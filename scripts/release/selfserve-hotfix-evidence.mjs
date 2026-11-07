import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";
import { validateHotfixTarget } from "./selfserve-hotfix-source.mjs";

const REPOSITORY = "Corgtexdotcom/corgtex";
const WORKFLOW = ".github/workflows/release-images.yml";
const MANIFESTS = Object.freeze({
  "selfserve-switcher": ".github/selfserve-switcher-hotfix.json",
  "ops-release-authority": ".github/ops-release-authority-hotfix.json",
});
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const SHA = /^[a-f0-9]{40}$/;
const HEX = /^[a-f0-9]{64}$/;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const requireEvidence = (condition, code) => { if (!condition) throw new Error(code); };
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const id = (value) => Number.isSafeInteger(value) && value > 0;
const exactKeys = (value, keys) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).sort().join("|") === [...keys].sort().join("|");
const BINDINGS = ["repository", "candidateSha", "candidateTree", "manifestSha256", "targetId", "origin", "schemaSha256", "recoverySha", "toolingSha"];

// Expected values come only from the trusted source verifier. The optional
// legacy form is confined to the one fixed Azure selfserve identity.
function evidenceTarget(value) {
  const target = validateHotfixTarget(value, value);
  requireEvidence(value.targetDigest === undefined || value.targetDigest === target.targetDigest,
    "HOTFIX_EVIDENCE_TARGET_DIGEST_MISMATCH");
  return target;
}
function sameTarget(value, expected) {
  return JSON.stringify(evidenceTarget(value)) === JSON.stringify(evidenceTarget(expected));
}
export function hotfixEvidenceManifestPath(admissionId = "selfserve-switcher") {
  requireEvidence(Object.hasOwn(MANIFESTS, admissionId), "HOTFIX_EVIDENCE_ADMISSION_INVALID");
  return MANIFESTS[admissionId];
}

// The producer is an exact reviewed source, not a trusted branch name. Only the
// protected-main admission supplies target/tree/schema/recovery authority.
function validateRun(run, workflow, jobs, approvals, expected, jobName, sourceSha) {
  // GitHub approval history is run-scoped, not attempt-scoped. A rerun cannot
  // inherit this proof; dispatch a new protected run instead.
  requireEvidence(expected.runAttempt === 1 && id(run?.actor?.id) && id(run?.triggering_actor?.id)
    && Array.isArray(approvals) && !approvals.some((approval) => approval.state === "rejected"
      && approval.environments?.some((environment) => environment.id === 17085878745)) && approvals.some((approval) =>
    approval.state === "approved" && approval.user?.id === 278524841 && approval.user.login === "beepto-codex"
    && run?.actor?.id !== approval.user.id && run?.triggering_actor?.id !== approval.user.id
    && approval.environments?.some((environment) => environment.id === 17085878745
      && environment.name === "fleet-release-production")), "HOTFIX_BUILD_APPROVAL_UNPROVEN");
  requireEvidence(run?.id === expected.runId && run.run_attempt === expected.runAttempt
    && run.event === "workflow_dispatch" && run.head_sha === sourceSha
    && run.status === "completed" && run.conclusion === "success" && run.path === WORKFLOW
    && run.repository?.full_name === REPOSITORY && run.head_repository?.full_name === REPOSITORY
    && id(run.repository.id) && run.head_repository.id === run.repository.id
    && workflow?.path === WORKFLOW && id(workflow.id) && run.workflow_id === workflow.id,
  "HOTFIX_BUILD_RUN_UNTRUSTED");
  const selected = Array.isArray(jobs) ? jobs.filter((job) => job.name === jobName) : [];
  requireEvidence(selected.length === 1 && selected[0].run_id === expected.runId
    && selected[0].run_attempt === expected.runAttempt && selected[0].head_sha === sourceSha
    && selected[0].status === "completed" && selected[0].conclusion === "success", "HOTFIX_BUILD_JOB_UNPROVEN");
}
function validateArtifact(artifact, run, expected, name) {
  requireEvidence(artifact?.id === expected.artifactId && artifact.name === name
    && artifact.expired === false && DIGEST.test(artifact.digest)
    && artifact.workflow_run?.id === expected.runId && artifact.workflow_run.head_sha === run.head_sha
    && artifact.workflow_run.head_branch === run.head_branch
    && artifact.workflow_run.repository_id === run.repository.id
    && artifact.workflow_run.head_repository_id === run.repository.id, "HOTFIX_BUILD_ARTIFACT_UNTRUSTED");
}
function validateExpected(expected) {
  evidenceTarget(expected);
  requireEvidence(expected?.repository === REPOSITORY && SHA.test(expected.candidateSha)
    && SHA.test(expected.candidateTree) && SHA.test(expected.recoverySha) && SHA.test(expected.toolingSha)
    && SHA.test(expected.baseSha) && expected.recoverySha === expected.baseSha
    && expected.recoverySha !== expected.candidateSha && HEX.test(expected.manifestSha256)
    && HEX.test(expected.schemaSha256) && id(expected.runId) && id(expected.runAttempt)
    && id(expected.artifactId) && ["candidate", "recovery"].includes(expected.sourceRole), "HOTFIX_BUILD_EXPECTATION_INVALID");
}
export function validateHotfixBuildEvidence({ run, workflow, jobs, approvals, artifact, receipt, workflowUnchanged, toolingTrusted }, expected) {
  validateExpected(expected);
  const sourceSha = expected.sourceRole === "candidate" ? expected.candidateSha : expected.recoverySha;
  const protectedProducer = receipt?.schemaVersion === 2;
  validateRun(run, workflow, jobs, approvals, expected, "Build and publish web/worker images", protectedProducer ? run?.head_sha : sourceSha);
  if (protectedProducer) {
    requireEvidence(toolingTrusted === true && run.head_branch === "main" && SHA.test(run.head_sha), "HOTFIX_BUILD_TOOLING_UNTRUSTED");
    const source = receipt.source;
    requireEvidence(exactKeys(receipt, ["schemaVersion", "mode", "admissionId", "sourceRole", "sourceSha", "toolingSha", "runId", "runAttempt", "source", "images"])
      && receipt.mode === "candidate-build" && receipt.admissionId === evidenceTarget(expected).admissionId
      && receipt.sourceRole === expected.sourceRole && receipt.sourceSha === sourceSha
      && receipt.toolingSha === run.head_sha && receipt.runId === expected.runId && receipt.runAttempt === expected.runAttempt
      && source?.schemaVersion === 1 && source.admission === "hotfix" && source.repository === REPOSITORY
      && source.sourceSha === expected.candidateSha && source.sourceTree === expected.candidateTree
      && source.toolingSha === run.head_sha && source.manifestSha256 === expected.manifestSha256
      && source.schemaSha256 === expected.schemaSha256 && source.recoverySha === expected.recoverySha
      && SHA.test(expected.prismaTree || "") && source.prismaTree === expected.prismaTree
      && sameTarget(source, expected), "HOTFIX_BUILD_BINDING_MISMATCH");
  } else {
    requireEvidence(evidenceTarget(expected).admissionId === "selfserve-switcher", "HOTFIX_BUILD_LEGACY_ADMISSION_FORBIDDEN");
    requireEvidence(workflowUnchanged === true, "HOTFIX_BUILD_WORKFLOW_CHANGED");
    requireEvidence(exactKeys(receipt, ["schemaVersion", "sourceSha", "images"])
      && receipt.schemaVersion === 1 && receipt.sourceSha === sourceSha, "HOTFIX_BUILD_BINDING_MISMATCH");
  }
  validateArtifact(artifact, run, expected, `release-image-digests-${expected.runId}-${expected.runAttempt}`);
  requireEvidence(exactKeys(receipt.images, ["web", "worker"])
    && ["web", "worker"].every((role) => exactKeys(receipt.images[role], ["digest"])
      && DIGEST.test(receipt.images[role].digest)), "HOTFIX_BUILD_IMAGE_INVALID");
  return Object.freeze({ schemaVersion: 1, kind: "selfserve-hotfix-build-proof",
    ...Object.fromEntries([...BINDINGS, "baseSha", "sourceRole", "runId", "runAttempt", "artifactId"].map((key) => [key, expected[key]])),
    sourceSha, ...evidenceTarget(expected), artifactDigest: artifact.digest,
    images: Object.fromEntries(["web", "worker"].map((role) => [role,
      `ghcr.io/corgtexdotcom/corgtex/${role}@${receipt.images[role].digest}`])) });
}

export function validateHotfixProofEvidence({ run, workflow, jobs, approvals, artifact, startup, preparation }, expected, build) {
  validateExpected(expected);
  requireEvidence(SHA.test(run?.head_sha || "") && run.head_branch === "main", "HOTFIX_PROOF_TOOLING_UNTRUSTED");
  validateRun(run, workflow, jobs, approvals, expected, "Isolated immutable web and worker startup proof", run.head_sha);
  validateArtifact(artifact, run, expected, `immutable-startup-proof-${expected.runId}-${expected.runAttempt}`);
  const sourceSha = expected.sourceRole === "candidate" ? expected.candidateSha : expected.recoverySha;
  requireEvidence(build?.kind === "selfserve-hotfix-build-proof" && build.sourceSha === sourceSha
    && build.sourceRole === expected.sourceRole && build.manifestSha256 === expected.manifestSha256
    && build.candidateSha === expected.candidateSha && build.candidateTree === expected.candidateTree
    && build.schemaSha256 === expected.schemaSha256 && build.recoverySha === expected.recoverySha
    && build.targetId === expected.targetId && build.origin === expected.origin && sameTarget(build, expected),
  "HOTFIX_PROOF_BUILD_MISMATCH");
  requireEvidence(startup?.schemaVersion === 1 && startup.sourceSha === sourceSha
    && startup.schemaSha === expected.baseSha && startup.status === "passed" && startup.stage === "STARTUP"
    && startup.cleanup === "completed" && startup.schemaSha256 === expected.schemaSha256
    && HEX.test(expected.migrationLedgerSha256 || "") && startup.migrationLedgerSha256 === expected.migrationLedgerSha256
    && Number.isSafeInteger(expected.migrationCount) && expected.migrationCount > 0 && startup.migrationCount === expected.migrationCount
    && startup.isolation === "internal-network;synthetic-only;normal-entrypoints;no-published-ports-or-host-mounts"
    && preparation?.status === "staged" && preparation.authCleanup === "completed" && preparation.runtimeStarted === false
    && preparation.sourceSha === sourceSha && preparation.schemaSha === expected.baseSha,
  "HOTFIX_PROOF_STARTUP_INVALID");
  const hotfix = startup.hotfix;
  const target = evidenceTarget(expected);
  const targetKeys = target.admissionId === "ops-release-authority"
    ? ["admissionId", "provider", "targetDigest", "deploymentId", "railway"]
    : hotfix?.admissionId !== undefined || hotfix?.provider !== undefined || hotfix?.targetDigest !== undefined
      ? ["admissionId", "provider", "targetDigest"] : [];
  requireEvidence(exactKeys(hotfix, ["manifestSha256", "candidateSha", "candidateTree", "sourceRole", "buildRunId", "buildRunAttempt", "buildArtifactId",
    "targetId", "origin", "recoverySha", "toolingSha", "runId", "runAttempt", ...targetKeys])
    && sameTarget(hotfix, expected)
    && ["manifestSha256", "candidateSha", "candidateTree", "sourceRole", "targetId", "origin", "recoverySha", "runId", "runAttempt"]
      .every((key) => hotfix[key] === expected[key])
    && hotfix.toolingSha === run.head_sha && hotfix.buildRunId === build.runId
    && hotfix.buildRunAttempt === build.runAttempt && hotfix.buildArtifactId === build.artifactId,
  "HOTFIX_PROOF_BINDING_MISMATCH");
  for (const role of ["web", "worker"]) {
    const evidence = startup.roles?.[role], health = evidence?.health;
    requireEvidence(startup.images?.[role] === build.images[role] && preparation.images?.[role] === build.images[role]
      && evidence?.image === build.images[role] && evidence.bakedSha === sourceSha
      && JSON.stringify(evidence.normalEntrypoint) === JSON.stringify(["docker-entrypoint.sh"])
      && JSON.stringify(evidence.normalCommand) === JSON.stringify(role === "web" ? ["sh", "/app/deploy/entrypoint.sh"] : ["node", "/app/scripts/start-worker.mjs"])
      && health?.status === "ok" && health.release?.runtime?.gitSha === sourceSha
      && health.release.runtime.evidence === "baked" && health.release.configured?.gitSha === sourceSha
      && health.release.drift?.gitSha === false && health.release.drift?.imageTag === false && health.release.drift?.version === false,
    "HOTFIX_PROOF_ROLE_INVALID");
    requireEvidence(role === "web" ? health.database === "up" && health.schema === "ready"
      : health.phase === "running" && health.tickCount > 0 && health.lastError === null && Number.isFinite(Date.parse(health.lastSuccessfulTickAt)),
    "HOTFIX_PROOF_ROLE_INVALID");
  }
  return Object.freeze({ ...build, kind: "selfserve-hotfix-startup-proof", proofRunId: expected.runId,
    proofRunAttempt: expected.runAttempt, proofArtifactId: expected.artifactId, proofArtifactDigest: artifact.digest,
    proofToolingSha: run.head_sha, migrationLedgerSha256: startup.migrationLedgerSha256 });
}

// No extraction: bound compressed/uncompressed size and require the exact regular
// JSON entry set. ZIP64, encryption, links, directories and extra entries fail.
export function decodeHotfixArchive(archive, expectedDigest, names) {
  requireEvidence(Buffer.isBuffer(archive) && archive.length >= 22 && archive.length <= 1024 * 1024
    && DIGEST.test(expectedDigest) && `sha256:${hash(archive)}` === expectedDigest, "HOTFIX_ARTIFACT_DIGEST_MISMATCH");
  const end = archive.length - 22;
  requireEvidence(archive.readUInt32LE(end) === 0x06054b50
    && archive.readUInt16LE(end + 4) === 0 && archive.readUInt16LE(end + 6) === 0
    && archive.readUInt16LE(end + 8) === names.length && archive.readUInt16LE(end + 10) === names.length
    && archive.readUInt16LE(end + 20) === 0, "HOTFIX_ARTIFACT_ZIP_INVALID");
  const size = archive.readUInt32LE(end + 12), start = archive.readUInt32LE(end + 16);
  requireEvidence(start >= 30 && size >= 46 && start + size === end, "HOTFIX_ARTIFACT_ZIP_INVALID");
  const result = {}; let cursor = start;
  for (let count = 0; count < names.length; count++) {
    requireEvidence(cursor + 46 <= end && archive.readUInt32LE(cursor) === 0x02014b50, "HOTFIX_ARTIFACT_ZIP_INVALID");
    const flags = archive.readUInt16LE(cursor + 8), method = archive.readUInt16LE(cursor + 10);
    const compressed = archive.readUInt32LE(cursor + 20), uncompressed = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28), extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32), mode = archive.readUInt32LE(cursor + 38) >>> 16;
    const local = archive.readUInt32LE(cursor + 42);
    const name = archive.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    requireEvidence(cursor + 46 + nameLength + extraLength + commentLength <= end
      && names.includes(name) && !Object.hasOwn(result, name) && (flags & ~0x808) === 0 && [0, 8].includes(method)
      && uncompressed > 0 && uncompressed <= 64 * 1024 && compressed <= 1024 * 1024
      && (mode === 0 || (mode & 0xf000) === 0x8000) && local + 30 <= start
      && archive.readUInt16LE(cursor + 34) === 0
      && archive.readUInt32LE(local) === 0x04034b50 && archive.readUInt16LE(local + 6) === flags
      && archive.readUInt16LE(local + 8) === method, "HOTFIX_ARTIFACT_ZIP_INVALID");
    const localNameLength = archive.readUInt16LE(local + 26), localExtraLength = archive.readUInt16LE(local + 28);
    const dataStart = local + 30 + localNameLength + localExtraLength;
    requireEvidence(localNameLength === nameLength && dataStart + compressed <= start
      && archive.subarray(local + 30, local + 30 + localNameLength).toString("utf8") === name, "HOTFIX_ARTIFACT_ZIP_INVALID");
    try {
      const content = archive.subarray(dataStart, dataStart + compressed);
      const bytes = method === 0 ? content : inflateRawSync(content, { maxOutputLength: 64 * 1024 });
      requireEvidence(bytes.length === uncompressed, "HOTFIX_ARTIFACT_ZIP_INVALID");
      result[name] = JSON.parse(bytes.toString("utf8"));
    } catch { throw new Error("HOTFIX_ARTIFACT_JSON_INVALID"); }
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  requireEvidence(cursor === end, "HOTFIX_ARTIFACT_ZIP_INVALID");
  return result;
}

async function boundedBytes(response, limit) {
  requireEvidence(response.ok && response.body, "HOTFIX_EVIDENCE_REQUEST_FAILED");
  const chunks = []; let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    requireEvidence(length <= limit, "HOTFIX_EVIDENCE_RESPONSE_TOO_LARGE");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export async function fetchHotfixEvidence({ runId, runAttempt, artifactId, token, fetchImpl = fetch, workflowFile = "release-images.yml" }, names) {
  requireEvidence(["release-images.yml", "ci.yml"].includes(workflowFile), "HOTFIX_WORKFLOW_INVALID");
  requireEvidence(id(runId) && id(runAttempt) && id(artifactId)
    && typeof token === "string" && token.length > 0, "HOTFIX_EVIDENCE_INPUT_INVALID");
  const api = `https://api.github.com/repos/${REPOSITORY}`;
  const request = (path) => fetchImpl(`${api}${path}`, { redirect: "error", signal: AbortSignal.timeout(30_000),
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" } });
  const json = async (path) => JSON.parse((await boundedBytes(await request(path), 2 * 1024 * 1024)).toString("utf8"));
  const [run, workflow, artifact, approvals] = await Promise.all([
    json(`/actions/runs/${runId}/attempts/${runAttempt}`), json(`/actions/workflows/${workflowFile}`), json(`/actions/artifacts/${artifactId}`), json(`/actions/runs/${runId}/approvals`),
  ]);
  const jobs = [];
  for (let page = 1; ; page++) {
    requireEvidence(page <= 20, "HOTFIX_BUILD_JOBS_INCOMPLETE");
    const result = await json(`/actions/runs/${runId}/attempts/${runAttempt}/jobs?per_page=100&page=${page}`);
    requireEvidence(Array.isArray(result.jobs) && Number.isSafeInteger(result.total_count), "HOTFIX_BUILD_JOBS_INCOMPLETE");
    jobs.push(...result.jobs);
    if (jobs.length === result.total_count) break;
    requireEvidence(result.jobs.length > 0 && jobs.length < result.total_count, "HOTFIX_BUILD_JOBS_INCOMPLETE");
  }
  requireEvidence(run?.id === runId && artifact?.id === artifactId && artifact.workflow_run?.id === runId
    && artifact.expired === false && DIGEST.test(artifact.digest), "HOTFIX_BUILD_ARTIFACT_UNTRUSTED");
  const redirect = await fetchImpl(`${api}/actions/artifacts/${artifactId}/zip`, {
    redirect: "manual", signal: AbortSignal.timeout(30_000),
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
  });
  requireEvidence(redirect.status === 302, "HOTFIX_ARTIFACT_DOWNLOAD_FAILED");
  let url;
  try { url = new URL(redirect.headers.get("location")); } catch { throw new Error("HOTFIX_ARTIFACT_DOWNLOAD_FAILED"); }
  requireEvidence(url.protocol === "https:" && !url.username && !url.password && !url.port
    && (url.hostname.endsWith(".blob.core.windows.net") || url.hostname.endsWith(".actions.githubusercontent.com")),
  "HOTFIX_ARTIFACT_DOWNLOAD_HOST_INVALID");
  const archive = await boundedBytes(await fetchImpl(url.href, { redirect: "error", signal: AbortSignal.timeout(30_000) }), 1024 * 1024);
  return { run, workflow, jobs, approvals, artifact, files: decodeHotfixArchive(archive, artifact.digest, names) };
}
const git = (root, args) => execFileSync("git", ["-C", root, ...args],
  { encoding: "utf8", maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });

export async function verifyHotfixBuildEvidence(options) {
  const expected = { ...options.expected, sourceRole: options.sourceRole || options.expected.sourceRole, runId: options.runId, runAttempt: options.runAttempt, artifactId: options.artifactId };
  const data = await fetchHotfixEvidence(options, ["release-image-digests.json"]);
  const sourceSha = expected.sourceRole === "candidate" ? expected.candidateSha : expected.recoverySha;
  const receipt = data.files["release-image-digests.json"];
  if (receipt?.schemaVersion === 2) {
    try {
      requireEvidence(SHA.test(data.run.head_sha || ""), "HOTFIX_BUILD_TOOLING_UNTRUSTED");
      git(options.toolingRoot || ROOT, ["merge-base", "--is-ancestor", data.run.head_sha, "origin/main"]);
      requireEvidence(hash(Buffer.from(git(options.toolingRoot || ROOT, ["show", `${data.run.head_sha}:${hotfixEvidenceManifestPath(expected.admissionId)}`]))) === expected.manifestSha256,
        "HOTFIX_BUILD_ADMISSION_CHANGED");
    } catch { throw new Error("HOTFIX_BUILD_TOOLING_UNTRUSTED"); }
    return validateHotfixBuildEvidence({ ...data, receipt, toolingTrusted: true }, expected);
  }
  let workflowUnchanged = false;
  try {
    workflowUnchanged = SHA.test(sourceSha) && SHA.test(expected.baseSha)
      && git(options.sourceRoot || options.toolingRoot || ROOT, ["show", `${sourceSha}:${WORKFLOW}`]) === git(options.toolingRoot || ROOT, ["show", `${expected.baseSha}:${WORKFLOW}`]);
  } catch { throw new Error("HOTFIX_BUILD_WORKFLOW_CHANGED"); }
  return validateHotfixBuildEvidence({ ...data, receipt: data.files["release-image-digests.json"], workflowUnchanged }, expected);
}

export async function verifyHotfixProofEvidence(options) {
  const expected = { ...options.expected, sourceRole: options.sourceRole || options.expected.sourceRole, runId: options.runId, runAttempt: options.runAttempt, artifactId: options.artifactId };
  const data = await fetchHotfixEvidence(options, ["startup.json", "preparation.json"]);
  try {
    requireEvidence(SHA.test(data.run.head_sha || ""), "HOTFIX_PROOF_TOOLING_UNTRUSTED");
    git(options.toolingRoot || ROOT, ["merge-base", "--is-ancestor", data.run.head_sha, "origin/main"]);
    requireEvidence(hash(Buffer.from(git(options.toolingRoot || ROOT, ["show", `${data.run.head_sha}:${hotfixEvidenceManifestPath(expected.admissionId)}`]))) === expected.manifestSha256,
      "HOTFIX_PROOF_ADMISSION_CHANGED");
  } catch { throw new Error("HOTFIX_PROOF_TOOLING_UNTRUSTED"); }
  const migrationRoot = options.sourceRoot || options.toolingRoot || ROOT;
  const files = git(migrationRoot, ["ls-tree", "-r", "--name-only", expected.baseSha, "--", "prisma/migrations"])
    .trim().split("\n").filter((path) => /^prisma\/migrations\/[^/]+\/migration\.sql$/.test(path));
  const migrations = files.map((path) => ({ name: path.split("/")[2], checksum: hash(Buffer.from(git(migrationRoot, ["show", `${expected.baseSha}:${path}`]))) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  expected.migrationCount = migrations.length;
  expected.migrationLedgerSha256 = hash(JSON.stringify(migrations));
  return validateHotfixProofEvidence({ ...data, startup: data.files["startup.json"], preparation: data.files["preparation.json"] }, expected, options.buildEvidence || options.build);
}
