import { describe, expect, it, vi } from "vitest";
import { validateEvidence, identityHash, validateReceipt, baselineSmokeEvidence } from "./accepted-core-baseline.mjs";
import { recoveryDatabaseWitness, sourceEnums, migrationEnums, verifySourceEnums } from "./core-readonly-database.mjs";
import { CORE_RECOVERY_PROOF as contract, validateRecoveryProofProvenance, validateRecoveryInheritance, resolveRetainedCoreRecovery } from "./core-recovery-proof.mjs";

const REPO = "Corgtexdotcom/corgtex", time = "2026-09-30T21:33:29.063Z", now = Date.parse("2026-09-30T22:00:00Z");
const id = n => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
function fixture() {
  const evidence = { sourceSha: "d0a3896ef917b50f2fec2d797908f29aa026a058",
    target: { id: "backup-app", origin: "https://app.corgtex.com", provider: "railway", projectId: id(1), environmentId: id(2),
      webServiceId: id(3), workerServiceId: id(4), databaseIdentitySha256: "a".repeat(64) },
    images: { web: { deploymentId: id(5), digest: `sha256:${"b".repeat(64)}` }, worker: { deploymentId: id(6), digest: `sha256:${"c".repeat(64)}` } },
  };
  evidence.databaseVerification = recoveryDatabaseWitness(evidence);
  const witness = evidence.databaseVerification;
  evidence.buildProof = { kind: "recovered-accepted-image-inheritance", evidenceSha256: witness.recoveryReceiptSha256, observedAt: time,
    roles: Object.fromEntries(["web", "worker"].map(role => [role, { deploymentId: evidence.images[role].deploymentId, sourceSha: evidence.sourceSha }])) };
  evidence.authProof = { kind: "protected-review-retained-recovery-auth", runId: contract.runId, runAttempt: 1,
    jobId: contract.jobId, stepNumber: contract.stepNumber, workflowSha: contract.workflowSha, evidenceSha256: witness.recoveryReceiptSha256,
    observedAt: time, origin: evidence.target.origin,
    checks: { health: true, releaseMetadata: true, loginPage: true, login: true, session: true, rootFlow: true },
    recovery: { artifact: { ...contract.artifact }, originalReceiptSha256: witness.originalReceiptSha256 } };
  const run = { id: contract.runId, run_attempt: 1, path: contract.workflowPath, head_sha: contract.workflowSha,
    head_branch: "main", event: "workflow_dispatch", status: "completed", conclusion: "success", workflow_id: 80,
    repository: { full_name: REPO, id: 1 }, head_repository: { full_name: REPO, id: 1 },
    run_started_at: "2026-09-30T21:30:18Z", updated_at: "2026-09-30T21:33:36Z" };
  const artifact = { ...contract.artifact, digest: `sha256:${contract.artifact.sha256}`, expired: false,
    created_at: "2026-09-30T21:33:29Z", expires_at: "2026-12-29T21:30:18Z", workflow_run: {
      id: contract.runId, head_sha: contract.workflowSha, head_branch: "main", repository_id: 1, head_repository_id: 1 } };
  const provenance = { run, attempt: structuredClone(run), workflow: { id: 80, path: contract.workflowPath, state: "active" }, artifact,
    artifacts: { total_count: 1, artifacts: [artifact] }, job: { id: contract.jobId, run_id: contract.runId, run_attempt: 1,
      head_sha: contract.workflowSha, name: "Recover existing Core", conclusion: "success", steps: [{ number: contract.stepNumber,
        name: contract.stepName, status: "completed", conclusion: "success", started_at: "2026-09-30T21:32:10Z", completed_at: "2026-09-30T21:33:29Z" }] } };
  const pin = { receiptSha256: witness.originalReceiptSha256 };
  const original = { evidence: { ...structuredClone(evidence), images: { ...structuredClone(evidence.images), web: { ...evidence.images.web, deploymentId: id(7) } } }, schema: witness.schema };
  const recovery = { kind: "core-recovery-verified", runId: contract.runId, runAttempt: 1, workflowSha: contract.workflowSha, verifiedAt: time,
    failedRunId: 36757068293, baselineReceiptSha256: pin.receiptSha256, sourceSha: evidence.sourceSha,
    originalBaselinePinUnchanged: true, baselineAdoptionRequired: true,
    recoveredRuntime: { sourceSha: evidence.sourceSha, target: evidence.target, images: evidence.images }, schema: witness.schema,
    previousWorkerDeploymentId: id(6), writes: ["variables:web", "variables:worker", "image:web", "image:worker", "deploy:web"],
    registryProofs: ["web", "worker"].map(role => ({ role, acceptedDigest: evidence.images[role].digest,
      image: `ghcr.io/corgtexdotcom/corgtex/${role}@${evidence.images[role].digest}`, platform: "linux/amd64", platformManifestDigest: `sha256:${"d".repeat(64)}` })) };
  return { evidence, provenance, pin, original, recovery };
}

describe("incident-bound recovered Core baseline", () => {
  it("accepts only the distinct recovery inheritance contract and exact successful step/artifact", () => {
    const f = fixture();
    expect(validateEvidence(f.evidence)).toEqual(f.evidence);
    expect(() => validateRecoveryProofProvenance(f.evidence, f.provenance, now)).not.toThrow();
    expect(() => validateRecoveryInheritance(f.evidence, f.recovery, f.original, f.pin)).not.toThrow();
  });
  it.each([
    ["rerun", p => { p.run.run_attempt = 2; }], ["attempt", p => { p.attempt.run_attempt = 2; }],
    ["fork", p => { p.run.head_repository.full_name = "other/fork"; }], ["workflow", p => { p.workflow.path = ".github/workflows/ci.yml"; }],
    ["source", p => { p.run.head_sha = "e".repeat(40); }], ["pending", p => { p.run.status = "in_progress"; }],
    ["failed", p => { p.run.conclusion = "failure"; }], ["job", p => { p.job.name = "Production Smoke Test"; }],
    ["dry-run", p => { p.job.steps[0].conclusion = "skipped"; }], ["ambiguous step", p => { p.job.steps.push({ ...p.job.steps[0] }); }],
    ["unstarted step", p => { delete p.job.steps[0].started_at; }], ["wrong step", p => { p.job.steps[0].number++; }],
    ["expired", p => { p.artifact.expired = true; }], ["expiry time", p => { p.artifact.expires_at = "2026-01-01T00:00:00Z"; }],
    ["archive digest", p => { p.artifact.digest = `sha256:${"0".repeat(64)}`; }],
    ["artifact origin", p => { p.artifact.workflow_run.repository_id = 2; }], ["artifact time", p => { p.artifact.created_at = "2026-09-29T21:33:29Z"; }],
    ["duplicate artifact", p => { p.artifacts.artifacts.push({ ...p.artifact, id: 81 }); p.artifacts.total_count++; }],
  ])("rejects %s provenance", (_name, change) => {
    const f = fixture(); change(f.provenance);
    expect(() => validateRecoveryProofProvenance(f.evidence, f.provenance, now)).toThrow(/CORE_BASELINE_RECOVERY_/);
  });
  it("rejects stale proof even when the exact successful artifact is retained", () => {
    const f = fixture(); expect(() => validateRecoveryProofProvenance(f.evidence, f.provenance, now + 86400000)).toThrow("STALE");
  });
  it.each([
    ["plan", r => { r.kind = "core-recovery-plan"; }], ["worker", r => { r.previousWorkerDeploymentId = id(9); }],
    ["digest", r => { r.registryProofs[0].acceptedDigest = `sha256:${"0".repeat(64)}`; }], ["schema", r => { r.schema = { ...r.schema, datamodelSha256: "0".repeat(64) }; }],
    ["pin", r => { r.baselineReceiptSha256 = "0".repeat(64); }], ["extra deploy", r => { r.writes.push("deploy:worker"); }],
  ])("rejects recovered %s claims", (_name, change) => {
    const f = fixture(); change(f.recovery); expect(() => validateRecoveryInheritance(f.evidence, f.recovery, f.original, f.pin)).toThrow();
  });
  it.each(["sourceVersion", "sourceSchemaSha256", "sourceTls", "enumSha256", "schema"])("rejects caller-selected database witness %s", field => {
    const f = fixture(); f.evidence.databaseVerification[field] = "override";
    expect(() => validateEvidence(f.evidence)).toThrow();
  });
  it("preserves the inherited database witness during ordinary baseline-auth renewal", () => {
    const f = fixture(), verifier = "f".repeat(40);
    const pin = { sourceSha: f.evidence.sourceSha, targetSha256: identityHash(f.evidence.target), verifierSha: verifier,
      schemaVersion: 1, target: "backup-app", receiptSha256: "f".repeat(64),
      run: { id: 90, attempt: 1, workflowId: 80, workflowSha: verifier },
      artifact: { id: 91, name: "accepted-core-baseline-90-1", sha256: "e".repeat(64) } };
    const retained = baselineSmokeEvidence(f.evidence, pin, { GITHUB_SHA: verifier, GITHUB_RUN_ID: "100", GITHUB_RUN_ATTEMPT: "1", GITHUB_JOB: "smoke-prod" }, time);
    f.evidence.authProof = { kind: "protected-review-retained-baseline-auth", runId: 100, runAttempt: 1, jobId: 110,
      stepNumber: 14, workflowSha: verifier, evidenceSha256: "f".repeat(64), observedAt: time, origin: f.evidence.target.origin,
      checks: retained.checks, baseline: retained.baseline };
    f.evidence.buildProof.kind = "direct-container-build-readback";
    expect(() => validateEvidence(f.evidence)).not.toThrow();
    expect(retained.baseline.databaseVerificationSha256).toBe(identityHash(f.evidence.databaseVerification));
    delete f.evidence.databaseVerification;
    expect(() => validateEvidence(f.evidence)).toThrow();
  });
  it("rejects altered bytes before interpreting a self-described recovery receipt", async () => {
    const f = fixture(), p = f.provenance;
    const responses = [p.run, p.attempt, p.job, p.workflow, p.artifact, p.artifacts];
    const download = vi.fn(async () => Buffer.from(JSON.stringify(f.recovery)));
    await expect(resolveRetainedCoreRecovery(f.evidence, { api: async () => responses.shift(), download, now })).rejects.toThrow("RECEIPT_BYTES");
    expect(download).toHaveBeenCalledExactlyOnceWith({ artifact: contract.artifact }, "recover.json");
  });
  it("retains the database witness under the newly accepted receipt's own identity", () => {
    const f = fixture(), verifier = "f".repeat(40), pin = { sourceSha: f.evidence.sourceSha, targetSha256: identityHash(f.evidence.target), verifierSha: verifier, run: { id: 90, attempt: 1 } };
    const receipt = { schemaVersion: 1, kind: "accepted-core-baseline", accepted: true, evidence: f.evidence, schema: f.original.schema,
      acceptance: { repository: REPO, workflowPath: ".github/workflows/accepted-core-baseline.yml", workflowSha: verifier,
        runId: 90, runAttempt: 1, acceptedAt: time, evidenceSha256: identityHash(f.evidence) } };
    expect(() => validateReceipt(JSON.parse(JSON.stringify(receipt)), pin)).not.toThrow();
    receipt.evidence.databaseVerification.sourceVersion = "16.15";
    expect(() => validateReceipt(receipt, pin)).toThrow();
  });
});

describe("accepted source enum derivation", () => {
  const sql = ['CREATE TYPE "Old" AS ENUM (\'FIRST\',\'LAST\'); ALTER TYPE "Old" ADD VALUE \'MIDDLE\';',
    'ALTER TYPE "Old" RENAME TO "Mapped"; CREATE TYPE "Temporary" AS ENUM (\'X\'); DROP TYPE "Temporary"; DROP TYPE IF EXISTS "Absent";'];
  const model = 'enum PublicName {\n FIRST\n MIDDLE\n LAST\n @@map("Mapped")\n}';
  const rows = [{ name: "Mapped", labels: ["FIRST", "LAST", "MIDDLE"] }];
  it("derives database order from immutable migrations and label sets from the datamodel", () => {
    expect(migrationEnums(sql)).toEqual(rows);
    expect(verifySourceEnums(model, rows, sql)).toBe(identityHash(rows));
    expect(sourceEnums('enum Example {\n VALUE @map("sql_value")\n}')).toEqual([{ name: "Example", labels: ["sql_value"] }]);
  });
  it("rejects changed label order and extra/missing labels", () => {
    expect(() => verifySourceEnums(model, [{ name: "Mapped", labels: ["FIRST", "MIDDLE", "LAST"] }], sql)).toThrow("SOURCE_ENUMS_CHANGED");
    expect(() => verifySourceEnums(model, [{ name: "Mapped", labels: ["FIRST", "LAST"] }], sql)).toThrow();
    expect(() => verifySourceEnums(model.replace(' LAST\n', ''), rows, sql)).toThrow("ENUM_DATAMODEL_MIGRATIONS_CHANGED");
  });
  it.each(['ALTER TYPE "Mapped" ADD VALUE \'X\' BEFORE \'FIRST\';', 'ALTER TYPE "Mapped" RENAME VALUE \'FIRST\' TO \'X\';',
    'CREATE TYPE "Mapped" AS ENUM (\'X\');', 'ALTER TYPE "Mapped" ADD VALUE \'FIRST\';', 'DROP TYPE "Missing";',
    'ALTER TYPE "Missing" RENAME TO "X";'])("rejects unsupported or contradictory migration operation", statement => {
    expect(() => migrationEnums([...sql, statement])).toThrow();
  });
});
