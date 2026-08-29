import { createHash } from "node:crypto";
import { spawn as nodeSpawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  canonicalizeManagedAzureImportRequestV1,
  canonicalizeManagedAzureReleaseIntentV1,
  compareManagedAzureDestinationDigestV1,
} from "./azure-release-managed-target.mjs";
import { createManagedAzureArmImportTransport } from "./managed-azure-arm-import-transport.mjs";
import {
  ManagedAzureContainerAppError,
  assertManagedAzureTemplateDelta,
  buildManagedAzureReleaseTemplate,
  createManagedAzureContainerAppTransport,
  managedAzureRevisionSuffix,
  managedAzureTemplateDigest,
} from "./managed-azure-container-app-transport.mjs";
import { createManagedAzureProviderObservation } from "./managed-azure-provider-runtime.mjs";
import { createManagedAzureSourceManifestResolver } from "./managed-azure-source-manifest-resolver.mjs";

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const ROLES = Object.freeze(["web", "worker"]);

class ManagedAzureReleaseError extends Error {
  constructor(code) {
    super(code);
    this.name = "ManagedAzureReleaseError";
    this.code = code;
  }
}

function fail(code) { throw new ManagedAzureReleaseError(code); }
function same(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
function failureMessage(error) { return typeof error?.message === "string" ? error.message : ""; }

function failReleaseResolution(error) {
  if (error instanceof ManagedAzureReleaseError) throw error;
  const message = failureMessage(error);
  if (message === "MANAGED_AZURE_SOURCE_MANIFEST_RESOLUTION_FAILED") fail("MANAGED_RELEASE_SOURCE_MANIFEST_FAILED");
  if (message === "MANAGED_AZURE_PROVIDER_OBSERVATION_FAILED") fail("MANAGED_RELEASE_PROVIDER_OBSERVATION_FAILED");
  fail("MANAGED_RELEASE_IMAGE_PREFLIGHT_FAILED");
}

async function readBaselineApp(deps, target, role, release) {
  try {
    return await deps.readApp({ target, role, release });
  } catch (error) {
    if (error instanceof ManagedAzureContainerAppError) fail(`MANAGED_RELEASE_BASELINE_${role.toUpperCase()}_${error.code}`);
    fail(`MANAGED_RELEASE_BASELINE_${role.toUpperCase()}_READ_FAILED`);
  }
}

function canonicalInput(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("MANAGED_RELEASE_INPUT_INVALID");
  const keys = ["inventoryRef", "inventorySha256", "deploymentId", "releaseSha", "releaseVersion", "reason", "execute", "acrName"];
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) fail("MANAGED_RELEASE_INPUT_INVALID");
  if (!UUID.test(value.inventoryRef) || !SHA256.test(value.inventorySha256) || !UUID.test(value.deploymentId)
    || !SHA.test(value.releaseSha) || typeof value.releaseVersion !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(value.releaseVersion)
    || typeof value.reason !== "string" || value.reason.trim().length < 8 || value.reason.length > 256
    || typeof value.execute !== "boolean" || !/^[a-z0-9]{5,50}$/.test(value.acrName)) fail("MANAGED_RELEASE_INPUT_INVALID");
  return Object.freeze({ ...value, reason: value.reason.trim(), acrServer: `${value.acrName}.azurecr.io` });
}

function releaseIdentity(imageTag, version) {
  if (!/^sha-[0-9a-f]{40}$/.test(imageTag) || typeof version !== "string") fail("MANAGED_RELEASE_BASELINE_INVALID");
  return Object.freeze({ gitSha: imageTag.slice(4), imageTag, version });
}

function leaseArgs(handle, extra = {}) {
  return { deploymentId: handle.deploymentId, leaseId: handle.leaseId, capability: handle.capability, fence: handle.fence, ...extra };
}

function safeResult(input, inventory, status, detail = {}) {
  return Object.freeze({
    status,
    deploymentId: input.deploymentId,
    inventoryRef: input.inventoryRef,
    inventorySha256: input.inventorySha256,
    inventoryCanonicalDigest: inventory.evaluation.canonicalDigest,
    releaseSha: input.releaseSha,
    releaseImageTag: `sha-${input.releaseSha}`,
    ...detail,
  });
}

export function managedAzureCliResultAccepted(result, execute) {
  return execute ? result?.status === "SUCCEEDED" : result?.status === "DRY_RUN_READY";
}

export function writeManagedAzureCliResult(result, execute, writers = { stdout: process.stdout, stderr: process.stderr }) {
  writers.stdout.write(`${JSON.stringify(result)}\n`);
  if (managedAzureCliResultAccepted(result, execute)) return 0;
  writers.stderr.write(`${result.status}${result.code ? `:${result.code}` : ""}\n`);
  return 1;
}

function verifyInventoryResponse(inventory, input) {
  if (inventory?.inventoryRef !== input.inventoryRef || inventory.sha256 !== input.inventorySha256
    || typeof inventory.bytesBase64 !== "string"
    || !/^sha256:[0-9a-f]{64}$/.test(inventory.evaluation?.canonicalDigest)) fail("MANAGED_RELEASE_INVENTORY_INVALID");
  let bytes;
  try { bytes = Buffer.from(inventory.bytesBase64, "base64"); } catch { fail("MANAGED_RELEASE_INVENTORY_INVALID"); }
  if (bytes.length === 0 || bytes.length > 96_000 || bytes.toString("base64") !== inventory.bytesBase64
    || createHash("sha256").update(bytes).digest("hex") !== input.inventorySha256) fail("MANAGED_RELEASE_INVENTORY_INVALID");
  return inventory;
}

export function managedAzureHealthReady(body, release) {
  return body?.status === "ok"
    && body.service === "web"
    && body.database === "up"
    && body.schema === "ready"
    && body.app === "corgtex"
    && body.release?.gitSha === release.gitSha
    && body.release?.imageTag === release.imageTag
    && body.release?.version === release.version;
}

export async function runManagedAzureReleaseTransaction(rawInput, dependencies) {
  const input = canonicalInput(rawInput);
  const deps = dependencies;
  const inventory = verifyInventoryResponse(await deps.loadInventory(input), input);
  const preflight = await deps.lease("preflight", { deploymentId: input.deploymentId, acrName: input.acrName, acrServer: input.acrServer });
  if (preflight.deploymentId !== input.deploymentId || preflight.target?.acrName !== input.acrName || preflight.target?.acrServer !== input.acrServer) fail("MANAGED_RELEASE_TARGET_INVALID");
  const baselineRelease = releaseIdentity(preflight.release?.baselineImageTag, preflight.release?.baselineVersion);
  if (baselineRelease.imageTag === `sha-${input.releaseSha}`) fail("MANAGED_RELEASE_ALREADY_CURRENT");
  const nextRelease = Object.freeze({ gitSha: input.releaseSha, imageTag: `sha-${input.releaseSha}`, version: input.releaseVersion });
  let releasePlan;
  try {
    releasePlan = await deps.resolveRelease({ deploymentId: input.deploymentId, target: preflight.target, gitSha: input.releaseSha });
  } catch (error) {
    failReleaseResolution(error);
  }
  if (!releasePlan || ROLES.some((role) => !/^sha256:[0-9a-f]{64}$/.test(releasePlan.roles?.[role]?.digest)
    || !["MATCH", "ABSENT"].includes(releasePlan.roles?.[role]?.destinationState))) fail("MANAGED_RELEASE_IMAGE_PREFLIGHT_FAILED");

  const baselines = {};
  for (const role of ROLES) baselines[role] = await readBaselineApp(deps, preflight.target, role, baselineRelease);
  const rollback = {
    schemaVersion: 1,
    target: preflight.target,
    previous: {
      releaseVersion: baselineRelease.version,
      web: { containerName: baselines.web.containerName, image: baselines.web.image, readyRevision: baselines.web.revisionName, templateDigest: baselines.web.templateDigest },
      worker: { containerName: baselines.worker.containerName, image: baselines.worker.image, readyRevision: baselines.worker.revisionName, templateDigest: baselines.worker.templateDigest },
    },
    incoming: { webDigest: releasePlan.roles.web.digest, workerDigest: releasePlan.roles.worker.digest },
  };
  const baselineHealth = await deps.healthProbe({ origin: preflight.origin, release: baselineRelease });
  if (!baselineHealth.ok) fail("MANAGED_RELEASE_BASELINE_HEALTH_FAILED");
  if (!input.execute) {
    return safeResult(input, inventory, "DRY_RUN_READY", {
      effects: 0,
      importsRequired: ROLES.filter((role) => releasePlan.roles[role].destinationState === "ABSENT"),
    });
  }

  let handle;
  let mutationBegun = false;
  const heartbeat = () => deps.lease("heartbeat", leaseArgs(handle, { reason: input.reason }));
  const markRecovery = async (stage, code, detail = {}) => {
    if (handle) await deps.lease("mark_recovery", leaseArgs(handle, { stage, code, reason: input.reason })).catch(() => undefined);
    return safeResult(input, inventory, "RECOVERY_REQUIRED", { phase: stage, code, ...detail });
  };

  const classifyRole = async (role, forwardTemplate) => {
    try {
      const state = await deps.readApp({ target: preflight.target, role, release: baselineRelease, imageDigest: baselines[role].imageDigest, ambiguous: true });
      if (state.templateDigest === baselines[role].templateDigest) return { kind: "BASELINE", state };
    } catch { /* Try the transaction-owned revision next. */ }
    try {
      const state = await deps.readApp({ target: preflight.target, role, release: nextRelease, imageDigest: releasePlan.roles[role].digest, ambiguous: true });
      if (state.templateDigest === deps.templateDigest(forwardTemplate)) return { kind: "FORWARD", state };
    } catch { /* Unknown state is retained for recovery. */ }
    return { kind: "UNKNOWN", state: null };
  };

  const compensate = async (stage, code, forwardTemplates, detail = {}) => {
    const classified = {};
    for (const role of ROLES) classified[role] = await classifyRole(role, forwardTemplates[role]);
    if (ROLES.some((role) => classified[role].kind === "UNKNOWN")) return markRecovery(stage, code, detail);
    await heartbeat();
    for (const role of ["worker", "web"]) {
      if (classified[role].kind !== "FORWARD") continue;
      const suffix = managedAzureRevisionSuffix({ leaseId: handle.leaseId, fence: handle.fence, role, phase: "rollback" });
      const template = buildManagedAzureReleaseTemplate({
        baseline: classified[role].state,
        role,
        image: baselines[role].image,
        release: baselineRelease,
        revisionSuffix: suffix,
      });
      assertManagedAzureTemplateDelta(classified[role].state, template, { role, image: baselines[role].image, release: baselineRelease, revisionSuffix: suffix });
      const patched = await deps.patchTemplate({ target: preflight.target, role, location: classified[role].state.location, template, onProgress: heartbeat });
      const rollbackDetail = patched.providerCode ? { providerCode: patched.providerCode } : detail;
      if (!patched.terminal || !patched.succeeded) return markRecovery("ROLLBACK", patched.code ?? code, rollbackDetail);
      await heartbeat();
      try {
        await deps.waitForState({ target: preflight.target, role, release: baselineRelease, imageDigest: baselines[role].imageDigest, expectedTemplate: template, onProgress: heartbeat });
      } catch { return markRecovery("ROLLBACK", "ROLLBACK_READBACK_AMBIGUOUS", rollbackDetail); }
      await heartbeat();
    }
    await deps.lease("finalize_rollback", leaseArgs(handle, { reason: input.reason }));
    return safeResult(input, inventory, "ROLLED_BACK", { phase: stage, code, ...detail });
  };

  try {
    handle = await deps.lease("acquire", {
      deploymentId: input.deploymentId,
      expectedImageTag: baselineRelease.imageTag,
      incomingImageTag: nextRelease.imageTag,
      incomingVersion: nextRelease.version,
      owner: deps.owner,
      reason: input.reason,
    });
    const leasedTarget = await deps.lease("get_target", leaseArgs(handle, { acrName: input.acrName, acrServer: input.acrServer }));
    if (!same(leasedTarget.target, preflight.target) || leasedTarget.release?.baselineImageTag !== baselineRelease.imageTag) {
      await deps.lease("abort", leaseArgs(handle, { reason: input.reason }));
      fail("MANAGED_RELEASE_LEASE_TARGET_DRIFT");
    }
    for (const role of ROLES) {
      const current = await deps.readApp({ target: preflight.target, role, release: baselineRelease, imageDigest: baselines[role].imageDigest });
      if (current.templateDigest !== baselines[role].templateDigest) {
        await deps.lease("abort", leaseArgs(handle, { reason: input.reason }));
        fail("MANAGED_RELEASE_BASELINE_DRIFT");
      }
    }
    await deps.lease("record_rollback", leaseArgs(handle, { rollback, reason: input.reason }));
    for (const role of ROLES) {
      if (releasePlan.roles[role].destinationState !== "ABSENT") continue;
      const imported = await deps.importRole(releasePlan.roles[role]);
      if (!imported.terminal || !imported.succeeded) {
        if (imported.ambiguous) return markRecovery("IMPORT", imported.code ?? "IMPORT_AMBIGUOUS");
        await deps.lease("abort", leaseArgs(handle, { reason: input.reason }));
        fail("MANAGED_RELEASE_IMPORT_REJECTED");
      }
      await heartbeat();
    }
    mutationBegun = true;
    await deps.lease("begin", leaseArgs(handle, { reason: input.reason }));
    const forwardTemplates = {};
    for (const role of ROLES) {
      const suffix = managedAzureRevisionSuffix({ leaseId: handle.leaseId, fence: handle.fence, role, phase: "forward" });
      forwardTemplates[role] = buildManagedAzureReleaseTemplate({
        baseline: baselines[role],
        role,
        image: releasePlan.roles[role].image,
        release: nextRelease,
        revisionSuffix: suffix,
      });
      assertManagedAzureTemplateDelta(baselines[role], forwardTemplates[role], { role, image: releasePlan.roles[role].image, release: nextRelease, revisionSuffix: suffix });
    }

    const webPatch = await deps.patchTemplate({ target: preflight.target, role: "web", location: baselines.web.location, template: forwardTemplates.web, onProgress: heartbeat });
    if (!webPatch.terminal) return markRecovery("WEB", webPatch.code ?? "WEB_PATCH_AMBIGUOUS",
      webPatch.providerCode ? { providerCode: webPatch.providerCode } : {});
    if (!webPatch.succeeded) return compensate("WEB", webPatch.code ?? "WEB_PATCH_FAILED", forwardTemplates,
      webPatch.providerCode ? { providerCode: webPatch.providerCode } : {});
    await heartbeat();
    try { await deps.waitForState({ target: preflight.target, role: "web", release: nextRelease, imageDigest: releasePlan.roles.web.digest, expectedTemplate: forwardTemplates.web, onProgress: heartbeat }); }
    catch { return compensate("WEB", "WEB_READBACK_AMBIGUOUS", forwardTemplates); }
    await heartbeat();
    const workerBefore = await classifyRole("worker", forwardTemplates.worker);
    const webBefore = await classifyRole("web", forwardTemplates.web);
    if (workerBefore.kind !== "BASELINE" || webBefore.kind !== "FORWARD") return compensate("WORKER", "PRE_WORKER_DRIFT", forwardTemplates);
    await heartbeat();

    const workerPatch = await deps.patchTemplate({ target: preflight.target, role: "worker", location: baselines.worker.location, template: forwardTemplates.worker, onProgress: heartbeat });
    if (!workerPatch.terminal) return markRecovery("WORKER", workerPatch.code ?? "WORKER_PATCH_AMBIGUOUS",
      workerPatch.providerCode ? { providerCode: workerPatch.providerCode } : {});
    if (!workerPatch.succeeded) return compensate("WORKER", workerPatch.code ?? "WORKER_PATCH_FAILED", forwardTemplates,
      workerPatch.providerCode ? { providerCode: workerPatch.providerCode } : {});
    await heartbeat();
    try {
      await deps.waitForState({ target: preflight.target, role: "worker", release: nextRelease, imageDigest: releasePlan.roles.worker.digest, expectedTemplate: forwardTemplates.worker, onProgress: heartbeat });
      await heartbeat();
      await deps.waitForState({ target: preflight.target, role: "web", release: nextRelease, imageDigest: releasePlan.roles.web.digest, expectedTemplate: forwardTemplates.web, onProgress: heartbeat });
    } catch { return compensate("READBACK", "FINAL_READBACK_AMBIGUOUS", forwardTemplates); }
    await heartbeat();
    const health = await deps.healthProbe({ origin: preflight.origin, release: nextRelease });
    if (!health.ok) return compensate("OBSERVATION", health.code ?? "HEALTH_PROBE_FAILED", forwardTemplates);
    await heartbeat();
    await deps.lease("finalize_success", leaseArgs(handle, { reason: input.reason }));
    return safeResult(input, inventory, "SUCCEEDED", { phase: "COMPLETE" });
  } catch (error) {
    if (!handle) throw error;
    if (!mutationBegun) {
      await deps.lease("abort", leaseArgs(handle, { reason: input.reason })).catch(() => undefined);
      throw error;
    }
    return markRecovery("FENCING", error instanceof ManagedAzureReleaseError ? error.code : "TRANSACTION_AMBIGUOUS");
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
  if (result.code !== 0 || result.signal !== null || result.timedOut || result.stdoutOverflow || result.stderrOverflow || result.stderr !== "") fail("MANAGED_RELEASE_COMMAND_FAILED");
  return result.stdout.trim();
}

async function callControlPlane(name, args, env, fetchImpl = fetch) {
  const token = env.CONTROL_PLANE_AGENT_API_KEY?.trim();
  const base = env.CONTROL_PLANE_URL?.trim().replace(/\/$/, "");
  if (!token || !base) fail("MANAGED_RELEASE_CONTROL_PLANE_UNAVAILABLE");
  const response = await fetchImpl(`${base}/api/control-plane/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer cp-${token}`, "content-type": "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
    body: JSON.stringify({ jsonrpc: "2.0", id: `managed-release-${Date.now()}`, method: "tools/call", params: { name, arguments: args } }),
  });
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > 192_000) fail("MANAGED_RELEASE_CONTROL_PLANE_INVALID");
  let body; try { body = JSON.parse(text); } catch { fail("MANAGED_RELEASE_CONTROL_PLANE_INVALID"); }
  if (!response.ok || body?.error) fail("MANAGED_RELEASE_CONTROL_PLANE_REJECTED");
  const payload = body?.result?.content?.find((item) => item?.type === "text")?.text;
  if (typeof payload !== "string") fail("MANAGED_RELEASE_CONTROL_PLANE_INVALID");
  try { return JSON.parse(payload); } catch { fail("MANAGED_RELEASE_CONTROL_PLANE_INVALID"); }
}

function runtimeDependencies(env = process.env) {
  const spawn = createSpawn();
  const sourceResolver = createManagedAzureSourceManifestResolver({ spawn });
  const provider = createManagedAzureProviderObservation({ spawn, clock: Date.now });
  const getAzureAccessToken = async () => commandText(spawn, "az", ["account", "get-access-token", "--resource", "https://management.azure.com", "--query", "accessToken", "--output", "tsv"], 8_192);
  const importer = createManagedAzureArmImportTransport({
    fetchImpl: fetch,
    getAzureAccessToken,
    getSourceCredentials: async () => {
      const password = (env.GHCR_IMPORT_TOKEN || env.GITHUB_TOKEN)?.trim();
      const username = (env.GHCR_IMPORT_USERNAME || env.GITHUB_ACTOR)?.trim();
      if (!password || !username) fail("MANAGED_RELEASE_SOURCE_CREDENTIALS_MISSING");
      return { username, password };
    },
    clock: Date.now,
    sleep: (ms, signal) => new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("aborted")); }, { once: true });
    }),
  });
  const apps = createManagedAzureContainerAppTransport();
  return {
    owner: `github:${env.GITHUB_RUN_ID || "manual"}:${env.GITHUB_RUN_ATTEMPT || "1"}`,
    templateDigest: managedAzureTemplateDigest,
    loadInventory: (input) => callControlPlane("get_managed_release_inventory", { inventoryRef: input.inventoryRef, expectedSha256: input.inventorySha256, deploymentId: input.deploymentId }, env),
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
    resolveRelease: async ({ deploymentId, target, gitSha }) => {
      const manifests = await sourceResolver.resolveManagedAzureSourceManifests({ gitSha });
      const deployment = { deploymentId, deploymentKind: "REMOTE_MANAGED", cloudProvider: "AZURE", environment: "production", deploymentStatus: "ACTIVE", provisioningStatus: "active", releaseEligible: true, provider: "azure", group: "managed-customers", workload: "managed-customers", azure: target };
      const intent = canonicalizeManagedAzureReleaseIntentV1({ deploymentId, deployments: [deployment], gitSha, manifests: manifests.manifests });
      const requests = { web: canonicalizeManagedAzureImportRequestV1({ intent, role: "web" }), worker: canonicalizeManagedAzureImportRequestV1({ intent, role: "worker" }) };
      await provider.observeRegistryPreflight({ webRequest: requests.web, workerRequest: requests.worker });
      const roles = {};
      for (const role of ROLES) {
        const observed = await provider.observeDestination(requests[role]);
        const compared = compareManagedAzureDestinationDigestV1({ expectedRequest: requests[role], observedRequest: observed.request, destinationDigest: observed.digest });
        if (compared.state === "CONFLICT") fail("MANAGED_RELEASE_DESTINATION_CONFLICT");
        roles[role] = { role, request: requests[role], digest: requests[role].binding.sourceDigest,
          image: `${target.acrServer}/${requests[role].binding.destinationRepository}@${requests[role].binding.sourceDigest}`,
          destinationState: compared.state === "MATCH" ? "MATCH" : "ABSENT" };
      }
      return { intent, roles };
    },
    importRole: async (rolePlan) => {
      const result = await importer.startManagedAzureImport(rolePlan.request).completion;
      if (result.outcome === "CONFIRMED_SUCCESS") {
        try {
          const observed = await provider.observeDestination(rolePlan.request);
          const compared = compareManagedAzureDestinationDigestV1({ expectedRequest: rolePlan.request, observedRequest: observed.request, destinationDigest: observed.digest });
          if (compared.state === "MATCH") return { terminal: true, succeeded: true, ambiguous: false, code: "IMPORT_VERIFIED" };
          return { terminal: true, succeeded: false, ambiguous: false, code: "IMPORT_DIGEST_MISMATCH" };
        } catch { return { terminal: false, succeeded: false, ambiguous: true, code: "IMPORT_READBACK_AMBIGUOUS" }; }
      }
      return { terminal: result.outcome !== "UNVERIFIED", succeeded: false, ambiguous: result.outcome === "UNVERIFIED", code: result.reason };
    },
  };
}

function cliInput(argv, env) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]; const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) fail("MANAGED_RELEASE_INPUT_INVALID");
    values[flag.slice(2)] = value;
  }
  return {
    inventoryRef: values["inventory-ref"],
    inventorySha256: values["inventory-sha256"],
    deploymentId: values["deployment-id"],
    releaseSha: values["release-sha"],
    releaseVersion: values["release-version"],
    reason: values.reason,
    execute: values.execute === "true" ? true : values.execute === "false" ? false : fail("MANAGED_RELEASE_INPUT_INVALID"),
    acrName: env.MANAGED_AZURE_ACR_NAME,
  };
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  const input = cliInput(process.argv.slice(2), process.env);
  runManagedAzureReleaseTransaction(input, runtimeDependencies())
    .then((result) => {
      process.exitCode = writeManagedAzureCliResult(result, input.execute);
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof ManagedAzureReleaseError ? error.code : "MANAGED_RELEASE_FAILED"}\n`);
      process.exitCode = 1;
    });
}
