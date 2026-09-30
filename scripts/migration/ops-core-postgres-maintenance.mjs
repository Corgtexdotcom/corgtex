import pg from "pg";
import { nodeClientConfig } from "./run-postgres-restore-rehearsal.mjs";

// Session locks are scoped to a database: every domain uses the maintenance
// database, never its own application database. Closing this dedicated session
// releases the lock. Historical tools must be drained before server promotion.
const KEYS = [0x434f5247, 0x50474d54];
const need = (value, code) => { if (!value) throw new Error(code); };
class MaintenanceLost extends Error {
  constructor(reason) { super("PG_MAINTENANCE_LOST"); this.code = "PG_MAINTENANCE_LOST"; this.reason = reason; }
}

export async function openPostgresMaintenance({ config, expected, signal, assertOwned,
  clientFactory = value => new pg.Client(value) }) {
  need(signal instanceof AbortSignal && typeof assertOwned === "function"
    && config?.database === "postgres" && expected?.database === "postgres"
    && config.sslmode === "verify-full"
    && ["host", "port", "database", "user"].every(key => config[key] === expected[key]), "PG_MAINTENANCE_BINDING_INVALID");
  const abort = new AbortController();
  const combined = AbortSignal.any([signal, abort.signal]);
  const client = clientFactory(nodeClientConfig(config, "corgtex_server_maintenance", 10_000, 10_000));
  let closed = false;
  const lost = (reason = "SESSION_LOST") => {
    if (!abort.signal.aborted) abort.abort(new MaintenanceLost(reason));
  };
  const stop = () => { lost("SIGNAL_ABORTED"); void client.end().catch(() => {}); };
  client.on?.("error", () => lost("SESSION_ERROR"));
  client.on?.("end", () => lost("SESSION_END"));
  signal.addEventListener("abort", stop, { once: true });
  async function checkIdentity() {
    combined.throwIfAborted(); await assertOwned(); combined.throwIfAborted();
    const result = await client.query("SELECT current_database() AS database, session_user AS login, current_user AS role");
    const row = result.rows?.[0];
    need(result.rows?.length === 1 && row.database === expected.database
      && row.login === expected.user && row.role === expected.user, "PG_MAINTENANCE_IDENTITY_CHANGED");
  }
  async function assertHeld() {
    let stage = "IDENTITY_OR_CUSTODY";
    try {
      need(!closed, "PG_MAINTENANCE_CLOSED"); await checkIdentity();
      stage = "LOCK_QUERY";
      const result = await client.query(`SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_locks
        WHERE locktype='advisory' AND pid=pg_backend_pid() AND granted
          AND database=(SELECT oid FROM pg_catalog.pg_database WHERE datname=current_database())
          AND classid=$1::oid AND objid=$2::oid AND objsubid=2) AS held`, KEYS);
      stage = "LOCK_NOT_HELD";
      need(result.rows?.length === 1 && result.rows[0].held === true, "PG_MAINTENANCE_LOST");
      stage = "SIGNAL_ABORTED";
      combined.throwIfAborted();
    } catch {
      const reason = abort.signal.reason instanceof MaintenanceLost ? abort.signal.reason.reason : stage;
      lost(reason);
      throw new MaintenanceLost(reason);
    }
  }
  async function close() {
    if (closed) return;
    closed = true; signal.removeEventListener("abort", stop);
    try { await client.end(); } finally { lost(); }
  }
  try {
    await client.connect(); await checkIdentity();
    const result = await client.query("SELECT pg_try_advisory_lock($1::integer,$2::integer) AS held", KEYS);
    need(result.rows?.length === 1 && result.rows[0].held === true, "PG_MAINTENANCE_ALREADY_OWNED");
    await assertHeld();
    return { signal: combined, assertHeld, close };
  } catch (error) {
    await close().catch(() => {});
    throw new Error(error?.message === "PG_MAINTENANCE_ALREADY_OWNED" ? error.message : "PG_MAINTENANCE_UNAVAILABLE");
  }
}
