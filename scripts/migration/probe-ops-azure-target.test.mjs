import { test } from "vitest";
import assert from "node:assert/strict";
import { RESOURCE, HOST, SQL, OPTIONS, connectionConfig, capture, sanitize } from "./probe-ops-azure-target.mjs";

const posture = (isolation) => ({ default_ro: "on", ro: "on", isolation, statement_timeout: "5s",
  lock_timeout: "1s", idle_timeout: "15s", transaction_timeout: "1min", search_path: "pg_catalog",
  row_security: "on", database_ok: true, user_ok: true });
const rows = {
  settings: [{ version: 180006, encoding: "UTF8", provider: "c", collation: "en_US.utf8", ctype: "en_US.utf8", recorded: "2.41", actual: "2.41" }],
  collations: [{ provider: "c", collation: "en_US.utf8", ctype: "en_US.utf8", deterministic: true, recorded: "2.41", actual: "2.41" }],
  vector: [{ name: "vector", version: "0.8.2", installed: false }],
  installed: [{ name: "plpgsql", version: "1.0", schema: "pg_catalog" }],
  capacity: [{ max_connections: 100, reserved_connections: 5, superuser_reserved_connections: 10, vector_allowlisted: true }],
};
function mock(change = {}) {
  const calls = []; let inside = false;
  return { calls, ended: false, destroyed: false,
    connection: { stream: { destroy() { calls.push("DESTROY"); } } },
    async connect() { calls.push("CONNECT"); if (change.connectError) throw change.connectError; },
    async query(sql) {
      calls.push(sql);
      if (sql.startsWith("BEGIN")) { inside = true; return { command: "BEGIN" }; }
      if (sql === "ROLLBACK") { if (change.rollbackError) throw Error("synthetic raw password"); return { command: change.rollbackAck ?? "ROLLBACK" }; }
      if (sql === SQL.guard) return { rows: [{ ...posture(inside ? "repeatable read" : "read committed"), ...change.guard }] };
      const key = Object.keys(SQL).find((k) => SQL[k] === sql);
      assert.ok(key, "Only static SQL may execute");
      if (change.queryError) throw change.queryError;
      return { rows: structuredClone(change[key] ?? rows[key]) };
    },
    async end() { this.ended = true; calls.push("END"); if (change.hangEnd) await new Promise(() => {}); },
  };
}
const env = { TARGET_POSTGRES_RESOURCE_ID: RESOURCE, TARGET_POSTGRES_HOST: HOST,
  TARGET_POSTGRES_ADMIN_USER: "corgtexadmin", TARGET_POSTGRES_ADMIN_PASSWORD: "synthetic-only" };

test("actual runner builds verified TLS with pinned root bundle and fixed DB", async () => {
  const c = await connectionConfig(env);
  assert.equal(c.host, HOST); assert.equal(c.port, 5432); assert.equal(c.database, "postgres");
  assert.equal(c.ssl.rejectUnauthorized, true); assert.equal(c.ssl.checkServerIdentity, undefined);
  assert.match(c.ssl.ca, /BEGIN CERTIFICATE/u); assert.equal(c.options, OPTIONS);
  assert.equal(c.connectionTimeoutMillis, 5000); assert.equal(c.query_timeout, 5000);
});
for (const [name, edit] of Object.entries({ resource: { TARGET_POSTGRES_RESOURCE_ID: "wrong" },
  host: { TARGET_POSTGRES_HOST: "wrong" }, user: { TARGET_POSTGRES_ADMIN_USER: "wrong" },
  port: { TARGET_POSTGRES_PORT: "5433" }, missingCredential: { TARGET_POSTGRES_ADMIN_PASSWORD: "" },
  tlsDisabled: { NODE_TLS_REJECT_UNAUTHORIZED: "0" } })) {
  test(`reject ${name} before connecting`, async () => { await assert.rejects(connectionConfig({ ...env, ...edit })); });
}
test("success is metadata only with explicit rollback then disconnect", async () => {
  const c = mock(), r = await capture(c);
  assert.equal(r.status, "TARGET_METADATA_CAPTURED"); assert.equal(r.rollback, true); assert.equal(r.disconnected, true);
  assert.equal(r.ordinaryConnectionSlots, 85); assert.equal(r.comparison.sourceLocaleAvailable, true);
  assert.equal(r.productionAccepted, false); assert.deepEqual(c.calls.slice(-2), ["ROLLBACK", "END"]);
  assert.equal(r.metadata.vector[0].installed, false);
});
for (const [name, value] of Object.entries({ default_ro: "off", ro: "off", transaction_timeout: "0",
  statement_timeout: "0", database_ok: false, user_ok: false })) {
  test(`guard rejects ${name} without metadata queries`, async () => {
    const c = mock({ guard: { [name]: value } });
    await assert.rejects(capture(c), { code: "READONLY_GUARD_FAILED" });
    assert.equal(c.calls.includes(SQL.settings), false); assert.equal(c.ended, true);
  });
}
test("oversize and cardinality fail with disconnect", async () => {
  for (const edit of [{ collations: Array(11).fill({}) }, { settings: [{ text: "x".repeat(16385) }] }, { settings: [] }]) {
    const c = mock(edit); await assert.rejects(capture(c)); assert.equal(c.ended, true);
  }
});
test("mismatched platform metadata is captured without false compatibility", async () => {
  const c = mock({ settings: [{ version: 180005 }], collations: [], vector: [], capacity: [{ ...rows.capacity[0], vector_allowlisted: false }] });
  const r = await capture(c); assert.deepEqual(Object.values(r.comparison), [false, false, false, false]);
});
test("query/connection/TLS failures do not leak message or create success", async () => {
  for (const edit of [{ connectError: Error("synthetic credential TLS failure") }, { queryError: Object.assign(Error("synthetic raw SQL password"), { code: "42501" }) }]) {
    const c = mock(edit); let e; try { await capture(c); } catch (error) { e = error; }
    assert.ok(e); assert.equal(c.ended, true);
    assert.equal(JSON.stringify(sanitize(e)).includes("synthetic"), false);
  }
});
test("rollback failure is never recorded as success", async () => { await assert.rejects(capture(mock({ rollbackError: true }))); });
test("wrong rollback command cannot become a cleanup receipt", async () => { await assert.rejects(capture(mock({ rollbackAck: "COMMIT" })), { code: "ROLLBACK_UNPROVEN" }); });
test("deadline destroys connection and closes without retry", async () => {
  const c = mock(); c.connect = async () => { await new Promise(() => {}); };
  await assert.rejects(capture(c, { deadlineMs: 5 }), { code: "DEADLINE" });
  assert.equal(c.calls.includes("DESTROY"), true); assert.equal(c.ended, true);
});
test("hung disconnect is bounded and destroys socket", async () => {
  const c = mock({ hangEnd: true }); await assert.rejects(capture(c, { closeMs: 5 }), { code: "DISCONNECT_TIMEOUT" });
  assert.equal(c.calls.includes("DESTROY"), true);
});
test("late connection resolution after deadline cannot issue SQL", async () => {
  const c = mock(); let resolveConnect;
  c.connect = () => new Promise((resolve) => { resolveConnect = resolve; });
  await assert.rejects(capture(c, { deadlineMs: 5 }), { code: "DEADLINE" });
  resolveConnect(); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(c.calls.includes(SQL.guard), false);
});
test("query scope is catalog only, no full restore or mutation", () => {
  for (const sql of Object.values(SQL)) {
    assert.match(sql, /^SELECT /u);
    assert.doesNotMatch(sql, /\b(?:CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|GRANT|REVOKE|COPY|pg_dump|_prisma_migrations)\b/iu);
  }
});
