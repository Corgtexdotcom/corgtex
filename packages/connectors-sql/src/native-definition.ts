import { assertBookmarkDefinition, CursorError, orderColumns } from "./cursor";
import type { TableDefinition } from "./cursor";

// Native declaration matches the domain receipt contract.
// Cursor bookmarks retain their existing ordering-only wire format.
interface CapturedSqlColumn {
  name: string;
  type: string;
  typeOid: number;
  typeModifier: number;
  collationOid: number;
  position: number;
  isNullable: boolean;
  identity: string;
  generated: string;
}

export interface CapturedSqlDefinition extends TableDefinition {
  columns: readonly CapturedSqlColumn[];
}

export function cursorDefinition(definition: TableDefinition): TableDefinition {
  return { schema: definition.schema, name: definition.name, relationOid: definition.relationOid,
    cursor: definition.cursor, key: definition.key };
}

export function capturedDefinition(definition: TableDefinition): CapturedSqlDefinition {
  const ordering = cursorDefinition(definition);
  assertBookmarkDefinition({ definition: ordering, values: orderColumns(ordering).map(() => "") }, ordering, ordering.name);
  const unproved = () => new Error("SQL native captured column metadata is unproved");
  if (!("columns" in definition) || !Array.isArray(definition.columns) || definition.columns.length === 0) throw unproved();
  const names = new Set<string>();
  let position = 0;
  const integer = (value: unknown, min: number, max: number) => typeof value === "number"
    && Number.isInteger(value) && value >= min && value <= max;
  const columns: CapturedSqlColumn[] = definition.columns.map((value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw unproved();
    const column = value as Record<string, unknown>;
    if (typeof column.name !== "string" || !column.name || column.name.includes("\0") || names.has(column.name)
      || typeof column.type !== "string" || !column.type || column.type.includes("\0")
      || !integer(column.typeOid, 1, 4_294_967_295) || !integer(column.typeModifier, -1, 2_147_483_647)
      || !integer(column.collationOid, 0, 4_294_967_295) || !integer(column.position, position + 1, 32767)
      || typeof column.isNullable !== "boolean" || typeof column.identity !== "string" || !["", "a", "d"].includes(column.identity)
      || typeof column.generated !== "string" || !["", "s", "v"].includes(column.generated)) throw unproved();
    names.add(column.name);
    position = column.position as number;
    return { name: column.name, type: column.type, typeOid: column.typeOid as number,
      typeModifier: column.typeModifier as number, collationOid: column.collationOid as number,
      position, isNullable: column.isNullable, identity: column.identity as string, generated: column.generated as string };
  });
  for (const ordered of orderColumns(ordering)) {
    const full = columns.find((column) => column.name === ordered.name);
    if (!full || full.isNullable || full.type !== ordered.type || full.typeOid !== ordered.typeOid
      || full.typeModifier !== ordered.typeModifier || full.collationOid !== ordered.collationOid) throw unproved();
  }
  return { ...ordering, columns };
}

export function assertCapturedDefinition(expected: TableDefinition, actual: TableDefinition, table: string): void {
  const saved = capturedDefinition(expected);
  const current = capturedDefinition(actual);
  assertBookmarkDefinition({ definition: cursorDefinition(saved), values: orderColumns(saved).map(() => "") }, cursorDefinition(current), table);
  if (JSON.stringify(saved.columns) !== JSON.stringify(current.columns)) {
    throw new CursorError("CURSOR_DEFINITION_CHANGED", `The captured native column definition for ${table} changed.`);
  }
}

export function assertCapturedFields(definition: TableDefinition, fields: readonly {
  name: string; tableID: number; columnID: number; dataTypeID: number; dataTypeModifier: number;
}[], wireColumns: readonly { typeOid: number; typeModifier: number }[]): void {
  const { columns } = capturedDefinition(definition);
  if (wireColumns.length !== columns.length || fields.length !== columns.length || fields.some((field, index) => {
    const column = columns[index];
    const wire = wireColumns[index];
    return field.name !== column.name || field.tableID !== definition.relationOid
      || field.columnID !== column.position || field.dataTypeID !== wire.typeOid
      || field.dataTypeModifier !== wire.typeModifier;
  })) {
    throw new Error("SQL native SELECT fields differ from the captured column definition");
  }
}
