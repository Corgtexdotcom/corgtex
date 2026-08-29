#!/usr/bin/env node
import { spawn as nodeSpawn } from "node:child_process";
import {
  ManagedAzureContainerAppError,
  createManagedAzureContainerAppTransport,
} from "./managed-azure-container-app-transport.mjs";

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
    const web = await deps.readApp({ target: status.target, role: "web", release: baseline, imageDigest: digestFromImage(rollback.previous.web.image), ambiguous: true });
    verifyRole("web", web, rollback);
    const worker = await deps.readApp({ target: status.target, role: "worker", release: baseline, imageDigest: digestFromImage(rollback.previous.worker.image), ambiguous: true });
    verifyRole("worker", worker, rollback);
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
