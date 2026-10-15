import type { Prisma } from "@prisma/client";
import { prisma } from "@corgtex/shared";
import { sqlIngestionConfigurationFingerprint } from "@corgtex/domain";
import type {
  AuthenticatedSqlRunReceipt, SqlIngestionAttempt, SqlIngestionAttemptPort,
  SqlKnowledgePublicationPort, SqlPublicationIdentity,
} from "@corgtex/domain/sql-ingestion-contract";
import { startAttemptHeartbeat } from "./attempt-heartbeat";
import "./native-driver";

export interface SqlIngestionExecution {
  workspaceId: string;
  signal: AbortSignal;
  assertCurrent(tx?: Prisma.TransactionClient): Promise<void>;
  beforePublication(): Promise<void>;
}

/** Typed orchestration; production binds the authority's actual runtime ports. */
export function createSqlIngestionRunner(ports: SqlIngestionAttemptPort & SqlKnowledgePublicationPort) {
  return async function syncExternalDataSource(sourceId: string, execution?: SqlIngestionExecution) {
    await execution?.assertCurrent();
    const source = await prisma.externalDataSource.findUnique({ where: { id: sourceId } });
    if (!source || source.archivedAt) {
      throw new Error(`Data source not found or inactive: ${sourceId}`);
    }
    if (source.driverType !== "postgres") throw new Error(`Unsupported driver: ${source.driverType}`);
    if (execution && source.workspaceId !== execution.workspaceId) {
      throw new Error("SQL source workspace does not match admitted execution.");
    }
    if (!source.selectedTables.length || source.selectedTables.some(table => !table.trim())) {
      return {skipped: true, reason: "table_selection_required"} as const;
    }
    if (!source.isActive) throw new Error(`Data source not found or inactive: ${sourceId}`);
    const log = await prisma.externalDataSyncLog.create({ data: { sourceId } });
    const fingerprint = sqlIngestionConfigurationFingerprint(source);
    let attempt: SqlIngestionAttempt | undefined;
    let receipt: AuthenticatedSqlRunReceipt | undefined;
    let heartbeat: ReturnType<typeof startAttemptHeartbeat> | undefined;
    let publication: SqlPublicationIdentity | undefined;
    let preparationStopped = false;
    const cancelAttempt = () => {
      if (attempt) void ports.failSqlIngestionAttempt({ attempt, error: "SQL_WORKFLOW_LEASE_LOST", logId: log.id }).catch(() => undefined);
    };
    execution?.signal.addEventListener("abort", cancelAttempt, { once: true });
    try {
      await execution?.assertCurrent();
      // Claim precedes parsing, decryption and native I/O. Even unchanged cursor
      // text cannot let an obsolete attempt own terminal status or publication.
      attempt = await ports.claimSqlIngestionAttempt({
        workspaceId: source.workspaceId, sourceId, expectedConfigurationFingerprint: fingerprint,
        expectedCursor: source.lastCursorValue, logId: log.id,
      });
      const claimed = attempt;
      heartbeat = startAttemptHeartbeat(async () => {
        await execution?.assertCurrent();
        return ports.renewSqlIngestionAttempt(claimed);
      });
      await execution?.assertCurrent();
      receipt = await ports.captureSqlIngestionAttempt(claimed);
      await heartbeat.assertHealthy();
      await execution?.assertCurrent();
      const prepared = await ports.prepareSqlKnowledgeAttempt({ attempt: claimed, receipt });
      await heartbeat.assertHealthy();
      await execution?.assertCurrent();
      const result = await ports.publishPreparedSqlKnowledgeAttempt({
        attempt: claimed,
        prepared,
        async beforePublication() {
          await heartbeat!.stop();
          await execution?.beforePublication();
          preparationStopped = true;
        },
        async commit(tx, identity) {
          await execution?.assertCurrent(tx);
          if (!preparationStopped || identity.workspaceId !== source.workspaceId || identity.sourceId !== sourceId
            || identity.attemptId !== claimed.attemptId || identity.generation !== claimed.generation
            || identity.configurationFingerprint !== fingerprint || !identity.publicationId
            || !Number.isSafeInteger(identity.rowsProcessed) || identity.rowsProcessed < 0
            || !Number.isSafeInteger(identity.chunksCreated) || identity.chunksCreated < 0
            || (identity.rowsProcessed > 0 && identity.chunksCreated === 0)) {
            throw new Error("SQL publication identity does not acknowledge the complete committed output.");
          }
          const checkpoint = await tx.externalDataSource.updateMany({
            where: {
              id: sourceId, workspaceId: source.workspaceId, isActive: true, archivedAt: null,
              driverType: source.driverType, connectionStringEnc: source.connectionStringEnc,
              cursorColumn: source.cursorColumn, selectedTables: { equals: source.selectedTables },
              lastCursorValue: source.lastCursorValue,
            },
            data: { lastCursorValue: identity.nextCursor, lastSyncAt: new Date(), lastSyncError: null },
          });
          if (checkpoint.count !== 1) throw new Error("SQL_INGESTION_FENCE_LOST: source checkpoint changed before publication.");
          await tx.externalDataSyncLog.update({
            where: { id: log.id, sourceId },
            data: { rowsProcessed: identity.rowsProcessed, chunksCreated: identity.chunksCreated, completedAt: new Date(), error: null },
          });
          publication = { ...identity };
        },
      });
      if (!result || result.committed !== true || !publication
        || result.publicationId !== publication.publicationId
        || result.attemptId !== publication.attemptId || result.generation !== publication.generation
        || result.workspaceId !== publication.workspaceId || result.sourceId !== publication.sourceId
        || result.configurationFingerprint !== publication.configurationFingerprint
        || result.nextCursor !== publication.nextCursor || result.rowsProcessed !== publication.rowsProcessed
        || result.chunksCreated !== publication.chunksCreated) {
        throw new Error("SQL publication did not acknowledge the committed transaction.");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      if (attempt) {
        await ports.failSqlIngestionAttempt({ attempt, error: message, logId: log.id }).catch(() => undefined);
      } else {
        // A failed claim never owns source status. Its log may already have been
        // cascade-deleted; preserve the original diagnostic in either case.
        await prisma.externalDataSyncLog.updateMany({
          where: { id: log.id, sourceId }, data: { error: message, completedAt: new Date() },
        }).catch(() => undefined);
      }
      throw error;
    } finally {
      execution?.signal.removeEventListener("abort", cancelAttempt);
      await heartbeat?.stop().catch(() => undefined);
      if (receipt) await ports.disposeSqlIngestionCapture(receipt).catch(() => undefined);
    }
  };
}
