import { readFile, writeFile, mkdir, appendFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { verifyHotfixSource, hotfixAdmissionProfile } from "./selfserve-hotfix-source.mjs";
import { verifyHotfixBuildEvidence, verifyHotfixProofEvidence } from "./selfserve-hotfix-evidence.mjs";

import { assertOpsHotfixFleetBoundary, requireOpsOperationalApproval } from "./ops-hotfix-fleet-boundary.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const TARGET = "e0d34b24-bd86-4cb2-8ccb-f2f84309ca16";
const ORIGIN = "https://selfserve.corgtex.com";
const requireGate = (condition, code) => { if (!condition) throw new Error(code); };
const keys = (value, expected) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).sort().join("|") === [...expected].sort().join("|");
function reference(value) {
  requireGate(keys(value, ["runId", "runAttempt", "artifactId"])
    && Object.values(value).every((number) => Number.isSafeInteger(number) && number > 0), "HOTFIX_EVIDENCE_REFERENCE_INVALID");
  return value;
}
export function parseHotfixEvidence(raw, release = false) {
  requireGate(typeof raw === "string" && raw.length > 0 && raw.length < 4096, "HOTFIX_EVIDENCE_REQUIRED");
  let value;
  try { value = JSON.parse(raw); } catch { throw new Error("HOTFIX_EVIDENCE_REFERENCE_INVALID"); }
  if (!release) {
    requireGate(keys(value, ["build"]), "HOTFIX_EVIDENCE_REFERENCE_INVALID");
    reference(value.build);
  } else {
    requireGate(keys(value, ["ci", "candidate", "recovery"]), "HOTFIX_EVIDENCE_REFERENCE_INVALID");
    reference(value.ci);
    for (const role of ["candidate", "recovery"]) {
      requireGate(keys(value[role], ["build", "proof"]), "HOTFIX_EVIDENCE_REFERENCE_INVALID");
      reference(value[role].build); reference(value[role].proof);
    }
  }
  return value;
}
export function hotfixProofRole(env, manifest) {
  requireGate(env.IMAGE_PROOF_SCHEMA_SHA === manifest.baseSha, "HOTFIX_PROOF_SCHEMA_MISMATCH");
  if (env.IMAGE_PROOF_SOURCE_SHA === manifest.candidateSha) return "candidate";
  requireGate(env.IMAGE_PROOF_SOURCE_SHA === manifest.recoverySha, "HOTFIX_PROOF_SOURCE_MISMATCH");
  return "recovery";
}
export function assertHotfixProofImages(env, build) {
  for (const role of ["web", "worker"]) requireGate(build.images[role]
    === `ghcr.io/corgtexdotcom/corgtex/${role}@${env[`IMAGE_PROOF_${role.toUpperCase()}_DIGEST`]}`,
  "HOTFIX_PROOF_IMAGE_MISMATCH");
}

// Called again by source resolution before the release transaction can acquire
// its lease or import anything. Re-publishing a SHA tag cannot replace a proof.
export function assertHotfixResolvedImages(proof, { gitSha, deploymentId, roles }) {
  requireGate(proof?.schemaVersion === 1 && proof.kind === "selfserve-hotfix-release-proof"
    && proof.targetId === TARGET && proof.origin === ORIGIN && deploymentId === TARGET,
  "HOTFIX_RELEASE_TARGET_MISMATCH");
  const pair = gitSha === proof.candidate?.sourceSha ? proof.candidate
    : gitSha === proof.recovery?.sourceSha ? proof.recovery : null;
  requireGate(pair && pair.kind === "selfserve-hotfix-startup-proof"
    && pair.targetId === TARGET && pair.origin === ORIGIN && pair.manifestSha256 === proof.manifestSha256,
  "HOTFIX_RELEASE_SOURCE_MISMATCH");
  for (const role of ["web", "worker"]) requireGate(pair.images?.[role]
    === `ghcr.io/corgtexdotcom/corgtex/${role}@${roles?.[role]?.digest}`, "HOTFIX_RELEASE_DIGEST_MISMATCH");
}

async function save(file, value) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
}
async function expectedSource(env, manifest, admissionId = "selfserve-switcher") {
  const sourceRoot = resolve(env.HOTFIX_SOURCE_ROOT || ".accepted-source");
  const sourceSha = env.HOTFIX_SOURCE_SHA || manifest.candidateSha;
  const source = await verifyHotfixSource({ toolingRoot: ROOT, sourceRoot, sourceSha,
    targetId: env.HOTFIX_TARGET_ID || manifest.targetId, origin: manifest.origin, admissionId,
    ...(admissionId === "ops-release-authority" ? { provider: "railway", deploymentId: null, railway: manifest.railway } : {}) });
  return { source, sourceRoot, expected: { ...source, candidateSha: manifest.candidateSha,
    candidateTree: manifest.candidateTree, baseSha: manifest.baseSha, recoverySha: manifest.recoverySha } };
}
export async function runHotfixGate(mode, env = process.env) {
  if (mode === "ops-release") requireOpsOperationalApproval();
  const buildFile = resolve(ROOT, ".artifacts/hotfix-build.json");
  if (mode === "finish-proof") {
    const build = JSON.parse(await readFile(buildFile, "utf8"));
    const file = resolve(ROOT, ".artifacts/image-startup-proof/startup.json");
    const startup = JSON.parse(await readFile(file, "utf8"));
    requireGate(startup.status === "passed" && startup.cleanup === "completed", "HOTFIX_PROOF_INCOMPLETE");
    startup.hotfix = {
      ...Object.fromEntries(["manifestSha256", "candidateSha", "candidateTree", "sourceRole", "targetId", "origin", "recoverySha"].map((key) => [key, build[key]])),
      admissionId: build.admissionId, provider: build.provider, targetDigest: build.targetDigest,
      ...(build.admissionId === "ops-release-authority" ? { deploymentId: null, railway: build.railway } : {}),
      buildRunId: build.runId, buildRunAttempt: build.runAttempt, buildArtifactId: build.artifactId,
      toolingSha: env.GITHUB_SHA, runId: Number(env.GITHUB_RUN_ID), runAttempt: Number(env.GITHUB_RUN_ATTEMPT),
    };
    await writeFile(file, `${JSON.stringify(startup, null, 2)}\n`);
    return;
  }
  requireGate(["proof", "validation", "release", "ops-release"].includes(mode), "HOTFIX_GATE_MODE_INVALID");
  const admissionId = mode === "ops-release" ? "ops-release-authority" : (env.HOTFIX_ADMISSION_ID || "selfserve-switcher");
  requireGate(mode === "proof" || mode === "ops-release" || admissionId === "selfserve-switcher", "HOTFIX_GATE_TARGET_MISMATCH");
  const profile = hotfixAdmissionProfile(admissionId);
  const manifest = JSON.parse(await readFile(resolve(ROOT, profile.manifestPath), "utf8"));
  if (mode === "ops-release") {
    let targets;
    try { const parsed = JSON.parse(env.FLEET_RELEASE_OPS_TARGET_JSON); targets = Array.isArray(parsed) ? parsed : [parsed]; }
    catch { throw new Error("HOTFIX_FLEET_SELECTION_INVALID"); }
    assertOpsHotfixFleetBoundary({ admission: manifest, targets, selector: env.TARGETS_INPUT, targetId: env.FLEET_RELEASE_TARGET_ID,
      context: { repository: env.GITHUB_REPOSITORY, eventName: env.GITHUB_EVENT_NAME, ref: env.GITHUB_REF, workflowRef: env.GITHUB_WORKFLOW_REF } });
  }
  const { source, sourceRoot, expected } = await expectedSource(env, manifest, admissionId);
  if (source.admission !== "hotfix") {
    requireGate(mode !== "proof" && !env.HOTFIX_EVIDENCE, "HOTFIX_SOURCE_REQUIRED");
    return; // Existing reviewed-main release/validation path is unchanged.
  }
  let evidence;
  if (mode === "ops-release") {
    try { evidence = JSON.parse(env.HOTFIX_EVIDENCE); } catch { throw new Error("HOTFIX_EVIDENCE_REFERENCE_INVALID"); }
    requireGate(keys(evidence, ["ci", "build", "proof"]), "HOTFIX_EVIDENCE_REFERENCE_INVALID");
    for (const key of ["ci", "build", "proof"]) reference(evidence[key]);
  } else evidence = parseHotfixEvidence(env.HOTFIX_EVIDENCE, mode === "release");
  const options = { expected, token: env.GITHUB_TOKEN, toolingRoot: ROOT, sourceRoot };
  if (mode === "ops-release") {
    const { verifyHotfixCiEvidence } = await import("./hotfix-candidate-ci.mjs");
    const ci = await verifyHotfixCiEvidence({ ...options, ...evidence.ci });
    const build = await verifyHotfixBuildEvidence({ ...options, ...evidence.build, sourceRole: "candidate" });
    const candidate = await verifyHotfixProofEvidence({ ...options, ...evidence.proof, sourceRole: "candidate", buildEvidence: build });
    const proof = { schemaVersion: 1, kind: "ops-hotfix-release-proof", admission: source, ci, candidate };
    const file = resolve(ROOT, ".artifacts/ops-hotfix-release.json");
    await save(file, proof);
    requireGate(env.GITHUB_ENV, "HOTFIX_GITHUB_ENV_REQUIRED");
    await appendFile(env.GITHUB_ENV, `OPS_HOTFIX_PROOF_FILE=${file}\n`);
    return;
  }
  if (mode === "proof" || mode === "validation") {
    const sourceRole = mode === "proof" ? hotfixProofRole(env, manifest) : "candidate";
    const build = await verifyHotfixBuildEvidence({ ...options, ...evidence.build, sourceRole });
    if (mode === "proof") assertHotfixProofImages(env, build);
    await save(buildFile, build);
    if (mode === "validation") {
      requireGate(env.GITHUB_ENV, "HOTFIX_GITHUB_ENV_REQUIRED");
      await appendFile(env.GITHUB_ENV, `SELFSERVE_ISOLATED_WEB_IMAGE=${build.images.web}\n`);
    }
    return;
  }
  const { verifyHotfixCiEvidence } = await import("./hotfix-candidate-ci.mjs");
  const ci = await verifyHotfixCiEvidence({ ...options, ...evidence.ci });
  const pairs = {};
  for (const sourceRole of ["candidate", "recovery"]) {
    const build = await verifyHotfixBuildEvidence({ ...options, ...evidence[sourceRole].build, sourceRole });
    pairs[sourceRole] = await verifyHotfixProofEvidence({ ...options, ...evidence[sourceRole].proof, sourceRole, buildEvidence: build });
  }
  const proof = { schemaVersion: 1, kind: "selfserve-hotfix-release-proof", targetId: TARGET, origin: ORIGIN,
    manifestSha256: source.manifestSha256, ci, ...pairs };
  const file = resolve(ROOT, ".artifacts/hotfix-release.json");
  await save(file, proof);
  requireGate(env.GITHUB_ENV, "HOTFIX_GITHUB_ENV_REQUIRED");
  await appendFile(env.GITHUB_ENV, `MANAGED_HOTFIX_PROOF_FILE=${file}\n`);
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runHotfixGate(process.argv[2]).catch((error) => {
    process.stderr.write(`${/^HOTFIX_[A-Z_]+$/.test(error.message) ? error.message : "HOTFIX_GATE_FAILED"}\n`);
    process.exitCode = 1;
  });
}
