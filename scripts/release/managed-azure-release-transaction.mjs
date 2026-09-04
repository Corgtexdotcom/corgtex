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
const WORKLOAD_CLASSES = Object.freeze(["ACTIVE_CLIENT_PRIMARY", "ACTIVE_CLIENT_CANARY"]);

class ManagedAzureReleaseError extends Error {
  constructor(code) {
    super(code);
    this.name = "ManagedAzureReleaseError";
    this.code = code;
  }
}

function fail(code) { throw new ManagedAzureReleaseError(code); }
function same(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
function releaseTargetWithAcrGroup(target, acrResourceGroup) { return Object.freeze({ ...target, acrResourceGroup }); }
function failureMessage(error) { return typeof error?.message === "string" ? error.message : ""; }
function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}
function diagnosticOperationId(leaseId, gitSha, purpose) {
  const value = createHash("sha256").update(`${purpose}:${leaseId}:${gitSha}`).digest("hex").slice(0, 32).split("");
  value[12] = "5";
  value[16] = (8 + (Number.parseInt(value[16], 16) % 4)).toString(16);
  const hex = value.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function preflightProjection(preflight) {
  return Object.freeze({
    deploymentId: preflight.deploymentId,
    ...(preflight.deployment ? { deployment: preflight.deployment } : {}),
    authorityDigest: preflight.authorityDigest,
    origin: preflight.origin,
    release: {
      baselineImageTag: preflight.release?.baselineImageTag,
      baselineVersion: preflight.release?.baselineVersion ?? null,
    },
    target: {
      subscriptionId: preflight.target?.subscriptionId,
      resourceGroup: preflight.target?.resourceGroup,
      acrName: preflight.target?.acrName,
      acrServer: preflight.target?.acrServer,
      webAppName: preflight.target?.webAppName,
      workerAppName: preflight.target?.workerAppName,
    },
  });
}
function preflightDigest(preflight) {
  return `sha256:${createHash("sha256").update(canonicalJson(preflightProjection(preflight))).digest("hex")}`;
}

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
  const keys = ["inventoryRef", "inventorySha256", "deploymentId", "workloadClass", "releaseSha", "releaseVersion", "reason", "execute", "acrName", "acrResourceGroup"];
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) fail("MANAGED_RELEASE_INPUT_INVALID");
  if (!UUID.test(value.inventoryRef) || !SHA256.test(value.inventorySha256) || !UUID.test(value.deploymentId)
    || !WORKLOAD_CLASSES.includes(value.workloadClass)
    || !SHA.test(value.releaseSha) || typeof value.releaseVersion !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(value.releaseVersion)
    || typeof value.reason !== "string" || value.reason.trim().length < 8 || value.reason.length > 256
    || typeof value.execute !== "boolean" || !/^[a-z0-9]{5,50}$/.test(value.acrName)
    || !/^[A-Za-z0-9][A-Za-z0-9_.()-]{0,89}$/.test(value.acrResourceGroup) || value.acrResourceGroup.endsWith(".")) fail("MANAGED_RELEASE_INPUT_INVALID");
  return Object.freeze({ ...value, reason: value.reason.trim(), acrServer: `${value.acrName}.azurecr.io` });
}

function releaseIdentity(imageTag, version) {
  if (!/^sha-[0-9a-f]{40}$/.test(imageTag) || typeof version !== "string") fail("MANAGED_RELEASE_BASELINE_INVALID");
  return Object.freeze({ gitSha: imageTag.slice(4), imageTag, version });
}

async function verifyImportedRole(deps, rolePlan) {
  try {
    return await deps.verifyImport(rolePlan);
  } catch {
    return { terminal: false, succeeded: false, ambiguous: true, code: "IMPORT_READBACK_AMBIGUOUS" };
  }
}

function confirmedImportReadbackResult(verified) {
  if (verified.succeeded) return verified;
  if (verified.code === "IMPORT_READBACK_ABSENT") return { terminal: true, succeeded: false, ambiguous: false, code: "IMPORT_DIGEST_MISMATCH" };
  return verified;
}

function leaseArgs(handle, extra = {}) {
  return { deploymentId: handle.deploymentId, leaseId: handle.leaseId, capability: handle.capability, fence: handle.fence, ...extra };
}

function safeResult(input, inventory, status, detail = {}) {
  return Object.freeze({
    status,
    deploymentId: input.deploymentId,
    workloadClass: input.workloadClass,
    inventoryRef: input.inventoryRef,
    inventorySha256: input.inventorySha256,
    inventoryCanonicalDigest: inventory.evaluation.canonicalDigest,
    releaseSha: input.releaseSha,
    releaseImageTag: `sha-${input.releaseSha}`,
    executionAllowed: input.workloadClass === "ACTIVE_CLIENT_PRIMARY",
    ...detail,
  });
}

export function managedAzureCliResultAccepted(result, execute) {
  return result?.status === "ALREADY_CURRENT" || (execute ? result?.status === "SUCCEEDED" : result?.status === "DRY_RUN_READY");
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
    || inventory.evaluation?.workloadClass !== input.workloadClass
    || !/^sha256:[0-9a-f]{64}$/.test(inventory.evaluation?.canonicalDigest)
    || !/^sha256:[0-9a-f]{64}$/.test(inventory.evaluation?.preflightDigest)) fail("MANAGED_RELEASE_INVENTORY_INVALID");
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
  if (input.execute && input.workloadClass === "ACTIVE_CLIENT_CANARY") fail("MANAGED_RELEASE_EXECUTION_NOT_ALLOWED");
  const inventory = verifyInventoryResponse(await deps.loadInventory(input), input);
  const configured = input.workloadClass === "ACTIVE_CLIENT_CANARY"
    ? { status: "RECONCILIATION_READY", effects: 0, target: { acrName: input.acrName, acrResourceGroup: input.acrResourceGroup, activationPolicy: "STANDARD" } }
    : await deps.targetConfig({ deploymentId: input.deploymentId, execute: false, reason: input.reason });
  if (configured?.status !== "RECONCILIATION_READY" || configured.effects !== 0 || configured.target?.acrName !== input.acrName
    || configured.target?.acrResourceGroup !== input.acrResourceGroup || !["STANDARD", "EXCLUSIVE"].includes(configured.target?.activationPolicy)) fail("MANAGED_RELEASE_TARGET_INVALID");
  const preflight = await deps.lease("preflight", { deploymentId: input.deploymentId, workloadClass: input.workloadClass, acrName: input.acrName, acrServer: input.acrServer });
  if (preflight.deploymentId !== input.deploymentId || preflight.target?.acrName !== input.acrName || preflight.target?.acrServer !== input.acrServer) fail("MANAGED_RELEASE_TARGET_INVALID");
  if (inventory.evaluation.preflightDigest !== preflightDigest(preflight)) fail("MANAGED_RELEASE_TARGET_INVALID");
  if (!SHA256.test(preflight.authorityDigest) || preflight.deployment?.deploymentId !== input.deploymentId || preflight.deployment?.workloadClass !== input.workloadClass) fail("MANAGED_RELEASE_TARGET_INVALID");
  const baselineRelease = releaseIdentity(preflight.release?.baselineImageTag, preflight.release?.baselineVersion);
  const nextRelease = Object.freeze({ gitSha: input.releaseSha, imageTag: `sha-${input.releaseSha}`, version: input.releaseVersion });
  let releasePlan;
  try {
    releasePlan = await deps.resolveRelease({ deploymentId: input.deploymentId,
      target: releaseTargetWithAcrGroup(preflight.target, input.acrResourceGroup), gitSha: input.releaseSha, workloadClass: input.workloadClass, deployment: preflight.deployment });
  } catch (error) {
    failReleaseResolution(error);
  }
  if (!releasePlan || ROLES.some((role) => !/^sha256:[0-9a-f]{64}$/.test(releasePlan.roles?.[role]?.digest)
    || !["MATCH", "ABSENT"].includes(releasePlan.roles?.[role]?.destinationState))) fail("MANAGED_RELEASE_IMAGE_PREFLIGHT_FAILED");
  const recoveryConfig = configured.target.recovery;
  const releaseApproval = configured.target.releaseApproval;
  if (input.workloadClass === "ACTIVE_CLIENT_PRIMARY" && (!releaseApproval || releaseApproval.gitSha !== input.releaseSha
    || !SHA256.test(releaseApproval.schemaApprovalDigest))) fail("MANAGED_RELEASE_SCHEMA_APPROVAL_REQUIRED");
  if (input.workloadClass === "ACTIVE_CLIENT_PRIMARY" && (!recoveryConfig || !SHA.test(recoveryConfig.gitSha) || typeof recoveryConfig.releaseVersion !== "string"
    || !SHA256.test(recoveryConfig.schemaCompatibilityApprovalDigest) || recoveryConfig.gitSha === input.releaseSha)) fail("MANAGED_RELEASE_RECOVERY_PREFLIGHT_FAILED");
  const recoveryRelease = input.workloadClass === "ACTIVE_CLIENT_PRIMARY"
    ? Object.freeze({ gitSha: recoveryConfig.gitSha, imageTag: `sha-${recoveryConfig.gitSha}`, version: recoveryConfig.releaseVersion }) : nextRelease;
  let recoveryPlan = releasePlan;
  try {
    if (input.workloadClass === "ACTIVE_CLIENT_PRIMARY") recoveryPlan = await deps.resolveRelease({ deploymentId: input.deploymentId,
      target: releaseTargetWithAcrGroup(preflight.target, input.acrResourceGroup), gitSha: recoveryRelease.gitSha,
      workloadClass: input.workloadClass, deployment: preflight.deployment });
  } catch { fail("MANAGED_RELEASE_RECOVERY_PREFLIGHT_FAILED"); }
  if (!recoveryPlan || ROLES.some((role) => !/^sha256:[0-9a-f]{64}$/.test(recoveryPlan.roles?.[role]?.digest)
    || !["MATCH", "ABSENT"].includes(recoveryPlan.roles?.[role]?.destinationState))) fail("MANAGED_RELEASE_RECOVERY_PREFLIGHT_FAILED");

  const baselines = {};
  for (const role of ROLES) baselines[role] = await readBaselineApp(deps, preflight.target, role, baselineRelease);
  const rollback = {
    schemaVersion: 2,
    target: preflight.target,
    previous: {
      releaseVersion: baselineRelease.version,
      web: { containerName: baselines.web.containerName, image: baselines.web.image, readyRevision: baselines.web.revisionName, templateDigest: baselines.web.templateDigest },
      worker: { containerName: baselines.worker.containerName, image: baselines.worker.image, readyRevision: baselines.worker.revisionName, templateDigest: baselines.worker.templateDigest },
    },
    incoming: { webDigest: releasePlan.roles.web.digest, workerDigest: releasePlan.roles.worker.digest,
      schemaApprovalDigest: `sha256:${releaseApproval?.schemaApprovalDigest ?? "0".repeat(64)}` },
    compatibleRecovery: { gitSha: recoveryRelease.gitSha, imageTag: recoveryRelease.imageTag, releaseVersion: recoveryRelease.version,
      web: { image: recoveryPlan.roles.web.image, digest: recoveryPlan.roles.web.digest },
      worker: { image: recoveryPlan.roles.worker.image, digest: recoveryPlan.roles.worker.digest },
      schemaCompatibilityApprovalDigest: `sha256:${recoveryConfig?.schemaCompatibilityApprovalDigest ?? "0".repeat(64)}`,
      acceptancePolicy: "AUTHENTICATED_WEB_AND_WORKER_IDENTITY_SCHEMA_V1", activationPolicy: configured.target.activationPolicy },
  };
  const baselineHealth = await deps.healthProbe({ origin: preflight.origin, release: baselineRelease });
  if (!baselineHealth.ok) fail("MANAGED_RELEASE_BASELINE_HEALTH_FAILED");
  await deps.authPreflight({ deploymentId: input.deploymentId, reason: input.reason, release: baselineRelease });
  if (baselineRelease.imageTag === nextRelease.imageTag) {
    if (baselineRelease.version !== nextRelease.version
      || ROLES.some((role) => baselines[role].imageDigest !== releasePlan.roles[role].digest)) fail("MANAGED_RELEASE_ALREADY_CURRENT_DRIFT");
    return safeResult(input, inventory, "ALREADY_CURRENT", { effects: 0 });
  }
  if (!input.execute) {
    return safeResult(input, inventory, "DRY_RUN_READY", {
      effects: 0,
      ...(input.workloadClass === "ACTIVE_CLIENT_PRIMARY" ? { schemaApprovalDigest: `sha256:${releaseApproval.schemaApprovalDigest}` } : {}),
      importsRequired: ROLES.filter((role) => releasePlan.roles[role].destinationState === "ABSENT"),
      recoveryImportsRequired: ROLES.filter((role) => recoveryPlan.roles[role].destinationState === "ABSENT"),
    });
  }

  let handle;
  let mutationBegun = false;
  let drainCompleted = false;
  let firstForwardPatchAttempted = false;
  const forwardTemplates = {};
  const heartbeat = () => deps.lease("heartbeat", leaseArgs(handle, { reason: input.reason }));
  const recoveryHeartbeat = () => deps.lease("heartbeat_recovery", leaseArgs(handle, { reason: input.reason }));
  const markRecovery = async (stage, code, detail = {}) => {
    if (handle) {
      try {
        await deps.lease("mark_recovery", leaseArgs(handle, { stage, code, reason: input.reason }));
      } catch {
        return safeResult(input, inventory, "RECOVERY_REQUIRED", {
          phase: "FENCING",
          code: "RECOVERY_RECORDING_FAILED",
          originatingPhase: stage,
          originatingCode: code,
          ...detail,
        });
      }
    }
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
    await recoveryHeartbeat();
    const recoveryTemplates = {};
    for (const role of ["web", "worker"]) {
      const current = classified[role].state;
      if (!current) return markRecovery("ROLLBACK", "COMPATIBLE_RECOVERY_STATE_AMBIGUOUS", detail);
      const suffix = managedAzureRevisionSuffix({ leaseId: handle.leaseId, fence: handle.fence, role, phase: "rollback" });
      const template = buildManagedAzureReleaseTemplate({
        baseline: current,
        role,
        image: recoveryPlan.roles[role].image,
        release: recoveryRelease,
        revisionSuffix: suffix,
      });
      assertManagedAzureTemplateDelta(current, template, { role, image: recoveryPlan.roles[role].image, release: recoveryRelease, revisionSuffix: suffix });
      recoveryTemplates[role] = template;
      const patched = await deps.patchTemplate({ target: preflight.target, role, location: current.location, template, onProgress: recoveryHeartbeat });
      const rollbackDetail = patched.providerCode ? { providerCode: patched.providerCode } : detail;
      if (!patched.terminal || !patched.succeeded) return markRecovery("ROLLBACK", patched.code ?? code, rollbackDetail);
      await recoveryHeartbeat();
      try {
        await deps.waitForState({ target: preflight.target, role, release: recoveryRelease, imageDigest: recoveryPlan.roles[role].digest, expectedTemplate: template, onProgress: recoveryHeartbeat });
      } catch { return markRecovery("ROLLBACK", "ROLLBACK_READBACK_AMBIGUOUS", rollbackDetail); }
      await recoveryHeartbeat();
    }
    const health = await deps.healthProbe({ origin: preflight.origin, release: recoveryRelease });
    if (!health.ok) return markRecovery("OBSERVATION", "COMPATIBLE_RECOVERY_HEALTH_FAILED", detail);
    try { await deps.authPreflight({ deploymentId: input.deploymentId, reason: input.reason, release: recoveryRelease }); }
    catch { return markRecovery("AUTH", "COMPATIBLE_RECOVERY_AUTH_FAILED", detail); }
    const operationId = diagnosticOperationId(handle.leaseId, recoveryRelease.gitSha, "compatible-recovery");
    const acceptance = await deps.acceptanceProbe({ deploymentId: input.deploymentId, origin: preflight.origin,
      operationId, release: recoveryRelease, reason: input.reason, onProgress: recoveryHeartbeat });
    if (!acceptance?.accepted || acceptance.webGitSha !== recoveryRelease.gitSha
      || acceptance.receipt?.workerGitSha !== recoveryRelease.gitSha || acceptance.receipt?.operationId !== operationId) {
      return markRecovery("DIAGNOSTIC", "COMPATIBLE_RECOVERY_DIAGNOSTIC_FAILED", detail);
    }
    const observed = await deps.observeNewRelease({ deploymentId: input.deploymentId, target: preflight.target, origin: preflight.origin,
      release: recoveryRelease, imageDigests: { web: recoveryPlan.roles.web.digest, worker: recoveryPlan.roles.worker.digest },
      durationMs: 15 * 60_000, onProgress: recoveryHeartbeat });
    if (!observed?.verified) return markRecovery("OBSERVATION", "COMPATIBLE_RECOVERY_OBSERVATION_FAILED", detail);
    const acceptanceEvidenceDigest = `sha256:${createHash("sha256").update(canonicalJson({ health, acceptance, observed,
      webDigest: recoveryPlan.roles.web.digest, workerDigest: recoveryPlan.roles.worker.digest })).digest("hex")}`;
    const finalized = await deps.lease("finalize_compatible_recovery", leaseArgs(handle, { reason: input.reason, evidence: {
      gitSha: recoveryRelease.gitSha, imageTag: recoveryRelease.imageTag, releaseVersion: recoveryRelease.version,
      webDigest: recoveryPlan.roles.web.digest, workerDigest: recoveryPlan.roles.worker.digest, acceptanceEvidenceDigest,
    } }));
    if (finalized?.status !== "RECOVERED_COMPATIBLE") return markRecovery("FENCING", "COMPATIBLE_RECOVERY_RECORDING_FAILED", detail);
    return safeResult(input, inventory, "RECOVERED_COMPATIBLE", { phase: stage, code, recoveryReleaseImageTag: recoveryRelease.imageTag, ...detail });
  };

  const restoreDrainedBaseline = async (stage, code) => {
    try {
      for (const role of ROLES) {
        const activated = await deps.setRevisionActive({ target: preflight.target, role, revisionName: baselines[role].revisionName,
          active: true, onProgress: recoveryHeartbeat });
        if (!activated?.terminal || !activated?.succeeded) return markRecovery("FENCING", "BASELINE_REACTIVATION_AMBIGUOUS");
      }
      for (const role of ROLES) {
        const restored = await deps.readApp({ target: preflight.target, role, release: baselineRelease, imageDigest: baselines[role].imageDigest });
        if (restored.templateDigest !== baselines[role].templateDigest) return markRecovery("FENCING", "BASELINE_REACTIVATION_DRIFT");
      }
      const health = await deps.healthProbe({ origin: preflight.origin, release: baselineRelease });
      if (!health.ok) return markRecovery("FENCING", health.code ?? "BASELINE_REACTIVATION_HEALTH_FAILED");
      return compensate(stage, code, forwardTemplates, { containment: "BASELINE_REACTIVATED" });
    } catch {
      return markRecovery("FENCING", "BASELINE_REACTIVATION_AMBIGUOUS");
    }
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
    if (!same(leasedTarget.target, preflight.target) || !same(leasedTarget.deployment, preflight.deployment) || leasedTarget.authorityDigest !== preflight.authorityDigest || leasedTarget.release?.baselineImageTag !== baselineRelease.imageTag) {
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
    for (const plan of [releasePlan, recoveryPlan]) for (const role of ROLES) {
      if (plan.roles[role].destinationState !== "ABSENT") continue;
      await heartbeat();
      let imported = await deps.importRole(plan.roles[role]);
      if ((!imported.terminal || !imported.succeeded) && imported.ambiguous) {
        const verified = await verifyImportedRole(deps, plan.roles[role]);
        imported = imported.confirmedProviderSuccess ? confirmedImportReadbackResult(verified) : verified;
      }
      if (!imported.terminal || !imported.succeeded) {
        const importDetail = {
          role,
          ...(Number.isInteger(imported.providerStatus) ? { providerStatus: imported.providerStatus } : {}),
          ...(imported.providerCode ? { providerCode: imported.providerCode } : {}),
        };
        if (imported.ambiguous) return markRecovery("IMPORT", imported.code ?? "IMPORT_AMBIGUOUS", importDetail);
        await deps.lease("abort", leaseArgs(handle, { reason: input.reason }));
        return safeResult(input, inventory, "REJECTED", { phase: "IMPORT", code: imported.code ?? "IMPORT_REJECTED", ...importDetail });
      }
      await heartbeat();
    }
    mutationBegun = true;
    await deps.lease("begin", leaseArgs(handle, { reason: input.reason }));
    if (configured.target.activationPolicy === "EXCLUSIVE") {
      await recoveryHeartbeat();
      const drained = await deps.drainBaseline({ target: preflight.target, baselines, handle, onProgress: recoveryHeartbeat });
      if (!drained?.terminal || !drained?.succeeded) return markRecovery("FENCING", "BASELINE_DRAIN_AMBIGUOUS",
        drained?.code ? { providerCode: drained.code } : {});
      drainCompleted = true;
      await recoveryHeartbeat();
    }
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

    await heartbeat();
    firstForwardPatchAttempted = true;
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
    const operationId = handle.leaseId;
    const acceptance = await deps.acceptanceProbe({ deploymentId: input.deploymentId, origin: preflight.origin,
      operationId, release: nextRelease, reason: input.reason, onProgress: heartbeat });
    if (!acceptance?.accepted || acceptance.webGitSha !== input.releaseSha || acceptance.receipt?.workerGitSha !== input.releaseSha
      || acceptance.receipt?.operationId !== operationId) return compensate("DIAGNOSTIC", "AUTHENTICATED_RELEASE_DIAGNOSTIC_FAILED", forwardTemplates);
    await heartbeat();
    const observed = await deps.observeNewRelease({ deploymentId: input.deploymentId, target: preflight.target, origin: preflight.origin,
      release: nextRelease, imageDigests: { web: releasePlan.roles.web.digest, worker: releasePlan.roles.worker.digest },
      durationMs: 15 * 60_000, onProgress: heartbeat });
    if (!observed?.verified) return compensate("OBSERVATION", observed?.code ?? "INITIAL_OBSERVATION_FAILED", forwardTemplates);
    await heartbeat();
    await deps.lease("finalize_success", leaseArgs(handle, { reason: input.reason }));
    return safeResult(input, inventory, "SUCCEEDED", { phase: "COMPLETE", schemaApprovalDigest: `sha256:${releaseApproval.schemaApprovalDigest}` });
  } catch (error) {
    if (!handle) throw error;
    if (!mutationBegun) {
      await deps.lease("abort", leaseArgs(handle, { reason: input.reason })).catch(() => undefined);
      throw error;
    }
    if (drainCompleted && !firstForwardPatchAttempted) {
      return restoreDrainedBaseline("FENCING", error instanceof ManagedAzureReleaseError ? error.code : "TRANSACTION_AMBIGUOUS");
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
  const runtime = {
    owner: `github:${env.GITHUB_RUN_ID || "manual"}:${env.GITHUB_RUN_ATTEMPT || "1"}`,
    templateDigest: managedAzureTemplateDigest,
    loadInventory: (input) => callControlPlane("get_managed_release_inventory", {
      inventoryRef: input.inventoryRef,
      expectedSha256: input.inventorySha256,
      deploymentId: input.deploymentId,
      workloadClass: input.workloadClass,
      acrName: input.acrName,
      acrServer: input.acrServer,
    }, env),
    targetConfig: ({ deploymentId, reason }) => callControlPlane("reconcile_managed_azure_target", { deploymentId, execute: false, reason }, env),
    lease: (operation, args) => callControlPlane("managed_release_lease", { operation, ...args }, env),
    readApp: apps.readApp,
    patchTemplate: apps.patchTemplate,
    waitForState: apps.waitForState,
    drainBaseline: apps.drainBaseline,
    setRevisionActive: apps.setRevisionActive,
    healthProbe: async ({ origin, release }) => {
      try {
        const response = await fetch(`${origin}/api/health`, { method: "GET", redirect: "error", signal: AbortSignal.timeout(20_000) });
        const text = await response.text();
        if (!response.ok || Buffer.byteLength(text, "utf8") > 32_768) return { ok: false, code: "HEALTH_PROBE_FAILED" };
        const body = JSON.parse(text);
        return { ok: managedAzureHealthReady(body, release), code: "HEALTH_RELEASE_MISMATCH" };
      } catch { return { ok: false, code: "HEALTH_PROBE_AMBIGUOUS" }; }
    },
    authPreflight: async ({ deploymentId, reason }) => {
      const result = await callControlPlane("read_managed_release_auth", { deploymentId, mode: "preflight" }, env);
      if (result?.status !== "READY" || result.effects !== 0) fail("MANAGED_RELEASE_AUTH_PREFLIGHT_FAILED");
      return { ok: true };
    },
    acceptanceProbe: async ({ deploymentId, operationId, release, reason, onProgress }) => {
      const start = await callControlPlane("dispatch_managed_release_diagnostic", {
        deploymentId, operationId, expectedGitSha: release.gitSha, reason,
      }, env);
      if (start?.status !== "COMPLETED" || !UUID.test(start.workspaceId)) return { accepted: false };
      let retryRequested = false;
      for (let attempt = 0; attempt < 30; attempt += 1) {
        await onProgress();
        const value = await callControlPlane("read_managed_release_auth", { deploymentId, mode: "status",
          operationId, expectedGitSha: release.gitSha }, env);
        if (value?.accepted === true && value.workspaceId === start.workspaceId) return value;
        if (value?.status === "FAILED") {
          if (value.attempts !== 1 || retryRequested) return { accepted: false };
          retryRequested = true;
          try {
            const retry = await callControlPlane("dispatch_managed_release_diagnostic", {
              deploymentId, operationId, expectedGitSha: release.gitSha, reason, retryAttempt: 1,
            }, env);
            if (retry?.status !== "COMPLETED" || retry.workspaceId !== start.workspaceId) return { accepted: false };
          } catch { /* Reconcile an uncertain retry response by status; never issue it twice in this run. */ }
          continue;
        }
        await new Promise((resolve) => setTimeout(resolve, 10_000));
      }
      return { accepted: false };
    },
    observeNewRelease: async ({ target, origin, release, imageDigests, durationMs, onProgress }) => {
      const started = Date.now();
      while (Date.now() - started < durationMs) {
        await onProgress();
        for (const role of ROLES) await apps.readApp({ target, role, release, imageDigest: imageDigests[role] });
        const health = await runtime.healthProbe({ origin, release });
        if (!health.ok) return { verified: false, code: health.code };
        await new Promise((resolve) => setTimeout(resolve, Math.min(60_000, durationMs - (Date.now() - started))));
      }
      return { verified: true, durationMs };
    },
    resolveRelease: async ({ deploymentId, target, gitSha, deployment }) => {
      const manifests = await sourceResolver.resolveManagedAzureSourceManifests({ gitSha });
      const intent = canonicalizeManagedAzureReleaseIntentV1({ deploymentId, deployments: [{ ...deployment, azure: target }], gitSha, manifests: manifests.manifests });
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
    verifyImport: async (rolePlan) => {
      const observed = await provider.observeDestination(rolePlan.request);
      const compared = compareManagedAzureDestinationDigestV1({ expectedRequest: rolePlan.request, observedRequest: observed.request, destinationDigest: observed.digest });
      if (compared.state === "MATCH") return { terminal: true, succeeded: true, ambiguous: false, code: "IMPORT_VERIFIED" };
      if (compared.state === "CONFLICT") return { terminal: true, succeeded: false, ambiguous: false, code: "IMPORT_DESTINATION_CONFLICT" };
      return { terminal: false, succeeded: false, ambiguous: true, code: "IMPORT_READBACK_ABSENT" };
    },
    importRole: async (rolePlan) => {
      const result = await importer.startManagedAzureImport(rolePlan.request).completion;
      const detail = {
        ...(Number.isInteger(result.providerStatus) ? { providerStatus: result.providerStatus } : {}),
        ...(result.providerCode ? { providerCode: result.providerCode } : {}),
      };
      if (result.outcome === "CONFIRMED_SUCCESS") {
        const verified = await verifyImportedRole(runtime, rolePlan);
        return { ...confirmedImportReadbackResult(verified), ...(verified.ambiguous ? { confirmedProviderSuccess: true } : {}), ...detail };
      }
      return { terminal: result.outcome !== "UNVERIFIED", succeeded: false, ambiguous: result.outcome === "UNVERIFIED", code: result.reason, ...detail };
    },
  };
  return runtime;
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
    workloadClass: values["workload-class"],
    releaseSha: values["release-sha"],
    releaseVersion: values["release-version"],
    reason: values.reason,
    execute: values.execute === "true" ? true : values.execute === "false" ? false : fail("MANAGED_RELEASE_INPUT_INVALID"),
    acrName: env.MANAGED_AZURE_ACR_NAME,
    acrResourceGroup: env.MANAGED_AZURE_ACR_RESOURCE_GROUP,
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
