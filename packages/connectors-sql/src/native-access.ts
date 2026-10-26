import type {
  SqlNativeDefinition, SqlNativePage, SqlNativeRow, SqlSourceConfiguration,
} from "@corgtex/domain/sql-ingestion-contract";
import { assertBookmarkDefinition, CursorError, orderColumns } from "./cursor";
import type { TableDefinition } from "./cursor";
import { assertCapturedDefinition, capturedDefinition, cursorDefinition } from "./native-definition";
import type { CapturedSqlDefinition } from "./native-definition";
import { decrypt } from "./encryption";
import { connectReadOnly, describeTable, readAccessibleTuples, SqlTableDefinitionUnavailableError } from "./postgres";

// Native access proof grants no capture or publication authority on its own.
export interface SqlNativeAccessInput {
  source: SqlSourceConfiguration;
  parents: Readonly<{
    rows: readonly Pick<SqlNativeRow, "table" | "definition" | "values" | "primaryKey">[];
    pages: readonly SqlNativePage[];
  }>;
  assertCurrentSource(): Promise<void>;
}

function mutableDefinition(definition: SqlNativeDefinition): CapturedSqlDefinition {
  return capturedDefinition({ ...definition, cursor: { ...definition.cursor }, key: definition.key.map((column) => ({ ...column })) });
}

class NativeAccessDenied extends Error {}

function authenticatedDenial(error: unknown): boolean {
  if (error instanceof SqlTableDefinitionUnavailableError) return true;
  // This error follows authentication and a native object/SELECT operation.
  // Connection authentication, transport, timeout and unknown failures are not
  // proof of native denial and must not permanently retire a serving receipt.
  return error !== null && typeof error === "object" && "code" in error
    && error.code === "42501";
}

export async function validatePostgresNativeAccess(input: Readonly<SqlNativeAccessInput>): Promise<boolean> {
  const { source, parents, assertCurrentSource } = input;
  await assertCurrentSource();
  if (source.driverType !== "postgres") throw new Error("SQL native access driver is unsupported");
  if (!source.isActive || source.archivedAt) return false;
  if (parents.rows.length > 10_000 || parents.pages.length > 10) throw new Error("SQL native access parent set exceeds the captured run bound");
  const tables = new Map<string, { definition: CapturedSqlDefinition; tuples: Map<string, string[]> }>();
  function tableParent(table: string, nativeDefinition: SqlNativeDefinition) {
    if (!source.selectedTables.includes(table)) throw new Error("SQL native access table is not in the authoritative source configuration");
    const definition = mutableDefinition(nativeDefinition);
    if (definition.key.length !== 1) throw new Error("SQL native access requires a proved scalar row identity");
    const existing = tables.get(table);
    if (existing) {
      assertCapturedDefinition(definition, existing.definition, table);
      return existing;
    }
    const entry = { definition, tuples: new Map<string, string[]>() };
    tables.set(table, entry);
    return entry;
  }
  for (const page of parents.pages) tableParent(page.table, page.definition);
  for (const row of parents.rows) {
    const entry = tableParent(row.table, row.definition);
    const values = [...row.values];
    const ordering = cursorDefinition(entry.definition);
    assertBookmarkDefinition({ definition: ordering, values }, ordering, row.table);
    const keyPosition = orderColumns(entry.definition).findIndex((column) => column.name === entry.definition.key[0].name);
    if (values[keyPosition] !== row.primaryKey) throw new Error("SQL native access parent identity is unproved");
    entry.tuples.set(JSON.stringify(values), values);
  }
  if (tables.size === 0) throw new Error("SQL native access has no authenticated table parents");

  async function native<T>(operation: () => Promise<T>): Promise<T> {
    await assertCurrentSource();
    let result: T;
    try { result = await operation(); }
    catch (error) {
      await assertCurrentSource();
      if (authenticatedDenial(error)) throw new NativeAccessDenied("Authenticated native SELECT or table definition denied");
      throw error;
    }
    await assertCurrentSource();
    return result;
  }

  // Do not translate connection/authentication failure into permanent denial.
  await assertCurrentSource();
  const client = await connectReadOnly(decrypt(source.connectionStringEnc)).catch(async (error: unknown) => {
    await assertCurrentSource();
    throw error;
  });
  let allowed = true;
  let failed = false;
  let failure: unknown;
  function definitionMatches(expected: TableDefinition, actual: TableDefinition, table: string) {
    try {
      assertCapturedDefinition(expected, actual, table);
      return true;
    } catch (error) {
      if (error instanceof CursorError && error.code === "CURSOR_DEFINITION_CHANGED") return false;
      throw error;
    }
  }
  try {
    await assertCurrentSource();
    for (const [table, entry] of tables) {
      const actual = await native(() => describeTable(client, table, source.cursorColumn));
      if (!definitionMatches(entry.definition, actual, table)) { allowed = false; break; }
      const tuples = [...entry.tuples.values()];
      for (let offset = 0; offset < Math.max(tuples.length, 1); offset += 1000) {
        const batch = tuples.slice(offset, offset + 1000);
        const current = await native(() => readAccessibleTuples(client, actual, batch));
        const visible = new Set(current.map((tuple) => JSON.stringify(tuple)));
        if (batch.some((tuple) => !visible.has(JSON.stringify(tuple)))) { allowed = false; break; }
      }
      if (!allowed) break;
      // A table can be changed between provider round trips. Recheck the exact
      // native definition after its SELECT boundary before accepting the proof.
      const final = await native(() => describeTable(client, table, source.cursorColumn));
      if (!definitionMatches(entry.definition, final, table)) { allowed = false; break; }
    }
  } catch (error) {
    if (error instanceof NativeAccessDenied) allowed = false;
    else { failed = true; failure = error; }
  } finally {
    try { await client.end(); }
    catch (error) { if (!failed) { failed = true; failure = error; } }
  }
  await assertCurrentSource();
  if (failed) throw failure;
  return allowed;
}
