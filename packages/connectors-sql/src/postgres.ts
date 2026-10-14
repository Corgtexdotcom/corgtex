import pg from "pg";
import { assertBookmarkDefinition, orderColumns, SQL_CURSOR_TYPE_OIDS } from "./cursor";
import type { CursorColumn, SqlCursorType, TableDefinition } from "./cursor";
import { assertCapturedFields, capturedDefinition, cursorDefinition } from "./native-definition";
import type { CapturedSqlDefinition } from "./native-definition";

const { Client } = pg;
const supportedTypes = new Set<string>(Object.keys(SQL_CURSOR_TYPE_OIDS));
const temporalTextOids = new Set([1082, 1114, 1184, 1182, 1115, 1185]);
// RowDescription flattens domain types, whereas the sealed declaration must
// retain their original OIDs. Provider-only wire metadata never enters receipts.
const wireDefinitions = new WeakMap<TableDefinition, readonly { typeOid: number; typeModifier: number }[]>();

function wireColumns(definition: TableDefinition) {
  const columns = wireDefinitions.get(definition);
  if (!columns) throw new Error("SQL native wire column metadata is unproved");
  return columns;
}

/** Preserve the legacy identity pause for cells whose old pg Date decoding
 * differs from exact native text, including domains and temporal arrays. */
export function usesTemporalTextDecoding(definition: CapturedSqlDefinition, name: string): boolean {
  const index = definition.columns.findIndex((column) => column.name === name);
  return index >= 0 && temporalTextOids.has(wireColumns(definition)[index].typeOid);
}

function quoteIdentifier(value: string): string {
  if (!value || value.includes("\0")) {
    throw new Error("SQL identifiers must be nonempty and cannot contain null characters");
  }
  return `"${value.replace(/"/g, '""')}"`;
}

function tableNames(token: string): { schema: string; name: string } {
  const input = token;
  const parts: string[] = [];
  let position = 0;
  if (!input || input.includes("\0")) throw new Error("Invalid SQL table identifier");

  while (position < input.length) {
    const componentStart = position;
    while (/\s/.test(input[position] ?? "")) position++;
    let name = "";
    if (input[position] === '"') {
      position++;
      let closed = false;
      while (position < input.length) {
        const character = input[position++];
        if (character !== '"') {
          name += character;
        } else if (input[position] === '"') {
          name += '"';
          position++;
        } else {
          closed = true;
          break;
        }
      }
      if (!closed) throw new Error("Invalid quoted SQL table identifier");
      while (/\s/.test(input[position] ?? "")) position++;
      if (position < input.length && input[position] !== ".") {
        throw new Error("Invalid quoted SQL table identifier");
      }
    } else {
      if (position !== componentStart) throw new Error("Invalid SQL table identifier");
      const start = position;
      while (position < input.length && input[position] !== ".") {
        if (input[position] === '"') throw new Error("Invalid SQL table identifier");
        position++;
      }
      // Only simple legacy tokens are unambiguous without SQL quoting.
      name = input.slice(start, position);
      if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(name)) {
        throw new Error("Invalid SQL table identifier; quote unusual schema and table names");
      }
    }
    if (!name || parts.length === 2) throw new Error("Invalid SQL table identifier");
    parts.push(name);
    if (position < input.length) {
      position++;
      if (position === input.length) throw new Error("Invalid SQL table identifier");
    }
  }
  return parts.length === 1
    ? { schema: "public", name: parts[0] }
    : { schema: parts[0], name: parts[1] };
}

function pageLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new Error("SQL ingestion page limit must be an integer between 1 and 1000");
  }
}

export async function connectReadOnly(connectionString: string) {
  const client = new Client({ connectionString });
  try {
    // pg's default Date decoding loses microseconds and interprets naive dates
    // in the host timezone. Override only this native connector client; keep
    // scalar and array wire text exactly as the authenticated server sent it.
    for (const oid of temporalTextOids) {
      client.setTypeParser(oid, "text", (value) => value);
    }
    await client.connect();
    await client.query("SET statement_timeout = 30000");
    await client.query("SET default_transaction_read_only = on");
    await client.query("SET TIME ZONE 'UTC'");
    await client.query("SET DateStyle = ISO");
    return client;
  } catch (error) {
    await client.end().catch(() => undefined);
    throw error;
  }
}

export async function listTables(client: pg.Client): Promise<string[]> {
  const query = `
    SELECT pg_catalog.quote_ident(table_schema) || '.' ||
      pg_catalog.quote_ident(table_name) AS full_name
    FROM information_schema.tables
    WHERE table_type = 'BASE TABLE'
      AND table_schema NOT IN ('pg_catalog', 'information_schema')
    ORDER BY table_schema, table_name
  `;
  const result = await client.query<{ full_name: string }>(query);
  return result.rows.map((row) => row.full_name);
}

export async function pullRows(
  client: pg.Client,
  table: string,
  cursorCol: string,
  lastValue: string | null,
  limit: number
): Promise<Record<string, unknown>[]> {
  const names = tableNames(table);
  const safeSchema = quoteIdentifier(names.schema);
  const safeName = quoteIdentifier(names.name);
  const safeCursor = quoteIdentifier(cursorCol);

  let queryText = `SELECT * FROM ${safeSchema}.${safeName}`;
  const queryValues: unknown[] = [];

  if (lastValue) {
    queryText += ` WHERE ${safeCursor} > $1`;
    queryValues.push(lastValue);
  }

  queryText += ` ORDER BY ${safeCursor} ASC LIMIT $${queryValues.length + 1}`;
  queryValues.push(limit);

  const result = await client.query<Record<string, unknown>>(queryText, queryValues);
  return result.rows;
}

const describeTableQuery = `
  WITH RECURSIVE relation AS (
    SELECT c.oid, c.relkind, n.nspname, c.relname
    FROM pg_catalog.pg_class AS c
    JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
    WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('r', 'p')
      AND (c.relkind = 'p' OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_inherits AS inh WHERE inh.inhparent = c.oid
      ))
  ), column_wire_types AS (
    SELECT a.attrelid, a.attnum, a.atttypid AS type_oid, a.atttypmod AS type_mod
    FROM relation AS r JOIN pg_catalog.pg_attribute AS a ON a.attrelid = r.oid
    WHERE a.attnum > 0 AND NOT a.attisdropped
    UNION ALL
    SELECT w.attrelid, w.attnum, t.typbasetype,
      CASE WHEN w.type_mod = -1 THEN t.typtypmod ELSE w.type_mod END
    FROM column_wire_types AS w JOIN pg_catalog.pg_type AS t ON t.oid = w.type_oid
    WHERE t.typtype = 'd'
  ), eligible_cursor AS (
    SELECT r.*, a.attname AS cursor_name, a.atttypid AS cursor_type_oid,
      a.atttypmod AS cursor_type_mod, a.attcollation AS cursor_collation_oid,
      t.typname AS cursor_type
    FROM relation AS r
    JOIN pg_catalog.pg_attribute AS a ON a.attrelid = r.oid
    JOIN pg_catalog.pg_type AS t ON t.oid = a.atttypid
    JOIN pg_catalog.pg_namespace AS tn ON tn.oid = t.typnamespace
    WHERE a.attname = $3 AND a.attnum > 0 AND NOT a.attisdropped
      AND a.attnotnull AND tn.nspname = 'pg_catalog' AND t.typtype = 'b'
      AND t.typname IN (
        'int2', 'int4', 'int8', 'numeric', 'date', 'timestamp',
        'timestamptz', 'uuid', 'text', 'varchar', 'bpchar'
      )
  ), eligible_key AS (
    SELECT r.oid, i.indexrelid,
      pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'column', a.attname, 'type', t.typname, 'typeOid', a.atttypid,
        'typeMod', a.atttypmod, 'collationOid', a.attcollation
      ) ORDER BY k.position) AS key_columns
    FROM relation AS r
    JOIN pg_catalog.pg_index AS i ON i.indrelid = r.oid
    JOIN pg_catalog.pg_class AS ic ON ic.oid = i.indexrelid
    JOIN pg_catalog.pg_am AS am ON am.oid = ic.relam
    CROSS JOIN LATERAL ROWS FROM (
      pg_catalog.unnest(i.indkey::pg_catalog.int2[]),
      pg_catalog.unnest(i.indclass::pg_catalog.oid[]),
      pg_catalog.unnest(i.indcollation::pg_catalog.oid[])
    ) WITH ORDINALITY AS k(attnum, opclass_oid, collation_oid, position)
    JOIN pg_catalog.pg_attribute AS a
      ON a.attrelid = r.oid AND a.attnum = k.attnum
    JOIN pg_catalog.pg_type AS t ON t.oid = a.atttypid
    JOIN pg_catalog.pg_namespace AS tn ON tn.oid = t.typnamespace
    JOIN pg_catalog.pg_opclass AS oc ON oc.oid = k.opclass_oid
    WHERE i.indisprimary AND i.indisunique AND i.indisvalid AND i.indisready
      AND i.indislive AND i.indimmediate AND i.indpred IS NULL
      AND i.indexprs IS NULL AND am.amname = 'btree'
      AND k.position <= i.indnkeyatts
    GROUP BY r.oid, i.indexrelid, i.indnkeyatts
    HAVING pg_catalog.count(*) = i.indnkeyatts AND pg_catalog.bool_and(
      a.attnum > 0 AND NOT a.attisdropped AND a.attnotnull
      AND tn.nspname = 'pg_catalog' AND t.typtype = 'b'
      AND t.typname IN (
        'int2', 'int4', 'int8', 'numeric', 'date', 'timestamp',
        'timestamptz', 'uuid', 'text', 'varchar', 'bpchar'
      )
      AND oc.opcdefault AND k.collation_oid = a.attcollation
    )
  )
  SELECT c.oid AS relation_oid, c.nspname AS schema_name, c.relname AS table_name,
    c.cursor_name, c.cursor_type, c.cursor_type_oid, c.cursor_type_mod,
    c.cursor_collation_oid, k.key_columns,
    (SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'name', a.attname, 'type', t.typname, 'typeOid', a.atttypid::pg_catalog.int8,
      'typeModifier', a.atttypmod, 'collationOid', a.attcollation::pg_catalog.int8,
      'position', a.attnum, 'isNullable', NOT a.attnotnull,
      'identity', a.attidentity, 'generated', a.attgenerated
    ) ORDER BY a.attnum)
      FROM pg_catalog.pg_attribute AS a
      JOIN pg_catalog.pg_type AS t ON t.oid = a.atttypid
      WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    ) AS captured_columns,
    (SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'position', w.attnum, 'typeOid', w.type_oid::pg_catalog.int8, 'typeModifier', w.type_mod
    ) ORDER BY w.attnum)
      FROM column_wire_types AS w JOIN pg_catalog.pg_type AS t ON t.oid = w.type_oid
      WHERE w.attrelid = c.oid AND t.typtype <> 'd'
    ) AS wire_columns
  FROM eligible_cursor AS c JOIN eligible_key AS k ON k.oid = c.oid
`;

function metadataInteger(value: unknown, minimum: number, maximum = 4_294_967_295): number {
  const parsed = typeof value === "string" && /^-?\d+$/.test(value)
    ? Number(value)
    : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) ||
      parsed < minimum || parsed > maximum) {
    throw new Error("Invalid PostgreSQL cursor metadata");
  }
  return parsed;
}

function metadataColumn(value: Record<string, unknown>): CursorColumn {
  if (typeof value.column !== "string" || !value.column ||
      typeof value.type !== "string" || !supportedTypes.has(value.type)) {
    throw new Error("Invalid PostgreSQL cursor metadata");
  }
  quoteIdentifier(value.column);
  const type = value.type as SqlCursorType;
  const typeOid = metadataInteger(value.typeOid, 1);
  if (typeOid !== SQL_CURSOR_TYPE_OIDS[type]) {
    throw new Error("Invalid PostgreSQL cursor metadata");
  }
  return {
    name: value.column,
    type,
    typeOid,
    typeModifier: metadataInteger(value.typeMod, -1, 2_147_483_647),
    collationOid: metadataInteger(value.collationOid, 0),
  };
}

/** Authenticated metadata no longer identifies a supported captured table. */
export class SqlTableDefinitionUnavailableError extends Error {}

export async function describeTable(
  client: pg.Client,
  tableToken: string,
  cursorColumn: string
): Promise<CapturedSqlDefinition> {
  const names = tableNames(tableToken);
  quoteIdentifier(cursorColumn);
  const result = await client.query<Record<string, unknown>>(
    describeTableQuery, [names.schema, names.name, cursorColumn]
  );
  if (result.rows.length !== 1) {
    throw new SqlTableDefinitionUnavailableError(`Unsupported SQL ingestion configuration for ${tableToken}: ` +
      "require a NOT NULL supported cursor and an immediate, valid btree primary key");
  }

  const metadata = result.rows[0];
  if (metadata.schema_name !== names.schema || metadata.table_name !== names.name ||
      metadata.cursor_name !== cursorColumn || !Array.isArray(metadata.key_columns) ||
      metadata.key_columns.length === 0) {
    throw new Error("Invalid PostgreSQL cursor metadata");
  }
  const key = metadata.key_columns.map((column: unknown) => {
    if (!column || typeof column !== "object" || Array.isArray(column)) {
      throw new Error("Invalid PostgreSQL cursor metadata");
    }
    return metadataColumn(column as Record<string, unknown>);
  });
  if (new Set(key.map((column) => column.name)).size !== key.length) {
    throw new Error("Invalid PostgreSQL cursor metadata");
  }

  const definition = {
    ...names,
    relationOid: metadataInteger(metadata.relation_oid, 1),
    cursor: metadataColumn({
      column: metadata.cursor_name, type: metadata.cursor_type,
      typeOid: metadata.cursor_type_oid, typeMod: metadata.cursor_type_mod,
      collationOid: metadata.cursor_collation_oid,
    }),
    key,
    columns: metadata.captured_columns,
  };
  const captured = capturedDefinition(definition);
  if (!Array.isArray(metadata.wire_columns) || metadata.wire_columns.length !== captured.columns.length) {
    throw new Error("Invalid PostgreSQL wire column metadata");
  }
  const wire = metadata.wire_columns.map((value: unknown, index) => {
    if (!value || typeof value !== "object" || !("position" in value) || !("typeOid" in value) || !("typeModifier" in value)
      || value.position !== captured.columns[index].position) throw new Error("Invalid PostgreSQL wire column metadata");
    return { typeOid: metadataInteger(value.typeOid, 1), typeModifier: metadataInteger(value.typeModifier, -1, 2_147_483_647) };
  });
  wireDefinitions.set(captured, wire);
  return captured;
}

export async function pullPage(
  client: pg.Client,
  definition: TableDefinition,
  values: string[] | null,
  limit: number
): Promise<{ rows: Array<{ row: Record<string, unknown>; values: string[] }> }> {
  pageLimit(limit);
  // Validate the complete key before orderColumns removes a cursor overlap.
  assertBookmarkDefinition({
    definition: cursorDefinition(definition),
    values: Array.from({ length: orderColumns(definition).length }, () => ""),
  }, cursorDefinition(definition), `${definition.schema}.${definition.name}`);
  const columns = orderColumns(definition);
  if (definition.key.length === 0 || new Set(columns.map((column) => column.name)).size !== columns.length ||
      columns.some((column) => !supportedTypes.has(column.type))) {
    throw new Error("Invalid SQL ingestion order");
  }
  if (values !== null && (values.length !== columns.length ||
      values.some((value) => typeof value !== "string"))) {
    throw new Error("Invalid SQL ingestion cursor tuple");
  }

  const expressions = columns.map((column) => `r.${quoteIdentifier(column.name)}`);
  const table = `${quoteIdentifier(definition.schema)}.${quoteIdentifier(definition.name)}`;
  let text = `SELECT r.*, ${expressions.map((column) => `${column}::pg_catalog.text`).join(", ")} ` +
    `FROM ${table} AS r`;
  const queryValues: unknown[] = [];
  if (values !== null) {
    const parameters = columns.map((column, index) => `$${index + 1}::pg_catalog.${column.type}`);
    text += ` WHERE (${expressions.join(", ")}) OPERATOR(pg_catalog.>) (${parameters.join(", ")})`;
    queryValues.push(...values);
  }
  text += ` ORDER BY ${expressions.map((column) => `${column} ASC`).join(", ")}`;
  text += ` LIMIT $${queryValues.length + 1}`;
  queryValues.push(limit);

  const result = await client.query<unknown[]>({ text, values: queryValues, rowMode: "array" });
  const fieldCount = result.fields.length;
  const rowFieldCount = fieldCount - columns.length;
  if (rowFieldCount < 1) throw new Error("Invalid PostgreSQL ingestion page fields");
  const rowFields = result.fields.slice(0, rowFieldCount);
  if ("columns" in definition) assertCapturedFields(definition, rowFields, wireColumns(definition));
  const rows = result.rows.map((raw) => {
    if (!Array.isArray(raw) || raw.length !== fieldCount) {
      throw new Error("Invalid PostgreSQL ingestion page row");
    }
    const tuple = raw.slice(rowFieldCount);
    if (tuple.some((value) => typeof value !== "string")) {
      throw new Error("SQL ingestion cursor and primary key values must be non-null PostgreSQL text");
    }
    return {
      row: Object.fromEntries(rowFields.map((field, index) => [field.name, raw[index]])),
      values: tuple as string[],
    };
  });
  return { rows };
}

/** Execute the original SELECT-* privilege boundary under current native RLS.
 * Payload is deliberately discarded; only native exact tuples leave this check.
 */
export async function readAccessibleTuples(
  client: pg.Client,
  definition: CapturedSqlDefinition,
  tuples: readonly (readonly string[])[],
): Promise<string[][]> {
  if (tuples.length > 1000) throw new Error("SQL access validation batch exceeds its bounded limit");
  const columns = orderColumns(definition);
  const ordering = cursorDefinition(definition);
  capturedDefinition(definition);
  assertBookmarkDefinition({ definition: ordering, values: columns.map(() => "") }, ordering, `${definition.schema}.${definition.name}`);
  for (const tuple of tuples) {
    assertBookmarkDefinition({ definition: ordering, values: [...tuple] }, ordering, `${definition.schema}.${definition.name}`);
  }
  const expressions = columns.map((column) => `r.${quoteIdentifier(column.name)}`);
  const table = `${quoteIdentifier(definition.schema)}.${quoteIdentifier(definition.name)}`;
  const parameters: string[] = [];
  const values: string[] = [];
  for (const tuple of tuples) {
    const projected = columns.map((column, index) => {
      values.push(tuple[index]);
      return `$${values.length}::pg_catalog.${column.type}`;
    });
    parameters.push(`(${projected.join(", ")})`);
  }
  const predicate = tuples.length === 0 ? "false"
    : parameters.map((tuple) => `((${expressions.join(", ")}) OPERATOR(pg_catalog.=) ${tuple})`).join(" OR ");
  const result = await client.query<unknown[]>({
    text: `SELECT r.*, ${expressions.map((column) => `${column}::pg_catalog.text`).join(", ")} FROM ${table} AS r WHERE ${predicate}`,
    values,
    rowMode: "array",
  });
  if (result.fields.length <= columns.length) throw new Error("Unproved PostgreSQL access result fields");
  assertCapturedFields(definition, result.fields.slice(0, -columns.length), wireColumns(definition));
  return result.rows.map((row) => {
    if (!Array.isArray(row) || row.length !== result.fields.length) throw new Error("Unproved PostgreSQL access result row");
    const tuple = row.slice(-columns.length);
    if (tuple.some((value) => typeof value !== "string")) throw new Error("Unproved PostgreSQL access result tuple");
    return tuple as string[];
  });
}
