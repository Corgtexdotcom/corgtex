import test from "node:test";
import assert from "node:assert/strict";
import { imageDigest, validateRegistry, validateReleaseBuild, validateReleaseRun } from "./promote-opscore-images.mjs";

const sha = "a".repeat(40);
const digest = `sha256:${"b".repeat(64)}`;
const run = { id: 123, name: "Release Images", path: ".github/workflows/release-images.yml",
  event: "workflow_dispatch", head_branch: "main", head_sha: sha, conclusion: "success" };

test("image promotion admits only a successful Release Images run at the exact main SHA", () => {
  validateReleaseRun(run, { id: "123", sha });
  for (const changed of [{ head_sha: "c".repeat(40) }, { conclusion: "failure" },
    { head_branch: "feature" }, { path: ".github/workflows/other.yml" }]) {
    assert.throws(() => validateReleaseRun({ ...run, ...changed }, { id: "123", sha }), /IMAGE_RELEASE_NOT_PROVEN/);
  }
});

test("registry identity and admin access must match the pinned Azure target", () => {
  const account = { id: "227eb707-bc46-415e-a09b-7d2b69fb14b2" };
  const registry = { id: "/subscriptions/227eb707-bc46-415e-a09b-7d2b69fb14b2/resourceGroups/rg-corgtex-corporate-rebels-production-wus3/providers/Microsoft.ContainerRegistry/registries/acrcorgtexcrprodwus3",
    loginServer: "acrcorgtexcrprodwus3.azurecr.io",
    adminUserEnabled: false, provisioningState: "Succeeded" };
  validateRegistry(account, registry);
  assert.throws(() => validateRegistry(account, { ...registry, adminUserEnabled: true }), /IMAGE_REGISTRY_CHANGED/);
  assert.throws(() => validateRegistry(account, { ...registry, id: registry.id.replace("corporate-rebels", "other") }),
    /IMAGE_REGISTRY_CHANGED/);
});

test("image content and registry digest receipts reject swapped roles and ambiguous digests", () => {
  validateReleaseBuild({ schemaVersion: 1, role: "web", gitSha: sha }, { role: "web", sha });
  assert.throws(() => validateReleaseBuild({ schemaVersion: 1, role: "worker", gitSha: sha },
    { role: "web", sha }), /IMAGE_BUILD_IDENTITY_MISMATCH/);
  const repo = "ghcr.io/corgtexdotcom/corgtex/web";
  assert.equal(imageDigest(repo, [`${repo}@${digest}`]), digest);
  assert.throws(() => imageDigest(repo, [`ghcr.io/foreign/web@${digest}`]), /IMAGE_DIGEST_UNPROVEN/);
  assert.throws(() => imageDigest(repo, [`${repo}@${digest}`, `${repo}@${digest}`]), /IMAGE_DIGEST_UNPROVEN/);
});
