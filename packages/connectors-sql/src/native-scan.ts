import { createHash } from "node:crypto";
import { renderSqlNativeRow } from "@corgtex/domain/sql-native-driver";
import { decrypt } from "./encryption";
import { connectReadOnly, describeTable, pullPage, usesTemporalTextDecoding } from "./postgres";
import { assertBookmarkDefinition, CursorError, orderColumns, parseCursor, serializeCursor } from "./cursor";
import { assertCapturedDefinition, cursorDefinition } from "./native-definition";
import type { CapturedSqlDefinition } from "./native-definition";

const PAGE_SIZE = 1000;
const MAX_PAGES_PER_RUN = 10;

export interface PlannedSqlRow {
  row: Record<string, unknown>;
  table: string;
  definition: CapturedSqlDefinition;
  values: string[];
  primaryKey: string;
  content: string;
}

export interface ScanConfiguration {
  lastCursorValue: string | null;
  id: string;
  workspaceId: string;
  driverType: string;
  connectionStringEnc: string;
  cursorColumn: string;
  selectedTables: readonly string[];
}

export function scanFingerprint(source: ScanConfiguration): string {
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
  definition: CapturedSqlDefinition,
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
  const identityColumn = ["id", "uuid", "_id"].find((name) => row[name]) ?? Object.keys(row)[0];
  const previousKey = row[identityColumn];
  if (usesTemporalTextDecoding(definition, identityColumn) || String(previousKey) !== exactKey) {
    // Exact text decoding must not silently adopt new IDs where the legacy
    // connector used Date.toString() for a temporal primary key.
    throw new CursorError("CURSOR_IDENTITY_CHANGED", `${table} has a row whose existing identity differs from its primary key. An explicit identity/resync decision is required; no row identities were migrated.`);
  }
  return exactKey;
}

/**
 * Capture the complete bounded native output without Knowledge writes.
 * Incremental polling needs stable keys and advancing change cursors. Commits
 * behind a saved watermark, backdated updates and deletes are not captured;
 * read-committed pages may see different snapshots. The publication fence owns
 * run freshness, not change-data-capture or automatic resync semantics.
 */
export async function capturePostgresScan(source: ScanConfiguration, assertCurrentSource: () => Promise<void>) {
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

  async function native<T>(operation: () => Promise<T>): Promise<T> {
    await assertCurrentSource();
    let result: T;
    try { result = await operation(); }
    catch (error) { await assertCurrentSource(); throw error; }
    await assertCurrentSource();
    return result;
  }
  await assertCurrentSource();
  // Keep ownership of the returned connection even if the post-connect
  // authority check fails, so disposal still happens exactly once.
  const client = await connectReadOnly(decrypt(source.connectionStringEnc)).catch(async (error: unknown) => {
    await assertCurrentSource();
    throw error;
  });
  let closed = false;
  async function dispose() {
    if (closed) return;
    closed = true;
    await client.end();
  }
  try {
    await assertCurrentSource();
    const definitions = new Map<string, CapturedSqlDefinition>();
    const relations = new Set<string>();
    for (const table of source.selectedTables) {
      const definition = await native(() => describeTable(client, table, source.cursorColumn));
      if (definition.key.length !== 1) {
        throw new CursorError("CURSOR_IDENTITY_UNSUPPORTED", `${table} uses a composite primary key. Stable composite identity requires an explicit identity/resync decision; no identity migration was performed.`);
      }
      const relation = `${definition.relationOid}:${definition.schema}:${definition.name}`;
      if (relations.has(relation)) {
        throw new CursorError("CURSOR_CONFIGURATION_INVALID", "Two selected table tokens resolve to the same source table; preserve the existing identity token.");
      }
      relations.add(relation);
      if (Object.hasOwn(state.tables, table)) {
        assertBookmarkDefinition(state.tables[table], cursorDefinition(definition), table);
      }
      definitions.set(table, definition);
    }

    async function assertCurrentDefinition(table: string) {
      const definition = definitions.get(table)!;
      const actual = await native(() => describeTable(client, table, source.cursorColumn));
      assertCapturedDefinition(definition, actual, table);
    }

    const queue = [...source.selectedTables];
    if (state.nextTable !== null) {
      const start = queue.indexOf(state.nextTable);
      queue.push(...queue.splice(0, start));
    }
    const plannedRows: PlannedSqlRow[] = [];
    let totalRows = 0;
    const capturedPages: Array<{
      table: string; definition: CapturedSqlDefinition; previous: string[] | null;
      rowCount: number; tail: string[] | null;
    }> = [];
    while (queue.length > 0 && capturedPages.length < MAX_PAGES_PER_RUN) {
      await assertCurrentSource();
      const table = queue.shift()!;
      await assertCurrentDefinition(table);
      const definition = definitions.get(table)!;
      const previous = Object.hasOwn(state.tables, table) ? state.tables[table].values : null;
      const page = await native(() => pullPage(client, definition, previous, PAGE_SIZE));
      // RowDescription exposes a domain's base type and cannot distinguish
      // same-wire domain swaps or nullability/identity changes during SELECT.
      await assertCurrentDefinition(table);
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
      capturedPages.push({ table, definition, previous, rowCount: page.rows.length, tail: tail ? [...tail] : null });
      totalRows += page.rows.length;
      for (let index = 0; index < page.rows.length; index++) {
        const content = renderSqlNativeRow(page.rows[index].row, definition.columns);
        const pk = identities[index];
        plannedRows.push({
          row: page.rows[index].row, table, definition, values: [...page.rows[index].values], primaryKey: pk, content,
        });
      }
      if (tail) {
        Object.defineProperty(state.tables, table, {
          value: { definition: cursorDefinition(definition), values: [...tail] }, enumerable: true, configurable: true, writable: true,
        });
      }
      if (page.rows.length === PAGE_SIZE) queue.push(table);
    }
    state.nextTable = queue[0] ?? null;
    return {
      rows: plannedRows,
      pages: capturedPages,
      rowsProcessed: totalRows,
      nextCursor: serializeCursor(state),
      async beforePublication() {
        try {
          // Recheck after model preparation, before opening a publication TX.
          for (const table of source.selectedTables) await assertCurrentDefinition(table);
          await assertCurrentSource();
        } catch (error) {
          await dispose().catch(() => undefined);
          throw error;
        }
        await dispose();
        await assertCurrentSource();
      },
      dispose,
    };
  } catch (error) {
    await dispose().catch(() => undefined);
    throw error;
  }
}
