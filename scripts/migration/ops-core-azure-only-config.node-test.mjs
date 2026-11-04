import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { validateAzureOnlyConfiguration as validate } from "./azure-only-config.mjs";

const enabled = { enabled: true };
const valid = { enabled: true, valid: true, findings: [] };
const finding = (setting, code) => ({ enabled: true, valid: false, findings: [{ setting, code }] });

test("Azure-only validation requires explicit opt-in and leaves staged values untouched", () => {
  const values = { APP_URL: "https://fixture.up.railway.app" };
  const before = structuredClone(values);
  for (const policy of [undefined, { enabled: false }]) {
    assert.deepEqual(validate(values, policy), { enabled: false, valid: true, findings: [] });
  }
  assert.deepEqual(values, before);
});

for (const value of [
  "https://fixture.up.railway.app", "HTTPS://FIXTURE.UP.RAILWAY.APP.:8443/path?fixture=1",
  "https://fixture%2eup%2erailway%2eapp/path", "https://railway.app/",
  "postgresql://runtime:synthetic-password@DB.PROXY.RLWY.NET.:5432/database",
  "rediss://default:synthetic-password@REDIS.RAILWAY.INTERNAL:6379/0",
  "https://backboard.railway.com/graphql/v2", " https://fixture.up.railway.app/ ",
]) test(`normalizes Railway endpoint fixture ${JSON.stringify(value.replace(/synthetic-password/g, "fixture"))}`, () => {
  assert.deepEqual(validate({ BACKEND_URL: value }, enabled), finding("BACKEND_URL", "RAILWAY_HOST"));
});

for (const value of [
  "https://api.stripe.com/v1", "https://accounts.google.com/", "https://slack.com/api/",
  "https://openrouter.ai/api/v1", "https://fixture.blob.core.windows.net/objects",
  "https://fixture.up.railway.app.example.test/", "https://notrailway.app/", "https://railway-app.example.test/",
  "https://api.stripe.com/fixture.up.railway.app?next=https://fixture.up.railway.app",
  "https://fixture.up.railway.app:fixture@api.stripe.com:443/v1",
  "postgresql://fixture:fixture@db.example.test:5432/database",
]) test(`permits external provider or lookalike fixture ${JSON.stringify(value)}`, () => {
  assert.deepEqual(validate({ BACKEND_URL: value }, enabled), valid);
});

test("custom legacy origins match exact normalized hosts across protocols, paths and ports", () => {
  const policy = { enabled: true, legacyOrigins: ["https://OLD.EXAMPLE.TEST.:443/"] };
  const before = structuredClone(policy);
  for (const value of ["https://old.example.test/path", "http://old.example.test:8080/", "wss://OLD.EXAMPLE.TEST.:9443/socket"]) {
    assert.deepEqual(validate({ MCP_PUBLIC_URL: value }, policy), finding("MCP_PUBLIC_URL", "LEGACY_ORIGIN"));
  }
  for (const value of ["https://sub.old.example.test", "https://old.example.test.other.test", "https://new.example.test"]) {
    assert.deepEqual(validate({ MCP_PUBLIC_URL: value }, policy), valid);
  }
  assert.deepEqual(validate({ MCP_PUBLIC_URL: "https://old.example.test" }, enabled), valid);
  assert.deepEqual(policy, before);
});

test("custom legacy hosts normalize internationalized domains without conflating lookalikes", () => {
  const policy = { enabled: true, legacyOrigins: ["https://bücher.example.test"] };
  assert.deepEqual(validate({ APP_URL: "https://xn--bcher-kva.example.test:8443/path" }, policy), finding("APP_URL", "LEGACY_ORIGIN"));
  assert.deepEqual(validate({ DATABASE_URL: "postgresql://fixture:fixture@bücher.example.test:5432/database" }, policy),
    finding("DATABASE_URL", "LEGACY_ORIGIN"));
  assert.deepEqual(validate({ APP_URL: "https://rаilway.app" }, enabled), valid);
});

test("bare HOST/HOSTNAME values accept ports, IP addresses and normalized Railway hosts", () => {
  for (const value of ["DB.RAILWAY.INTERNAL.:5432", "fixture.proxy.rlwy.net:5432"]) {
    assert.deepEqual(validate({ DATABASE_HOST: value }, enabled), finding("DATABASE_HOST", "RAILWAY_HOST"));
  }
  for (const value of ["db.example.test:5432", "127.0.0.1:5432", "[::1]:5432", "localhost"]) {
    assert.deepEqual(validate({ DATABASE_HOSTNAME: value }, enabled), valid);
  }
});

test("opaque credentials are preserved while an absolute URL under any setting is checked", () => {
  assert.deepEqual(validate({ PROVIDER_CONFIG: "fixture mentions railway.app", SECRET: "fixture.railway.internal" }, enabled), valid);
  assert.deepEqual(validate({ PROVIDER_CONFIG: "https://fixture.up.railway.app" }, enabled), finding("PROVIDER_CONFIG", "RAILWAY_HOST"));
  assert.deepEqual(validate({ CUSTOM_SERVICE: "not-an-absolute-url" }, enabled), valid);
  assert.deepEqual(validate({ CUSTOM_SERVICE: "not-an-absolute-url" }, { enabled: true, urlNames: ["CUSTOM_SERVICE"] }),
    finding("CUSTOM_SERVICE", "INVALID_ENDPOINT"));
});

for (const value of [
  42, false, {}, [], "not-an-absolute-url", "/relative", "https://", "https://user:fixture@/path",
  "https://api.stripe.com:65536/", "redis://user:fixture@db.example.test:65536/0",
  "https://api.stripe.com\n.example.test/", "https://api.stripe.com\\fixture", "file:///tmp/fixture", "javascript://example.test/",
  "https://fixture.up.railway.app../", " ",
]) test(`rejects malformed relevant endpoint fixture ${JSON.stringify(value)}`, () => {
  assert.deepEqual(validate({ APP_URL: value }, enabled), finding("APP_URL", "INVALID_ENDPOINT"));
});

test("optional unset URL settings and non-URL values do not require Azure endpoints", () => {
  assert.deepEqual(validate({ APP_URL: undefined, MODEL_BASE_URL: null, CONTROL_PLANE_URL: "", PROVIDER_ENABLED: true }, enabled), valid);
});

for (const policy of [
  true, null, [], { enabled: "true" }, { enabled: true, unknown: "fixture" },
  { enabled: true, urlNames: "APP_URL" }, { enabled: true, urlNames: ["not a setting"] },
  ...[null, "https://old.example.test", [42], ["old.example.test"], ["https://user:fixture@old.example.test"],
    ["https://old.example.test/path"], ["https://old.example.test?fixture=1"], ["redis://old.example.test:6379"]]
    .map(legacyOrigins => ({ enabled: true, legacyOrigins })),
]) test(`rejects malformed policy fixture ${JSON.stringify(policy)}`, () => {
  assert.deepEqual(validate({}, policy), { enabled: true, valid: false, findings: [{ code: "POLICY_INVALID" }] });
});

test("diagnostics contain only setting names and codes, including credential-bearing malformed URLs", () => {
  const username = "synthetic-private-user", password = "synthetic-private-password", token = "synthetic-private-token";
  const inputs = [
    `https://${username}:${password}@fixture.up.railway.app:8443/path?token=${token}`,
    `https://${username}:${password}@old.example.test/path?token=${token}`,
    `https://${username}:${password}@old.example.test:999999/path?token=${token}`,
  ];
  const policy = { enabled: true, legacyOrigins: ["https://old.example.test"] };
  for (const value of inputs) {
    const report = validate({ APP_URL: value }, policy);
    assert.equal(report.valid, false);
    const text = JSON.stringify(report);
    for (const privateValue of [value, username, password, token, "old.example.test", "fixture.up.railway.app"]) {
      assert.equal(text.includes(privateValue), false);
    }
  }
  assert.deepEqual(validate({ [`https://${username}:${password}@old.example.test`]: inputs[0] }, enabled),
    { enabled: true, valid: false, findings: [{ code: "CONFIG_INVALID" }] });
});

test("offline CLI emits redacted JSON and correct exit status without environment discovery", () => {
  const script = fileURLToPath(new URL("./azure-only-config.mjs", import.meta.url));
  const run = input => spawnSync(process.execPath, [script], { input, encoding: "utf8", env: {} });
  const clean = run(JSON.stringify({ values: { APP_URL: "https://new.example.test" }, policy: enabled }));
  assert.equal(clean.status, 0);
  assert.deepEqual(JSON.parse(clean.stdout), valid);
  const denied = run(JSON.stringify({ values: { APP_URL: "https://fixture:synthetic-private-password@fixture.up.railway.app" }, policy: enabled }));
  assert.equal(denied.status, 1);
  assert.deepEqual(JSON.parse(denied.stdout), finding("APP_URL", "RAILWAY_HOST"));
  assert.equal((denied.stdout + denied.stderr).includes("synthetic-private-password"), false);
  const malformed = run('{"values":{"APP_URL":"synthetic-private-password"');
  assert.equal(malformed.status, 1);
  assert.equal(malformed.stdout, "");
  assert.deepEqual(JSON.parse(malformed.stderr), { enabled: true, valid: false, findings: [{ code: "INPUT_INVALID" }] });
});
