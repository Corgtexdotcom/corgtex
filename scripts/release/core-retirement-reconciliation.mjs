import { execFileSync } from "node:child_process";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { identityHash, sha256 } from "../accepted-core-baseline.mjs";
import { need, CORE_BEFORE, CORE_RETIREMENT_TARGET } from "./core-retirement.mjs";

export const RECONCILE_STEP = "Reconcile unchanged Core retirement incident";
export const RECONCILIATION_CASE = JSON.parse(await readFile(new URL("../../.github/core-retirement-reconciliation.json", import.meta.url), "utf8"));
const REPO = "Corgtexdotcom/corgtex", WORKFLOW = ".github/workflows/core-retirement.yml";
const same = (a, b) => identityHash(a) === identityHash(b);

export function validateReconciliationEvidence({ run, artifact, artifacts, jobs, members }, incident = RECONCILIATION_CASE) {
  need(run.id === incident.runId && run.run_attempt === incident.attempt && run.workflow_id === incident.workflowId
    && run.head_sha === incident.workflowSha && run.path === WORKFLOW && run.head_branch === "main"
    && run.event === "workflow_dispatch" && run.status === "completed" && run.conclusion === "failure"
    && run.repository?.full_name === REPO && run.head_repository?.full_name === REPO
    && run.repository.id === run.head_repository.id, "RECONCILIATION_RUN_INVALID");
  need(artifact.id === incident.artifactId && artifact.name === incident.artifactName && artifact.expired === false
    && artifact.digest === `sha256:${incident.artifactSha256}` && Date.parse(artifact.expires_at) > Date.now()
    && artifact.workflow_run?.id === run.id && artifact.workflow_run.head_sha === run.head_sha
    && artifact.workflow_run.repository_id === run.repository.id && artifact.workflow_run.head_repository_id === run.head_repository.id
    && artifact.workflow_run.head_branch === "main" && artifacts.total_count === 1
    && artifacts.artifacts?.length === 1 && artifacts.artifacts[0].id === artifact.id, "RECONCILIATION_ARTIFACT_INVALID");
  need(jobs.total_count === 1 && jobs.jobs?.length === 1, "RECONCILIATION_JOBS_INVALID");
  const job = jobs.jobs[0], execute = job.steps?.filter(step => step.name === (incident.stepName || "Retire reviewed Core application execution"));
  need(job.id === incident.jobId && job.run_id === run.id && job.run_attempt === 1 && job.name === "Retire existing Core"
    && job.status === "completed" && job.conclusion === "failure" && execute?.length === 1
    && execute[0].status === "completed" && execute[0].conclusion === "failure" && Number.isFinite(Date.parse(execute[0].started_at))
    && job.steps.some(step => step.name === "Retain retirement and uncertain-outcome evidence" && step.conclusion === "success"), "RECONCILIATION_STEP_INVALID");
  need(sha256(members["intent.json"]) === incident.intentSha256 && sha256(members["failed.json"]) === incident.failedSha256,
    "RECONCILIATION_MEMBER_INVALID");
  const intent = JSON.parse(members["intent.json"]), failure = JSON.parse(members["failed.json"]);
  need(intent.runId === String(run.id) && intent.workflowSha === incident.workflowSha && intent.approvalHash === (incident.retirementApprovalHash || incident.originalApprovalHash)
    && identityHash(intent.approval) === (incident.retirementApprovalHash || incident.originalApprovalHash) && intent.providerBeforeSha256 === incident.providerBeforeSha256
    && same(intent.target, CORE_RETIREMENT_TARGET) && same(intent.before, CORE_BEFORE)
    && failure.status === "unverified" && failure.code === incident.failureCode
    && failure.providerWrites === "unknown; reconcile before another execution", "RECONCILIATION_INTENT_INVALID");
  return intent;
}

export function validateReconciliationApproval(approval, hash, intent, now = Date.now()) {
  const incident = RECONCILIATION_CASE;
  need(approval?.schemaVersion === 1 && approval.kind === "core-logical-retirement-reconciliation"
    && identityHash(approval) === hash && approval.caseSha256 === identityHash(incident)
    && approval.failedRunId === incident.runId && approval.originalApprovalHash === incident.originalApprovalHash
    && approval.expectedProviderSha256 === incident.providerBeforeSha256 && approval.expectedPrivateConfigSha256 === incident.privateConfigSha256,
    "RECONCILIATION_APPROVAL_INVALID");
  const age = now - Date.parse(approval.reviewedAt);
  need(age >= 0 && age <= 3600000, "RECONCILIATION_APPROVAL_STALE");
  const current = approval.retirementApproval;
  need(current && ["baselineReceiptSha256", "providerBeforeSha256", "opsSnapshotSha256", "imageStartupProofSha256"].every(key => current[key] === intent[key])
    && current.providerBeforeSha256 === incident.providerBeforeSha256, "RECONCILIATION_START_CHANGED");
  // New public/disposition evidence and review time are independently approved;
  // the original approval bytes remain immutable in the authenticated archive.
  return current;
}

export async function downloadReconciliationMembers(env, fetchImpl = fetch, incident = RECONCILIATION_CASE) {
  const response = await fetchImpl(`https://api.github.com/repos/${REPO}/actions/artifacts/${incident.artifactId}/zip`, {
    headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}` }, redirect: "manual", signal: AbortSignal.timeout(30000),
  });
  need(response.status === 302, "RECONCILIATION_DOWNLOAD_FAILED");
  const location = new URL(response.headers.get("location"));
  need(location.protocol === "https:" && !location.username && !location.password, "RECONCILIATION_REDIRECT_INVALID");
  const archive = await fetchImpl(location, { redirect: "error", signal: AbortSignal.timeout(30000) });
  need(archive.ok, "RECONCILIATION_DOWNLOAD_FAILED");
  const chunks = []; let size = 0;
  for await (const chunk of archive.body) { size += chunk.length; need(size <= 1000000, "RECONCILIATION_ARCHIVE_TOO_LARGE"); chunks.push(chunk); }
  const bytes = Buffer.concat(chunks);
  need(sha256(bytes) === incident.artifactSha256, "RECONCILIATION_ARCHIVE_HASH");
  const directory = await mkdtemp(join(tmpdir(), "core-reconciliation-"));
  try {
    const path = join(directory, "incident.zip"); await writeFile(path, bytes, { mode: 0o600 });
    const names = execFileSync("unzip", ["-Z1", path], { encoding: "utf8", maxBuffer: 4096 }).trim().split("\n").sort();
    need(same(names, ["failed.json", "image-startup.json", "intent.json"]), "RECONCILIATION_ARCHIVE_CONTENTS");
    return Object.fromEntries(["intent.json", "failed.json"].map(name => [name, execFileSync("unzip", ["-p", path, name], { maxBuffer: 64000 })]));
  } finally { await rm(directory, { recursive: true, force: true }); }
}
