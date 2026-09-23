import { createHash, createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";
import pg from "pg";
import { archiveEvidenceHash, readArchiveKeyVersion, validateArchiveKeyVersion } from "./ops-core-archive.mjs";
import { nodeClientConfig } from "./run-postgres-restore-rehearsal.mjs";

const HASH = /^[a-f0-9]{64}$/;
const KIND = "POSTGRES_ROTATE_RUNTIME_PASSWORD";
class FenceError extends Error {
  constructor(code) { super(code); Object.freeze(this); }
}
const fail = (code) => { throw new FenceError(code); };
export const postgresSourceFenceDiagnostic = (error) => error instanceof FenceError ? error.message : null;
const hash = (text) => createHash("sha256").update(text).digest("hex");
const sameConnection = (config, expected) => !config.connectionString
  && config.host === expected.host && config.port === expected.port
  && config.database === expected.database && config.user === expected.user;

// Passwords generated for this path are 32 random bytes encoded as ASCII base64,
// so PostgreSQL SASLprep leaves them unchanged. The verifier is also sensitive.
function scramVerifier(password) {
  const salt = randomBytes(16);
  const salted = pbkdf2Sync(password, salt, 4096, 32, "sha256");
  const clientKey = createHmac("sha256", salted).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest("base64");
  const serverKey = createHmac("sha256", salted).update("Server Key").digest("base64");
  salted.fill(0);
  clientKey.fill(0);
  return `SCRAM-SHA-256$4096:${salt.toString("base64")}$${storedKey}:${serverKey}`;
}

function newClient(config) {
  const client = new pg.Client({ ...nodeClientConfig(config, "corgtex_migration_source_fence", 10_000, 15_000),
    options: "-c statement_timeout=10000 -c lock_timeout=2000" });
  client.on("error", () => {});
  return client;
}
async function connected(config, action) {
  const client = newClient(config);
  try { await client.connect(); return await action(client); }
  finally { await client.end().catch(() => {}); }
}
function nonLoopback(address) {
  return typeof address === "string" && address !== "::1" && !address.startsWith("127.")
    && !address.toLowerCase().startsWith("::ffff:127.");
}
async function identity(client, expected, admin) {
  const row = (await client.query(`SELECT current_user::text AS current_role, session_user::text AS login,
    current_database()::text AS database, d.oid::text AS database_oid,
    inet_client_addr()::text AS client_address, inet_server_addr()::text AS server_address,
    inet_server_port() AS server_port, current_setting('server_version_num')::integer AS version,
    r.rolsuper AS superuser, pg_is_in_recovery() AS recovery FROM pg_database d CROSS JOIN pg_roles r
    WHERE d.datname=current_database() AND r.rolname=session_user`)).rows[0];
  const role = admin ? "postgres" : expected.readerRole;
  if (!row || row.login !== role || row.current_role !== role || row.database !== expected.connection.database
    || row.database_oid !== expected.databaseOid || !nonLoopback(row.client_address)
    || !row.server_address || row.version < 180000 || row.version >= 190000 || row.superuser !== admin || row.recovery) {
    fail("POSTGRES_FENCE_SERVER_BINDING_MISMATCH");
  }
  if (admin) {
    const system = (await client.query("SELECT system_identifier::text AS id FROM pg_control_system()")).rows[0];
    if (system?.id !== expected.systemIdentifier) fail("POSTGRES_FENCE_CLUSTER_MISMATCH");
  }
  return row;
}

async function probe(config, expected) {
  const client = newClient(config);
  try {
    try { await client.connect(); }
    catch (error) {
      if (error?.code === "28P01") return { accepted: false, rejectedByPassword: true };
      fail("POSTGRES_FENCE_AUTH_PROBE_UNPROVEN");
    }
    await identity(client, expected, true);
    return { accepted: true, rejectedByPassword: false };
  } finally { await client.end().catch(() => {}); }
}

async function readerPrivileges(client, expected) {
  const role = expected.readerRole;
  const roles = (await client.query(`SELECT rolname::text AS name,rolcanlogin,rolsuper,rolcreaterole,
    rolcreatedb,rolreplication,rolbypassrls,rolvaliduntil IS NULL OR rolvaliduntil>now() AS valid
    FROM pg_roles WHERE rolcanlogin OR rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls`)).rows;
  if (roles.some(row => !["postgres", role].includes(row.name))) fail("POSTGRES_FENCE_UNEXPECTED_PRIVILEGED_ROLE");
  const reader = roles.find(row => row.name === role);
  if (!reader?.rolcanlogin || !reader.valid || reader.rolsuper || reader.rolcreaterole || reader.rolcreatedb
    || reader.rolreplication || reader.rolbypassrls) fail("POSTGRES_FENCE_READER_ROLE_INVALID");
  const membership = (await client.query(`SELECT count(*)::integer AS count FROM pg_auth_members
    WHERE member=(SELECT oid FROM pg_roles WHERE rolname=$1)`, [role])).rows[0];
  if (membership.count !== 0) fail("POSTGRES_FENCE_READER_MEMBERSHIP_CHANGED");
  const counts = (await client.query(`SELECT
    (SELECT count(*)::integer FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE c.relkind IN ('r','p','v','m','f') AND n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema'
      AND (NOT has_table_privilege($1,c.oid,'SELECT') OR has_table_privilege($1,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER')
      OR has_any_column_privilege($1,c.oid,'INSERT,UPDATE'))) AS bad_tables,
    (SELECT count(*)::integer FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind='S'
      AND n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema'
      AND (NOT has_sequence_privilege($1,c.oid,'SELECT') OR has_sequence_privilege($1,c.oid,'USAGE,UPDATE'))) AS bad_sequences,
    (SELECT count(*)::integer FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname<>'information_schema'
      AND (NOT has_schema_privilege($1,oid,'USAGE') OR has_schema_privilege($1,oid,'CREATE'))) AS bad_schemas,
    (SELECT count(*)::integer FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE p.prosecdef AND n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema') AS security_definers,
    (SELECT count(*)::integer FROM pg_class WHERE relowner=(SELECT oid FROM pg_roles WHERE rolname=$1))
      +(SELECT count(*)::integer FROM pg_namespace WHERE nspowner=(SELECT oid FROM pg_roles WHERE rolname=$1))
      +(SELECT count(*)::integer FROM pg_proc WHERE proowner=(SELECT oid FROM pg_roles WHERE rolname=$1))
      +(SELECT count(*)::integer FROM pg_database WHERE datdba=(SELECT oid FROM pg_roles WHERE rolname=$1)) AS owned,
    has_database_privilege($1,current_database(),'CREATE') AS database_create,
    has_database_privilege($1,current_database(),'CONNECT') AS database_connect`, [role])).rows[0];
  if (!counts || counts.bad_tables || counts.bad_sequences || counts.bad_schemas || counts.security_definers
    || counts.owned || counts.database_create || !counts.database_connect) fail("POSTGRES_FENCE_READER_GRANTS_INVALID");
  const prepared = (await client.query("SELECT count(*)::integer AS count FROM pg_prepared_xacts")).rows[0];
  if (prepared.count !== 0) fail("POSTGRES_FENCE_PREPARED_TRANSACTIONS_PRESENT");
}

async function readerProbe(config, expected, server) {
  await connected(config, async client => {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    try {
      const observed = await identity(client, expected, false);
      if (observed.server_address !== server.server_address || observed.server_port !== server.server_port) {
        fail("POSTGRES_FENCE_READER_SERVER_CHANGED");
      }
      if ((await client.query("SHOW transaction_read_only")).rows[0].transaction_read_only !== "on") fail("POSTGRES_FENCE_READER_NOT_READONLY");
      const snapshot = (await client.query("SELECT pg_export_snapshot() AS snapshot")).rows[0];
      if (typeof snapshot?.snapshot !== "string") fail("POSTGRES_FENCE_READER_SNAPSHOT_FAILED");
    } finally { await client.query("ROLLBACK"); }
  });
}

// Session-only changes; monitoring elsewhere keeps its existing configuration.
// Neither plaintext passwords nor SCRAM verifiers may enter SQL activity,
// sampled statements, server error statements, or pg_stat_statements storage.
async function suppressSensitiveSql(client) {
  const settings = (await client.query(`SELECT name,setting FROM pg_settings WHERE name IN
    ('shared_preload_libraries','session_preload_libraries','local_preload_libraries')`)).rows;
  const loaded = Object.fromEntries(settings.map(row => [row.name, row.setting]));
  const modules = (loaded.shared_preload_libraries ?? "").split(",").map(value => value.trim()).filter(Boolean);
  if (modules.some(name => name !== "pg_stat_statements") || loaded.session_preload_libraries
    || loaded.local_preload_libraries) fail("POSTGRES_FENCE_LOGGING_HOOK_UNPROVEN");
  const required = {
    log_statement: "none", log_min_error_statement: "panic", log_parameter_max_length: "0",
    log_parameter_max_length_on_error: "0", log_duration: "off", log_min_duration_statement: "-1",
    log_min_duration_sample: "-1", log_statement_sample_rate: "0", log_transaction_sample_rate: "0",
    debug_print_parse: "off", debug_print_rewritten: "off", debug_print_plan: "off",
    log_parser_stats: "off", log_planner_stats: "off", log_executor_stats: "off", log_statement_stats: "off",
    track_activities: "off", client_min_messages: "error",
    ...(modules.includes("pg_stat_statements") ? { "pg_stat_statements.track": "none", "pg_stat_statements.track_utility": "off" } : {}),
  };
  for (const [name, value] of Object.entries(required)) {
    await client.query("SELECT set_config($1,$2,false)", [name, value]);
  }
  for (const [name, value] of Object.entries(required)) {
    if ((await client.query("SELECT current_setting($1) AS value", [name])).rows[0].value !== value) {
      fail("POSTGRES_FENCE_LOGGING_SUPPRESSION_FAILED");
    }
  }
}

async function context(options) {
  const { expected, sourceConfig, readerConfig, custody, retainedSecretVersion, vaultName,
    assertProviderFenced, assertDatabaseServiceCustody, resolveSecret = readArchiveKeyVersion } = options;
  if (!expected || !["ops", "core"].includes(expected.domain) || expected.connection?.user !== "postgres"
    || typeof expected.connection.host !== "string" || !Number.isInteger(expected.connection.port)
    || typeof expected.connection.database !== "string" || !/^[0-9]{1,20}$/.test(expected.systemIdentifier)
    || !/^[1-9][0-9]{0,9}$/.test(expected.databaseOid) || !HASH.test(expected.databaseServiceSha256)
    || !/^[a-z][a-z0-9_]{0,62}$/.test(expected.readerRole) || expected.readerRole === "postgres"
    || !sameConnection(sourceConfig, expected.connection) || typeof sourceConfig.password !== "string"
    || !sameConnection(readerConfig, { ...expected.connection, user: expected.readerRole })
    || typeof readerConfig.password !== "string" || typeof assertProviderFenced !== "function"
    || typeof assertDatabaseServiceCustody !== "function" || !custody?.signal) fail("POSTGRES_FENCE_INTENT_INVALID");
  if ([sourceConfig, readerConfig].some(config => !["disable", "require", "verify-full"].includes(config.sslmode)
    || config.ssl !== undefined)) fail("POSTGRES_FENCE_TLS_MODE_INVALID");
  validateArchiveKeyVersion(retainedSecretVersion, vaultName);
  const initial = custody.snapshot();
  if (initial.domain !== expected.domain || !HASH.test(initial.intentSha256)) fail("POSTGRES_FENCE_CUSTODY_MISMATCH");
  const check = async () => {
    custody.signal.throwIfAborted();
    await custody.assertOwned();
    await assertProviderFenced();
    await assertDatabaseServiceCustody();
    custody.signal.throwIfAborted();
    const current = custody.snapshot();
    if (current.domain !== initial.domain || current.intentSha256 !== initial.intentSha256
      || current.phase !== initial.phase || current.pending?.operationId !== initial.pending?.operationId) fail("POSTGRES_FENCE_CUSTODY_MISMATCH");
  };
  await check();
  const first = await resolveSecret(retainedSecretVersion, vaultName);
  let second;
  let password;
  try {
    second = await resolveSecret(retainedSecretVersion, vaultName);
    if (!Buffer.isBuffer(first) || !Buffer.isBuffer(second) || first.length !== 32 || second.length !== 32
      || !timingSafeEqual(first, second)) fail("POSTGRES_FENCE_RETAINED_SECRET_UNPROVEN");
    password = first.toString("base64");
  } finally { if (Buffer.isBuffer(first)) first.fill(0); if (Buffer.isBuffer(second)) second.fill(0); }
  if (password === sourceConfig.password) fail("POSTGRES_FENCE_PASSWORD_UNCHANGED");
  const recoveryConfig = { ...sourceConfig, password };
  const transportBinding = config => ({ mode: config.sslmode,
    certificateSha256: config.sslmode === "disable" ? null
      : hash(config.sslmode === "require" ? config.sourceTlsRootCert ?? "" : config.targetTlsRootCert ?? "") });
  const input = { expected, intentSha256: initial.intentSha256, retainedSecretVersion,
    transport: { source: transportBinding(sourceConfig), reader: transportBinding(readerConfig) } };
  return { ...options, recoveryConfig, password, input, check };
}

async function credentials(ctx) {
  await ctx.check();
  const old = await probe(ctx.sourceConfig, ctx.expected);
  const retained = await probe(ctx.recoveryConfig, ctx.expected);
  await ctx.check();
  if (old.accepted && retained.accepted) fail("POSTGRES_FENCE_PASSWORD_AUTH_BYPASSED");
  if (!old.accepted && !retained.accepted) fail("POSTGRES_FENCE_RECOVERY_ACCESS_UNPROVEN");
  return { complete: old.rejectedByPassword && retained.accepted,
    evidence: { oldPasswordRejected28P01: old.rejectedByPassword, retainedPasswordAccepted: retained.accepted,
      systemIdentifier: ctx.expected.systemIdentifier, databaseOid: ctx.expected.databaseOid,
      retainedSecretVersion: ctx.retainedSecretVersion } };
}

async function finalCensus(ctx) {
  const auth = await credentials(ctx);
  if (!auth.complete) fail("POSTGRES_FENCE_CREDENTIAL_ROTATION_UNPROVEN");
  await connected(ctx.recoveryConfig, async client => {
    const server = await identity(client, ctx.expected, true);
    await readerPrivileges(client, ctx.expected);
    await readerProbe(ctx.readerConfig, ctx.expected, server);
    const writers = (await client.query(`SELECT count(*)::integer AS count FROM pg_stat_activity
      WHERE backend_type='client backend' AND pid<>pg_backend_pid() AND usename<>$1`, [ctx.expected.readerRole])).rows[0];
    if (writers.count !== 0) fail("POSTGRES_FENCE_WRITERS_REMAIN");
    await ctx.check();
  });
  return { status: "POSTGRES_REMOTE_SOURCE_FENCED", ...auth.evidence, readerSnapshotVerified: true,
    unexpectedWriterSessions: 0, databaseServiceSha256: ctx.expected.databaseServiceSha256 };
}

async function sessionAbsent(ctx, client, input) {
  await ctx.check();
  const sessions = (await client.query(`SELECT backend_start::text AS started FROM pg_stat_activity
    WHERE pid=$1 AND usename='postgres' AND backend_type='client backend'`, [input.pid])).rows;
  const absent = !sessions.some(session => hash(session.started) === input.backendStartSha256);
  return { complete: absent, evidence: { pid: input.pid, backendStartSha256: input.backendStartSha256, absent } };
}

async function reconcileSessions(ctx, client) {
  const pending = ctx.resumeSessionOperations ?? [];
  if (!Array.isArray(pending) || pending.length > 2000) fail("POSTGRES_FENCE_RECOVERY_DESCRIPTOR_INVALID");
  for (const descriptor of pending) {
    const input = descriptor?.input;
    if (descriptor?.kind !== "POSTGRES_TERMINATE_OLD_RUNTIME_SESSION" || !input
      || !Number.isSafeInteger(input.pid) || input.pid < 1 || !HASH.test(input.backendStartSha256)
      || archiveEvidenceHash(input) !== archiveEvidenceHash({ ...ctx.input,
        pid: input.pid, backendStartSha256: input.backendStartSha256 })) fail("POSTGRES_FENCE_RECOVERY_DESCRIPTOR_INVALID");
    if (!await ctx.operations.readIntent(descriptor.kind, input)) fail("POSTGRES_FENCE_SESSION_INTENT_MISSING");
    await ctx.operations.runRecordedOperation({ kind: descriptor.kind, input,
      apply: async () => fail("POSTGRES_FENCE_RECOVERY_REPLAY_FORBIDDEN"), verify: () => sessionAbsent(ctx, client, input) });
  }
}

/** Provider writers and database-service recovery custody must be verified before
 * entering. Retain the new password outside Ops before calling. No secret enters
 * argv, journal input, receipts or propagated errors. This fences remote password
 * access; local trust and database-service startup remain the caller's custody.
 * The controller durably retains every operation descriptor. On reopen it
 * supplies inherited termination descriptors as resumeSessionOperations so an
 * already-absent session still gets its receipt reconciled without another kill.
 */
export async function runPostgresSourceFence(options) {
  try {
    const ctx = await context(options);
    if (ctx.custody.snapshot().pending?.to !== "SOURCE_FENCED" || !ctx.operations?.readIntent
      || !ctx.operations.runRecordedOperation) fail("POSTGRES_FENCE_OPERATION_CUSTODY_REQUIRED");
    const initialAuth = await credentials(ctx);
    if (initialAuth.complete && !await ctx.operations.readIntent(KIND, ctx.input)) fail("POSTGRES_FENCE_ROTATION_INTENT_MISSING");
    const preflightConfig = initialAuth.complete ? ctx.recoveryConfig : ctx.sourceConfig;
    await connected(preflightConfig, async client => {
      const server = await identity(client, ctx.expected, true);
      await readerPrivileges(client, ctx.expected);
      await readerProbe(ctx.readerConfig, ctx.expected, server);
    });
    await ctx.operations.runRecordedOperation({ kind: KIND, input: ctx.input,
      apply: async () => {
        await ctx.check();
        await connected(ctx.sourceConfig, async client => {
          await identity(client, ctx.expected, true);
          await suppressSensitiveSql(client);
          const verifier = scramVerifier(ctx.password);
          await ctx.check();
          await client.query(`ALTER ROLE "postgres" PASSWORD '${verifier}'`);
          await ctx.check();
        });
      }, verify: () => credentials(ctx) });
    await connected(ctx.recoveryConfig, async client => {
      await identity(client, ctx.expected, true);
      await readerPrivileges(client, ctx.expected);
      await reconcileSessions(ctx, client);
      // Cluster-wide: applications can hold postgres sessions outside railway.
      const sessions = (await client.query(`SELECT pid,backend_start::text AS started FROM pg_stat_activity
        WHERE backend_type='client backend' AND usename='postgres' AND pid<>pg_backend_pid() ORDER BY pid`)).rows;
      if (sessions.length > 2000) fail("POSTGRES_FENCE_SESSION_LIMIT");
      for (const session of sessions) {
        const input = { ...ctx.input, pid: session.pid, backendStartSha256: hash(session.started) };
        const verify = () => sessionAbsent(ctx, client, input);
        await ctx.operations.runRecordedOperation({ kind: "POSTGRES_TERMINATE_OLD_RUNTIME_SESSION", input,
          apply: async () => {
            await ctx.check();
            await client.query(`SELECT pg_terminate_backend(pid,5000) FROM pg_stat_activity
              WHERE pid=$1 AND backend_start::text=$2 AND usename='postgres' AND backend_type='client backend'
              AND pid<>pg_backend_pid()`, [session.pid, session.started]);
          }, verify });
      }
    });
    return await finalCensus(ctx);
  } catch (error) { throw error instanceof FenceError ? error : new FenceError("POSTGRES_FENCE_RECONCILIATION_REQUIRED"); }
}

export async function assertPostgresSourceFenced(options) {
  try { return await finalCensus(await context(options)); }
  catch (error) { throw error instanceof FenceError ? error : new FenceError("POSTGRES_FENCE_RECONCILIATION_REQUIRED"); }
}
