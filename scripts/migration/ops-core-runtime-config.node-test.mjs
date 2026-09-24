import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import { prepareOpsCoreRuntimeValues, retainOpsCoreRuntimeConfig } from "./ops-core-runtime-config.mjs";

function fixture() {
  const credential = randomBytes(32).toString("base64");
  const source = { SESSION_COOKIE_SECRET: credential, ENCRYPTION_KEY: credential,
    DATABASE_URL: "source-placeholder", REDIS_URL: "source-placeholder", REDIS_KEY_PREFIX: "existing-core",
    NEXT_PUBLIC_APP_URL: "https://app.example.test", MCP_PUBLIC_URL: "https://mcp.example.test",
    PROVIDER_CONFIG: `  ${credential}\n`, RAILWAY_SERVICE_ID: "source-id", S3_BUCKET_NAME: "source-bucket",
    CORGTEX_AUTO_SEED_INTERNAL_VALIDATION: "true", NEXT_SERVER_ACTIONS_ENCRYPTION_KEY: credential };
  const names = Object.keys(source).sort(); const omit = ["RAILWAY_SERVICE_ID", "S3_BUCKET_NAME", "CORGTEX_AUTO_SEED_INTERNAL_VALIDATION"];
  const plan = { schemaVersion: 1, domain: "core", targetBindingSha256: "a".repeat(64), binding: {
    vaultUri: "https://fixture-runtime.vault.azure.net/", storageAccount: "fixtureobjects", storageContainer: "documents",
    identityClientId: "00000000-0000-4000-8000-000000000002",
    identityResourceId: "/subscriptions/00000000-0000-4000-8000-000000000001/resourceGroups/fixture/providers/Microsoft.ManagedIdentity/userAssignedIdentities/core",
    postgresHost: "fixture.postgres.database.azure.com", redisHost: "fixture.westus3.redis.azure.net" },
  roles: { web: { sourceNames: names, omit }, worker: { sourceNames: names, omit } } };
  const secrets = new Map(); const calls = []; let active = false;
  const options = { plan, sourceEnvironments: { web: { ...source }, worker: { ...source } },
    databaseUrl: `postgresql://runtime:${encodeURIComponent(credential)}@fixture.postgres.database.azure.com/corgtex_core?sslmode=verify-full`,
    redisUrl: `rediss://default:${encodeURIComponent(credential)}@fixture.westus3.redis.azure.net:10000/0`,
    signal: new AbortController().signal,
    assertTargetInactive: async () => ({ complete: !active, domain: "core", targetBindingSha256: plan.targetBindingSha256 }),
    secretClient: {
      async getSecret(name) { if (!secrets.has(name)) throw { statusCode: 404, code: "SecretNotFound" }; return structuredClone(secrets.get(name)); },
      async setSecret(name, value) {
        calls.push(name); const version = randomBytes(16).toString("hex");
        const stored = { value, properties: { version, id: `${plan.binding.vaultUri}secrets/${name}/${version}`, enabled: true } };
        secrets.set(name, stored); return structuredClone(stored);
      },
    } };
  return { options, secrets, calls, credential, activate: () => { active = true; } };
}

test("runtime projection preserves exact continuity/provider/origin/build-key values and changes only infrastructure", () => {
  const f = fixture(); const p = prepareOpsCoreRuntimeValues(f.options);
  assert.equal(p.roles.web.values.PROVIDER_CONFIG, f.options.sourceEnvironments.web.PROVIDER_CONFIG);
  assert.equal(p.roles.web.values.NEXT_SERVER_ACTIONS_ENCRYPTION_KEY, f.credential);
  assert.equal(p.roles.worker.values.REDIS_KEY_PREFIX, "existing-core");
  assert.equal(p.roles.web.values.MCP_PUBLIC_URL, "https://mcp.example.test");
  assert.equal(p.roles.web.generated.CORGTEX_STARTUP_MODE, "migrate-and-web");
  assert.equal(p.roles.web.generated.STORAGE_PROVIDER, "azure_blob");
  assert.equal(p.roles.web.values.RAILWAY_SERVICE_ID, undefined);
  assert.equal(p.roles.web.values.CORGTEX_AUTO_SEED_INTERNAL_VALIDATION, undefined);
});
test("retains versioned private references, reads bytes back and reuses identical versions without writes", async () => {
  const f = fixture(); const result = await retainOpsCoreRuntimeConfig(f.options);
  assert.equal(JSON.stringify(result).includes(f.credential), false);
  for (const role of ["web", "worker"]) {
    const env = result.roles[role].env.find(item => item.name === "SESSION_COOKIE_SECRET");
    const secret = result.roles[role].secrets.find(item => item.name === env.secretRef);
    assert.match(secret.keyVaultUrl, /\/secrets\/migration-core-.*\/[a-f0-9]{32}$/);
    assert.equal(secret.identity, f.options.plan.binding.identityResourceId);
  }
  const count = f.calls.length; const again = await retainOpsCoreRuntimeConfig(f.options);
  assert.deepEqual(again, result); assert.equal(f.calls.length, count);
});
test("unknown source inventory drift blocks before any secret write", async () => {
  const f = fixture(); f.options.sourceEnvironments.worker.NEW_PROVIDER_KEY = f.credential;
  await assert.rejects(retainOpsCoreRuntimeConfig(f.options), /RUNTIME_SOURCE_INVENTORY_MISMATCH/); assert.equal(f.calls.length, 0);
});
test("cannot omit an application credential or leave source infrastructure unclassified", async () => {
  const f = fixture(); f.options.plan.roles.web.omit.push("ENCRYPTION_KEY");
  await assert.rejects(retainOpsCoreRuntimeConfig(f.options), /RUNTIME_SOURCE_INVENTORY_MISMATCH/);
  f.options.plan.roles.web.omit = [];
  await assert.rejects(retainOpsCoreRuntimeConfig(f.options), /RUNTIME_SOURCE_INFRASTRUCTURE_UNCLASSIFIED/); assert.equal(f.calls.length, 0);
});
test("refuses divergent worker continuity credentials and Redis namespaces", () => {
  for (const name of ["ENCRYPTION_KEY", "SESSION_COOKIE_SECRET", "REDIS_KEY_PREFIX"]) {
    const f = fixture(); f.options.sourceEnvironments.worker[name] = "different";
    assert.throws(() => prepareOpsCoreRuntimeValues(f.options), /RUNTIME_(CONTINUITY_SECRET|REDIS_PREFIX)_MISMATCH/);
  }
});
test("cannot send runtime data to a foreign database or downgrade transport", () => {
  for (const change of [o => { o.databaseUrl = o.databaseUrl.replace("fixture.postgres", "foreign.postgres"); },
    o => { o.databaseUrl = o.databaseUrl.replace("verify-full", "disable"); },
    o => { o.databaseUrl += "&host=foreign"; }, o => { o.redisUrl = o.redisUrl.replace("rediss:", "redis:"); }]) {
    const f = fixture(); change(f.options); assert.throws(() => prepareOpsCoreRuntimeValues(f.options), /RUNTIME_(DATABASE|REDIS)_INVALID/);
  }
});
test("different existing vault value is never overwritten", async () => {
  const f = fixture(); await retainOpsCoreRuntimeConfig(f.options); const count = f.calls.length;
  f.secrets.values().next().value.value = "different";
  await assert.rejects(retainOpsCoreRuntimeConfig(f.options), /RUNTIME_SECRET_READBACK_MISMATCH/); assert.equal(f.calls.length, count);
});
test("lost write acknowledgement is reconciled by fresh read without a second version", async () => {
  const f = fixture(); const set = f.options.secretClient.setSecret; let first = true;
  f.options.secretClient.setSecret = async (...args) => { const result = await set(...args); if (first) { first = false; throw new Error(f.credential); } return result; };
  await assert.rejects(retainOpsCoreRuntimeConfig(f.options), error => error.message === "RUNTIME_CONFIG_RECONCILIATION_REQUIRED" && !String(error.stack).includes(f.credential));
  const firstName = f.calls[0]; const version = f.secrets.get(firstName).properties.version;
  await retainOpsCoreRuntimeConfig(f.options); assert.equal(f.calls.filter(name => name === firstName).length, 1);
  assert.equal(f.secrets.get(firstName).properties.version, version);
});
test("activation or cancellation during readback blocks further secret writes", async () => {
  const f = fixture(); const set = f.options.secretClient.setSecret;
  f.options.secretClient.setSecret = async (...args) => { const value = await set(...args); f.activate(); return value; };
  await assert.rejects(retainOpsCoreRuntimeConfig(f.options), /RUNTIME_TARGET_UNPROVEN/); assert.equal(f.calls.length, 1);
});


function postgresStateFixture() {
  const f = fixture();
  f.options.plan.binding.sharedStateBackend = "postgres";
  f.options.plan.binding.redisHost = null;
  f.options.redisUrl = null;
  f.options.databaseUrl += "&connection_limit=5&pool_timeout=10";
  return f;
}
test("PostgreSQL runtime explicitly selects shared backend with bounded pools and no Redis secret", async () => {
  const f = postgresStateFixture();
  const result = await retainOpsCoreRuntimeConfig(f.options);
  for (const role of ["web", "worker"]) {
    assert.deepEqual(result.roles[role].env.find(e => e.name === "SHARED_STATE_BACKEND"), { name: "SHARED_STATE_BACKEND", value: "postgres" });
    assert.equal(result.roles[role].env.some(e => e.name === "REDIS_URL"), false);
    assert.equal(result.roles[role].env.some(e => e.name === "DATABASE_URL" && e.secretRef), true);
  }
});
for (const [label, change] of [
  ["mixed Redis credentials", o => { o.redisUrl = fixture().options.redisUrl; }],
  ["unbounded pool", o => { o.databaseUrl = o.databaseUrl.replace("connection_limit=5", "connection_limit=50"); }],
  ["missing pool", o => { o.databaseUrl = o.databaseUrl.replace("&connection_limit=5", ""); }],
  ["missing backend", o => { delete o.plan.binding.sharedStateBackend; }],
  ["unknown backend", o => { o.plan.binding.sharedStateBackend = "automatic"; }],
]) test(`PostgreSQL runtime rejects ${label} before secret writes`, async () => {
  const f = postgresStateFixture(); change(f.options);
  await assert.rejects(retainOpsCoreRuntimeConfig(f.options)); assert.equal(f.calls.length, 0);
});
