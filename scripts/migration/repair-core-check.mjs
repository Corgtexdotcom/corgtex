// One approved Core-only representation repair. Not a Prisma migration or parity waiver.
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { nodeClientConfig, parseSourceDatabaseUrl, validateSourceTlsRootCertificate } from "./run-postgres-restore-rehearsal.mjs";

export const ENDPOINT_DIGEST = "a228351c28e24c54bb8abd03fd0aebb345d021e578f7e30e6a7fd509b2a81877";
export const TREE_DIGESTS = Object.freeze({
  original: "1e56609c78ff33f713dcf4d86d95cc80d34139e2f2cd627b341ca3cd402a2231",
  canonical: "e52c8f6295a56640ef006d84d2476d0d6bd712073971011668f73e453a984c0c",
});
const hash = (s) => createHash("sha256").update(s).digest("hex");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
class RepairError extends Error {}
const requireState = (condition, code) => { if (!condition) throw new RepairError(code); };
export const treeDigest = (tree) => {
  requireState(typeof tree === "string" && Buffer.byteLength(tree) <= 16384, "TREE_UNAVAILABLE");
  // Only SQL source offsets are irrelevant. Keep every executable OID, constant and other field.
  return hash(tree.replace(/:location -?\d+/gu, ":location 0"));
};

export function boundOwnerConfig(ownerUrl, readOnlyUrl, ca) {
  const parse = (raw) => {
    let u;
    try { u = new URL(raw); } catch { throw new RepairError("INVALID_CONNECTION_INPUT"); }
    requireState(!u.hash, "INVALID_CONNECTION_INPUT");
    for (const [key, value] of u.searchParams) {
      requireState(["sslmode", "schema", "connection_limit", "pool_timeout"].includes(key), "UNSUPPORTED_CONNECTION_OPTION");
      requireState(u.searchParams.getAll(key).length === 1, "UNSUPPORTED_CONNECTION_OPTION");
      requireState(key === "sslmode" ? value === "require" : key === "schema" ? value === "public" : /^[1-9][0-9]*$/u.test(value), "UNSUPPORTED_CONNECTION_OPTION");
    }
    u.searchParams.set("sslmode", "require");
    try { return parseSourceDatabaseUrl(u.toString()); } catch { throw new RepairError("INVALID_CONNECTION_INPUT"); }
  };
  const owner = parse(ownerUrl);
  const reader = parse(readOnlyUrl);
  const tuple = (c) => [c.host, String(c.port), c.database];
  requireState(same(tuple(owner), tuple(reader)) && hash(JSON.stringify(tuple(owner))) === ENDPOINT_DIGEST, "CORE_ENDPOINT_MISMATCH");
  requireState(owner.user === "postgres" && owner.password.length > 0, "EXISTING_OWNER_MISMATCH");
  let sourceTlsRootCert;
  try { sourceTlsRootCert = validateSourceTlsRootCertificate(ca); } catch { throw new RepairError("INVALID_TRUST_ANCHOR"); }
  return nodeClientConfig({ ...owner, sourceTlsRootCert }, "corgtex_core_check_repair", 10000, 10000);
}

export const CATALOG_SQL = `
  SELECT c.oid::text AS oid, c.conbin::text AS tree,
    jsonb_build_array(c.convalidated,c.conenforced,c.conislocal,c.coninhcount,c.connoinherit,
      c.condeferrable,c.condeferred,c.conparentid::bigint,c.conkey) AS options,
    obj_description(c.oid,'pg_constraint') AS comment,
    t.relkind='r' AND t.relpersistence='p' AND NOT t.relispartition
      AND NOT EXISTS (SELECT 1 FROM pg_inherits WHERE inhrelid=t.oid OR inhparent=t.oid) AS ordinary,
    pg_has_role(current_user,t.relowner,'USAGE') AS owner,
    (SELECT jsonb_agg(jsonb_build_array(a.attnum,a.attname,a.atttypid::bigint,a.atttypmod,
      a.attcollation::bigint,a.attnotnull,a.attisdropped) ORDER BY a.attnum)
      FROM pg_attribute a WHERE a.attrelid=t.oid AND a.attnum IN (4,5,6)) AS columns,
    (SELECT jsonb_agg(jsonb_build_array(d.refclassid='pg_class'::regclass,
      d.refobjid=t.oid,d.refobjsubid,d.deptype) ORDER BY d.refobjsubid,d.deptype)
      FROM pg_depend d WHERE d.classid='pg_constraint'::regclass AND d.objid=c.oid) AS dependencies,
    NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.refclassid='pg_constraint'::regclass
      AND d.refobjid=c.oid) AS no_dependents,
    (SELECT md5(coalesce(jsonb_agg(to_jsonb(other) ORDER BY other.oid)::text,'[]'))
      FROM pg_constraint other WHERE other.conrelid=t.oid AND other.oid<>c.oid) AS other_constraints,
    (SELECT md5(coalesce(jsonb_agg(to_jsonb(m) ORDER BY m.id)::text,'[]'))
      FROM public._prisma_migrations m) AS migration_ledger
  FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
  WHERE n.nspname='public' AND t.relname='ConstitutionSourceReference' AND c.contype='c'
    AND c.connamespace=n.oid AND c.conname='ConstitutionSource_point_contract_check'
    AND octet_length(c.conbin::text)<=16384
    AND coalesce(octet_length(obj_description(c.oid,'pg_constraint')),0)<=4096
`;
const OPTIONS = [true, true, true, 0, false, false, false, 0, [5, 6, 4]];
const COLUMNS = [[4, "pointKey", 25, -1, 100, true, false], [5, "pointOrder", 23, -1, 0, true, false], [6, "sourceOrder", 23, -1, 0, true, false]];
const DEPENDENCIES = [4, 5, 6].flatMap((i) => [[true, true, i, "a"], [true, true, i, "n"]]);
export function validateCatalog(row) {
  requireState(row && row.ordinary === true && row.owner === true && row.no_dependents === true, "RELATION_PRECONDITION_FAILED");
  requireState(same(row.options, OPTIONS) && same(row.columns, COLUMNS) && same(row.dependencies, DEPENDENCIES), "CATALOG_DRIFT");
  requireState(row.comment === null || (typeof row.comment === "string" && Buffer.byteLength(row.comment) <= 4096), "COMMENT_UNAVAILABLE");
  requireState(/^[a-f0-9]{32}$/u.test(row.migration_ledger) && /^[a-f0-9]{32}$/u.test(row.other_constraints), "AUDIT_UNAVAILABLE");
  const digest = treeDigest(row.tree);
  const state = Object.keys(TREE_DIGESTS).find((key) => TREE_DIGESTS[key] === digest);
  requireState(state, "CHECK_DEFINITION_DRIFT");
  return state;
}
const catalog = async (client) => {
  const result = await client.query(CATALOG_SQL);
  requireState(result.rows.length === 1, "CHECK_IDENTITY_MISMATCH");
  return { row: result.rows[0], state: validateCatalog(result.rows[0]) };
};
const stable = (before, after) => {
  for (const key of ["options", "columns", "dependencies", "comment", "other_constraints", "migration_ledger"]) {
    requireState(same(before[key], after[key]), "POSTCONDITION_DRIFT");
  }
};
const begin = async (client, readOnly) => {
  await client.query(readOnly ? "BEGIN READ ONLY" : "BEGIN READ WRITE");
  await client.query("SET LOCAL search_path = pg_catalog");
  await client.query("SET LOCAL client_encoding = 'UTF8'");
  await client.query("SET LOCAL lock_timeout = '500ms'");
  await client.query("SET LOCAL statement_timeout = '5s'");
  await client.query("SET LOCAL transaction_timeout = '30s'");
  await client.query("SET LOCAL idle_in_transaction_session_timeout = '10s'");
  await client.query("SET LOCAL event_triggers = false");
  const r = (await client.query(`SELECT current_database()='railway' AS database,
    current_user='postgres' AND session_user=current_user AS identity,
    current_setting('server_version_num')='180006' AS version,
    NOT pg_is_in_recovery() AS primary,
    current_setting('event_triggers')='off' AS suppressed,
    current_setting('transaction_read_only')=$1 AS mode,
    current_setting('lock_timeout')='500ms' AND current_setting('statement_timeout')='5s'
      AND current_setting('transaction_timeout')='30s'
      AND current_setting('idle_in_transaction_session_timeout')='10s' AS bounded`, [readOnly ? "on" : "off"])).rows[0];
  requireState(r && ["database", "identity", "version", "primary", "suppressed", "mode", "bounded"].every((k) => r[k] === true), "SESSION_PRECONDITION_FAILED");
};
export const REPAIR_SQL = `ALTER TABLE public."ConstitutionSourceReference"
  DROP CONSTRAINT "ConstitutionSource_point_contract_check",
  ADD CONSTRAINT "ConstitutionSource_point_contract_check"
  CHECK ("pointOrder" >= 1 AND "pointOrder" <= 10 AND "sourceOrder" >= 1
    AND "pointKey" = 'point-' || "pointOrder"::TEXT)`;

export async function runCoreCheckRepair(mode, createClient, emit = () => {}) {
  requireState(["inspect", "apply"].includes(mode), "INVALID_MODE");
  let client;
  let transaction = false;
  let committing = false;
  let committed = false;
  let before;
  try {
    client = createClient();
    // Never log asynchronous PostgreSQL error objects or their potentially private details.
    client.on?.("error", () => {});
    await client.connect();
    transaction = true;
    await begin(client, mode === "inspect");
    if (mode === "apply") await client.query('LOCK TABLE public."ConstitutionSourceReference" IN ACCESS EXCLUSIVE MODE');
    const initial = await catalog(client);
    before = initial.row;
    if (mode === "inspect" || initial.state === "canonical") {
      await client.query("ROLLBACK");
      transaction = false;
      return { status: mode === "inspect" ? "INSPECTED" : "ALREADY_CANONICAL", state: initial.state, mutation: false };
    }
    await client.query(REPAIR_SQL);
    if (before.comment !== null) {
      const commentSql = (await client.query(`SELECT format('COMMENT ON CONSTRAINT "ConstitutionSource_point_contract_check" ON public."ConstitutionSourceReference" IS %L', $1::text) AS sql`, [before.comment])).rows[0]?.sql;
      requireState(typeof commentSql === "string", "COMMENT_RESTORE_FAILED");
      await client.query(commentSql);
    }
    const after = await catalog(client);
    requireState(after.state === "canonical", "CANONICAL_POSTCONDITION_FAILED");
    stable(before, after.row);
    emit({ status: "COMMITTING", reconcileBeforeRetry: true });
    committing = true;
    await client.query("COMMIT");
    committed = true;
    transaction = false;
    await client.end();
    client = createClient();
    client.on?.("error", () => {});
    await client.connect();
    transaction = true;
    await begin(client, true);
    const readback = await catalog(client);
    requireState(readback.state === "canonical", "CANONICAL_READBACK_FAILED");
    stable(before, readback.row);
    await client.query("ROLLBACK");
    transaction = false;
    return { status: "APPLIED_AND_VERIFIED", state: "canonical", mutation: true, strictRestoreRequired: true };
  } catch (error) {
    const status = committing ? (committed ? "COMMITTED_READBACK_UNPROVEN" : "COMMIT_OUTCOME_UNCERTAIN") : "ABORTED";
    let rollbackVerified = !transaction;
    if (transaction && client) {
      try { await client.query("ROLLBACK"); rollbackVerified = true; transaction = false; } catch { /* report uncertainty */ }
    }
    return { status, reason: error instanceof RepairError ? error.message : "DATABASE_OPERATION_FAILED",
      rollbackVerified, reconcileBeforeRetry: committing || !rollbackVerified };
  } finally {
    if (transaction && client) await client.query("ROLLBACK").catch(() => {});
    await client?.end().catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const emit = (receipt) => console.log(JSON.stringify(receipt));
  try {
    requireState(process.env.GITHUB_REF === "refs/heads/main" && process.env.GITHUB_REPOSITORY === "Corgtexdotcom/corgtex", "PROTECTED_CONTEXT_REQUIRED");
    const config = boundOwnerConfig(process.env.SOURCE_OWNER_URL, process.env.SOURCE_READ_ONLY_URL, process.env.SOURCE_TLS_ROOT_CERT);
    delete process.env.SOURCE_OWNER_URL;
    delete process.env.SOURCE_READ_ONLY_URL;
    delete process.env.SOURCE_TLS_ROOT_CERT;
    const receipt = await runCoreCheckRepair(process.env.REPAIR_MODE, () => new pg.Client(config), emit);
    emit(receipt);
    if (!["INSPECTED", "ALREADY_CANONICAL", "APPLIED_AND_VERIFIED"].includes(receipt.status)) process.exitCode = 1;
  } catch (error) {
    emit({ status: "NOT_STARTED", reason: error instanceof RepairError ? error.message : "CONFIGURATION_FAILED" });
    process.exitCode = 1;
  }
}
