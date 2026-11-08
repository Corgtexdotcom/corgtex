import { appendFile, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { hotfixAdmissionProfile, validateHotfixTarget, verifyHotfixSource } from "./selfserve-hotfix-source.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const requireBuild = (condition, code) => { if (!condition) throw new Error(code); };
export function candidateBuildContext(env) {
  const admissionId = env.CANDIDATE_ADMISSION || "";
  requireBuild(SHA.test(env.GITHUB_SHA || ""), "HOTFIX_BUILD_TOOLING_SHA_INVALID");
  if (!admissionId) return { candidateMode: false, sourceSha: env.GITHUB_SHA, candidateSha: "", sourceRole: "", admissionId: "" };
  hotfixAdmissionProfile(admissionId);
  requireBuild(env.GITHUB_REPOSITORY === "Corgtexdotcom/corgtex" && env.GITHUB_EVENT_NAME === "workflow_dispatch"
    && env.GITHUB_REF === "refs/heads/main"
    && env.GITHUB_WORKFLOW_REF === "Corgtexdotcom/corgtex/.github/workflows/release-images.yml@refs/heads/main"
    && env.RELEASE_IMAGE_MODE === "build", "HOTFIX_BUILD_TOOLING_UNTRUSTED");
  const sourceRole = env.CANDIDATE_SOURCE_ROLE || "candidate";
  requireBuild(["candidate", "recovery"].includes(sourceRole), "HOTFIX_BUILD_ROLE_INVALID");
  return { candidateMode: true, admissionId, sourceRole };
}
export async function selectCandidateBuild({ env = process.env, toolingRoot = ROOT } = {}) {
  const context = candidateBuildContext(env);
  if (!context.candidateMode) return context;
  const profile = hotfixAdmissionProfile(context.admissionId);
  const path = resolve(toolingRoot, profile.manifestPath);
  requireBuild((await lstat(path)).isFile(), "HOTFIX_MANIFEST_INVALID");
  const bytes = await readFile(path);
  requireBuild(bytes.length <= 64 * 1024, "HOTFIX_MANIFEST_INVALID");
  const manifest = JSON.parse(bytes.toString("utf8"));
  validateHotfixTarget(manifest, { ...manifest, admissionId: context.admissionId, provider: profile.provider });
  requireBuild(SHA.test(manifest.candidateSha || "") && SHA.test(manifest.recoverySha || "")
    && manifest.candidateSha !== manifest.recoverySha, "HOTFIX_BUILD_SOURCE_INVALID");
  return { ...context, manifest, candidateSha: manifest.candidateSha,
    sourceSha: context.sourceRole === "candidate" ? manifest.candidateSha : manifest.recoverySha };
}
export async function verifyCandidateBuild({ env = process.env, toolingRoot = ROOT } = {}) {
  const selected = await selectCandidateBuild({ env, toolingRoot });
  requireBuild(selected.candidateMode && env.PINNED_SOURCE_SHA === selected.sourceSha
    && env.PINNED_CANDIDATE_SHA === selected.candidateSha, "HOTFIX_BUILD_SOURCE_INVALID");
  const m = selected.manifest;
  const binding = { admissionId: selected.admissionId, provider: hotfixAdmissionProfile(selected.admissionId).provider,
    targetId: m.targetId, origin: m.origin, ...(m.railway ? { railway: m.railway, deploymentId: m.deploymentId } : {}) };
  const source = await verifyHotfixSource({ toolingRoot, sourceRoot: resolve(env.CANDIDATE_SOURCE_ROOT || ".admission-candidate"),
    sourceSha: selected.candidateSha, ...binding });
  requireBuild(source.admission === "hotfix" && source.toolingSha === env.GITHUB_SHA, "HOTFIX_BUILD_ADMISSION_INVALID");
  if (env.BUILD_SOURCE_ROOT) {
    const buildSource = await verifyHotfixSource({ toolingRoot, sourceRoot: resolve(env.BUILD_SOURCE_ROOT), sourceSha: selected.sourceSha,
      ...(selected.sourceRole === "candidate" ? binding : {}) });
    requireBuild(buildSource.prismaTree === source.prismaTree && buildSource.schemaSha256 === source.schemaSha256
      && (selected.sourceRole === "candidate" ? buildSource.sourceTree === source.sourceTree : buildSource.admission === "main"),
    "HOTFIX_BUILD_SCHEMA_MISMATCH");
  }
  if (env.ADMISSION_RECEIPT) {
    let prior;
    try { prior = JSON.parse(env.ADMISSION_RECEIPT); } catch { throw new Error("HOTFIX_BUILD_ADMISSION_INVALID"); }
    requireBuild(JSON.stringify(prior) === JSON.stringify(source), "HOTFIX_BUILD_ADMISSION_CHANGED");
  }
  return source;
}
export function candidateImageReceipt({ env, source, webDigest, workerDigest }) {
  const context = candidateBuildContext(env);
  requireBuild(context.candidateMode && source?.admission === "hotfix" && source.admissionId === context.admissionId
    && source.toolingSha === env.GITHUB_SHA && SHA.test(source.sourceSha || "") && SHA.test(source.sourceTree || "")
    && SHA.test(source.recoverySha || ""), "HOTFIX_BUILD_ADMISSION_INVALID");
  validateHotfixTarget(source, source);
  const sourceSha = context.sourceRole === "candidate" ? source.sourceSha : source.recoverySha;
  requireBuild(env.PINNED_SOURCE_SHA === sourceSha && DIGEST.test(webDigest || "") && DIGEST.test(workerDigest || ""),
    "HOTFIX_BUILD_IMAGES_INVALID");
  const runId = Number(env.GITHUB_RUN_ID), runAttempt = Number(env.GITHUB_RUN_ATTEMPT);
  requireBuild(Number.isSafeInteger(runId) && runId > 0 && Number.isSafeInteger(runAttempt) && runAttempt > 0, "HOTFIX_BUILD_RUN_INVALID");
  return { schemaVersion: 2, mode: "candidate-build", admissionId: context.admissionId, sourceRole: context.sourceRole,
    sourceSha, toolingSha: env.GITHUB_SHA, runId, runAttempt, source,
    images: { web: { digest: webDigest }, worker: { digest: workerDigest } } };
}
async function cli(mode, env = process.env) {
  if (mode === "select") {
    const selected = await selectCandidateBuild({ env });
    await appendFile(env.GITHUB_OUTPUT, `candidate_mode=${selected.candidateMode}\nsource_sha=${selected.sourceSha}\ncandidate_sha=${selected.candidateSha}\nsource_role=${selected.sourceRole}\n`);
    return;
  }
  const file = resolve(ROOT, ".artifacts/candidate-source.json");
  if (mode === "verify") {
    const source = await verifyCandidateBuild({ env });
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(source)}\n`, { flag: "wx" });
    if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, `source_receipt=${JSON.stringify(source)}\n`);
    return;
  }
  requireBuild(mode === "receipt", "HOTFIX_BUILD_MODE_INVALID");
  const source = JSON.parse(await readFile(file, "utf8"));
  const receipt = candidateImageReceipt({ env, source, webDigest: env.WEB_DIGEST, workerDigest: env.WORKER_DIGEST });
  await writeFile(resolve(env.RUNNER_TEMP, "release-image-digests.json"), `${JSON.stringify(receipt)}\n`, { flag: "wx" });
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  cli(process.argv[2]).catch((error) => {
    process.stderr.write(`${/^HOTFIX_[A-Z_]+$/.test(error.message) ? error.message : "HOTFIX_BUILD_ADMISSION_FAILED"}\n`);
    process.exitCode = 1;
  });
}
