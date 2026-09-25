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

function client({ deniedSetting, catalogError, database = "postgres", providerViewError,
  relationName = "runtime_stats" } = {}) {
  const calls = []; let inside = false;
  return { calls, ended: false, connection: { stream: { destroy() { calls.push("DESTROY"); } } },
    async connect() { calls.push("CONNECT"); },
    async query(sql, values) {
      calls.push([sql, values]);
      if (sql === metadataSql.guard || sql === ACCESS_SQL.providerGuard)
        return { rows: [posture(inside ? "repeatable read" : "read committed")] };
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
      if (sql === ACCESS_SQL.effectiveSettings) return { rows: [{ name: "pg_qs.query_capture_mode", setting: "none",
        source: "default", context: "sighup", pendingRestart: false }] };
      if (sql === ACCESS_SQL.providerSchemas) return { rows: [{ name: database === "azure_sys" ? "query_store" : "public",
        oid: "300", owner: "azuresu", publicUsage: database === "azure_sys", publicCreate: false }] };
      if (sql === ACCESS_SQL.providerPublicRelations) return { rows: database === "azure_sys" ? [
        { schema: "query_store", name: "qs_view", kind: "v", grantScope: "relation", column: null, privilege: "SELECT" },
        { schema: "query_store", name: "qs_view", kind: "v", grantScope: "column", column: "id", privilege: "SELECT" },
        { schema: "query_store", name: relationName, kind: "r", grantScope: "relation", column: null, privilege: "SELECT" },
        { schema: "query_store", name: "column_only", kind: "r", grantScope: "column", column: "id", privilege: "SELECT" },
      ] : [] };
      if (sql === ACCESS_SQL.providerPublicDefiners) return { rows: [] };
      if (sql === ACCESS_SQL.providerPublicFunctions) return { rows: database === "azure_sys" ? [
        { schema: "query_store", name: "qs_reset", oid: "400", securityDefiner: false, kind: "f" },
      ] : [] };
      if (sql === ACCESS_SQL.providerRelation) return { rows: [{ relation: values[0] }] };
      if (sql.startsWith('SELECT EXISTS(SELECT 1 FROM "query_store"."')) {
        if (providerViewError) throw Object.assign(Error("synthetic provider relation denied"), { code: "42501" });
        return { rows: [{ hasRows: sql.includes('"runtime_stats"') || sql.includes('"column_only"') }] };
      }
      if (sql.startsWith("SELECT EXISTS(SELECT 1 FROM query_store.")) {
        if (providerViewError) throw Object.assign(Error("synthetic provider view denied"), { code: "42501" });
        return { rows: [{ hasRows: sql.includes("query_texts_view") }] };
      }
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
  const c = client(), providers = [];
  const receipt = await captureSharedPostgresAccess(c, { providerClientFactory: database => {
    const provider = client({ database }); providers.push(provider); return provider;
  }, azureParameters: [{ name: "pg_qs.query_capture_mode", value: "none", allowedValues: "none,top,all",
    readOnly: false, dynamic: true }] });
  assert.equal(receipt.status, "SHARED_POSTGRES_ACCESS_CAPTURED");
  assert.equal(receipt.resource, RESOURCE); assert.equal(receipt.host, HOST);
  assert.equal(receipt.admissionReady, false);
  assert.equal(receipt.databases.length, 4);
  assert.equal(receipt.settingResults.every(row => row.accepted), true);
  assert.equal(receipt.effectiveSettings[0].setting, "none");
  assert.equal(receipt.azureParameters[0].value, "none");
  assert.equal(receipt.azureParameters[0].dynamic, true);
  assert.equal(receipt.providerDatabases.length, 3);
  const azureSys = receipt.providerDatabases.find(row => row.name === "azure_sys");
  assert.equal(azureSys.queryStore[0].hasRows, true);
  assert.equal(azureSys.schemas[0].publicUsage, true);
  assert.deepEqual(azureSys.publicRelations.find(row => row.name === "column_only"),
    { schema: "query_store", name: "column_only", kind: "r", grantScope: "column", column: "id", privilege: "SELECT" });
  assert.deepEqual(azureSys.publicRelationRows.map(row => [row.name, row.hasRows]),
    [["qs_view", false], ["runtime_stats", true], ["column_only", true]]);
  assert.equal(azureSys.publicFunctions[0].name, "qs_reset");
  assert.equal(providers.every(provider => provider.ended && provider.calls.some(([sql]) => sql === "ROLLBACK")), true);
  assert.equal(receipt.inventories.core.databases.length, 4);
  assert.equal(receipt.inventories.ops.databases.length, 4);
  assert.equal(receipt.rollback, true); assert.equal(c.ended, true);
  assert.equal(c.calls.at(-2)[0], "ROLLBACK"); assert.equal(c.calls.at(-1), "END");
});

test("a denied Azure session setting is retained without hiding the remaining catalog", async () => {
  const c = client({ deniedSetting: "track_activities" });
  const receipt = await captureSharedPostgresAccess(c, { providerClientFactory: database => client({ database }) });
  assert.deepEqual(receipt.settingResults.filter(row => !row.accepted),
    [{ name: "track_activities", accepted: false, sqlState: "42501" }]);
  assert.equal(c.calls.some(([sql]) => sql === "ROLLBACK TO SAVEPOINT access_setting"), true);
  assert.equal(c.ended, true);
  assert.equal(JSON.stringify(receipt).includes("synthetic raw"), false);
});

test("catalog failure cannot produce admission receipt and closes the connection", async () => {
  const c = client({ catalogError: true });
  await assert.rejects(captureSharedPostgresAccess(c, { providerClientFactory: database => client({ database }) }));
  assert.equal(c.ended, true);
});

test("provider Query Store denial is recorded without exporting query text", async () => {
  const c = client();
  const receipt = await captureSharedPostgresAccess(c, { providerClientFactory: database =>
    client({ database, providerViewError: database === "azure_sys" }) });
  const store = receipt.providerDatabases.find(row => row.name === "azure_sys").queryStore;
  assert.equal(store.every(row => row.present && !row.readable && row.hasRows === null && row.sqlState === "42501"), true);
  const publicRows = receipt.providerDatabases.find(row => row.name === "azure_sys").publicRelationRows;
  assert.equal(publicRows.every(row => !row.administratorRead && row.hasRows === null && row.sqlState === "42501"), true);
  assert.equal(JSON.stringify(receipt).includes("synthetic provider view denied"), false);
  assert.equal(JSON.stringify(receipt).includes("synthetic provider relation denied"), false);
  assert.equal(receipt.admissionReady, false);
});

test("provider catalog names are quoted as identifiers before the bounded row check", async () => {
  const c = client(), providers = [];
  const receipt = await captureSharedPostgresAccess(c, { providerClientFactory: database => {
    const provider = client({ database, relationName: 'runtime"stats' }); providers.push(provider); return provider;
  } });
  const azureSys = providers.find(provider => provider.calls.some(([sql, values]) =>
    sql === ACCESS_SQL.providerGuard && values?.[0] === "azure_sys"));
  assert.ok(azureSys.calls.some(([sql]) => sql ===
    'SELECT EXISTS(SELECT 1 FROM "query_store"."runtime""stats" LIMIT 1) AS "hasRows"'));
  assert.equal(receipt.providerDatabases.find(row => row.name === "azure_sys").publicRelationRows[1].name,
    'runtime"stats');
});
