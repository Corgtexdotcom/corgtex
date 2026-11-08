import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertOpsHotfixFleetBoundary, requireOpsOperationalApproval } from "./ops-hotfix-fleet-boundary.mjs";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const requireProof = (condition, code) => { if (!condition) throw new Error(code); };
export function assertOpsHotfixRequest(env = process.env, root = ROOT) {
  const records = ["selfserve-switcher-hotfix", "ops-release-authority-hotfix"].flatMap((name) => {
    const file = resolve(root, `.github/${name}.json`);
    return existsSync(file) ? [JSON.parse(readFileSync(file, "utf8"))] : [];
  });
  const sha = env.RELEASE_INPUT === "latest-stable" ? env.FLEET_RELEASE_STABLE_GIT_SHA : env.RELEASE_INPUT;
  if (!env.HOTFIX_EVIDENCE) {
    requireProof(!records.some((record) => record.candidateSha === sha), "HOTFIX_FLEET_EVIDENCE_REQUIRED");
    return;
  }
  requireProof(env.GITHUB_REPOSITORY === "Corgtexdotcom/corgtex" && env.GITHUB_EVENT_NAME === "workflow_dispatch"
    && env.GITHUB_REF === "refs/heads/main"
    && env.GITHUB_WORKFLOW_REF === "Corgtexdotcom/corgtex/.github/workflows/fleet-release.yml@refs/heads/main",
  "HOTFIX_FLEET_TOOLING_UNTRUSTED");
  const record = records.find((item) => item.admissionId === "ops-release-authority");
  requireProof(record && record.candidateSha === sha && env.TARGETS_INPUT === "ops"
    && env.FLEET_RELEASE_TARGET_ID === "", "HOTFIX_FLEET_REQUEST_INVALID");
  requireOpsOperationalApproval();
}
export function readOpsHotfixProof(env, target) {
  if (!env.OPS_HOTFIX_PROOF_FILE) return null;
  requireOpsOperationalApproval();
  const proof = JSON.parse(readFileSync(env.OPS_HOTFIX_PROOF_FILE, "utf8"));
  requireProof(proof?.schemaVersion === 1 && proof.kind === "ops-hotfix-release-proof"
    && proof.admission?.admission === "hotfix" && proof.candidate?.sourceSha === proof.admission.sourceSha
    && proof.candidate?.manifestSha256 === proof.admission.manifestSha256
    && proof.ci, "HOTFIX_FLEET_PROOF_INVALID");
  if (target) assertOpsHotfixFleetBoundary({ admission: proof.admission,
    context: { repository: env.GITHUB_REPOSITORY, eventName: env.GITHUB_EVENT_NAME, ref: env.GITHUB_REF, workflowRef: env.GITHUB_WORKFLOW_REF },
    selector: "ops", targetId: "", targets: [target] });
  return proof;
}
// Docker's raw output may append one presentation newline. Hash either exact
// representation; never accept reserialized JSON as registry-content proof.
export function validateOpsProducedIndex(raw, indexDigest, platformDigest) {
  requireProof(typeof raw === "string" && Buffer.byteLength(raw) <= 1024 * 1024
    && DIGEST.test(indexDigest) && DIGEST.test(platformDigest), "HOTFIX_INDEX_INVALID");
  const hash = (text) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
  requireProof(hash(raw) === indexDigest || (raw.endsWith("\n") && hash(raw.slice(0, -1)) === indexDigest),
    "HOTFIX_INDEX_DIGEST_MISMATCH");
  let index;
  try { index = JSON.parse(raw); } catch { throw new Error("HOTFIX_INDEX_INVALID"); }
  requireProof(index.schemaVersion === 2 && ["application/vnd.oci.image.index.v1+json", "application/vnd.docker.distribution.manifest.list.v2+json"].includes(index.mediaType)
    && Array.isArray(index.manifests), "HOTFIX_INDEX_INVALID");
  const matches = index.manifests.filter((entry) => entry?.platform?.os === "linux" && entry.platform.architecture === "amd64");
  requireProof(matches.length === 1 && matches[0].digest === platformDigest
    && ["application/vnd.oci.image.manifest.v1+json", "application/vnd.docker.distribution.manifest.v2+json"].includes(matches[0].mediaType),
  "HOTFIX_INDEX_PLATFORM_MISMATCH");
  return { indexDigest, platform: "linux/amd64", platformDigest };
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { assertOpsHotfixRequest(); } catch (error) {
    process.stderr.write(`${/^HOTFIX_[A-Z_]+$/.test(error.message) ? error.message : "HOTFIX_FLEET_REQUEST_INVALID"}\n`);
    process.exitCode = 1;
  }
}
