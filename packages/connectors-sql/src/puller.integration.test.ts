import { execFile } from "node:child_process";
import { createCipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createSqlTestFixture } from "./postgres-test-fixture";
import type { SqlTestFixture } from "./postgres-test-fixture";
import { startSqlIngestionProcess } from "./puller-process-fixture";

const execute = promisify(execFile);
const encryptionKey = randomBytes(32).toString("hex");
let fixture: SqlTestFixture;
let db: PrismaClient;
const children: ReturnType<typeof startSqlIngestionProcess>[] = [];
const workspaces: string[] = [];

beforeAll(async () => {
  fixture = await createSqlTestFixture();
  await execute(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy"], {
    env: { ...process.env, DATABASE_URL: fixture.connectionString },
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
  });
  db = new PrismaClient({ datasources: { db: { url: fixture.connectionString } } });
}, 90_000);

afterEach(async () => {
  await Promise.all(children.splice(0).map((child) => child.close()));
  if (db) await db.workspace.deleteMany({ where: { id: { in: workspaces.splice(0) } } });
});

afterAll(async () => {
  await db?.$disconnect();
  await fixture?.close();
});

function encryptedConnection() {
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(encryptionKey, "hex"), iv);
  const encrypted = Buffer.concat([cipher.update(fixture.connectionString, "utf8"), cipher.final()]);
  return [iv.toString("hex"), cipher.getAuthTag().toString("hex"), encrypted.toString("hex")].join(":");
}

async function setup() {
  const workspace = await db.workspace.create({ data: { name: "Synthetic SQL race", slug: `sql-race-${randomUUID()}` } });
  workspaces.push(workspace.id);
  const table = fixture.table(`rows_${randomBytes(6).toString("hex")}`);
  await fixture.writer.query(`CREATE TABLE ${table} (id int PRIMARY KEY, seq int NOT NULL, payload text NOT NULL)`);
  await fixture.writer.query(`INSERT INTO ${table} VALUES (1, 1, 'first committed payload')`);
  const source = await db.externalDataSource.create({ data: {
    workspaceId: workspace.id, label: "Synthetic native SQL", connectionStringEnc: encryptedConnection(),
    selectedTables: [table], cursorColumn: "seq",
  } });
  return { source, table };
}

async function child() {
  const process = startSqlIngestionProcess({
    DATABASE_URL: fixture.connectionString,
    ENCRYPTION_KEY: encryptionKey,
    MODEL_PROVIDER: "fake",
    SHARED_STATE_BACKEND: "postgres",
    KNOWLEDGE_SEARCH_PROVIDER: "postgres",
    REDIS_KEY_PREFIX: "sql-race",
    NODE_ENV: "test",
  });
  children.push(process);
  await process.ready();
  return process;
}

async function cacheVersion(workspaceId: string) {
  const id = createHash("sha256").update(JSON.stringify(["sql-race", "cache-version", `knowledge:${workspaceId}`])).digest("hex");
  return (await db.sharedCacheVersion.findUnique({ where: { id } }))?.version ?? 0;
}

describe("native SQL publication across independent processes", () => {
  it("commits native rows, cursor, log and cache together", async () => {
    const { source } = await setup();
    const worker = await child();
    await worker.run(source.id);
    await worker.prepared();
    expect(await db.knowledgeChunk.count({ where: { workspaceId: source.workspaceId } })).toBe(0);
    expect((await db.externalDataSource.findUniqueOrThrow({ where: { id: source.id } })).lastCursorValue).toBeNull();
    expect(await cacheVersion(source.workspaceId)).toBe(0);
    await worker.release();
    await worker.complete();
    const chunks = await db.knowledgeChunk.findMany({ where: { workspaceId: source.workspaceId } });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toContain("first committed payload");
    const current = await db.externalDataSource.findUniqueOrThrow({ where: { id: source.id } });
    expect(current.lastCursorValue).not.toBeNull();
    expect(current.lastSyncError).toBeNull();
    expect(await cacheVersion(source.workspaceId)).toBeGreaterThan(0);
    expect(await db.externalDataSyncLog.findFirst({ where: { sourceId: source.id } })).toMatchObject({
      rowsProcessed: 1, chunksCreated: 1, error: null, completedAt: expect.any(Date),
    });
  });

  it("publishes the full bounded run when row and chunk output counts exceed ten thousand", async () => {
    const { source, table } = await setup();
    await fixture.writer.query(`DELETE FROM ${table}`);
    await fixture.writer.query(`INSERT INTO ${table} SELECT n, n, repeat('synthetic ', 180) FROM generate_series(1, 4000) AS n`);
    const worker = await child();
    await worker.run(source.id);
    await worker.prepared();
    expect(await db.knowledgeChunk.count({ where: { workspaceId: source.workspaceId } })).toBe(0);
    await worker.release();
    await worker.complete(180_000);
    const chunks = await db.knowledgeChunk.findMany({ where: { workspaceId: source.workspaceId }, select: { sourceId: true } });
    expect(new Set(chunks.map((chunk) => chunk.sourceId)).size).toBe(4000);
    expect(chunks.length).toBeGreaterThanOrEqual(8000);
    const log = await db.externalDataSyncLog.findFirstOrThrow({ where: { sourceId: source.id } });
    expect(log).toMatchObject({ rowsProcessed: 4000, chunksCreated: chunks.length, error: null, completedAt: expect.any(Date) });
    const stored = await db.externalDataSource.findUniqueOrThrow({ where: { id: source.id } });
    expect(Object.values(JSON.parse(stored.lastCursorValue!).tables)).toContainEqual(expect.objectContaining({ values: ["4000", "4000"] }));
  }, 240_000);

  it("rejects a second active owner before provider/model preparation without changing its status", async () => {
    const { source } = await setup();
    const owner = await child();
    const overlap = await child();
    await owner.run(source.id);
    await owner.prepared();
    await overlap.run(source.id, false);
    expect((await overlap.failed()).error).toMatch(/FENCE_LOST|CLAIM|ACTIVE|BUSY|attempt/i);
    expect(await db.knowledgeChunk.count({ where: { workspaceId: source.workspaceId } })).toBe(0);
    expect(await cacheVersion(source.workspaceId)).toBe(0);
    const pending = await db.externalDataSource.findUniqueOrThrow({ where: { id: source.id } });
    expect(pending.lastCursorValue).toBeNull();
    expect(pending.lastSyncError).toBeNull();
    await owner.release();
    await owner.complete();
    expect((await db.externalDataSource.findUniqueOrThrow({ where: { id: source.id } })).lastSyncError).toBeNull();
  });

  it.each(["obsolete-first", "current-first"] as const)("fences changed credentials with identical cursors when publishing %s", async (order) => {
    const { source, table } = await setup();
    const obsolete = await child();
    const current = await child();
    expect(obsolete.pid).not.toBe(current.pid);
    await obsolete.run(source.id);
    await obsolete.prepared();
    await fixture.writer.query(`UPDATE ${table} SET payload = 'new credential generation payload'`);
    await db.externalDataSource.update({ where: { id: source.id }, data: { connectionStringEnc: encryptedConnection() } });
    // Both attempts start with NULL and eventually propose the identical native
    // cursor. The credential/attempt fence, not cursor text, chooses the owner.
    expect((await db.externalDataSource.findUniqueOrThrow({ where: { id: source.id } })).lastCursorValue).toBeNull();
    await current.run(source.id);
    await current.prepared();
    if (order === "obsolete-first") {
      await obsolete.release();
      expect((await obsolete.failed()).error).toMatch(/FENCE_LOST|SCAN_CHANGED|configuration/i);
      expect(await db.knowledgeChunk.count({ where: { workspaceId: source.workspaceId } })).toBe(0);
      expect(await cacheVersion(source.workspaceId)).toBe(0);
      await current.release();
      await current.complete();
    } else {
      await current.release();
      await current.complete();
      const committedVersion = await cacheVersion(source.workspaceId);
      await obsolete.release();
      expect((await obsolete.failed()).error).toMatch(/FENCE_LOST|SCAN_CHANGED|configuration/i);
      expect(await cacheVersion(source.workspaceId)).toBe(committedVersion);
    }
    const chunks = await db.knowledgeChunk.findMany({ where: { workspaceId: source.workspaceId } });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toContain("new credential generation payload");
    const stored = await db.externalDataSource.findUniqueOrThrow({ where: { id: source.id } });
    expect(stored.lastCursorValue).not.toBeNull();
    expect(stored.lastSyncError).toBeNull();
    const logs = await db.externalDataSyncLog.findMany({ where: { sourceId: source.id } });
    expect(logs.filter((log) => log.error === null && log.completedAt !== null)).toHaveLength(1);
    expect(logs.filter((log) => log.error !== null && log.completedAt !== null)).toHaveLength(1);
  });

  it("keeps a same-id source recreation fenced after its previous log is cascade-deleted", async () => {
    const { source, table } = await setup();
    const obsolete = await child();
    const current = await child();
    await obsolete.run(source.id);
    await obsolete.prepared();
    await db.externalDataSource.delete({ where: { id: source.id } });
    await db.externalDataSource.create({ data: {
      id: source.id, workspaceId: source.workspaceId, label: source.label,
      connectionStringEnc: source.connectionStringEnc, selectedTables: source.selectedTables,
      cursorColumn: source.cursorColumn,
    } });
    await fixture.writer.query(`UPDATE ${table} SET payload = 'recreated source payload'`);
    await current.run(source.id);
    await current.prepared();
    await current.release();
    await current.complete();
    const version = await cacheVersion(source.workspaceId);
    await obsolete.release();
    expect((await obsolete.failed()).error).toMatch(/FENCE_LOST|source|attempt/i);
    const chunks = await db.knowledgeChunk.findMany({ where: { workspaceId: source.workspaceId } });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toContain("recreated source payload");
    expect(await cacheVersion(source.workspaceId)).toBe(version);
    expect((await db.externalDataSource.findUniqueOrThrow({ where: { id: source.id } })).lastSyncError).toBeNull();
  });

  it.each(["checkpoint", "completion-log"] as const)("rolls back chunks and cache when the %s callback fails", async (failure) => {
    const { source } = await setup();
    const worker = await child();
    const trigger = `reject_${randomBytes(6).toString("hex")}`;
    const functionName = fixture.table(trigger);
    const target = failure === "checkpoint" ? "ExternalDataSource" : "ExternalDataSyncLog";
    const condition = failure === "checkpoint" ? `NEW.id = '${source.id}'`
      : `NEW."sourceId" = '${source.id}' AND NEW."rowsProcessed" > 0 AND NEW.error IS NULL`;
    const columns = failure === "checkpoint" ? '"lastCursorValue"' : '"completedAt"';
    await fixture.writer.query(`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF ${condition} THEN RAISE EXCEPTION 'synthetic publication callback failure'; END IF; RETURN NEW; END $$`);
    await fixture.writer.query(`CREATE TRIGGER "${trigger}" BEFORE UPDATE OF ${columns} ON "${target}" FOR EACH ROW EXECUTE FUNCTION ${functionName}()`);
    try {
      await worker.run(source.id);
      await worker.prepared();
      await worker.release();
      expect((await worker.failed()).error).toContain("synthetic publication callback failure");
      expect(await db.knowledgeChunk.count({ where: { workspaceId: source.workspaceId } })).toBe(0);
      expect(await cacheVersion(source.workspaceId)).toBe(0);
      expect((await db.externalDataSource.findUniqueOrThrow({ where: { id: source.id } })).lastCursorValue).toBeNull();
      expect(await db.externalDataSyncLog.findFirst({ where: { sourceId: source.id } })).toMatchObject({
        rowsProcessed: 0, chunksCreated: 0, error: expect.any(String), completedAt: expect.any(Date),
      });
    } finally {
      await fixture.writer.query(`DROP TRIGGER "${trigger}" ON "${target}"`);
      await fixture.writer.query(`DROP FUNCTION ${functionName}()`);
    }
  });
});
