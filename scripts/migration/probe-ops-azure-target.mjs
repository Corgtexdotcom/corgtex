#!/usr/bin/env node
// Private metadata-only probe. Parent owns credentials, access, start/stop and costs.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

export const RESOURCE = "/subscriptions/227eb707-bc46-415e-a09b-7d2b69fb14b2/resourceGroups/rg-corgtex-migration-rehearsal/providers/Microsoft.DBforPostgreSQL/flexibleServers/corgtex-mig-reh-restore-pg";
export const HOST = "corgtex-mig-reh-restore-pg.postgres.database.azure.com";
const hash = (v) => createHash("sha256").update(v).digest("hex");
export class ProbeError extends Error { constructor(code) { super(code); this.code = code; } }
const check = (v, code) => { if (!v) throw new ProbeError(code); };
export const OPTIONS = "-c default_transaction_read_only=on -c statement_timeout=5000 -c lock_timeout=1000 -c idle_in_transaction_session_timeout=15000 -c transaction_timeout=60000 -c search_path=pg_catalog -c row_security=on";
export const SQL = {
  guard: `SELECT current_setting('default_transaction_read_only') AS default_ro,
current_setting('transaction_read_only') AS ro,current_setting('transaction_isolation') AS isolation,
current_setting('statement_timeout') AS statement_timeout,current_setting('lock_timeout') AS lock_timeout,
current_setting('idle_in_transaction_session_timeout') AS idle_timeout,current_setting('transaction_timeout') AS transaction_timeout,
current_setting('search_path') AS search_path,current_setting('row_security') AS row_security,
current_database()='postgres' AS database_ok,current_user='corgtexadmin' AS user_ok`,
  settings: `SELECT current_setting('server_version_num')::int AS version,
pg_encoding_to_char(encoding) AS encoding,datlocprovider::text AS provider,datcollate AS collation,
datctype AS ctype,datlocale AS provider_locale,daticurules AS icu_rules,datcollversion AS recorded,
pg_database_collation_actual_version(oid) AS actual
FROM pg_catalog.pg_database WHERE datname=current_database()`,
  collations: `SELECT n.nspname AS schema,c.collname AS name,c.collencoding AS encoding,
c.collprovider::text AS provider,c.collisdeterministic AS deterministic,c.collcollate AS collation,
c.collctype AS ctype,c.collversion AS recorded,pg_catalog.pg_collation_actual_version(c.oid) AS actual
FROM pg_catalog.pg_collation c JOIN pg_catalog.pg_namespace n ON n.oid=c.collnamespace
WHERE n.nspname='pg_catalog' AND c.collprovider='c' AND c.collname IN ('en_US.utf8','en_US')
AND c.collencoding IN (-1,6) ORDER BY c.collname,c.collencoding LIMIT 11`,
  vector: `SELECT name,version,installed FROM pg_catalog.pg_available_extension_versions
WHERE name='vector' AND version='0.8.2' LIMIT 3`,
  installed: `SELECT e.extname AS name,e.extversion AS version,n.nspname AS schema
FROM pg_catalog.pg_extension e JOIN pg_catalog.pg_namespace n ON n.oid=e.extnamespace
WHERE e.extname IN ('vector','plpgsql') ORDER BY e.extname LIMIT 3`,
  capacity: `SELECT current_setting('max_connections')::int AS max_connections,
current_setting('reserved_connections')::int AS reserved_connections,
current_setting('superuser_reserved_connections')::int AS superuser_reserved_connections,
EXISTS(SELECT 1 FROM pg_catalog.regexp_split_to_table(current_setting('azure.extensions'), ',') AS t(value)
WHERE lower(btrim(value))='vector') AS vector_allowlisted`,
};

export function guard(r, isolation) {
  check(r?.default_ro === "on" && r.ro === "on" && r.isolation === isolation
    && r.statement_timeout === "5s" && r.lock_timeout === "1s" && r.idle_timeout === "15s"
    && r.transaction_timeout === "1min" && r.search_path === "pg_catalog" && r.row_security === "on"
    && r.database_ok === true && r.user_ok === true, "READONLY_GUARD_FAILED");
}

export async function connectionConfig(env) {
  check(env.TARGET_POSTGRES_RESOURCE_ID === RESOURCE && env.TARGET_POSTGRES_HOST === HOST
    && env.TARGET_POSTGRES_ADMIN_USER === "corgtexadmin"
    && (env.TARGET_POSTGRES_PORT === undefined || env.TARGET_POSTGRES_PORT === "5432"), "TARGET_IDENTITY_MISMATCH");
  check(typeof env.TARGET_POSTGRES_ADMIN_PASSWORD === "string" && env.TARGET_POSTGRES_ADMIN_PASSWORD.length > 0,
    "TARGET_CREDENTIAL_MISSING");
  check(env.NODE_TLS_REJECT_UNAUTHORIZED !== "0", "TLS_DISABLED");
  const { targetDatabaseConfigFromEnv, nodeClientConfig } = await import("./run-postgres-restore-rehearsal.mjs");
  const base = targetDatabaseConfigFromEnv(env, "postgres");
  const config = { ...nodeClientConfig(base, "corgtex_ops_target_metadata", 5000, 5000), options: OPTIONS };
  check(config.host === HOST && config.database === "postgres" && config.ssl.rejectUnauthorized === true
    && !config.ssl.checkServerIdentity, "TLS_CONFIG_INVALID");
  return config;
}

export function sanitize(error) {
  return { status: "TARGET_METADATA_FAILED", code: error instanceof ProbeError ? error.code : "CONNECTION_OR_QUERY_FAILED",
    sqlState: typeof error?.code === "string" && /^[0-9A-Z]{5}$/u.test(error.code) ? error.code : null,
    rawErrorSuppressed: true };
}

export async function capture(client, { deadlineMs = 60000, closeMs = 3000 } = {}) {
  let timer, closeTimer, expired = false, transaction = false, rollback = false, disconnected = false;
  const query = async (sql) => {
    check(!expired, "DEADLINE");
    const result = await client.query(sql);
    check(!expired, "DEADLINE");
    return result;
  };
  const work = async () => {
    await client.connect();
    guard((await query(SQL.guard)).rows[0], "read committed");
    check((await query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")).command === "BEGIN", "BEGIN_UNPROVEN"); transaction = true;
    guard((await query(SQL.guard)).rows[0], "repeatable read");
    const metadata = {};
    for (const [key, cap] of [["settings", 1], ["collations", 10], ["vector", 2], ["installed", 2], ["capacity", 1]]) {
      const result = await query(SQL[key]);
      check(Array.isArray(result.rows) && result.rows.length <= cap && Buffer.byteLength(JSON.stringify(result.rows)) <= 16384, "METADATA_LIMIT");
      if (cap === 1) check(result.rows.length === 1, "METADATA_MISSING");
      metadata[key] = result.rows;
    }
    check((await query("ROLLBACK")).command === "ROLLBACK", "ROLLBACK_UNPROVEN"); transaction = false; rollback = true;
    return metadata;
  };
  let result, failure;
  try {
    result = await Promise.race([work(), new Promise((_, reject) => {
      timer = setTimeout(() => { expired = true; client.connection?.stream?.destroy(); reject(new ProbeError("DEADLINE")); }, deadlineMs);
    })]);
  } catch (error) { failure = error; }
  finally {
    clearTimeout(timer);
    // Closing an open transaction rolls it back; it is not a successful explicit rollback receipt.
    try {
      await Promise.race([client.end().then(() => { disconnected = true; }), new Promise((_, reject) => {
        closeTimer = setTimeout(() => { client.connection?.stream?.destroy(); reject(new ProbeError("DISCONNECT_TIMEOUT")); }, closeMs);
      })]);
    } catch (error) { failure ??= error; }
    clearTimeout(closeTimer);
  }
  if (failure) throw failure;
  check(!transaction && rollback && disconnected, "CLEANUP_UNPROVEN");
  const settings = result.settings[0], capacity = result.capacity[0];
  check([capacity.max_connections, capacity.reserved_connections, capacity.superuser_reserved_connections]
    .every((n) => Number.isInteger(n) && n >= 0), "CAPACITY_SHAPE");
  const ordinarySlots = capacity.max_connections - capacity.reserved_connections - capacity.superuser_reserved_connections;
  check(ordinarySlots >= 0, "CAPACITY_SHAPE");
  const localeCandidates = result.collations.filter((c) => c.provider === "c" && c.collation === "en_US.utf8"
    && c.ctype === "en_US.utf8" && c.deterministic === true && c.recorded === "2.41" && c.actual === "2.41");
  return { status: "TARGET_METADATA_CAPTURED", resource: RESOURCE, host: HOST, database: "postgres",
    at: new Date().toISOString(), readonlyGuards: true, rollback, disconnected, tlsVerificationRequired: true,
    metadata: result, ordinaryConnectionSlots: ordinarySlots,
    comparison: { pg180006: settings.version === 180006,
      sourceLocaleAvailable: localeCandidates.length > 0,
      vector082Available: result.vector.some((v) => v.name === "vector" && v.version === "0.8.2"),
      vectorAllowlisted: capacity.vector_allowlisted === true },
    productionAccepted: false,
    limits: "Existing postgres metadata only; no scratch/extension installation, source reads, restore, table data, workload capacity, production acceptance, firewall cleanup or cost-accounting proof." };
}

async function main() {
  if (!process.argv.slice(2).length) { console.log(JSON.stringify({ status: "NO_EXECUTION", resource: RESOURCE, mode: "--execute", independentQaRequired: true })); return; }
  check(process.argv.length === 3 && process.argv[2] === "--execute", "INVALID_ARGUMENTS");
  const config = await connectionConfig(process.env);
  const { default: { Client } } = await import("pg");
  const receipt = await capture(new Client(config));
  receipt.scriptSha256 = hash(readFileSync(fileURLToPath(import.meta.url)));
  const bytes = JSON.stringify(receipt, null, 2) + "\n";
  check(Buffer.byteLength(bytes) <= 65536, "RECEIPT_LIMIT");
  const path = new URL(`ops-azure-target-metadata-${Date.now()}.json`, import.meta.url);
  writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ status: receipt.status, comparison: receipt.comparison, rollback: true, disconnected: true, receipt: fileURLToPath(path) }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.log(JSON.stringify(sanitize(error))); process.exitCode = 1; });
}
