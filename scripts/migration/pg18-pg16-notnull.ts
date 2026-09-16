import { createHash } from "node:crypto";
import { hashCanonical } from "./shared-tenant-export";
import { readSharedTenantSchema } from "./shared-tenant-inventory.mjs";
import type { TenantTransferSnapshot, TransferSqlClient } from "./shared-tenant-transfer-contract";

export const PG18_TO_PG16_NOT_NULL_RULE = "pg18-to-pg16-validated-local-notnull-v1" as const;
type Row = Record<string, unknown>;
type Catalog = { columns: Row[]; constraints: Row[]; indexes: Row[]; triggers: Row[] };
export interface PgNotNullEvidence {
  rule: typeof PG18_TO_PG16_NOT_NULL_RULE;
  serverVersionNum: string;
  serverVersion: string;
  database: string;
  sourceSnapshot: string;
  rawCatalog: Catalog;
  rawSchemaSha256: string;
  relations: Row[];
  attributes: Row[];
  constraints: Row[];
  enums: Row[];
  collations: Row[];
  databaseLocale: Row[];
  extensions: Row[];
  sha256: string;
}
export interface Pg18ToPg16NotNullComparison {
  rule: typeof PG18_TO_PG16_NOT_NULL_RULE;
  sourceSnapshotSha256: string;
  sourceEvidenceSha256: string;
  targetEvidenceSha256: string;
  sourceVersion: string;
  targetVersion: string;
  sourceRawSchemaSha256: string;
  targetRawSchemaSha256: string;
  semanticSha256: string;
  sha256: string;
}
function fail(reason: string): never { throw new Error(`TRANSFER_PG18_PG16_NOTNULL_${reason}`); }
const equal = (a: unknown, b: unknown) => hashCanonical(a) === hashCanonical(b);
const rawHash = (catalog: Catalog) => createHash("sha256").update(JSON.stringify(catalog)).digest("hex");
const key = (row: Row) => JSON.stringify([row.table, row.name]);
function unique(rows: Row[]) {
  const result = new Map<string, Row>();
  for (const row of rows) {
    if (!row || typeof row.table !== "string" || typeof row.name !== "string" || result.has(key(row))) fail("AMBIGUOUS_RECORD");
    result.set(key(row), row);
  }
  return result;
}

/** Must share the export snapshot, or the import's serializable transaction. */
export async function readPgNotNullEvidence(client: TransferSqlClient): Promise<PgNotNullEvidence> {
  const { rows: [identity] } = await client.query(`SELECT current_setting('server_version_num') AS version,
    current_setting('server_version') AS description, current_database() AS database,
    pg_current_snapshot()::text AS snapshot, current_setting('transaction_isolation') AS isolation`);
  if (!identity || !["repeatable read", "serializable"].includes(String(identity.isolation))) fail("SNAPSHOT_TRANSACTION_REQUIRED");
  const version = String(identity.version);
  if (!/^(16|18)\d{4}$/.test(version)) fail("VERSION_UNSUPPORTED");
  const pg18 = version.startsWith("18");
  const raw = await readSharedTenantSchema(client);
  const query = async (sql: string) => (await client.query(sql)).rows;
  const relations = await query(`SELECT c.relname AS "table", c.relkind::text AS kind, c.relispartition AS partition,
    EXISTS(SELECT 1 FROM pg_inherits i WHERE i.inhrelid=c.oid OR i.inhparent=c.oid) AS inheritance
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind IN ('r','p','f') ORDER BY c.relname`);
  const attributes = await query(`SELECT c.relname AS "table", a.attname AS name, a.attnum AS number,
    a.attnotnull AS "notNull", a.attislocal AS local, a.attinhcount AS ancestors, t.typtype::text AS "typeKind",
    (a.attcollation<>0) AS collatable,
    EXISTS(WITH RECURSIVE dependencies AS (
      SELECT t.oid,t.typtype,t.typelem,t.typbasetype
      UNION SELECT p.oid,p.typtype,p.typelem,p.typbasetype FROM pg_type p JOIN dependencies d ON p.oid=d.typelem OR p.oid=d.typbasetype
    ) SELECT 1 FROM dependencies WHERE typtype='d') AS domain
    FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_type t ON t.oid=a.atttypid WHERE n.nspname='public' AND c.relkind IN ('r','p','f')
    AND a.attnum>0 AND NOT a.attisdropped ORDER BY c.relname,a.attnum`);
  const constraints = await query(`SELECT c.relname AS "table", k.conname AS name, k.contype::text AS type,
    k.convalidated AS validated, ${pg18 ? "k.conenforced" : "true"} AS enforced,
    k.conislocal AS local, k.coninhcount AS ancestors, k.connoinherit AS "noInherit",
    (k.conparentid<>0) AS parent, (k.contypid<>0) AS domain,
    k.condeferrable AS deferrable, k.condeferred AS deferred,
    ARRAY(SELECT a.attname::text FROM unnest(k.conkey) WITH ORDINALITY x(num,pos)
      JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=x.num ORDER BY x.pos) AS columns
    FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' ORDER BY c.relname,k.conname`);
  // Domain types (including array/composite dependencies) are outside this rule.
  if ((await query(`SELECT t.typname FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
    WHERE n.nspname='public' AND t.typtype='d'`)).length) fail("DOMAIN_UNSUPPORTED");
  const enums = await query(`SELECT t.typname AS name,e.enumlabel AS label,e.enumsortorder AS position
    FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid JOIN pg_namespace n ON n.oid=t.typnamespace
    WHERE n.nspname='public' ORDER BY t.typname,e.enumsortorder`);
  const collations = await query(`SELECT c.relname AS "table",a.attname AS name,nc.nspname AS namespace,
    co.collname AS collation,co.collprovider::text AS provider,co.collisdeterministic AS deterministic,
    co.collencoding AS encoding,co.collcollate AS locale,co.collctype AS ctype,co.collversion AS version,
    pg_collation_actual_version(co.oid) AS actual
    FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_collation co ON co.oid=a.attcollation JOIN pg_namespace nc ON nc.oid=co.collnamespace
    WHERE n.nspname='public' AND c.relkind IN ('r','p','f') AND a.attnum>0 AND NOT a.attisdropped
    ORDER BY c.relname,a.attnum`);
  const databaseLocale = await query(`SELECT pg_encoding_to_char(encoding) AS encoding,datcollate AS locale,
    datctype AS ctype,datlocprovider::text AS provider,datcollversion AS version,
    pg_database_collation_actual_version(oid) AS actual FROM pg_database WHERE datname=current_database()`);
  const extensions = await query(`SELECT e.extname AS name,e.extversion AS version,n.nspname AS namespace
    FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace ORDER BY e.extname`);
  const body = { rule: PG18_TO_PG16_NOT_NULL_RULE, serverVersionNum: version, serverVersion: String(identity.description),
    database: String(identity.database), sourceSnapshot: String(identity.snapshot), rawCatalog: raw.schema as Catalog,
    rawSchemaSha256: raw.schemaSha256, relations, attributes, constraints, enums, collations, databaseLocale, extensions };
  const evidence = { ...body, sha256: hashCanonical(body) };
  semanticCatalog(evidence, pg18 ? 18 : 16);
  return evidence;
}

/** Operator preparation only; importing re-reads and binds the target again. */
export async function capturePg16NotNullTarget(client: TransferSqlClient) {
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    const evidence = await readPgNotNullEvidence(client);
    semanticCatalog(evidence, 16);
    await client.query("COMMIT");
    return evidence;
  } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
}

function semanticCatalog(evidence: PgNotNullEvidence, major: 16 | 18) {
  if (!evidence || evidence.rule !== PG18_TO_PG16_NOT_NULL_RULE) fail("EVIDENCE_REQUIRED");
  const { sha256, ...body } = evidence;
  if (!/^[a-f0-9]{64}$/.test(sha256) || !equal(sha256, hashCanonical(body))) fail("EVIDENCE_DIGEST_MISMATCH");
  if (typeof evidence.serverVersionNum !== "string" || !new RegExp(`^${major}\\d{4}$`).test(evidence.serverVersionNum)
    || typeof evidence.serverVersion !== "string" || !evidence.serverVersion
    || typeof evidence.database !== "string" || !evidence.database || typeof evidence.sourceSnapshot !== "string"
    || !/^\d+:\d+:[\d,]*$/.test(evidence.sourceSnapshot)) fail("IDENTITY_INVALID");
  const raw = evidence.rawCatalog;
  if (!raw || ![raw.columns, raw.constraints, raw.indexes, raw.triggers, evidence.relations,
    evidence.attributes, evidence.constraints, evidence.enums, evidence.collations, evidence.databaseLocale, evidence.extensions].every(Array.isArray)
    || rawHash(raw) !== evidence.rawSchemaSha256) fail("CATALOG_DIGEST_MISMATCH");
  const columns = unique(raw.columns), attributes = unique(evidence.attributes), constraints = unique(raw.constraints), details = unique(evidence.constraints);
  unique(raw.indexes); unique(raw.triggers); const collations = unique(evidence.collations);
  if (!columns.size || columns.size !== attributes.size || constraints.size !== details.size) fail("RECORD_COVERAGE_MISMATCH");
  const tables = new Set(raw.columns.map((column) => column.table));
  if (evidence.relations.length !== tables.size || new Set(evidence.relations.map((row) => row.table)).size !== tables.size) fail("RELATION_COVERAGE_MISMATCH");
  for (const row of evidence.relations) if (!tables.has(row.table) || row.kind !== "r" || row.partition !== false || row.inheritance !== false) fail("INHERITANCE_UNSUPPORTED");
  for (const [id, column] of columns) {
    const attr = attributes.get(id);
    if (!attr || attr.notNull !== column.notNull || typeof column.notNull !== "boolean"
      || attr.local !== true || attr.ancestors !== 0 || !Number.isInteger(attr.number) || Number(attr.number) < 1
      || attr.domain !== false || typeof attr.collatable !== "boolean" || attr.collatable !== collations.has(id)
      || !["b", "e"].includes(String(attr.typeKind))) fail("ATTRIBUTE_UNSUPPORTED");
  }
  if ([...collations.keys()].some((id) => !attributes.has(id))) fail("ATTRIBUTE_UNSUPPORTED");
  const notNull = new Set<string>();
  for (const [id, constraint] of constraints) {
    const detail = details.get(id);
    if (!detail || !equal(detail.columns, constraint.columns) || detail.type !== constraint.type
      || detail.deferrable !== constraint.deferrable || detail.deferred !== constraint.deferred
      || typeof detail.validated !== "boolean" || detail.enforced !== true
      || detail.local !== true || detail.ancestors !== 0 || detail.parent !== false || detail.domain !== false
      || typeof detail.noInherit !== "boolean") fail("CONSTRAINT_UNSUPPORTED");
    if (constraint.type !== "n") continue;
    if (major !== 18 || detail.validated !== true || detail.noInherit !== false
      || detail.deferrable !== false || detail.deferred !== false || !Array.isArray(detail.columns) || detail.columns.length !== 1) fail("NOTNULL_UNSUPPORTED");
    const columnKey = JSON.stringify([constraint.table, detail.columns[0]]);
    if (columns.get(columnKey)?.notNull !== true || notNull.has(columnKey)) fail("NOTNULL_COVERAGE_MISMATCH");
    notNull.add(columnKey);
  }
  if (major === 18 && raw.columns.some((row) => row.notNull === true && !notNull.has(key(row)))) fail("NOTNULL_COVERAGE_MISMATCH");
  if (evidence.databaseLocale.length !== 1) fail("LOCALE_UNSUPPORTED");
  // Restrict v1 to libc C/POSIX. ICU/builtin locale metadata differ by major.
  const locale = evidence.databaseLocale[0];
  if (locale.provider !== "c" || !["C", "POSIX"].includes(String(locale.locale)) || locale.ctype !== locale.locale
    || locale.encoding !== "UTF8" || locale.version !== null || locale.actual !== null) fail("LOCALE_UNSUPPORTED");
  for (const collation of evidence.collations) if (collation.deterministic !== true || collation.version !== collation.actual
    || !["default", "C", "POSIX"].includes(String(collation.collation)) || collation.namespace !== "pg_catalog") fail("LOCALE_UNSUPPORTED");
  if (!evidence.extensions.length || evidence.extensions.some((row) => typeof row.name !== "string" || typeof row.version !== "string")) fail("EXTENSION_EVIDENCE_REQUIRED");
  return {
    ...raw, constraints: raw.constraints.filter((row) => row.type !== "n"),
    relations: evidence.relations, attributes: evidence.attributes,
    constraintSemantics: evidence.constraints.filter((row) => row.type !== "n"),
    enums: evidence.enums, collations: evidence.collations, databaseLocale: evidence.databaseLocale, extensions: evidence.extensions,
  };
}

export function assertPg18NotNullSource(snapshot: TenantTransferSnapshot) {
  const source = snapshot.pg18ToPg16NotNullEvidence;
  if (!source) fail("SOURCE_EVIDENCE_REQUIRED");
  semanticCatalog(source, 18);
  if (source.rawSchemaSha256 !== snapshot.schemaSha256 || source.database !== snapshot.sourceDatabase
    || source.sourceSnapshot !== snapshot.sourceSnapshot) fail("SOURCE_BINDING_MISMATCH");
  return source;
}

function targetDigest(target: PgNotNullEvidence) {
  // The prepared target transaction's MVCC snapshot necessarily changes at import.
  // Everything else, including exact version, database and raw catalog, is pinned.
  const { sourceSnapshot: _snapshot, sha256: _hash, ...body } = target;
  return hashCanonical(body);
}

export function comparePg18ToPg16NotNull(snapshot: TenantTransferSnapshot, target: PgNotNullEvidence): Pg18ToPg16NotNullComparison {
  const { sha256, ...snapshotBody } = snapshot;
  if (sha256 !== hashCanonical(snapshotBody)) fail("SNAPSHOT_DIGEST_MISMATCH");
  const source = assertPg18NotNullSource(snapshot);
  const sourceSemantics = semanticCatalog(source, 18), targetSemantics = semanticCatalog(target, 16);
  if (!equal(sourceSemantics, targetSemantics)) fail("SEMANTIC_MISMATCH");
  const body = { rule: PG18_TO_PG16_NOT_NULL_RULE, sourceSnapshotSha256: snapshot.sha256,
    sourceEvidenceSha256: source.sha256, targetEvidenceSha256: targetDigest(target),
    sourceVersion: source.serverVersionNum, targetVersion: target.serverVersionNum,
    sourceRawSchemaSha256: source.rawSchemaSha256, targetRawSchemaSha256: target.rawSchemaSha256,
    semanticSha256: hashCanonical(sourceSemantics) };
  return { ...body, sha256: hashCanonical(body) };
}

export function verifyPg18ToPg16NotNullComparison(snapshot: TenantTransferSnapshot, target: PgNotNullEvidence, expected: Pg18ToPg16NotNullComparison) {
  const actual = comparePg18ToPg16NotNull(snapshot, target);
  if (!expected || !equal(actual, expected)) fail("COMPARISON_MISMATCH");
  return actual;
}
