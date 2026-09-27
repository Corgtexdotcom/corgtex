import test from "node:test";
import assert from "node:assert/strict";
import { opsCoreImageRepository } from "./ops-core-image-repository.mjs";
import { validateOpsCoreActivationPlan } from "./ops-core-activation.mjs";
import { imageDigest, validateRegistry, validateReleaseBuild, validateReleaseDigestReceipt,
  validateReleaseRun } from "./promote-opscore-images.mjs";

const sha = "a".repeat(40);
const digest = `sha256:${"b".repeat(64)}`;
const run = { id: 123, name: "Release Images", path: ".github/workflows/release-images.yml",
  event: "workflow_dispatch", head_branch: "main", head_sha: sha, conclusion: "success", run_attempt: 1 };

test("image promotion admits only a successful Release Images run at the exact main SHA", () => {
  validateReleaseRun(run, { id: "123", sha });
  for (const changed of [{ head_sha: "c".repeat(40) }, { conclusion: "failure" },
    { head_branch: "feature" }, { path: ".github/workflows/other.yml" }]) {
    assert.throws(() => validateReleaseRun({ ...run, ...changed }, { id: "123", sha }), /IMAGE_RELEASE_NOT_PROVEN/);
  }
});

test("selected release run binds two immutable GHCR digests", () => {
  const receipt = { schemaVersion: 1, sourceSha: sha,
    images: { web: { digest }, worker: { digest: `sha256:${"c".repeat(64)}` } } };
  validateReleaseDigestReceipt(receipt, sha);
  assert.throws(() => validateReleaseDigestReceipt({ ...receipt, sourceSha: "d".repeat(40) }, sha),
    /IMAGE_RELEASE_DIGESTS_UNPROVEN/);
  assert.throws(() => validateReleaseDigestReceipt({ ...receipt, images: { web: receipt.images.web } }, sha),
    /IMAGE_RELEASE_DIGESTS_UNPROVEN/);
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

test("promoted repository digest references satisfy the activation image contract", () => {
  const subscription = "00000000-0000-4000-8000-000000000001";
  const prefix = `/subscriptions/${subscription}/resourceGroups/fixture/providers/`;
  const id = (type, name) => `${prefix}${type}/${name}`;
  const identity = id("Microsoft.ManagedIdentity/userAssignedIdentities", "fixture");
  const acrServer = "acrcorgtexcrprodwus3.azurecr.io";
  const target = { domain: "ops", subscriptionId: subscription, resourceGroupName: "fixture",
    environmentId: id("Microsoft.App/managedEnvironments", "fixture"),
    postgres: { resourceId: id("Microsoft.DBforPostgreSQL/flexibleServers", "fixture-pg"),
      host: "fixture-pg.postgres.database.azure.com", major: 18,
      privateEndpointId: id("Microsoft.Network/privateEndpoints", "pg") },
    redis: { resourceId: id("Microsoft.Cache/redisEnterprise", "fixture-redis"),
      databaseId: id("Microsoft.Cache/redisEnterprise", "fixture-redis/databases/default"),
      host: "fixture-redis.westus3.redis.azure.net", port: 10000,
      privateEndpointId: id("Microsoft.Network/privateEndpoints", "redis") },
    apps: { web: "fixture-web", worker: "fixture-worker" } };
  const plan = { schemaVersion: 1, target, location: "westus3", managedIdentityId: identity,
    managedIdentityClientId: "00000000-0000-4000-8000-000000000002",
    runtimeVaultUri: "https://fixture.vault.azure.net/", acrServer,
    release: { gitSha: sha, imageTag: `sha-${sha}`, version: "1.2.3" },
    roles: Object.fromEntries(["web", "worker"].map(role => [role, {
      image: `${opsCoreImageRepository(acrServer, role)}@${digest}`,
      resources: { cpu: 0.5, memory: "1Gi" },
      env: [{ name: "DATABASE_URL", secretRef: "db" }, { name: "REDIS_URL", secretRef: "redis" }],
      secrets: ["db", "redis"].map(name => ({ name,
        keyVaultUrl: `https://fixture.vault.azure.net/secrets/${name}/${"d".repeat(32)}`, identity })),
    }])) };
  assert.doesNotThrow(() => validateOpsCoreActivationPlan(plan));
  plan.roles.web.image = `${acrServer}/opscore/web@${digest}`;
  assert.throws(() => validateOpsCoreActivationPlan(plan), /ACTIVATION_RUNTIME_INVALID/);
});
