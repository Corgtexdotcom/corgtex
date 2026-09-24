import test from "node:test";
import assert from "node:assert/strict";
import { redisGateBindingSha256 } from "./ops-core-redis-gate.mjs";
import { randomBytes } from "node:crypto";
import { assertOpsCorePostgresStateEmpty, POSTGRES_SHARED_STATE_MIGRATION } from "./ops-core-postgres-state-gate.mjs";

function fixture(change = {}) {
  const controller = new AbortController();
  const state = { connects: 0, ends: 0, redisEnds: 0, scans: 0, queries: [], configs: [], guards: 0 };
  const journal = { domain: "core", intentSha256: "a".repeat(64), phase: "RESTORED", destinationMayHaveWritten: false,
    pending: { operationId: "owned-operation", to: "VERIFIED", intentSha256: "b".repeat(64) },
    history: [{ phase: "SOURCE_FENCED", evidenceSha256: "c".repeat(64) }] };
  const schema = [
    ["PendingTranscriptUpload", [["id", "text"], ["workspaceId", "text"], ["encryptedPayload", "text"], ["expiresAt", "timestamp(3) without time zone"], ["createdAt", "timestamp(3) without time zone"]]],
    ["SharedCacheEntry", [["id", "text"], ["encryptedPayload", "text"], ["expiresAt", "timestamp(3) without time zone"]]],
    ["SharedCacheVersion", [["id", "text"], ["version", "integer"]]],
    ["SharedRateLimit", [["id", "text"], ["timestamps", "bigint[]"], ["expiresAt", "timestamp(3) without time zone"]]],
  ].flatMap(([table, fields]) => fields.map(([column, type]) => ({ table_name: table, relkind: "r", row_security: false,
    column_name: column, data_type: type, not_null: true })));
  const identity = { database: "corgtex_core", oid: "16401", session_user: "admin", role_user: "admin", version_num: 180006,
    read_only: "on", tls: true, tls_version: "TLSv1.3" };
  const options = {
    sourceRedis: { mode: "standalone", resourceId: null, server: { version: "8.2.9", runId: "d".repeat(40) },
      connection: { host: "source.local", port: 6379, database: 0, username: "default", tls: false } },
    sourceCredentials: { password: randomBytes(24).toString("base64"), tlsCa: null },
    targetAdminConfig: { host: "synthetic.postgres.database.azure.com", port: 5432, user: "admin", database: "postgres",
      password: randomBytes(24).toString("base64"), sslmode: "verify-full", targetTlsRootCert: "synthetic-certificate" },
    targetDatabaseOid: "16401", targetBindingSha256: "e".repeat(64),
    custody: { signal: controller.signal, snapshot: () => structuredClone(journal), async assertOwned() {} },
    async assertSourceFenced() { state.guards++; change.guard?.(state, journal, controller);
      return { complete: true, domain: "core", intentSha256: "a".repeat(64), sourceFenceSha256: "c".repeat(64) }; },
    async assertSourceRedisBound() { return { complete: true, domain: "core", intentSha256: "a".repeat(64),
      sourceFenceSha256: "c".repeat(64), bindingSha256: redisGateBindingSha256(options.sourceRedis), runtimeBaselineSha256: "f".repeat(64) }; },
    async assertTargetInactive() { return { complete: true, domain: "core", intentSha256: "a".repeat(64), targetBindingSha256: "e".repeat(64) }; },
    createRedisClient() { return { isOpen: false, on() {}, async connect() {}, destroy() { state.redisEnds++; },
      async sendCommand(args) {
        if (args[0] === "INFO") return `redis_version:8.2.9\nrun_id:${"d".repeat(40)}\nredis_mode:standalone\n`;
        if (args[0] === "ROLE") return ["master", 0, []];
        if (args[0] === "DBSIZE") return change.nonemptySize ? 1 : 0;
        if (args[0] === "SCAN") { state.scans++; return ["0", change.nonemptyScan === state.scans ? ["synthetic-private-key"] : []]; }
        throw new Error("Unexpected Redis command");
      } }; },
    createPostgresClient(config) { state.configs.push(config); return {
      async connect() { state.connects++; }, async end() { state.ends++; },
      async query(sql, values) {
        state.queries.push(sql); change.query?.(sql, state, journal, controller);
        if (change.hang && sql.includes("current_database")) return new Promise(() => {});
        if (sql.startsWith("BEGIN") || sql === "COMMIT") return { rows: [] };
        if (sql.includes("current_database")) return { rows: [{ ...identity, ...change.identity }] };
        if (sql.includes("_prisma_migrations")) {
          assert.deepEqual(values, [POSTGRES_SHARED_STATE_MIGRATION]);
          return { rows: change.migrationMissing ? [] : [{ migration_name: POSTGRES_SHARED_STATE_MIGRATION, finished: !change.migrationIncomplete, active: true }] };
        }
        if (sql.includes("pg_catalog.pg_class")) return { rows: change.schema ? change.schema(structuredClone(schema)) : schema };
        if (sql.startsWith("SELECT count")) return { rows: [{ count: change.nonemptyTarget ? "1" : "0" }] };
        throw new Error("Unexpected PostgreSQL statement");
      },
    }; },
  };
  return { options, state, journal, controller };
}

test("brackets readonly target proof with fresh source scans and verifies the target twice", async () => {
  const f = fixture();
  const receipt = await assertOpsCorePostgresStateEmpty(f.options);
  assert.equal(receipt.status, "POSTGRES_SHARED_STATE_ACCEPTED");
  assert.equal(receipt.target.database, "corgtex_core");
  assert.equal(receipt.target.databaseOid, "16401");
  assert.deepEqual(Object.values(receipt.target.counts), [0, 0, 0, 0]);
  assert.equal(f.state.scans, 2); assert.equal(f.state.redisEnds, 2); assert.equal(f.state.ends, 1);
  assert.equal(f.state.configs[0].database, "corgtex_core");
  assert.equal(f.state.configs[0].ssl.rejectUnauthorized, true);
  assert.equal(f.state.configs[0].statement_timeout, 30000);
  assert.match(f.state.configs[0].options, /default_transaction_read_only=on/);
  assert.equal(f.state.queries.filter(sql => sql.startsWith("BEGIN")).length, 2);
  assert.equal(f.state.queries.every(sql => /^(SELECT|BEGIN|COMMIT)/.test(sql)), true);
  assert.equal(JSON.stringify(receipt).includes(f.options.targetAdminConfig.password), false);
});

for (const scan of [1, 2]) test(`source key on scan ${scan} blocks acceptance`, async () => {
  const f = fixture({ nonemptyScan: scan });
  await assert.rejects(assertOpsCorePostgresStateEmpty(f.options), { code: "REDIS_SOURCE_NOT_EMPTY" });
  assert.equal(f.state.connects, scan === 1 ? 0 : 1);
  assert.equal(f.state.ends, scan === 1 ? 0 : 1);
});

for (const [name, change, code] of [
  ["wrong database", { identity: { database: "postgres" } }, "DATABASE_UNPROVEN"],
  ["wrong restored OID", { identity: { oid: "99999" } }, "DATABASE_UNPROVEN"],
  ["unprotected session", { identity: { read_only: "off" } }, "DATABASE_UNPROVEN"],
  ["TLS disabled", { identity: { tls: false } }, "DATABASE_UNPROVEN"],
  ["old PostgreSQL", { identity: { version_num: 170000 } }, "DATABASE_UNPROVEN"],
  ["missing migration", { migrationMissing: true }, "MIGRATION_UNPROVEN"],
  ["incomplete migration", { migrationIncomplete: true }, "MIGRATION_UNPROVEN"],
  ["missing table", { schema: rows => rows.filter(row => row.table_name !== "SharedCacheVersion") }, "SCHEMA_UNPROVEN"],
  ["wrong column type", { schema: rows => rows.map((row, i) => i === 0 ? { ...row, data_type: "integer" } : row) }, "SCHEMA_UNPROVEN"],
  ["RLS hiding rows", { schema: rows => rows.map(row => ({ ...row, row_security: true })) }, "SCHEMA_UNPROVEN"],
  ["nonempty target", { nonemptyTarget: true }, "TARGET_NOT_EMPTY"],
]) test(`rejects ${name} and closes the session`, async () => {
  const f = fixture(change);
  await assert.rejects(assertOpsCorePostgresStateEmpty(f.options), { code: `POSTGRES_STATE_${code}` });
  assert.equal(f.state.ends, 1);
});

test("rejects missing source fence, activation, and unsupported Enterprise source before network work", async () => {
  for (const variant of ["fence", "activation", "enterprise"]) {
    const f = fixture();
    if (variant === "fence") f.journal.history = [];
    if (variant === "activation") f.journal.destinationMayHaveWritten = true;
    if (variant === "enterprise") {
      f.options.sourceRedis.mode = "azure-enterprise-proxy";
      f.options.sourceRedis.resourceId = "/subscriptions/00000000-0000-4000-8000-000000000001/resourceGroups/synthetic/providers/Microsoft.Cache/redisEnterprise/synthetic/databases/default";
      f.options.sourceRedis.connection.tls = true;
    }
    await assert.rejects(assertOpsCorePostgresStateEmpty(f.options), { code: variant === "enterprise" ? "POSTGRES_STATE_SOURCE_ENTERPRISE_UNPROVEN" : "POSTGRES_STATE_SOURCE_FENCE_REQUIRED" });
    assert.equal(f.state.scans, 0); assert.equal(f.state.connects, 0);
  }
});

test("rejects custody mutation during a guard before scanning", async () => {
  const f = fixture({ guard(state, journal) { if (state.guards === 1) journal.pending.intentSha256 = "f".repeat(64); } });
  await assert.rejects(assertOpsCorePostgresStateEmpty(f.options), { code: "POSTGRES_STATE_CUSTODY_CHANGED" });
  assert.equal(f.state.scans, 0);
});

test("rejects target activation after PostgreSQL reads", async () => {
  const f = fixture();
  f.options.assertTargetInactive = async () => ({ complete: f.state.queries.length === 0,
    domain: "core", intentSha256: "a".repeat(64), targetBindingSha256: "e".repeat(64) });
  await assert.rejects(assertOpsCorePostgresStateEmpty(f.options), { code: "POSTGRES_STATE_TARGET_ACTIVE" });
  assert.equal(f.state.ends, 1);
});

test("abort and hanging query timeout cannot produce acceptance or leak the client", async () => {
  const early = fixture(); early.controller.abort();
  await assert.rejects(assertOpsCorePostgresStateEmpty(early.options), { code: "POSTGRES_STATE_ABORTED" });
  assert.equal(early.state.connects, 0);
  const later = fixture({ query(sql, state, journal, controller) { if (sql.includes("current_database")) controller.abort(); } });
  await assert.rejects(assertOpsCorePostgresStateEmpty(later.options), { code: "POSTGRES_STATE_ABORTED" });
  assert.equal(later.state.ends, 1);
  const hanging = fixture({ hang: true }); hanging.options.timeoutMs = 20;
  await assert.rejects(assertOpsCorePostgresStateEmpty(hanging.options), { code: "POSTGRES_STATE_READ_TIMEOUT" });
  assert.equal(hanging.state.ends, 1);
});


test("an unrelated empty Redis cannot bypass the live source runtime binding proof", async () => {
  const f = fixture(); f.options.assertSourceRedisBound = async () => ({ complete: true, domain: "core", intentSha256: "a".repeat(64),
    sourceFenceSha256: "c".repeat(64), bindingSha256: "0".repeat(64), runtimeBaselineSha256: "f".repeat(64) });
  await assert.rejects(assertOpsCorePostgresStateEmpty(f.options), { code: "POSTGRES_STATE_SOURCE_RUNTIME_UNPROVEN" });
  assert.equal(f.state.scans, 0); assert.equal(f.state.connects, 0);
});
