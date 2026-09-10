import { hashCanonical, hashFrames } from "./shared-tenant-export";
import { assertNoSourceImportMarker, assertTransferTableFieldPolicies } from "./shared-tenant-transfer-contract";
import type { TenantTransferSnapshot, TransferColumn, TransferForeignKey, TransferTableData } from "./shared-tenant-transfer-contract";

type PrimaryKeys = (string | null)[][];
export interface PublicationRowSelection {
  table: string;
  primaryKeys: PrimaryKeys;
  reason: string;
}
export interface TenantPublicationOptions {
  stagedRows: PublicationRowSelection[];
  detachReferences: (PublicationRowSelection & { column: string })[];
}
export interface TenantPublicationStaging {
  formatVersion: 1;
  sourceSnapshotSha256: string;
  rows: (PublicationRowSelection & {
    columns: TransferColumn[];
    primaryKey: string[];
    rows: (string | null)[][];
  })[];
  detachedReferences: (PublicationRowSelection & {
    column: string;
    primaryKey: string[];
    references: TransferForeignKey[];
    originalValues: (string | null)[];
  })[];
  sha256: string;
}

function fail(message: string): never { throw new Error(`PUBLICATION_${message}`); }
function keyOf(table: TransferTableData, row: (string | null)[]) {
  return JSON.stringify(table.primaryKey.map((key) => row[table.columns.findIndex((column) => column.name === key)]));
}

/** Operator policy only: exact keys, no inferred deletions or business-state rewrites.
 * Both returned artifacts contain private customer data and require private storage.
 */
export function prepareTenantPublication(originalSnapshot: TenantTransferSnapshot, options: TenantPublicationOptions) {
  const { sha256, ...originalBody } = originalSnapshot;
  if (originalSnapshot.formatVersion !== 1 || hashCanonical(originalBody) !== sha256
    || hashCanonical(originalSnapshot.manifest) !== originalSnapshot.manifestSha256
    || originalSnapshot.schemaSha256 !== originalSnapshot.manifest.schemaSha256) fail("SNAPSHOT_DIGEST_MISMATCH");
  const tables = new Map<string, TransferTableData>();
  const rowIndexes = new Map<string, Map<string, (string | null)[]>>();
  for (const table of originalSnapshot.tables) {
    if (tables.has(table.name) || hashFrames(table.rows) !== table.sha256) fail("TABLE_DIGEST_MISMATCH");
    if (!table.primaryKey.length || new Set(table.columns.map((column) => column.name)).size !== table.columns.length
      || new Set(table.primaryKey).size !== table.primaryKey.length
      || table.primaryKey.some((key) => !table.columns.some((column) => column.name === key))) fail("TABLE_SHAPE_INVALID");
    const index = new Map<string, (string | null)[]>();
    for (const row of table.rows) {
      if (row.length !== table.columns.length || row.some((value) => value !== null && typeof value !== "string")) fail("ROW_SHAPE_INVALID");
      const key = keyOf(table, row);
      if (index.has(key)) fail("DUPLICATE_SOURCE_KEY");
      index.set(key, row);
    }
    assertTransferTableFieldPolicies(table, originalSnapshot.manifest.tables[table.name]);
    const disposition = originalSnapshot.dispositions.filter((entry) => entry.table === table.name);
    if (disposition.length !== 1 || disposition[0].selectedRows !== String(table.rows.length)) fail("SOURCE_COUNT_MISMATCH");
    tables.set(table.name, table); rowIndexes.set(table.name, index);
  }
  const publicationSnapshot = structuredClone(originalSnapshot);
  const stagingBody: Omit<TenantPublicationStaging, "sha256"> = {
    formatVersion: 1, sourceSnapshotSha256: sha256, rows: [], detachedReferences: [],
  };
  const stagedKeys = new Map<string, Set<string>>();
  const detachedKeys = new Set<string>();
  function selection(request: PublicationRowSelection) {
    if (typeof request.reason !== "string" || !request.reason.trim()) fail("REASON_REQUIRED");
    const table = tables.get(request.table);
    if (!table) fail("UNKNOWN_TABLE");
    if (!Array.isArray(request.primaryKeys) || !request.primaryKeys.length) fail("KEYS_REQUIRED");
    const seen = new Set<string>();
    const rows = request.primaryKeys.map((keys) => {
      if (!Array.isArray(keys) || keys.length !== table.primaryKey.length
        || keys.some((key) => key !== null && typeof key !== "string")) fail("KEY_SHAPE_INVALID");
      const key = JSON.stringify(keys);
      if (seen.has(key)) fail("DUPLICATE_REQUEST_KEY");
      seen.add(key);
      const row = rowIndexes.get(table.name)!.get(key);
      if (!row) fail("UNKNOWN_KEY");
      return row;
    });
    return { table, rows };
  }
  for (const request of options.stagedRows) {
    const { table, rows } = selection(request);
    if (table.name === "Workspace") fail("WORKSPACE_MUST_REMAIN");
    const keys = stagedKeys.get(table.name) ?? new Set<string>();
    for (const row of rows) {
      const key = keyOf(table, row);
      if (keys.has(key)) fail("DUPLICATE_REQUEST_KEY");
      keys.add(key);
    }
    stagedKeys.set(table.name, keys);
    stagingBody.rows.push(structuredClone({ ...request, columns: table.columns, primaryKey: table.primaryKey, rows }));
  }
  for (const request of options.detachReferences) {
    const { table, rows } = selection(request);
    const position = table.columns.findIndex((column) => column.name === request.column);
    const column = table.columns[position];
    const references = table.foreignKeys.filter((key) => key.columns.includes(request.column));
    const policy = originalSnapshot.manifest.tables[table.name]?.fields?.[request.column];
    const declared = references.filter((reference) => reference.declared);
    if (!column?.nullable || table.primaryKey.includes(request.column) || request.column === "workspaceId" || !references.length
      || declared.some((key) => key.columns.length !== 1 || key.referencedColumns.length !== 1
        || policy?.kind !== "reference" || !policy.reason.trim() || policy.references?.table !== key.referencedTable
        || policy.references.column !== key.referencedColumns[0])) fail("REFERENCE_DETACH_FORBIDDEN");
    const targetTable = publicationSnapshot.tables.find((candidate) => candidate.name === table.name)!;
    for (const row of rows) {
      const key = keyOf(table, row);
      const uniqueKey = JSON.stringify([table.name, request.column, key]);
      if (detachedKeys.has(uniqueKey)) fail("DUPLICATE_REQUEST_KEY");
      if (stagedKeys.get(table.name)?.has(key)) fail("STAGED_ROW_DETACH_CONFLICT");
      detachedKeys.add(uniqueKey);
      targetTable.rows.find((candidate) => keyOf(table, candidate) === key)![position] = null;
    }
    stagingBody.detachedReferences.push(structuredClone({ ...request, primaryKey: table.primaryKey,
      references, originalValues: rows.map((row) => row[position]) }));
  }
  for (const table of publicationSnapshot.tables) {
    table.rows = table.rows.filter((row) => !stagedKeys.get(table.name)?.has(keyOf(table, row)));
    table.sha256 = hashFrames(table.rows);
    publicationSnapshot.dispositions.find((entry) => entry.table === table.name)!.selectedRows = String(table.rows.length);
  }
  // Only explicit removal is permitted. A surviving reference to staged history
  // needs its own detach/stage decision; PostgreSQL MATCH SIMPLE permits NULL.
  for (const table of publicationSnapshot.tables) for (const key of table.foreignKeys) {
    const removed = stagedKeys.get(key.referencedTable);
    if (!removed?.size) continue;
    const referenced = tables.get(key.referencedTable)!;
    const removedValues = new Set(referenced.rows.filter((row) => removed.has(keyOf(referenced, row)))
      .map((row) => JSON.stringify(key.referencedColumns.map((name) => row[referenced.columns.findIndex((column) => column.name === name)]))));
    for (const row of table.rows) {
      const values = key.columns.map((name) => row[table.columns.findIndex((column) => column.name === name)]);
      if (!values.includes(null) && removedValues.has(JSON.stringify(values))) fail(`STAGED_REFERENCE_REMAINS:${table.name}`);
    }
  }
  assertNoSourceImportMarker(publicationSnapshot.tables);
  const staging: TenantPublicationStaging = { ...stagingBody, sha256: hashCanonical(stagingBody) };
  publicationSnapshot.manifest.preparedFromSha256 = sha256;
  publicationSnapshot.manifest.stagingSha256 = staging.sha256;
  publicationSnapshot.manifestSha256 = hashCanonical(publicationSnapshot.manifest);
  const { sha256: _publicationSha256, ...publicationBody } = publicationSnapshot;
  publicationSnapshot.sha256 = hashCanonical(publicationBody);
  const result = { publicationSnapshot, staging };
  return { ...result, sha256: hashCanonical(result) };
}
