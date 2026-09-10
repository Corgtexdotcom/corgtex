import { createHash } from "node:crypto";
import { inventorySharedTenantSource, quoteIdentifier } from "./shared-tenant-inventory.mjs";
import { getWorkspaceModelMetadata, getWorkspaceOwnershipRules, type WorkspaceOwnershipRule } from "./workspace-ownership";
import { assertTransferTableFieldPolicies, transferScalarFieldKinds } from "./shared-tenant-transfer-contract";
import type {
  TenantTransferManifest, TenantTransferSnapshot, TransferColumn, TransferForeignKey,
  TransferSqlClient, TransferTableData, TransferTablePolicy,
} from "./shared-tenant-transfer-contract";

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const result = JSON.stringify(value);
    if (result === undefined) throw new Error("Undefined values cannot be hashed");
    return result;
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
}

export function canonicalManifest(manifest: TenantTransferManifest): string { return canonical(manifest); }
export function hashCanonical(value: unknown): string { return createHash("sha256").update(canonical(value)).digest("hex"); }

// Frames distinguish row boundaries, SQL NULL, empty strings, and embedded
// delimiters. Lengths are UTF-8 byte lengths, never JavaScript character counts.
export function hashFrames(rows: readonly (readonly (string | null)[])[]): string {
  const hash = createHash("sha256");
  for (const row of rows) {
    hash.update(`R${row.length}:`);
    for (const value of row) {
      if (value === null) hash.update("N;");
      else { hash.update(`S${Buffer.byteLength(value, "utf8")}:`); hash.update(value, "utf8"); }
    }
  }
  return hash.digest("hex");
}

const q = quoteIdentifier as (value: string) => string;
const tableName = (name: string) => `public.${q(name)}`;
const dispositions = new Set(["copy", "transform", "rebuild", "discard", "operator-control"]);
const fieldKinds = new Set(["content", "reference", "secret", "object", "effect"]);
const transfers = (policy: TransferTablePolicy | undefined) => policy?.disposition === "copy" || policy?.disposition === "transform";

function assertManifest(manifest: TenantTransferManifest) {
  if (manifest.formatVersion !== 1 || !manifest.transferId?.trim() || !manifest.workspaceId?.trim()
    || !manifest.workspaceSlug?.trim() || !/^[a-f0-9]{64}$/.test(manifest.schemaSha256)
    || !manifest.tables || typeof manifest.tables !== "object" || Array.isArray(manifest.tables)) {
    throw new Error("Invalid tenant transfer manifest");
  }
  for (const [name, policy] of Object.entries(manifest.tables)) {
    q(name);
    if (!policy || !dispositions.has(policy.disposition) || typeof policy.reason !== "string" || !policy.reason.trim()) {
      throw new Error(`Explicit disposition and reason required: ${name}`);
    }
    for (const [field, value] of Object.entries(policy.fields ?? {})) {
      q(field);
      if (!value || !fieldKinds.has(value.kind) || typeof value.reason !== "string" || !value.reason.trim()) {
        throw new Error(`Explicit field kind and reason required: ${name}.${field}`);
      }
      if (value.references) {
        if (value.kind !== "reference") throw new Error(`Only reference fields may declare scalar dependencies: ${name}.${field}`);
        q(value.references.table); q(value.references.column);
      }
    }
  }
  if (!transfers(manifest.tables.Workspace)) throw new Error("Workspace must have an explicit copy or transform policy");
}

function ownerSql(rule: WorkspaceOwnershipRule, alias: string): string {
  if (!rule.steps.length) return `${alias}.${q(rule.field)}`;
  const joins: string[] = [];
  let previous = alias;
  for (const [index, step] of rule.steps.entries()) {
    const current = `p${index}`;
    const condition = step.to.map((field, key) => `${current}.${q(field)} = ${previous}.${q(step.from[key])}`).join(" AND ");
    joins.push(index === 0 ? `${tableName(step.table)} ${current}` : `JOIN ${tableName(step.table)} ${current} ON ${condition}`);
    previous = current;
  }
  const first = rule.steps[0];
  const where = first.to.map((field, index) => `p0.${q(field)} = ${alias}.${q(first.from[index])}`).join(" AND ");
  return `(SELECT ${previous}.${q(rule.field)} FROM ${joins.join(" ")} WHERE ${where})`;
}

interface CatalogTable extends Omit<TransferTableData, "sha256"> {
  sourceRows: string;
  owners: string[];
  seen: Set<string>;
  referenceIndexes: Map<string, { columns: string[]; keys: Set<string> }>;
}

/** Consistent read-only export. Caller supplies a dedicated source connection. */
export async function exportTenantSnapshot(
  client: TransferSqlClient,
  manifest: TenantTransferManifest,
  { maxRows = 100_000, maxBytes = 128 * 1024 * 1024 }: { maxRows?: number; maxBytes?: number } = {},
): Promise<TenantTransferSnapshot> {
  assertManifest(manifest);
  if (!Number.isSafeInteger(maxRows) || maxRows < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error("Positive safe integer row/byte limits required");
  }
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    await client.query("SET LOCAL DateStyle = 'ISO, YMD'");
    await client.query("SET LOCAL TimeZone = 'UTC'");
    await client.query("SET LOCAL extra_float_digits = 3");
    await client.query("SET LOCAL bytea_output = 'hex'");
    const inventory = await inventorySharedTenantSource(client, { existingReadOnlyTransaction: true });
    if (inventory.schemaSha256 !== manifest.schemaSha256) throw new Error("Source schema fingerprint does not match converted-schema manifest");
    const metadata = getWorkspaceModelMetadata();
    const models = new Map([...metadata].map(([model, value]) => [value.dbName ?? model, value]));
    const ownership = getWorkspaceOwnershipRules();
    const catalog = new Map<string, CatalogTable>();
    for (const raw of inventory.tables as { name: string; rows: string }[]) {
      const columns = (inventory.schema.columns as { table: string; name: string; type: string; notNull: boolean }[])
        .filter((column) => column.table === raw.name)
        .map((column): TransferColumn => ({ name: column.name, type: column.type, nullable: !column.notNull }));
      const constraints = (inventory.schema.constraints as { table: string; type: string; columns: string[]; referencedSchema: string | null; referencedTable: string | null; referencedColumns: string[] }[])
        .filter((constraint) => constraint.table === raw.name);
      const foreignKeys: TransferForeignKey[] = constraints.filter((constraint) => constraint.type === "f").map((constraint) => {
        if (constraint.referencedSchema !== "public" || !constraint.referencedTable) throw new Error(`Unsupported cross-schema foreign key: ${raw.name}`);
        return { columns: constraint.columns, referencedTable: constraint.referencedTable, referencedColumns: constraint.referencedColumns };
      });
      if (BigInt(raw.rows) > 0n) {
        if (!models.has(raw.name) && raw.name !== "_prisma_migrations") throw new Error(`Unknown populated table: ${raw.name}`);
        if (!manifest.tables[raw.name]) throw new Error(`Unclassified populated table: ${raw.name}`);
        if (raw.name === "_prisma_migrations" && manifest.tables[raw.name].disposition !== "operator-control") {
          throw new Error("_prisma_migrations must remain operator-control metadata");
        }
        const structured = columns.filter((column) => /^jsonb?$/.test(column.type) || column.type.endsWith("[]"));
        const classified = columns.filter((column) => structured.includes(column) || transferScalarFieldKinds[raw.name]?.[column.name]);
        if (classified.length) {
          const { rows: [populated] } = await client.query(`SELECT ${classified.map((column) => `bool_or(${q(column.name)} IS NOT NULL) AS ${q(column.name)}`).join(",")} FROM ${tableName(raw.name)}`);
          for (const column of structured) if (populated[column.name] && !manifest.tables[raw.name].fields?.[column.name]) {
            throw new Error(`Unclassified populated JSON/array field: ${raw.name}.${column.name}`);
          }
          assertTransferTableFieldPolicies({ name: raw.name, columns: classified,
            rows: [classified.map((column) => populated[column.name] ? "" : null)] }, manifest.tables[raw.name]);
        }
      }
      const ownRules = ownership.get(models.get(raw.name)?.name ?? raw.name) ?? [];
      catalog.set(raw.name, { name: raw.name, columns, primaryKey: constraints.find((constraint) => constraint.type === "p")?.columns ?? [], foreignKeys,
        rows: [], sourceRows: raw.rows, owners: raw.name === "Workspace" ? ['r."id"'] : ownRules.map((rule) => ownerSql(rule, "r")), seen: new Set(), referenceIndexes: new Map() });
    }
    for (const [name, model] of models) {
      const actual = catalog.get(name);
      if (!actual) throw new Error(`Converted schema is missing model table: ${name}`);
      for (const field of model.fields.filter((field) => field.kind !== "object")) {
        if (!actual.columns.some((column) => column.name === (field.dbName ?? field.name))) throw new Error(`Converted schema is missing model column: ${name}.${field.name}`);
      }
    }
    for (const [name, policy] of Object.entries(manifest.tables)) {
      const actual = catalog.get(name);
      if (!actual) throw new Error(`Manifest table missing from converted schema: ${name}`);
      for (const [field, policyField] of Object.entries(policy.fields ?? {})) {
        const sourceColumn = actual.columns.find((column) => column.name === field);
        if (!sourceColumn) throw new Error(`Manifest field missing from converted schema: ${name}.${field}`);
        if (policyField.references) {
          const target = catalog.get(policyField.references.table);
          const targetColumn = target?.columns.find((column) => column.name === policyField.references!.column);
          if (!target || !targetColumn || [sourceColumn, targetColumn].some((column) => /^jsonb?$/.test(column.type) || column.type.endsWith("[]") || column.type.startsWith("vector"))) {
            throw new Error(`Declared reference must bind actual scalar columns: ${name}.${field}`);
          }
          const { rows: [unique] } = await client.query(`SELECT EXISTS (
            SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid
            JOIN pg_namespace n ON n.oid=c.relnamespace
            JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=i.indkey[0]
            WHERE n.nspname='public' AND c.relname=$1 AND a.attname=$2
              AND i.indisunique AND i.indisvalid AND i.indnkeyatts=1
              AND i.indpred IS NULL AND i.indexprs IS NULL) AS valid`, [target.name, targetColumn.name]);
          if (!unique.valid) throw new Error(`Declared reference target must have a scalar unique key: ${name}.${field}`);
          if (actual.foreignKeys.some((fk) => fk.columns.includes(field))) {
            throw new Error(`Declared reference overlaps an actual foreign key: ${name}.${field}`);
          }
          actual.foreignKeys.push({ columns: [field], referencedTable: target.name, referencedColumns: [targetColumn.name], declared: true });
        }
      }
    }
    for (const table of catalog.values()) for (const fk of table.foreignKeys) {
      catalog.get(fk.referencedTable)?.referenceIndexes.set(JSON.stringify(fk.referencedColumns), { columns: fk.referencedColumns, keys: new Set() });
    }
    let rowCount = 0;
    let byteCount = Buffer.byteLength(canonicalManifest(manifest));
    const pending: { table: CatalogTable; row: (string | null)[] }[] = [];
    function append(table: CatalogTable, result: Record<string, unknown>) {
      const row = result.values;
      const owners = result.owners;
      if (!Array.isArray(row) || row.length !== table.columns.length || row.some((value) => value !== null && typeof value !== "string")
        || !Array.isArray(owners) || owners.some((value) => value !== null && typeof value !== "string")) throw new Error(`Invalid text serialization: ${table.name}`);
      if (owners.some((id) => id !== null && id !== manifest.workspaceId)) throw new Error(`Cross-tenant ownership: ${table.name}`);
      if (!table.primaryKey.length) throw new Error(`Selected table lacks primary key: ${table.name}`);
      const key = JSON.stringify(table.primaryKey.map((name) => row[table.columns.findIndex((column) => column.name === name)]));
      if (table.seen.has(key)) return;
      rowCount++;
      byteCount += Buffer.byteLength(JSON.stringify(row));
      if (rowCount > maxRows) throw new Error(`Transfer row limit exceeded (${maxRows})`);
      if (byteCount > maxBytes) throw new Error(`Transfer byte limit exceeded (${maxBytes})`);
      table.seen.add(key); table.rows.push(row); pending.push({ table, row });
      for (const reference of table.referenceIndexes.values()) {
        reference.keys.add(JSON.stringify(reference.columns.map((name) => row[table.columns.findIndex((column) => column.name === name)])));
      }
    }
    function selectSql(table: CatalogTable, predicate: string, limit: string) {
      if (!table.primaryKey.length) throw new Error(`Selected table lacks primary key: ${table.name}`);
      return `SELECT ARRAY[${table.columns.map((column) => `r.${q(column.name)}::text`).join(",")}]::text[] AS values,
        ARRAY[${table.owners.join(",")}]::text[] AS owners FROM ${tableName(table.name)} r WHERE ${predicate}
        ORDER BY ${table.primaryKey.map((name) => `r.${q(name)}`).join(",")} LIMIT ${limit}`;
    }
    for (const table of catalog.values()) if (transfers(manifest.tables[table.name]) && table.owners.length) {
      const { rows } = await client.query(selectSql(table, table.owners.map((sql) => `${sql} = $1`).join(" OR "), "$2"), [manifest.workspaceId, maxRows - rowCount + 1]);
      for (const row of rows) append(table, row);
    }
    const workspaceTable = catalog.get("Workspace")!;
    const workspaceRow = workspaceTable.rows[0];
    if (workspaceTable.rows.length !== 1 || workspaceRow[workspaceTable.columns.findIndex((column) => column.name === "slug")] !== manifest.workspaceSlug) {
      throw new Error("Exact source workspace id/slug not found");
    }
    // Only outgoing actual FKs extend closure. Global users never cause inverse
    // traversal into their other memberships, workspaces, or sessions.
    for (let index = 0; index < pending.length; index++) {
      const { table, row } = pending[index];
      for (const fk of table.foreignKeys) {
        const values = fk.columns.map((name) => row[table.columns.findIndex((column) => column.name === name)]);
        if (values.some((value) => value === null)) continue;
        const target = catalog.get(fk.referencedTable);
        if (!target || !transfers(manifest.tables[fk.referencedTable])) {
          throw new Error(`Closure blocker: ${table.name}.${fk.columns.join(",")} references excluded ${fk.referencedTable} (${manifest.tables[fk.referencedTable]?.disposition ?? "unclassified"})`);
        }
        if (target.referenceIndexes.get(JSON.stringify(fk.referencedColumns))?.keys.has(JSON.stringify(values))) continue;
        const predicate = fk.referencedColumns.map((name, key) => `r.${q(name)}::text = $${key + 1}`).join(" AND ");
        const { rows } = await client.query(selectSql(target, predicate, "2"), values);
        if (rows.length !== 1) throw new Error(`Unresolved outgoing foreign key: ${table.name} -> ${target.name}`);
        append(target, rows[0]);
      }
    }
    const tables: TransferTableData[] = [];
    // Re-read by primary key in PostgreSQL order after dependency discovery.
    // Sorting serialized numbers/dates in JavaScript would change key ordering.
    for (const table of catalog.values()) if (table.rows.length) {
      const keys = table.rows.map((row) => table.primaryKey.map((name) => row[table.columns.findIndex((column) => column.name === name)]));
      const predicate = `EXISTS (SELECT 1 FROM jsonb_array_elements($1::jsonb) key WHERE ${table.primaryKey.map((name, key) => `r.${q(name)}::text = key->>${key}`).join(" AND ")})`;
      const { rows } = await client.query(selectSql(table, predicate, "$2"), [JSON.stringify(keys), table.rows.length + 1]);
      const sorted = rows.map((row) => row.values as (string | null)[]);
      if (sorted.length !== table.rows.length) throw new Error(`Snapshot selection changed: ${table.name}`);
      tables.push({ name: table.name, columns: table.columns, primaryKey: table.primaryKey, foreignKeys: table.foreignKeys,
        rows: sorted, sha256: hashFrames(sorted) });
    }
    for (const table of tables) assertTransferTableFieldPolicies(table, manifest.tables[table.name]);
    const snapshot: Omit<TenantTransferSnapshot, "sha256"> = {
      formatVersion: 1, manifest, manifestSha256: hashCanonical(manifest),
      sourceSnapshot: String(inventory.identity.snapshot), sourceDatabase: String(inventory.identity.database),
      schemaSha256: inventory.schemaSha256, tables,
      dispositions: [...catalog.values()].filter((table) => BigInt(table.sourceRows) > 0n).map((table) => ({
        table: table.name, sourceRows: table.sourceRows, selectedRows: String(table.rows.length),
        disposition: manifest.tables[table.name].disposition, reason: manifest.tables[table.name].reason,
      })),
    };
    if (Buffer.byteLength(canonical(snapshot)) > maxBytes) throw new Error(`Transfer byte limit exceeded (${maxBytes})`);
    const result = { ...snapshot, sha256: hashCanonical(snapshot) };
    if (Buffer.byteLength(canonical(result)) > maxBytes) throw new Error(`Transfer byte limit exceeded (${maxBytes})`);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
}
