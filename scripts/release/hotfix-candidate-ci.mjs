import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { hotfixAdmissionProfile, validateHotfixTarget, verifyHotfixSource } from "./selfserve-hotfix-source.mjs";
import { fetchHotfixEvidence } from "./selfserve-hotfix-evidence.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const REPOSITORY = "Corgtexdotcom/corgtex";
const IDS = ["selfserve-switcher", "ops-release-authority"];
const SHA = /^[a-f0-9]{40}$/;
const HEX = /^[a-f0-9]{64}$/;
const requireCi = (condition, code) => { if (!condition) throw new Error(code); };
const hash = (value) => createHash("sha256").update(value).digest("hex");
const id = (value) => Number.isSafeInteger(value) && value > 0;
const exactKeys = (value, keys) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).sort().join("|") === [...keys].sort().join("|");
const COMMON_CHECKS = ["lint", "typecheck", "private-boundary", "schema-diff", "migration-deploy", "migration-fixtures", "seed-fixtures", "unit", "integration", "build", "secret-scan", "client-data-scan"];
export const hotfixCiChecks = (admissionId) => {
  hotfixAdmissionProfile(admissionId);
  return [...COMMON_CHECKS, ...(admissionId === "selfserve-switcher" ? ["switcher-browser"] : [])];
};
export function discoverHotfixCi(root = ROOT) {
  return { include: IDS.filter((admissionId) => existsSync(resolve(root, hotfixAdmissionProfile(admissionId).manifestPath)))
    .map((admissionId) => ({ admissionId })) };
}
function manifestFor(root, admissionId) {
  const file = resolve(root, hotfixAdmissionProfile(admissionId).manifestPath);
  const manifest = JSON.parse(readFileSync(file, "utf8"));
  requireCi(SHA.test(manifest.candidateSha ?? "") && SHA.test(manifest.baseSha ?? ""), "HOTFIX_CI_MANIFEST_INVALID");
  return manifest;
}
export function validateHotfixCiContext(env) {
  requireCi(env.GITHUB_REPOSITORY === REPOSITORY && env.GITHUB_EVENT_NAME === "push"
    && env.GITHUB_REF === "refs/heads/main"
    && env.GITHUB_WORKFLOW_REF === `${REPOSITORY}/.github/workflows/ci.yml@refs/heads/main`
    && SHA.test(env.GITHUB_SHA ?? "") && id(Number(env.GITHUB_RUN_ID)) && id(Number(env.GITHUB_RUN_ATTEMPT)), "HOTFIX_CI_CONTEXT_UNTRUSTED");
}
export function createHotfixCiReceipt(source, env) {
  validateHotfixCiContext(env);
  requireCi(source.admission === "hotfix" && source.toolingSha === env.GITHUB_SHA
    && source.repository === REPOSITORY && SHA.test(source.sourceSha) && SHA.test(source.sourceTree)
    && SHA.test(source.prismaTree) && SHA.test(source.recoverySha) && HEX.test(source.schemaSha256)
    && HEX.test(source.manifestSha256), "HOTFIX_CI_SOURCE_INVALID");
  const target = validateHotfixTarget(source, source);
  requireCi(target.targetDigest === source.targetDigest, "HOTFIX_CI_TARGET_MISMATCH");
  return { schemaVersion: 1, kind: "exact-hotfix-ci", status: "passed", repository: REPOSITORY,
    toolingSha: env.GITHUB_SHA, runId: Number(env.GITHUB_RUN_ID), runAttempt: Number(env.GITHUB_RUN_ATTEMPT),
    ...target, ...Object.fromEntries(["sourceSha", "sourceTree", "prismaTree", "schemaSha256", "manifestSha256", "recoverySha"].map((key) => [key, source[key]])),
    checks: hotfixCiChecks(target.admissionId) };
}
export function validateHotfixCiEvidence({ run, workflow, jobs, artifact, receipt }, expected) {
  requireCi(expected?.repository === REPOSITORY && id(expected.runId) && id(expected.runAttempt)
    && id(expected.artifactId) && SHA.test(expected.toolingSha), "HOTFIX_CI_EXPECTATION_INVALID");
  const target = validateHotfixTarget(expected, expected);
  requireCi(target.targetDigest === expected.targetDigest, "HOTFIX_CI_TARGET_MISMATCH");
  const path = ".github/workflows/ci.yml";
  requireCi(run?.id === expected.runId && run.run_attempt === expected.runAttempt && run.event === "push"
    && run.head_branch === "main" && run.head_sha === expected.toolingSha && run.path === path
    && run.status === "completed" && run.conclusion === "success" && run.repository?.full_name === REPOSITORY
    && run.head_repository?.full_name === REPOSITORY && id(run.repository.id) && run.head_repository.id === run.repository.id
    && workflow?.path === path && id(workflow.id) && run.workflow_id === workflow.id, "HOTFIX_CI_RUN_UNTRUSTED");
  const names = [`hotfix-candidate / Exact admitted candidate checks (${target.admissionId})`, "Lint, Typecheck & Test"];
  for (const name of names) {
    const matches = Array.isArray(jobs) ? jobs.filter((job) => job.name === name) : [];
    requireCi(matches.length === 1 && matches[0].run_id === expected.runId && matches[0].run_attempt === expected.runAttempt
      && matches[0].head_sha === expected.toolingSha && matches[0].status === "completed" && matches[0].conclusion === "success", "HOTFIX_CI_JOB_UNPROVEN");
  }
  requireCi(artifact?.id === expected.artifactId && artifact.expired === false && /^sha256:[a-f0-9]{64}$/.test(artifact.digest)
    && artifact.name === `exact-hotfix-ci-${target.admissionId}-${expected.runId}-${expected.runAttempt}`
    && artifact.workflow_run?.id === expected.runId && artifact.workflow_run.head_sha === expected.toolingSha
    && artifact.workflow_run.head_branch === "main" && artifact.workflow_run.repository_id === run.repository.id
    && artifact.workflow_run.head_repository_id === run.repository.id, "HOTFIX_CI_ARTIFACT_UNTRUSTED");
  const source = { ...expected, admission: "hotfix", sourceSha: expected.candidateSha, sourceTree: expected.candidateTree };
  const desired = createHotfixCiReceipt(source, { GITHUB_REPOSITORY: REPOSITORY, GITHUB_EVENT_NAME: "push",
    GITHUB_REF: "refs/heads/main", GITHUB_WORKFLOW_REF: `${REPOSITORY}/${path}@refs/heads/main`,
    GITHUB_SHA: expected.toolingSha, GITHUB_RUN_ID: String(expected.runId), GITHUB_RUN_ATTEMPT: String(expected.runAttempt) });
  requireCi(exactKeys(receipt, Object.keys(desired)) && Object.entries(desired).every(([key, value]) => JSON.stringify(receipt[key]) === JSON.stringify(value)), "HOTFIX_CI_RECEIPT_MISMATCH");
  return { ...receipt, artifactId: artifact.id, artifactDigest: artifact.digest };
}
function git(root, args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  return execFileSync("git", ["--no-replace-objects", "-C", root, ...args], { encoding: "utf8", maxBuffer: 1024 * 1024,
    env: { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_OPTIONAL_LOCKS: "0" }, stdio: ["ignore", "pipe", "pipe"] });
}
export async function verifyHotfixCiEvidence(options) {
  const expected = { ...options.expected, runId: options.runId, runAttempt: options.runAttempt, artifactId: options.artifactId };
  const data = await fetchHotfixEvidence({ ...options, workflowFile: "ci.yml" }, ["hotfix-ci-receipt.json"]);
  // The consumer may run after the authorizing CI commit. Bind the producer's
  // tooling SHA separately, with the same exact protected-main manifest.
  const toolingRoot = options.toolingRoot || ROOT;
  try {
    requireCi(SHA.test(data.run.head_sha ?? ""), "HOTFIX_CI_TOOLING_UNTRUSTED");
    git(toolingRoot, ["merge-base", "--is-ancestor", data.run.head_sha, "origin/main"]);
    const manifestPath = hotfixAdmissionProfile(expected.admissionId).manifestPath;
    requireCi(hash(Buffer.from(git(toolingRoot, ["show", `${data.run.head_sha}:${manifestPath}`]))) === expected.manifestSha256,
      "HOTFIX_CI_ADMISSION_CHANGED");
  } catch { throw new Error("HOTFIX_CI_TOOLING_UNTRUSTED"); }
  return validateHotfixCiEvidence({ ...data, receipt: data.files["hotfix-ci-receipt.json"] }, { ...expected, toolingSha: data.run.head_sha });
}
async function cli(mode, env) {
  const admissionId = env.HOTFIX_ADMISSION_ID;
  const writeOutput = (value) => {
    requireCi(env.GITHUB_OUTPUT, "HOTFIX_CI_OUTPUT_REQUIRED");
    appendFileSync(env.GITHUB_OUTPUT, `${value}\n`);
  };
  if (mode === "discover") { writeOutput(`matrix=${JSON.stringify(discoverHotfixCi())}`); return; }
  const manifest = manifestFor(ROOT, admissionId);
  if (mode === "prepare") { writeOutput(`sha=${manifest.candidateSha}\nbase=${manifest.baseSha}`); return; }
  requireCi(["verify", "finish"].includes(mode), "HOTFIX_CI_MODE_INVALID");
  const source = await verifyHotfixSource({ toolingRoot: ROOT, sourceRoot: resolve(ROOT, ".hotfix-source"),
    sourceSha: manifest.candidateSha, targetId: manifest.targetId, origin: manifest.origin,
    admissionId, provider: manifest.provider ?? "azure", ...(admissionId === "ops-release-authority"
      ? { deploymentId: manifest.deploymentId, railway: manifest.railway } : {}) });
  const file = resolve(ROOT, mode === "verify" ? ".artifacts/hotfix-source.json" : ".artifacts/hotfix-ci-receipt.json");
  const receipt = mode === "verify" ? source : createHotfixCiReceipt(source, env);
  mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  cli(process.argv[2], process.env).catch((error) => { console.error(/^HOTFIX_[A-Z_]+$/.test(error.message) ? error.message : "HOTFIX_CI_FAILED"); process.exitCode = 1; });
}
