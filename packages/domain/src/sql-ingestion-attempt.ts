import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { ExternalDataSource, Prisma } from "@prisma/client";
import { prisma } from "@corgtex/shared";
import { AppError, invariant } from "./errors";
import { artifactPermissionEpochIdentities, capturePermissionEpochs, isArtifactPermissionEpochProofCurrent, mergePermissionEpochProofs,
  type PermissionEpochProof } from "./source-permission-epochs";
import { assertSourceCommitTransactionCompatible } from "./source-commit-lock-plan";
import type { SqlIngestionAttempt, SqlSourceConfiguration } from "./sql-ingestion-contract";

export const SQL_INGESTION_LEASE_MS = 300_000;
export const SQL_INGESTION_RENEW_INTERVAL_MS = 60_000;
type AttemptState = {attemptId: string; workspaceId: string; sourceId: string; generation: bigint;
  ownerNonce: string; configurationFingerprint: string; expectedCursor: string | null;
  sourcePermissionEpoch: bigint; originalPermissions: PermissionEpochProof;
  logId: string; source: Readonly<ExternalDataSource>};
const attempts = new WeakMap<SqlIngestionAttempt, AttemptState>();
type Db = Prisma.TransactionClient | typeof prisma;

/** Matches the existing compatible v1 cursor fingerprint byte for byte. Do not
 * sort properties/tables or add control timestamps to this transport identity. */
export function sqlIngestionConfigurationFingerprint(source: Pick<ExternalDataSource,
  "id" | "workspaceId" | "driverType" | "connectionStringEnc" | "cursorColumn" | "selectedTables">) {
  return createHash("sha256").update(JSON.stringify({sourceId: source.id, workspaceId: source.workspaceId,
    driverType: source.driverType, connectionStringEnc: source.connectionStringEnc,
    cursorColumn: source.cursorColumn, selectedTables: source.selectedTables})).digest("hex");
}
function stateOf(attempt: SqlIngestionAttempt) {
  const state = attempts.get(attempt);
  invariant(state, 409, "SQL_INGESTION_FENCE_LOST", "SQL ingestion attempt has no trusted claim.");
  return state;
}
async function databaseNow(db: Db) {
  const rows = await db.$queryRaw<Array<{now: Date}>>`SELECT clock_timestamp() AS "now"`;
  return rows[0]!.now;
}
/** Same canonical physical head used by the complete source-plan registry. */
async function lockSourceHead(tx: Prisma.TransactionClient, workspaceId: string, sourceId: string) {
  assertSourceCommitTransactionCompatible(tx);
  const head = `source-head:${workspaceId}:${JSON.stringify(["ExternalDataSource", sourceId])}`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${head}, 0))`;
  await tx.$queryRaw`SELECT id FROM "ExternalDataSource" WHERE id = ${sourceId} AND "workspaceId" = ${workspaceId} FOR UPDATE`;
  await tx.$queryRaw`SELECT id FROM "SqlIngestionSourceClaim" WHERE "sourceId" = ${sourceId} AND "workspaceId" = ${workspaceId} FOR UPDATE`;
}

export async function claimSqlIngestionAttempt(input: {workspaceId: string; sourceId: string;
  expectedConfigurationFingerprint: string; expectedCursor: string | null; logId: string}): Promise<SqlIngestionAttempt> {
  const request = structuredClone(input);
  invariant(/^[a-f0-9]{64}$/.test(request.expectedConfigurationFingerprint)
    && [request.workspaceId, request.sourceId, request.logId].every(id => typeof id === "string" && id.length > 0 && id.length <= 100)
    && (request.expectedCursor === null || typeof request.expectedCursor === "string" && request.expectedCursor.length <= 1_000_000),
  409, "SQL_INGESTION_ATTEMPT_CONFLICT", "SQL ingestion claim parameters are unavailable.");
  const saved = await prisma.$transaction(async tx => {
    await lockSourceHead(tx, request.workspaceId, request.sourceId);
    const source = await tx.externalDataSource.findFirst({where: {id: request.sourceId, workspaceId: request.workspaceId}});
    invariant(source && source.isActive && !source.archivedAt && source.driverType === "postgres"
      && sqlIngestionConfigurationFingerprint(source) === request.expectedConfigurationFingerprint
      && source.lastCursorValue === request.expectedCursor,
    409, "SQL_INGESTION_ATTEMPT_CONFLICT", "SQL source changed before claim admission.");
    const log = await tx.externalDataSyncLog.findFirst({where: {id: request.logId, sourceId: source.id,
      sqlAttemptId: null, completedAt: null}});
    invariant(log, 409, "SQL_INGESTION_ATTEMPT_CONFLICT", "SQL attempt log is unavailable.");
    const claim = await tx.sqlIngestionSourceClaim.upsert({where: {workspaceId_sourceId: {workspaceId: source.workspaceId, sourceId: source.id}},
      update: {}, create: {workspaceId: source.workspaceId, sourceId: source.id}});
    const now = await databaseNow(tx);
    invariant(claim.status !== "RUNNING" || !claim.leaseExpiresAt || claim.leaseExpiresAt <= now,
      409, "SQL_INGESTION_ATTEMPT_CONFLICT", "Another current SQL ingestion attempt owns this source.");
    if (claim.activeAttemptId) await tx.sqlIngestionAttempt.updateMany({where: {id: claim.activeAttemptId, status: "RUNNING"},
      data: {status: "RECLAIMED", completedAt: now}});
    // Hold absence-sensitive policy epochs before reading their mutable
    // bindings. A later restriction/move must invalidate these original epochs,
    // rather than pairing new epochs with an old selected role/circle set.
    const sourceProof = await capturePermissionEpochs(tx, source.workspaceId,
      artifactPermissionEpochIdentities("ExternalDataSource", source));
    const category = await tx.informationCategoryPolicy.findUnique({where: {workspaceId_category: {
      workspaceId: source.workspaceId, category: source.informationCategory}}});
    const roleIds = [...new Set([...(source.isRestricted ? source.allowedRoleIds : []),
      ...(category?.isRestricted ? category.allowedRoleIds : [])])];
    const roleProof = roleIds.length || (category?.isRestricted && category.allowedCircleIds.length) ? await capturePermissionEpochs(tx, source.workspaceId,
      [...roleIds.map(id => ({kind: "Role", id})),
        ...(category?.isRestricted ? category.allowedCircleIds.map(id => ({kind: "Circle", id})) : [])]) : null;
    const roles = roleIds.length ? await tx.role.findMany({where: {id: {in: roleIds}, circle: {workspaceId: source.workspaceId}},
      select: {circleId: true}}) : [];
    const circleProof = roles.length ? await capturePermissionEpochs(tx, source.workspaceId,
      roles.map(role => ({kind: "Circle", id: role.circleId}))) : null;
    const proof = mergePermissionEpochProofs(sourceProof, ...[roleProof, circleProof].filter(proof => proof !== null))!;
    const sourcePermissionEpoch = BigInt(proof.entries.find(entry => entry.kind === "ExternalDataSource" && entry.id === source.id)!.epoch);
    const generation = claim.generation + 1n, ownerNonce = randomUUID(), attemptId = randomUUID();
    const leaseExpiresAt = new Date(now.getTime() + SQL_INGESTION_LEASE_MS);
    await tx.sqlIngestionAttempt.create({data: {id: attemptId, workspaceId: source.workspaceId, sourceId: source.id,
      generation, ownerNonce, configurationFingerprint: request.expectedConfigurationFingerprint,
      expectedCursor: request.expectedCursor, sourcePermissionEpoch, originalPermissionEpochsJson: proof,
      logId: request.logId, leaseExpiresAt}});
    await tx.sqlIngestionSourceClaim.update({where: {id: claim.id}, data: {generation, ownerNonce, activeAttemptId: attemptId,
      configurationFingerprint: request.expectedConfigurationFingerprint, leaseExpiresAt, status: "RUNNING"}});
    const bound = await tx.externalDataSyncLog.updateMany({where: {id: log.id, sourceId: source.id, sqlAttemptId: null, completedAt: null},
      data: {sqlAttemptId: attemptId}});
    invariant(bound.count === 1, 409, "SQL_INGESTION_ATTEMPT_CONFLICT", "SQL attempt log changed before admission.");
    return {attemptId, workspaceId: source.workspaceId, sourceId: source.id, generation, ownerNonce,
      configurationFingerprint: request.expectedConfigurationFingerprint, expectedCursor: request.expectedCursor,
      sourcePermissionEpoch, originalPermissions: proof, logId: log.id, source: Object.freeze(structuredClone(source))};
  }, {timeout: 10_000});
  const token = Object.freeze({attemptId: saved.attemptId, workspaceId: saved.workspaceId, sourceId: saved.sourceId,
    generation: saved.generation.toString(), configurationFingerprint: saved.configurationFingerprint, logId: saved.logId}) as SqlIngestionAttempt;
  attempts.set(token, saved);
  return token;
}

/** Internal owner check. Cursor changes are permitted only when the verified
 * publication declares its exact native tail; original source epoch stays fixed. */
export async function assertSqlIngestionAttemptCurrent(attempt: SqlIngestionAttempt, db: Db = prisma,
  options?: {publishedCursor: string | null}) {
  assertSourceCommitTransactionCompatible(db);
  const state = stateOf(attempt);
  const [source, claim, stored, epoch, now] = await Promise.all([
    db.externalDataSource.findFirst({where: {id: state.sourceId, workspaceId: state.workspaceId}}),
    db.sqlIngestionSourceClaim.findUnique({where: {workspaceId_sourceId: {workspaceId: state.workspaceId, sourceId: state.sourceId}}}),
    db.sqlIngestionAttempt.findUnique({where: {id: state.attemptId}}),
    db.sourcePermissionEpoch.findUnique({where: {workspaceId_sourceKind_sourceId: {
      workspaceId: state.workspaceId, sourceKind: "ExternalDataSource", sourceId: state.sourceId}}}), databaseNow(db),
  ]);
  invariant(source && source.isActive && !source.archivedAt && sqlIngestionConfigurationFingerprint(source) === state.configurationFingerprint
    && source.lastCursorValue === (options ? options.publishedCursor : state.expectedCursor)
    && claim?.status === "RUNNING" && claim.activeAttemptId === state.attemptId && claim.generation === state.generation
    && claim.ownerNonce === state.ownerNonce && claim.configurationFingerprint === state.configurationFingerprint
    && claim.leaseExpiresAt && claim.leaseExpiresAt > now
    && stored?.status === "RUNNING" && stored.workspaceId === state.workspaceId && stored.sourceId === state.sourceId
    && stored.generation === state.generation && stored.ownerNonce === state.ownerNonce
    && stored.configurationFingerprint === state.configurationFingerprint && stored.expectedCursor === state.expectedCursor
    && stored.sourcePermissionEpoch === state.sourcePermissionEpoch && stored.logId === state.logId
    && stored.leaseExpiresAt.getTime() === claim.leaseExpiresAt.getTime() && epoch?.epoch === state.sourcePermissionEpoch,
  409, "SQL_INGESTION_FENCE_LOST", "SQL source attempt, configuration or lease is no longer current.");
  invariant(isDeepStrictEqual(stored.originalPermissionEpochsJson, state.originalPermissions)
    && await isArtifactPermissionEpochProofCurrent(state.workspaceId, state.originalPermissions, db),
  409, "SQL_INGESTION_FENCE_LOST", "SQL source policy changed after admission.");
}

export async function renewSqlIngestionAttempt(attempt: SqlIngestionAttempt) {
  const state = stateOf(attempt);
  return prisma.$transaction(async tx => {
    await lockSourceHead(tx, state.workspaceId, state.sourceId);
    await assertSqlIngestionAttemptCurrent(attempt, tx);
    const leaseExpiresAt = new Date((await databaseNow(tx)).getTime() + SQL_INGESTION_LEASE_MS);
    await tx.sqlIngestionSourceClaim.update({where: {workspaceId_sourceId: {workspaceId: state.workspaceId, sourceId: state.sourceId}},
      data: {leaseExpiresAt}});
    await tx.sqlIngestionAttempt.update({where: {id: state.attemptId}, data: {leaseExpiresAt}});
    return {leaseExpiresAt};
  }, {timeout: 10_000});
}

/** A stale attempt records only its own failure/log. A source deletion may have
 * cascaded that log away; updateMany's zero result must not mask the real error. */
export async function failSqlIngestionAttempt(input: {attempt: SqlIngestionAttempt; error: string; logId: string}) {
  const state = stateOf(input.attempt);
  invariant(input.logId === state.logId, 409, "SQL_INGESTION_FENCE_LOST", "SQL failure log belongs to another attempt.");
  const error = String(input.error).slice(0, 2000);
  await prisma.$transaction(async tx => {
    await lockSourceHead(tx, state.workspaceId, state.sourceId);
    const now = await databaseNow(tx);
    let ownsCurrentSource = false;
    try {await assertSqlIngestionAttemptCurrent(input.attempt, tx); ownsCurrentSource = true;}
    catch (failure) {
      if (!(failure instanceof AppError) || failure.code !== "SQL_INGESTION_FENCE_LOST") throw failure;
    }
    const failed = await tx.sqlIngestionAttempt.updateMany({where: {id: state.attemptId, workspaceId: state.workspaceId,
      sourceId: state.sourceId, generation: state.generation, ownerNonce: state.ownerNonce,
      logId: state.logId, configurationFingerprint: state.configurationFingerprint, status: {in: ["RUNNING", "REVOKED", "RECLAIMED"]}},
      data: {status: "FAILED", error, completedAt: now}});
    if (failed.count === 1) await tx.externalDataSyncLog.updateMany({where: {
      id: state.logId, sourceId: state.sourceId, sqlAttemptId: state.attemptId, completedAt: null}, data: {error, completedAt: now}});
    if (ownsCurrentSource) {
      await tx.externalDataSource.update({where: {id: state.sourceId}, data: {lastSyncError: error}});
    }
    // Release only this exact control tuple, even when its original policy was
    // revoked. This confers no source/status grant and cannot clear a successor.
    if (failed.count === 1) await tx.sqlIngestionSourceClaim.updateMany({where: {
      workspaceId: state.workspaceId, sourceId: state.sourceId, status: "RUNNING", activeAttemptId: state.attemptId,
      generation: state.generation, ownerNonce: state.ownerNonce},
    data: {status: "FAILED", activeAttemptId: null, ownerNonce: null, leaseExpiresAt: null}});
    // The original opaque token may reclaim only its own terminal, non-serving
    // staging, even after a newer generation owns the source. Repeated failure
    // acknowledgements retry cleanup without rewriting the historical failure.
    const terminal = failed.count === 1 || await tx.sqlIngestionAttempt.count({where: {
      id: state.attemptId, workspaceId: state.workspaceId, sourceId: state.sourceId,
      generation: state.generation, ownerNonce: state.ownerNonce, logId: state.logId,
      configurationFingerprint: state.configurationFingerprint, status: "FAILED"}}) === 1;
    if (terminal) await tx.sqlKnowledgePublication.deleteMany({where: {
      workspaceId: state.workspaceId, sourceId: state.sourceId, attemptId: state.attemptId,
      generation: state.generation, configurationFingerprint: state.configurationFingerprint,
      status: {in: ["PREPARING", "PREPARED"]}, committedAt: null}});
    // The parent cascade deletes at most the bounded run's staged rows without
    // hydrating vectors. Native receipt, attempt and log remain auditable.
  }, {timeout: 10_000});
}

/** Internal dedicated capture lookup. A copied JSON token cannot reach a driver. */
export async function sqlIngestionSourceForCapture(attempt: SqlIngestionAttempt): Promise<SqlSourceConfiguration> {
  await assertSqlIngestionAttemptCurrent(attempt);
  const source = structuredClone(stateOf(attempt).source);
  return Object.freeze({...source, selectedTables: Object.freeze(source.selectedTables)});
}

/** Dedicated native adapters share this exact claim/physical-source lock order. */
export async function lockSqlIngestionAttempt(attempt: SqlIngestionAttempt, tx: Prisma.TransactionClient) {
  const state = stateOf(attempt);
  await lockSourceHead(tx, state.workspaceId, state.sourceId);
  const held = await capturePermissionEpochs(tx, state.workspaceId, state.originalPermissions.entries);
  invariant(isDeepStrictEqual(held, state.originalPermissions), 409, "SQL_INGESTION_FENCE_LOST",
    "SQL source policy changed before its publication epoch union was held.");
  await assertSqlIngestionAttemptCurrent(attempt, tx);
}

export function sqlIngestionOriginalPermissions(attempt: SqlIngestionAttempt): PermissionEpochProof {
  return structuredClone(stateOf(attempt).originalPermissions);
}

/** Terminalize only after the exact native tail and own log have committed in
 * this same transaction. No caller-provided terminal status is accepted. */
export async function completeSqlIngestionAttempt(attempt: SqlIngestionAttempt, tx: Prisma.TransactionClient,
  publishedCursor: string | null) {
  await assertSqlIngestionAttemptCurrent(attempt, tx, {publishedCursor});
  const state = stateOf(attempt), now = await databaseNow(tx);
  await tx.sqlIngestionAttempt.update({where: {id: state.attemptId}, data: {status: "SUCCEEDED", completedAt: now}});
  await tx.sqlIngestionSourceClaim.update({where: {workspaceId_sourceId: {workspaceId: state.workspaceId, sourceId: state.sourceId}},
    data: {status: "SUCCEEDED", activeAttemptId: null, ownerNonce: null, leaseExpiresAt: null}});
}
