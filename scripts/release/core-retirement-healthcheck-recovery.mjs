import { readFile } from "node:fs/promises";
import { identityHash, sha256 } from "../accepted-core-baseline.mjs";
import { RECONCILIATION_CASE } from "./core-retirement-reconciliation.mjs";
import { need, CORE_BEFORE, CORE_SOURCE_SHA, CORE_RETIREMENT_TARGET, ROLES,
  assertQuietTriggers, validateRetirementApproval } from "./core-retirement.mjs";

export const HEALTHCHECK_STEP = "Recover Core worker healthcheck retirement";
export const HEALTHCHECK_CASE = JSON.parse(await readFile(new URL("../../.github/core-retirement-healthcheck-recovery.json", import.meta.url), "utf8"));
const same = (a, b) => identityHash(a) === identityHash(b);
const INACTIVE = new Set(["CRASHED", "EXITED", "REMOVED", "SKIPPED", "STOPPED"]);
const EVIDENCE = ["baselineReceiptSha256", "opsSnapshotSha256", "imageStartupProofSha256"];

export function assertHealthcheckRecoveryStart(state, receipt) {
  const incident = HEALTHCHECK_CASE;
  // Authenticate the actual failed projection before inspecting it. Never rewrite
  // latest FAILED into the prior SUCCESS or replace the failed image's null digest.
  need(identityHash(state) === incident.expectedProviderSha256
    && state.configIdentity === incident.privateConfigSha256, "HEALTHCHECK_RECOVERY_STATE_CHANGED");
  need(sha256(incident.predecessorWorkerStartCommand) === incident.predecessorWorkerStartCommandSha256,
    "HEALTHCHECK_PREDECESSOR_COMMAND_INVALID");
  assertQuietTriggers(state.fence);
  for (const role of ROLES) {
    const stage = state.stages[role], original = { id: CORE_BEFORE[role], status: "SUCCESS" };
    const latest = role === "worker" ? { id: incident.failedWorkerDeploymentId, status: "FAILED" } : original;
    const digest = receipt.evidence.images[role].digest;
    need(same(stage.latestDeployment, latest) && same(stage.activeDeployments, [original])
      && stage.history.some(row => row.id === original.id && row.status === "SUCCESS" && row.digest === digest),
    "HEALTHCHECK_RECOVERY_DEPLOYMENT_CHANGED");
    need(stage.image === `ghcr.io/corgtexdotcom/corgtex/${role}@${digest}`
      || stage.image === `ghcr.io/corgtexdotcom/corgtex/${role}:sha-${CORE_SOURCE_SHA}`, "HEALTHCHECK_RECOVERY_IMAGE_CHANGED");
    need(stage.startCommand === (role === "worker" ? incident.predecessorWorkerStartCommand : "npm run start --workspace=@corgtex/web")
      && stage.releaseSettings.CORGTEX_RELEASE_GIT_SHA === CORE_SOURCE_SHA
      && stage.releaseSettings.CORGTEX_RELEASE_IMAGE_TAG === `sha-${CORE_SOURCE_SHA}`
      && stage.releaseSettings.CORGTEX_RELEASE_VERSION === `main-${CORE_SOURCE_SHA.slice(0, 12)}`
      && stage.releaseSettings.CORGTEX_STARTUP_MODE === "web", "HEALTHCHECK_RECOVERY_CONFIGURATION_CHANGED");
    const service = state.fence.services.find(row => row.serviceId === CORE_RETIREMENT_TARGET[`${role}ServiceId`]);
    const active = service.activeDeployments;
    need(active.length === 1 && active[0].id === original.id && active[0].status === "SUCCESS" && active[0].deploymentStopped === false
      && active[0].instances.length > 0 && active[0].instances.every(instance => instance.status === "RUNNING"),
    "HEALTHCHECK_RECOVERY_ORIGINAL_RUNTIME_CHANGED");
    if (role === "worker") {
      const failed = service.deployments.find(row => row.id === incident.failedWorkerDeploymentId);
      need(stage.history.some(row => row.id === incident.failedWorkerDeploymentId && row.status === "FAILED" && row.digest === null)
        && failed?.status === "FAILED" && failed.deploymentStopped === true
        && failed.instances.every(instance => INACTIVE.has(instance.status)), "HEALTHCHECK_FAILED_UTILITY_NOT_STOPPED");
    }
  }
  // The read-only witness pins /healthz +100s in the private configuration hash.
  // The public stage intentionally contains no raw environment configuration.
  need(incident.workerHealthcheck.path === "/healthz" && incident.workerHealthcheck.timeout === 100,
    "HEALTHCHECK_POLICY_CHANGED");
}

export function validateHealthcheckPredecessors(firstIntent, secondIntent) {
  const incident = HEALTHCHECK_CASE, original = RECONCILIATION_CASE;
  need(same(incident.predecessor, original) && incident.originalApprovalHash === original.originalApprovalHash,
    "HEALTHCHECK_ORIGINAL_CASE_CHANGED");
  need(firstIntent?.runId === String(original.runId) && firstIntent.workflowSha === original.workflowSha
    && firstIntent.approvalHash === original.originalApprovalHash && identityHash(firstIntent.approval) === original.originalApprovalHash
    && firstIntent.providerBeforeSha256 === original.providerBeforeSha256
    && same(firstIntent.target, CORE_RETIREMENT_TARGET) && same(firstIntent.before, CORE_BEFORE), "HEALTHCHECK_FIRST_INTENT_INVALID");
  need(secondIntent?.runId === String(incident.runId) && secondIntent.workflowSha === incident.workflowSha
    && secondIntent.approvalHash === incident.retirementApprovalHash && identityHash(secondIntent.approval) === incident.retirementApprovalHash
    && secondIntent.providerBeforeSha256 === incident.providerBeforeSha256
    && same(secondIntent.target, CORE_RETIREMENT_TARGET) && same(secondIntent.before, CORE_BEFORE)
    && same(secondIntent.predecessor, original), "HEALTHCHECK_SECOND_INTENT_INVALID");
  const reconciliation = secondIntent.reconciliation;
  need(identityHash(reconciliation) === incident.reconciliationApprovalHash
    && reconciliation.schemaVersion === 1 && reconciliation.kind === "core-logical-retirement-reconciliation"
    && reconciliation.caseSha256 === identityHash(original) && reconciliation.failedRunId === original.runId
    && reconciliation.originalApprovalHash === original.originalApprovalHash
    && reconciliation.expectedProviderSha256 === original.providerBeforeSha256
    && reconciliation.expectedPrivateConfigSha256 === incident.privateConfigSha256
    && same(reconciliation.retirementApproval, secondIntent.approval), "HEALTHCHECK_RECONCILIATION_CHAIN_INVALID");
  need(EVIDENCE.every(key => firstIntent[key] === secondIntent[key] && firstIntent.approval[key] === firstIntent[key]
    && secondIntent.approval[key] === secondIntent[key])
    && secondIntent.approval.providerBeforeSha256 === incident.providerBeforeSha256
    && firstIntent.approval.providerBeforeSha256 === original.providerBeforeSha256,
  "HEALTHCHECK_PREDECESSOR_EVIDENCE_CHANGED");
  return secondIntent;
}

export function validateHealthcheckRecoveryApproval(envelope, hash, secondIntent, now = Date.now()) {
  const incident = HEALTHCHECK_CASE;
  need(envelope?.schemaVersion === 1 && envelope.kind === "core-logical-retirement-healthcheck-recovery"
    && /^[a-f0-9]{64}$/.test(hash) && identityHash(envelope) === hash
    && envelope.caseSha256 === identityHash(incident) && envelope.failedRunId === incident.runId
    && envelope.originalApprovalHash === incident.originalApprovalHash
    && envelope.reconciliationApprovalHash === incident.reconciliationApprovalHash
    && envelope.expectedProviderSha256 === incident.expectedProviderSha256
    && envelope.expectedPrivateConfigSha256 === incident.privateConfigSha256, "HEALTHCHECK_RECOVERY_APPROVAL_INVALID");
  const age = now - Date.parse(envelope.reviewedAt);
  need(age >= 0 && age <= 3600000, "HEALTHCHECK_RECOVERY_APPROVAL_STALE");
  need(secondIntent?.runId === String(incident.runId) && secondIntent.workflowSha === incident.workflowSha
    && secondIntent.approvalHash === incident.retirementApprovalHash && identityHash(secondIntent.approval) === incident.retirementApprovalHash
    && identityHash(secondIntent.reconciliation) === incident.reconciliationApprovalHash
    && same(secondIntent.predecessor, RECONCILIATION_CASE)
    && EVIDENCE.every(key => secondIntent[key] === secondIntent.approval[key])
    && secondIntent.providerBeforeSha256 === incident.providerBeforeSha256, "HEALTHCHECK_RECOVERY_PREDECESSOR_INVALID");
  const current = envelope.retirementApproval;
  need(current && EVIDENCE.every(key => current[key] === secondIntent[key])
    && current.providerBeforeSha256 === incident.expectedProviderSha256, "HEALTHCHECK_RECOVERY_START_CHANGED");
  validateRetirementApproval(current, { ...secondIntent, providerBeforeSha256: incident.expectedProviderSha256 }, identityHash(current), now);
  return current;
}
