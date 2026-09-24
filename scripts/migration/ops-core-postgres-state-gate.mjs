import pg from "pg";
import { archiveEvidenceHash } from "./ops-core-archive.mjs";
import { observeRedisEmpty, redisGateBindingSha256, redisEmptyGateDiagnostic } from "./ops-core-redis-gate.mjs";
import { nodeClientConfig } from "./run-postgres-restore-rehearsal.mjs";

const HASH = /^[a-f0-9]{64}$/;
export const POSTGRES_SHARED_STATE_MIGRATION = "20260923120000_postgres_shared_state";
const columns = {
  PendingTranscriptUpload: [["id", "text"], ["workspaceId", "text"], ["encryptedPayload", "text"], ["expiresAt", "timestamp(3) without time zone"], ["createdAt", "timestamp(3) without time zone"]],
  SharedCacheEntry: [["id", "text"], ["encryptedPayload", "text"], ["expiresAt", "timestamp(3) without time zone"]],
  SharedCacheVersion: [["id", "text"], ["version", "integer"]],
  SharedRateLimit: [["id", "text"], ["timestamps", "bigint[]"], ["expiresAt", "timestamp(3) without time zone"]],
};
const TABLES = Object.keys(columns);
class GateError extends Error {
  constructor(code) { super(code); this.name = "PostgresSharedStateGateError"; this.code = code; }
}
const requireValue = (condition, code) => { if (!condition) throw new GateError(code); };
export const postgresSharedStateGateDiagnostic = error => error instanceof GateError ? error.code : null;

/** Read-only migration gate. A new verified-TLS session targets the promoted DB,
 * never the controller's postgres administration session. Source Redis is read
 * twice in full; no target Redis instance or fabricated Redis receipt is used. */
export async function assertOpsCorePostgresStateEmpty({ sourceRedis: sourceValue, sourceCredentials,
  targetAdminConfig: configValue, targetDatabaseOid, targetBindingSha256, custody,
  assertSourceFenced, assertTargetInactive, createPostgresClient = config => new pg.Client(config),
  createRedisClient, maxScanPages = 100, timeoutMs = 30_000 }) {
  let client;
  let abort;
  let signal;
  let ending;
  const close = () => {
    if (client && !ending) ending = Promise.resolve().then(() => client.end()).catch(() => {});
    return ending;
  };
  try {
    const sourceRedis = structuredClone(sourceValue), config = structuredClone(configValue);
    const sourceBindingSha256 = redisGateBindingSha256(sourceRedis);
    requireValue(sourceRedis.mode === "standalone", "POSTGRES_STATE_SOURCE_ENTERPRISE_UNPROVEN");
    requireValue(custody?.signal instanceof AbortSignal && typeof custody.assertOwned === "function"
      && typeof custody.snapshot === "function" && typeof assertSourceFenced === "function"
      && typeof assertTargetInactive === "function" && typeof createPostgresClient === "function", "POSTGRES_STATE_CUSTODY_REQUIRED");
    requireValue(HASH.test(targetBindingSha256) && /^[1-9][0-9]*$/.test(targetDatabaseOid)
      && Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 30_000, "POSTGRES_STATE_BINDING_INVALID");
    signal = custody.signal;
    const initial = custody.snapshot(), initialSha256 = archiveEvidenceHash(initial);
    const sourceFenceSha256 = initial.history?.find(entry => entry.phase === "SOURCE_FENCED")?.evidenceSha256;
    requireValue(["core", "ops"].includes(initial.domain) && HASH.test(initial.intentSha256)
      && HASH.test(sourceFenceSha256) && initial.phase === "RESTORED" && initial.pending?.to === "VERIFIED"
      && initial.destinationMayHaveWritten === false, "POSTGRES_STATE_SOURCE_FENCE_REQUIRED");
    requireValue(config?.sslmode === "verify-full" && config.database === "postgres"
      && typeof config.host === "string" && config.host.endsWith(".postgres.database.azure.com") && config.port === 5432
      && typeof config.user === "string" && config.user.length > 0
      && typeof config.targetTlsRootCert === "string" && config.targetTlsRootCert.length > 0,
    "POSTGRES_STATE_TARGET_CONFIG_INVALID");
    const database = `corgtex_${initial.domain}`;
    const signalCheck = () => requireValue(!signal.aborted, "POSTGRES_STATE_ABORTED");
    const snapshotCheck = () => requireValue(archiveEvidenceHash(custody.snapshot()) === initialSha256, "POSTGRES_STATE_CUSTODY_CHANGED");
    const check = async () => {
      signalCheck(); await custody.assertOwned(); signalCheck(); snapshotCheck();
      const source = await assertSourceFenced(); signalCheck(); snapshotCheck();
      requireValue(source?.complete === true && source.domain === initial.domain && source.intentSha256 === initial.intentSha256
        && source.sourceFenceSha256 === sourceFenceSha256, "POSTGRES_STATE_SOURCE_UNFENCED");
      const target = await assertTargetInactive(); signalCheck(); snapshotCheck();
      requireValue(target?.complete === true && target.domain === initial.domain && target.intentSha256 === initial.intentSha256
        && target.targetBindingSha256 === targetBindingSha256, "POSTGRES_STATE_TARGET_ACTIVE");
      await custody.assertOwned(); signalCheck(); snapshotCheck();
    };
    const sourceScan = async () => {
      await check();
      const result = await observeRedisEmpty({ binding: sourceRedis, credentials: sourceCredentials, side: "SOURCE", signal,
        maxScanPages, connectTimeoutMs: timeoutMs, ...(createRedisClient ? { createClient: createRedisClient } : {}) });
      await check(); return result;
    };
    const sourceBefore = await sourceScan();
    const clientConfig = { ...nodeClientConfig({ ...config, database }, `corgtex_${initial.domain}_shared_state_gate`, timeoutMs, timeoutMs),
      statement_timeout: timeoutMs, options: `-c default_transaction_read_only=on -c statement_timeout=${timeoutMs} -c lock_timeout=${timeoutMs} -c idle_in_transaction_session_timeout=${timeoutMs}` };
    client = createPostgresClient(clientConfig);
    requireValue(client && typeof client.connect === "function" && typeof client.query === "function" && typeof client.end === "function",
      "POSTGRES_STATE_CLIENT_INVALID");
    const bounded = async work => {
      signalCheck();
      let timer, cancel;
      const cancelled = new Promise((_, reject) => {
        cancel = () => { void close(); reject(new GateError("POSTGRES_STATE_ABORTED")); };
        signal.addEventListener("abort", cancel, { once: true });
        timer = setTimeout(() => { void close(); reject(new GateError("POSTGRES_STATE_READ_TIMEOUT")); }, timeoutMs);
      });
      try { const result = await Promise.race([Promise.resolve().then(() => { signalCheck(); return work(); }), cancelled]); signalCheck(); return result; }
      finally { clearTimeout(timer); signal.removeEventListener("abort", cancel); }
    };
    abort = () => { void close(); };
    signal.addEventListener("abort", abort, { once: true });
    await bounded(() => client.connect());
    const query = (sql, values) => bounded(() => client.query(sql, values));
    const observe = async () => {
      await check();
      await query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const identity = (await query(`SELECT current_database() AS database, session_user, current_user AS role_user,
        current_setting('server_version_num')::int AS version_num, current_setting('transaction_read_only') AS read_only,
        (SELECT oid::text FROM pg_catalog.pg_database WHERE datname = current_database()) AS oid,
        ssl.ssl AS tls, ssl.version AS tls_version FROM pg_catalog.pg_stat_ssl ssl WHERE ssl.pid = pg_backend_pid()`)).rows;
      const actual = identity[0];
      requireValue(identity.length === 1 && actual.database === database && actual.oid === targetDatabaseOid
        && actual.session_user === config.user && actual.role_user === config.user
        && actual.version_num >= 180000 && actual.version_num < 190000 && actual.read_only === "on"
        && actual.tls === true && ["TLSv1.2", "TLSv1.3"].includes(actual.tls_version), "POSTGRES_STATE_DATABASE_UNPROVEN");
      const migrations = (await query(`SELECT migration_name, finished_at IS NOT NULL AS finished, rolled_back_at IS NULL AS active
        FROM public._prisma_migrations WHERE migration_name = $1`, [POSTGRES_SHARED_STATE_MIGRATION])).rows;
      requireValue(migrations.length === 1 && migrations[0].migration_name === POSTGRES_SHARED_STATE_MIGRATION
        && migrations[0].finished === true && migrations[0].active === true, "POSTGRES_STATE_MIGRATION_UNPROVEN");
      const schema = (await query(`SELECT c.relname AS table_name, c.relkind, c.relrowsecurity AS row_security,
        a.attname AS column_name, format_type(a.atttypid, a.atttypmod) AS data_type, a.attnotnull AS not_null
        FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
        WHERE n.nspname = 'public' AND c.relname = ANY($1::text[]) ORDER BY c.relname, a.attnum`, [TABLES])).rows;
      const expected = TABLES.flatMap(table => columns[table].map(([column, type]) => ({
        table_name: table, relkind: "r", row_security: false, column_name: column, data_type: type, not_null: true,
      })));
      requireValue(archiveEvidenceHash(schema) === archiveEvidenceHash(expected), "POSTGRES_STATE_SCHEMA_UNPROVEN");
      const counts = {};
      for (const table of TABLES) {
        // Table names are fixed code constants, never plan or operator input.
        const result = (await query(`SELECT count(*)::text AS count FROM public."${table}"`)).rows;
        requireValue(result.length === 1 && result[0].count === "0", "POSTGRES_STATE_TARGET_NOT_EMPTY");
        counts[table] = 0;
      }
      await query("COMMIT");
      await check();
      return { database, databaseOid: actual.oid, serverVersionNum: actual.version_num, sessionUser: actual.session_user,
        tls: { verified: true, version: actual.tls_version }, readOnly: true,
        migration: POSTGRES_SHARED_STATE_MIGRATION, schema, counts };
    };
    const targetBefore = await observe();
    const sourceAfter = await sourceScan();
    requireValue(sourceBefore.bindingSha256 === sourceBindingSha256 && sourceAfter.bindingSha256 === sourceBindingSha256,
      "POSTGRES_STATE_SOURCE_BINDING_CHANGED");
    const targetAfter = await observe();
    requireValue(archiveEvidenceHash(targetBefore) === archiveEvidenceHash(targetAfter), "POSTGRES_STATE_TARGET_CHANGED");
    await check();
    return { schemaVersion: 1, status: "POSTGRES_SHARED_STATE_ACCEPTED", domain: initial.domain,
      intentSha256: initial.intentSha256, sourceFenceSha256, targetBindingSha256,
      source: { before: sourceBefore, after: sourceAfter }, target: targetAfter };
  } catch (error) {
    if (error instanceof GateError) throw error;
    const redisCode = redisEmptyGateDiagnostic(error);
    throw new GateError(redisCode ?? "POSTGRES_STATE_READ_FAILED");
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
    await close();
  }
}
