import { test } from "vitest";
import assert from "node:assert/strict";
import { ACCESS_SQL, captureSharedPostgresAccess } from "./probe-shared-postgres-access.mjs";
import { HOST, RESOURCE, SQL as metadataSql } from "./probe-ops-azure-target.mjs";

const databases = ["azure_maintenance", "azure_sys", "corgtex", "postgres"].map((name, index) => ({
  name, oid: String(100 + index), owner: "corgtexadmin", allowConnections: true,
  isTemplate: false, ownerAuthority: name === "postgres" || name === "corgtex",
  acl: [{ grantor: "10", grantee: "0", privilege: "CONNECT", grantable: false }],
}));
const hooks = ["local_preload_libraries", "session_preload_libraries", "shared_preload_libraries"]
  .map(name => ({ name, setting: "" }));
const posture = isolation => ({ default_ro: "on", ro: "on", isolation, statement_timeout: "5s",
  lock_timeout: "1s", idle_timeout: "15s", transaction_timeout: "1min", search_path: "pg_catalog",
  row_security: "on", database_ok: true, user_ok: true });

function client({ deniedSetting, catalogError } = {}) {
  const calls = []; let inside = false;
  return { calls, ended: false, connection: { stream: { destroy() { calls.push("DESTROY"); } } },
    async connect() { calls.push("CONNECT"); },
    async query(sql, values) {
      calls.push([sql, values]);
      if (sql === metadataSql.guard) return { rows: [posture(inside ? "repeatable read" : "read committed")] };
      if (sql.startsWith("BEGIN")) { inside = true; return { command: "BEGIN" }; }
      if (sql === "ROLLBACK") { inside = false; return { command: "ROLLBACK" }; }
      if (sql.startsWith("SAVEPOINT") || sql.startsWith("ROLLBACK TO") || sql.startsWith("RELEASE")) return { command: sql.split(" ")[0] };
      if (sql === ACCESS_SQL.databases) return { rows: databases };
      if (sql === ACCESS_SQL.roles) {
        if (catalogError) throw Error("synthetic raw catalog error");
        return { rows: [{ oid: "10", name: "corgtexadmin", createRole: true }] };
      }
      if (sql === ACCESS_SQL.memberships) return { rows: [] };
      if (sql === ACCESS_SQL.hooks) return { rows: hooks };
      if (sql === "SELECT pg_catalog.set_config($1,$2,true)") {
        if (values[0] === deniedSetting) throw Object.assign(Error("synthetic raw provider error"), { code: "42501" });
        return { rows: [{ set_config: values[1] }] };
      }
      if (sql === "SELECT pg_catalog.current_setting($1) AS value") {
        const setting = calls.slice().reverse().find(([text]) => text === "SELECT pg_catalog.set_config($1,$2,true)");
        return { rows: [{ value: setting[1][1] }] };
      }
      throw Error("unexpected SQL");
    },
    async end() { this.ended = true; calls.push("END"); },
  };
}

test("captures bounded actual database ACLs and GUC privileges with rollback and disconnect", async () => {
  const c = client(), receipt = await captureSharedPostgresAccess(c);
  assert.equal(receipt.status, "SHARED_POSTGRES_ACCESS_CAPTURED");
  assert.equal(receipt.resource, RESOURCE); assert.equal(receipt.host, HOST);
  assert.equal(receipt.admissionReady, false);
  assert.equal(receipt.databases.length, 4);
  assert.equal(receipt.settingResults.every(row => row.accepted), true);
  assert.equal(receipt.inventories.core.databases.length, 4);
  assert.equal(receipt.inventories.ops.databases.length, 4);
  assert.equal(receipt.rollback, true); assert.equal(c.ended, true);
  assert.equal(c.calls.at(-2)[0], "ROLLBACK"); assert.equal(c.calls.at(-1), "END");
});

test("a denied Azure session setting is retained without hiding the remaining catalog", async () => {
  const c = client({ deniedSetting: "track_activities" });
  const receipt = await captureSharedPostgresAccess(c);
  assert.deepEqual(receipt.settingResults.filter(row => !row.accepted),
    [{ name: "track_activities", accepted: false, sqlState: "42501" }]);
  assert.equal(c.calls.some(([sql]) => sql === "ROLLBACK TO SAVEPOINT access_setting"), true);
  assert.equal(c.ended, true);
  assert.equal(JSON.stringify(receipt).includes("synthetic raw"), false);
});

test("catalog failure cannot produce admission receipt and closes the connection", async () => {
  const c = client({ catalogError: true });
  await assert.rejects(captureSharedPostgresAccess(c));
  assert.equal(c.ended, true);
});
