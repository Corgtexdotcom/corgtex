import { readFile } from "node:fs/promises";
import { identityHash, sha256 } from "../accepted-core-baseline.mjs";
import { need, CORE_BEFORE, CORE_SOURCE_SHA, CORE_RETIREMENT_TARGET as target, ROLES,
  retirementCommand, assertQuietTriggers, validateRetirementBaseline } from "./core-retirement.mjs";
import { HEALTHCHECK_CASE } from "./core-retirement-healthcheck-recovery.mjs";
import { WEB_COMPLETION_CASE, validateWebCompletionPredecessors, verifyWebCompletionContinuity } from "./core-retirement-web-completion.mjs";

export const FINALIZATION_CASE = JSON.parse(await readFile(new URL("../../.github/core-retirement-finalization.json", import.meta.url), "utf8"));
const same = (a, b) => identityHash(a) === identityHash(b);
const EVIDENCE = ["baselineReceiptSha256", "opsSnapshotSha256", "imageStartupProofSha256"];
const INACTIVE = new Set(["CRASHED", "EXITED", "REMOVED", "SKIPPED", "STOPPED"]);
const service = (state, role) => state.fence.services.find(row => row.serviceId === target[`${role}ServiceId`]);
const bound = (row, role) => row?.projectId === target.projectId && row.environmentId === target.environmentId && row.serviceId === target[`${role}ServiceId`];
const stopped = row => row?.deploymentStopped === true && row.instances?.length > 0 && row.instances.every(i => INACTIVE.has(i.status));
const running = row => row?.deploymentStopped === false && row.instances?.length > 0 && row.instances.every(i => i.status === "RUNNING");
const QUERY = "query CoreRetirementFinalizationContinuity($id:String!) { deployment(id:$id) { id projectId environmentId serviceId status deploymentStopped instances { id status } meta } }";

/** Historical approvals authenticate consumed writes; they do not authorize any new write. */
export function validateFinalizationPredecessors(first, second, third, fourth) {
  validateWebCompletionPredecessors(first, second, third);
  const c = FINALIZATION_CASE, prior = WEB_COMPLETION_CASE;
  need(same(c.predecessor, prior) && fourth?.runId === String(c.runId) && fourth.workflowSha === c.workflowSha
    && fourth.approvalHash === c.retirementApprovalHash && identityHash(fourth.approval) === c.retirementApprovalHash
    && same(fourth.predecessor, prior) && same(fourth.target, target) && same(fourth.before, CORE_BEFORE)
    && fourth.providerBeforeSha256 === c.providerBeforeSha256 && c.providerBeforeSha256 === prior.expectedProviderSha256,
  "FINALIZATION_FOURTH_INTENT_INVALID");
  const envelope = fourth.webCompletionApproval;
  need(envelope?.schemaVersion === 1 && envelope.kind === "core-logical-retirement-web-completion"
    && identityHash(envelope) === c.webCompletionApprovalHash && envelope.caseSha256 === identityHash(prior)
    && envelope.failedRunId === prior.runId && envelope.healthcheckApprovalHash === prior.healthcheckApprovalHash
    && envelope.expectedProviderSha256 === prior.expectedProviderSha256 && envelope.expectedPrivateConfigSha256 === prior.privateConfigSha256
    && envelope.retainedWorkerDeploymentId === prior.workerDeploymentId && envelope.retainedWorkerProofSha256 === prior.workerProofSha256
    && same(envelope.retirementApproval, fourth.approval)
    && EVIDENCE.every(key => fourth[key] === third[key] && fourth[key] === c[key] && fourth.approval[key] === fourth[key]),
  "FINALIZATION_CHAIN_INVALID");
  return fourth;
}

function assertFinalizedState(state, receipt) {
  const c = FINALIZATION_CASE;
  need(identityHash(state) === c.expectedProviderSha256 && state.configIdentity === c.privateConfigSha256, "FINALIZATION_STATE_CHANGED");
  assertQuietTriggers(state.fence);
  need(state.fence.binding?.projectId === target.projectId && state.fence.binding.environmentId === target.environmentId
    && same([...state.fence.binding.serviceIds].sort(), [target.webServiceId, target.workerServiceId].sort()), "FINALIZATION_TARGET_CHANGED");
  need(c.roleProofs.worker.deploymentId === WEB_COMPLETION_CASE.workerDeploymentId
    && c.roleProofs.worker.proofSha256 === WEB_COMPLETION_CASE.workerProofSha256
    && c.roleProofs.web.proofSha256 === c.retirementApprovalHash, "FINALIZATION_ROLE_PROOF_CHANGED");
  for (const role of ROLES) {
    const proof = c.roleProofs[role], stage = state.stages[role], svc = service(state, role), command = retirementCommand(role, proof.proofSha256);
    need(receipt.evidence.images[role].digest === proof.imageDigest && sha256(command) === proof.commandSha256 && stage.startCommand === command
      && same(stage.latestDeployment, { id: proof.deploymentId, status: "SUCCESS" })
      && same(stage.activeDeployments, [{ id: proof.deploymentId, status: "SUCCESS" }])
      && stage.history.some(row => row.id === proof.deploymentId && row.status === "SUCCESS" && row.digest === proof.imageDigest)
      && (stage.image === `ghcr.io/corgtexdotcom/corgtex/${role}@${proof.imageDigest}`
        || stage.image === `ghcr.io/corgtexdotcom/corgtex/${role}:sha-${CORE_SOURCE_SHA}`), "FINALIZATION_RUNTIME_CHANGED");
    const active = svc.activeDeployments, live = svc.deployments.find(row => row.id === proof.deploymentId);
    need(active.length === 1 && active[0].id === proof.deploymentId && active[0].status === "SUCCESS" && bound(active[0], role) && running(active[0])
      && live?.status === "SUCCESS" && bound(live, role) && running(live), "FINALIZATION_ACTIVE_RUNTIME_CHANGED");
    const old = svc.deployments.find(row => row.id === CORE_BEFORE[role]);
    need(old?.status === "REMOVED" && bound(old, role) && stopped(old), "FINALIZATION_BUSINESS_PROCESS_NOT_STOPPED");
  }
  const failed = service(state, "worker").deployments.find(row => row.id === HEALTHCHECK_CASE.failedWorkerDeploymentId);
  need(failed?.status === "FAILED" && bound(failed, "worker") && stopped(failed), "FINALIZATION_FAILED_PROCESS_NOT_STOPPED");
}

async function continuity(state, query) {
  const proofs = await verifyWebCompletionContinuity(state, query);
  const c = FINALIZATION_CASE, displaced = c.displacedWebHistory, web = c.roleProofs.web;
  const retained = service(state, "web").deployments.find(row => row.id === displaced.id);
  need(retained && identityHash(retained) === displaced.fullFenceRowSha256, "FINALIZATION_WEB_HISTORY_CHANGED");
  for (const expected of [{ ...displaced, stopped: true }, { id: web.deploymentId, status: "SUCCESS", digest: web.imageDigest, stopped: false }]) {
    const row = (await query(QUERY, { id: expected.id }))?.deployment;
    need(row?.id === expected.id && bound(row, "web") && row.status === expected.status && row.meta?.imageDigest === expected.digest
      && (expected.stopped ? stopped(row) : running(row)), "FINALIZATION_DIRECT_CONTINUITY_CHANGED");
    proofs.push({ id: row.id, status: row.status, digest: row.meta.imageDigest, deploymentStopped: row.deploymentStopped,
      target: { projectId: row.projectId, environmentId: row.environmentId, serviceId: row.serviceId } });
  }
  return proofs;
}

/** Only read dependencies are accepted or invoked; all four mutation opportunities are consumed. */
export async function verifyReadOnlyFinalization({ pin, receipt, receiptBytes }, { now = Date.now, assertContext, verifyImages, readState, query, verifyPublic }) {
  const c = FINALIZATION_CASE;
  validateRetirementBaseline({ pin, receipt, receiptBytes, now: now() });
  need(pin.receiptSha256 === c.baselineReceiptSha256, "FINALIZATION_BASELINE_CHANGED");
  const opsSnapshotSha256 = await assertContext(), imageStartupProofSha256 = await verifyImages(receipt.evidence);
  need(opsSnapshotSha256 === c.opsSnapshotSha256 && imageStartupProofSha256 === c.imageStartupProofSha256, "FINALIZATION_EVIDENCE_CHANGED");
  const initial = await readState(); assertFinalizedState(initial, receipt);
  const evidence = await continuity(initial, query);
  await verifyPublic(c.roleProofs.web.proofSha256);
  need(await assertContext() === opsSnapshotSha256, "FINALIZATION_OPS_CHANGED");
  const final = await readState(); assertFinalizedState(final, receipt);
  need(same(final, initial), "FINALIZATION_PROVIDER_DRIFT");
  validateRetirementBaseline({ pin, receipt, receiptBytes, now: now() });
  return { kind: "core-logical-retirement-readonly-finalized", schemaVersion: 1, mutations: 0, providerWrites: 0, customerWrites: 0,
    physicalServices: "retain", databaseChanges: false, applicationWrites: false, businessWorker: false,
    target, before: CORE_BEFORE, roleProofs: structuredClone(c.roleProofs), caseSha256: identityHash(c), baselineReceiptSha256: pin.receiptSha256,
    providerAfterSha256: identityHash(final), opsSnapshotSha256, imageStartupProofSha256, continuity: evidence,
    consumedFailedRunIds: [HEALTHCHECK_CASE.predecessor.runId, HEALTHCHECK_CASE.runId, WEB_COMPLETION_CASE.runId, c.runId],
    failureCause: "unestablished" };
}
