import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { assertOpsHotfixRequest, validateOpsProducedIndex } from "./ops-hotfix-fleet-proof.mjs";
const child = `sha256:${"a".repeat(64)}`;
const index = () => ({ schemaVersion: 2, mediaType: "application/vnd.oci.image.index.v1+json", manifests: [{ mediaType: "application/vnd.oci.image.manifest.v1+json", digest: child, platform: { os: "linux", architecture: "amd64" } }] });
const hash = (raw) => `sha256:${createHash("sha256").update(raw).digest("hex")}`;
test("binds produced index bytes to its unique deployed amd64 child", () => {
  const raw = JSON.stringify(index());
  assert.deepEqual(validateOpsProducedIndex(raw, hash(raw), child), { indexDigest: hash(raw), platform: "linux/amd64", platformDigest: child });
  assert.doesNotThrow(() => validateOpsProducedIndex(`${raw}\n`, hash(raw), child));
  assert.throws(() => validateOpsProducedIndex(raw, `sha256:${"b".repeat(64)}`, child), /DIGEST_MISMATCH/);
  assert.throws(() => validateOpsProducedIndex(raw, hash(raw), `sha256:${"c".repeat(64)}`), /PLATFORM_MISMATCH/);
  const duplicate = index(); duplicate.manifests.push(duplicate.manifests[0]);
  const other = index(); other.manifests[0].platform.architecture = "arm64";
  for (const value of [duplicate, other]) { const bytes = JSON.stringify(value); assert.throws(() => validateOpsProducedIndex(bytes, hash(bytes), child), /PLATFORM_MISMATCH/); }
  assert.throws(() => validateOpsProducedIndex(JSON.stringify(index(), null, 2), hash(raw), child), /DIGEST_MISMATCH/);
});
test("known exact candidates cannot fall through ordinary Fleet without evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "fleet-admission-"));
  try {
    mkdirSync(join(root, ".github"));
    writeFileSync(join(root, ".github/selfserve-switcher-hotfix.json"), JSON.stringify({ candidateSha: "a".repeat(40) }));
    writeFileSync(join(root, ".github/ops-release-authority-hotfix.json"), JSON.stringify({ admissionId: "ops-release-authority", candidateSha: "b".repeat(40) }));
    for (const sha of ["a".repeat(40), "b".repeat(40)]) {
      assert.throws(() => assertOpsHotfixRequest({ RELEASE_INPUT: sha }, root), /EVIDENCE_REQUIRED/);
      assert.throws(() => assertOpsHotfixRequest({ RELEASE_INPUT: "latest-stable", FLEET_RELEASE_STABLE_GIT_SHA: sha }, root), /EVIDENCE_REQUIRED/);
    }
    assert.doesNotThrow(() => assertOpsHotfixRequest({ RELEASE_INPUT: "c".repeat(40) }, root));
    const env = { RELEASE_INPUT: "b".repeat(40), HOTFIX_EVIDENCE: "{}", GITHUB_REPOSITORY: "Corgtexdotcom/corgtex", GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: "refs/heads/main", GITHUB_WORKFLOW_REF: "Corgtexdotcom/corgtex/.github/workflows/fleet-release.yml@refs/heads/main", TARGETS_INPUT: "ops", FLEET_RELEASE_TARGET_ID: "" };
    assert.throws(() => assertOpsHotfixRequest(env, root), /HOTFIX_OPS_OPERATIONAL_APPROVAL_REQUIRED/);
    for (const patch of [{ RELEASE_INPUT: "a".repeat(40) }, { TARGETS_INPUT: "all" }, { FLEET_RELEASE_TARGET_ID: null }, { GITHUB_REF: "refs/heads/hotfix" }]) assert.throws(() => assertOpsHotfixRequest({ ...env, ...patch }, root), /HOTFIX_/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("privileged candidate mode runs trusted tooling and skips all candidate code", () => {
  const workflow = YAML.parse(readFileSync(new URL("../../.github/workflows/fleet-release.yml", import.meta.url), "utf8"));
  const steps = workflow.jobs.release.steps;
  const gate = steps.findIndex((step) => step.run?.includes("selfserve-hotfix-gate.mjs ops-release"));
  assert.ok(gate > 0 && gate < steps.findIndex((step) => step.run?.includes("preflight-provider")));
  const request = steps.findIndex((step) => step.run?.includes("ops-hotfix-fleet-proof.mjs"));
  const read = steps.findIndex((step) => step.with?.path === ".ops-hotfix-source");
  assert.ok(request < read && read < gate);
  assert.equal(steps[read].with["persist-credentials"], false);
  const candidateCheckout = steps.findIndex((step) => step.with?.ref === "${{ steps.manifest.outputs.git_sha }}");
  const restore = steps.findIndex((step) => step.name === "Checkout release runner source");
  for (const step of steps.slice(candidateCheckout, restore + 1)) assert.equal(step.if, "inputs.hotfix_evidence == ''");
  assert.equal(steps[0].with["persist-credentials"], false);
});
test("registry proof binds actual platform image before staged Railway mutation", () => {
  const runner = readFileSync(new URL("./fleet-release-runner.mjs", import.meta.url), "utf8");
  assert.match(runner, /image\.producedIndex = validateOpsProducedIndex\(raw, indexDigest, image\.manifestDigest\)/);
  const body = runner.slice(runner.indexOf("function verifyOpsRegistryBaseline"), runner.indexOf("function isCanonicalFleetImage"));
  assert.match(body, /producedIndex\.platformDigest !== matches\[0\]\.manifestDigest/);
  assert.match(body, /hotfix\.candidate\.images/);
});
test("Fleet holds unapproved Ops promotion before any provider read or mutation", async () => {
  const { checkFleetRegistryImages } = await import("./fleet-release-runner.mjs");
  const root = mkdtempSync(join(tmpdir(), "fleet-index-"));
  try {
    const file = join(root, "proof.json"), sha = "b".repeat(40);
    writeFileSync(file, JSON.stringify({ schemaVersion: 1, kind: "ops-hotfix-release-proof", ci: { status: "passed" },
      admission: { admission: "hotfix", sourceSha: sha, manifestSha256: "c".repeat(64) },
      candidate: { sourceSha: sha, manifestSha256: "c".repeat(64), images: { web: `ghcr.io/corgtexdotcom/corgtex/web@sha256:${"d".repeat(64)}`, worker: `ghcr.io/corgtexdotcom/corgtex/worker@sha256:${"e".repeat(64)}` } } }));
    let providerCalls = 0;
    await assert.rejects(checkFleetRegistryImages({ gitSha: sha, ghcrWebImage: `ghcr.io/corgtexdotcom/corgtex/web:sha-${sha}`, ghcrWorkerImage: `ghcr.io/corgtexdotcom/corgtex/worker:sha-${sha}` }, "ops", {
      env: { OPS_HOTFIX_PROOF_FILE: file, FLEET_RELEASE_TARGET_ID: "" },
      runCommand: (_command, args) => ({ stdout: args[0] === "buildx" ? JSON.stringify(index()) : JSON.stringify([{ Descriptor: { platform: { os: "linux", architecture: "amd64" }, digest: child } }]) }),
      fetch: () => { providerCalls++; throw Error("unexpected provider call"); },
    }), /HOTFIX_OPS_OPERATIONAL_APPROVAL_REQUIRED/);
    assert.equal(providerCalls, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
