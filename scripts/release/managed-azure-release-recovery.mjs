#!/usr/bin/env node
import { spawn as nodeSpawn } from "node:child_process";
import {
  ManagedAzureContainerAppError,
  assertManagedAzureTemplateDelta,
  buildManagedAzureReleaseTemplate,
  createManagedAzureContainerAppTransport,
  managedAzureTemplateDigest,
  managedAzureRevisionSuffix,
} from "./managed-azure-container-app-transport.mjs";
import { managedAzureHealthReady } from "./managed-azure-release-transaction.mjs";

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const SHA_IMAGE_TAG = /^sha-([0-9a-f]{40})$/;
const DIGEST_REF = /@(sha256:[0-9a-f]{64})$/;
const MAX_INT = 2_147_483_647;

class ManagedAzureRecoveryError extends Error {
  constructor(code) {
    super(code);
    this.name = "ManagedAzureRecoveryError";
    this.code = code;
  }
}

function fail(code) { throw new ManagedAzureRecoveryError(code); }
function same(left, right) { return JSON.stringify(left) === JSON.stringify(right); }

function canonicalInput(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("MANAGED_RELEASE_RECOVERY_INPUT_INVALID");
  const keys = ["deploymentId", "reason", "acrName"];
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) fail("MANAGED_RELEASE_RECOVERY_INPUT_INVALID");
  if (!UUID.test(value.deploymentId) || typeof value.reason !== "string" || value.reason.trim().length < 8 || value.reason.length > 256
    || !/^[a-z0-9]{5,50}$/.test(value.acrName)) fail("MANAGED_RELEASE_RECOVERY_INPUT_INVALID");
  return Object.freeze({ deploymentId: value.deploymentId, reason: value.reason.trim(), acrName: value.acrName, acrServer: `${value.acrName}.azurecr.io` });
}

function releaseIdentity(imageTag, version) {
  const matched = typeof imageTag === "string" ? SHA_IMAGE_TAG.exec(imageTag) : null;
  if (!matched || typeof version !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(version)) fail("MANAGED_RELEASE_RECOVERY_BASELINE_INVALID");
  return Object.freeze({ gitSha: matched[1], imageTag, version });
}

function incomingReleaseIdentity(status) {
  if (status.release?.target?.kind !== "FORWARD") fail("MANAGED_RELEASE_RECOVERY_TARGET_INVALID");
  return releaseIdentity(status.release.target.imageTag, status.release.target.version);
}

function originatingReleaseLease(status) {
  if (!UUID.test(status.originatingLease?.leaseId)
    || !Number.isSafeInteger(status.originatingLease?.fence)
    || status.originatingLease.fence < 1
    || status.originatingLease.fence > status.fence) fail("MANAGED_RELEASE_RECOVERY_STATUS_INVALID");
  return Object.freeze({ leaseId: status.originatingLease.leaseId, fence: status.originatingLease.fence });
}

function digestFromImage(image) {
  const matched = typeof image === "string" ? DIGEST_REF.exec(image) : null;
  if (!matched) fail("MANAGED_RELEASE_RECOVERY_BASELINE_INVALID");
  return matched[1];
}

function recoveryTargetMatchesInput(target, input) {
  return target && typeof target === "object" && !Array.isArray(target)
    && target.acrName === input.acrName && target.acrServer === input.acrServer;
}

function leaseArgs(handle, extra = {}) {
  return { deploymentId: handle.deploymentId, leaseId: handle.leaseId, capability: handle.capability, fence: handle.fence, ...extra };
}

function verifyRole(role, state, rollback) {
  const expected = rollback.previous[role];
  if (!expected || typeof expected !== "object") fail("MANAGED_RELEASE_RECOVERY_BASELINE_INVALID");
  if (state.containerName !== expected.containerName
    || state.image !== expected.image
    || state.revisionName !== expected.readyRevision
    || state.templateDigest !== expected.templateDigest) fail(`MANAGED_RELEASE_RECOVERY_${role.toUpperCase()}_DRIFT`);
}

function verifyRollbackRole(role, state, rollback, baseline, expectedRevisionSuffix) {
  const expected = rollback.previous[role];
  if (!expected || typeof expected !== "object"
    || state.containerName !== expected.containerName
    || state.image !== expected.image
    || state.imageDigest !== digestFromImage(expected.image)
    || state.revisionSuffix !== expectedRevisionSuffix) fail(`MANAGED_RELEASE_RECOVERY_${role.toUpperCase()}_DRIFT`);
  const reconstructedBaseline = buildManagedAzureReleaseTemplate({
    baseline: state,
    role,
    image: expected.image,
    release: baseline,
    revisionSuffix: matchingBaselineRevisionSuffix(role, state, rollback, baseline, expected.templateDigest),
  });
  if (managedAzureTemplateDigest(reconstructedBaseline) !== expected.templateDigest) fail(`MANAGED_RELEASE_RECOVERY_${role.toUpperCase()}_DRIFT`);
}

function baselineRevisionSuffixes(role, state, rollback) {
  const expected = rollback.previous[role];
  if (!expected || typeof expected.readyRevision !== "string" || typeof state.appName !== "string") fail("MANAGED_RELEASE_RECOVERY_BASELINE_INVALID");
  const prefix = `${state.appName}--`;
  if (!expected.readyRevision.startsWith(prefix)) fail("MANAGED_RELEASE_RECOVERY_BASELINE_INVALID");
  const derived = expected.readyRevision.slice(prefix.length);
  return derived === "" ? [""] : [derived, ""];
}

function matchingBaselineRevisionSuffix(role, state, rollback, baseline, expectedTemplateDigest) {
  for (const revisionSuffix of baselineRevisionSuffixes(role, state, rollback)) {
    const reconstructedBaseline = buildManagedAzureReleaseTemplate({
      baseline: state,
      role,
      image: rollback.previous[role].image,
      release: baseline,
      revisionSuffix,
    });
    if (managedAzureTemplateDigest(reconstructedBaseline) === expectedTemplateDigest) return revisionSuffix;
  }
  fail(`MANAGED_RELEASE_RECOVERY_${role.toUpperCase()}_DRIFT`);
}

function verifyForwardRole(role, state, status, rollback, baseline, incoming, expectedRevisionSuffix) {
  const key = role === "web" ? "webDigest" : "workerDigest";
  const digest = rollback.incoming?.[key];
  const revisionSuffix = expectedRevisionSuffix;
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)
    || state.imageDigest !== digest
    || state.image !== `${status.target.acrServer}/corgtex/${role}@${digest}`
    || state.revisionSuffix !== revisionSuffix) fail(`MANAGED_RELEASE_RECOVERY_${role.toUpperCase()}_DRIFT`);
  const reconstructedBaseline = buildManagedAzureReleaseTemplate({
    baseline: state,
    role,
    image: rollback.previous[role].image,
    release: baseline,
    revisionSuffix: matchingBaselineRevisionSuffix(role, state, rollback, baseline, rollback.previous[role].templateDigest),
  });
  if (managedAzureTemplateDigest(reconstructedBaseline) !== rollback.previous[role].templateDigest) fail(`MANAGED_RELEASE_RECOVERY_${role.toUpperCase()}_DRIFT`);
  assertManagedAzureTemplateDelta({ ...state, template: reconstructedBaseline }, state.template, {
    role,
    image: `${status.target.acrServer}/corgtex/${role}@${digest}`,
    release: incoming,
    revisionSuffix,
  });
}

async function classifyBaselineRole(deps, status, rollback, role, baseline, expectedRollbackRevisionSuffix) {
  try {
    const state = await deps.readApp({ target: status.target, role, release: baseline, imageDigest: digestFromImage(rollback.previous[role].image), ambiguous: true });
    try {
      verifyRole(role, state, rollback);
      return { kind: "BASELINE", state };
    } catch {
      if (expectedRollbackRevisionSuffix) {
        verifyRollbackRole(role, state, rollback, baseline, expectedRollbackRevisionSuffix);
        return { kind: "BASELINE", state };
      }
    }
  } catch { /* Unknown live state remains blocked unless it matches the recorded forward revision. */ }
  return { kind: "UNKNOWN", state: null };
}

async function classifyForwardRole(deps, status, rollback, role, baseline, incoming, expectedRevisionSuffix) {
  try {
    const key = role === "web" ? "webDigest" : "workerDigest";
    const state = await deps.readApp({ target: status.target, role, release: incoming, imageDigest: rollback.incoming[key], ambiguous: true });
    verifyForwardRole(role, state, status, rollback, baseline, incoming, expectedRevisionSuffix);
    return { kind: "FORWARD", state };
  } catch { /* Unknown live state remains blocked for manual investigation. */ }
  return { kind: "UNKNOWN", state: null };
}

export function managedAzureRecoveryCliResultAccepted(result) {
  return result?.status === "RECOVERY_CLEARED";
}

export function writeManagedAzureRecoveryCliResult(result, writers = { stdout: process.stdout, stderr: process.stderr }) {
  writers.stdout.write(`${JSON.stringify(result)}\n`);
  if (managedAzureRecoveryCliResultAccepted(result)) return 0;
  writers.stderr.write(`${result.status}${result.code ? `:${result.code}` : ""}\n`);
  return 1;
}

export async function runManagedAzureReleaseRecovery(rawInput, dependencies) {
  const input = canonicalInput(rawInput);
  const deps = dependencies;
  const status = await deps.lease("get_recovery", { deploymentId: input.deploymentId, acrName: input.acrName, acrServer: input.acrServer });
  if (status.deploymentId !== input.deploymentId || (status.phase !== "MUTATING" && status.phase !== "RECOVERY_REQUIRED")
    || !UUID.test(status.leaseId) || !Number.isSafeInteger(status.fence) || status.fence < 1 || status.fence > MAX_INT
    || !recoveryTargetMatchesInput(status.target, input)) fail("MANAGED_RELEASE_RECOVERY_STATUS_INVALID");
  const claimed = await deps.lease("claim_recovery", {
    deploymentId: input.deploymentId,
    expectedLeaseId: status.leaseId,
    expectedFence: status.fence,
    owner: deps.owner,
    reason: input.reason,
  });
  const handle = { deploymentId: input.deploymentId, leaseId: claimed.leaseId, capability: claimed.capability, fence: claimed.fence };
  try {
    const rollback = await deps.lease("get_rollback", leaseArgs(handle));
    const baseline = releaseIdentity(status.release?.baselineImageTag, rollback?.previous?.releaseVersion);
    if (!same(rollback.target, status.target)) fail("MANAGED_RELEASE_RECOVERY_TARGET_DRIFT");
    const originatingLease = originatingReleaseLease(status);
    const forwardSuffixes = {
      web: managedAzureRevisionSuffix({ ...originatingLease, role: "web", phase: "forward" }),
      worker: managedAzureRevisionSuffix({ ...originatingLease, role: "worker", phase: "forward" }),
    };
    const rollbackSuffixes = {
      web: managedAzureRevisionSuffix({ ...originatingLease, role: "web", phase: "rollback" }),
      worker: managedAzureRevisionSuffix({ ...originatingLease, role: "worker", phase: "rollback" }),
    };
    let web = await classifyBaselineRole(deps, status, rollback, "web", baseline, rollbackSuffixes.web);
    let worker = await classifyBaselineRole(deps, status, rollback, "worker", baseline, rollbackSuffixes.worker);
    if (web.kind === "BASELINE" && worker.kind === "BASELINE") {
      const finalized = await deps.lease("finalize_rollback", leaseArgs(handle, { reason: input.reason }));
      if (finalized?.status !== "ROLLED_BACK") fail("MANAGED_RELEASE_RECOVERY_FINALIZE_REJECTED");
      return Object.freeze({
        status: "RECOVERY_CLEARED",
        deploymentId: input.deploymentId,
        previousLeaseId: status.leaseId,
        previousFence: status.fence,
        fence: finalized.fence,
        releaseImageTag: finalized.releaseImageTag,
        releaseVersion: finalized.releaseVersion,
      });
    }
    const incoming = incomingReleaseIdentity(status);
    if (web.kind !== "BASELINE") web = await classifyForwardRole(deps, status, rollback, "web", baseline, incoming, forwardSuffixes.web);
    if (worker.kind !== "BASELINE") worker = await classifyForwardRole(deps, status, rollback, "worker", baseline, incoming, forwardSuffixes.worker);
    if (web.kind === "UNKNOWN" || worker.kind === "UNKNOWN") fail("MANAGED_RELEASE_RECOVERY_MIXED_STATE_UNSUPPORTED");
    let forwardAllowed = true;
    try { await deps.lease("heartbeat", leaseArgs(handle, { reason: input.reason })); }
    catch (error) {
      if (error?.code !== "MANAGED_RELEASE_FORWARD_NOT_ALLOWED") throw error;
      forwardAllowed = false;
    }
    if (!forwardAllowed) {
      const heartbeat = () => deps.lease("heartbeat_recovery", leaseArgs(handle, { reason: input.reason }));
      for (const [role, current] of [["worker", worker], ["web", web]]) {
        if (current.kind !== "FORWARD") continue;
        await heartbeat();
        const image = rollback.previous[role].image;
        const revisionSuffix = rollbackSuffixes[role];
        const template = buildManagedAzureReleaseTemplate({ baseline: current.state, role, image, release: baseline, revisionSuffix });
        assertManagedAzureTemplateDelta(current.state, template, { role, image, release: baseline, revisionSuffix });
        const patched = await deps.patchTemplate({ target: status.target, role, location: current.state.location, template, onProgress: heartbeat });
        if (!patched.terminal || !patched.succeeded) {
          await deps.lease("mark_recovery", leaseArgs(handle, { stage: "ROLLBACK", code: patched.code ?? "ROLLBACK_PATCH_AMBIGUOUS", reason: input.reason })).catch(() => undefined);
          fail("MANAGED_RELEASE_RECOVERY_ROLLBACK_AMBIGUOUS");
        }
        await heartbeat();
        await deps.waitForState({ target: status.target, role, release: baseline, imageDigest: digestFromImage(image), expectedTemplate: template, onProgress: heartbeat });
      }
      await heartbeat();
      for (const role of ["web", "worker"]) {
        const restored = await classifyBaselineRole(deps, status, rollback, role, baseline, rollbackSuffixes[role]);
        if (restored.kind !== "BASELINE") fail("MANAGED_RELEASE_RECOVERY_ROLLBACK_AMBIGUOUS");
      }
      const health = await deps.healthProbe({ origin: status.origin, release: baseline });
      if (!health.ok) fail("MANAGED_RELEASE_RECOVERY_ROLLBACK_HEALTH_FAILED");
      const finalized = await deps.lease("finalize_rollback", leaseArgs(handle, { reason: input.reason }));
      if (finalized?.status !== "ROLLED_BACK") fail("MANAGED_RELEASE_RECOVERY_FINALIZE_REJECTED");
      return Object.freeze({ status: "RECOVERY_CLEARED", deploymentId: input.deploymentId, previousLeaseId: status.leaseId,
        previousFence: status.fence, fence: finalized.fence, releaseImageTag: finalized.releaseImageTag,
        releaseVersion: finalized.releaseVersion, resolution: "ROLLED_BACK_SELECTION_REMOVED" });
    }
    if (web.kind === "FORWARD" && worker.kind === "BASELINE") {
      await deps.lease("heartbeat", leaseArgs(handle, { reason: input.reason }));
      const revisionSuffix = forwardSuffixes.worker;
      const image = `${status.target.acrServer}/corgtex/worker@${rollback.incoming.workerDigest}`;
      const template = buildManagedAzureReleaseTemplate({ baseline: worker.state, role: "worker", image, release: incoming, revisionSuffix });
      assertManagedAzureTemplateDelta(worker.state, template, { role: "worker", image, release: incoming, revisionSuffix });
      let patched;
      try {
        patched = await deps.patchTemplate({ target: status.target, role: "worker", location: worker.state.location, template,
          onProgress: () => deps.lease("heartbeat", leaseArgs(handle, { reason: input.reason })) });
      } catch (error) {
        const code = error instanceof ManagedAzureContainerAppError ? error.code : "WORKER_PATCH_AMBIGUOUS";
        await deps.lease("mark_recovery", leaseArgs(handle, { stage: "WORKER", code, reason: input.reason })).catch(() => undefined);
        return Object.freeze({ status: "RECOVERY_BLOCKED", deploymentId: input.deploymentId, code });
      }
      if (!patched.terminal || !patched.succeeded) {
        await deps.lease("mark_recovery", leaseArgs(handle, { stage: "WORKER", code: patched.code ?? "WORKER_PATCH_AMBIGUOUS", reason: input.reason })).catch(() => undefined);
        return Object.freeze({ status: "RECOVERY_BLOCKED", deploymentId: input.deploymentId, code: patched.code ?? "WORKER_PATCH_AMBIGUOUS" });
      }
      try {
        await deps.waitForState({ target: status.target, role: "worker", release: incoming, imageDigest: rollback.incoming.workerDigest, expectedTemplate: template,
          onProgress: () => deps.lease("heartbeat", leaseArgs(handle, { reason: input.reason })) });
      } catch (error) {
        const code = error instanceof ManagedAzureContainerAppError ? error.code : "WORKER_READBACK_AMBIGUOUS";
        await deps.lease("mark_recovery", leaseArgs(handle, { stage: "READBACK", code, reason: input.reason })).catch(() => undefined);
        return Object.freeze({ status: "RECOVERY_BLOCKED", deploymentId: input.deploymentId, code });
      }
      const webAfter = await classifyForwardRole(deps, status, rollback, "web", baseline, incoming, forwardSuffixes.web);
      if (webAfter.kind !== "FORWARD") {
        await deps.lease("mark_recovery", leaseArgs(handle, { stage: "READBACK", code: "WEB_READBACK_MISMATCH", reason: input.reason })).catch(() => undefined);
        return Object.freeze({ status: "RECOVERY_BLOCKED", deploymentId: input.deploymentId, code: "WEB_READBACK_MISMATCH" });
      }
      const health = await deps.healthProbe({ origin: status.origin, release: incoming });
      if (!health.ok) {
        await deps.lease("mark_recovery", leaseArgs(handle, { stage: "OBSERVATION", code: health.code ?? "HEALTH_PROBE_FAILED", reason: input.reason })).catch(() => undefined);
        return Object.freeze({ status: "RECOVERY_BLOCKED", deploymentId: input.deploymentId, code: health.code ?? "HEALTH_PROBE_FAILED" });
      }
      const finalized = await deps.lease("finalize_success", leaseArgs(handle, { reason: input.reason }));
      if (finalized?.status !== "SUCCEEDED") fail("MANAGED_RELEASE_RECOVERY_FINALIZE_REJECTED");
      return Object.freeze({
        status: "RECOVERY_CLEARED",
        deploymentId: input.deploymentId,
        previousLeaseId: status.leaseId,
        previousFence: status.fence,
        fence: finalized.fence,
        releaseImageTag: finalized.releaseImageTag,
        releaseVersion: finalized.releaseVersion,
        resolution: "FORWARD_COMPLETED",
      });
    }
    if (web.kind === "FORWARD" && worker.kind === "FORWARD") {
      const health = await deps.healthProbe({ origin: status.origin, release: incoming });
      if (!health.ok) {
        await deps.lease("mark_recovery", leaseArgs(handle, { stage: "OBSERVATION", code: health.code ?? "HEALTH_PROBE_FAILED", reason: input.reason })).catch(() => undefined);
        return Object.freeze({ status: "RECOVERY_BLOCKED", deploymentId: input.deploymentId, code: health.code ?? "HEALTH_PROBE_FAILED" });
      }
      const finalized = await deps.lease("finalize_success", leaseArgs(handle, { reason: input.reason }));
      if (finalized?.status !== "SUCCEEDED") fail("MANAGED_RELEASE_RECOVERY_FINALIZE_REJECTED");
      return Object.freeze({
        status: "RECOVERY_CLEARED",
        deploymentId: input.deploymentId,
        previousLeaseId: status.leaseId,
        previousFence: status.fence,
        fence: finalized.fence,
        releaseImageTag: finalized.releaseImageTag,
        releaseVersion: finalized.releaseVersion,
        resolution: "FORWARD_ALREADY_COMPLETE",
      });
    }
    fail("MANAGED_RELEASE_RECOVERY_MIXED_STATE_UNSUPPORTED");
  } catch (error) {
    if (error instanceof ManagedAzureRecoveryError) {
      return Object.freeze({ status: "RECOVERY_BLOCKED", deploymentId: input.deploymentId, code: error.code });
    }
    if (error instanceof ManagedAzureContainerAppError) {
      return Object.freeze({ status: "RECOVERY_BLOCKED", deploymentId: input.deploymentId, code: error.code });
    }
    return Object.freeze({ status: "RECOVERY_BLOCKED", deploymentId: input.deploymentId, code: "MANAGED_RELEASE_RECOVERY_AMBIGUOUS" });
  }
}

function createSpawn() {
  return (command, args, options) => {
    const child = nodeSpawn(command, args, { stdio: ["ignore", "pipe", "pipe"], shell: false, detached: false });
    let stdout = ""; let stderr = ""; let stdoutOverflow = false; let stderrOverflow = false; let timedOut = false; let terminal = false;
    const collect = (kind, chunk, maximum) => {
      const value = chunk.toString("utf8");
      if (Buffer.byteLength(kind === "stdout" ? stdout + value : stderr + value, "utf8") > maximum) {
        if (kind === "stdout") stdoutOverflow = true; else stderrOverflow = true;
        child.kill("SIGTERM");
        return;
      }
      if (kind === "stdout") stdout += value; else stderr += value;
    };
    child.stdout.on("data", (chunk) => collect("stdout", chunk, options.maxStdoutBytes));
    child.stderr.on("data", (chunk) => collect("stderr", chunk, options.maxStderrBytes));
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, options.timeoutMs);
    const completion = new Promise((resolve) => {
      child.on("close", (code, signal) => {
        terminal = true; clearTimeout(timer);
        resolve(Object.freeze({ code, signal, timedOut, stdout, stderr, stdoutOverflow, stderrOverflow }));
      });
      child.on("error", () => {
        if (!terminal) { terminal = true; clearTimeout(timer); resolve(Object.freeze({ code: null, signal: null, timedOut, stdout, stderr, stdoutOverflow, stderrOverflow })); }
      });
    });
    return Object.freeze({ completion, abort: async () => { if (!terminal) child.kill("SIGTERM"); return completion; } });
  };
}

async function commandText(spawn, command, args, maximum = 16_384) {
  const handle = spawn(command, args, { timeoutMs: 20_000, maxStdoutBytes: maximum, maxStderrBytes: 4_096 });
  const result = await handle.completion;
  if (result.code !== 0 || result.signal !== null || result.timedOut || result.stdoutOverflow || result.stderrOverflow || result.stderr !== "") fail("MANAGED_RELEASE_RECOVERY_COMMAND_FAILED");
  return result.stdout.trim();
}

async function callControlPlane(name, args, env, fetchImpl = fetch) {
  const token = env.CONTROL_PLANE_AGENT_API_KEY?.trim();
  const base = env.CONTROL_PLANE_URL?.trim().replace(/\/$/, "");
  if (!token || !base) fail("MANAGED_RELEASE_RECOVERY_CONTROL_PLANE_UNAVAILABLE");
  const response = await fetchImpl(`${base}/api/control-plane/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer cp-${token}`, "content-type": "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
    body: JSON.stringify({ jsonrpc: "2.0", id: `managed-release-recovery-${Date.now()}`, method: "tools/call", params: { name, arguments: args } }),
  });
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > 192_000) fail("MANAGED_RELEASE_RECOVERY_CONTROL_PLANE_INVALID");
  let body; try { body = JSON.parse(text); } catch { fail("MANAGED_RELEASE_RECOVERY_CONTROL_PLANE_INVALID"); }
  if (response.status === 409 && body?.error?.code === "MANAGED_RELEASE_FORWARD_NOT_ALLOWED") fail("MANAGED_RELEASE_FORWARD_NOT_ALLOWED");
  if (!response.ok || body?.error) fail("MANAGED_RELEASE_RECOVERY_CONTROL_PLANE_REJECTED");
  const payload = body?.result?.content?.find((item) => item?.type === "text")?.text;
  if (typeof payload !== "string") fail("MANAGED_RELEASE_RECOVERY_CONTROL_PLANE_INVALID");
  try { return JSON.parse(payload); } catch { fail("MANAGED_RELEASE_RECOVERY_CONTROL_PLANE_INVALID"); }
}

function runtimeDependencies(env = process.env) {
  const spawn = createSpawn();
  const apps = createManagedAzureContainerAppTransport({
    getAccessToken: async () => commandText(spawn, "az", ["account", "get-access-token", "--resource", "https://management.azure.com", "--query", "accessToken", "--output", "tsv"], 8_192),
  });
  return {
    owner: `github:${env.GITHUB_RUN_ID || "manual"}:${env.GITHUB_RUN_ATTEMPT || "1"}:recovery`,
    lease: (operation, args) => callControlPlane("managed_release_lease", { operation, ...args }, env),
    readApp: apps.readApp,
    patchTemplate: apps.patchTemplate,
    waitForState: apps.waitForState,
    healthProbe: async ({ origin, release }) => {
      try {
        const response = await fetch(`${origin}/api/health`, { method: "GET", redirect: "error", signal: AbortSignal.timeout(20_000) });
        const text = await response.text();
        if (!response.ok || Buffer.byteLength(text, "utf8") > 32_768) return { ok: false, code: "HEALTH_PROBE_FAILED" };
        const body = JSON.parse(text);
        return { ok: managedAzureHealthReady(body, release), code: "HEALTH_RELEASE_MISMATCH" };
      } catch { return { ok: false, code: "HEALTH_PROBE_AMBIGUOUS" }; }
    },
  };
}

function cliInput(argv, env) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]; const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) fail("MANAGED_RELEASE_RECOVERY_INPUT_INVALID");
    values[flag.slice(2)] = value;
  }
  return {
    deploymentId: values["deployment-id"],
    reason: values.reason,
    acrName: env.MANAGED_AZURE_ACR_NAME,
  };
}

async function main() {
  try {
    const input = cliInput(process.argv.slice(2), process.env);
    const result = await runManagedAzureReleaseRecovery(input, runtimeDependencies());
    process.exitCode = writeManagedAzureRecoveryCliResult(result);
  } catch (error) {
    const code = error instanceof ManagedAzureRecoveryError ? error.code : "MANAGED_RELEASE_RECOVERY_FAILED";
    process.stdout.write(`${JSON.stringify({ status: "RECOVERY_BLOCKED", code })}\n`);
    process.stderr.write(`RECOVERY_BLOCKED:${code}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  await main();
}
