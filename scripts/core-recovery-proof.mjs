import { sha256, identityHash } from "./core-baseline-common.mjs";
import { resolveBaseline, validatePin } from "./accepted-core-baseline.mjs";
import { RECOVERY_INCIDENT_SHA256, RECOVERY_RECEIPT_SHA256, validateRecoveryDatabaseWitness } from "./core-readonly-database.mjs";

export const CORE_RECOVERY_PROOF = Object.freeze({
  runId: 36779845461, runAttempt: 1, jobId: 110107012623, stepNumber: 10,
  workflowSha: "a63b40d6e9407914c9652fb410bd6b90d870e9d7",
  workflowPath: ".github/workflows/core-recovery.yml",
  stepName: "Restore and verify incident-bound Core runtime",
  artifact: { id: 11126859267, name: "core-recovery-36779845461-1",
    sha256: "e6554bf71e0e10bec34b51c7e9d901937059bcda4e33dca92e6df71e5253dcc0" },
});
const REPO = "Corgtexdotcom/corgtex";
const check = (ok, code) => { if (!ok) throw new Error(`CORE_BASELINE_RECOVERY_${code}`); };
const same = (a, b) => identityHash(a) === identityHash(b);
const date = value => typeof value === "string" && Number.isFinite(Date.parse(value));
const finalSecond = value => /:\d{2}Z$/.test(value ?? "") ? 1000 : 1;

export function validateRecoveryProofInput(evidence) {
  const proof = evidence.authProof;
  const expected = CORE_RECOVERY_PROOF;
  check(proof.kind === "protected-review-retained-recovery-auth" && proof.runId === expected.runId
    && proof.runAttempt === 1 && proof.jobId === expected.jobId && proof.stepNumber === expected.stepNumber
    && proof.workflowSha === expected.workflowSha && proof.evidenceSha256 === RECOVERY_RECEIPT_SHA256
    && same(proof.recovery?.artifact, expected.artifact), "INPUT_BINDING");
  validateRecoveryDatabaseWitness(evidence.databaseVerification, evidence);
  check(proof.recovery.originalReceiptSha256 === evidence.databaseVerification.originalReceiptSha256
    && evidence.buildProof.kind === "recovered-accepted-image-inheritance"
    && evidence.buildProof.evidenceSha256 === proof.evidenceSha256 && evidence.buildProof.observedAt === proof.observedAt,
  "INHERITANCE_BINDING");
}

export function validateRecoveryProofProvenance(evidence, { run, attempt, job, workflow, artifact, artifacts }, now = Date.now()) {
  validateRecoveryProofInput(evidence);
  const expected = CORE_RECOVERY_PROOF, proof = evidence.authProof;
  for (const record of [run, attempt]) {
    check(record?.id === expected.runId && record.run_attempt === 1 && record.path === expected.workflowPath
      && record.head_sha === expected.workflowSha && record.head_branch === "main" && record.event === "workflow_dispatch"
      && record.status === "completed" && record.conclusion === "success" && record.repository?.full_name === REPO
      && record.head_repository?.full_name === REPO && record.workflow_id === workflow?.id, "PRODUCER");
  }
  check(workflow.path === expected.workflowPath && workflow.state === "active", "WORKFLOW");
  const steps = job.steps?.filter(step => step.name === expected.stepName) ?? [];
  const step = steps[0];
  check(job.id === expected.jobId && job.run_id === expected.runId && job.run_attempt === 1
    && job.head_sha === expected.workflowSha && job.name === "Recover existing Core" && job.conclusion === "success"
    && steps.length === 1 && step.number === expected.stepNumber && step.status === "completed" && step.conclusion === "success"
    && date(proof.observedAt) && Date.parse(proof.observedAt) >= Date.parse(step.started_at)
    && Date.parse(proof.observedAt) < Date.parse(step.completed_at) + finalSecond(step.completed_at), "STEP");
  check(artifact?.id === expected.artifact.id && artifact.name === expected.artifact.name && artifact.expired === false
    && artifact.digest === `sha256:${expected.artifact.sha256}` && Date.parse(artifact.expires_at) > now
    && artifact.workflow_run?.id === expected.runId && artifact.workflow_run.head_sha === expected.workflowSha
    && artifact.workflow_run.head_branch === "main" && artifact.workflow_run.head_repository_id === run.head_repository.id
    && artifact.workflow_run.repository_id === run.repository.id && date(artifact.created_at)
    && Date.parse(artifact.created_at) >= Date.parse(attempt.run_started_at)
    && Date.parse(artifact.created_at) <= Date.parse(attempt.updated_at)
    && Date.parse(proof.observedAt) < Date.parse(artifact.created_at) + finalSecond(artifact.created_at), "ARTIFACT");
  check(artifacts?.total_count <= 100 && Array.isArray(artifacts.artifacts)
    && artifacts.artifacts.length === artifacts.total_count
    && artifacts.artifacts.filter(item => item.name === expected.artifact.name).length === 1
    && artifacts.artifacts.some(item => item.id === expected.artifact.id && item.name === expected.artifact.name), "AMBIGUOUS_ARTIFACT");
  check(now - Date.parse(proof.observedAt) >= 0 && now - Date.parse(proof.observedAt) <= 86400000, "STALE");
}

export function validateRecoveryInheritance(evidence, recovery, original, pin) {
  const expected = CORE_RECOVERY_PROOF;
  check(pin.receiptSha256 === evidence.databaseVerification.originalReceiptSha256
    && recovery.kind === "core-recovery-verified" && recovery.runId === expected.runId && recovery.runAttempt === 1
    && recovery.workflowSha === expected.workflowSha && recovery.verifiedAt === evidence.authProof.observedAt
    && recovery.failedRunId === 36757068293 && recovery.baselineReceiptSha256 === pin.receiptSha256
    && recovery.sourceSha === original.evidence.sourceSha && recovery.sourceSha === evidence.sourceSha
    && recovery.originalBaselinePinUnchanged === true && recovery.baselineAdoptionRequired === true, "RECEIPT");
  check(same(recovery.recoveredRuntime, { sourceSha: evidence.sourceSha, target: evidence.target, images: evidence.images })
    && same(evidence.target, original.evidence.target) && same(recovery.schema, original.schema)
    && same(recovery.schema, evidence.databaseVerification.schema), "RUNTIME_SCHEMA");
  check(evidence.images.web.deploymentId !== original.evidence.images.web.deploymentId
    && evidence.images.web.digest === original.evidence.images.web.digest
    && same(evidence.images.worker, original.evidence.images.worker)
    && recovery.previousWorkerDeploymentId === original.evidence.images.worker.deploymentId, "IMAGES_WORKER");
  check(same(recovery.writes, ["variables:web", "variables:worker", "image:web", "image:worker", "deploy:web"]), "WRITES");
  check(Array.isArray(recovery.registryProofs) && recovery.registryProofs.length === 2
    && ["web", "worker"].every(role => {
      const records = recovery.registryProofs.filter(item => item.role === role);
      return records.length === 1 && records[0].acceptedDigest === original.evidence.images[role].digest
        && records[0].image === `ghcr.io/corgtexdotcom/corgtex/${role}@${original.evidence.images[role].digest}`
        && records[0].platform === "linux/amd64" && /^sha256:[a-f0-9]{64}$/.test(records[0].platformManifestDigest);
    }), "REGISTRY");
}

export async function resolveRetainedCoreRecovery(evidence, { api, download, now = Date.now() }) {
  validateRecoveryProofInput(evidence);
  const expected = CORE_RECOVERY_PROOF;
  const run = await api(`actions/runs/${expected.runId}`);
  const attempt = await api(`actions/runs/${expected.runId}/attempts/1`);
  const job = await api(`actions/jobs/${expected.jobId}`);
  const workflow = await api(`actions/workflows/${run.workflow_id}`);
  const artifact = await api(`actions/artifacts/${expected.artifact.id}`);
  const artifacts = await api(`actions/runs/${expected.runId}/artifacts?per_page=100`);
  validateRecoveryProofProvenance(evidence, { run, attempt, job, workflow, artifact, artifacts }, now);
  const bytes = await download({ artifact: expected.artifact }, "recover.json");
  check(bytes.length <= 64000 && sha256(bytes) === RECOVERY_RECEIPT_SHA256, "RECEIPT_BYTES");
  const readProducerFile = async path => {
    const file = await api(`contents/${path}?ref=${expected.workflowSha}`);
    check(file.encoding === "base64" && file.size <= 16000 && file.path === path, "SOURCE_CONFIG");
    return Buffer.from(file.content, "base64");
  };
  const pin = validatePin(JSON.parse((await readProducerFile(".github/accepted-core-baseline.json")).toString()));
  check(sha256(await readProducerFile(".github/core-recovery-incident.json")) === RECOVERY_INCIDENT_SHA256, "INCIDENT");
  check(pin.receiptSha256 === evidence.databaseVerification.originalReceiptSha256, "ORIGINAL_PIN");
  const original = await resolveBaseline(pin, { api, download: p => download(p, "receipt.json"), now });
  validateRecoveryInheritance(evidence, JSON.parse(bytes.toString()), original, pin);
  return evidence.databaseVerification;
}
