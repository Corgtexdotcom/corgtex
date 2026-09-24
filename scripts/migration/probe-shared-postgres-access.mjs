// Catalog-only admission probe for the existing PG18 server. The owning
// qualification workflow controls its stopped baseline, temporary IP and cleanup.
import { DATABASE_SQL, RUNTIME_ACCESS_SENSITIVE_SETTINGS,
  postgresRuntimeAccessIsolationInventory } from "./ops-core-postgres-runtime-access.mjs";
import { HOST, RESOURCE, ProbeError, SQL as metadataSql, guard } from "./probe-ops-azure-target.mjs";

const check = (value, code) => { if (!value) throw new ProbeError(code); };
export const ACCESS_SQL = Object.freeze({
  databases: DATABASE_SQL,
  roles: `SELECT oid::text AS oid,rolname AS name,rolsuper AS superuser,
    rolcreatedb AS "createDb",rolcreaterole AS "createRole",rolcanlogin AS login,
    rolreplication AS replication,rolbypassrls AS "bypassRls"
    FROM pg_catalog.pg_roles ORDER BY rolname`,
  memberships: `SELECT roleid::text AS "roleOid",member::text AS "memberOid",
    grantor::text AS "grantorOid",admin_option AS "adminOption",
    inherit_option AS "inheritOption",set_option AS "setOption"
    FROM pg_catalog.pg_auth_members ORDER BY roleid,member,grantor`,
  hooks: `SELECT name,setting FROM pg_catalog.pg_settings
    WHERE name IN ('shared_preload_libraries','session_preload_libraries','local_preload_libraries')
    ORDER BY name`,
});

const boundedRows = (rows, maxRows, maxBytes) => {
  check(Array.isArray(rows) && rows.length <= maxRows
    && Buffer.byteLength(JSON.stringify(rows)) <= maxBytes, "ACCESS_CATALOG_LIMIT");
  return rows;
};

export async function captureSharedPostgresAccess(client, { deadlineMs = 120000, closeMs = 3000 } = {}) {
  let timer, closeTimer, expired = false, began = false, rolledBack = false, disconnected = false;
  const query = async (sql, values) => {
    check(!expired, "ACCESS_DEADLINE");
    const result = await client.query(sql, values);
    check(!expired, "ACCESS_DEADLINE");
    return result;
  };
  const work = async () => {
    await client.connect();
    guard((await query(metadataSql.guard)).rows[0], "read committed");
    check((await query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")).command === "BEGIN", "ACCESS_BEGIN_UNPROVEN");
    began = true;
    guard((await query(metadataSql.guard)).rows[0], "repeatable read");
    const databases = boundedRows((await query(ACCESS_SQL.databases)).rows, 1000, 65000);
    const roles = boundedRows((await query(ACCESS_SQL.roles)).rows, 10000, 65000);
    const memberships = boundedRows((await query(ACCESS_SQL.memberships)).rows, 10000, 65000);
    const hooks = boundedRows((await query(ACCESS_SQL.hooks)).rows, 3, 4000);
    check(databases.length > 0 && hooks.length === 3, "ACCESS_CATALOG_MISSING");
    const loaded = Object.fromEntries(hooks.map(row => [row.name, row.setting]));
    const modules = loaded.shared_preload_libraries.split(",").map(value => value.trim()).filter(Boolean);
    const settings = { ...RUNTIME_ACCESS_SENSITIVE_SETTINGS,
      ...(modules.includes("pg_stat_statements") ? {
        "pg_stat_statements.track": "none", "pg_stat_statements.track_utility": "off",
      } : {}) };
    const settingResults = [];
    for (const [name, expected] of Object.entries(settings)) {
      await query("SAVEPOINT access_setting");
      try {
        await query("SELECT pg_catalog.set_config($1,$2,true)", [name, expected]);
        const actual = (await query("SELECT pg_catalog.current_setting($1) AS value", [name])).rows[0]?.value;
        settingResults.push({ name, accepted: actual === expected, sqlState: null });
        await query("RELEASE SAVEPOINT access_setting");
      } catch (error) {
        // One rejected session GUC must not hide the other actual privileges.
        settingResults.push({ name, accepted: false,
          sqlState: /^[0-9A-Z]{5}$/u.test(error?.code ?? "") ? error.code : null });
        await query("ROLLBACK TO SAVEPOINT access_setting");
        await query("RELEASE SAVEPOINT access_setting");
      }
    }
    check((await query("ROLLBACK")).command === "ROLLBACK", "ACCESS_ROLLBACK_UNPROVEN");
    began = false; rolledBack = true;
    const inventories = Object.fromEntries(["core", "ops"].map(domain =>
      [domain, postgresRuntimeAccessIsolationInventory({ databases }, domain)]));
    const result = { status: "SHARED_POSTGRES_ACCESS_CAPTURED", resource: RESOURCE,
      host: HOST, database: "postgres", at: new Date().toISOString(), readonlyGuards: true,
      rollback: true, disconnected: true, databases, roles, memberships, hooks,
      settingResults, inventories, admissionReady: false,
      limits: "Catalog and session-setting probe only; no role, ACL, data, private connectivity, workload, backup or production acceptance proof." };
    check(Buffer.byteLength(JSON.stringify(result)) <= 65536, "ACCESS_RECEIPT_LIMIT");
    return result;
  };
  let result, failure;
  try {
    result = await Promise.race([work(), new Promise((_, reject) => {
      timer = setTimeout(() => { expired = true; client.connection?.stream?.destroy(); reject(new ProbeError("ACCESS_DEADLINE")); }, deadlineMs);
    })]);
  } catch (error) { failure = error; }
  finally {
    clearTimeout(timer);
    try {
      await Promise.race([client.end().then(() => { disconnected = true; }), new Promise((_, reject) => {
        closeTimer = setTimeout(() => { client.connection?.stream?.destroy(); reject(new ProbeError("ACCESS_DISCONNECT_TIMEOUT")); }, closeMs);
      })]);
    } catch (error) { failure ??= error; }
    clearTimeout(closeTimer);
  }
  if (failure) throw failure;
  check(!began && rolledBack && disconnected, "ACCESS_CLEANUP_UNPROVEN");
  return result;
}
