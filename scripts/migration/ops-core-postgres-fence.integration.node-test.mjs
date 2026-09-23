import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes, randomUUID, X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import pg from "pg";
import { createCutoverJournal, openCutoverCustody } from "./ops-core-custody.mjs";
import { openProviderOperationRecorder } from "./ops-core-provider-operations.mjs";

const IMAGE = "postgres:18.6@sha256:4ef4dbc939d61acea57712655ddb4b4ab27419c913f94cca0cd57cb3ea3c2280";
const LABEL = "corgtex.postgres-fence-test";
const { Client } = pg;

function memoryStores() {
  const intentSha256 = "d".repeat(64);
  let text = JSON.stringify(createCutoverJournal({ domain: "core", intentSha256, evidenceSha256: "e".repeat(64) }));
  let etag = 0;
  let lease = null;
  const records = new Map();
  return { intentSha256, records, blob: {
    async acquire() { assert.equal(lease, null); lease = randomUUID(); return lease; },
    async renew(value) { assert.equal(value, lease); },
    async release(value) { assert.equal(value, lease); lease = null; },
    async read(value) { assert.equal(value, lease); return { text, etag }; },
    async write(next, conditions) {
      assert.equal(conditions.lease, lease); assert.equal(conditions.etag, etag);
      text = next; return { etag: ++etag };
    },
  }, store: {
    async assertPrivate() {},
    async readOptional(key) { return records.get(key) ?? null; },
    async createOnly(key, value) { assert.equal(records.has(key), false); records.set(key, value); },
  } };
}

// Nothing in this fixture resolves a real Vault secret or touches a provider.
// Docker receives a private empty config, exact Unix endpoint, and own resources.
for (const scenario of ["POSTGRES_ROTATE_RUNTIME_PASSWORD", "POSTGRES_TERMINATE_OLD_RUNTIME_SESSION", "TERMINATION_NOT_APPLIED", "TLS_REQUIRED_MUST_REJECT"]) {
const unapplied = scenario === "TERMINATION_NOT_APPLIED";
const lostKind = unapplied ? "POSTGRES_TERMINATE_OLD_RUNTIME_SESSION" : scenario;
test(`PG18 source fence ${scenario}: durable reconciliation without replay`, { timeout: 180_000 }, async () => {
  let stage = "SETUP";
  let directory;
  let containerId;
  let dockerHost;
  let owner;
  let held;
  let admin;
  const runId = randomUUID();
  const recoveryBytes = randomBytes(32);
  const recoveryPassword = recoveryBytes.toString("base64");
  const oldPassword = randomBytes(32).toString("base64");
  const readerPassword = randomBytes(32).toString("base64");
  const docker = (...args) => {
    const result = spawnSync("docker", ["--config", directory, "--host", dockerHost, ...args], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000, maxBuffer: 16 * 1024 * 1024,
    });
    if (result.error || result.status !== 0) throw new Error("LOCAL_DOCKER_COMMAND_FAILED");
    return { stdout: result.stdout.trim(), stderr: result.stderr.trim() };
  };
  const connect = async (config) => {
    const client = new Client({ ...config, ssl: false, connectionTimeoutMillis: 3_000, query_timeout: 10_000 });
    client.on("error", () => {});
    try { await client.connect(); return client; }
    catch (error) { await client.end().catch(() => {}); throw error; }
  };
  try {
    const { runPostgresSourceFence, assertPostgresSourceFenced } = await import("./ops-core-postgres-fence.mjs");
    directory = mkdtempSync(join(tmpdir(), "ops-core-postgres-fence-"));
    try {
      dockerHost = execFileSync("docker", ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"], {
        encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000,
      }).trim();
    } catch { throw new Error("LOCAL_DOCKER_UNAVAILABLE"); }
    assert.match(dockerHost, /^unix:\/\//);
    writeFileSync(join(directory, "config.json"), "{}", { mode: 0o600 });
    const envFile = join(directory, "postgres.env");
    writeFileSync(envFile, `POSTGRES_USER=postgres\nPOSTGRES_PASSWORD=${oldPassword}\nPOSTGRES_DB=railway\nPOSTGRES_INITDB_ARGS=--auth-host=scram-sha-256 --auth-local=trust\n`, { mode: 0o600 });
    containerId = docker("run", "--detach", "--rm", "--name", `corgtex-fence-${runId}`,
      "--label", `${LABEL}=${runId}`, "--env-file", envFile, "--publish", "127.0.0.1::5432", IMAGE,
      "postgres", "-c", "shared_preload_libraries=pg_stat_statements", "-c", "pg_stat_statements.track=all",
      "-c", "log_statement=all", "-c", "debug_print_parse=on", "-c", "log_statement_stats=on",
      "-c", "password_encryption=scram-sha-256").stdout;
    assert.match(containerId, /^[a-f0-9]{64}$/);
    const portBinding = docker("port", containerId, "5432/tcp").stdout;
    assert.match(portBinding, /^127\.0\.0\.1:[0-9]+$/);
    const sourceConfig = { host: "127.0.0.1", port: Number(portBinding.split(":")[1]),
      database: "railway", user: "postgres", password: oldPassword, sslmode: "disable" };
    stage = "STARTUP";
    for (const deadline = Date.now() + 30_000; ;) {
      try { admin = await connect(sourceConfig); break; }
      catch { if (Date.now() > deadline) throw new Error("LOCAL_POSTGRES_UNAVAILABLE"); await delay(250); }
    }
    stage = "SEED";
    const identity = (await admin.query(`SELECT system_identifier::text AS system_identifier,
      (SELECT oid::text FROM pg_database WHERE datname = current_database()) AS database_oid,
      inet_client_addr()::text AS client_address, current_setting('server_version_num')::integer AS version
      FROM pg_control_system()`)).rows[0];
    assert.equal(Math.floor(identity.version / 10000), 18);
    assert.ok(identity.client_address && !["127.0.0.1", "::1"].includes(identity.client_address));
    await admin.query("CREATE EXTENSION pg_stat_statements");
    // Fixture setup also avoids logging its randomly generated reader password.
    await admin.query("SET debug_print_parse = off");
    await admin.query("SET log_statement_stats = off");
    await admin.query("SET log_statement = 'none'");
    await admin.query("SET pg_stat_statements.track = 'none'");
    await admin.query(`CREATE ROLE fence_reader LOGIN PASSWORD '${readerPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
    await admin.query("SET pg_stat_statements.track = 'all'");
    await admin.query("SET log_statement = 'all'");
    await admin.query("SET debug_print_parse = on");
    await admin.query("SET log_statement_stats = on");
    await admin.query(`CREATE TABLE public.retained_lifecycle_fixture (
      id serial PRIMARY KEY, status text NOT NULL, archived_at timestamptz,
      dependency_id integer REFERENCES public.retained_lifecycle_fixture(id));
      INSERT INTO public.retained_lifecycle_fixture (status, archived_at) VALUES ('COMPLETED', '2026-09-01T00:00:00Z');
      INSERT INTO public.retained_lifecycle_fixture (status, dependency_id) VALUES ('PENDING', 1);
      GRANT CONNECT ON DATABASE railway TO fence_reader;
      GRANT USAGE ON SCHEMA public TO fence_reader;
      GRANT SELECT ON public.retained_lifecycle_fixture TO fence_reader;
      GRANT SELECT ON public.retained_lifecycle_fixture_id_seq TO fence_reader`);
    await admin.end(); admin = null;
    const readerConfig = { ...sourceConfig, user: "fence_reader", password: readerPassword };
    let heldClosed = false;
    held = await connect({ ...sourceConfig, database: "postgres" });
    held.on("error", () => { heldClosed = true; });
    held.on("end", () => { heldClosed = true; });
    const heldPid = (await held.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    const stores = memoryStores();
    owner = await openCutoverCustody(stores.blob, stores.intentSha256);
    await owner.begin("SOURCE_FENCED", "f".repeat(64));
    let recorder = await openProviderOperationRecorder({ custody: owner, store: stores.store,
      phase: "SOURCE_FENCED", signal: owner.signal });
    let providerChecks = 0;
    let databaseServiceChecks = 0;
    let lost = false;
    let resumeSessionOperations = [];
    const effects = new Map();
    const operations = () => ({ readIntent: recorder.readIntent,
      runRecordedOperation: (descriptor) => recorder.runRecordedOperation({ ...descriptor, async apply() {
        effects.set(descriptor.kind, (effects.get(descriptor.kind) ?? 0) + 1);
        if (unapplied && !lost && descriptor.kind === lostKind) {
          lost = true;
          resumeSessionOperations = [{ kind: descriptor.kind, input: structuredClone(descriptor.input) }];
          throw new Error("SYNTHETIC_UNACCEPTED_TERMINATION");
        }
        await descriptor.apply();
        if (!lost && descriptor.kind === lostKind) {
          lost = true;
          if (descriptor.kind === "POSTGRES_TERMINATE_OLD_RUNTIME_SESSION") {
            resumeSessionOperations = [{ kind: descriptor.kind, input: structuredClone(descriptor.input) }];
          }
          throw new Error("SYNTHETIC_ACKNOWLEDGEMENT_LOSS");
        }
      } }),
    });
    const retainedSecretVersion = `https://migration-fixture.vault.azure.net/secrets/source-recovery/${"a".repeat(32)}`;
    const opts = () => ({ sourceConfig, readerConfig,
      expected: { domain: "core", connection: { host: sourceConfig.host, port: sourceConfig.port,
        database: "railway", user: "postgres" }, systemIdentifier: identity.system_identifier,
        databaseOid: identity.database_oid, readerRole: "fence_reader", databaseServiceSha256: "b".repeat(64) },
      retainedSecretVersion, vaultName: "migration-fixture", custody: owner, operations: operations(), resumeSessionOperations,
      assertProviderFenced: async () => { providerChecks++; },
      assertDatabaseServiceCustody: async () => { databaseServiceChecks++; },
      resolveSecret: async (version, vault) => {
        assert.equal(version, retainedSecretVersion); assert.equal(vault, "migration-fixture");
        return Buffer.from(recoveryBytes);
      },
    });
    if (scenario === "TLS_REQUIRED_MUST_REJECT") {
      stage = "TLS_REQUIRED";
      const sourceTlsRootCert = readFileSync(new URL("../../infra/azure/migration-foundation/azure-postgres-root-ca.pem", import.meta.url), "utf8");
      assert.equal(new X509Certificate(sourceTlsRootCert).ca, true);
      admin = await connect(sourceConfig);
      assert.equal((await admin.query("SHOW ssl")).rows[0].ssl, "off");
      await admin.end(); admin = null;
      await assert.rejects(runPostgresSourceFence({ ...opts(),
        sourceConfig: { ...sourceConfig, sslmode: "require", sourceTlsRootCert },
        readerConfig: { ...readerConfig, sslmode: "require", sourceTlsRootCert },
      }), { message: "POSTGRES_FENCE_AUTH_PROBE_UNPROVEN" });
      assert.equal(effects.size, 0, "TLS rejection must precede every provider operation");
      assert.equal(stores.records.size, 0, "TLS rejection must precede durable operation intent creation");
      admin = await connect(sourceConfig);
      assert.equal((await admin.query("SELECT session_user AS role")).rows[0].role, "postgres");
      await assert.rejects(connect({ ...sourceConfig, password: recoveryPassword }), { code: "28P01" });
      assert.equal((await held.query("SELECT pg_backend_pid() AS pid")).rows[0].pid, heldPid);
      assert.equal(heldClosed, false);
      assert.equal(owner.snapshot().phase, "PREPARED");
      return;
    }
    stage = "LOST_ACKNOWLEDGEMENT";
    await assert.rejects(runPostgresSourceFence(opts()));
    assert.equal(lost, true, "the selected operation must reach the injected lost acknowledgement");
    assert.equal([...stores.records.keys()].filter(key => key.endsWith("/intent.json")).length,
      [...stores.records.keys()].filter(key => key.endsWith("/receipt.json")).length + 1);
    await owner.close();
    owner = await openCutoverCustody(stores.blob, stores.intentSha256);
    recorder = await openProviderOperationRecorder({ custody: owner, store: stores.store,
      phase: "SOURCE_FENCED", signal: owner.signal });
    stage = "RECOVERY";
    if (unapplied) {
      await assert.rejects(runPostgresSourceFence(opts()), { message: "POSTGRES_FENCE_RECONCILIATION_REQUIRED" });
      assert.equal(effects.get(lostKind), 1, "an inherited intent cannot replay a termination even when the session remains");
      assert.equal((await held.query("SELECT pg_backend_pid() AS pid")).rows[0].pid, heldPid);
      assert.equal(heldClosed, false);
      assert.equal([...stores.records.keys()].filter(key => key.endsWith("/intent.json")).length,
        [...stores.records.keys()].filter(key => key.endsWith("/receipt.json")).length + 1);
      assert.equal(owner.snapshot().phase, "PREPARED");
      return;
    }
    const receipt = await runPostgresSourceFence(opts());
    assert.ok(receipt && typeof receipt === "object");
    await assertPostgresSourceFenced(opts());
    assert.ok(providerChecks > 0 && databaseServiceChecks > 0);
    assert.ok(effects.size > 0);
    assert.ok([...effects.values()].every(value => value === 1), "no provider operation may replay on reopen");
    assert.equal([...stores.records.keys()].filter(key => key.endsWith("/intent.json")).length,
      [...stores.records.keys()].filter(key => key.endsWith("/receipt.json")).length);
    assert.equal(owner.snapshot().phase, "PREPARED", "fence evidence cannot activate any target");
    stage = "AUTHENTICATION_AND_SESSIONS";
    let oldAuthenticationCode;
    try { const stale = await connect(sourceConfig); await stale.end(); }
    catch (error) { oldAuthenticationCode = error.code; }
    assert.equal(oldAuthenticationCode, "28P01");
    admin = await connect({ ...sourceConfig, password: recoveryPassword });
    assert.equal((await admin.query("SELECT count(*)::integer AS count FROM pg_stat_activity WHERE pid=$1", [heldPid])).rows[0].count, 0);
    for (let attempt = 0; attempt < 20 && !heldClosed; attempt++) await delay(25);
    assert.equal(heldClosed, true, "an old superuser session in another database must close");
    const reader = await connect(readerConfig);
    try {
      assert.deepEqual((await reader.query("SELECT status, dependency_id FROM retained_lifecycle_fixture ORDER BY id")).rows,
        [{ status: "COMPLETED", dependency_id: null }, { status: "PENDING", dependency_id: 1 }]);
      await assert.rejects(reader.query("INSERT INTO retained_lifecycle_fixture(status) VALUES ('UNAUTHORIZED')"), { code: "42501" });
      assert.equal((await reader.query("SELECT last_value FROM retained_lifecycle_fixture_id_seq")).rows[0].last_value, "2");
    } finally { await reader.end(); }
    stage = "READ_ONLY_DUMP";
    const dumpEnv = join(directory, "reader.env");
    writeFileSync(dumpEnv, `PGHOST=127.0.0.1\nPGPORT=5432\nPGDATABASE=railway\nPGUSER=fence_reader\nPGPASSWORD=${readerPassword}\n`, { mode: 0o600 });
    docker("exec", "--env-file", dumpEnv, containerId, "pg_dump", "--format=custom", "--file=/tmp/fence-reader.dump");
    const toc = docker("exec", containerId, "pg_restore", "--list", "/tmp/fence-reader.dump").stdout;
    assert.ok(toc.includes("TABLE DATA public retained_lifecycle_fixture"));
    assert.ok(toc.includes("SEQUENCE SET public retained_lifecycle_fixture_id_seq"));
    stage = "LOGGING_SUPPRESSION";
    const verifier = (await admin.query("SELECT rolpassword FROM pg_authid WHERE rolname='postgres'")).rows[0].rolpassword;
    assert.ok(verifier.startsWith("SCRAM-SHA-256$"));
    const statements = (await admin.query("SELECT query FROM pg_stat_statements")).rows.map(row => row.query).join("\n");
    const logs = docker("logs", containerId);
    for (const text of [statements, logs.stdout, logs.stderr, JSON.stringify(receipt), ...stores.records.values()]) {
      for (const password of [recoveryPassword, oldPassword, readerPassword]) {
        assert.equal(text.includes(password), false, "plaintext passwords must remain absent");
      }
      assert.equal(text.includes(verifier), false, "SCRAM verifier must remain absent");
    }
    assert.ok(logs.stdout.includes("SELECT") || logs.stderr.includes("SELECT"), "statement logging must actually be enabled");
    assert.ok(statements.includes("retained_lifecycle_fixture"), "statement tracking must actually be enabled");
  } catch (error) {
    const diagnostic = /^[A-Z][A-Z0-9_]{2,100}$/.test(error?.message ?? "") ? error.message
      : /^[0-9A-Z]{5}$/.test(error?.code ?? "") ? error.code : "ASSERTION_OR_OPERATION_FAILED";
    // Do not attach a cause: pg and Docker errors can contain SQL, argv or env.
    throw new Error(`LOCAL_POSTGRES_FENCE_${stage}_${diagnostic}`);
  } finally {
    await admin?.end().catch(() => {});
    await held?.end().catch(() => {});
    recoveryBytes.fill(0);
    try {
      await owner?.close();
    } finally {
      try {
        if (containerId) {
          const inspected = JSON.parse(docker("inspect", containerId).stdout);
          assert.equal(inspected.length, 1);
          assert.equal(inspected[0]?.Id, containerId);
          assert.equal(inspected[0]?.Name, `/corgtex-fence-${runId}`);
          assert.equal(inspected[0]?.Config?.Labels?.[LABEL], runId);
          docker("stop", containerId);
          for (const deadline = Date.now() + 5_000; ;) {
            if (!docker("ps", "--all", "--filter", `label=${LABEL}=${runId}`, "--format", "{{.ID}}").stdout) break;
            if (Date.now() > deadline) throw new Error("LOCAL_POSTGRES_OWNED_CONTAINER_REMOVAL_UNPROVEN");
            await delay(100);
          }
        }
      } finally {
        if (directory) rmSync(directory, { recursive: true });
      }
    }
  }
});
}
