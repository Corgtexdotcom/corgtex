import { createHash } from "node:crypto";

export function quoteIdentifier(value) {
  if (typeof value !== "string" || !value || value.includes("\0")) {
    throw new Error("Invalid PostgreSQL identifier");
  }
  return `"${value.replaceAll('"', '""')}"`;
}

/** Metadata and counts only. No credentials, customer content, or row samples. */
export async function inventorySharedTenantSource(client, { existingReadOnlyTransaction = false } = {}) {
  if (!existingReadOnlyTransaction) await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    if (existingReadOnlyTransaction) {
      const { rows: [settings] } = await client.query(`SELECT
        current_setting('transaction_read_only') AS "readOnly",
        current_setting('transaction_isolation') AS isolation`);
      if (settings.readOnly !== "on" || !["repeatable read", "serializable"].includes(settings.isolation)) {
        throw new Error("Existing repeatable-read read-only transaction required");
      }
    }
    await client.query("SET LOCAL statement_timeout = '60s'");
    await client.query("SET LOCAL lock_timeout = '5s'");
    const { rows: [identity] } = await client.query(`SELECT current_database() AS database,
      current_setting('server_version') AS version,
      current_setting('transaction_read_only') AS "readOnly",
      pg_current_snapshot()::text AS snapshot`);
    if (identity.readOnly !== "on") throw new Error("Read-only snapshot required");
    const { rows: tables } = await client.query(`SELECT c.relname AS name,
      c.relkind::text AS kind, pg_total_relation_size(c.oid)::text AS "allocatedBytes"
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
        AND NOT c.relispartition ORDER BY c.relname`);
    const { schema, schemaSha256 } = await readSharedTenantSchema(client);
    const { columns } = schema;
    for (const table of tables) {
      const name = `public.${quoteIdentifier(table.name)}`;
      const { rows: [count] } = await client.query(`SELECT count(*)::text AS count FROM ${name}`);
      table.rows = count.count;
      if (columns.some((column) => column.table === table.name && column.name === "workspaceId")) {
        const { rows } = await client.query(`SELECT "workspaceId", count(*)::text AS rows
          FROM ${name} GROUP BY "workspaceId" ORDER BY "workspaceId" NULLS FIRST`);
        table.workspaces = rows;
      }
    }
    const workspaceColumns = columns.filter((column) => column.table === "Workspace").map((column) => column.name);
    const workspaceFields = ["id", "slug", "createdAt"].filter((name) => workspaceColumns.includes(name));
    const workspaces = workspaceFields.includes("id")
      ? (await client.query(`SELECT ${workspaceFields.map(quoteIdentifier).join(", ")}
          FROM public."Workspace" ORDER BY id`)).rows : [];
    if (!existingReadOnlyTransaction) await client.query("COMMIT");
    return { formatVersion: 1, capturedAt: new Date().toISOString(), identity,
      schemaSha256, schema, tables, workspaces };
  } catch (error) {
    if (!existingReadOnlyTransaction) await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

/** Catalog only; caller owns transaction/isolation and no data counts are read. */
export async function readSharedTenantSchema(client) {
  const { rows: columns } = await client.query(`SELECT c.relname AS "table", a.attname AS name,
    format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS "notNull",
    a.attidentity::text AS identity, a.attgenerated::text AS generated,
    pg_get_expr(d.adbin, d.adrelid) AS "default"
    FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
      AND a.attnum > 0 AND NOT a.attisdropped ORDER BY c.relname, a.attnum`);
  const { rows: constraints } = await client.query(`SELECT c.relname AS "table", k.conname AS name,
    k.contype::text AS type, pg_get_constraintdef(k.oid, true) AS definition,
    k.condeferrable AS deferrable, k.condeferred AS deferred,
    rn.nspname AS "referencedSchema", r.relname AS "referencedTable",
    ARRAY(SELECT a.attname::text FROM unnest(k.conkey) WITH ORDINALITY x(attnum, position)
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = x.attnum ORDER BY x.position) AS columns,
    ARRAY(SELECT a.attname::text FROM unnest(k.confkey) WITH ORDINALITY x(attnum, position)
      JOIN pg_attribute a ON a.attrelid = r.oid AND a.attnum = x.attnum ORDER BY x.position) AS "referencedColumns"
    FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_class r ON r.oid = k.confrelid
    LEFT JOIN pg_namespace rn ON rn.oid = r.relnamespace
    WHERE n.nspname = 'public' AND NOT c.relispartition ORDER BY c.relname, k.conname`);
  const { rows: indexes } = await client.query(`SELECT tablename AS "table", indexname AS name,
    indexdef AS definition FROM pg_indexes WHERE schemaname = 'public'
    ORDER BY tablename, indexname`);
  const { rows: triggers } = await client.query(`SELECT c.relname AS "table", t.tgname AS name,
    pg_get_triggerdef(t.oid, true) AS definition FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND NOT t.tgisinternal ORDER BY c.relname, t.tgname`);
  const schema = { columns, constraints, indexes, triggers };
  const schemaSha256 = createHash("sha256").update(JSON.stringify(schema)).digest("hex");
  return { schema, schemaSha256 };
}
