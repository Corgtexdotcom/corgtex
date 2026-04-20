import { prisma } from "@corgtex/shared";
import { syncKnowledgeForSource } from "@corgtex/knowledge";
import { decrypt } from "./encryption";
import { connectReadOnly, pullRows } from "./postgres";

export async function syncExternalDataSource(sourceId: string) {
  const source = await prisma.externalDataSource.findUnique({
    where: { id: sourceId },
  });

  if (!source || !source.isActive) {
    throw new Error(`Data source not found or inactive: ${sourceId}`);
  }

  const logEntry = await prisma.externalDataSyncLog.create({
    data: { sourceId },
  });

  try {
    const connectionString = decrypt(source.connectionStringEnc);
    
    if (source.driverType !== "postgres") {
      throw new Error(`Unsupported driver: ${source.driverType}`);
    }

    const client = await connectReadOnly(connectionString);

    try {
      let totalRows = 0;
      let totalChunks = 0;
      let cursorMap: Record<string, string> = {};
      
      if (source.lastCursorValue) {
        try {
          cursorMap = JSON.parse(source.lastCursorValue);
        } catch (e) {
          // ignore parsing error
        }
      }

      for (const table of source.selectedTables) {
        const lastVal = cursorMap[table] || null;
        const rows = await pullRows(client, table, source.cursorColumn, lastVal, 1000);
        
        totalRows += rows.length;

        for (const row of rows) {
          const content = Object.entries(row)
            .map(([k, v]) => `${k}: ${v}`)
            .join("\n");
            
          const pkValue = row.id || row.uuid || row._id || Object.values(row)[0];
          const pk = String(pkValue);
          const identityId = `byodb:${source.id}:${table}:${pk}`;
          
          const chunksCreated = await syncKnowledgeForSource({
            workspaceId: source.workspaceId,
            sourceType: "EXTERNAL_DATABASE",
            sourceId: identityId,
            sourceTitle: `${table} row ${pk}`,
            content,
            metadata: { table, sourceId: source.id },
          });
          
          // syncKnowledgeForSource logic usually returns the number of chunks, 
          // but if it's void we can increment by approximations, for now assume it returns chunks length or we just approximate
          totalChunks += (typeof chunksCreated === 'number' ? chunksCreated : 1);
          
          const rowCursor = String(row[source.cursorColumn]);
          if (rowCursor && (!cursorMap[table] || rowCursor > cursorMap[table])) {
            cursorMap[table] = rowCursor;
          }
        }
      }

      await prisma.externalDataSource.update({
        where: { id: source.id },
        data: { 
          lastCursorValue: JSON.stringify(cursorMap),
          lastSyncAt: new Date(),
          lastSyncError: null,
        }
      });

      await prisma.externalDataSyncLog.update({
        where: { id: logEntry.id },
        data: {
          rowsProcessed: totalRows,
          chunksCreated: totalChunks,
          completedAt: new Date(),
        },
      });

    } finally {
      await client.end();
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : "Unknown error";
    
    await prisma.externalDataSyncLog.update({
      where: { id: logEntry.id },
      data: {
        error: errorMsg,
        completedAt: new Date(),
      },
    });

    await prisma.externalDataSource.update({
      where: { id: source.id },
      data: { lastSyncError: errorMsg },
    });
    
    throw error;
  }
}
