import { createHash, randomUUID } from "node:crypto";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const opaqueRef = (value) => `sha256:${sha256(value).slice(0, 16)}`;
const stableJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
};
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value, keys) => isRecord(value)
  && stableJson(Object.keys(value).sort()) === stableJson([...keys].sort());
const sameRecord = (left, right) => {
  try { return stableJson(left) === stableJson(right); } catch { return false; }
};
const HASH = /^[a-f0-9]{64}$/;
const OID = /^[1-9][0-9]{0,9}$/;
const IDENTIFIER = /^[a-zA-Z0-9_-]{1,128}$/;

export class PostgresPromotionError extends Error {
  constructor(code, reconciliationRequired = false) {
    super(`Postgres promotion failed: ${code}.`);
    this.name = "PostgresPromotionError";
    this.code = code;
    this.reconciliationRequired = reconciliationRequired;
  }
}

const requireValue = (condition, code, reconciliationRequired = false) => {
  if (!condition) throw new PostgresPromotionError(code, reconciliationRequired);
};
const deepFreeze = (value) => {
  if (value !== null && typeof value === "object") {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
};

function validateIdentity(value) {
  requireValue(exactKeys(value, ["host", "port", "database", "user"]), "INVALID_EXPECTED_CONNECTION");
  for (const key of ["host", "database", "user"]) {
    requireValue(typeof value[key] === "string" && value[key].length > 0 && value[key].length <= 253
      && !/[\x00-\x20\x7f]/.test(value[key]) && !value[key].includes("://"), "INVALID_EXPECTED_CONNECTION");
  }
  requireValue(Number.isInteger(value.port) && value.port > 0 && value.port <= 65535, "INVALID_EXPECTED_CONNECTION");
}

function validateIntent(intent) {
  requireValue(exactKeys(intent, ["schemaVersion", "operationId", "domain", "expectedConnection", "scratchName", "scratchOid",
    "permanentName", "targetIdentity", "parityEvidenceSha256", "sha256"]), "INVALID_PROMOTION_INTENT");
  requireValue(intent.schemaVersion === "1.0.0" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(intent.operationId), "INVALID_PROMOTION_INTENT");
  requireValue(intent.domain === "core" || intent.domain === "ops", "INVALID_PROMOTION_DOMAIN");
  requireValue(typeof intent.scratchName === "string" && intent.scratchName.length <= 63
    && new RegExp(`^corgtex_rehearsal_[1-9][0-9]*_[1-9][0-9]*_${intent.domain}$`).test(intent.scratchName), "INVALID_PROMOTION_SCRATCH");
  requireValue(typeof intent.scratchOid === "string" && OID.test(intent.scratchOid)
    && BigInt(intent.scratchOid) <= 4294967295n, "INVALID_PROMOTION_OID");
  requireValue(intent.permanentName === `corgtex_${intent.domain}`, "INVALID_PROMOTION_DESTINATION");
  requireValue(typeof intent.targetIdentity === "string" && IDENTIFIER.test(intent.targetIdentity), "INVALID_PROMOTION_TARGET_IDENTITY");
  requireValue(typeof intent.parityEvidenceSha256 === "string" && HASH.test(intent.parityEvidenceSha256), "INVALID_PARITY_EVIDENCE_HASH");
  validateIdentity(intent.expectedConnection);
  requireValue(![intent.scratchName, intent.permanentName].includes(intent.expectedConnection.database), "ADMIN_DATABASE_REQUIRED");
  const { sha256: digest, ...body } = intent;
  requireValue(typeof digest === "string" && HASH.test(digest) && sha256(stableJson(body)) === digest, "PROMOTION_INTENT_DIGEST_MISMATCH");
  return deepFreeze(structuredClone(intent));
}

function assertConnectionParameters(client, expected) {
  requireValue(typeof client?.query === "function" && isRecord(client.connectionParameters), "CONNECTED_ADMIN_CLIENT_REQUIRED");
  for (const key of ["host", "port", "database", "user"]) {
    requireValue(client.connectionParameters[key] === expected[key], "ADMIN_CONNECTION_BINDING_MISMATCH");
  }
}

async function query(client, sql, values) {
  try { return await client.query(sql, values); }
  catch { throw new PostgresPromotionError("PROMOTION_READ_FAILED", true); }
}

async function inspect(client, intent) {
  const expected = intent.expectedConnection;
  assertConnectionParameters(client, expected);
  const identity = await query(client, "SELECT current_database() AS database, session_user AS session_user, current_user AS role_user");
  requireValue(identity.rows?.length === 1 && identity.rows[0].database === expected.database
    && identity.rows[0].session_user === expected.user && identity.rows[0].role_user === expected.user,
  "ADMIN_SQL_IDENTITY_MISMATCH");
  const result = await query(client, `
    SELECT d.datname AS name, d.oid::text AS oid, pg_catalog.pg_get_userbyid(d.datdba) AS owner,
      d.datistemplate AS is_template,
      (SELECT count(*)::integer FROM pg_catalog.pg_stat_activity AS a WHERE a.datid = d.oid) AS connection_count
    FROM pg_catalog.pg_database AS d
    WHERE d.datname = ANY($1::text[]) OR d.oid = $2::oid
    ORDER BY d.oid
  `, [[intent.scratchName, intent.permanentName], intent.scratchOid]);
  requireValue(Array.isArray(result.rows) && result.rows.length <= 3, "PROMOTION_CATALOG_UNPROVEN");
  for (const row of result.rows) {
    requireValue(typeof row.name === "string" && typeof row.oid === "string" && OID.test(row.oid)
      && typeof row.owner === "string" && typeof row.is_template === "boolean"
      && Number.isSafeInteger(row.connection_count) && row.connection_count >= 0, "PROMOTION_CATALOG_UNPROVEN");
  }
  return result.rows;
}

function classify(intent, rows) {
  const common = { schemaVersion: "1.0.0", intentSha256: intent.sha256, targetIdentity: intent.targetIdentity,
    scratchOid: intent.scratchOid, permanentRef: opaqueRef(`${intent.expectedConnection.host}\0${intent.permanentName}`) };
  if (rows.length !== 1) return { ...common, status: "INDETERMINATE", reason: "DATABASE_IDENTITY_CONFLICT", connectionCount: null };
  const [row] = rows;
  if (row.oid !== intent.scratchOid || row.owner !== intent.expectedConnection.user || row.is_template) {
    return { ...common, status: "INDETERMINATE", reason: "DATABASE_IDENTITY_CONFLICT", connectionCount: null };
  }
  if (row.name === intent.scratchName || row.name === intent.permanentName) {
    return { ...common, status: row.name === intent.scratchName ? "PREPARED" : "PROMOTED",
      reason: row.connection_count === 0 ? null : "DATABASE_CONNECTIONS_PRESENT", connectionCount: row.connection_count };
  }
  return { ...common, status: "INDETERMINATE", reason: "DATABASE_IDENTITY_CONFLICT", connectionCount: null };
}

/** Read-only discovery. Does not fence writers, reserve a destination or authorize ALTER. */
export async function preparePostgresPromotion({ client, expectedConnection, domain, scratchName, scratchOid,
  permanentName, targetIdentity, parityEvidenceSha256 }) {
  const body = { schemaVersion: "1.0.0", operationId: randomUUID(), domain, expectedConnection: structuredClone(expectedConnection),
    scratchName, scratchOid, permanentName, targetIdentity, parityEvidenceSha256 };
  const intent = validateIntent({ ...body, sha256: sha256(stableJson(body)) });
  const state = classify(intent, await inspect(client, intent));
  requireValue(state.status === "PREPARED" && state.connectionCount === 0, "PROMOTION_PRECONDITIONS_UNPROVEN");
  return intent;
}

/** Read-only recovery by OID under both names, including an unexpected third name. */
export async function reconcilePostgresPromotion({ client, intent: input }) {
  const intent = validateIntent(input);
  try { return classify(intent, await inspect(client, intent)); }
  catch (error) {
    if (error instanceof PostgresPromotionError && error.code === "PROMOTION_READ_FAILED") {
      return { schemaVersion: "1.0.0", intentSha256: intent.sha256, targetIdentity: intent.targetIdentity,
        scratchOid: intent.scratchOid, permanentRef: opaqueRef(`${intent.expectedConnection.host}\0${intent.permanentName}`),
        status: "INDETERMINATE", reason: "PROMOTION_READ_FAILED", connectionCount: null };
    }
    throw error;
  }
}

/** Caller persists intent in independent custody storage and CAS-transitions the
 * actual scratch cleanup state to this marker. The old cleanup runner rejects its
 * phase, so a retained scratch name cannot authorize deletion after promotion.
 */
export function postgresPromotionDurableRecord(input) {
  const intent = validateIntent(input);
  return deepFreeze({ intent, cleanupState: { schemaVersion: "1.0.0", scratchName: intent.scratchName,
    targetRef: opaqueRef(`${intent.expectedConnection.host}\0${intent.scratchName}`),
    scratchOid: intent.scratchOid, intentSha256: intent.sha256, phase: "PROMOTION_INTENT" } });
}

function assertSignal(signal) {
  requireValue(!signal.aborted, "PROMOTION_ABORTED", true);
}

async function custody({ lease, assertTargetInactive, signal }, intent, effect) {
  assertSignal(signal);
  try { requireValue(await lease.assertHeld({ intentSha256: intent.sha256, effect }) !== false, "PROMOTION_CUSTODY_LOST", true); }
  catch { throw new PostgresPromotionError("PROMOTION_CUSTODY_LOST", true); }
  try { requireValue(await assertTargetInactive({ intent, effect }) !== false, "PROMOTION_TARGET_ACTIVITY_UNPROVEN", true); }
  catch { throw new PostgresPromotionError("PROMOTION_TARGET_ACTIVITY_UNPROVEN", true); }
  assertSignal(signal);
}

async function readRecord(readOperationIntent) {
  try { return await readOperationIntent(); }
  catch { throw new PostgresPromotionError("PROMOTION_DURABILITY_UNPROVEN", true); }
}

/** One ALTER attempt only. persistOperationIntent must CAS-create independent
 * durable custody intent AND transition the local scratch marker; readOperationIntent
 * must independently read both. null means neither exists. Partial persistence,
 * a stale marker, or a lost acknowledgement requires reconciliation, never replay.
 */
export async function applyPostgresPromotion(options) {
  const { client, intent: input, lease, assertTargetInactive, persistOperationIntent, readOperationIntent, signal } = options;
  const intent = validateIntent(input);
  requireValue(typeof lease?.assertHeld === "function" && typeof assertTargetInactive === "function"
    && typeof persistOperationIntent === "function" && typeof readOperationIntent === "function"
    && signal instanceof AbortSignal, "PROMOTION_CUSTODY_REQUIRED");
  assertConnectionParameters(client, intent.expectedConnection);
  const expectedRecord = postgresPromotionDurableRecord(intent);
  await custody(options, intent, "PREPARE_PROMOTION");
  const priorRecord = await readRecord(readOperationIntent);
  if (priorRecord !== null) {
    requireValue(sameRecord(priorRecord, expectedRecord), "PROMOTION_DURABILITY_UNPROVEN", true);
    const state = await reconcilePostgresPromotion({ client, intent });
    return { ...state, renameAttempted: false, renameAcknowledged: false,
      custodyVerified: true, targetInactiveVerified: state.connectionCount === 0, priorIntentReconciled: true };
  }
  const initial = classify(intent, await inspect(client, intent));
  requireValue(initial.status === "PREPARED" && initial.connectionCount === 0, "PROMOTION_PRECONDITIONS_UNPROVEN");
  try { await persistOperationIntent(expectedRecord); }
  catch { throw new PostgresPromotionError("PROMOTION_DURABILITY_UNPROVEN", true); }
  const persisted = await readRecord(readOperationIntent);
  requireValue(sameRecord(persisted, expectedRecord), "PROMOTION_DURABILITY_UNPROVEN", true);
  await custody(options, intent, "ALTER_DATABASE");
  // Recheck exact connection, OID, owner, destination absence and zero sessions
  // after persistence/custody callbacks, immediately before issuing the rename.
  const final = classify(intent, await inspect(client, intent));
  requireValue(final.status === "PREPARED" && final.connectionCount === 0, "PROMOTION_PRECONDITIONS_UNPROVEN", true);
  assertSignal(signal);
  let acknowledged = false;
  try {
    // Names are validated fixed-domain identifiers. There is no DROP/replacement.
    await client.query(`ALTER DATABASE "${intent.scratchName}" RENAME TO "${intent.permanentName}"`);
    acknowledged = true;
  } catch { /* A transport error does not prove that PostgreSQL rejected the ALTER. */ }
  let state;
  try { state = await reconcilePostgresPromotion({ client, intent }); }
  catch {
    state = { ...classify(intent, []), reason: "PROMOTION_RECONCILIATION_UNPROVEN" };
  }
  let custodyVerified = true;
  try { await custody(options, intent, "VERIFY_PROMOTION"); } catch { custodyVerified = false; }
  return { ...state, renameAttempted: true, renameAcknowledged: acknowledged,
    custodyVerified, targetInactiveVerified: custodyVerified && state.connectionCount === 0, priorIntentReconciled: false };
}
