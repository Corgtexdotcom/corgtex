import { prisma } from "@corgtex/shared";
import { syncKnowledgeForSource } from "@corgtex/knowledge";
import { CursorError } from "./cursor";
import { capturePostgresScan, scanFingerprint } from "./native-scan";

export async function syncExternalDataSource(sourceId: string) {
  const found = await prisma.externalDataSource.findUnique({ where: { id: sourceId } });
  if (!found || !found.isActive) {
    throw new Error(`Data source not found or inactive: ${sourceId}`);
  }
  const source = found;
  const logEntry = await prisma.externalDataSyncLog.create({ data: { sourceId } });
  const configurationWhere = {
    id: source.id,
    workspaceId: source.workspaceId,
    isActive: true,
    driverType: source.driverType,
    connectionStringEnc: source.connectionStringEnc,
    cursorColumn: source.cursorColumn,
    selectedTables: { equals: source.selectedTables },
  };
  let acknowledgedCursor = source.lastCursorValue;

  let scan: Awaited<ReturnType<typeof capturePostgresScan>> | undefined;
  try {
    const fingerprint = scanFingerprint(source);
    async function assertCurrentSource() {
      const current = await prisma.externalDataSource.findUnique({ where: { id: source.id } });
      if (!current || !current.isActive || scanFingerprint(current) !== fingerprint) {
        throw new CursorError("CURSOR_SCAN_CHANGED", "The source configuration changed during ingestion. Its previous checkpoint was retained.");
      }
      if (current.lastCursorValue !== source.lastCursorValue) {
        throw new CursorError("CURSOR_CONFLICT", "Another run advanced the source checkpoint. This run cannot overwrite it.");
      }
    }
    scan = await capturePostgresScan(source, assertCurrentSource);
    let totalChunks = 0;
    for (const planned of scan.rows) {
      const chunksCreated = await syncKnowledgeForSource({
        workspaceId: source.workspaceId,
        sourceType: "EXTERNAL_DATABASE",
        accessDomain: "WORKSPACE",
        sourceId: `byodb:${source.id}:${planned.table}:${planned.primaryKey}`,
        sourceTitle: `${planned.table} row ${planned.primaryKey}`,
        content: planned.content,
        metadata: { table: planned.table, sourceId: source.id },
      });
      if (typeof chunksCreated !== "number" || chunksCreated <= 0) {
        throw new Error("SQL row publication did not acknowledge a committed output.");
      }
      totalChunks += chunksCreated;
    }
    await scan.beforePublication();
    const serializedCursor = scan.nextCursor;
    const checkpoint = await prisma.externalDataSource.updateMany({
      where: { ...configurationWhere, lastCursorValue: source.lastCursorValue },
      data: { lastCursorValue: serializedCursor, lastSyncAt: new Date(), lastSyncError: null },
    });
    if (checkpoint.count !== 1) {
      throw new CursorError("CURSOR_CONFLICT", "The source cursor or configuration changed before checkpoint persistence. This run did not overwrite it.");
    }
    acknowledgedCursor = serializedCursor;
    await prisma.externalDataSyncLog.update({
      where: { id: logEntry.id },
      data: { rowsProcessed: scan.rowsProcessed, chunksCreated: totalChunks, completedAt: new Date() },
    });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : "Unknown error";
    await prisma.externalDataSyncLog.update({
      where: { id: logEntry.id },
      data: { error: errorMsg, completedAt: new Date() },
    });
    // The log belongs to this attempt; the source status may already belong to
    // a newer run or configuration. Never overwrite that newer status.
    await prisma.externalDataSource.updateMany({
      where: { ...configurationWhere, lastCursorValue: acknowledgedCursor },
      data: { lastSyncError: errorMsg },
    });
    throw error;
  } finally {
    await scan?.dispose();
  }
}
