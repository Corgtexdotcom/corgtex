// Catalog-only admission probe for the existing PG18 server. The owning
// qualification workflow controls its stopped baseline, temporary IP and cleanup.
import { AZURE_RUNTIME_ACCESS_SETTINGS, DATABASE_SQL, RUNTIME_ACCESS_SENSITIVE_SETTINGS,
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
  effectiveSettings: `SELECT name,setting,source,context,pending_restart AS "pendingRestart"
    FROM pg_catalog.pg_settings WHERE name=ANY($1::text[]) ORDER BY name`,
  providerGuard: metadataSql.guard.replace("current_database()='postgres'", "current_database()=$1"),
  providerSchemas: `SELECT nspname AS name,oid::text AS oid,pg_catalog.pg_get_userbyid(nspowner) AS owner,
    COALESCE((SELECT bool_or(a.privilege_type='USAGE') FROM pg_catalog.aclexplode(
      COALESCE(nspacl,pg_catalog.acldefault('n',nspowner))) a WHERE a.grantee=0),false) AS "publicUsage",
    COALESCE((SELECT bool_or(a.privilege_type='CREATE') FROM pg_catalog.aclexplode(
      COALESCE(nspacl,pg_catalog.acldefault('n',nspowner))) a WHERE a.grantee=0),false) AS "publicCreate"
    FROM pg_catalog.pg_namespace WHERE nspname NOT LIKE 'pg\\_%' ESCAPE '\\'
    AND nspname<>'information_schema' ORDER BY nspname`,
  providerPublicRelations: `WITH grants AS (
    SELECT n.nspname AS schema,c.relname AS name,c.relkind::text AS kind,
      'relation'::text AS "grantScope",NULL::text AS "column",a.privilege_type AS privilege
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(c.relacl,
      CASE WHEN c.relkind='S' THEN pg_catalog.acldefault('s',c.relowner)
      ELSE pg_catalog.acldefault('r',c.relowner) END)) a
    WHERE n.nspname NOT LIKE 'pg\\_%' ESCAPE '\\' AND n.nspname<>'information_schema'
      AND a.grantee=0
    UNION ALL
    SELECT n.nspname,c.relname,c.relkind::text,'column'::text,attr.attname,a.privilege_type
    FROM pg_catalog.pg_attribute attr
    JOIN pg_catalog.pg_class c ON c.oid=attr.attrelid
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(attr.attacl) a
    WHERE n.nspname NOT LIKE 'pg\\_%' ESCAPE '\\' AND n.nspname<>'information_schema'
      AND attr.attnum>0 AND NOT attr.attisdropped AND a.grantee=0 AND a.privilege_type='SELECT'
  ) SELECT * FROM grants ORDER BY schema,name,"grantScope","column",privilege`,
  providerPublicDefiners: `SELECT n.nspname AS schema,p.proname AS name,p.oid::text AS oid,
    a.privilege_type AS privilege FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(p.proacl,
      pg_catalog.acldefault('f',p.proowner))) a
    WHERE n.nspname NOT LIKE 'pg\\_%' ESCAPE '\\' AND n.nspname<>'information_schema'
    AND p.prosecdef AND a.grantee=0 AND a.privilege_type='EXECUTE'
    ORDER BY n.nspname,p.proname,p.oid`,
  providerPublicFunctions: `SELECT n.nspname AS schema,p.proname AS name,p.oid::text AS oid,
    p.prosecdef AS "securityDefiner",p.prokind::text AS kind
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(p.proacl,
      pg_catalog.acldefault('f',p.proowner))) a
    WHERE n.nspname NOT LIKE 'pg\\_%' ESCAPE '\\' AND n.nspname<>'information_schema'
    AND a.grantee=0 AND a.privilege_type='EXECUTE'
    ORDER BY n.nspname,p.proname,p.oid`,
  providerRelation: "SELECT pg_catalog.to_regclass($1)::text AS relation",
});

export const ACCESS_SETTING_NAMES = Object.freeze([...new Set([
  ...Object.keys(RUNTIME_ACCESS_SENSITIVE_SETTINGS),
  "pg_stat_statements.track", "pg_stat_statements.track_utility",
  "pg_qs.query_capture_mode", "pg_qs.parameters_capture_mode", "pg_qs.store_query_plans", "pg_qs.track_utility",
  "pg_qs.interval_length_minutes",
  "pgms_wait_sampling.query_capture_mode", "pgaudit.log", "pgaudit.log_parameter",
  "auto_explain.log_min_duration", "auto_explain.log_parameter_max_length",
])].sort());
const PROVIDER_DATABASES = Object.freeze(["azure_maintenance", "azure_sys", "template1"]);
const QUERY_STORE_VIEWS = Object.freeze([
  "query_store.query_texts_view", "query_store.qs_view", "query_store.query_plans_view",
  "query_store.pgms_wait_sampling_view",
]);
const CAPTURE_TRIAL_WAIT_MS = 21 * 60 * 1000;

function assertDisabledCapture(receipt) {
  check(receipt?.status === "SHARED_POSTGRES_ACCESS_CAPTURED" && receipt.readonlyGuards === true
    && receipt.rollback === true && receipt.disconnected === true, "CAPTURE_TRIAL_BASELINE_INVALID");
  check(Array.isArray(receipt.effectiveSettings) && Array.isArray(receipt.azureParameters),
    "CAPTURE_TRIAL_BASELINE_INVALID");
  const expected = { ...AZURE_RUNTIME_ACCESS_SETTINGS, "pg_qs.track_utility": "on", "pg_qs.interval_length_minutes": "15" };
  const effective = new Map(receipt.effectiveSettings?.map(row => [row.name, row]));
  const parameters = new Map(receipt.azureParameters?.map(row => [row.name, row]));
  check(effective.size === receipt.effectiveSettings?.length && parameters.size === receipt.azureParameters?.length
    && Object.entries(expected).every(([name, value]) => effective.get(name)?.setting === value
      && effective.get(name)?.pendingRestart === false && parameters.get(name)?.value === value),
  "CAPTURE_TRIAL_SETTINGS_UNSAFE");
  const views = receipt.providerDatabases?.find(row => row.name === "azure_sys")?.queryStore;
  check(Array.isArray(views) && views.length === QUERY_STORE_VIEWS.length
    && QUERY_STORE_VIEWS.every(name => views.some(row => row.view === name && row.present === true
      && row.readable === true && row.hasRows === false)), "CAPTURE_TRIAL_HISTORY_PRESENT");
}

export async function trialDisabledQueryCapture({ baseline, executeSynthetic, recapture, wait,
  now = Date.now, deadline }) {
  check(typeof executeSynthetic === "function" && typeof recapture === "function"
    && typeof wait === "function" && typeof now === "function" && Number.isSafeInteger(deadline),
  "CAPTURE_TRIAL_INPUT_INVALID");
  assertDisabledCapture(baseline);
  check(deadline - now() > CAPTURE_TRIAL_WAIT_MS + 120000, "CAPTURE_TRIAL_WINDOW_SHORT");
  await executeSynthetic();
  const executedAtMs = now(), executedAt = new Date(executedAtMs).toISOString();
  await wait(CAPTURE_TRIAL_WAIT_MS);
  check(now() - executedAtMs >= CAPTURE_TRIAL_WAIT_MS, "CAPTURE_TRIAL_WAIT_UNPROVEN");
  check(deadline - now() > 120000, "CAPTURE_TRIAL_DEADLINE");
  const after = await recapture();
  assertDisabledCapture(after);
  return { status: "QUERY_STORE_CAPTURE_TRIAL_PASS", executedAt, checkedAt: new Date(now()).toISOString(),
    waitMs: CAPTURE_TRIAL_WAIT_MS, provider: "azure-flexible-postgres-18",
    statements: ["EXPLAIN (COSTS OFF) SELECT 1", "SELECT 1"],
    views: [...QUERY_STORE_VIEWS], historyEmpty: true };
}

const boundedRows = (rows, maxRows, maxBytes) => {
  check(Array.isArray(rows) && rows.length <= maxRows
    && Buffer.byteLength(JSON.stringify(rows)) <= maxBytes, "ACCESS_CATALOG_LIMIT");
  return rows;
};
const ident = value => `"${value.replaceAll('"', '""')}"`;

export async function captureSharedPostgresAccess(client, { deadlineMs = 120000, closeMs = 3000,
  providerClientFactory, azureParameters = [] } = {}) {
  check(typeof providerClientFactory === "function", "ACCESS_PROVIDER_FACTORY_MISSING");
  const clients = [client];
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
    const effectiveSettings = boundedRows((await query(ACCESS_SQL.effectiveSettings, [ACCESS_SETTING_NAMES])).rows, 100, 16000);
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
    const providerDatabases = [];
    for (const name of PROVIDER_DATABASES) {
      check(!expired, "ACCESS_DEADLINE");
      const provider = providerClientFactory(name);
      check(provider && typeof provider.query === "function", "ACCESS_PROVIDER_CLIENT_INVALID");
      clients.push(provider);
      await provider.connect();
      guard((await provider.query(ACCESS_SQL.providerGuard, [name])).rows[0], "read committed");
      check((await provider.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")).command === "BEGIN", "ACCESS_PROVIDER_BEGIN_UNPROVEN");
      guard((await provider.query(ACCESS_SQL.providerGuard, [name])).rows[0], "repeatable read");
      const schemas = boundedRows((await provider.query(ACCESS_SQL.providerSchemas)).rows, 100, 8000);
      const publicRelations = boundedRows((await provider.query(ACCESS_SQL.providerPublicRelations)).rows, 500, 16000);
      const publicDefiners = boundedRows((await provider.query(ACCESS_SQL.providerPublicDefiners)).rows, 100, 8000);
      const publicFunctions = boundedRows((await provider.query(ACCESS_SQL.providerPublicFunctions)).rows, 300, 16000);
      const publicRelationRows = [], seenRelations = new Set();
      for (const relation of publicRelations.filter(row => row.privilege === "SELECT")) {
        const key = JSON.stringify([relation.schema, relation.name]);
        if (seenRelations.has(key)) continue;
        seenRelations.add(key);
        await provider.query("SAVEPOINT access_public_relation");
        try {
          const result = await provider.query(`SELECT EXISTS(SELECT 1 FROM ${ident(relation.schema)}.${ident(relation.name)} LIMIT 1) AS "hasRows"`);
          publicRelationRows.push({ schema: relation.schema, name: relation.name,
            administratorRead: true, hasRows: result.rows[0]?.hasRows === true });
        } catch (error) {
          publicRelationRows.push({ schema: relation.schema, name: relation.name,
            administratorRead: false, hasRows: null,
            sqlState: /^[0-9A-Z]{5}$/u.test(error?.code ?? "") ? error.code : null });
          await provider.query("ROLLBACK TO SAVEPOINT access_public_relation");
        }
        await provider.query("RELEASE SAVEPOINT access_public_relation");
      }
      boundedRows(publicRelationRows, 500, 16000);
      const queryStore = [];
      if (name === "azure_sys") for (const view of QUERY_STORE_VIEWS) {
        const relation = (await provider.query(ACCESS_SQL.providerRelation, [view])).rows[0]?.relation;
        if (!relation) { queryStore.push({ view, present: false, readable: false, hasRows: null }); continue; }
        await provider.query("SAVEPOINT access_provider_view");
        let hasRows;
        try {
          const result = await provider.query(`SELECT EXISTS(SELECT 1 FROM ${view} LIMIT 1) AS "hasRows"`);
          hasRows = result.rows[0]?.hasRows === true;
        } catch (error) {
          queryStore.push({ view, present: true, readable: false, hasRows: null,
            sqlState: /^[0-9A-Z]{5}$/u.test(error?.code ?? "") ? error.code : null });
          // A failed read aborts the transaction. Preserve the unknown result and
          // continue only after a bounded savepoint rollback.
          await provider.query("ROLLBACK TO SAVEPOINT access_provider_view");
        }
        await provider.query("RELEASE SAVEPOINT access_provider_view");
        if (hasRows !== undefined) queryStore.push({ view, present: true, readable: true, hasRows });
      }
      check((await provider.query("ROLLBACK")).command === "ROLLBACK", "ACCESS_PROVIDER_ROLLBACK_UNPROVEN");
      providerDatabases.push({ name, schemas, publicRelations, publicDefiners, publicFunctions,
        publicRelationRows, queryStore,
        readonlyGuards: true, rollback: true });
    }
    const inventories = Object.fromEntries(["core", "ops"].map(domain =>
      [domain, postgresRuntimeAccessIsolationInventory({ databases }, domain)]));
    const result = { status: "SHARED_POSTGRES_ACCESS_CAPTURED", resource: RESOURCE,
      host: HOST, database: "postgres", at: new Date().toISOString(), readonlyGuards: true,
      rollback: true, disconnected: true, databases, roles, memberships, hooks,
      settingResults, effectiveSettings, azureParameters, providerDatabases, inventories, admissionReady: false,
      limits: "Read-only catalog, effective-setting and provider exposure probe; no role, ACL, customer-row, private connectivity, workload, backup or production acceptance proof." };
    check(Buffer.byteLength(JSON.stringify(result)) <= 65536, "ACCESS_RECEIPT_LIMIT");
    return result;
  };
  let result, failure;
  try {
    result = await Promise.race([work(), new Promise((_, reject) => {
      timer = setTimeout(() => { expired = true; for (const active of clients) active.connection?.stream?.destroy(); reject(new ProbeError("ACCESS_DEADLINE")); }, deadlineMs);
    })]);
  } catch (error) { failure = error; }
  finally {
    clearTimeout(timer);
    try {
      await Promise.race([Promise.all(clients.map(active => active.end())).then(() => { disconnected = true; }), new Promise((_, reject) => {
        closeTimer = setTimeout(() => { for (const active of clients) active.connection?.stream?.destroy(); reject(new ProbeError("ACCESS_DISCONNECT_TIMEOUT")); }, closeMs);
      })]);
    } catch (error) { failure ??= error; }
    clearTimeout(closeTimer);
  }
  if (failure) throw failure;
  check(!began && rolledBack && disconnected, "ACCESS_CLEANUP_UNPROVEN");
  return result;
}
