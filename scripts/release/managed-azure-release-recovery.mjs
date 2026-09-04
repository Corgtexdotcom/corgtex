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
import { createHash } from "node:crypto";

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
function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}
function diagnosticOperationId(leaseId, gitSha, purpose) {
  const value = createHash("sha256").update(`${purpose}:${leaseId}:${gitSha}`).digest("hex").slice(0, 32).split("");
  value[12] = "5";
  value[16] = (8 + (Number.parseInt(value[16], 16) % 4)).toString(16);
  const hex = value.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
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

function verifyCompatibleRecoveryRole(role, state, status, rollback, baseline, recovery, recoveryRelease, expectedRevisionSuffix) {
  if (state.imageDigest !== recovery[role].digest || state.image !== recovery[role].image
    || state.revisionSuffix !== expectedRevisionSuffix) fail(`MANAGED_RELEASE_RECOVERY_${role.toUpperCase()}_DRIFT`);
  const reconstructedBaseline = buildManagedAzureReleaseTemplate({
    baseline: state,
    role,
    image: rollback.previous[role].image,
    release: baseline,
    revisionSuffix: matchingBaselineRevisionSuffix(role, state, rollback, baseline, rollback.previous[role].templateDigest),
  });
  if (managedAzureTemplateDigest(reconstructedBaseline) !== rollback.previous[role].templateDigest) fail(`MANAGED_RELEASE_RECOVERY_${role.toUpperCase()}_DRIFT`);
  assertManagedAzureTemplateDelta({ ...state, template: reconstructedBaseline }, state.template, {
    role, image: recovery[role].image, release: recoveryRelease, revisionSuffix: expectedRevisionSuffix,
  });
  if (state.appName !== status.target[role === "web" ? "webAppName" : "workerAppName"]) fail(`MANAGED_RELEASE_RECOVERY_${role.toUpperCase()}_DRIFT`);
}

async function classifyCompatibleRecoveryRole(deps, status, rollback, role, baseline, recovery, recoveryRelease, expectedRevisionSuffix) {
  try {
    const state = await deps.readApp({ target: status.target, role, release: recoveryRelease,
      imageDigest: recovery[role].digest, ambiguous: true });
    verifyCompatibleRecoveryRole(role, state, status, rollback, baseline, recovery, recoveryRelease, expectedRevisionSuffix);
    return { kind: "COMPATIBLE_RECOVERY", state };
  } catch { /* Unknown live state remains blocked for manual investigation. */ }
  return { kind: "UNKNOWN", state: null };
}

async function verifyRecoveryReleaseAcceptance(deps, { deploymentId, target, origin, release, imageDigests,
  operationId, reason, heartbeat, failurePrefix, handle }) {
  const block = async (stage, code) => {
    await deps.lease("mark_recovery", leaseArgs(handle, { stage, code, reason })).catch(() => undefined);
    fail(code);
  };
  const health = await deps.healthProbe({ origin, release });
  if (!health.ok) await block("OBSERVATION", health.code ?? `${failurePrefix}_HEALTH_FAILED`);
  try { await deps.authPreflight({ deploymentId, reason, release }); }
  catch { await block("AUTH", `${failurePrefix}_AUTH_FAILED`); }
  const acceptance = await deps.acceptanceProbe({ deploymentId, origin, operationId, release, reason, onProgress: heartbeat });
  if (!acceptance?.accepted || acceptance.webGitSha !== release.gitSha
    || acceptance.receipt?.workerGitSha !== release.gitSha || acceptance.receipt?.operationId !== operationId) {
    await block("DIAGNOSTIC", `${failurePrefix}_DIAGNOSTIC_FAILED`);
  }
  const observed = await deps.observeNewRelease({ deploymentId, target, origin, release, imageDigests,
    durationMs: 15 * 60_000, onProgress: heartbeat });
  if (!observed?.verified) await block("OBSERVATION", `${failurePrefix}_OBSERVATION_FAILED`);
  const acceptanceEvidenceDigest = `sha256:${createHash("sha256").update(canonicalJson({ health, acceptance, observed,
    webDigest: imageDigests.web, workerDigest: imageDigests.worker })).digest("hex")}`;
  return { health, acceptance, observed, acceptanceEvidenceDigest };
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
    if (rollback.schemaVersion === 2) {
      const pendingIncoming = incomingReleaseIdentity(status);
      if (web.kind !== "BASELINE") web = await classifyForwardRole(deps, status, rollback, "web", baseline, pendingIncoming, forwardSuffixes.web);
      if (worker.kind !== "BASELINE") worker = await classifyForwardRole(deps, status, rollback, "worker", baseline, pendingIncoming, forwardSuffixes.worker);
      const recovery = rollback.compatibleRecovery;
      const recoveryRelease = releaseIdentity(recovery.imageTag, recovery.releaseVersion);
      if (web.kind === "UNKNOWN") web = await classifyCompatibleRecoveryRole(deps, status, rollback, "web", baseline, recovery, recoveryRelease, rollbackSuffixes.web);
      if (worker.kind === "UNKNOWN") worker = await classifyCompatibleRecoveryRole(deps, status, rollback, "worker", baseline, recovery, recoveryRelease, rollbackSuffixes.worker);
    }
    if (rollback.schemaVersion === 2 && (web.kind !== "BASELINE" || worker.kind !== "BASELINE")) {
      const recovery = rollback.compatibleRecovery;
      const heartbeat = () => deps.lease("heartbeat_recovery", leaseArgs(handle, { reason: input.reason }));
      const recoveryRelease = releaseIdentity(recovery.imageTag, recovery.releaseVersion);
      const current = { web, worker };
      for (const role of ["web", "worker"]) {
        if (!current[role].state) fail("MANAGED_RELEASE_RECOVERY_MIXED_STATE_UNSUPPORTED");
        if (current[role].kind === "COMPATIBLE_RECOVERY") {
          continue;
        }
        const revisionSuffix = rollbackSuffixes[role];
        const image = recovery[role].image;
        const template = buildManagedAzureReleaseTemplate({ baseline: current[role].state, role, image, release: recoveryRelease, revisionSuffix });
        assertManagedAzureTemplateDelta(current[role].state, template, { role, image, release: recoveryRelease, revisionSuffix });
        await heartbeat();
        const patched = await deps.patchTemplate({ target: status.target, role, location: current[role].state.location, template, onProgress: heartbeat });
        if (!patched.terminal || !patched.succeeded) fail("MANAGED_RELEASE_RECOVERY_COMPATIBLE_PATCH_AMBIGUOUS");
        await deps.waitForState({ target: status.target, role, release: recoveryRelease, imageDigest: recovery[role].digest, expectedTemplate: template, onProgress: heartbeat });
      }
      for (const role of ["web", "worker"]) {
        const verified = await classifyCompatibleRecoveryRole(deps, status, rollback, role, baseline, recovery, recoveryRelease, rollbackSuffixes[role]);
        if (verified.kind !== "COMPATIBLE_RECOVERY") fail("MANAGED_RELEASE_RECOVERY_COMPATIBLE_READBACK_AMBIGUOUS");
      }
      const health = await deps.healthProbe({ origin: status.origin, release: recoveryRelease });
      if (!health.ok) fail("MANAGED_RELEASE_RECOVERY_COMPATIBLE_HEALTH_FAILED");
      await deps.authPreflight({ deploymentId: input.deploymentId, reason: input.reason, release: recoveryRelease });
      const operationId = diagnosticOperationId(originatingLease.leaseId, recoveryRelease.gitSha, "compatible-recovery");
      const acceptance = await deps.acceptanceProbe({ deploymentId: input.deploymentId, origin: status.origin,
        operationId, release: recoveryRelease, reason: input.reason, onProgress: heartbeat });
      if (!acceptance?.accepted || acceptance.webGitSha !== recoveryRelease.gitSha
        || acceptance.receipt?.workerGitSha !== recoveryRelease.gitSha || acceptance.receipt?.operationId !== operationId) {
        fail("MANAGED_RELEASE_RECOVERY_COMPATIBLE_DIAGNOSTIC_FAILED");
      }
      const observed = await deps.observeNewRelease({ deploymentId: input.deploymentId, target: status.target, origin: status.origin,
        release: recoveryRelease, imageDigests: { web: recovery.web.digest, worker: recovery.worker.digest }, durationMs: 15 * 60_000, onProgress: heartbeat });
      if (!observed?.verified) fail("MANAGED_RELEASE_RECOVERY_COMPATIBLE_OBSERVATION_FAILED");
      const acceptanceEvidenceDigest = `sha256:${createHash("sha256").update(canonicalJson({ health, acceptance, observed, webDigest: recovery.web.digest, workerDigest: recovery.worker.digest })).digest("hex")}`;
      const finalized = await deps.lease("finalize_compatible_recovery", leaseArgs(handle, { reason: input.reason, evidence: {
        gitSha: recovery.gitSha, imageTag: recovery.imageTag, releaseVersion: recovery.releaseVersion,
        webDigest: recovery.web.digest, workerDigest: recovery.worker.digest, acceptanceEvidenceDigest,
      } }));
      if (finalized?.status !== "RECOVERED_COMPATIBLE") fail("MANAGED_RELEASE_RECOVERY_FINALIZE_REJECTED");
      return Object.freeze({ status: "RECOVERY_CLEARED", resolution: "COMPATIBLE_RECOVERY", deploymentId: input.deploymentId,
        previousLeaseId: status.leaseId, previousFence: status.fence, fence: finalized.fence,
        releaseImageTag: finalized.releaseImageTag, releaseVersion: finalized.releaseVersion });
    }
    if (web.kind === "BASELINE" && worker.kind === "BASELINE") {
      const heartbeat = () => deps.lease("heartbeat_recovery", leaseArgs(handle, { reason: input.reason }));
      const exclusive = rollback.schemaVersion === 2 && rollback.compatibleRecovery.activationPolicy === "EXCLUSIVE";
      let rollbackEvidence;
      if (exclusive) {
        for (const role of ["web", "worker"]) {
          const activated = await deps.setRevisionActive({ target: status.target, role, revisionName: rollback.previous[role].readyRevision,
            active: true, onProgress: heartbeat });
          if (!activated.terminal || !activated.succeeded) fail("MANAGED_RELEASE_RECOVERY_REACTIVATION_AMBIGUOUS");
        }
        const operationId = diagnosticOperationId(originatingLease.leaseId, baseline.gitSha, "baseline-rollback");
        const imageDigests = { web: digestFromImage(rollback.previous.web.image), worker: digestFromImage(rollback.previous.worker.image) };
        const proof = await verifyRecoveryReleaseAcceptance(deps, { deploymentId: input.deploymentId, target: status.target,
          origin: status.origin, release: baseline, imageDigests, operationId, reason: input.reason, heartbeat,
          failurePrefix: "MANAGED_RELEASE_RECOVERY_ROLLBACK", handle });
        rollbackEvidence = { gitSha: baseline.gitSha, imageTag: baseline.imageTag, releaseVersion: baseline.version,
          webDigest: imageDigests.web, workerDigest: imageDigests.worker, operationId,
          acceptanceEvidenceDigest: proof.acceptanceEvidenceDigest };
      }
      const finalized = await deps.lease("finalize_rollback", leaseArgs(handle, { reason: input.reason,
        ...(rollbackEvidence ? { evidence: rollbackEvidence } : {}) }));
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
      let rollbackEvidence;
      if (rollback.schemaVersion === 2 && rollback.compatibleRecovery.activationPolicy === "EXCLUSIVE") {
        const operationId = diagnosticOperationId(originatingLease.leaseId, baseline.gitSha, "baseline-rollback");
        const imageDigests = { web: digestFromImage(rollback.previous.web.image), worker: digestFromImage(rollback.previous.worker.image) };
        const proof = await verifyRecoveryReleaseAcceptance(deps, { deploymentId: input.deploymentId, target: status.target,
          origin: status.origin, release: baseline, imageDigests, operationId, reason: input.reason, heartbeat,
          failurePrefix: "MANAGED_RELEASE_RECOVERY_ROLLBACK", handle });
        rollbackEvidence = { gitSha: baseline.gitSha, imageTag: baseline.imageTag, releaseVersion: baseline.version,
          webDigest: imageDigests.web, workerDigest: imageDigests.worker, operationId,
          acceptanceEvidenceDigest: proof.acceptanceEvidenceDigest };
      } else {
        const health = await deps.healthProbe({ origin: status.origin, release: baseline });
        if (!health.ok) fail("MANAGED_RELEASE_RECOVERY_ROLLBACK_HEALTH_FAILED");
      }
      const finalized = await deps.lease("finalize_rollback", leaseArgs(handle, { reason: input.reason,
        ...(rollbackEvidence ? { evidence: rollbackEvidence } : {}) }));
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
      await verifyRecoveryReleaseAcceptance(deps, { deploymentId: input.deploymentId, target: status.target,
        origin: status.origin, release: incoming, imageDigests: { web: rollback.incoming.webDigest, worker: rollback.incoming.workerDigest },
        operationId: originatingLease.leaseId, reason: input.reason,
        heartbeat: () => deps.lease("heartbeat", leaseArgs(handle, { reason: input.reason })),
        failurePrefix: "MANAGED_RELEASE_RECOVERY_FORWARD", handle });
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
      await verifyRecoveryReleaseAcceptance(deps, { deploymentId: input.deploymentId, target: status.target,
        origin: status.origin, release: incoming, imageDigests: { web: rollback.incoming.webDigest, worker: rollback.incoming.workerDigest },
        operationId: originatingLease.leaseId, reason: input.reason,
        heartbeat: () => deps.lease("heartbeat", leaseArgs(handle, { reason: input.reason })),
        failurePrefix: "MANAGED_RELEASE_RECOVERY_FORWARD", handle });
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
  const healthProbe = async ({ origin, release }) => {
    try {
      const response = await fetch(`${origin}/api/health`, { method: "GET", redirect: "error", signal: AbortSignal.timeout(20_000) });
      const text = await response.text();
      if (!response.ok || Buffer.byteLength(text, "utf8") > 32_768) return { ok: false, code: "HEALTH_PROBE_FAILED" };
      const body = JSON.parse(text);
      return { ok: managedAzureHealthReady(body, release), code: "HEALTH_RELEASE_MISMATCH" };
    } catch { return { ok: false, code: "HEALTH_PROBE_AMBIGUOUS" }; }
  };
  return {
    owner: `github:${env.GITHUB_RUN_ID || "manual"}:${env.GITHUB_RUN_ATTEMPT || "1"}:recovery`,
    lease: (operation, args) => callControlPlane("managed_release_lease", { operation, ...args }, env),
    readApp: apps.readApp,
    patchTemplate: apps.patchTemplate,
    waitForState: apps.waitForState,
    setRevisionActive: apps.setRevisionActive,
    healthProbe,
    authPreflight: async ({ deploymentId, reason }) => {
      const result = await callControlPlane("read_managed_release_auth", { deploymentId, mode: "preflight" }, env);
      if (result?.status !== "READY" || result.effects !== 0) fail("MANAGED_RELEASE_RECOVERY_AUTH_FAILED");
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
        for (const role of ["web", "worker"]) await apps.readApp({ target, role, release, imageDigest: imageDigests[role] });
        const health = await healthProbe({ origin, release }); if (!health.ok) return { verified: false, code: health.code };
        await new Promise((resolve) => setTimeout(resolve, Math.min(60_000, durationMs - (Date.now() - started))));
      }
      return { verified: true, durationMs };
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
