import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID, createCipheriv, createDecipheriv, createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { after, before, test } from "node:test";
import pg from "pg";
import { verifyPassword } from "../../packages/shared/src/crypto";
import { exportTenantSnapshot, hashCanonical, hashFrames } from "./shared-tenant-export";
import { importTenantSnapshot, type TenantImportOptions } from "./shared-tenant-import";
import { inventorySharedTenantSource } from "./shared-tenant-inventory.mjs";
import { validateObjectReceipt, type ObjectCopyReceipt } from "./shared-tenant-objects";
import type { TenantTransferManifest, TenantTransferSnapshot, TransferSqlClient } from "./shared-tenant-transfer-contract";

let containerId: string;
let port: string;
let admin: pg.Client;
let source: pg.Client;
let snapshot: TenantTransferSnapshot;
const workspaceId = randomUUID();
const newUser = randomUUID(); const linkedSourceUser = randomUUID();
const targetLinkedUser = randomUUID(); const otherWorkspace = randomUUID(); const otherCircle = randomUUID();
const rootCircle = randomUUID(); const childCircle = randomUUID(); const numericId = randomUUID(); const knowledgeId = randomUUID();
const agentId = randomUUID(); const terminalEventId = randomUUID(); const terminalJobId = randomUUID();
const targetPassword = "synthetic-target-password-must-remain";
const sourcePassword = "synthetic-source-password";

// Every URL is generated from this test's own ephemeral container. Ambient
// DATABASE_URL and existing local containers are never consumed or mutated.
function connectionString(database: string) {
  if (!/^transfer_(template|source|target_[a-f0-9]+)$/.test(database) && database !== "postgres") throw new Error("Synthetic database name required");
  const url = `postgresql://postgres:postgres@127.0.0.1:${port}/${database}`;
  if (new URL(url).hostname !== "127.0.0.1") throw new Error("LOCAL_SYNTHETIC_DATABASE_REQUIRED");
  return url;
}
before(async () => {
  containerId = execFileSync("docker", ["run", "--detach", "--rm", "--name", `corgtex-import-test-${randomUUID()}`,
    "-e", "POSTGRES_PASSWORD=postgres", "-e", "POSTGRES_DB=transfer_template", "-p", "127.0.0.1::5432", "pgvector/pgvector:pg16"], { encoding: "utf8" }).trim();
  port = execFileSync("docker", ["port", containerId, "5432"], { encoding: "utf8" }).trim().split(":").at(-1)!;
  for (let attempt = 0; ; attempt++) {
    const probe = new pg.Client({ connectionString: connectionString("postgres") });
    try { await probe.connect(); await probe.end(); break; }
    catch (error) { await probe.end().catch(() => {}); if (attempt === 60) throw error; await delay(100); }
  }
  execFileSync("node_modules/.bin/prisma", ["migrate", "deploy"], {
    env: { ...process.env, DATABASE_URL: connectionString("transfer_template") }, stdio: "pipe",
  });
  admin = new pg.Client({ connectionString: connectionString("postgres") }); await admin.connect();
  await admin.query('CREATE DATABASE "transfer_source" TEMPLATE "transfer_template"');
  source = new pg.Client({ connectionString: connectionString("transfer_source") }); await source.connect();
  await source.query('INSERT INTO "Workspace" (id,slug,name,"updatedAt") VALUES ($1,$1,\'Imported tenant\',now())', [workspaceId]);
  for (const [id, email] of [[newUser, "new@example.invalid"], [linkedSourceUser, "linked@example.invalid"]]) {
    await source.query('INSERT INTO "User" (id,email,"passwordHash","globalRole","updatedAt") VALUES ($1,$2,$3,\'OPERATOR\',now())', [id, email, sourcePassword]);
    await source.query('INSERT INTO "Member" (id,"workspaceId","userId") VALUES ($1,$2,$3)', [randomUUID(), workspaceId, id]);
  }
  await source.query('INSERT INTO "Circle" (id,"workspaceId",name,"updatedAt") VALUES ($1,$3,\'Parent\',now()),($2,$3,\'Child\',now())', [rootCircle, childCircle, workspaceId]);
  await source.query('UPDATE "Circle" SET "parentCircleId"=$2 WHERE id=$1', [childCircle, rootCircle]);
  await source.query(`INSERT INTO "ModelUsage" (id,"workspaceId",provider,model,"taskType","estimatedCostUsd","createdAt")
    VALUES ($1,$2,'synthetic','synthetic','CHAT',123456.123456,'2026-09-10 01:02:03.123')`, [numericId, workspaceId]);
  await source.query(`INSERT INTO "KnowledgeChunk" (id,"workspaceId","sourceType","sourceId",content,metadata,"vectorEmbedding")
    VALUES ($1,$2,'DOCUMENT','synthetic','synthetic','{"integer":9007199254740993,"fraction":0.1234567890123456789}', $3::vector)`, [knowledgeId, workspaceId, `[${[0.123456789, ...Array(1535).fill(0)].join(",")}]`]);
  await source.query(`INSERT INTO "EmailDelivery" (id,"providerMessageId","emailType","toEmail","toDomain",subject,"workspaceId","userId","updatedAt")
    VALUES ($1,$1,'synthetic','linked@example.invalid','example.invalid','synthetic',$2,$3,now())`, [randomUUID(), workspaceId, linkedSourceUser]);
  await source.query(`INSERT INTO "AgentIdentity" (id,"workspaceId","agentKey","displayName","updatedAt") VALUES ($1,$2,'synthetic','Synthetic agent',now())`, [agentId, workspaceId]);
  await source.query(`INSERT INTO "Event" (id,"workspaceId",type,payload,status,"dispatchedAt") VALUES ($1,$2,'synthetic.history','{}','DISPATCHED',now())`, [terminalEventId, workspaceId]);
  await source.query(`INSERT INTO "WorkflowJob" (id,"workspaceId","eventId",type,payload,status,"completedAt","updatedAt") VALUES ($1,$2,$3,'synthetic.history','{}','COMPLETED',now(),now())`, [terminalJobId, workspaceId, terminalEventId]);
  await source.query(`INSERT INTO "WorkspaceFeatureFlag" (id,"workspaceId",flag,enabled,config,"updatedAt") VALUES ($1,$2,'synthetic-existing-flag',false,'{}',now())`, [randomUUID(), workspaceId]);
  const inventory = await inventorySharedTenantSource(source);
  const manifest: TenantTransferManifest = {
    formatVersion: 1, transferId: "synthetic-import", workspaceId, workspaceSlug: workspaceId, schemaSha256: inventory.schemaSha256,
    tables: Object.fromEntries(inventory.tables.filter((table: { rows: string }) => BigInt(table.rows) > 0n).map((table: { name: string }) => [table.name, {
      disposition: table.name === "_prisma_migrations" ? "operator-control" : "copy", reason: "Explicit synthetic importer fixture",
      fields: { ...(table.name === "User" ? { passwordHash: { kind: "secret", reason: "Source password is replaced for new target identities" } } : {}),
        ...(table.name === "KnowledgeChunk" ? { sourceId: { kind: "reference", reason: "Explicit polymorphic historical source identifier" } } : {}),
        ...(table.name === "EmailDelivery" ? { providerMessageId: { kind: "reference", reason: "Provider receipt identity" }, workspaceId: { kind: "reference", reason: "Scalar tenant ownership" }, userId: { kind: "reference", reason: "Explicit scalar user binding", references: { table: "User", column: "id" } } } : {}),
        ...Object.fromEntries(inventory.schema.columns.filter((column: { table: string; type: string }) => column.table === table.name && (/^jsonb?$/.test(column.type) || column.type.endsWith("[]")))
          .map((column: { name: string }) => [column.name, { kind: "content", reason: "Synthetic content remains in PostgreSQL text format" }])) },
    }])),
  };
  snapshot = await exportTenantSnapshot(source, manifest);
});
after(async () => {
  await source?.end(); await admin?.end();
  if (containerId) execFileSync("docker", ["stop", containerId], { stdio: "pipe" });
});
function objectReceipt(value = snapshot, entries: ObjectCopyReceipt["entries"] = []): ObjectCopyReceipt {
  const body = { formatVersion: 1 as const, transferId: value.manifest.transferId, sourceSnapshotSha256: value.sha256,
    sourceStoreId: "synthetic-source", targetStoreId: "synthetic-target", entries };
  return validateObjectReceipt({ ...body, sha256: hashCanonical(body) });
}
function options(value = snapshot): TenantImportOptions {
  return { identityLinks: [{ sourceUserId: linkedSourceUser, targetUserId: targetLinkedUser,
    evidence: { kind: "operator-reviewed-ownership", reference: "synthetic-fixture-ownership", sha256: "a".repeat(64) } }], objectReceipt: objectReceipt(value) };
}
async function withTarget(run: (target: pg.Client, observer: pg.Client) => Promise<void>) {
  const database = `transfer_target_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE DATABASE "${database}" TEMPLATE "transfer_template"`);
  const target = new pg.Client({ connectionString: connectionString(database) }); const observer = new pg.Client({ connectionString: connectionString(database) });
  await target.connect(); await observer.connect();
  try {
    await target.query('INSERT INTO "Workspace" (id,slug,name,"updatedAt") VALUES ($1,$1,\'Existing shared tenant\',now())', [otherWorkspace]);
    await target.query('INSERT INTO "User" (id,email,"passwordHash","globalRole","displayName","updatedAt") VALUES ($1,\'linked@example.invalid\',$2,\'OPERATOR\',\'Target profile\',now())', [targetLinkedUser, targetPassword]);
    await target.query('INSERT INTO "Member" (id,"workspaceId","userId") VALUES ($1,$2,$3)', [randomUUID(), otherWorkspace, targetLinkedUser]);
    await target.query('INSERT INTO "Circle" (id,"workspaceId",name,"updatedAt") VALUES ($1,$2,\'Existing circle\',now())', [otherCircle, otherWorkspace]);
    await run(target, observer);
  } finally { await target.query("ROLLBACK").catch(() => {}); await target.end(); await observer.end(); await admin.query(`DROP DATABASE "${database}"`); }
}
async function readMarker(target: pg.Client) {
  return (await target.query(`SELECT enabled,config FROM "WorkspaceFeatureFlag" WHERE "workspaceId"=$1 AND flag='operator_import_inactive'`, [workspaceId])).rows[0];
}
async function assertAbsent(target: pg.Client) {
  assert.equal(await readMarker(target), undefined);
  assert.equal((await target.query('SELECT 1 FROM "Workspace" WHERE id=$1', [workspaceId])).rowCount, 0);
  assert.equal((await target.query('SELECT 1 FROM "User" WHERE id=$1', [newUser])).rowCount, 0);
  assert.equal((await target.query("SHOW transaction_isolation")).rows[0].transaction_isolation, "read committed");
}
function changedSnapshot(change: (value: TenantTransferSnapshot) => void) {
  const value = structuredClone(snapshot); change(value);
  for (const table of value.tables) table.sha256 = hashFrames(table.rows);
  value.manifestSha256 = hashCanonical(value.manifest);
  const { sha256: _sha256, ...body } = value; value.sha256 = hashCanonical(body);
  return value;
}
function setColumn(value: TenantTransferSnapshot, tableName: string, id: string, columnName: string, content: string | null) {
  const table = value.tables.find((table) => table.name === tableName)!;
  const row = table.rows.find((row) => row[table.columns.findIndex((column) => column.name === "id")] === id)!;
  row[table.columns.findIndex((column) => column.name === columnName)] = content;
}

test("integrated inactive import preserves existing tenant, target identity, self references and SQL values", async () => withTarget(async (target) => {
  const before = (await target.query('SELECT row_to_json(c)::text AS row FROM "Circle" c WHERE id=$1', [otherCircle])).rows[0].row;
  const result = await importTenantSnapshot(target, snapshot, options());
  assert.equal(result.alreadyImported, false);
  const marker = await readMarker(target);
  assert.equal(marker.enabled, true); assert.equal(marker.config.transferReceipt.sourceSnapshotSha256, snapshot.sha256);
  assert.equal((await target.query('SELECT count(*) FROM "Member" WHERE "workspaceId"=$1 AND "isActive"', [workspaceId])).rows[0].count, "0");
  assert.equal((await target.query('SELECT "isActive" FROM "AgentIdentity" WHERE id=$1', [agentId])).rows[0].isActive, false);
  assert.equal((await target.query('SELECT row_to_json(c)::text AS row FROM "Circle" c WHERE id=$1', [otherCircle])).rows[0].row, before);
  const targetIdentity = (await target.query('SELECT "passwordHash","globalRole","displayName" FROM "User" WHERE id=$1', [targetLinkedUser])).rows[0];
  assert.deepEqual(targetIdentity, { passwordHash: targetPassword, globalRole: "OPERATOR", displayName: "Target profile" });
  const importedIdentity = (await target.query('SELECT "globalRole","passwordHash" FROM "User" WHERE id=$1', [newUser])).rows[0];
  assert.equal(importedIdentity.globalRole, "USER");
  assert.equal(importedIdentity.passwordHash, "disabled:operator-import:synthetic-import");
  assert.equal(verifyPassword(sourcePassword, importedIdentity.passwordHash), false);
  assert.equal((await target.query('SELECT 1 FROM "User" WHERE id=$1', [linkedSourceUser])).rowCount, 0);
  assert.equal((await target.query('SELECT "userId" FROM "EmailDelivery" WHERE "workspaceId"=$1', [workspaceId])).rows[0].userId, targetLinkedUser);
  assert.equal((await target.query('SELECT "parentCircleId" FROM "Circle" WHERE id=$1', [childCircle])).rows[0].parentCircleId, rootCircle);
  const rawSql = 'SELECT "estimatedCostUsd"::text AS cost,"createdAt"::text AS at FROM "ModelUsage" WHERE id=$1';
  assert.deepEqual((await target.query(rawSql, [numericId])).rows, (await source.query(rawSql, [numericId])).rows);
  const knowledgeSql = 'SELECT metadata::text,"vectorEmbedding"::text FROM "KnowledgeChunk" WHERE id=$1';
  assert.deepEqual((await target.query(knowledgeSql, [knowledgeId])).rows, (await source.query(knowledgeSql, [knowledgeId])).rows);
  assert.equal((await target.query('SELECT status FROM "WorkflowJob" WHERE id=$1', [terminalJobId])).rows[0].status, "COMPLETED");
  assert.equal((await target.query('SELECT status FROM "Event" WHERE id=$1', [terminalEventId])).rows[0].status, "DISPATCHED");
  assert.equal((await target.query(`SELECT count(*) FROM "WorkflowJob" WHERE "workspaceId"=$1 AND status='PENDING' AND "runAfter"<=now()`, [workspaceId])).rows[0].count, "0");
  assert.equal((await target.query(`SELECT count(*) FROM "Event" WHERE "workspaceId"=$1 AND status='PENDING' AND "availableAt"<=now()`, [workspaceId])).rows[0].count, "0");
}));

test("workspace, inactive membership and marker receipt become visible together at commit", async () => withTarget(async (target, observer) => {
  let checked = false;
  const client: TransferSqlClient = { query: async (sql, parameters) => {
    if (sql === "COMMIT") {
      const inside = await readMarker(target);
      assert.ok(inside.enabled && inside.config.transferReceipt);
      assert.equal((await target.query('SELECT count(*) FROM "Member" WHERE "workspaceId"=$1 AND "isActive"', [workspaceId])).rows[0].count, "0");
      assert.equal(await readMarker(observer), undefined);
      assert.equal((await observer.query('SELECT 1 FROM "Workspace" WHERE id=$1', [workspaceId])).rowCount, 0);
      checked = true;
    }
    return target.query(sql, parameters);
  } };
  await importTenantSnapshot(client, snapshot, options()); assert.equal(checked, true);
  const visible = await readMarker(observer);
  assert.ok(visible.enabled && visible.config.transferReceipt);
  assert.equal((await observer.query('SELECT count(*) FROM "Member" WHERE "workspaceId"=$1 AND NOT "isActive"', [workspaceId])).rows[0].count, "2");
}));

test("unresolved email ownership and missing ownership evidence fail atomically", async () => withTarget(async (target) => {
  await assert.rejects(importTenantSnapshot(target, snapshot, { ...options(), identityLinks: [] }), /TRANSFER_USER_EMAIL_OWNERSHIP_UNRESOLVED/);
  await assertAbsent(target);
  const invalid = options(); invalid.identityLinks[0].evidence.reference = "";
  await assert.rejects(importTenantSnapshot(target, snapshot, invalid), /TRANSFER_IDENTITY_OWNERSHIP_EVIDENCE_REQUIRED/);
  await assertAbsent(target);
}));

test("interruption before commit rolls back all new tenant rows", async () => withTarget(async (target) => {
  const before = (await target.query('SELECT row_to_json(w)::text AS row FROM "Workspace" w WHERE id=$1', [otherWorkspace])).rows[0].row;
  const client: TransferSqlClient = { query: async (sql, parameters) => {
    if (sql === "COMMIT") throw new Error("SYNTHETIC_INTERRUPT_BEFORE_COMMIT");
    return target.query(sql, parameters);
  } };
  await assert.rejects(importTenantSnapshot(client, snapshot, options()), /SYNTHETIC_INTERRUPT_BEFORE_COMMIT/);
  await assertAbsent(target);
  assert.equal((await target.query('SELECT count(*)::text AS count FROM "Circle"')).rows[0].count, "1");
  assert.equal((await target.query('SELECT row_to_json(w)::text AS row FROM "Workspace" w WHERE id=$1', [otherWorkspace])).rows[0].row, before);
  assert.deepEqual((await target.query('SELECT "passwordHash","globalRole","isActive" FROM "User" JOIN "Member" ON "User".id="Member"."userId" WHERE "Member"."workspaceId"=$1', [otherWorkspace])).rows[0], { passwordHash: targetPassword, globalRole: "OPERATOR", isActive: true });
}));

test("pending and claimed source work must remain privately staged without fake cancellation", async () => withTarget(async (target) => {
  for (const [table, id, status] of [["WorkflowJob", terminalJobId, "PENDING"], ["WorkflowJob", terminalJobId, "RUNNING"], ["Event", terminalEventId, "PENDING"]]) {
    const value = changedSnapshot((copy) => setColumn(copy, table, id, "status", status));
    await assert.rejects(importTenantSnapshot(target, value, options(value)), /TRANSFER_SOURCE_WORK_NOT_DRAINED/);
    await assertAbsent(target);
    const input = options(value);
    input.transforms = { [table]: { status: { kind: "map-values", values: { [status]: table === "Event" ? "DISPATCHED" : "COMPLETED" }, reason: "Synthetic forbidden state conversion" } } };
    await assert.rejects(importTenantSnapshot(target, value, input), /TRANSFER_FIELD_TRANSFORM_FORBIDDEN/);
    await assertAbsent(target);
  }
}));

test("reviewed target fingerprint permits an operator constraint difference", async () => withTarget(async (target) => {
  await target.query(`ALTER TABLE "WorkspaceFeatureFlag" ADD CONSTRAINT synthetic_operator_marker CHECK (flag <> '')`);
  await assert.rejects(importTenantSnapshot(target, snapshot, options()), /TRANSFER_TARGET_SCHEMA_MISMATCH/);
  await assertAbsent(target);
  const inventory = await inventorySharedTenantSource(target);
  await importTenantSnapshot(target, snapshot, { ...options(), targetSchemaSha256: inventory.schemaSha256 });
  assert.equal((await readMarker(target)).enabled, true);
}));

test("reviewed target fingerprint cannot permit a changed copied column", async () => withTarget(async (target) => {
  await target.query('ALTER TABLE "Circle" ALTER COLUMN name TYPE varchar(255)');
  const inventory = await inventorySharedTenantSource(target);
  await assert.rejects(importTenantSnapshot(target, snapshot, { ...options(), targetSchemaSha256: inventory.schemaSha256 }), /TRANSFER_CATALOG_METADATA_MISMATCH/);
  await assertAbsent(target);
}));

test("an old session cannot be published with imported identities", async () => withTarget(async (target) => {
  const sessionId = randomUUID();
  await source.query(`INSERT INTO "Session" (id,"userId","tokenHash","expiresAt") VALUES ($1,$2,$1,now()+interval '1 day')`, [sessionId, newUser]);
  try {
    const inventory = await inventorySharedTenantSource(source);
    const columns = inventory.schema.columns.filter((column: { table: string }) => column.table === "Session")
      .map((column: { name: string; type: string; notNull: boolean }) => ({ name: column.name, type: column.type, nullable: !column.notNull }));
    const projection = columns.map((column: { name: string }) => `"${column.name.replaceAll('"', '""')}"::text`).join(",");
    const rows = (await source.query(`SELECT json_build_array(${projection})::text AS row FROM "Session" WHERE id=$1`, [sessionId])).rows.map((entry) => JSON.parse(entry.row));
    const value = changedSnapshot((copy) => {
      copy.manifest.tables.Session = { disposition: "copy", reason: "Synthetic forbidden credential import", fields: { tokenHash: { kind: "secret", reason: "Source session capability cannot transfer" } } };
      copy.tables.push({ name: "Session", columns, primaryKey: ["id"], foreignKeys: [{ columns: ["userId"], referencedTable: "User", referencedColumns: ["id"] }], rows, sha256: hashFrames(rows) });
      copy.dispositions.push({ table: "Session", sourceRows: "1", selectedRows: "1", disposition: "copy", reason: "Synthetic forbidden credential import" });
    });
    await assert.rejects(importTenantSnapshot(target, value, options(value)), /TRANSFER_OLD_CREDENTIALS_MUST_BE_STAGED/);
    await assertAbsent(target);
    assert.equal((await target.query('SELECT count(*) FROM "Session"')).rows[0].count, "0");
  } finally {
    await source.query('DELETE FROM "Session" WHERE id=$1', [sessionId]);
  }
}));

test("lost response after commit retries by verification without duplicate imports", async () => withTarget(async (target) => {
  const client: TransferSqlClient = { query: async (sql, parameters) => {
    const result = await target.query(sql, parameters);
    if (sql === "COMMIT") throw new Error("SYNTHETIC_RESPONSE_LOST_AFTER_COMMIT");
    return result;
  } };
  await assert.rejects(importTenantSnapshot(client, snapshot, options()), /SYNTHETIC_RESPONSE_LOST_AFTER_COMMIT/);
  assert.equal((await importTenantSnapshot(target, snapshot, options())).alreadyImported, true);
  assert.equal((await target.query('SELECT count(*)::text AS count FROM "Member" WHERE "workspaceId"=$1', [workspaceId])).rows[0].count, "2");
  assert.equal((await target.query('SELECT count(*)::text AS count FROM "User"')).rows[0].count, "2");
}));

test("changed snapshot or object receipt cannot reuse a committed transfer", async () => withTarget(async (target) => {
  await importTenantSnapshot(target, snapshot, options());
  const changed = changedSnapshot((value) => setColumn(value, "Workspace", workspaceId, "name", "Different import"));
  await assert.rejects(importTenantSnapshot(target, changed, options(changed)), /TRANSFER_WORKSPACE_COLLISION/);
  const altered = options(); const { sha256: _sha256, ...body } = altered.objectReceipt;
  altered.objectReceipt = { ...body, sourceStoreId: "different-source", sha256: hashCanonical({ ...body, sourceStoreId: "different-source" }) };
  await assert.rejects(importTenantSnapshot(target, snapshot, altered), /TRANSFER_WORKSPACE_COLLISION/);
  const tampered = structuredClone(snapshot); setColumn(tampered, "Workspace", workspaceId, "name", "Unhashed edit");
  await assert.rejects(importTenantSnapshot(target, tampered, options()), /TRANSFER_SNAPSHOT_DIGEST_MISMATCH/);
}));

test("modified target receipt is rejected on retry", async () => withTarget(async (target) => {
  await importTenantSnapshot(target, snapshot, options());
  await target.query(`UPDATE "WorkspaceFeatureFlag" SET config=jsonb_set(config,'{transferReceipt,tables,0,sha256}',to_jsonb($2::text)) WHERE "workspaceId"=$1 AND flag='operator_import_inactive'`, [workspaceId, "0".repeat(64)]);
  await assert.rejects(importTenantSnapshot(target, snapshot, options()), /TRANSFER_IMPORTED_DIGEST_MISMATCH/);
}));

test("global row id collisions fail without changing the existing row", async () => withTarget(async (target) => {
  await target.query('INSERT INTO "User" (id,email,"passwordHash","updatedAt") VALUES ($1,\'unrelated@example.invalid\',\'unrelated-password\',now())', [newUser]);
  await assert.rejects(importTenantSnapshot(target, snapshot, options()), /TRANSFER_ROW_ID_COLLISION/);
  assert.equal((await target.query('SELECT 1 FROM "Workspace" WHERE id=$1', [workspaceId])).rowCount, 0);
  assert.equal((await target.query('SELECT "passwordHash" FROM "User" WHERE id=$1', [newUser])).rows[0].passwordHash, "unrelated-password");
}));

test("bad closure cannot borrow a reference from another target tenant", async () => withTarget(async (target) => {
  const bad = changedSnapshot((value) => setColumn(value, "Circle", childCircle, "parentCircleId", otherCircle));
  await assert.rejects(importTenantSnapshot(target, bad, options(bad)), /TRANSFER_RELATIONAL_CLOSURE_UNRESOLVED/);
  await assertAbsent(target);
}));

test("object fields require a matching verified receipt binding and applied value mapping", async () => withTarget(async (target) => {
  const value = changedSnapshot((copy) => {
    setColumn(copy, "Workspace", workspaceId, "description", "source/synthetic.bin");
    copy.manifest.tables.Workspace.fields = { ...copy.manifest.tables.Workspace.fields,
      description: { kind: "object", reason: "Synthetic object binding fixture" } };
  });
  const input = options(value);
  input.objectReceipt = objectReceipt(value, [{ sourceKey: "source/synthetic.bin", targetKey: "target/synthetic.bin", sha256: "b".repeat(64), bytes: 3, ownership: "created", etag: "synthetic-etag" }]);
  await assert.rejects(importTenantSnapshot(target, value, input), /TRANSFER_OBJECT_REFERENCE_UNVERIFIED/); await assertAbsent(target);
  input.objectBindings = [{ table: "Workspace", column: "description", sourceValue: "source/synthetic.bin", targetValue: "target/synthetic.bin",
    sourceKey: "source/synthetic.bin", targetKey: "target/synthetic.bin", sha256: "b".repeat(64) }];
  await assert.rejects(importTenantSnapshot(target, value, input), /TRANSFER_OBJECT_MAPPING_MISMATCH/); await assertAbsent(target);
  input.transforms = { Workspace: { description: { kind: "map-values", values: { "source/synthetic.bin": "target/synthetic.bin" }, reason: "Verified synthetic object relocation" } } };
  await importTenantSnapshot(target, value, input);
  assert.equal((await target.query('SELECT description FROM "Workspace" WHERE id=$1', [workspaceId])).rows[0].description, "target/synthetic.bin");
}));

test("secret disposition reencrypts with the target key and retries without replacing ciphertext", async () => withTarget(async (target) => {
  const sourceKey = "a1".repeat(32); const targetKey = "b2".repeat(32);
  const iv = Buffer.alloc(12, 7); const cipher = createCipheriv("aes-256-gcm", Buffer.from(sourceKey, "hex"), iv);
  const bytes = Buffer.concat([cipher.update("synthetic-connector-secret"), cipher.final()]);
  const encrypted = ["aes-256-gcm", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), bytes.toString("base64url")].join(":");
  const value = changedSnapshot((copy) => {
    setColumn(copy, "Workspace", workspaceId, "description", encrypted);
    copy.manifest.tables.Workspace.fields = { ...copy.manifest.tables.Workspace.fields,
      description: { kind: "secret", reason: "Synthetic credential rekey fixture" } };
  });
  const input = options(value);
  await assert.rejects(importTenantSnapshot(target, value, input), /TRANSFER_SECRET_DISPOSITION_REQUIRED/);
  input.transforms = { Workspace: { description: { kind: "reencrypt", reason: "Keep existing target encryption key" } } };
  input.sourceEncryptionKey = sourceKey; input.targetEncryptionKey = targetKey;
  await importTenantSnapshot(target, value, input);
  const saved = (await target.query('SELECT description FROM "Workspace" WHERE id=$1', [workspaceId])).rows[0].description;
  assert.notEqual(saved, encrypted);
  const [, nextIv, tag, ciphertext] = saved.split(":");
  const decipher = createDecipheriv("aes-256-gcm", Buffer.from(targetKey, "hex"), Buffer.from(nextIv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  assert.equal(Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString(), "synthetic-connector-secret");
  assert.equal((await importTenantSnapshot(target, value, input)).alreadyImported, true);
  assert.equal((await target.query('SELECT description FROM "Workspace" WHERE id=$1', [workspaceId])).rows[0].description, saved);
}));

test("explicit JSON identity paths preserve adjacent large numeric values", async () => withTarget(async (target) => {
  const value = changedSnapshot((copy) => setColumn(copy, "KnowledgeChunk", knowledgeId, "metadata", `{"actor":"${linkedSourceUser}","integer":9007199254740993}`));
  const input = options(value);
  input.transforms = { KnowledgeChunk: { metadata: { kind: "json-user-references", paths: [["actor"]], reason: "Reviewed embedded actor reference" } } };
  await importTenantSnapshot(target, value, input);
  const row = (await target.query('SELECT metadata->>\'actor\' AS actor, metadata->>\'integer\' AS integer FROM "KnowledgeChunk" WHERE id=$1', [knowledgeId])).rows[0];
  assert.equal(row.actor, targetLinkedUser); assert.equal(row.integer, "9007199254740993");
}));

test("JSON replacement canonicalizes through PostgreSQL without rounding", async () => withTarget(async (target) => {
  const metadata = snapshot.tables.find((table) => table.name === "KnowledgeChunk")!;
  const original = metadata.rows[0][metadata.columns.findIndex((column) => column.name === "metadata")]!;
  const input = options();
  input.transforms = { KnowledgeChunk: { metadata: { kind: "map-values", values: { [original]: '{"replacement":9007199254740993}' }, reason: "Explicit reviewed metadata replacement" } } };
  await importTenantSnapshot(target, snapshot, input);
  assert.equal((await target.query('SELECT metadata->>\'replacement\' AS value FROM "KnowledgeChunk" WHERE id=$1', [knowledgeId])).rows[0].value, "9007199254740993");
}));

test("rehashed snapshots cannot omit or misclassify a known credential before opening a transaction", async () => withTarget(async (target) => {
  const id = randomUUID();
  await source.query(`INSERT INTO "CommunicationInstallation"(id,"workspaceId",provider,"externalWorkspaceId","botTokenEnc",status,"updatedAt") VALUES($1,$2,'SLACK','synthetic-provider','synthetic-source-credential','DISCONNECTED',now())`, [id, workspaceId]);
  let value: TenantTransferSnapshot;
  try {
    const manifest = structuredClone(snapshot.manifest);
    manifest.tables.CommunicationInstallation = { disposition: "copy", reason: "Synthetic disabled historical installation", fields: {
      externalWorkspaceId: { kind: "reference", reason: "Provider identity preserved as explicit opaque reference" },
      botTokenEnc: { kind: "secret", reason: "Source credential must be removed before publication" },
      scopes: { kind: "content", reason: "Original scopes" }, optionalScopes: { kind: "content", reason: "Original optional scopes" },
    } };
    value = await exportTenantSnapshot(source, manifest);
  } finally { await source.query('DELETE FROM "CommunicationInstallation" WHERE id=$1', [id]); }
  for (const kind of [undefined, "content"] as const) {
    const bad = structuredClone(value);
    if (kind) bad.manifest.tables.CommunicationInstallation.fields!.botTokenEnc.kind = kind;
    else delete bad.manifest.tables.CommunicationInstallation.fields!.botTokenEnc;
    bad.manifestSha256 = hashCanonical(bad.manifest); const { sha256: _digest, ...body } = bad; bad.sha256 = hashCanonical(body);
    let queries = 0;
    await assert.rejects(importTenantSnapshot({ query: async (sql, parameters) => { queries++; return target.query(sql, parameters); } }, bad, options(bad)), /TRANSFER_SCALAR_FIELD_POLICY_REQUIRED:CommunicationInstallation.botTokenEnc:secret/);
    assert.equal(queries, 0); await assertAbsent(target);
  }
  await assert.rejects(importTenantSnapshot(target, value, options(value)), /TRANSFER_SECRET_DISPOSITION_REQUIRED/); await assertAbsent(target);
  const input = options(value); input.transforms = { CommunicationInstallation: { botTokenEnc: { kind: "null", reason: "Remove source installation credential" } } };
  await importTenantSnapshot(target, value, input);
  assert.equal((await target.query('SELECT "botTokenEnc" FROM "CommunicationInstallation" WHERE id=$1', [id])).rows[0].botTokenEnc, null);
}));

test("exact reviewed inline locator exception leaves every other real object subject to receipt verification", async () => withTarget(async (target) => {
  const inline = randomUUID(), blob = randomUUID();
  const inlineLocator = "synthetic/retained-inline.txt", blobLocator = "synthetic/real-blob.bin";
  await source.query(`INSERT INTO "Document"(id,"workspaceId",title,source,"storageKey","textContent","updatedAt") VALUES($1,$3,'Inline','synthetic',$4,'Complete retained inline content',now()),($2,$3,'Blob','synthetic',$5,NULL,now())`, [inline, blob, workspaceId, inlineLocator, blobLocator]);
  let value: TenantTransferSnapshot;
  try {
    const manifest = structuredClone(snapshot.manifest);
    manifest.tables.Document = { disposition: "copy", reason: "Reviewed historical mixed source locators", fields: {
      storageKey: { kind: "object", reason: "Each locator requires a verified object or exact absence/inline evidence", retainedInlineValues: [{ valueSha256: createHash("sha256").update(inlineLocator).digest("hex"), evidenceSha256: "a".repeat(64), reason: "Synthetic source object absence and complete retained text verified" }] },
    } };
    value = await exportTenantSnapshot(source, manifest);
  } finally { await source.query('DELETE FROM "Document" WHERE id=ANY($1::text[])', [[inline, blob]]); }
  const input = options(value);
  await assert.rejects(importTenantSnapshot(target, value, input), /TRANSFER_OBJECT_REFERENCE_UNVERIFIED/); await assertAbsent(target);
  const misclassified = structuredClone(value); misclassified.manifest.tables.Document.fields!.storageKey = { kind: "content", reason: "Mixed column content cannot exempt blob rows" };
  misclassified.manifestSha256 = hashCanonical(misclassified.manifest); const { sha256: _hash, ...badBody } = misclassified; misclassified.sha256 = hashCanonical(badBody);
  await assert.rejects(importTenantSnapshot(target, misclassified, options(misclassified)), /TRANSFER_SCALAR_FIELD_POLICY_REQUIRED:Document.storageKey:object/);
  const emptyInline = structuredClone(value); setColumn(emptyInline, "Document", inline, "textContent", null);
  for (const table of emptyInline.tables) table.sha256 = hashFrames(table.rows);
  const { sha256: _old, ...emptyBody } = emptyInline; emptyInline.sha256 = hashCanonical(emptyBody);
  await assert.rejects(importTenantSnapshot(target, emptyInline, options(emptyInline)), /TRANSFER_INLINE_CONTENT_REQUIRED/);
  input.objectReceipt = objectReceipt(value, [{ sourceKey: blobLocator, targetKey: "target/real-blob.bin", sha256: "b".repeat(64), bytes: 3, ownership: "created", etag: "synthetic-etag" }]);
  input.objectBindings = [{ table: "Document", column: "storageKey", sourceValue: blobLocator, targetValue: "target/real-blob.bin", sourceKey: blobLocator, targetKey: "target/real-blob.bin", sha256: "b".repeat(64) }];
  input.transforms = { Document: { storageKey: { kind: "map-values", values: { [inlineLocator]: inlineLocator, [blobLocator]: "target/real-blob.bin" }, reason: "Exact verified object mapping, retained inline locator unchanged" } } };
  const alteredInline = structuredClone(input);
  (alteredInline.transforms!.Document.storageKey as { values: Record<string, string> }).values[inlineLocator] = "unverified/other-location";
  await assert.rejects(importTenantSnapshot(target, value, alteredInline), /TRANSFER_INLINE_LOCATOR_MUST_REMAIN/); await assertAbsent(target);
  const removedContent = structuredClone(input);
  removedContent.transforms!.Document.textContent = { kind: "null", reason: "Cannot remove content that justifies the inline exception" };
  await assert.rejects(importTenantSnapshot(target, value, removedContent), /TRANSFER_INLINE_CONTENT_MUST_REMAIN/); await assertAbsent(target);
  const replacedContent = structuredClone(input);
  replacedContent.transforms!.Document.textContent = { kind: "map-values", values: { "Complete retained inline content": "Different nonempty text has no matching original evidence" }, reason: "Original inline evidence cannot authorize a replacement" };
  await assert.rejects(importTenantSnapshot(target, value, replacedContent), /TRANSFER_INLINE_CONTENT_MUST_REMAIN/); await assertAbsent(target);
  await importTenantSnapshot(target, value, input);
  assert.equal((await target.query('SELECT "storageKey" FROM "Document" WHERE id=$1', [inline])).rows[0].storageKey, inlineLocator);
  assert.equal((await target.query('SELECT "storageKey" FROM "Document" WHERE id=$1', [blob])).rows[0].storageKey, "target/real-blob.bin");
}));

test("source reserved marker is rejected before BEGIN rather than colliding late or being discarded", async () => withTarget(async (target) => {
  const value = changedSnapshot((copy) => {
    const flags = copy.tables.find((table) => table.name === "WorkspaceFeatureFlag")!;
    flags.rows[0][flags.columns.findIndex((column) => column.name === "flag")] = "operator_import_inactive";
  });
  let queries = 0;
  await assert.rejects(importTenantSnapshot({ query: async (sql, parameters) => { queries++; return target.query(sql, parameters); } }, value, options(value)), /TRANSFER_SOURCE_IMPORT_MARKER_MUST_BE_STAGED/);
  assert.equal(queries, 0); await assertAbsent(target);
}));

test("explicit tracking token disable preserves link identities and click history without retaining source capability", async () => withTarget(async (target) => {
  const first = randomUUID(), second = randomUUID();
  await source.query(`INSERT INTO "NewspaperTrackedLink"(id,"workspaceId","runKey","targetUrl","targetUrlHash","tokenHash","clickCount","firstClickedAt","lastClickedAt","updatedAt")
    VALUES($1,$3,'synthetic-run','https://example.invalid/first','first',$4,7,'2026-09-01','2026-09-02',now()),
          ($2,$3,'synthetic-run','https://example.invalid/second','second',$5,3,'2026-09-03','2026-09-04',now())`, [first, second, workspaceId, "a".repeat(64), "b".repeat(64)]);
  let value: TenantTransferSnapshot;
  try {
    const manifest = structuredClone(snapshot.manifest);
    manifest.tables.NewspaperTrackedLink = { disposition: "copy", reason: "Preserve click history with source token capability disabled", fields: { tokenHash: { kind: "secret", reason: "Old tracking capability must not work on target" } } };
    value = await exportTenantSnapshot(source, manifest);
  } finally { await source.query('DELETE FROM "NewspaperTrackedLink" WHERE id=ANY($1::text[])', [[first, second]]); }
  const input = options(value);
  await assert.rejects(importTenantSnapshot(target, value, input), /TRANSFER_SECRET_DISPOSITION_REQUIRED/); await assertAbsent(target);
  const wrong = options(value); wrong.transforms = { NewspaperTrackedLink: { tokenHash: { kind: "disable-tracking-token", reason: "Disable source tracking capability" } }, Workspace: { name: { kind: "disable-tracking-token", reason: "This transform cannot affect arbitrary fields" } } };
  await assert.rejects(importTenantSnapshot(target, value, wrong), /TRANSFER_TRACKING_TOKEN_TRANSFORM_FORBIDDEN/); await assertAbsent(target);
  input.transforms = { NewspaperTrackedLink: { tokenHash: { kind: "disable-tracking-token", reason: "Keep click history while making old lookup hashes unreachable" } } };
  await importTenantSnapshot(target, value, input);
  const rows = (await target.query('SELECT id,"tokenHash","clickCount","firstClickedAt"::text,"lastClickedAt"::text FROM "NewspaperTrackedLink" ORDER BY "clickCount" DESC')).rows;
  assert.deepEqual(rows.map((row) => row.id), [first, second]);
  assert.deepEqual(rows.map((row) => row.clickCount), [7, 3]);
  assert.equal(new Set(rows.map((row) => row.tokenHash)).size, 2);
  for (const row of rows) {
    assert.equal(row.tokenHash, `disabled:operator-import:${value.manifest.transferId}:${row.id}`);
    assert.equal(/^[a-f0-9]{64}$/.test(row.tokenHash), false);
  }
  assert.equal((await target.query('SELECT count(*) FROM "NewspaperTrackedLink" WHERE "tokenHash"=ANY($1::text[])', [["a".repeat(64), "b".repeat(64)]])).rows[0].count, "0");
  const original = value.tables.find((table) => table.name === "NewspaperTrackedLink")!;
  for (const row of rows) for (const field of ["firstClickedAt", "lastClickedAt"]) {
    const sourceRow = original.rows.find((candidate) => candidate[original.columns.findIndex((column) => column.name === "id")] === row.id)!;
    assert.equal(row[field], sourceRow[original.columns.findIndex((column) => column.name === field)]);
  }
}));

test("demo qualification bearer token requires explicit secret classification and null removal", async () => withTarget(async (target) => {
  const id = randomUUID();
  await source.query('INSERT INTO "DemoLead"(id,"workspaceId",email,"qualifyToken","visitCount") VALUES($1,$2,\'synthetic-lead@example.invalid\',\'synthetic-bearer-token\',9)', [id, workspaceId]);
  let value: TenantTransferSnapshot;
  try {
    const manifest = structuredClone(snapshot.manifest);
    manifest.tables.DemoLead = { disposition: "copy", reason: "Preserve lead history while removing source bearer capability", fields: { qualifyToken: { kind: "secret", reason: "Public qualification capability must not transfer" } } };
    value = await exportTenantSnapshot(source, manifest);
  } finally { await source.query('DELETE FROM "DemoLead" WHERE id=$1', [id]); }
  const bad = structuredClone(value); bad.manifest.tables.DemoLead.fields!.qualifyToken.kind = "content";
  bad.manifestSha256 = hashCanonical(bad.manifest); const { sha256: _hash, ...body } = bad; bad.sha256 = hashCanonical(body);
  let queries = 0;
  await assert.rejects(importTenantSnapshot({ query: async (sql, parameters) => { queries++; return target.query(sql, parameters); } }, bad, options(bad)), /TRANSFER_SCALAR_FIELD_POLICY_REQUIRED:DemoLead.qualifyToken:secret/);
  assert.equal(queries, 0);
  await assert.rejects(importTenantSnapshot(target, value, options(value)), /TRANSFER_QUALIFICATION_TOKEN_MUST_BE_REMOVED/); await assertAbsent(target);
  const input = options(value); input.transforms = { DemoLead: { qualifyToken: { kind: "null", reason: "Disable unauthenticated source qualification lookup" } } };
  await importTenantSnapshot(target, value, input);
  assert.deepEqual((await target.query('SELECT "qualifyToken","visitCount" FROM "DemoLead" WHERE id=$1', [id])).rows[0], { qualifyToken: null, visitCount: 9 });
}));
