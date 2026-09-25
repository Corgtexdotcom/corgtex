import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import pg from "pg";
import { provisionWorkerScalerRoleInTransaction, verifyWorkerScalerAccess, WORKER_SCALER_TABLE_COLUMNS } from "../release/worker-demand.mjs";

const NAME = /^[a-z][a-z0-9_]{0,62}$/;
const OID = /^[1-9][0-9]{0,9}$/;
const HASH = /^[a-f0-9]{64}$/;
const q = name => `"${name.replaceAll('"', '""')}"`;
const stable = value => Array.isArray(value) ? `[${value.map(stable).join(",")}]` : value && typeof value === "object"
  ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}` : JSON.stringify(value);
const hash = value => createHash("sha256").update(stable(value)).digest("hex");
const equal = (a, b) => stable(a) === stable(b);
const exact = (value, keys) => value && typeof value === "object" && !Array.isArray(value) && equal(Object.keys(value).sort(), [...keys].sort());
export class PostgresRuntimeAccessError extends Error {
  constructor(code) { super(code); this.name = "PostgresRuntimeAccessError"; this.code = code; }
}
const need = (ok, code) => { if (!ok) throw new PostgresRuntimeAccessError(code); };
const safeError = error => error instanceof PostgresRuntimeAccessError ? error : new PostgresRuntimeAccessError("RUNTIME_ACCESS_OPERATION_FAILED");
export const postgresRuntimeAccessPolicySha256 = hash;
const version = (value, vault) => typeof value === "string" && value.startsWith(vault + "secrets/")
  && /^https:\/\/[a-z0-9-]{3,24}\.vault\.azure\.net\/secrets\/[A-Za-z0-9-]{1,127}\/[a-f0-9]{32}$/.test(value);

export function validatePostgresRuntimeAccessPolicy(policy, { domain, runtimeVaultUri } = {}) {
  need(["core", "ops"].includes(domain) && /^https:\/\/[a-z0-9-]{3,24}\.vault\.azure\.net\/$/.test(runtimeVaultUri), "RUNTIME_ACCESS_BINDING_INVALID");
  const azure = policy?.schemaVersion === 2;
  need(exact(policy, ["schemaVersion", "runtimeRole", "runtimeDatabaseSecrets", "scaler", "applicationSchema", "isolation",
    ...(azure ? ["providerProfile"] : []),
    ...(azure && policy?.queryStoreUtilityTracking !== undefined ? ["queryStoreUtilityTracking"] : [])])
    && [1, 2].includes(policy.schemaVersion) && (!azure || policy.providerProfile === "azure-flexible-postgres-18")
    && (!azure || policy.queryStoreUtilityTracking === undefined
      || policy.queryStoreUtilityTracking === "capture-disabled-provider-on")
    && policy.runtimeRole === `corgtex_${domain}_runtime` && policy.applicationSchema === "public", "RUNTIME_ACCESS_POLICY_INVALID");
  need(exact(policy.runtimeDatabaseSecrets, ["web", "worker"])
    && Object.values(policy.runtimeDatabaseSecrets).every(value => version(value, runtimeVaultUri))
    && exact(policy.scaler, ["role", "connectionSecretVersion"]) && policy.scaler.role === `worker_scale_${domain}`
    && version(policy.scaler.connectionSecretVersion, runtimeVaultUri)
    && !Object.values(policy.runtimeDatabaseSecrets).includes(policy.scaler.connectionSecretVersion), "RUNTIME_ACCESS_SECRET_BINDING_INVALID");
  need(exact(policy.isolation, ["inventorySha256", "databases"]) && HASH.test(policy.isolation.inventorySha256)
    && Array.isArray(policy.isolation.databases) && policy.isolation.databases.length > 0 && policy.isolation.databases.length <= 1000, "RUNTIME_ACCESS_ISOLATION_INVALID");
  const seen = new Set();
  for (const db of policy.isolation.databases) {
    need(exact(db, ["name", "oid", "owner", "action", "beforeAclSha256", "preserveConnectRoles"])
      && NAME.test(db.name) && db.name !== `corgtex_${domain}` && OID.test(db.oid) && typeof db.owner === "string" && db.owner.length <= 63
      && !seen.has(db.name) && HASH.test(db.beforeAclSha256)
      && ["replace-public-connect", "verify-only", ...(azure ? ["allow-provider-connect"] : [])].includes(db.action)
      && Array.isArray(db.preserveConnectRoles) && db.preserveConnectRoles.length <= 1000, "RUNTIME_ACCESS_ISOLATION_INVALID");
    seen.add(db.name); const principals = new Set();
    for (const role of db.preserveConnectRoles) {
      need(exact(role, ["name", "oid"]) && NAME.test(role.name) && OID.test(role.oid) && !principals.has(role.name)
        && ![policy.runtimeRole, policy.scaler.role].includes(role.name), "RUNTIME_ACCESS_CONNECT_ALLOWLIST_INVALID");
      principals.add(role.name);
    }
    need(db.action === "replace-public-connect" || db.preserveConnectRoles.length === 0, "RUNTIME_ACCESS_VERIFY_ONLY_PATCH_INVALID");
    if (db.action === "allow-provider-connect") need({ azure_sys: "azuresu", azure_maintenance: "azuresu",
      template1: "azure_pg_admin" }[db.name] === db.owner, "RUNTIME_ACCESS_PROVIDER_EXCEPTION_INVALID");
  }
  return policy;
}

function validatePlan(plan, preflight = false) {
  const keys=["schemaVersion","domain","intentSha256","operationId","serverResourceId","host","port","database","databaseOid","administrator","runtimeVaultUri","policy"];
  need(plan && (preflight ? Object.keys(plan).every(key=>keys.includes(key)) : exact(plan,keys)), "RUNTIME_ACCESS_PLAN_INVALID");
  need(plan && ["core", "ops"].includes(plan.domain) && typeof plan.host === "string" && /^[a-z0-9][a-z0-9.-]{0,252}$/.test(plan.host)
    && Number.isInteger(plan.port) && plan.port > 0 && plan.port <= 65535 && NAME.test(plan.administrator)
    && /^\/subscriptions\/[a-f0-9-]{36}\/resourceGroups\/[A-Za-z0-9_.()-]+\/providers\/Microsoft.DBforPostgreSQL\/flexibleServers\/[a-z0-9-]+$/i.test(plan.serverResourceId), "RUNTIME_ACCESS_PLAN_INVALID");
  validatePostgresRuntimeAccessPolicy(plan.policy, plan);
  if (!preflight) need(plan.schemaVersion === 1 && HASH.test(plan.intentSha256) && typeof plan.operationId === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(plan.operationId)
    && plan.database === `corgtex_${plan.domain}` && OID.test(plan.databaseOid), "RUNTIME_ACCESS_PLAN_INVALID");
  return plan;
}
function guards(options, preflight = false) {
  need(options.signal instanceof AbortSignal && typeof options.assertHeld === "function" && typeof options.assertTargetInactive === "function"
    && (preflight || typeof options.assertSourceFenced === "function"), "RUNTIME_ACCESS_GUARDS_REQUIRED");
  return async effect => {
    options.signal.throwIfAborted();
    need(await options.assertHeld({ effect }) !== false, "RUNTIME_ACCESS_CUSTODY_LOST");
    // Per-statement custody is cheap and mandatory. Full provider inventories
    // belong to explicit admission/commit/readback boundaries, not each object.
    if (!["SQL_MUTATION", "SCALER_PROVISION"].includes(effect)) {
      if (!preflight) need(await options.assertSourceFenced({ effect }) !== false, "RUNTIME_ACCESS_SOURCE_NOT_FENCED");
      need(await options.assertTargetInactive({ effect }) !== false, "RUNTIME_ACCESS_TARGET_NOT_INACTIVE");
    }
    need(await options.assertHeld({ effect }) !== false, "RUNTIME_ACCESS_CUSTODY_LOST");
    options.signal.throwIfAborted();
  };
}
function validateClient(client, plan) {
  need(client?.connection?.stream?.encrypted === true && client.connection.stream.authorized === true
    && client.connectionParameters?.host === plan.host && Number(client.connectionParameters.port) === plan.port
    && client.connectionParameters.user === plan.administrator, "RUNTIME_ACCESS_VERIFIED_CONNECTION_REQUIRED");
}
async function credentials(plan, resolveSecretVersion) {
  need(typeof resolveSecretVersion === "function", "RUNTIME_ACCESS_SECRET_RESOLVER_REQUIRED");
  const entries = { web: plan.policy.runtimeDatabaseSecrets.web, worker: plan.policy.runtimeDatabaseSecrets.worker, scaler: plan.policy.scaler.connectionSecretVersion };
  const result = {};
  for (const [kind, url] of Object.entries(entries)) {
    const text = await resolveSecretVersion(url); let parsed;
    try { parsed = new URL(text); } catch { throw new PostgresRuntimeAccessError("RUNTIME_ACCESS_SECRET_INVALID"); }
    const expected = kind === "scaler" ? plan.policy.scaler.role : plan.policy.runtimeRole;
    let username, password, database;
    try { username = decodeURIComponent(parsed.username); password = decodeURIComponent(parsed.password); database = decodeURIComponent(parsed.pathname.slice(1)); }
    catch { throw new PostgresRuntimeAccessError("RUNTIME_ACCESS_SECRET_INVALID"); }
    const params = [...parsed.searchParams];
    need(["postgres:", "postgresql:"].includes(parsed.protocol) && parsed.hostname === plan.host && Number(parsed.port || 5432) === plan.port
      && username === expected && database === `corgtex_${plan.domain}` && /^[a-f0-9]{64}$/.test(password) && !parsed.hash
      && new Set(params.map(([key]) => key)).size === params.length && parsed.searchParams.get("sslmode") === "verify-full"
      && params.every(([key, value]) => key === "sslmode" || (kind !== "scaler" && ((key === "connection_limit" && ["2", "5"].includes(value)) || (key === "pool_timeout" && value === "10")))), "RUNTIME_ACCESS_SECRET_INVALID");
    result[kind] = { role: expected, password };
  }
  need(result.web.password === result.worker.password && result.web.password !== result.scaler.password, "RUNTIME_ACCESS_PASSWORD_BINDING_INVALID");
  return result;
}

// ACL entries are normalized effective defaults, retaining every named grant and grantor.
const acl = (column, kind, owner) => `(SELECT COALESCE(jsonb_agg(jsonb_build_object('grantor', a.grantor::text, 'grantee', a.grantee::text,
  'privilege', a.privilege_type, 'grantable', a.is_grantable) ORDER BY a.grantor,a.grantee,a.privilege_type,a.is_grantable),'[]'::jsonb)
  FROM pg_catalog.aclexplode(COALESCE(${column},pg_catalog.acldefault('${kind}',${owner}))) a)`;
export const DATABASE_SQL = `/* runtime-access:databases */ SELECT d.datname AS name,d.oid::text AS oid,pg_catalog.pg_get_userbyid(d.datdba) AS owner,
  d.datallowconn AS "allowConnections",d.datistemplate AS "isTemplate",pg_catalog.pg_has_role(current_user,d.datdba,'USAGE') AS "ownerAuthority",${acl("d.datacl", "d", "d.datdba")} AS acl
  FROM pg_catalog.pg_database d ORDER BY d.datname`;
const OBJECT_SQL = `/* runtime-access:objects */ WITH objects AS (
 SELECT 'pg_class'::text AS catalog,c.oid,c.relnamespace AS namespace,c.relname AS name,c.relowner AS owner,c.relkind::text AS kind,
  c.relacl AS acl,CASE WHEN c.relkind='S' THEN 's' ELSE 'r' END AS aclkind,
  pg_catalog.format('%I.%I',n.nspname,c.relname) AS identity,false AS "securityDefiner",
  COALESCE((SELECT 'pg_class:'||i.indrelid::text FROM pg_catalog.pg_index i WHERE i.indexrelid=c.oid),
    (SELECT 'pg_class:'||d.refobjid::text FROM pg_catalog.pg_depend d WHERE d.classid='pg_class'::regclass AND d.objid=c.oid
      AND d.refclassid='pg_class'::regclass AND d.deptype IN ('a','i') ORDER BY d.refobjid LIMIT 1),
    CASE WHEN c.relkind='c' THEN 'pg_type:'||c.reltype::text END) AS parent
 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
 UNION ALL
 SELECT 'pg_type',t.oid,t.typnamespace,t.typname,t.typowner,t.typtype::text,t.typacl,'T',pg_catalog.format('%I.%I',n.nspname,t.typname),false,
  CASE WHEN t.typrelid<>0 AND r.relkind<>'c' THEN 'pg_class:'||t.typrelid::text
    WHEN t.typelem<>0 AND t.typlen=-1 THEN 'pg_type:'||t.typelem::text
    WHEN t.typtype='m' THEN (SELECT 'pg_type:'||g.rngtypid::text FROM pg_catalog.pg_range g WHERE g.rngmultitypid=t.oid) END
 FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace LEFT JOIN pg_catalog.pg_class r ON r.oid=t.typrelid WHERE n.nspname='public'
 UNION ALL
 SELECT 'pg_proc',p.oid,p.pronamespace,p.proname,p.proowner,p.prokind::text,p.proacl,'f',
  pg_catalog.format('%I.%I(%s)',n.nspname,p.proname,pg_catalog.pg_get_function_identity_arguments(p.oid)),p.prosecdef,NULL
 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'
 UNION ALL
 SELECT 'pg_largeobject_metadata',l.oid,0::oid,l.oid::text,l.lomowner,'L',l.lomacl,'L',l.oid::text,false,NULL FROM pg_catalog.pg_largeobject_metadata l
 ) SELECT o.catalog,o.oid::text AS oid,o.name,o.kind,o.identity,pg_catalog.pg_get_userbyid(o.owner) AS owner,o.parent,o."securityDefiner",
 COALESCE(n.nspname,'') AS schema,
 (SELECT e.extname FROM pg_catalog.pg_depend d JOIN pg_catalog.pg_extension e ON e.oid=d.refobjid
 WHERE d.classid=('pg_catalog.'||o.catalog)::regclass AND d.objid=o.oid AND d.refclassid='pg_extension'::regclass AND d.deptype='e') AS extension,
 (SELECT COALESCE(jsonb_agg(jsonb_build_object('grantor',a.grantor::text,'grantee',a.grantee::text,'privilege',a.privilege_type,'grantable',a.is_grantable)
 ORDER BY a.grantor,a.grantee,a.privilege_type,a.is_grantable),'[]'::jsonb)
 FROM pg_catalog.aclexplode(COALESCE(o.acl,pg_catalog.acldefault(o.aclkind::"char",o.owner))) a) AS acl
 FROM objects o LEFT JOIN pg_catalog.pg_namespace n ON n.oid=o.namespace ORDER BY o.catalog,o.oid`;

export async function observePostgresRuntimeAccessCatalog({ client, plan }) {
  validatePlan(plan, !plan.databaseOid); validateClient(client, plan);
  const identity = (await client.query(`/* runtime-access:identity */ SELECT current_database() AS database,current_user AS administrator,session_user AS "sessionUser",
    current_setting('server_version_num')::int AS version,d.oid::text AS "databaseOid",pg_catalog.pg_get_userbyid(d.datdba) AS "databaseOwner"
    FROM pg_catalog.pg_database d WHERE d.datname=current_database()`)).rows;
  need(identity.length === 1 && identity[0].administrator === plan.administrator && identity[0].sessionUser === plan.administrator
    && Math.floor(identity[0].version / 10000) === 18, "RUNTIME_ACCESS_DATABASE_IDENTITY_CHANGED");
  const databases = (await client.query(DATABASE_SQL)).rows;
  need(databases.length > 0 && databases.length <= 1000, "RUNTIME_ACCESS_CATALOG_LIMIT");
  const roles = (await client.query(`/* runtime-access:roles */ SELECT oid::text AS oid,rolname AS name,rolsuper AS superuser,rolcreatedb AS "createDb",
    rolcreaterole AS "createRole",rolinherit AS inherit,rolcanlogin AS login,rolreplication AS replication,rolbypassrls AS "bypassRls",rolconnlimit AS "connectionLimit"
    FROM pg_catalog.pg_roles ORDER BY rolname`)).rows;
  need(roles.length <= 10000, "RUNTIME_ACCESS_CATALOG_LIMIT");
  const roleNames = [plan.policy.runtimeRole, plan.policy.scaler.role];
  const memberships = (await client.query(`/* runtime-access:memberships */ SELECT roleid::text AS "roleOid",member::text AS "memberOid",grantor::text AS "grantorOid",
    admin_option AS "adminOption",inherit_option AS "inheritOption",set_option AS "setOption" FROM pg_catalog.pg_auth_members
    WHERE roleid IN (SELECT oid FROM pg_catalog.pg_roles WHERE rolname=ANY($1::text[])) OR member IN (SELECT oid FROM pg_catalog.pg_roles WHERE rolname=ANY($1::text[]))
    ORDER BY roleid,member,grantor`, [roleNames])).rows;
  if (!plan.databaseOid) return { schemaVersion: 1, identity: identity[0], databases, roles, memberships };
  need(identity[0].database === plan.database && identity[0].databaseOid === plan.databaseOid && identity[0].databaseOwner === plan.administrator, "RUNTIME_ACCESS_DATABASE_IDENTITY_CHANGED");
  const schemas = (await client.query(`/* runtime-access:schemas */ SELECT n.oid::text AS oid,n.nspname AS name,pg_catalog.pg_get_userbyid(n.nspowner) AS owner,
    ${acl("n.nspacl", "n", "n.nspowner")} AS acl FROM pg_catalog.pg_namespace n
    WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' ORDER BY n.nspname`)).rows;
  const objects = (await client.query(OBJECT_SQL)).rows;
  need(objects.length <= 20000 && schemas.length <= 100, "RUNTIME_ACCESS_CATALOG_LIMIT");
  const columns = (await client.query(`/* runtime-access:columns */ SELECT c.oid::text AS "tableOid",c.relname AS "table",a.attnum AS number,a.attname AS name,
    (SELECT COALESCE(jsonb_agg(jsonb_build_object('grantor',x.grantor::text,'grantee',x.grantee::text,'privilege',x.privilege_type,'grantable',x.is_grantable)
      ORDER BY x.grantor,x.grantee,x.privilege_type,x.is_grantable),'[]'::jsonb) FROM pg_catalog.aclexplode(a.attacl) x) AS acl
    FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND a.attnum>0 AND NOT a.attisdropped ORDER BY c.oid,a.attnum`)).rows;
  need(columns.length<=200000,"RUNTIME_ACCESS_CATALOG_LIMIT");
  const extensions = (await client.query(`/* runtime-access:extensions */ SELECT oid::text AS oid,extname AS name,extversion AS version,
    pg_catalog.pg_get_userbyid(extowner) AS owner,extnamespace::text AS "schemaOid" FROM pg_catalog.pg_extension ORDER BY extname`)).rows;
  const defaults = (await client.query(`/* runtime-access:defaults */ SELECT d.oid::text AS oid,pg_catalog.pg_get_userbyid(d.defaclrole) AS role,
    d.defaclnamespace::text AS "schemaOid",d.defaclobjtype::text AS kind,${acl("d.defaclacl", "f", "d.defaclrole")} AS acl
    FROM pg_catalog.pg_default_acl d ORDER BY d.defaclrole,d.defaclnamespace,d.defaclobjtype`)).rows;
  return { schemaVersion: 1, identity: identity[0], databases, roles, memberships, schemas, objects, columns, extensions, defaults };
}
export function postgresRuntimeAccessIsolationInventory(manifest, domain) {
  need(["core", "ops"].includes(domain), "RUNTIME_ACCESS_BINDING_INVALID");
  const databases = manifest.databases.filter(db => db.name !== `corgtex_${domain}`).map(db => ({ name: db.name, oid: db.oid, owner: db.owner,
    allowConnections: db.allowConnections, isTemplate: db.isTemplate, aclSha256: hash(db.acl) })).sort((a,b) => a.name.localeCompare(b.name));
  return { inventorySha256: hash(databases), databases };
}

export const RUNTIME_ACCESS_SENSITIVE_SETTINGS = Object.freeze({
  log_statement: "none", log_min_error_statement: "panic", log_parameter_max_length: "0", log_parameter_max_length_on_error: "0",
  log_duration: "off", log_min_duration_statement: "-1", log_min_duration_sample: "-1", log_statement_sample_rate: "0", log_transaction_sample_rate: "0",
  debug_print_parse: "off", debug_print_rewritten: "off", debug_print_plan: "off", log_parser_stats: "off", log_planner_stats: "off",
  log_executor_stats: "off", log_statement_stats: "off", track_activities: "off", client_min_messages: "error",
});
const AZURE_PRELOAD_MODULES = Object.freeze(["pg_cron", "pg_stat_statements", "azure", "pg_qs", "pgaadauth",
  "pgms_stats", "pgms_wait_sampling", "pg_availability"]);
export const AZURE_RUNTIME_ACCESS_SETTINGS = Object.freeze({ ...RUNTIME_ACCESS_SENSITIVE_SETTINGS,
  "pg_stat_statements.track": "none", "pg_stat_statements.track_utility": "off",
  "pg_qs.query_capture_mode": "none", "pg_qs.parameters_capture_mode": "capture_parameterless_only",
  "pg_qs.store_query_plans": "off", "pg_qs.track_utility": "off",
  "pgms_wait_sampling.query_capture_mode": "none" });
function azureRuntimeAccessSettings(policy) {
  return policy.queryStoreUtilityTracking === "capture-disabled-provider-on"
    ? { ...AZURE_RUNTIME_ACCESS_SETTINGS, "pg_qs.track_utility": "on", "pg_qs.interval_length_minutes": "15" }
    : AZURE_RUNTIME_ACCESS_SETTINGS;
}
async function assertAzureLoggingProfile(client, policy, readAzureParameters, inspectAzureQueryStore) {
  need(typeof readAzureParameters === "function", "RUNTIME_ACCESS_AZURE_PARAMETER_READBACK_REQUIRED");
  need(typeof inspectAzureQueryStore === "function", "RUNTIME_ACCESS_AZURE_QUERY_STORE_READBACK_REQUIRED");
  const expected = azureRuntimeAccessSettings(policy), names = Object.keys(expected);
  const rows = (await client.query(`/* runtime-access:azure-settings */ SELECT name,setting,pending_restart AS "pendingRestart"
    FROM pg_catalog.pg_settings WHERE name=ANY($1::text[])`, [names])).rows;
  need(rows.length === names.length && new Set(rows.map(row => row.name)).size === names.length
    && rows.every(row => expected[row.name] === row.setting && row.pendingRestart === false),
  "RUNTIME_ACCESS_AZURE_LOGGING_UNSAFE");
  const parameters = await readAzureParameters();
  need(Array.isArray(parameters) && parameters.length <= 1000, "RUNTIME_ACCESS_AZURE_PARAMETER_READBACK_INVALID");
  const byName = new Map(parameters.map(row => [row.name, row.value]));
  need(byName.size === parameters.length && names.every(name => byName.get(name) === expected[name]),
    "RUNTIME_ACCESS_AZURE_PARAMETER_MISMATCH");
  need(await inspectAzureQueryStore() === false, "RUNTIME_ACCESS_AZURE_QUERY_HISTORY_PRESENT");
  return hash({ settings: rows, parameters: names.map(name => ({ name, value: byName.get(name) })) });
}
async function suppressSensitiveSql(client, policy, readAzureParameters, inspectAzureQueryStore) {
  const loaded = Object.fromEntries((await client.query(`/* runtime-access:logging */ SELECT name,setting FROM pg_catalog.pg_settings
    WHERE name IN ('shared_preload_libraries','session_preload_libraries','local_preload_libraries')`)).rows.map(row => [row.name,row.setting]));
  const modules = (loaded.shared_preload_libraries ?? "").split(",").map(value => value.trim()).filter(Boolean);
  need(!loaded.session_preload_libraries && !loaded.local_preload_libraries, "RUNTIME_ACCESS_LOGGING_HOOK_UNPROVEN");
  if (policy.schemaVersion === 2) {
    need(equal(modules, AZURE_PRELOAD_MODULES), "RUNTIME_ACCESS_LOGGING_HOOK_UNPROVEN");
    return assertAzureLoggingProfile(client, policy, readAzureParameters, inspectAzureQueryStore);
  }
  need(modules.every(name => name === "pg_stat_statements"), "RUNTIME_ACCESS_LOGGING_HOOK_UNPROVEN");
  const settings = { ...RUNTIME_ACCESS_SENSITIVE_SETTINGS, ...(modules.includes("pg_stat_statements") ? { "pg_stat_statements.track": "none", "pg_stat_statements.track_utility": "off" } : {}) };
  for (const [name,value] of Object.entries(settings)) {
    await client.query("SELECT pg_catalog.set_config($1,$2,true)", [name,value]);
    need((await client.query("SELECT pg_catalog.current_setting($1) AS value", [name])).rows[0]?.value === value, "RUNTIME_ACCESS_LOGGING_SUPPRESSION_UNPROVEN");
  }
}
function scram(password) {
  const salt = randomBytes(16), salted = pbkdf2Sync(password,salt,4096,32,"sha256");
  const clientKey = createHmac("sha256",salted).update("Client Key").digest();
  const stored = createHash("sha256").update(clientKey).digest("base64");
  const server = createHmac("sha256",salted).update("Server Key").digest("base64");
  salted.fill(0); clientKey.fill(0);
  return `SCRAM-SHA-256$4096:${salt.toString("base64")}$${stored}:${server}`;
}
function isolationBefore(manifest, plan) {
  need(manifest.roles.some(role=>role.name===plan.administrator && (role.createRole || role.superuser)), "RUNTIME_ACCESS_ADMIN_ROLE_CREATION_UNPROVEN");
  const actual = postgresRuntimeAccessIsolationInventory(manifest,plan.domain), expected = plan.policy.isolation;
  need(actual.inventorySha256 === expected.inventorySha256 && actual.databases.length === expected.databases.length, "RUNTIME_ACCESS_ISOLATION_INVENTORY_CHANGED");
  for (const db of expected.databases) {
    const observed = actual.databases.find(row => row.name === db.name);
    need(observed?.oid === db.oid && observed.owner === db.owner && observed.aclSha256 === db.beforeAclSha256, "RUNTIME_ACCESS_DATABASE_ACL_CHANGED");
    if (db.action === "verify-only" && observed.allowConnections) need(!manifest.databases.find(row=>row.oid===db.oid).acl.some(
      entry=>entry.grantee==="0" && entry.privilege==="CONNECT"), "RUNTIME_ACCESS_PROVIDER_PUBLIC_CONNECT");
    if (db.action === "allow-provider-connect") {
      need(plan.policy.schemaVersion === 2 && observed.allowConnections && observed.isTemplate === (db.name === "template1")
        && manifest.databases.find(row=>row.oid===db.oid).acl.some(entry=>entry.grantee==="0" && entry.privilege==="CONNECT"),
      "RUNTIME_ACCESS_PROVIDER_EXCEPTION_CHANGED");
    }
    if (db.action === "replace-public-connect") need(manifest.databases.find(row=>row.oid===db.oid)?.ownerAuthority === true && !observed.isTemplate
      && !["azure_sys","azure_maintenance","template0","template1"].includes(db.name), "RUNTIME_ACCESS_PROVIDER_DATABASE_PATCH_FORBIDDEN");
    for (const role of db.preserveConnectRoles) need(manifest.roles.some(row => row.name === role.name && row.oid === role.oid), "RUNTIME_ACCESS_CONNECT_PRINCIPAL_CHANGED");
  }
  need(!manifest.roles.some(row => [plan.policy.runtimeRole,plan.policy.scaler.role].includes(row.name)), "RUNTIME_ACCESS_ROLE_ALREADY_EXISTS");
}
function objectActions(manifest, plan) {
  need(manifest.schemas.length === 1 && manifest.schemas[0].name === "public", "RUNTIME_ACCESS_UNREVIEWED_SCHEMA");
  const objects = new Map(manifest.objects.map(o => [`${o.catalog}:${o.oid}`,o]));
  need(objects.size === manifest.objects.length, "RUNTIME_ACCESS_OBJECT_AMBIGUOUS");
  function extensionOwned(o, visited = new Set()) {
    if (o.extension) return true;
    if (!o.parent) return false;
    need(!visited.has(o.parent) && objects.has(o.parent), "RUNTIME_ACCESS_DEPENDENCY_UNPROVEN");
    visited.add(o.parent); return extensionOwned(objects.get(o.parent),visited);
  }
  const actions = [];
  for (const o of manifest.objects) {
    need(OID.test(o.oid) && typeof o.identity === "string" && !o.identity.includes("\0"), "RUNTIME_ACCESS_OBJECT_INVALID");
    if (extensionOwned(o)) continue;
    need(o.owner === plan.administrator && !o.securityDefiner, "RUNTIME_ACCESS_OBJECT_OWNER_UNSUPPORTED");
    if (o.parent) continue;
    let kind;
    if (o.catalog === "pg_class") kind = ({ r:"TABLE",p:"TABLE",S:"SEQUENCE",v:"VIEW",m:"MATERIALIZED VIEW" })[o.kind];
    if (o.catalog === "pg_type") kind = ({ e:"TYPE",d:"DOMAIN",c:"TYPE",r:"TYPE" })[o.kind];
    if (o.catalog === "pg_proc") kind = ({ f:"FUNCTION",p:"PROCEDURE" })[o.kind];
    if (o.catalog === "pg_largeobject_metadata" && o.kind === "L") kind = "LARGE OBJECT";
    need(kind, "RUNTIME_ACCESS_OBJECT_KIND_UNSUPPORTED");
    actions.push({ object:o,kind });
  }
  return { actions, application:manifest.objects.filter(o => !extensionOwned(o)), protected:manifest.objects.filter(o=>extensionOwned(o)) };
}
function ordinary(row, connectionLimit) {
  return row && row.login && !row.superuser && !row.createDb && !row.createRole && !row.replication && !row.bypassRls
    && !row.inherit && row.connectionLimit === connectionLimit;
}
function changedAclAllowed(before,after, { removedPublic = [], added = [], ownerChange = null } = {}) {
  const normalize = entries => entries.map(entry => ({ ...entry,
    grantor: ownerChange && entry.grantor === ownerChange.from ? ownerChange.to : entry.grantor,
    grantee: ownerChange && entry.grantee === ownerChange.from ? ownerChange.to : entry.grantee })).sort((a,b)=>stable(a).localeCompare(stable(b)));
  const required = normalize(before.filter(entry => !(entry.grantee === "0" && removedPublic.includes(entry.privilege))));
  const actual = normalize(after);
  return required.every(entry=>actual.some(row=>equal(row,entry))) && actual.every(entry=>required.some(row=>equal(row,entry))
    || added.some(allow => entry.grantee === allow.oid && allow.privileges.includes(entry.privilege) && !entry.grantable));
}
function validateAfter(before,after,plan) {
  need(equal(before.identity,after.identity) && equal(before.extensions,after.extensions), "RUNTIME_ACCESS_PROTECTED_IDENTITY_CHANGED");
  const runtime = after.roles.find(r=>r.name===plan.policy.runtimeRole), scaler=after.roles.find(r=>r.name===plan.policy.scaler.role);
  const admin = before.roles.find(r=>r.name===plan.administrator);
  need(ordinary(runtime,-1) && ordinary(scaler,2) && admin
    && equal(before.roles,after.roles.filter(r=>![runtime.name,scaler.name].includes(r.name))), "RUNTIME_ACCESS_ROLE_PROOF_FAILED");
  const edges = after.memberships;
  need(edges.length > 0 && edges.every(e=>[runtime.oid,scaler.oid].includes(e.roleOid) && e.memberOid===admin.oid)
    && edges.some(e=>e.roleOid===runtime.oid && e.setOption && e.inheritOption)
    && edges.some(e=>e.roleOid===scaler.oid && e.setOption)
    && !edges.some(e=>e.roleOid===scaler.oid && e.inheritOption), "RUNTIME_ACCESS_MEMBERSHIP_PROOF_FAILED");
  const { application,protected:protectedObjects } = objectActions(before,plan);
  need(before.objects.length===after.objects.length && before.schemas.length===after.schemas.length, "RUNTIME_ACCESS_OBJECT_SET_CHANGED");
  for (const object of protectedObjects) need(after.objects.some(o=>equal(o,object)), "RUNTIME_ACCESS_EXTENSION_CHANGED");
  for (const old of application) {
    const current=after.objects.find(o=>o.catalog===old.catalog && o.oid===old.oid);
    need(current && current.owner===runtime.name && equal({ ...old,owner:runtime.name,acl:null },{ ...current,acl:null })
      && changedAclAllowed(old.acl,current.acl,{ownerChange:{from:admin.oid,to:runtime.oid},removedPublic:old.catalog==="pg_proc"?["EXECUTE"]:[],
        added:old.catalog==="pg_class" ? [{oid:scaler.oid,privileges:[]}] : []}), "RUNTIME_ACCESS_OBJECT_TRANSFER_UNPROVEN");
  }
  need(before.columns.length===after.columns.length,"RUNTIME_ACCESS_COLUMN_SET_CHANGED");
  for(const old of before.columns) {
    const current=after.columns.find(c=>c.tableOid===old.tableOid && c.number===old.number);
    const app=application.some(o=>o.catalog==="pg_class" && o.oid===old.tableOid);
    need(current && equal({...old,acl:null},{...current,acl:null}) && (app ? changedAclAllowed(old.acl,current.acl,{
      ownerChange:{from:admin.oid,to:runtime.oid},added:WORKER_SCALER_TABLE_COLUMNS[old.table]?.includes(old.name)?[{oid:scaler.oid,privileges:["SELECT"]}]:[]
    }):equal(old.acl,current.acl)),"RUNTIME_ACCESS_COLUMN_ACL_UNPROVEN");
  }
  for (const old of before.schemas) {
    const current=after.schemas.find(s=>s.oid===old.oid);
    need(current && equal({...old,acl:null},{...current,acl:null}) && changedAclAllowed(old.acl,current.acl,
      {added:[{oid:runtime.oid,privileges:["USAGE","CREATE"]},{oid:scaler.oid,privileges:["USAGE"]}]}),"RUNTIME_ACCESS_SCHEMA_CHANGED");
  }
  need(before.databases.length===after.databases.length,"RUNTIME_ACCESS_DATABASE_SET_CHANGED");
  for (const old of before.databases) {
    const current=after.databases.find(d=>d.oid===old.oid), policy=plan.policy.isolation.databases.find(d=>d.name===old.name);
    need(current && equal({...old,acl:null},{...current,acl:null}),"RUNTIME_ACCESS_DATABASE_IDENTITY_CHANGED");
    const own=old.name===plan.database;
    if (!own && policy.action!=="replace-public-connect") need(equal(old,current),"RUNTIME_ACCESS_PROVIDER_DATABASE_CHANGED");
    else need(changedAclAllowed(old.acl,current.acl,{removedPublic:own?["CONNECT","TEMPORARY","CREATE"]:["CONNECT"],
      added:own?[{oid:runtime.oid,privileges:["CONNECT"]},{oid:scaler.oid,privileges:["CONNECT"]}]:policy.preserveConnectRoles.map(r=>({oid:r.oid,privileges:["CONNECT"]}))}),"RUNTIME_ACCESS_DATABASE_ACL_UNPROVEN");
  }
  const newDefaults=after.defaults.filter(d=>d.role===runtime.name);
  need(equal(before.defaults,after.defaults.filter(d=>d.role!==runtime.name)) && newDefaults.length===1 && newDefaults[0].schemaOid==="0"
    && newDefaults[0].kind==="f" && newDefaults[0].acl.every(a=>a.grantee===runtime.oid && a.privilege==="EXECUTE"),"RUNTIME_ACCESS_DEFAULT_PRIVILEGES_UNPROVEN");
}

async function readSnapshot(client,plan) { return observePostgresRuntimeAccessCatalog({client,plan}); }
function verifyForeignConnect(rows, policy) {
  const expected = new Map(policy.isolation.databases.map(db => [db.name, db]));
  need(rows.length === expected.size && new Set(rows.map(row => row.name)).size === expected.size,
    "RUNTIME_ACCESS_FOREIGN_CONNECT_INVENTORY_CHANGED");
  for (const row of rows) {
    const db = expected.get(row.name);
    need(db && row.oid === db.oid, "RUNTIME_ACCESS_FOREIGN_CONNECT_INVENTORY_CHANGED");
    need(row.allowed === (db.action === "allow-provider-connect"), "RUNTIME_ACCESS_FOREIGN_CONNECT_ALLOWED");
  }
}
function verifyMonitoredForeignConnect(rows, policy) {
  const provider = new Map(policy.isolation.databases.filter(db => db.action === "allow-provider-connect")
    .map(db => [db.name, db]));
  need(new Set(rows.map(row => row.name)).size === rows.length,
    "RUNTIME_ACCESS_FOREIGN_CONNECT_INVENTORY_CHANGED");
  for (const row of rows) {
    const approved = provider.get(row.name);
    if (approved) need(row.oid === approved.oid && row.allowed === true,
      "RUNTIME_ACCESS_PROVIDER_EXCEPTION_CHANGED");
    else need(row.allowed === false, "RUNTIME_ACCESS_FOREIGN_CONNECT_ALLOWED");
  }
  need([...provider.keys()].every(name => rows.some(row => row.name === name)),
    "RUNTIME_ACCESS_PROVIDER_EXCEPTION_CHANGED");
}
async function readForeignConnect(client, role, database) {
  return (await client.query(`SELECT datname AS name,oid::text AS oid,
    datallowconn AND pg_catalog.has_database_privilege($1,oid,'CONNECT') AS allowed
    FROM pg_catalog.pg_database WHERE datname<>$2 ORDER BY datname`, [role, database])).rows;
}
export async function preparePostgresRuntimeAccessPreflight(options) {
  const plan=validatePlan(options.plan,true), check=guards(options,true); validateClient(options.client,plan);
  let transaction=false;
  try {
    await check("PREFLIGHT"); await credentials(plan,options.resolveSecretVersion);
    await options.client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"); transaction=true;
    await suppressSensitiveSql(options.client,plan.policy,options.readAzureParameters,options.inspectAzureQueryStore);
    const manifest=await readSnapshot(options.client,{...plan,databaseOid:undefined});
    need(manifest.identity.database==="postgres", "RUNTIME_ACCESS_PREFLIGHT_DATABASE_INVALID");
    isolationBefore(manifest,plan);
    await options.client.query("ROLLBACK"); transaction=false; await check("PREFLIGHT_COMPLETE");
    return {schemaVersion:1,complete:true,domain:plan.domain,policySha256:hash(plan.policy),inventorySha256:plan.policy.isolation.inventorySha256,
      runtimeCredentialVersions:{...plan.policy.runtimeDatabaseSecrets,scaler:plan.policy.scaler.connectionSecretVersion},loggingSuppression:true};
  } catch(error) { if(transaction) await options.client.query("ROLLBACK").catch(()=>{}); throw safeError(error); }
}
export async function preparePostgresRuntimeAccess(options) {
  const plan=validatePlan(options.plan),check=guards(options); validateClient(options.client,plan);
  let transaction=false;
  try {
    await check("PREPARE"); await credentials(plan,options.resolveSecretVersion);
    await options.client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"); transaction=true;
    const before=await readSnapshot(options.client,plan); isolationBefore(before,plan); objectActions(before,plan);
    await suppressSensitiveSql(options.client,plan.policy,options.readAzureParameters,options.inspectAzureQueryStore); await options.client.query("ROLLBACK"); transaction=false;
    await check("PREPARE_COMPLETE");
    const body={schemaVersion:1,plan:structuredClone(plan),before,beforeSha256:hash(before)};
    return {...body,sha256:hash(body)};
  } catch(error) { if(transaction) await options.client.query("ROLLBACK").catch(()=>{}); throw safeError(error); }
}
export function validatePostgresRuntimeAccessIntent(intent) {
  need(exact(intent,["schemaVersion","plan","before","beforeSha256","sha256"]) && intent.schemaVersion===1, "RUNTIME_ACCESS_INTENT_INVALID");
  validatePlan(intent.plan); const {sha256,...body}=intent;
  need(sha256===hash(body) && intent.beforeSha256===hash(intent.before),"RUNTIME_ACCESS_INTENT_HASH_MISMATCH");
  isolationBefore(intent.before,intent.plan); objectActions(intent.before,intent.plan); return intent;
}
function receipt(intent,status,manifest) {
  return {schemaVersion:1,status,domain:intent.plan.domain,globalIntentSha256:intent.plan.intentSha256,intentSha256:intent.sha256,
    policySha256:hash(intent.plan.policy),databaseOid:intent.plan.databaseOid,manifestSha256:hash(manifest),
    runtimeCredentialVersions:{...intent.plan.policy.runtimeDatabaseSecrets,scaler:intent.plan.policy.scaler.connectionSecretVersion}};
}
async function authenticateRoles({intent,client,clientFactory=config=>new pg.Client(config)},secrets,check) {
  const p=intent.plan;
  for (const kind of ["web","scaler"]) {
    const secret=secrets[kind]; let connection;
    try {
      await check("AUTHENTICATE_ROLE");
      connection=clientFactory({host:p.host,port:p.port,database:p.database,user:secret.role,password:secret.password,
        ssl:client.connectionParameters.ssl,connectionTimeoutMillis:10000,query_timeout:15000,application_name:"corgtex_runtime_access_verify"});
      await connection.connect();
      need(connection.connection?.stream?.encrypted===true && connection.connection.stream.authorized===true,"RUNTIME_ACCESS_ROLE_TLS_UNPROVEN");
      const identity=(await connection.query(`SELECT current_user AS role,current_database() AS database,oid::text AS oid FROM pg_catalog.pg_database WHERE datname=current_database()`)).rows;
      need(identity.length===1 && identity[0].role===secret.role && identity[0].database===p.database && identity[0].oid===p.databaseOid,"RUNTIME_ACCESS_ROLE_AUTHENTICATION_FAILED");
      const isolation=await readForeignConnect(connection, secret.role, p.database);
      verifyForeignConnect(isolation,p.policy);
      if (kind==="scaler") await verifyWorkerScalerAccess({client:connection,database:p.database,role:secret.role});
      else {
        const access=(await connection.query(`SELECT pg_catalog.has_schema_privilege(current_user,'public','USAGE') AS usage,
          pg_catalog.has_schema_privilege(current_user,'public','CREATE') AS create`)).rows[0];
        need(access?.usage && access.create,"RUNTIME_ACCESS_SCHEMA_ACCESS_UNPROVEN");
      }
    } finally { if(connection) await connection.end().catch(()=>{}); }
  }
  await check("AUTHENTICATION_COMPLETE");
}

export async function applyPostgresRuntimeAccess(options) {
  const intent=validatePostgresRuntimeAccessIntent(options.intent),p=intent.plan,client=options.client,check=guards(options); validateClient(client,p);
  need(typeof options.persistIntent==="function" && typeof options.persistExpectedAfter==="function" && typeof options.readRecords==="function","RUNTIME_ACCESS_RECORD_STORE_REQUIRED");
  let transaction=false,commitAttempted=false;
  try {
    await check("APPLY_ADMISSION"); const secrets=await credentials(p,options.resolveSecretVersion);
    const existing=await options.readRecords(); need(!existing?.intent && !existing?.expectedAfter,"RUNTIME_ACCESS_RECONCILIATION_REQUIRED");
    await options.persistIntent(intent);
    need(equal((await options.readRecords())?.intent,intent),"RUNTIME_ACCESS_INTENT_RETENTION_UNPROVEN");
    await check("BEGIN"); await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE"); transaction=true;
    await client.query("SET LOCAL lock_timeout='5s'"); await client.query("SET LOCAL statement_timeout='30s'");
    const before=await readSnapshot(client,p); need(equal(before,intent.before),"RUNTIME_ACCESS_BEFORE_CHANGED");
    await suppressSensitiveSql(client,p.policy,options.readAzureParameters,options.inspectAzureQueryStore);
    const mutate=async sql=>{await check("SQL_MUTATION"); await client.query(sql);};
    await mutate(`CREATE ROLE ${q(p.policy.runtimeRole)} LOGIN PASSWORD '${scram(secrets.web.password)}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT -1`);
    await mutate(`GRANT ${q(p.policy.runtimeRole)} TO ${q(p.administrator)} WITH SET TRUE, INHERIT TRUE`);
    await mutate(`GRANT USAGE,CREATE ON SCHEMA public TO ${q(p.policy.runtimeRole)}`);
    await mutate(`REVOKE CONNECT,TEMPORARY,CREATE ON DATABASE ${q(p.database)} FROM PUBLIC`);
    await mutate(`GRANT CONNECT ON DATABASE ${q(p.database)} TO ${q(p.policy.runtimeRole)}`);
    for(const db of p.policy.isolation.databases) if(db.action==="replace-public-connect") {
      await mutate(`REVOKE CONNECT ON DATABASE ${q(db.name)} FROM PUBLIC`);
      for(const role of db.preserveConnectRoles) await mutate(`GRANT CONNECT ON DATABASE ${q(db.name)} TO ${q(role.name)}`);
    }
    for(const {object,kind} of objectActions(before,p).actions) {
      await mutate(`ALTER ${kind} ${object.identity} OWNER TO ${q(p.policy.runtimeRole)}`);
      if(object.catalog==="pg_proc") await mutate(`REVOKE EXECUTE ON ${kind} ${object.identity} FROM PUBLIC`);
    }
    await mutate(`ALTER DEFAULT PRIVILEGES FOR ROLE ${q(p.policy.runtimeRole)} REVOKE EXECUTE ON ROUTINES FROM PUBLIC`);
    await provisionWorkerScalerRoleInTransaction({client:{query:async(...args)=>{await check("SCALER_PROVISION");return client.query(...args);}},database:p.database,
      role:p.policy.scaler.role,passwordVerifier:scram(secrets.scaler.password),administrator:p.administrator});
    const after=await readSnapshot(client,p); validateAfter(before,after,p);
    if (p.policy.schemaVersion === 2) await suppressSensitiveSql(client,p.policy,options.readAzureParameters,options.inspectAzureQueryStore);
    // Effective foreign CONNECT must already be denied before committing either login.
    for(const role of [p.policy.runtimeRole,p.policy.scaler.role]) {
      verifyForeignConnect(await readForeignConnect(client,role,p.database),p.policy);
    }
    const expectedAfter={schemaVersion:1,intentSha256:intent.sha256,manifest:after,manifestSha256:hash(after)};
    await options.persistExpectedAfter(expectedAfter);
    const retained=await options.readRecords(); need(equal(retained.intent,intent) && equal(retained.expectedAfter,expectedAfter),"RUNTIME_ACCESS_AFTER_RETENTION_UNPROVEN");
    if (p.policy.schemaVersion === 2) await suppressSensitiveSql(client,p.policy,options.readAzureParameters,options.inspectAzureQueryStore);
    await check("COMMIT"); commitAttempted=true; await client.query("COMMIT"); transaction=false;
    const actual=await readSnapshot(client,p); need(equal(actual,after),"RUNTIME_ACCESS_POST_COMMIT_DRIFT");
    if (p.policy.schemaVersion === 2) await suppressSensitiveSql(client,p.policy,options.readAzureParameters,options.inspectAzureQueryStore);
    await authenticateRoles(options,secrets,check);
    return {...receipt(intent,"APPLIED",actual),credentialAuthentication:{complete:true,runtimeRole:p.policy.runtimeRole,scalerRole:p.policy.scaler.role},isolation:{complete:true}};
  } catch(error) {
    if(transaction && !commitAttempted) {
      try { await client.query("ROLLBACK"); } catch { throw new PostgresRuntimeAccessError("RUNTIME_ACCESS_ROLLBACK_UNCERTAIN"); }
    }
    if(commitAttempted) throw new PostgresRuntimeAccessError("RUNTIME_ACCESS_RECONCILIATION_REQUIRED");
    throw safeError(error);
  }
}
export async function reconcilePostgresRuntimeAccess(options) {
  const intent=validatePostgresRuntimeAccessIntent(options.intent),p=intent.plan,check=guards(options); validateClient(options.client,p);
  need(typeof options.readRecords==="function","RUNTIME_ACCESS_RECORD_STORE_REQUIRED");
  try {
    await check("RECONCILE"); const secrets=await credentials(p,options.resolveSecretVersion),records=await options.readRecords();
    need(equal(records?.intent,intent),"RUNTIME_ACCESS_INTENT_RETENTION_UNPROVEN");
    const actual=await readSnapshot(options.client,p),expected=records.expectedAfter;
    if (p.policy.schemaVersion === 2) await suppressSensitiveSql(options.client,p.policy,options.readAzureParameters,options.inspectAzureQueryStore);
    if(equal(actual,intent.before)) { await check("RECONCILE_COMPLETE"); return receipt(intent,"UNCHANGED",actual); }
    if(!expected || expected.intentSha256!==intent.sha256 || expected.manifestSha256!==hash(expected.manifest) || !equal(actual,expected.manifest)) {
      await check("RECONCILE_COMPLETE"); return receipt(intent,"INDETERMINATE",actual);
    }
    validateAfter(intent.before,actual,p); await authenticateRoles(options,secrets,check);
    return {...receipt(intent,"APPLIED",actual),credentialAuthentication:{complete:true,runtimeRole:p.policy.runtimeRole,scalerRole:p.policy.scaler.role},isolation:{complete:true}};
  } catch(error) { throw safeError(error); }
}

/** Read-only drift check for an active Azure target. Application object catalogs
 * may change after activation; database ACLs and capture controls may not. */
export async function monitorPostgresRuntimeAccessDrift(options) {
  const intent=validatePostgresRuntimeAccessIntent(options.intent),p=intent.plan,client=options.client;
  need(p.policy.schemaVersion===2,"RUNTIME_ACCESS_AZURE_PROFILE_REQUIRED");
  validateClient(client,p);
  const expected=options.expectedAfter;
  need(expected?.schemaVersion===1 && expected.intentSha256===intent.sha256
    && expected.manifestSha256===hash(expected.manifest),"RUNTIME_ACCESS_AFTER_RETENTION_UNPROVEN");
  const identity=(await client.query(`SELECT current_database() AS database,current_user AS administrator,
    session_user AS "sessionUser",current_setting('server_version_num')::int AS version`)).rows[0];
  need(identity?.database===p.database && identity.administrator===p.administrator
    && identity.sessionUser===p.administrator && Math.floor(identity.version/10000)===18,
  "RUNTIME_ACCESS_DATABASE_IDENTITY_CHANGED");
  const databases=(await client.query(DATABASE_SQL)).rows;
  const pinned = new Set([p.database,"postgres","template0","template1","azure_sys","azure_maintenance"]);
  need(databases.length > 0 && databases.length <= 1000
    && [...pinned].every(name => {
      const before = expected.manifest.databases.find(row => row.name === name);
      const current = databases.find(row => row.name === name);
      return !before || equal(before,current);
    }) && databases.some(row => row.name === p.database && row.oid === p.databaseOid),
  "RUNTIME_ACCESS_DATABASE_DRIFT");
  const profileSha256=await suppressSensitiveSql(client,p.policy,options.readAzureParameters,options.inspectAzureQueryStore);
  for(const role of [p.policy.runtimeRole,p.policy.scaler.role])
    verifyMonitoredForeignConnect(await readForeignConnect(client,role,p.database),p.policy);
  return {schemaVersion:1,complete:true,domain:p.domain,intentSha256:intent.sha256,
    databasesSha256:hash(databases),profileSha256};
}
