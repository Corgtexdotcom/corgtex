import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseHotfixEvidence, hotfixProofRole, assertHotfixProofImages, assertHotfixResolvedImages } from "./selfserve-hotfix-gate.mjs";

const manifest = { baseSha: "a".repeat(40), candidateSha: "b".repeat(40), recoverySha: "a".repeat(40) };
const ref = { runId: 1, runAttempt: 1, artifactId: 2 };
test("only closed numeric evidence references enter authenticated artifact reads", () => {
  assert.deepEqual(parseHotfixEvidence(JSON.stringify({ build: ref })), { build: ref });
  assert.deepEqual(parseHotfixEvidence(JSON.stringify({ ci: ref, candidate: { build: ref, proof: ref }, recovery: { build: ref, proof: ref } }), true).candidate.build, ref);
  for (const value of [null, "", "[]", '{"build":{"runId":"1","runAttempt":1,"artifactId":2}}',
    JSON.stringify({ build: { ...ref, artifactId: -1 } }), JSON.stringify({ build: { ...ref, path: "../fake.zip" } }),
    JSON.stringify({ build: ref, candidateSha: manifest.candidateSha }), JSON.stringify({ candidate: { build: ref, proof: ref } })]) {
    assert.throws(() => parseHotfixEvidence(value), /HOTFIX_/);
  }
});
test("candidate and recovery proof retain the unchanged reviewed-main schema", () => {
  assert.equal(hotfixProofRole({ IMAGE_PROOF_SOURCE_SHA: manifest.candidateSha, IMAGE_PROOF_SCHEMA_SHA: manifest.baseSha }, manifest), "candidate");
  assert.equal(hotfixProofRole({ IMAGE_PROOF_SOURCE_SHA: manifest.recoverySha, IMAGE_PROOF_SCHEMA_SHA: manifest.baseSha }, manifest), "recovery");
  assert.throws(() => hotfixProofRole({ IMAGE_PROOF_SOURCE_SHA: manifest.candidateSha, IMAGE_PROOF_SCHEMA_SHA: manifest.candidateSha }, manifest), /SCHEMA_MISMATCH/);
  assert.throws(() => hotfixProofRole({ IMAGE_PROOF_SOURCE_SHA: "c".repeat(40), IMAGE_PROOF_SCHEMA_SHA: manifest.baseSha }, manifest), /SOURCE_MISMATCH/);
});
const digest = (value) => `sha256:${value.repeat(64)}`;
const images = { web: `ghcr.io/corgtexdotcom/corgtex/web@${digest("d")}`, worker: `ghcr.io/corgtexdotcom/corgtex/worker@${digest("e")}` };
test("proof input images cannot substitute another role or mutable SHA tag", () => {
  const env = { IMAGE_PROOF_WEB_DIGEST: digest("d"), IMAGE_PROOF_WORKER_DIGEST: digest("e") };
  assert.doesNotThrow(() => assertHotfixProofImages(env, { images }));
  assert.throws(() => assertHotfixProofImages({ ...env, IMAGE_PROOF_WEB_DIGEST: digest("f") }, { images }), /IMAGE_MISMATCH/);
  assert.throws(() => assertHotfixProofImages(env, { images: { ...images, worker: images.web } }), /IMAGE_MISMATCH/);
});
const targetId = "e0d34b24-bd86-4cb2-8ccb-f2f84309ca16", origin = "https://selfserve.corgtex.com";
function releaseProof() {
  const binding = { kind: "selfserve-hotfix-startup-proof", targetId, origin, manifestSha256: "f".repeat(64), images };
  return { schemaVersion: 1, kind: "selfserve-hotfix-release-proof", targetId, origin, manifestSha256: binding.manifestSha256,
    candidate: { ...binding, sourceSha: manifest.candidateSha }, recovery: { ...binding, sourceSha: manifest.recoverySha } };
}
const resolved = (gitSha = manifest.candidateSha) => ({ gitSha, deploymentId: targetId, roles: { web: { digest: digest("d") }, worker: { digest: digest("e") } } });
test("resolved candidate and recovery tags must still match the authenticated immutable pair", () => {
  assert.doesNotThrow(() => assertHotfixResolvedImages(releaseProof(), resolved()));
  assert.doesNotThrow(() => assertHotfixResolvedImages(releaseProof(), resolved(manifest.recoverySha)));
  const changed = resolved(); changed.roles.worker.digest = digest("f");
  assert.throws(() => assertHotfixResolvedImages(releaseProof(), changed), /DIGEST_MISMATCH/);
  assert.throws(() => assertHotfixResolvedImages(releaseProof(), resolved("c".repeat(40))), /SOURCE_MISMATCH/);
  assert.throws(() => assertHotfixResolvedImages(releaseProof(), { ...resolved(), deploymentId: "other" }), /TARGET_MISMATCH/);
  const wrongManifest = releaseProof(); wrongManifest.recovery.manifestSha256 = "0".repeat(64);
  assert.throws(() => assertHotfixResolvedImages(wrongManifest, resolved(manifest.recoverySha)), /SOURCE_MISMATCH/);
});
test("tag recheck remains inside source resolution, before transaction lease acquisition", () => {
  const runner = readFileSync(new URL("./managed-azure-release-transaction.mjs", import.meta.url), "utf8");
  const resolution = runner.slice(runner.indexOf("resolveRelease: async"), runner.indexOf("verifyImport: async"));
  assert.match(resolution, /assertHotfixResolvedImages\(hotfixProof, \{ gitSha, deploymentId, roles \}\)/);
  assert.ok(runner.indexOf("await deps.resolveRelease") < runner.indexOf('deps.lease("acquire"'));
});
