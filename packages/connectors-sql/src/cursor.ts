export const SQL_CURSOR_TYPE_OIDS = {
  int2: 21,
  int4: 23,
  int8: 20,
  numeric: 1700,
  date: 1082,
  timestamp: 1114,
  timestamptz: 1184,
  uuid: 2950,
  text: 25,
  varchar: 1043,
  bpchar: 1042,
} as const;

export type SqlCursorType = keyof typeof SQL_CURSOR_TYPE_OIDS;

export interface CursorColumn {
  name: string;
  type: SqlCursorType;
  typeOid: number;
  typeModifier: number;
  collationOid: number;
}

export interface TableDefinition {
  schema: string;
  name: string;
  relationOid: number;
  cursor: CursorColumn;
  key: CursorColumn[];
}

export interface TableBookmark {
  definition: TableDefinition;
  values: string[];
}

export interface CursorState {
  version: 1;
  scanFingerprint: string | null;
  nextTable: string | null;
  tables: Record<string, TableBookmark>;
}

export class CursorError extends Error {
  constructor(public readonly code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "SqlCursorError";
  }
}

/** The ordering tuple always retains the cursor first and the complete unique key. */
export function orderColumns(definition: TableDefinition): CursorColumn[] {
  return [definition.cursor, ...definition.key.filter((column) => column.name !== definition.cursor.name)];
}

function invalid(message: string): never {
  throw new CursorError("CURSOR_INVALID", `${message} The stored cursor was not reset; an explicit resync decision is required.`);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalid(`${label} must be an object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    invalid(`${label} must be a plain object.`);
  }
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== "string" || !descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      invalid(`${label} contains an unsupported property.`);
    }
  }
  return value as Record<string, unknown>;
}

function fields(value: Record<string, unknown>, expected: string[], label: string): void {
  const actual = Object.keys(value);
  if (actual.length !== expected.length || expected.some((key) => !Object.hasOwn(value, key))) {
    invalid(`${label} has missing or unknown fields.`);
  }
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) invalid(`${label} must be an array.`);
  if (Object.getPrototypeOf(value) !== Array.prototype) invalid(`${label} must be a plain array.`);
  if (Reflect.ownKeys(value).length !== value.length + 1) invalid(`${label} contains unsupported properties.`);
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) invalid(`${label} must contain every array position.`);
  }
  return value;
}

function name(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    invalid(`${label} must be a nonempty name without a NUL byte.`);
  }
  return value;
}

function integer(value: unknown, minimum: number, maximum: number, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    invalid(`${label} is outside the supported metadata range.`);
  }
  return value;
}

function column(value: unknown, label: string): CursorColumn {
  const input = record(value, label);
  fields(input, ["name", "type", "typeOid", "typeModifier", "collationOid"], label);
  if (typeof input.type !== "string" || !Object.hasOwn(SQL_CURSOR_TYPE_OIDS, input.type)) {
    invalid(`${label} has an unsupported SQL type.`);
  }
  const type = input.type as SqlCursorType;
  if (input.typeOid !== SQL_CURSOR_TYPE_OIDS[type]) {
    invalid(`${label} SQL type and OID do not match.`);
  }
  return {
    name: name(input.name, `${label} name`),
    type,
    typeOid: SQL_CURSOR_TYPE_OIDS[type],
    typeModifier: integer(input.typeModifier, -1, 2_147_483_647, `${label} type modifier`),
    collationOid: integer(input.collationOid, 0, 4_294_967_295, `${label} collation OID`),
  };
}

function definition(value: unknown): TableDefinition {
  const input = record(value, "Table definition");
  fields(input, ["schema", "name", "relationOid", "cursor", "key"], "Table definition");
  const cursor = column(input.cursor, "Cursor column");
  const keyValues = array(input.key, "Primary key");
  if (keyValues.length === 0) {
    invalid("The stable primary key must contain at least one column.");
  }
  const key = keyValues.map((value, index) => column(value, `Primary key column ${index + 1}`));
  const keyNames = new Set<string>();
  for (const component of key) {
    if (keyNames.has(component.name)) invalid("Primary key column names must be unique.");
    keyNames.add(component.name);
    if (component.name === cursor.name && JSON.stringify(component) !== JSON.stringify(cursor)) {
      invalid("A cursor column in the primary key must have matching metadata.");
    }
  }
  return {
    schema: name(input.schema, "Schema"),
    name: name(input.name, "Table"),
    relationOid: integer(input.relationOid, 1, 4_294_967_295, "Relation OID"),
    cursor,
    key,
  };
}

function bookmark(value: unknown): TableBookmark {
  const input = record(value, "Table bookmark");
  fields(input, ["definition", "values"], "Table bookmark");
  const table = definition(input.definition);
  const tuple = array(input.values, "Cursor tuple");
  if (tuple.length !== orderColumns(table).length) {
    invalid("Cursor tuple length must match the database ordering columns.");
  }
  const values = tuple.map((value) => {
    if (typeof value !== "string") invalid("Every cursor tuple value must be exact SQL text.");
    return value;
  });
  return { definition: table, values };
}

function state(value: unknown): CursorState {
  const input = record(value, "Cursor state");
  fields(input, ["version", "scanFingerprint", "nextTable", "tables"], "Cursor state");
  if (input.version !== 1) {
    throw new CursorError("CURSOR_VERSION_UNSUPPORTED", "The stored cursor version is unsupported. The cursor was not reset; choose an explicit resync path.");
  }
  if (typeof input.scanFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(input.scanFingerprint)) {
    invalid("A persisted typed cursor must contain its SHA-256 scan configuration fingerprint.");
  }
  const tables = record(input.tables, "Cursor tables");
  const entries = Object.keys(tables).sort().map((token) => [name(token, "Table token"), bookmark(tables[token])] as const);
  return {
    version: 1,
    scanFingerprint: input.scanFingerprint,
    nextTable: input.nextTable === null ? null : name(input.nextTable, "Next table token"),
    tables: Object.fromEntries(entries),
  };
}

function emptyState(): CursorState {
  return { version: 1, scanFingerprint: null, nextTable: null, tables: {} };
}

/** SQL NULL and an empty legacy map are the only implicit initial states. */
export function parseCursor(value: string | null): CursorState {
  if (value === null) return emptyState();
  if (typeof value !== "string") invalid("The stored cursor must be JSON text or SQL NULL.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    invalid("The stored cursor is malformed JSON.");
  }
  const input = record(parsed, "Cursor state");
  if (Object.keys(input).length === 0) return emptyState();
  if (!Object.hasOwn(input, "version")) {
    throw new CursorError(
      "CURSOR_LEGACY_REPLAY_REQUIRED",
      "This scalar checkpoint does not record its historical connection, table/cursor ordering, or row-identity metadata. Compatibility cannot be proved from current configuration alone. The stored cursor was preserved; operator review must establish a compatible continuation or explicitly authorize recovery. No reset or replay was performed.",
    );
  }
  return state(input);
}

/** Canonical serialization preserves exact values and gives stable checkpoint text. */
export function serializeCursor(value: CursorState): string {
  return JSON.stringify(state(value));
}

export function assertBookmarkDefinition(bookmarkValue: TableBookmark, actualDefinition: TableDefinition, tableToken: string): void {
  const saved = bookmark(bookmarkValue).definition;
  const actual = definition(actualDefinition);
  if (JSON.stringify(saved) !== JSON.stringify(actual)) {
    throw new CursorError(
      "CURSOR_DEFINITION_CHANGED",
      `The database ordering definition for ${tableToken} changed. The stored cursor was not reset; choose an explicit resync before continuing.`,
    );
  }
}
