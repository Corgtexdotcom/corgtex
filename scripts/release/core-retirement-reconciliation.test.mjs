import { describe, expect, it } from "vitest";
import { identityHash, sha256 } from "../accepted-core-baseline.mjs";
import { CORE_RETIREMENT_TARGET, CORE_BEFORE } from "./core-retirement.mjs";
import { RECONCILIATION_CASE as incident, validateReconciliationEvidence, validateReconciliationApproval,
  downloadReconciliationMembers } from "./core-retirement-reconciliation.mjs";

function evidence() {
  const approval = { kind: "core-logical-retirement", providerBeforeSha256: incident.providerBeforeSha256 };
  const intent = { runId: String(incident.runId), workflowSha: incident.workflowSha, approval, approvalHash: identityHash(approval),
    providerBeforeSha256: incident.providerBeforeSha256, target: structuredClone(CORE_RETIREMENT_TARGET), before: structuredClone(CORE_BEFORE) };
  const members = { "intent.json": Buffer.from(JSON.stringify(intent)), "failed.json": Buffer.from(JSON.stringify({ status: "unverified",
    code: incident.failureCode, providerWrites: "unknown; reconcile before another execution" })) };
  const testCase = { ...incident, originalApprovalHash: intent.approvalHash,
    intentSha256: sha256(members["intent.json"]), failedSha256: sha256(members["failed.json"]) };
  const run = { id: incident.runId, run_attempt: 1, workflow_id: incident.workflowId, head_sha: incident.workflowSha,
    path: ".github/workflows/core-retirement.yml", head_branch: "main", event: "workflow_dispatch", status: "completed", conclusion: "failure",
    repository: { id: 1, full_name: "Corgtexdotcom/corgtex" }, head_repository: { id: 1, full_name: "Corgtexdotcom/corgtex" } };
  const artifact = { id: incident.artifactId, name: incident.artifactName, expired: false, digest: `sha256:${incident.artifactSha256}`,
    expires_at: "2099-01-01T00:00:00Z", workflow_run: { id: run.id, head_sha: run.head_sha, repository_id: 1, head_repository_id: 1, head_branch: "main" } };
  const jobs = { total_count: 1, jobs: [{ id: incident.jobId, run_id: run.id, run_attempt: 1, name: "Retire existing Core", status: "completed", conclusion: "failure",
    steps: [{ name: "Retire reviewed Core application execution", status: "completed", conclusion: "failure", started_at: "2026-10-01T15:23:12Z" },
      { name: "Retain retirement and uncertain-outcome evidence", conclusion: "success" }] }] };
  return { testCase, intent, run, artifact, artifacts: { total_count: 1, artifacts: [artifact] }, jobs, members };
}

describe("authenticated single incident evidence", () => {
  it("binds the exact failed run, job and immutable members", () => {
    const f = evidence(); expect(validateReconciliationEvidence(f, f.testCase)).toEqual(f.intent);
  });
  it.each(["sha", "attempt", "workflow", "artifact", "expiry", "ambiguous", "intent", "failure", "job", "upload", "original-approval", "partial-state"])("refuses altered %s before execution", kind => {
    const f = evidence();
    if (kind === "sha") f.run.head_sha = "0".repeat(40);
    if (kind === "attempt") f.run.run_attempt = 2;
    if (kind === "workflow") f.run.path = ".github/workflows/other.yml";
    if (kind === "artifact") f.artifact.digest = "sha256:" + "0".repeat(64);
    if (kind === "expiry") f.artifact.expired = true;
    if (kind === "ambiguous") f.artifacts.total_count = 2;
    if (kind === "intent") f.members["intent.json"] = Buffer.from("{}");
    if (kind === "failure") f.members["failed.json"] = Buffer.from("{}");
    if (kind === "job") f.jobs.jobs[0].id++;
    if (kind === "upload") f.jobs.jobs[0].steps.pop();
    if (kind === "original-approval") { f.intent.approvalHash = "0".repeat(64); f.members["intent.json"] = Buffer.from(JSON.stringify(f.intent)); f.testCase.intentSha256 = sha256(f.members["intent.json"]); }
    if (kind === "partial-state") { f.intent.before.worker = "not-original"; f.members["intent.json"] = Buffer.from(JSON.stringify(f.intent)); f.testCase.intentSha256 = sha256(f.members["intent.json"]); }
    expect(() => validateReconciliationEvidence(f, f.testCase)).toThrow();
  });
  it("does not forward the GitHub token to artifact storage", async () => {
    const calls = [], secret = "private-github-fixture";
    const fetcher = async (url, options) => {
      calls.push({ url: String(url), options });
      return calls.length === 1 ? { status: 302, headers: new Headers({ location: "https://artifact.example/incident.zip" }) }
        : { ok: true, body: [Buffer.from("invalid archive")] };
    };
    await expect(downloadReconciliationMembers({ GITHUB_TOKEN: secret }, fetcher)).rejects.toThrow("ARCHIVE_HASH");
    expect(calls[0].options.headers.Authorization).toBe(`Bearer ${secret}`);
    expect(calls[1].options.headers).toBeUndefined();
    expect(calls[1].options.redirect).toBe("error");
  });
});

describe("fresh reconciliation approval", () => {
  const now = Date.parse("2026-10-01T16:00:00Z"), proof = "a".repeat(64);
  const intent = { baselineReceiptSha256: proof, providerBeforeSha256: incident.providerBeforeSha256, opsSnapshotSha256: proof, imageStartupProofSha256: proof };
  const envelope = () => ({ schemaVersion: 1, kind: "core-logical-retirement-reconciliation", reviewedAt: new Date(now).toISOString(),
    caseSha256: identityHash(incident), failedRunId: incident.runId, originalApprovalHash: incident.originalApprovalHash,
    expectedProviderSha256: incident.providerBeforeSha256, expectedPrivateConfigSha256: incident.privateConfigSha256,
    retirementApproval: { ...intent, reviewedAt: new Date(now).toISOString() } });
  it("returns a newly reviewed retirement approval while keeping predecessor evidence immutable", () => {
    const a = envelope(); expect(validateReconciliationApproval(a, identityHash(a), intent, now)).toEqual(a.retirementApproval);
  });
  it.each(["failedRunId", "originalApprovalHash", "caseSha256", "expectedProviderSha256", "expectedPrivateConfigSha256", "reviewedAt", "retirementApproval"])("blocks altered %s", key => {
    const a = envelope(); a[key] = key === "reviewedAt" ? "2026-09-30T16:00:00Z" : null;
    expect(() => validateReconciliationApproval(a, identityHash(a), intent, now)).toThrow();
  });
});
