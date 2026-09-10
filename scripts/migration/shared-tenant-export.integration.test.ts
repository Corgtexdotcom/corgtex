import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { after, before, test } from "node:test";
import pg from "pg";
import { canonicalManifest, exportTenantSnapshot, hashCanonical, hashFrames } from "./shared-tenant-export";
import { inventorySharedTenantSource, readSharedTenantSchema } from "./shared-tenant-inventory.mjs";
import type { TenantTransferManifest, TransferSqlClient } from "./shared-tenant-transfer-contract";

let containerId: string;
let db: pg.Client;
let peer: pg.Client;
const tenantA = randomUUID(); const tenantB = randomUUID(); const sharedUser = randomUUID(); const historicalUser = randomUUID();
const memberA = randomUUID(); const memberB = randomUUID(); const roleA = randomUUID(); const roleB = randomUUID();
const emailOnlyUser = randomUUID();
const actionA = randomUUID(); const numericId = randomUUID(); const vectorId = randomUUID();
let manifest: TenantTransferManifest;

before(async () => {
  containerId = execFileSync("docker", ["run", "--detach", "--rm", "--name", `corgtex-export-test-${randomUUID()}`,
    "-e", "POSTGRES_PASSWORD=postgres", "-e", "POSTGRES_DB=tenant_export_test", "-p", "127.0.0.1::5432", "pgvector/pgvector:pg16"], { encoding: "utf8" }).trim();
  const port = execFileSync("docker", ["port", containerId, "5432"], { encoding: "utf8" }).trim().split(":").at(-1);
  const connectionString = `postgresql://postgres:postgres@127.0.0.1:${port}/tenant_export_test`;
  for (let attempt = 0; ; attempt++) {
    const probe = new pg.Client({ connectionString });
    try { await probe.connect(); await probe.end(); break; }
    catch (error) { await probe.end().catch(() => {}); if (attempt === 60) throw error; await delay(100); }
  }
  execFileSync("node_modules/.bin/prisma", ["migrate", "deploy"], { env: { ...process.env, DATABASE_URL: connectionString }, stdio: "pipe" });
  db = new pg.Client({ connectionString }); peer = new pg.Client({ connectionString });
  await db.connect(); await peer.connect();
  await db.query('INSERT INTO "Workspace" (id,slug,name,"updatedAt") VALUES ($1,$1,\'Tenant A\',now()),($2,$2,\'Tenant B\',now())', [tenantA, tenantB]);
  for (const id of [sharedUser, historicalUser, emailOnlyUser, randomUUID()]) await db.query('INSERT INTO "User" (id,email,"passwordHash","updatedAt") VALUES ($1,$2,\'synthetic\',now())', [id, `${id}@example.invalid`]);
  await db.query('INSERT INTO "Member" (id,"workspaceId","userId") VALUES ($1,$3,$5),($2,$4,$5)', [memberA, memberB, tenantA, tenantB, sharedUser]);
  for (const [workspaceId, roleId] of [[tenantA, roleA], [tenantB, roleB]]) {
    const circleId = randomUUID();
    await db.query('INSERT INTO "Circle" (id,"workspaceId",name,"updatedAt") VALUES ($1,$2,$1,now())', [circleId, workspaceId]);
    await db.query('INSERT INTO "Role" (id,"circleId",name,accountabilities,artifacts,"updatedAt") VALUES ($1,$2,$1,ARRAY[\'synthetic\'],ARRAY[]::text[],now())', [roleId, circleId]);
  }
  await db.query('INSERT INTO "RoleAssignment" (id,"roleId","memberId") VALUES ($1,$2,$3)', [randomUUID(), roleA, memberA]);
  await db.query('INSERT INTO "Action" (id,"workspaceId","authorUserId",title,"updatedAt") VALUES ($1,$2,$3,\'historical actor\',now())', [actionA, tenantA, historicalUser]);
  await db.query(`INSERT INTO "ModelUsage" (id,"workspaceId",provider,model,"taskType","estimatedCostUsd","createdAt") VALUES ($1,$2,'synthetic','synthetic','CHAT',123456.123456,'2026-09-10 01:02:03.123')`, [numericId, tenantA]);
  await db.query(`INSERT INTO "KnowledgeChunk" (id,"workspaceId","sourceType","sourceId",content,metadata,"vectorEmbedding")
    VALUES ($1,$2,'DOCUMENT','synthetic','synthetic','{"integer":9007199254740993,"fraction":0.1234567890123456789}', $3::vector)`, [vectorId, tenantA, `[${[0.123456789, ...Array(1535).fill(0)].join(",")}]`]);
  await db.query(`INSERT INTO "EmailDelivery" (id,"providerMessageId","emailType","toEmail","toDomain",subject,"workspaceId","userId","updatedAt")
    VALUES ($1,$1,'synthetic','synthetic@example.invalid','example.invalid','synthetic',$2,$3,now())`, [randomUUID(), tenantA, emailOnlyUser]);
  manifest = await fixtureManifest();
});
after(async () => {
  await db?.end(); await peer?.end();
  if (containerId) execFileSync("docker", ["stop", containerId], { stdio: "pipe" });
});
async function fixtureManifest(): Promise<TenantTransferManifest> {
  const inventory = await inventorySharedTenantSource(db);
  return {
    formatVersion: 1, transferId: "synthetic-transfer", workspaceId: tenantA, workspaceSlug: tenantA, schemaSha256: inventory.schemaSha256,
    tables: Object.fromEntries(inventory.tables.filter((table: { rows: string }) => BigInt(table.rows) > 0n).map((table: { name: string }) => [table.name, {
      disposition: table.name === "_prisma_migrations" ? "operator-control" : "copy", reason: "Explicit synthetic fixture classification",
      fields: { ...(table.name === "User" ? { passwordHash: { kind: "secret", reason: "Source password is replaced for new target identities" } } : {}),
        ...(table.name === "KnowledgeChunk" ? { sourceId: { kind: "reference", reason: "Explicit polymorphic historical source identifier" } } : {}),
        ...(table.name === "EmailDelivery" ? { providerMessageId: { kind: "reference", reason: "Provider receipt identity" }, workspaceId: { kind: "reference", reason: "Scalar tenant ownership" }, userId: { kind: "reference", reason: "Explicit synthetic scalar actor", references: { table: "User", column: "id" } } } : {}), ...Object.fromEntries(inventory.schema.columns.filter((column: { table: string; type: string }) => column.table === table.name && (/^jsonb?$/.test(column.type) || column.type.endsWith("[]")))
        .map((column: { name: string }) => [column.name, { kind: "content", reason: "Synthetic content retained without number parsing" }])) },
    }])),
  };
}
async function assertIdle() {
  assert.equal((await db.query("SHOW transaction_read_only")).rows[0].transaction_read_only, "off");
  assert.equal((await db.query("SHOW transaction_isolation")).rows[0].transaction_isolation, "read committed");
}

test("consistent tenant closure includes indirect data and historical actors without other memberships", async () => {
  const snapshot = await exportTenantSnapshot(db, manifest);
  const records = (name: string) => {
    const table = snapshot.tables.find((table) => table.name === name)!;
    return table.rows.map((row) => Object.fromEntries(table.columns.map((column, index) => [column.name, row[index]])));
  };
  assert.deepEqual(records("Workspace").map((row) => row.id), [tenantA]);
  assert.deepEqual(records("Member").map((row) => row.id), [memberA]);
  assert.deepEqual(records("Role").map((row) => row.id), [roleA]);
  assert.deepEqual(new Set(records("User").map((row) => row.id)), new Set([sharedUser, historicalUser, emailOnlyUser]));
  assert.equal(snapshot.tables.find((table) => table.name === "EmailDelivery")?.foreignKeys.find((fk) => fk.columns[0] === "userId")?.declared, true);
  assert.equal(records("ModelUsage")[0].estimatedCostUsd, "123456.123456");
  assert.equal(records("ModelUsage")[0].createdAt, "2026-09-10 01:02:03.123");
  const raw = (await db.query('SELECT metadata::text, "vectorEmbedding"::text FROM "KnowledgeChunk" WHERE id=$1', [vectorId])).rows[0];
  assert.equal(records("KnowledgeChunk")[0].metadata, raw.metadata);
  assert.equal(records("KnowledgeChunk")[0].vectorEmbedding, raw.vectorEmbedding);
  assert.ok(records("KnowledgeChunk")[0].metadata?.includes("9007199254740993"));
  assert.equal(snapshot.dispositions.find((row) => row.table === "Member")?.sourceRows, "2");
  assert.equal(snapshot.dispositions.find((row) => row.table === "Member")?.selectedRows, "1");
  assert.equal(snapshot.dispositions.find((row) => row.table === "_prisma_migrations")?.disposition, "operator-control");
  for (const table of snapshot.tables) assert.equal(table.sha256, hashFrames(table.rows));
  const { sha256, ...body } = snapshot; assert.equal(sha256, hashCanonical(body));
  assert.equal(snapshot.manifestSha256, hashCanonical(manifest));
  await assertIdle();
});

test("all selections share one read-only repeatable-read snapshot", async () => {
  let changed = false;
  const statements: string[] = [];
  const client: TransferSqlClient = { query: async (sql, parameters) => {
    statements.push(sql);
    if (!changed && sql.startsWith("SELECT ARRAY[") && sql.includes('FROM public."Action" r')) {
      changed = true;
      await peer.query('UPDATE "Action" SET title=\'after snapshot\' WHERE id=$1', [actionA]);
    }
    return db.query(sql, parameters);
  } };
  const snapshot = await exportTenantSnapshot(client, manifest);
  const table = snapshot.tables.find((row) => row.name === "Action")!;
  assert.equal(table.rows[0][table.columns.findIndex((column) => column.name === "title")], "historical actor");
  assert.equal(statements.filter((sql) => sql.startsWith("BEGIN")).length, 1);
  assert.equal(statements.filter((sql) => sql === "COMMIT").length, 1);
  await assertIdle();
});

test("unclassified table/structured field and schema mismatch roll back", async () => {
  const missing = structuredClone(manifest); delete missing.tables.Action;
  await assert.rejects(exportTenantSnapshot(db, missing), /Unclassified populated table: Action/); await assertIdle();
  const field = structuredClone(manifest); delete field.tables.KnowledgeChunk.fields!.metadata;
  await assert.rejects(exportTenantSnapshot(db, field), /Unclassified populated JSON\/array field: KnowledgeChunk.metadata/); await assertIdle();
  await assert.rejects(exportTenantSnapshot(db, { ...manifest, schemaSha256: "0".repeat(64) }), /Source schema fingerprint/); await assertIdle();
});

test("cross-tenant indirect references block export", async () => {
  const id = randomUUID();
  await db.query('INSERT INTO "RoleAssignment" (id,"roleId","memberId") VALUES ($1,$2,$3)', [id, roleA, memberB]);
  try { await assert.rejects(exportTenantSnapshot(db, manifest), /Cross-tenant ownership: RoleAssignment/); await assertIdle(); }
  finally { await db.query('DELETE FROM "RoleAssignment" WHERE id=$1', [id]); }
});

test("outgoing references to excluded tables are explicit closure blockers", async () => {
  const excluded = structuredClone(manifest); excluded.tables.User.disposition = "operator-control";
  await assert.rejects(exportTenantSnapshot(db, excluded), /Closure blocker: .* references excluded User \(operator-control\)/);
  await assertIdle();
});

test("row and byte limits fail before returning and roll back", async () => {
  await assert.rejects(exportTenantSnapshot(db, manifest, { maxRows: 2 }), /Transfer row limit exceeded/); await assertIdle();
  await assert.rejects(exportTenantSnapshot(db, manifest, { maxBytes: 500 }), /Transfer byte limit exceeded/); await assertIdle();
});

test("unknown populated tables remain blockers even if given a policy", async () => {
  await db.query('CREATE TABLE "UnknownTransferFixture" (id text PRIMARY KEY)');
  await db.query('INSERT INTO "UnknownTransferFixture" VALUES (\'synthetic\')');
  try {
    const unknown = await fixtureManifest();
    await assert.rejects(exportTenantSnapshot(db, unknown), /Unknown populated table: UnknownTransferFixture/); await assertIdle();
  } finally { await db.query('DROP TABLE "UnknownTransferFixture"'); }
});

test("catalog fingerprint is reusable in writer transactions and inventory rejects writer reuse", async () => {
  await db.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  try {
    assert.equal((await readSharedTenantSchema(db)).schemaSha256, manifest.schemaSha256);
    await assert.rejects(inventorySharedTenantSource(db, { existingReadOnlyTransaction: true }), /Existing repeatable-read read-only transaction required/);
    assert.equal((await db.query("SHOW transaction_isolation")).rows[0].transaction_isolation, "serializable");
  } finally { await db.query("ROLLBACK"); }
});

test("canonical and framed hashes distinguish boundaries/null while ignoring object-key insertion order", () => {
  const reversed = Object.fromEntries(Object.entries(manifest).reverse()) as unknown as TenantTransferManifest;
  assert.equal(canonicalManifest(manifest), canonicalManifest(reversed));
  for (const different of [[["a", "bc"]], [["ab", "c"]], [[null]], [[""]], [["N;"]]]) {
    assert.notEqual(hashFrames(different), hashFrames([["a"], ["bc"]]));
  }
});


test("declared scalar references require reference kind and actual unique target keys", async () => {
  const nonunique = structuredClone(manifest);
  nonunique.tables.EmailDelivery.fields!.userId.references!.column = "displayName";
  await assert.rejects(exportTenantSnapshot(db, nonunique), /Declared reference target must have a scalar unique key/);
  await assertIdle();
  const wrongKind = structuredClone(manifest);
  wrongKind.tables.EmailDelivery.fields!.userId.kind = "content";
  await assert.rejects(exportTenantSnapshot(db, wrongKind), /Only reference fields may declare scalar dependencies/);
  await assertIdle();
});

test("real populated scalar secrets cannot be omitted or relabeled as ordinary content", async () => {
  const installation = randomUUID(), dataSource = randomUUID();
  await db.query(`INSERT INTO "CommunicationInstallation"(id,"workspaceId",provider,"externalWorkspaceId","botTokenEnc","updatedAt") VALUES($1,$2,'SLACK','synthetic-external','synthetic-credential',now())`, [installation, tenantA]);
  await db.query(`INSERT INTO "ExternalDataSource"(id,"workspaceId",label,"connectionStringEnc","updatedAt") VALUES($1,$2,'Synthetic datasource','synthetic-connection-secret',now())`, [dataSource, tenantA]);
  try {
    const value = await fixtureManifest();
    value.tables.CommunicationInstallation.fields!.externalWorkspaceId = { kind: "reference", reason: "Explicit external provider identity" };
    for (const kind of [undefined, "content"] as const) {
      if (kind) value.tables.CommunicationInstallation.fields!.botTokenEnc = { kind, reason: "Incorrect credential classification" };
      await assert.rejects(exportTenantSnapshot(db, value), /TRANSFER_SCALAR_FIELD_POLICY_REQUIRED:CommunicationInstallation.botTokenEnc:secret/); await assertIdle();
    }
    value.tables.CommunicationInstallation.fields!.botTokenEnc = { kind: "secret", reason: "Credential must be staged, nulled or reencrypted on import" };
    await assert.rejects(exportTenantSnapshot(db, value), /TRANSFER_SCALAR_FIELD_POLICY_REQUIRED:ExternalDataSource.connectionStringEnc:secret/); await assertIdle();
    value.tables.ExternalDataSource.fields!.connectionStringEnc = { kind: "secret", reason: "Datasource credential requires separate disposition" };
    const exported = await exportTenantSnapshot(db, value);
    assert.equal(exported.tables.find((table) => table.name === "CommunicationInstallation")!.rows.length, 1);
  } finally {
    await db.query('DELETE FROM "CommunicationInstallation" WHERE id=$1', [installation]);
    await db.query('DELETE FROM "ExternalDataSource" WHERE id=$1', [dataSource]);
  }
});

test("private export retains an existing source marker for explicit publication staging", async () => {
  const id = randomUUID();
  await db.query(`INSERT INTO "WorkspaceFeatureFlag"(id,"workspaceId",flag,enabled,config,"updatedAt") VALUES($1,$2,'operator_import_inactive',true,'{}',now())`, [id, tenantA]);
  try {
    const exported = await exportTenantSnapshot(db, await fixtureManifest());
    const flags = exported.tables.find((table) => table.name === "WorkspaceFeatureFlag")!;
    assert.equal(flags.rows[0][flags.columns.findIndex((column) => column.name === "flag")], "operator_import_inactive");
  } finally { await db.query('DELETE FROM "WorkspaceFeatureFlag" WHERE id=$1', [id]); }
});
