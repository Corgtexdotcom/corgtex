import { readFile } from "node:fs/promises";
import { identityHash, sha256 } from "../accepted-core-baseline.mjs";
import { need, CORE_BEFORE, CORE_SOURCE_SHA, CORE_RETIREMENT_TARGET as target, assertQuietTriggers,
  retirementCommand, validateRetirementBaseline, validateRetirementApproval } from "./core-retirement.mjs";
import { HEALTHCHECK_CASE, validateHealthcheckPredecessors } from "./core-retirement-healthcheck-recovery.mjs";

export const WEB_COMPLETION_STEP = "Complete remaining Core web retirement";
export const WEB_COMPLETION_CASE = JSON.parse(await readFile(new URL("../../.github/core-retirement-web-completion.json", import.meta.url), "utf8"));
const same = (a, b) => identityHash(a) === identityHash(b);
const INACTIVE = new Set(["CRASHED", "EXITED", "REMOVED", "SKIPPED", "STOPPED"]);
const EVIDENCE = ["baselineReceiptSha256", "opsSnapshotSha256", "imageStartupProofSha256"];
const service = (state, role) => state.fence.services.find(row => row.serviceId === target[`${role}ServiceId`]);
const queryById = "query CoreWebCompletionContinuity($id:String!) { deployment(id:$id) { id projectId environmentId serviceId status deploymentStopped instances { id status } meta } }";

export function validateWebCompletionPredecessors(first, second, third) {
  validateHealthcheckPredecessors(first, second);
  const incident = WEB_COMPLETION_CASE, prior = HEALTHCHECK_CASE;
  need(same(incident.predecessor, prior) && third?.runId === String(incident.runId)
    && third.workflowSha === incident.workflowSha && third.approvalHash === incident.workerProofSha256
    && same(third.predecessor, prior) && same(third.target, target) && same(third.before, CORE_BEFORE)
    && third.providerBeforeSha256 === prior.expectedProviderSha256
    && identityHash(third.approval) === incident.retirementApprovalHash, "WEB_COMPLETION_THIRD_INTENT_INVALID");
  const envelope = third.healthcheckApproval;
  need(envelope?.kind === "core-logical-retirement-healthcheck-recovery" && envelope.schemaVersion === 1
    && identityHash(envelope) === incident.healthcheckApprovalHash && envelope.caseSha256 === identityHash(prior)
    && envelope.failedRunId === prior.runId && envelope.originalApprovalHash === prior.originalApprovalHash
    && envelope.reconciliationApprovalHash === prior.reconciliationApprovalHash
    && envelope.expectedProviderSha256 === prior.expectedProviderSha256
    && envelope.expectedPrivateConfigSha256 === prior.privateConfigSha256
    && same(envelope.retirementApproval, third.approval)
    && EVIDENCE.every(key => third[key] === second[key] && third.approval[key] === third[key]), "WEB_COMPLETION_CHAIN_INVALID");
  return third;
}

export function validateWebCompletionApproval(envelope, hash, third, now = Date.now()) {
  const incident = WEB_COMPLETION_CASE;
  need(envelope?.kind === "core-logical-retirement-web-completion" && envelope.schemaVersion === 1
    && /^[a-f0-9]{64}$/.test(hash) && identityHash(envelope) === hash
    && envelope.caseSha256 === identityHash(incident) && envelope.failedRunId === incident.runId
    && envelope.healthcheckApprovalHash === incident.healthcheckApprovalHash
    && envelope.expectedProviderSha256 === incident.expectedProviderSha256
    && envelope.expectedPrivateConfigSha256 === incident.privateConfigSha256
    && envelope.retainedWorkerDeploymentId === incident.workerDeploymentId
    && envelope.retainedWorkerProofSha256 === incident.workerProofSha256, "WEB_COMPLETION_APPROVAL_INVALID");
  const age = now - Date.parse(envelope.reviewedAt);
  need(age >= 0 && age <= 3600000, "WEB_COMPLETION_APPROVAL_STALE");
  need(third?.runId === String(incident.runId) && third.workflowSha === incident.workflowSha
    && identityHash(third.approval) === incident.retirementApprovalHash
    && identityHash(third.healthcheckApproval) === incident.healthcheckApprovalHash, "WEB_COMPLETION_PREDECESSOR_INVALID");
  const approval = envelope.retirementApproval;
  need(approval && EVIDENCE.every(key => approval[key] === third[key])
    && approval.providerBeforeSha256 === incident.expectedProviderSha256, "WEB_COMPLETION_START_CHANGED");
  validateRetirementApproval(approval, { ...third, providerBeforeSha256: incident.expectedProviderSha256 }, identityHash(approval), now);
  return approval;
}

export function assertWebCompletionStart(state, receipt) {
  const c = WEB_COMPLETION_CASE;
  need(identityHash(state) === c.expectedProviderSha256 && state.configIdentity === c.privateConfigSha256,
    "WEB_COMPLETION_STATE_CHANGED");
  assertQuietTriggers(state.fence);
  need(sha256(c.workerStartCommand) === c.workerStartCommandSha256
    && c.workerStartCommand === retirementCommand("worker", c.workerProofSha256), "WEB_COMPLETION_WORKER_COMMAND_CHANGED");
  for (const role of ["worker", "web"]) {
    const stage = state.stages[role], digest = receipt.evidence.images[role].digest;
    const id = role === "worker" ? c.workerDeploymentId : CORE_BEFORE.web;
    need(same(stage.latestDeployment, { id, status: "SUCCESS" })
      && same(stage.activeDeployments, [{ id, status: "SUCCESS" }])
      && stage.history.some(row => row.id === id && row.status === "SUCCESS" && row.digest === digest)
      && (stage.image === `ghcr.io/corgtexdotcom/corgtex/${role}@${digest}`
        || stage.image === `ghcr.io/corgtexdotcom/corgtex/${role}:sha-${CORE_SOURCE_SHA}`)
      && stage.startCommand === (role === "worker" ? c.workerStartCommand : "npm run start --workspace=@corgtex/web"),
    "WEB_COMPLETION_RUNTIME_CHANGED");
    const live = service(state, role).activeDeployments;
    need(live.length === 1 && live[0].id === id && live[0].status === "SUCCESS" && live[0].deploymentStopped === false
      && live[0].instances.length > 0 && live[0].instances.every(row => row.status === "RUNNING"), "WEB_COMPLETION_ACTIVE_RUNTIME_CHANGED");
  }
  const worker = service(state, "worker"), old = worker.deployments.find(row => row.id === CORE_BEFORE.worker);
  const failed = worker.deployments.find(row => row.id === HEALTHCHECK_CASE.failedWorkerDeploymentId);
  need(old?.deploymentStopped === true && old.status === "REMOVED" && old.instances.length > 0
    && old.instances.every(row => INACTIVE.has(row.status)) && failed?.status === "FAILED" && failed.deploymentStopped === true
    && failed.instances.every(row => INACTIVE.has(row.status)), "WEB_COMPLETION_PREDECESSOR_NOT_STOPPED");
  const h = c.workerHealthEvidence;
  need(h.path === "/healthz" && h.httpStatus === 200 && h.status === "ok" && h.mode === "source-freeze-utility"
    && h.role === "worker" && h.proofSha256 === c.workerProofSha256 && h.applicationWrites === false
    && h.businessWorker === false, "WEB_COMPLETION_WORKER_HEALTH_EVIDENCE_INVALID");
}

export async function verifyWebCompletionContinuity(state, query) {
  const c = WEB_COMPLETION_CASE, expected = c.displacedWorkerHistory;
  const worker = service(state, "worker"), retained = worker.deployments.find(row => row.id === expected.id);
  need(retained && identityHash(retained) === expected.fullFenceRowSha256, "WEB_COMPLETION_HISTORY_CHANGED");
  const proofs = [];
  for (const row of [{ id: expected.id, status: expected.status, digest: expected.digest, stopped: true },
    { id: c.workerDeploymentId, status: "SUCCESS", digest: state.stages.worker.history.find(row => row.id === c.workerDeploymentId)?.digest, stopped: false }]) {
    const d = (await query(queryById, { id: row.id }))?.deployment;
    need(d?.id === row.id && d.projectId === target.projectId && d.environmentId === target.environmentId
      && d.serviceId === target.workerServiceId && d.status === row.status && d.meta?.imageDigest === row.digest
      && d.deploymentStopped === row.stopped && d.instances?.length > 0
      && d.instances.every(i => row.stopped ? INACTIVE.has(i.status) : i.status === "RUNNING"), "WEB_COMPLETION_DIRECT_CONTINUITY_CHANGED");
    proofs.push({ id: d.id, status: d.status, digest: d.meta.imageDigest, deploymentStopped: d.deploymentStopped,
      target: { projectId: d.projectId, environmentId: d.environmentId, serviceId: d.serviceId } });
  }
  return proofs;
}

export async function completeCoreWebRetirement({ pin, receipt, receiptBytes, approval, approvalHash, dryRun = true }, deps) {
  validateRetirementBaseline({ pin, receipt, receiptBytes, now: deps.now?.() });
  const opsSnapshotSha256 = await deps.assertContext(), imageStartupProofSha256 = await deps.verifyImages(receipt.evidence);
  const initial = await deps.readState(); assertWebCompletionStart(initial, receipt);
  const continuity = await deps.verifyContinuity(initial);
  const commandExercise = await deps.verifyCommands(receipt.evidence, initial, dryRun ? "0".repeat(64) : approvalHash);
  const plan = { kind: "core-web-retirement-completion-plan", baselineReceiptSha256: pin.receiptSha256,
    providerBeforeSha256: identityHash(initial), opsSnapshotSha256, imageStartupProofSha256, target, before: CORE_BEFORE,
    retainedWorker: { deploymentId: WEB_COMPLETION_CASE.workerDeploymentId, proofSha256: WEB_COMPLETION_CASE.workerProofSha256,
      commandSha256: WEB_COMPLETION_CASE.workerStartCommandSha256, imageDigest: receipt.evidence.images.worker.digest },
    continuity, databaseChanges: false, physicalServices: "retain", permittedWrites: ["command:web", "deploy:web"],
    exclusion: "fleet-release-concurrency-and-fresh-ops-no-active-leases" };
  if (dryRun) return { ...plan, commandExercise, dryRun: true, mutations: 0 };
  validateRetirementApproval(approval, plan, approvalHash, deps.now?.());
  validateRetirementBaseline({ pin, receipt, receiptBytes, now: deps.now?.() });
  need(await deps.reserveIntent({ ...plan, approvalHash }) === true, "DURABLE_INTENT_REQUIRED");
  need(await deps.assertContext() === opsSnapshotSha256 && same(await deps.readState(), initial), "WEB_COMPLETION_ADMISSION_CHANGED");
  const command = retirementCommand("web", approvalHash);
  await deps.setCommand("web", command);
  const staged = await deps.readState(), wanted = structuredClone(initial); wanted.stages.web.startCommand = command;
  need(same(staged, wanted), "COMMAND_READBACK");
  need(await deps.assertContext() === opsSnapshotSha256, "OPS_SNAPSHOT_CHANGED");
  const deploymentId = await deps.deploy("web");
  need(/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(deploymentId), "DEPLOYMENT_OUTCOME_UNCERTAIN");
  const final = await deps.verifyRuntime("web", deploymentId, command, initial);
  need(same(final.stages.worker, initial.stages.worker) && same(service(final, "worker"), service(initial, "worker")), "RETAINED_WORKER_CHANGED");
  await deps.verifyContinuity(final);
  await deps.verifyPublic(approvalHash);
  need(await deps.assertContext() === opsSnapshotSha256 && same(await deps.readState(), final), "FINAL_PROVIDER_DRIFT");
  return { ...plan, kind: "core-logical-retirement-web-completion-verified", approvalHash,
    writes: ["command:web", "deploy:web"], afterSha256: identityHash(final), commandExercise,
    roleProofs: { worker: { ...plan.retainedWorker, role: "worker" }, web: { role: "web", deploymentId,
      proofSha256: approvalHash, commandSha256: sha256(command), imageDigest: receipt.evidence.images.web.digest } },
    applicationWrites: false, businessWorker: false };
}
