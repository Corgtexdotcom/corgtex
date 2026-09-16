import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import pg from "pg";
import { readPgNotNullEvidence, capturePg16NotNullTarget, comparePg18ToPg16NotNull } from "./pg18-pg16-notnull";
import { exportTenantSnapshot, hashCanonical } from "./shared-tenant-export";
import { importTenantSnapshot, type TenantImportOptions } from "./shared-tenant-import";
import { inventorySharedTenantSource } from "./shared-tenant-inventory.mjs";
import type { PgNotNullEvidence } from "./pg18-pg16-notnull";
import type { TenantTransferManifest, TenantTransferSnapshot } from "./shared-tenant-transfer-contract";

// The qualification supplies two freshly provisioned, isolated databases.
function client(variable: string, major: string) {
  const value = process.env[variable];
  if (!value) throw new Error(`Explicit synthetic URL required: ${variable}`);
  const url = new URL(value);
  if (!["127.0.0.1", "localhost", `${major === "18" ? "source" : "target"}-db`].includes(url.hostname)
    || url.pathname !== `/pg_notnull_${major}_test`) throw new Error("Isolated NOT NULL test database required");
  return new pg.Client({ connectionString: value });
}
const source = client("PG18_NOTNULL_TEST_SOURCE_URL", "18");
const target = client("PG18_NOTNULL_TEST_TARGET_URL", "16");
const proof = '"PgNotNullProof"';
before(async () => {
  await source.connect(); await target.connect();
  for (const db of [source, target]) await db.query(`CREATE TABLE ${proof} (id text PRIMARY KEY, value text NOT NULL)`);
});
after(async () => {
  for (const db of [source, target]) { await db.query("ROLLBACK").catch(() => {}); await db.end(); }
});
async function transactions(run: () => Promise<void>) {
  await source.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  await target.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  try { await run(); } finally { await source.query("ROLLBACK"); await target.query("ROLLBACK"); }
}
function fromEvidence(evidence: PgNotNullEvidence): TenantTransferSnapshot {
  const manifest: TenantTransferManifest = { formatVersion: 1, transferId: "catalog-test", workspaceId: "fixture", workspaceSlug: "fixture", schemaSha256: evidence.rawSchemaSha256, tables: {} };
  const body = { formatVersion: 1 as const, manifest, manifestSha256: hashCanonical(manifest), sourceSnapshot: evidence.sourceSnapshot,
    sourceDatabase: evidence.database, schemaSha256: evidence.rawSchemaSha256, pg18ToPg16NotNullEvidence: evidence, tables: [], dispositions: [] };
  return { ...body, sha256: hashCanonical(body) };
}

test("plain validated NOT NULL is equivalent and rejects NULL INSERT and UPDATE on both engines", async () => transactions(async () => {
  const value = fromEvidence(await readPgNotNullEvidence(source));
  const comparison = comparePg18ToPg16NotNull(value, await readPgNotNullEvidence(target));
  assert.notEqual(comparison.sourceRawSchemaSha256, comparison.targetRawSchemaSha256);
  for (const db of [source, target]) {
    await db.query(`INSERT INTO ${proof} VALUES ('valid','kept')`);
    for (const sql of [`INSERT INTO ${proof} VALUES ('invalid',NULL)`, `UPDATE ${proof} SET value=NULL WHERE id='valid'`]) {
      await db.query("SAVEPOINT null_probe");
      await assert.rejects(db.query(sql), (error: { code?: string }) => error.code === "23502");
      await db.query("ROLLBACK TO SAVEPOINT null_probe");
      await db.query("RELEASE SAVEPOINT null_probe");
    }
    assert.deepEqual((await db.query(`SELECT * FROM ${proof}`)).rows, [{ id: "valid", value: "kept" }]);
  }
}));

for (const [name, sql] of [
  ["unvalidated NOT NULL despite clean rows", `ALTER TABLE ${proof} ALTER COLUMN value DROP NOT NULL; ALTER TABLE ${proof} ADD CONSTRAINT not_valid NOT NULL value NOT VALID`],
  ["NO INHERIT", `ALTER TABLE ${proof} ALTER COLUMN value DROP NOT NULL; ALTER TABLE ${proof} ADD CONSTRAINT no_inherit NOT NULL value NO INHERIT`],
  ["inheritance", `CREATE TABLE "InheritedProof" () INHERITS (${proof})`],
  ["partition", `CREATE TABLE "PartitionProof" (id text NOT NULL) PARTITION BY LIST(id)`],
  ["domain", `CREATE DOMAIN "DomainProof" AS text NOT NULL`],
] as const) {
  test(`rejects real ${name}`, async () => transactions(async () => {
    await source.query(`INSERT INTO ${proof} VALUES ('clean','non-null')`);
    await source.query(sql);
    await assert.rejects(readPgNotNullEvidence(source), /TRANSFER_PG18_PG16_NOTNULL_/);
  }));
}
for (const [name, sql] of [
  ["nullable column", `ALTER TABLE ${proof} ALTER COLUMN value DROP NOT NULL`],
  ["default", `ALTER TABLE ${proof} ALTER COLUMN value SET DEFAULT 'drift'`],
  ["type", `ALTER TABLE ${proof} ALTER COLUMN value TYPE varchar(50)`],
  ["CHECK", `ALTER TABLE ${proof} ADD CONSTRAINT drift_check CHECK (value <> '')`],
  ["FK", `ALTER TABLE ${proof} ADD CONSTRAINT drift_fk FOREIGN KEY (id) REFERENCES "Workspace"(id) NOT VALID`],
  ["enum", `ALTER TYPE "WorkflowJobStatus" ADD VALUE 'SYNTHETIC_DRIFT'`],
  ["column collation", `ALTER TABLE ${proof} ALTER COLUMN value TYPE text COLLATE "C"`],
] as const) {
  test(`rejects real unrelated target ${name} drift`, async () => transactions(async () => {
    const value = fromEvidence(await readPgNotNullEvidence(source));
    await target.query(sql);
    assert.throws(() => comparePg18ToPg16NotNull(value, {} as PgNotNullEvidence), /TRANSFER_PG18_PG16_NOTNULL_/);
    const evidence = await readPgNotNullEvidence(target);
    assert.throws(() => comparePg18ToPg16NotNull(value, evidence), /SEMANTIC_MISMATCH/);
  }));
}

test("fresh export is opt-in; stale target rejects inside importer and preserves the existing tenant", async () => {
  await source.query(`INSERT INTO "Workspace" (id,slug,name,"updatedAt") VALUES ('fixture','fixture','Source',now())`);
  await target.query(`INSERT INTO "Workspace" (id,slug,name,"updatedAt") VALUES ('existing','existing','Existing',now())`);
  const inventory = await inventorySharedTenantSource(source);
  const manifest: TenantTransferManifest = { formatVersion: 1, transferId: "guard-test", workspaceId: "fixture", workspaceSlug: "fixture", schemaSha256: inventory.schemaSha256,
    tables: { _prisma_migrations: { disposition: "operator-control", reason: "Test control" }, Workspace: { disposition: "copy", reason: "Synthetic fixture",
      fields: Object.fromEntries(inventory.schema.columns.filter((c: { table: string; type: string }) => c.table === "Workspace" && (/^jsonb?$/.test(c.type) || c.type.endsWith("[]"))).map((c: { name: string }) => [c.name, { kind: "content", reason: "Fixture content" }])) } } };
  const old = await exportTenantSnapshot(source, manifest);
  assert.equal(Object.hasOwn(old, "pg18ToPg16NotNullEvidence"), false);
  const value = await exportTenantSnapshot(source, manifest, { pg18ToPg16NotNullEvidence: true });
  const comparison = comparePg18ToPg16NotNull(value, await capturePg16NotNullTarget(target));
  function options(snapshot: TenantTransferSnapshot): TenantImportOptions {
    const body = { formatVersion: 1 as const, transferId: snapshot.manifest.transferId, sourceSnapshotSha256: snapshot.sha256, sourceStoreId: "empty-source", targetStoreId: "empty-target", entries: [] };
    return { identityLinks: [], objectStorageBinding: { sourceStoreId: body.sourceStoreId, targetStoreId: body.targetStoreId }, objectReceipt: { ...body, sha256: hashCanonical(body) } };
  }
  const before = (await target.query('SELECT row_to_json(w)::text AS value FROM "Workspace" w ORDER BY id')).rows;
  await assert.rejects(importTenantSnapshot(target, old, options(old)), /TRANSFER_TARGET_SCHEMA_MISMATCH/);
  await target.query(`ALTER TABLE ${proof} ALTER COLUMN value SET DEFAULT 'stale-target'`);
  try {
    await assert.rejects(importTenantSnapshot(target, value, { ...options(value), pg18ToPg16NotNull: comparison }), /SEMANTIC_MISMATCH/);
    assert.deepEqual((await target.query('SELECT row_to_json(w)::text AS value FROM "Workspace" w ORDER BY id')).rows, before);
    assert.equal((await target.query('SELECT count(*) FROM "WorkspaceFeatureFlag"')).rows[0].count, "0");
    assert.equal((await target.query("SHOW transaction_isolation")).rows[0].transaction_isolation, "read committed");
  } finally { await target.query(`ALTER TABLE ${proof} ALTER COLUMN value DROP DEFAULT`); }
  // A late failure must roll back even after valid compatibility and row insertion.
  let inserts = 0;
  const interrupted = { query: async (sql: string, parameters?: unknown[]) => {
    if (sql.startsWith("INSERT INTO")) inserts++;
    if (sql === "COMMIT") throw new Error("SYNTHETIC_BEFORE_COMMIT");
    return target.query(sql, parameters);
  } };
  await assert.rejects(importTenantSnapshot(interrupted, value, { ...options(value), pg18ToPg16NotNull: comparison }), /SYNTHETIC_BEFORE_COMMIT/);
  assert.ok(inserts > 0);
  assert.deepEqual((await target.query('SELECT row_to_json(w)::text AS value FROM "Workspace" w ORDER BY id')).rows, before);
  assert.equal((await target.query('SELECT count(*) FROM "WorkspaceFeatureFlag"')).rows[0].count, "0");
});
