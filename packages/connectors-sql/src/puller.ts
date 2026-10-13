import { createHash } from "node:crypto";
import { prisma } from "@corgtex/shared";
import { syncKnowledgeForSource } from "@corgtex/knowledge";
import { decrypt } from "./encryption";
import { connectReadOnly, describeTable, pullPage } from "./postgres";
import {
  assertBookmarkDefinition,
  CursorError,
  orderColumns,
  parseCursor,
  serializeCursor,
} from "./cursor";
import type { TableDefinition } from "./cursor";

const PAGE_SIZE = 1000;
const MAX_PAGES_PER_RUN = 10;

interface ScanConfiguration {
  id: string;
  workspaceId: string;
  driverType: string;
  connectionStringEnc: string;
  cursorColumn: string;
  selectedTables: string[];
}

function scanFingerprint(source: ScanConfiguration): string {
  return createHash("sha256").update(JSON.stringify({
    sourceId: source.id,
    workspaceId: source.workspaceId,
    driverType: source.driverType,
    connectionStringEnc: source.connectionStringEnc,
    cursorColumn: source.cursorColumn,
    selectedTables: source.selectedTables,
  })).digest("hex");
}

function identityForRow(
  definition: TableDefinition,
  row: Record<string, unknown>,
  values: string[],
  table: string,
): string {
  if (definition.key.length !== 1) {
    throw new CursorError("CURSOR_IDENTITY_UNSUPPORTED", `${table} needs a scalar primary key whose existing row identities can be preserved. Composite identity migration requires an explicit resync decision.`);
  }
  const key = definition.key[0];
  const position = orderColumns(definition).findIndex((column) => column.name === key.name);
  const exactKey = values[position];
  if (typeof exactKey !== "string" || !Object.hasOwn(row, key.name)) {
    throw new CursorError("CURSOR_PAGE_INVALID", `${table} returned a missing primary-key value.`);
  }
  // A NULL checkpoint can follow committed ingestion. Retain the historical
  // namespace only when the old heuristic and enforced primary key agree on
  // every row; never silently rename existing sources or invent a fresh format.
  const previousKey = row.id || row.uuid || row._id || Object.values(row)[0];
  if (String(previousKey) !== exactKey) {
    throw new CursorError("CURSOR_IDENTITY_CHANGED", `${table} has a row whose existing identity differs from its primary key. An explicit identity/resync decision is required; no row identities were migrated.`);
  }
  return exactKey;
}

/**
 * Incremental polling requires stable keys and advancing change cursors. A row
 * committed behind a saved watermark, backdated changes, and deletes are not
 * captured. Read-committed pages can see different data, and even a repeatable-
 * read backfill cannot prevent later commits behind a persisted watermark.
 * Checkpoint CAS prevents stale cursor overwrite; it does not fence overlapping
 * knowledge writes. Cross-process content freshness needs source serialization
 * outside the unchanged knowledge contract before claiming that guarantee.
 */
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

  try {
    // Validate saved state before decrypting or contacting the source. Existing
    // nonempty legacy cursors pause with a diagnostic; no implicit reset/replay.
    const state = parseCursor(source.lastCursorValue);
    const fingerprint = scanFingerprint(source);
    if (state.scanFingerprint !== null && state.scanFingerprint !== fingerprint) {
      throw new CursorError("CURSOR_SCAN_CHANGED", "The connection, table selection, cursor, or identity configuration changed. The saved cursor was not reset; choose an explicit resync before continuing.");
    }
    state.scanFingerprint = fingerprint;
    if (source.driverType !== "postgres") throw new Error(`Unsupported driver: ${source.driverType}`);
    if (new Set(source.selectedTables).size !== source.selectedTables.length) {
      throw new CursorError("CURSOR_CONFIGURATION_INVALID", "Selected tables must not repeat the same token.");
    }
    if (state.nextTable !== null && !source.selectedTables.includes(state.nextTable)) {
      throw new CursorError("CURSOR_INVALID", "The saved next table is not in the configured selection. The cursor was not reset.");
    }

    const client = await connectReadOnly(decrypt(source.connectionStringEnc));
    try {
      const definitions = new Map<string, TableDefinition>();
      const relations = new Set<string>();
      for (const table of source.selectedTables) {
        const definition = await describeTable(client, table, source.cursorColumn);
        if (definition.key.length !== 1) {
          throw new CursorError("CURSOR_IDENTITY_UNSUPPORTED", `${table} uses a composite primary key. Stable composite identity requires an explicit identity/resync decision; no identity migration was performed.`);
        }
        const relation = `${definition.relationOid}:${definition.schema}:${definition.name}`;
        if (relations.has(relation)) {
          throw new CursorError("CURSOR_CONFIGURATION_INVALID", "Two selected table tokens resolve to the same source table; preserve the existing identity token.");
        }
        relations.add(relation);
        if (Object.hasOwn(state.tables, table)) {
          assertBookmarkDefinition(state.tables[table], definition, table);
        }
        definitions.set(table, definition);
      }

      async function assertCurrentSource() {
        const current = await prisma.externalDataSource.findUnique({ where: { id: source.id } });
        if (!current || !current.isActive || scanFingerprint(current) !== fingerprint) {
          throw new CursorError("CURSOR_SCAN_CHANGED", "The source configuration changed during ingestion. Its previous checkpoint was retained.");
        }
        if (current.lastCursorValue !== source.lastCursorValue) {
          throw new CursorError("CURSOR_CONFLICT", "Another run advanced the source checkpoint. This run cannot overwrite it.");
        }
      }

      async function assertCurrentDefinition(table: string) {
        const definition = definitions.get(table)!;
        const actual = await describeTable(client, table, source.cursorColumn);
        assertBookmarkDefinition({
          definition, values: orderColumns(definition).map(() => ""),
        }, actual, table);
      }

      const queue = [...source.selectedTables];
      if (state.nextTable !== null) {
        const start = queue.indexOf(state.nextTable);
        queue.push(...queue.splice(0, start));
      }
      let totalRows = 0;
      let totalChunks = 0;
      let pages = 0;
      while (queue.length > 0 && pages < MAX_PAGES_PER_RUN) {
        await assertCurrentSource();
        const table = queue.shift()!;
        await assertCurrentDefinition(table);
        const definition = definitions.get(table)!;
        const previous = Object.hasOwn(state.tables, table) ? state.tables[table].values : null;
        const page = await pullPage(client, definition, previous, PAGE_SIZE);
        pages++;
        if (page.rows.length > PAGE_SIZE) {
          throw new CursorError("CURSOR_PAGE_INVALID", `${table} returned more rows than the requested page limit.`);
        }
        const columns = orderColumns(definition);
        // Prevalidate the whole page before any knowledge write. Original pg
        // values remain row content; only the exact projected tuple is stored.
        const identities = page.rows.map(({ row, values }) => {
          if (values.length !== columns.length || values.some((value) => typeof value !== "string")) {
            throw new CursorError("CURSOR_PAGE_INVALID", `${table} returned an incomplete or NULL cursor tuple.`);
          }
          return identityForRow(definition, row, values, table);
        });
        const tail = page.rows.at(-1)?.values;
        if (previous && tail && previous.every((value, index) => value === tail[index])) {
          throw new CursorError("CURSOR_PAGE_INVALID", `${table} returned a page that did not advance its ordering tuple.`);
        }
        totalRows += page.rows.length;
        for (let index = 0; index < page.rows.length; index++) {
          const content = Object.entries(page.rows[index].row).map(([key, value]) => `${key}: ${value}`).join("\n");
          const pk = identities[index];
          const chunksCreated = await syncKnowledgeForSource({
            workspaceId: source.workspaceId,
            sourceType: "EXTERNAL_DATABASE",
            accessDomain: "WORKSPACE",
            sourceId: `byodb:${source.id}:${table}:${pk}`,
            sourceTitle: `${table} row ${pk}`,
            content,
            metadata: { table, sourceId: source.id },
          });
          totalChunks += typeof chunksCreated === "number" ? chunksCreated : 1;
        }
        if (tail) {
          Object.defineProperty(state.tables, table, {
            value: { definition, values: [...tail] }, enumerable: true, configurable: true, writable: true,
          });
        }
        if (page.rows.length === PAGE_SIZE) queue.push(table);
      }
      state.nextTable = queue[0] ?? null;
      // Source DDL can occur while knowledge calls run. Recheck the native
      // ordering metadata before persisting, without holding a DB transaction
      // across network work. Later DDL still requires an explicit resync.
      for (const table of source.selectedTables) await assertCurrentDefinition(table);
      await assertCurrentSource();
      // Stage page tails in memory and preserve the existing all-run durability
      // boundary. Partial ingestion replays with identical source IDs on retry.
      const serializedCursor = serializeCursor(state);
      const checkpoint = await prisma.externalDataSource.updateMany({
        where: {
          ...configurationWhere,
          lastCursorValue: source.lastCursorValue,
        },
        data: { lastCursorValue: serializedCursor, lastSyncAt: new Date(), lastSyncError: null },
      });
      if (checkpoint.count !== 1) {
        throw new CursorError("CURSOR_CONFLICT", "The source cursor or configuration changed before checkpoint persistence. This run did not overwrite it.");
      }
      acknowledgedCursor = serializedCursor;
      await prisma.externalDataSyncLog.update({
        where: { id: logEntry.id },
        data: { rowsProcessed: totalRows, chunksCreated: totalChunks, completedAt: new Date() },
      });
    } finally {
      await client.end();
    }
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
  }
}
