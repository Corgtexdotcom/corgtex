import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { validateObjectReceipt, type ObjectCopyReceipt } from "./shared-tenant-objects";
import { hashCanonical, hashFrames } from "./shared-tenant-export";
import { readSharedTenantSchema, quoteIdentifier } from "./shared-tenant-inventory.mjs";
import { assertNoSourceImportMarker, assertTransferTableFieldPolicies, isRetainedInlineValue } from "./shared-tenant-transfer-contract";
import type { TenantTransferSnapshot, TransferSqlClient, TransferTableData } from "./shared-tenant-transfer-contract";

type IdentityLink = {
  sourceUserId: string;
  targetUserId: string;
  evidence: { kind: "verified-provider-subject" | "operator-reviewed-ownership"; reference: string; sha256: string };
};
type FieldTransform =
  | { kind: "null"; reason: string }
  | { kind: "map-values"; values: Record<string, string>; reason: string }
  | { kind: "reencrypt"; reason: string }
  | { kind: "disable-tracking-token"; reason: string }
  | { kind: "json-user-references"; paths: string[][]; reason: string };
export interface TenantImportOptions {
  identityLinks: IdentityLink[];
  // Explicit reviewed target fingerprint; relevant copied columns/FKs are checked below.
  targetSchemaSha256?: string;
  transforms?: Record<string, Record<string, FieldTransform>>;
  sourceEncryptionKey?: string;
  targetEncryptionKey?: string;
  // Produced by the object verifier for precisely this final snapshot. Empty
  // object sets also require a receipt; absence never means no objects exist.
  objectReceipt: ObjectCopyReceipt;
  // Independently reviewed source and destination storage identities, from the
  // transfer configuration rather than inferred from the receipt being checked.
  objectStorageBinding: { sourceStoreId: string; targetStoreId: string };
  objectBindings?: { table: string; column: string; sourceValue: string; targetValue: string; sourceKey: string; targetKey: string; sha256: string }[];
}

function fail(code: string): never { throw new Error(code); }
const inactiveFlag = "operator_import_inactive";
const forbiddenCredentialTables = new Set(["Session", "PasswordResetToken", "AgentCredential", "McpOAuthAccessToken", "McpOAuthAuthorizationCode", "OAuthConnection"]);
const tableName = (name: string) => `public.${quoteIdentifier(name)}`;
const rowObject = (table: TransferTableData, row: (string | null)[]) =>
  Object.fromEntries(table.columns.map((column, index) => [column.name, row[index]]));

function reencrypt(value: string, options: TenantImportOptions) {
  if (!/^[a-f0-9]{64}$/i.test(options.sourceEncryptionKey ?? "")
    || !/^[a-f0-9]{64}$/i.test(options.targetEncryptionKey ?? "")) fail("TRANSFER_ENCRYPTION_KEYS_REQUIRED");
  const [version, iv, tag, ciphertext, extra] = value.split(":");
  if (version !== "aes-256-gcm" || !iv || !tag || !ciphertext || extra) fail("TRANSFER_SECRET_FORMAT_UNSUPPORTED");
  const decipher = createDecipheriv("aes-256-gcm", Buffer.from(options.sourceEncryptionKey!, "hex"), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]);
  try {
    const nextIv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", Buffer.from(options.targetEncryptionKey!, "hex"), nextIv);
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return [version, nextIv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(":");
  } finally { plaintext.fill(0); }
}

function primaryWhere(table: TransferTableData, row: (string | null)[]) {
  if (!table.primaryKey.length) fail("TRANSFER_PRIMARY_KEY_REQUIRED");
  return {
    sql: table.primaryKey.map((name, index) => `${quoteIdentifier(name)} = $${index + 1}`).join(" AND "),
    values: table.primaryKey.map((name) => row[table.columns.findIndex((column) => column.name === name)]),
  };
}

function validateSnapshot(snapshot: TenantTransferSnapshot, options: TenantImportOptions) {
  const { sha256, ...body } = snapshot;
  if (snapshot.formatVersion !== 1 || hashCanonical(body) !== sha256
    || hashCanonical(snapshot.manifest) !== snapshot.manifestSha256
    || snapshot.schemaSha256 !== snapshot.manifest.schemaSha256) fail("TRANSFER_SNAPSHOT_DIGEST_MISMATCH");
  assertNoSourceImportMarker(snapshot.tables);
  for (const table of snapshot.tables) assertTransferTableFieldPolicies(table, snapshot.manifest.tables[table.name]);
  validateObjectReceipt(options.objectReceipt);
  if (options.objectReceipt.transferId !== snapshot.manifest.transferId
    || options.objectReceipt.sourceSnapshotSha256 !== sha256 || !/^[a-f0-9]{64}$/.test(options.objectReceipt.sha256)) {
    fail("TRANSFER_FINAL_OBJECT_RECEIPT_REQUIRED");
  }
  const stores = options.objectStorageBinding;
  if (!stores || typeof stores.sourceStoreId !== "string" || !stores.sourceStoreId.trim()
    || typeof stores.targetStoreId !== "string" || !stores.targetStoreId.trim()
    || stores.sourceStoreId !== options.objectReceipt.sourceStoreId
    || stores.targetStoreId !== options.objectReceipt.targetStoreId) fail("TRANSFER_OBJECT_STORAGE_BINDING_MISMATCH");
  const names = new Set<string>();
  for (const table of snapshot.tables) {
    if (names.has(table.name) || hashFrames(table.rows) !== table.sha256) fail("TRANSFER_TABLE_DIGEST_MISMATCH");
    names.add(table.name);
    if (table.rows.length && forbiddenCredentialTables.has(table.name)) fail("TRANSFER_OLD_CREDENTIALS_MUST_BE_STAGED");
    for (const row of table.rows) for (let index = 0; index < table.columns.length; index++) {
      const column = table.columns[index];
      if (row[index] === null || snapshot.manifest.tables[table.name]?.fields?.[column.name]?.kind !== "object"
        || isRetainedInlineValue(table.name, column.name, row[index]!, snapshot.manifest.tables[table.name])) continue;
      const binding = options.objectBindings?.find((binding) => binding.table === table.name
        && binding.column === column.name && binding.sourceValue === row[index]);
      if (!binding || !options.objectReceipt.entries.some((entry) => entry.sourceKey === binding.sourceKey
        && entry.targetKey === binding.targetKey && entry.sha256 === binding.sha256)) fail("TRANSFER_OBJECT_REFERENCE_UNVERIFIED");
    }
    if (!table.primaryKey.length || table.rows.some((row) => row.length !== table.columns.length)) fail("TRANSFER_ROW_SHAPE_INVALID");
    const policy = snapshot.manifest.tables[table.name];
    if (!policy || !["copy", "transform"].includes(policy.disposition)) fail("TRANSFER_TABLE_POLICY_INVALID");
  }
  if (!names.has("Workspace")) fail("TRANSFER_WORKSPACE_REQUIRED");
  const sourceUsers = new Set<string>();
  for (const link of options.identityLinks) {
    if (sourceUsers.has(link.sourceUserId) || !link.targetUserId || !link.evidence.reference.trim()
      || !["verified-provider-subject", "operator-reviewed-ownership"].includes(link.evidence.kind)
      || !/^[a-f0-9]{64}$/.test(link.evidence.sha256)) fail("TRANSFER_IDENTITY_OWNERSHIP_EVIDENCE_REQUIRED");
    sourceUsers.add(link.sourceUserId);
  }
}

async function transformedRows(client: TransferSqlClient, snapshot: TenantTransferSnapshot, options: TenantImportOptions) {
  const links = new Map(options.identityLinks.map((link) => [link.sourceUserId, link.targetUserId]));
  const tables = structuredClone(snapshot.tables);
  for (const table of tables) {
    for (const row of table.rows) {
      const original = rowObject(table, row);
      for (let index = 0; index < table.columns.length; index++) {
        const column = table.columns[index];
        if (table.name === "Member" && column.name === "isActive") row[index] = "false";
        if (table.name === "AgentIdentity" && column.name === "isActive") row[index] = "false";
        if (table.name === "User" && column.name === "passwordHash") row[index] = `disabled:operator-import:${snapshot.manifest.transferId}`;
        if (table.name === "User" && column.name === "globalRole") row[index] = "USER";
        if (table.name === "User" && column.name === "id") row[index] = links.get(row[index]!) ?? row[index];
        for (const key of table.foreignKeys.filter((key) => key.referencedTable === "User")) {
          if (key.columns.includes(column.name)) {
            if (key.columns.length !== 1 || key.referencedColumns[0] !== "id") fail("TRANSFER_USER_REFERENCE_UNSUPPORTED");
            row[index] = links.get(row[index]!) ?? row[index];
          }
        }
        const transform = options.transforms?.[table.name]?.[column.name];
        const classification = snapshot.manifest.tables[table.name]?.fields?.[column.name];
        const disablesTrackingToken = transform?.kind === "disable-tracking-token"
          && table.name === "NewspaperTrackedLink" && column.name === "tokenHash";
        if (transform?.kind === "disable-tracking-token" && !disablesTrackingToken) fail("TRANSFER_TRACKING_TOKEN_TRANSFORM_FORBIDDEN");
        if (table.name === "DemoLead" && column.name === "qualifyToken" && row[index] !== null && transform?.kind !== "null") {
          fail("TRANSFER_QUALIFICATION_TOKEN_MUST_BE_REMOVED");
        }
        if (row[index] !== null && classification?.kind === "secret" && !(table.name === "User" && column.name === "passwordHash") && transform?.kind !== "reencrypt" && transform?.kind !== "null" && !disablesTrackingToken) {
          fail("TRANSFER_SECRET_DISPOSITION_REQUIRED");
        }
        if (!transform || row[index] === null) continue;
        if (!transform.reason.trim() || table.primaryKey.includes(column.name)
          || column.name === "workspaceId" || (table.name === "Member" && column.name === "isActive") || (table.name === "AgentIdentity" && column.name === "isActive") || (table.name === "User" && column.name === "passwordHash")
          || (table.name === "User" && column.name === "globalRole")
          || (["WorkflowJob", "Event"].includes(table.name) && ["status", "type", "attempts", "completedAt", "dispatchedAt"].includes(column.name))) {
          fail("TRANSFER_FIELD_TRANSFORM_FORBIDDEN");
        }
        if (transform.kind === "null") {
          if (!column.nullable) fail("TRANSFER_REQUIRED_FIELD_CANNOT_BE_NULL");
          row[index] = null;
        } else if (transform.kind === "map-values") {
          if (!Object.hasOwn(transform.values, row[index]!)) fail("TRANSFER_VALUE_MAPPING_MISSING");
          row[index] = transform.values[row[index]!];
        } else if (transform.kind === "disable-tracking-token") {
          if (table.primaryKey.length !== 1 || table.primaryKey[0] !== "id" || !original.id) fail("TRANSFER_TRACKING_TOKEN_TRANSFORM_FORBIDDEN");
          row[index] = `disabled:operator-import:${snapshot.manifest.transferId}:${original.id}`;
        } else if (transform.kind === "reencrypt") {
          row[index] = reencrypt(row[index]!, options);
        } else if (transform.kind === "json-user-references") {
          if (!/^jsonb?$/.test(column.type)) fail("TRANSFER_JSON_REFERENCE_TYPE_INVALID");
          for (const path of transform.paths) {
            if (!path.length || path.some((part) => !part || part.includes("\0"))) fail("TRANSFER_JSON_REFERENCE_PATH_INVALID");
            const result = await client.query("SELECT ($1::jsonb #>> $2::text[]) AS value", [row[index], path]);
            const oldId = result.rows[0]?.value;
            if (typeof oldId === "string" && links.has(oldId)) {
              row[index] = (await client.query("SELECT jsonb_set($1::jsonb, $2::text[], to_jsonb($3::text), false)::text AS value",
                [row[index], path, links.get(oldId)])).rows[0].value as string;
            }
          }
        } else {
          fail("TRANSFER_FIELD_TRANSFORM_INVALID");
        }
        // Normalize explicit replacements through the verified target SQL type.
        // This keeps JSON numeric precision and PostgreSQL canonical formatting.
        if (row[index] !== null && transform.kind === "map-values") {
          row[index] = (await client.query(`SELECT ($1::${column.type})::text AS value`, [row[index]])).rows[0].value as string;
        }
      }
      for (const [index, column] of table.columns.entries()) {
        const value = original[column.name];
        if (typeof value === "string" && isRetainedInlineValue(table.name, column.name, value, snapshot.manifest.tables[table.name])) {
          if (row[index] !== value) fail("TRANSFER_INLINE_LOCATOR_MUST_REMAIN");
          const contentName = table.name === "Document" ? "textContent" : "content";
          const contentIndex = table.columns.findIndex((field) => field.name === contentName);
          if (row[contentIndex] !== original[contentName]) fail("TRANSFER_INLINE_CONTENT_MUST_REMAIN");
        }
      }
      for (const binding of options.objectBindings?.filter((binding) => binding.table === table.name) ?? []) {
        const index = table.columns.findIndex((column) => column.name === binding.column);
        if (original[binding.column] === binding.sourceValue && row[index] !== binding.targetValue) {
          fail("TRANSFER_OBJECT_MAPPING_MISMATCH");
        }
      }
      if (["WorkflowJob", "Event"].includes(table.name)
        && (original.lockedBy || original.lockedAt || ["RUNNING", "PENDING"].includes(original.status ?? ""))) fail("TRANSFER_SOURCE_WORK_NOT_DRAINED");
      if (table.name === "Workspace" && (original.id !== snapshot.manifest.workspaceId || original.slug !== snapshot.manifest.workspaceSlug)) {
        fail("TRANSFER_WORKSPACE_IDENTITY_MISMATCH");
      }
    }
  }
  for (const table of tables) assertTransferTableFieldPolicies(table, snapshot.manifest.tables[table.name]);
  return tables;
}

/** Single publication transaction with inactive membership/agents and scheduler marker. Never upserts shared rows or disables constraints. */
export async function importTenantSnapshot(client: TransferSqlClient, snapshot: TenantTransferSnapshot, options: TenantImportOptions) {
  validateSnapshot(snapshot, options);
  await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  try {
    await client.query("SET LOCAL TimeZone = 'UTC'");
    await client.query("SET LOCAL DateStyle = 'ISO, YMD'");
    await client.query("SET LOCAL extra_float_digits = 3");
    await client.query("SET LOCAL bytea_output = 'hex'");
    await client.query("SET LOCAL lock_timeout = '10s'");
    await client.query("SET LOCAL statement_timeout = '120s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`tenant-transfer:${snapshot.manifest.workspaceId}`]);
    const existing = await client.query('SELECT id, slug FROM public."Workspace" WHERE id = $1 OR slug = $2 FOR UPDATE',
      [snapshot.manifest.workspaceId, snapshot.manifest.workspaceSlug]);
    if (existing.rows.length) {
      const marker = (await client.query('SELECT enabled, config FROM public."WorkspaceFeatureFlag" WHERE "workspaceId"=$1 AND flag=$2 FOR UPDATE', [snapshot.manifest.workspaceId, inactiveFlag])).rows[0];
      const receipt = (marker?.config as { transferReceipt?: Record<string, unknown> } | undefined)?.transferReceipt ?? null;
      if (existing.rows.length !== 1 || existing.rows[0].id !== snapshot.manifest.workspaceId
        || receipt?.sourceSnapshotSha256 !== snapshot.sha256 || receipt?.transferId !== snapshot.manifest.transferId
        || receipt?.identityLinksSha256 !== hashCanonical(options.identityLinks)
        || receipt?.transformsSha256 !== hashCanonical(options.transforms ?? {})
        || receipt?.objectBindingsSha256 !== hashCanonical(options.objectBindings ?? [])
        || receipt?.objectReceiptSha256 !== options.objectReceipt.sha256) {
        fail("TRANSFER_WORKSPACE_COLLISION");
      }
      // Retry is verification-only, while the marker exists. After activation, changed data requires current-state recovery. Never replay rows.
      await verifyImportedTenant(client, snapshot, receipt);
      await client.query("COMMIT");
      return { alreadyImported: true, held: marker?.enabled === true, receipt };
    }
    // Catalog inspection is read-only but belongs to this serializable import tx.
    // Use a metadata-only schema helper; population is intentionally irrelevant.
    const catalog = await readSharedTenantSchema(client);
    if (catalog.schemaSha256 !== (options.targetSchemaSha256 ?? snapshot.schemaSha256)) fail("TRANSFER_TARGET_SCHEMA_MISMATCH");
    validateTableCatalog(snapshot, catalog.schema);
    const tables = await transformedRows(client, snapshot, options);
    assertRelationalClosure(tables, options);
    const linkedUsers = new Set(options.identityLinks.map((link) => link.targetUserId));
    for (const link of options.identityLinks) {
      const target = await client.query('SELECT id FROM public."User" WHERE id = $1 FOR SHARE', [link.targetUserId]);
      if (target.rows.length !== 1) fail("TRANSFER_LINKED_USER_NOT_FOUND");
    }
    const pending = tables.map((table) => ({ table, rows: [...table.rows] }));
    const inserted = new Map<string, (string | null)[][]>();
    const selfEdges: { table: TransferTableData; row: (string | null)[]; columns: string[] }[] = [];
    let remaining = pending.reduce((sum, entry) => sum + entry.rows.length, 0);
    while (remaining) {
      let progress = 0;
      for (const entry of pending) {
        const { table } = entry;
        for (let offset = 0; offset < entry.rows.length;) {
          const row = entry.rows[offset];
          const values = rowObject(table, row);
          if (table.name === "User" && linkedUsers.has(values.id!)) {
            entry.rows.splice(offset, 1); remaining--; progress++; continue;
          }
          let ready = true;
          const nullableSelf: string[] = [];
          for (const key of table.foreignKeys) {
            if (key.columns.some((name) => values[name] === null)) continue;
            if (key.referencedTable === table.name && key.columns.every((name) => table.columns.find((column) => column.name === name)?.nullable)) {
              nullableSelf.push(...key.columns); continue;
            }
            const match = await client.query(`SELECT 1 FROM ${tableName(key.referencedTable)} WHERE ${key.referencedColumns.map((name, index) => `${quoteIdentifier(name)} = $${index + 1}`).join(" AND ")} LIMIT 1`,
              key.columns.map((name) => values[name]));
            if (!match.rows.length) { ready = false; break; }
          }
          if (!ready) { offset++; continue; }
          const where = primaryWhere(table, row);
          if ((await client.query(`SELECT 1 FROM ${tableName(table.name)} WHERE ${where.sql}`, where.values)).rows.length) {
            fail("TRANSFER_ROW_ID_COLLISION");
          }
          if (table.name === "User" && (await client.query('SELECT 1 FROM public."User" WHERE lower(email) = lower($1)', [values.email])).rows.length) {
            fail("TRANSFER_USER_EMAIL_OWNERSHIP_UNRESOLVED");
          }
          await client.query(`INSERT INTO ${tableName(table.name)} (${table.columns.map((column) => quoteIdentifier(column.name)).join(",")}) VALUES (${table.columns.map((_, index) => `$${index + 1}`).join(",")})`,
            table.columns.map((column, index) => nullableSelf.includes(column.name) ? null : row[index]));
          if (nullableSelf.length) selfEdges.push({ table, row, columns: nullableSelf });
          const accepted = inserted.get(table.name) ?? [];
          accepted.push(row); inserted.set(table.name, accepted);
          entry.rows.splice(offset, 1); remaining--; progress++;
        }
      }
      if (!progress) fail("TRANSFER_RELATIONAL_CLOSURE_UNRESOLVED");
    }
    for (const edge of selfEdges) {
      const where = primaryWhere(edge.table, edge.row);
      await client.query(`UPDATE ${tableName(edge.table.name)} SET ${edge.columns.map((name, index) => `${quoteIdentifier(name)} = $${where.values.length + index + 1}`).join(",")} WHERE ${where.sql}`,
        [...where.values, ...edge.columns.map((name) => edge.row[edge.table.columns.findIndex((column) => column.name === name)])]);
    }
    const receipt = {
      formatVersion: 1, transferId: snapshot.manifest.transferId, workspaceId: snapshot.manifest.workspaceId,
      sourceSnapshotSha256: snapshot.sha256, manifestSha256: snapshot.manifestSha256, schemaSha256: snapshot.schemaSha256,
      identityLinksSha256: hashCanonical(options.identityLinks), transformsSha256: hashCanonical(options.transforms ?? {}), objectBindingsSha256: hashCanonical(options.objectBindings ?? []), objectReceiptSha256: options.objectReceipt.sha256,
      importedAt: new Date().toISOString(), phase: "INACTIVE", targetSchemaSha256: catalog.schemaSha256,
      tables: tables.map((table) => ({ name: table.name, rows: inserted.get(table.name) ?? [], sha256: hashFrames(inserted.get(table.name) ?? []) })),
    };
    // Receipt stores keys and digests, never customer values or encrypted tokens.
    const persistedReceipt = { ...receipt, tables: receipt.tables.map((entry) => {
      const table = tables.find((table) => table.name === entry.name)!;
      return { name: entry.name, count: entry.rows.length, sha256: entry.sha256,
        primaryKeys: entry.rows.map((row) => primaryWhere(table, row).values) };
    }) };
    await verifyImportedTenant(client, snapshot, persistedReceipt);
    await client.query('INSERT INTO public."WorkspaceFeatureFlag" (id,"workspaceId",flag,enabled,config,"updatedAt") VALUES ($1,$2,$3,true,$4::jsonb,clock_timestamp())',
      [`operator-import:${snapshot.manifest.transferId}`, snapshot.manifest.workspaceId, inactiveFlag, JSON.stringify({ transferReceipt: persistedReceipt })]);
    await client.query("COMMIT");
    return { alreadyImported: false, held: true, receipt: persistedReceipt };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

export async function verifyImportedTenant(client: TransferSqlClient, snapshot: TenantTransferSnapshot, receipt: Record<string, unknown>) {
  const { sha256, ...body } = snapshot;
  if (hashCanonical(body) !== sha256 || hashCanonical(snapshot.manifest) !== snapshot.manifestSha256
    || receipt.sourceSnapshotSha256 !== sha256 || receipt.workspaceId !== snapshot.manifest.workspaceId) {
    fail("TRANSFER_VERIFICATION_IDENTITY_MISMATCH");
  }
  assertNoSourceImportMarker(snapshot.tables);
  for (const table of snapshot.tables) assertTransferTableFieldPolicies(table, snapshot.manifest.tables[table.name]);
  const entries = receipt.tables as { name: string; count: number; sha256: string; primaryKeys: (string | null)[][] }[];
  if (!Array.isArray(entries) || entries.length !== snapshot.tables.length
    || new Set(entries.map((entry) => entry.name)).size !== snapshot.tables.length) fail("TRANSFER_RECEIPT_INVALID");
  for (const entry of entries) {
    const table = snapshot.tables.find((candidate) => candidate.name === entry.name);
    if (!table || entry.primaryKeys.length !== entry.count
      || (table.name !== "User" && entry.count !== table.rows.length)) fail("TRANSFER_RECEIPT_INVALID");
    const rows: (string | null)[][] = [];
    for (const keys of entry.primaryKeys) {
      const projection = table.columns.map((column) => `${quoteIdentifier(column.name)}::text`);
      const found = await client.query(`SELECT json_build_array(${projection.join(",")})::text AS row FROM ${tableName(table.name)} WHERE ${table.primaryKey.map((name, index) => `${quoteIdentifier(name)} = $${index + 1}`).join(" AND ")}`, keys);
      if (found.rows.length !== 1) fail("TRANSFER_IMPORTED_ROW_MISSING");
      rows.push(JSON.parse(found.rows[0].row as string));
    }
    if (hashFrames(rows) !== entry.sha256) fail("TRANSFER_IMPORTED_DIGEST_MISMATCH");
  }
}

function assertRelationalClosure(tables: TransferTableData[], options: TenantImportOptions) {
  const linkedUsers = new Set(options.identityLinks.map((link) => link.targetUserId));
  const byName = new Map(tables.map((table) => [table.name, table]));
  const indexes = new Map<string, Set<string>>();
  for (const table of tables) for (const row of table.rows) {
    const values = rowObject(table, row);
    for (const key of table.foreignKeys) {
      const foreignValues = key.columns.map((column) => values[column]);
      if (foreignValues.some((value) => value === null)) continue;
      if (key.referencedTable === "User" && key.referencedColumns.length === 1
        && key.referencedColumns[0] === "id" && linkedUsers.has(foreignValues[0]!)) continue;
      const indexKey = JSON.stringify([key.referencedTable, key.referencedColumns]);
      let index = indexes.get(indexKey);
      if (!index) {
        const referenced = byName.get(key.referencedTable);
        const positions = key.referencedColumns.map((column) => referenced?.columns.findIndex((field) => field.name === column) ?? -1);
        index = new Set(referenced?.rows.map((candidate) => JSON.stringify(positions.map((position) => candidate[position]))) ?? []);
        indexes.set(indexKey, index);
      }
      if (!index.has(JSON.stringify(foreignValues))) fail("TRANSFER_RELATIONAL_CLOSURE_UNRESOLVED");
    }
  }
}

function validateTableCatalog(snapshot: TenantTransferSnapshot, schema: {
  columns: { table: string; name: string; type: string; notNull: boolean }[];
  constraints: { table: string; type: string; columns: string[]; referencedTable: string; referencedColumns: string[] }[];
}) {
  for (const table of snapshot.tables) {
    const columns = schema.columns.filter((column) => column.table === table.name)
      .map((column) => ({ name: column.name, type: column.type, nullable: !column.notNull }));
    const constraints = schema.constraints.filter((key) => key.table === table.name);
    const primary = constraints.find((key) => key.type === "p")?.columns ?? [];
    const keys = constraints.filter((key) => key.type === "f").map((key) => ({ columns: key.columns,
      referencedTable: key.referencedTable, referencedColumns: key.referencedColumns }));
    const actual = table.foreignKeys.filter((key) => !("declared" in key && key.declared));
    if (hashCanonical(columns) !== hashCanonical(table.columns)
      || hashCanonical(primary) !== hashCanonical(table.primaryKey)
      || hashCanonical(keys) !== hashCanonical(actual)) fail("TRANSFER_CATALOG_METADATA_MISMATCH");
    for (const key of table.foreignKeys.filter((key) => "declared" in key && key.declared)) {
      const policy = snapshot.manifest.tables[table.name]?.fields?.[key.columns[0]];
      if (key.columns.length !== 1 || key.referencedColumns.length !== 1
        || policy?.kind !== "reference" || !("references" in policy)
        || (policy.references as {table:string;column:string}).table !== key.referencedTable
        || (policy.references as {table:string;column:string}).column !== key.referencedColumns[0]) {
        fail("TRANSFER_DECLARED_REFERENCE_INVALID");
      }
    }
  }
}
