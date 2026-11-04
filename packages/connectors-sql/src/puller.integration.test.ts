import { execFile } from "node:child_process";
import { createCipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { PrismaClient, type Prisma } from "@prisma/client";
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
const users: string[] = [];

beforeAll(async () => {
  fixture = await createSqlTestFixture();
  await execute(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy"], {
    env: { ...process.env, DATABASE_URL: fixture.connectionString },
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
  });
  db = new PrismaClient<Prisma.PrismaClientOptions>({ datasources: { db: { url: fixture.connectionString } } });
}, 90_000);

afterEach(async () => {
  await Promise.all(children.splice(0).map((child) => child.close()));
  if (db) {
    await db.workflowJob.deleteMany({ where: { workspaceId: { in: workspaces } } });
    await db.workspace.deleteMany({ where: { id: { in: workspaces.splice(0) } } });
    await db.user.deleteMany({ where: { id: { in: users.splice(0) } } });
  }
});

afterAll(async () => {
  await db?.$disconnect();
  await fixture?.close();
});

function encryptedConnection(connectionString = fixture.connectionString) {
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(encryptionKey, "hex"), iv);
  const encrypted = Buffer.concat([cipher.update(connectionString, "utf8"), cipher.final()]);
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

async function child(mode: "ingestion" | "web-reader" | "mcp-reader" | "outbox" = "ingestion", budgeted = false, claimBarrier = false) {
  const process = startSqlIngestionProcess({
    DATABASE_URL: fixture.connectionString,
    ENCRYPTION_KEY: encryptionKey,
    MODEL_PROVIDER: "fake",
    SHARED_STATE_BACKEND: "postgres",
    KNOWLEDGE_SEARCH_PROVIDER: "postgres",
    REDIS_KEY_PREFIX: "sql-race",
    NODE_ENV: "test",
    ...(claimBarrier ? { SQL_TEST_CLAIM_BARRIER: "1" } : {}),
    ...(budgeted ? { SQL_TEST_HEAP_MB: "512", SQL_TEST_RSS_LIMIT_BYTES: String(1024 ** 3) } : {}),
  }, mode);
  children.push(process);
  await process.ready();
  return process;
}

async function cacheVersion(workspaceId: string) {
  const id = createHash("sha256").update(JSON.stringify(["sql-race", "cache-version", `knowledge:${workspaceId}`])).digest("hex");
  return (await db.sharedCacheVersion.findUnique({ where: { id } }))?.version ?? 0;
}

async function expireLease(sourceId: string) {
  const expired = new Date(Date.now() - 1000);
  await db.$transaction([
    db.sqlIngestionSourceClaim.updateMany({ where: { sourceId, status: "RUNNING" }, data: { leaseExpiresAt: expired } }),
    db.sqlIngestionAttempt.updateMany({ where: { sourceId, status: "RUNNING" }, data: { leaseExpiresAt: expired } }),
  ]);
}

describe("native SQL publication across independent processes", () => {
  it("commits native rows, cursor, log and cache together", async () => {
    const { source } = await setup();
    const user = await db.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: "synthetic", displayName: "Reader" } });
    users.push(user.id);
    await db.member.create({ data: { workspaceId: source.workspaceId, userId: user.id, role: "ADMIN" } });
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
    expect((await worker.read(source.workspaceId, user.id, chunks[0].id)).read).toEqual({
      fetched: true, count: 1, searchIds: [chunks[0].id], downstreamReadable: true,
    });
    const coldReader = await child("web-reader");
    expect((await coldReader.read(source.workspaceId, user.id, chunks[0].id)).read).toEqual({
      fetched: true, count: 1, searchIds: [chunks[0].id], downstreamReadable: true,
    });
    const mcpReader = await child("mcp-reader");
    expect((await mcpReader.read(source.workspaceId, user.id, chunks[0].id)).read).toEqual({
      fetched: true, count: 1, searchIds: [chunks[0].id], downstreamReadable: true,
    });
    expect(await db.sqlIngestionAttempt.count({ where: { sourceId: source.id } })).toBe(1);
  });

  it("publishes and serves the full bounded run when combined row and chunk counts exceed ten thousand", async () => {
    const { source, table } = await setup();
    await fixture.writer.query(`DELETE FROM ${table}`);
    await fixture.writer.query(`INSERT INTO ${table} SELECT n, n, repeat('synthetic ', 180) FROM generate_series(1, 4000) AS n`);
    const second = await setup();
    const createdAt = new Date(Date.now() - 60_000);
    const firstJob = await db.workflowJob.create({ data: { workspaceId: source.workspaceId, type: "data-source.sync", runAfter: new Date(Date.now() - 86_400_000),
      payload: { sourceId: source.id }, createdAt } });
    const waitingSql = await db.workflowJob.create({ data: { workspaceId: second.source.workspaceId, type: "data-source.sync", runAfter: new Date(Date.now() - 86_400_000),
      payload: { sourceId: second.source.id }, createdAt: new Date(createdAt.getTime() + 1) } });
    const waitingNormal = await db.workflowJob.create({ data: { workspaceId: source.workspaceId, type: "synthetic.noop", runAfter: new Date(Date.now() - 86_400_000),
      payload: {}, createdAt: new Date(createdAt.getTime() + 2) } });
    const worker = await child("outbox", true);
    const capacityUser = await db.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: "synthetic", displayName: "Capacity reader" } });
    users.push(capacityUser.id);
    await db.member.create({ data: { workspaceId: source.workspaceId, userId: capacityUser.id, role: "ADMIN" } });
    const observer = new pg.Client({ connectionString: fixture.connectionString });
    await observer.connect();
    const hasStatistics = (await observer.query("SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements'")).rowCount === 1;
    const queryCount = async () => hasStatistics ? (await observer.query("SELECT coalesce(sum(calls),0)::float8 AS all, coalesce(sum(calls) FILTER (WHERE toplevel),0)::float8 AS top FROM pg_stat_statements WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())")).rows[0] as { all: number; top: number } : null;
    const beforeQueries = await queryCount();
    let stopped = false, longestChunkTransactionMs = 0, observationQueries = 0;
    const observation = (async () => {
      while (!stopped) {
        const result = await observer.query(`SELECT max(extract(epoch from (clock_timestamp()-a.xact_start))*1000) AS age
          FROM pg_stat_activity a WHERE a.datname=current_database() AND a.pid<>pg_backend_pid()
          AND EXISTS (SELECT 1 FROM pg_locks l WHERE l.pid=a.pid AND l.relation='"KnowledgeChunk"'::regclass AND l.mode='RowExclusiveLock' AND l.granted)`);
        observationQueries++;
        longestChunkTransactionMs = Math.max(longestChunkTransactionMs, Number(result.rows[0].age ?? 0));
        await delay(50);
      }
    })();
    let completed, afterQueries: { all: number; top: number } | null = null;
    try {
      await worker.run(source.id);
      await worker.prepared();
      expect(await db.knowledgeChunk.count({ where: { workspaceId: source.workspaceId } })).toBe(0);
      expect(await db.workflowJob.findMany({ where: { id: { in: [waitingSql.id, waitingNormal.id] } } }))
        .toEqual(expect.arrayContaining([expect.objectContaining({ id: waitingSql.id, status: "PENDING", attempts: 0, lockedAt: null }),
          expect.objectContaining({ id: waitingNormal.id, status: "PENDING", attempts: 0, lockedAt: null })]));
      await worker.release();
      completed = await worker.complete(180_000);
    } finally {
      stopped = true;
      try { await observation; afterQueries = await queryCount(); } finally { await observer.end(); }
    }
    expect(await db.workflowJob.findUniqueOrThrow({ where: { id: firstJob.id } })).toMatchObject({ status: "COMPLETED", attempts: 1 });
    expect(await db.workflowJob.findMany({ where: { id: { in: [waitingSql.id, waitingNormal.id] } } }))
      .toEqual(expect.arrayContaining([expect.objectContaining({ id: waitingSql.id, status: "PENDING", attempts: 0 }),
        expect.objectContaining({ id: waitingNormal.id, status: "PENDING", attempts: 0 })]));
    const metrics = { ...completed.metrics, longestChunkTransactionMs,
      databaseQueries: afterQueries && beforeQueries ? {
        topLevel: afterQueries.top - beforeQueries.top - observationQueries - 1,
        includingTriggers: afterQueries.all - beforeQueries.all - observationQueries - 1,
        observerQueriesExcluded: observationQueries + 1,
      } : null };
    if (process.env.PUN85_METRICS_FILE) await writeFile(process.env.PUN85_METRICS_FILE, JSON.stringify(metrics, null, 2));
    expect(longestChunkTransactionMs).toBeLessThan(120_000);
    expect(completed.metrics?.osMaxRssBytes).toBeLessThan(1024 ** 3);
    const chunks = await db.knowledgeChunk.findMany({ where: { workspaceId: source.workspaceId }, select: { sourceId: true } });
    expect(new Set(chunks.map((chunk) => chunk.sourceId)).size).toBe(4000);
    expect(chunks.length).toBeGreaterThanOrEqual(8000);
    const log = await db.externalDataSyncLog.findFirstOrThrow({ where: { sourceId: source.id } });
    expect(log).toMatchObject({ rowsProcessed: 4000, chunksCreated: chunks.length, error: null, completedAt: expect.any(Date) });
    const stored = await db.externalDataSource.findUniqueOrThrow({ where: { id: source.id } });
    expect(Object.values(JSON.parse(stored.lastCursorValue!).tables)).toContainEqual(expect.objectContaining({ values: ["4000", "4000"] }));
    const first = await db.knowledgeChunk.findFirstOrThrow({ where: { workspaceId: source.workspaceId } });
    const readObserver = new pg.Client({ connectionString: fixture.connectionString });
    await readObserver.connect();
    const readQueryCount = async () => hasStatistics ? Number((await readObserver.query(
      "SELECT coalesce(sum(calls),0)::float8 AS calls FROM pg_stat_statements WHERE toplevel AND dbid = (SELECT oid FROM pg_database WHERE datname=current_database())")).rows[0].calls) : null;
    const readQueriesBefore = await readQueryCount();
    const startedRead = performance.now();
    let read;
    try { read = await worker.read(source.workspaceId, capacityUser.id, first.id); }
    finally { if (!read) await readObserver.end(); }
    const readQueriesAfter = await readQueryCount();
    await readObserver.end();
    if (process.env.PUN85_METRICS_FILE) await writeFile(process.env.PUN85_METRICS_FILE,
      JSON.stringify({ ...metrics, readDurationMs: performance.now() - startedRead,
        readTopLevelQueries: readQueriesAfter !== null && readQueriesBefore !== null ? readQueriesAfter - readQueriesBefore - 1 : null,
        read: read.read, readProcessMetrics: read.metrics }, null, 2));
    expect(read.metrics?.osMaxRssBytes).toBeLessThan(1024 ** 3);
    expect(read.read).toMatchObject({ fetched: true, count: chunks.length, downstreamReadable: true });
    expect(read.read?.searchIds.length).toBeGreaterThan(0);
  }, 240_000);

  it("serializes a concurrent source permission change behind the complete publication transaction", async () => {
    const { source } = await setup(), worker = await child();
    const key = randomBytes(4).readUInt32BE() % 2_000_000_000;
    const name = `pause_${randomBytes(6).toString("hex")}`, fn = fixture.table(name);
    const observer = new pg.Client({ connectionString: fixture.connectionString });
    const policyWriter = new pg.Client({ connectionString: fixture.connectionString });
    await Promise.all([observer.connect(), policyWriter.connect()]);
    let mutation: Promise<pg.QueryResult> | undefined;
    async function eventually(check: () => Promise<boolean>) {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) { if (await check()) return; await delay(20); }
      throw new Error("Expected concurrent PostgreSQL lock was not observed");
    }
    try {
      const lockHolderPid = Number((await fixture.writer.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
      await fixture.writer.query(`SELECT pg_advisory_lock($1)`, [key]);
      await fixture.writer.query(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW."workspaceId" = '${source.workspaceId}' THEN PERFORM pg_advisory_xact_lock(${key}); END IF; RETURN NEW; END $$`);
      await fixture.writer.query(`CREATE TRIGGER "${name}" BEFORE INSERT ON "KnowledgeChunk" FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
      await worker.run(source.id, false);
      let publisherPid = 0;
      await eventually(async () => {
        // Observe the fixture's actual lock relationship, independent of INSERT formatting.
        const result = await observer.query(`SELECT pid FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event = 'advisory'
            AND $1::int = ANY(pg_blocking_pids(pid))`, [lockHolderPid]);
        publisherPid = Number(result.rows[0]?.pid ?? 0); return publisherPid > 0;
      });
      const epoch = await db.sourcePermissionEpoch.findUniqueOrThrow({ where: { workspaceId_sourceKind_sourceId: {
        workspaceId: source.workspaceId, sourceKind: "ExternalDataSource", sourceId: source.id } } });
      mutation = policyWriter.query(`UPDATE "SourcePermissionEpoch" SET epoch=epoch+1 WHERE id=$1`, [epoch.id]);
      const policyPid = Number((policyWriter as pg.Client & { processID: number }).processID);
      await eventually(async () => (await observer.query("SELECT $1::int = ANY(pg_blocking_pids($2)) AS blocked", [publisherPid, policyPid])).rows[0].blocked);
      expect(await db.knowledgeChunk.count({ where: { workspaceId: source.workspaceId } })).toBe(0);
      await fixture.writer.query(`SELECT pg_advisory_unlock($1)`, [key]);
      await worker.complete();
      expect((await mutation).rowCount).toBe(1);
      expect(await db.knowledgeChunk.count({ where: { workspaceId: source.workspaceId } })).toBe(1);
      expect((await db.sourcePermissionEpoch.findUniqueOrThrow({ where: { id: epoch.id } })).epoch).toBe(epoch.epoch + 1n);
      expect(await db.externalDataSyncLog.findFirst({ where: { sourceId: source.id } })).toMatchObject({ chunksCreated: 1, error: null });
    } finally {
      await fixture.writer.query(`SELECT pg_advisory_unlock($1)`, [key]);
      await worker.close();
      await mutation?.catch(() => undefined);
      await fixture.writer.query(`DROP TRIGGER IF EXISTS "${name}" ON "KnowledgeChunk"`);
      await fixture.writer.query(`DROP FUNCTION IF EXISTS ${fn}()`);
      await Promise.all([observer.end(), policyWriter.end()]);
    }
  });

  it.each(["grant", "rls"] as const)("withholds stored publication after a provider %s denial at the final replay barrier, including restore", async (denial) => {
    const { source, table } = await setup();
    const role = `pun85_reader_${randomBytes(6).toString("hex")}`;
    const user = await db.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: "synthetic", displayName: "SQL reader" } });
    await db.member.create({ data: { workspaceId: source.workspaceId, userId: user.id, role: "ADMIN" } });
    await fixture.writer.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT`);
    try {
      await fixture.writer.query(`GRANT USAGE ON SCHEMA "${fixture.schema}" TO "${role}"`);
      await fixture.writer.query(`GRANT SELECT ON ${table} TO "${role}"`);
      if (denial === "rls") {
        await fixture.writer.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
        await fixture.writer.query(`CREATE POLICY readable ON ${table} FOR SELECT TO "${role}" USING (true)`);
      }
      const connection = new URL(fixture.connectionString); connection.username = role;
      await db.externalDataSource.update({ where: { id: source.id }, data: { connectionStringEnc: encryptedConnection(connection.toString()) } });
      const worker = await child(), reader = await child("web-reader");
      await worker.run(source.id, false, true);
      await worker.publicationReady();
      expect(await db.knowledgeChunk.count({ where: { workspaceId: source.workspaceId } })).toBe(0);
      if (denial === "grant") await fixture.writer.query(`REVOKE SELECT ON ${table} FROM "${role}"`);
      else await fixture.writer.query(`ALTER POLICY readable ON ${table} USING (false)`);
      await worker.releasePublication();
      await worker.complete();
      const chunks = await db.knowledgeChunk.findMany({ where: { workspaceId: source.workspaceId } });
      expect(chunks).toHaveLength(1);
      const denied = { fetched: false, count: 0, searchIds: [], downstreamReadable: false };
      expect((await reader.read(source.workspaceId, user.id, chunks[0].id)).read).toEqual(denied);
      if (denial === "grant") await fixture.writer.query(`GRANT SELECT ON ${table} TO "${role}"`);
      else await fixture.writer.query(`ALTER POLICY readable ON ${table} USING (true)`);
      expect((await reader.read(source.workspaceId, user.id, chunks[0].id)).read).toEqual(denied);
      expect(await db.knowledgeChunk.findMany({ where: { workspaceId: source.workspaceId } })).toEqual(chunks);
      expect((await db.externalDataSource.findUniqueOrThrow({ where: { id: source.id } })).lastCursorValue).not.toBeNull();
    } finally {
      await Promise.all(children.splice(0).map((worker) => worker.close()));
      await fixture.writer.query(`DROP OWNED BY "${role}"`);
      await fixture.writer.query(`DROP ROLE "${role}"`);
      await db.user.delete({ where: { id: user.id } });
    }
  }, 120_000);

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

  it.each(["obsolete-first", "current-first"] as const)("reclaims an expired identical cursor/configuration and fences status (%s)", async (order) => {
    const { source, table } = await setup();
    const obsolete = await child(), current = await child();
    await current.run(source.id, false);
    await current.complete();
    const initial = await db.externalDataSource.findUniqueOrThrow({ where: { id: source.id } });
    await fixture.writer.query(`UPDATE ${table} SET seq = 2, payload = 'obsolete capture'`);
    await obsolete.run(source.id);
    await obsolete.prepared();
    await expireLease(source.id);
    await fixture.writer.query(`UPDATE ${table} SET payload = 'current reclaimed capture'`);
    await current.run(source.id);
    await current.prepared();
    const inputs = await db.sqlNativeRunInput.findMany({ where: { sourceId: source.id }, orderBy: { generation: "desc" }, take: 2 });
    expect(inputs[0].nextCursor).toBe(inputs[1].nextCursor);
    const attempts = await db.sqlIngestionAttempt.findMany({ where: { sourceId: source.id }, orderBy: { generation: "desc" }, take: 2 });
    expect(attempts[0].expectedCursor).toBe(initial.lastCursorValue);
    expect(attempts[1].expectedCursor).toBe(initial.lastCursorValue);
    expect(attempts[0].configurationFingerprint).toBe(attempts[1].configurationFingerprint);
    if (order === "obsolete-first") {
      await obsolete.release();
      expect((await obsolete.failed()).error).toMatch(/current|fence|attempt/i);
      expect((await db.externalDataSource.findUniqueOrThrow({ where: { id: source.id } })).lastSyncError).toBeNull();
      await current.release();
      await current.complete();
    } else {
      await current.release();
      await current.complete();
      const version = await cacheVersion(source.workspaceId);
      await obsolete.release();
      expect((await obsolete.failed()).error).toMatch(/current|fence|attempt/i);
      expect(await cacheVersion(source.workspaceId)).toBe(version);
    }
    const chunks = await db.knowledgeChunk.findMany({ where: { workspaceId: source.workspaceId } });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toContain("current reclaimed capture");
    const stored = await db.externalDataSource.findUniqueOrThrow({ where: { id: source.id } });
    expect(stored.lastCursorValue).toBe(inputs[0].nextCursor);
    expect(stored.lastSyncError).toBeNull();
    expect((await db.sqlIngestionSourceClaim.findUniqueOrThrow({ where: { workspaceId_sourceId: { workspaceId: source.workspaceId, sourceId: source.id } } })).status).toBe("SUCCEEDED");
  });

  it("acknowledges a verified empty run without replacing chunks or resetting the typed cursor", async () => {
    const { source } = await setup();
    const worker = await child();
    await worker.run(source.id, false);
    await worker.complete();
    const before = await db.externalDataSource.findUniqueOrThrow({ where: { id: source.id } });
    const chunks = await db.knowledgeChunk.findMany({ where: { workspaceId: source.workspaceId } });
    await worker.run(source.id, false);
    await worker.complete();
    expect((await db.externalDataSource.findUniqueOrThrow({ where: { id: source.id } })).lastCursorValue).toBe(before.lastCursorValue);
    expect(await db.knowledgeChunk.findMany({ where: { workspaceId: source.workspaceId } })).toEqual(chunks);
    expect(await db.sqlKnowledgePublication.findFirst({ where: { sourceId: source.id, rowsProcessed: 0 } }))
      .toMatchObject({ status: "COMMITTED", chunksCreated: 0 });
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
    await expireLease(source.id);
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
    await expireLease(source.id);
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


describe("exclusive SQL outbox admission", () => {
  it.each(["complete", "renew"] as const)("rechecks a materialized SQL claim after concurrent %s", async (mutation) => {
    const { source } = await setup();
    const job = await db.workflowJob.create({ data: { workspaceId: source.workspaceId, type: "data-source.sync",
      payload: { sourceId: source.id }, status: "RUNNING", lockedBy: "prior-worker", attempts: 1,
      lockedAt: new Date(Date.now() - 86_400_000), runAfter: new Date(Date.now() - 86_400_000) } });
    const key = randomBytes(4).readUInt32BE() % 2_000_000_000;
    const name = `claim_pause_${randomBytes(6).toString("hex")}`, fn = fixture.table(name);
    const worker = await child("outbox", false, true);
    const observer = new pg.Client({ connectionString: fixture.connectionString });
    await observer.connect();
    try {
      const holderPid = Number((await fixture.writer.query("SELECT pg_backend_pid() AS pid, pg_advisory_lock($1)", [key])).rows[0].pid);
      await fixture.writer.query(`CREATE FUNCTION ${fn}() RETURNS boolean LANGUAGE plpgsql AS $$ BEGIN
        PERFORM pg_advisory_xact_lock(${key}); RETURN true; END $$`);
      await worker.run(source.id, false, false, `${fixture.schema}.${name}`);
      const deadline = Date.now() + 15_000;
      let blocked = false;
      while (Date.now() < deadline) {
        // Activity SQL is truncated (normally at 1024 bytes); identify the
        // actual unique barrier lock and its holder, never a query-text suffix.
        blocked = Number((await observer.query(`SELECT count(*) FROM pg_stat_activity a
          JOIN pg_locks l ON l.pid=a.pid
          WHERE a.datname=current_database() AND a.wait_event='advisory'
            AND l.locktype='advisory' AND l.classid=0 AND l.objid=$1 AND l.objsubid=1
            AND NOT l.granted AND $2=ANY(pg_blocking_pids(a.pid))`, [key, holderPid])).rows[0].count) > 0;
        if (blocked) break;
        await delay(20);
      }
      expect(blocked).toBe(true);
      if (mutation === "complete") {
        await db.workflowJob.update({ where: { id: job.id }, data: { status: "COMPLETED", completedAt: new Date(), lockedAt: null, lockedBy: null } });
      } else {
        // Native SQL renewal uses server instant; no fabricated future lease.
        await observer.query(`UPDATE "WorkflowJob" SET "lockedAt"=clock_timestamp() WHERE id=$1`, [job.id]);
      }
      await fixture.writer.query("SELECT pg_advisory_unlock($1)", [key]);
      await worker.complete();
      expect(await db.workflowJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({
        status: mutation === "complete" ? "COMPLETED" : "RUNNING", attempts: 1,
        lockedBy: mutation === "complete" ? null : "prior-worker" });
      expect(await db.sqlIngestionAttempt.count({ where: { sourceId: source.id } })).toBe(0);
    } finally {
      await fixture.writer.query("SELECT pg_advisory_unlock($1)", [key]);
      await worker.close();
      await fixture.writer.query(`DROP FUNCTION IF EXISTS ${fn}()`);
      await observer.end();
    }
  });

  it("does not prematurely reclaim another process SQL lease in a non-UTC database", async () => {
    const first = await setup(), second = await setup();
    const born = Date.now() - 60_000;
    const jobs = [];
    for (const [index, source] of [first.source, second.source].entries()) {
      jobs.push(await db.workflowJob.create({ data: { workspaceId: source.workspaceId, type: "data-source.sync",
        payload: { sourceId: source.id }, createdAt: new Date(born + index), runAfter: new Date(Date.now() - 86_400_000) } }));
    }
    const firstWorker = await child("outbox"), secondWorker = await child("outbox");
    await firstWorker.run(first.source.id);
    await firstWorker.prepared();
    await secondWorker.run(second.source.id, false);
    await secondWorker.complete();
    expect(await db.workflowJob.findUniqueOrThrow({ where: { id: jobs[0].id } })).toMatchObject({ status: "RUNNING", attempts: 1 });
    expect(await db.workflowJob.findUniqueOrThrow({ where: { id: jobs[1].id } })).toMatchObject({ status: "COMPLETED", attempts: 1 });
    await firstWorker.release();
    await firstWorker.complete();
    expect(await db.workflowJob.findUniqueOrThrow({ where: { id: jobs[0].id } })).toMatchObject({ status: "COMPLETED", attempts: 1 });
  });

  it("keeps five ordinary jobs concurrent and quiesces all before the SQL turn", async () => {
    const { source } = await setup();
    const born = Date.now() - 60_000, key = randomBytes(4).readUInt32BE() % 2_000_000_000;
    const name = `normal_pause_${randomBytes(6).toString("hex")}`, fn = fixture.table(name);
    await db.workflowJob.createMany({ data: Array.from({ length: 5 }, (_, index) => ({ workspaceId: source.workspaceId,
      type: "synthetic.noop", payload: {}, createdAt: new Date(born + index), runAfter: new Date(Date.now() - 86_400_000) })) });
    const sql = await db.workflowJob.create({ data: { workspaceId: source.workspaceId, type: "data-source.sync",
      payload: { sourceId: source.id }, createdAt: new Date(born + 10), runAfter: new Date(Date.now() - 86_400_000) } });
    const worker = await child("outbox");
    const observer = new pg.Client({ connectionString: fixture.connectionString });
    await observer.connect();
    try {
      await fixture.writer.query("SELECT pg_advisory_lock($1)", [key]);
      await fixture.writer.query(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW."workspaceId" = '${source.workspaceId}' AND NEW.type = 'synthetic.noop' AND NEW.status = 'COMPLETED'
        THEN PERFORM pg_advisory_xact_lock(${key}); END IF; RETURN NEW; END $$`);
      await fixture.writer.query(`CREATE TRIGGER "${name}" BEFORE UPDATE ON "WorkflowJob" FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
      await worker.run(source.id, false);
      const deadline = Date.now() + 15_000;
      let active = 0;
      while (Date.now() < deadline) {
        active = Number((await observer.query(`SELECT count(*) FROM pg_stat_activity WHERE wait_event='advisory' AND query LIKE '%WorkflowJob%'`)).rows[0].count);
        if (active === 5) break;
        await delay(20);
      }
      expect(active).toBe(5);
      await worker.dispatchAgain();
      await delay(100);
      expect(await db.workflowJob.findUniqueOrThrow({ where: { id: sql.id } })).toMatchObject({ status: "PENDING", attempts: 0, lockedAt: null });
      expect(await db.sqlIngestionAttempt.count({ where: { sourceId: source.id } })).toBe(0);
      await fixture.writer.query("SELECT pg_advisory_unlock($1)", [key]);
      await worker.complete();
      await worker.dispatchComplete();
      expect(await db.workflowJob.findUniqueOrThrow({ where: { id: sql.id } })).toMatchObject({ status: "COMPLETED", attempts: 1 });
    } finally {
      await fixture.writer.query("SELECT pg_advisory_unlock($1)", [key]);
      await worker.close();
      await fixture.writer.query(`DROP TRIGGER IF EXISTS "${name}" ON "WorkflowJob"`);
      await fixture.writer.query(`DROP FUNCTION IF EXISTS ${fn}()`);
      await observer.end();
    }
  });

  it("leaves other work unclaimed during SQL and fairly releases overlapping dispatch calls", async () => {
    const first = await setup(), second = await setup();
    const born = Date.now() - 60_000;
    const jobs = [];
    for (const [index, source] of [first.source, second.source].entries()) {
      jobs.push(await db.workflowJob.create({ data: { workspaceId: source.workspaceId, type: "data-source.sync", runAfter: new Date(Date.now() - 86_400_000),
        payload: { sourceId: source.id }, createdAt: new Date(born + index * 2) } }));
    }
    const normal = await db.workflowJob.create({ data: { workspaceId: first.source.workspaceId,
      type: "synthetic.noop", runAfter: new Date(Date.now() - 86_400_000), payload: {}, createdAt: new Date(born + 1) } });
    const worker = await child("outbox");
    await worker.run(first.source.id);
    await worker.prepared();
    await worker.dispatchAgain();
    await delay(100);
    expect(await db.workflowJob.findMany({ where: { id: { in: [jobs[1].id, normal.id] } } }))
      .toEqual(expect.arrayContaining([expect.objectContaining({ id: jobs[1].id, status: "PENDING", attempts: 0, lockedAt: null }),
        expect.objectContaining({ id: normal.id, status: "PENDING", attempts: 0, lockedAt: null })]));
    await worker.release();
    await worker.complete();
    await worker.dispatchComplete();
    expect(await db.workflowJob.findUniqueOrThrow({ where: { id: normal.id } })).toMatchObject({ status: "COMPLETED", attempts: 1 });
    expect(await db.workflowJob.findUniqueOrThrow({ where: { id: jobs[1].id } })).toMatchObject({ status: "PENDING", attempts: 0 });
    await worker.dispatchAgain();
    await worker.dispatchComplete();
    expect(await db.workflowJob.findUniqueOrThrow({ where: { id: jobs[1].id } })).toMatchObject({ status: "COMPLETED", attempts: 1 });
    expect(await db.sqlIngestionAttempt.count({ where: { sourceId: second.source.id } })).toBe(1);
  });

  it("rolls back publication and never overwrites a workflow reclaimed after provider replay", async () => {
    const { source } = await setup();
    const job = await db.workflowJob.create({ data: { workspaceId: source.workspaceId, type: "data-source.sync", runAfter: new Date(Date.now() - 86_400_000), payload: { sourceId: source.id } } });
    const worker = await child("outbox");
    await worker.run(source.id, true, true);
    await worker.prepared();
    await worker.release();
    await worker.publicationReady();
    const prepared = await db.sqlKnowledgePublication.findFirstOrThrow({where: {sourceId: source.id}});
    const native = await db.sqlNativeRunInput.findUniqueOrThrow({where: {id: prepared.nativeInputId}});
    expect(prepared.status).toBe("PREPARED");
    expect(await db.sqlKnowledgeStagedChunk.count({where: {publicationId: prepared.id}})).toBeGreaterThan(0);
    const replacement = await db.workflowJob.update({ where: { id: job.id }, data: { lockedBy: "replacement-worker", attempts: { increment: 1 }, lockedAt: new Date() } });
    await worker.releasePublication();
    await worker.complete(); // Dispatcher records the owned failure instead of rejecting its cycle.
    expect(await db.workflowJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ status: "RUNNING", lockedBy: "replacement-worker", attempts: 2, error: null });
    expect(await db.knowledgeChunk.count({ where: { workspaceId: source.workspaceId } })).toBe(0);
    expect(await cacheVersion(source.workspaceId)).toBe(0);
    expect(await db.externalDataSource.findUniqueOrThrow({ where: { id: source.id } })).toMatchObject({ lastCursorValue: null, lastSyncAt: null });
    expect(await db.externalDataSyncLog.findFirstOrThrow({ where: { sourceId: source.id } })).toMatchObject({ chunksCreated: 0, error: "SQL_WORKFLOW_LEASE_LOST" });
    // Terminal cleanup removes only abandoned non-serving preparation. The
    // immutable native receipt and exact failed attempt/log remain auditable,
    // and the replacement workflow's complete row must not be overwritten.
    expect(await db.sqlKnowledgePublication.findUnique({where: {id: prepared.id}})).toBeNull();
    expect(await db.sqlKnowledgeStagedChunk.count({where: {publicationId: prepared.id}})).toBe(0);
    expect(await db.sqlNativeRunInput.findUnique({where: {id: native.id}})).toEqual(native);
    expect(await db.sqlIngestionAttempt.findUnique({where: {id: prepared.attemptId}})).toMatchObject({
      status: "FAILED", sourceId: source.id, generation: prepared.generation,
      error: "SQL_WORKFLOW_LEASE_LOST", completedAt: expect.any(Date)});
    expect(await db.externalDataSyncLog.findFirstOrThrow({where: {sourceId: source.id}})).toMatchObject({
      sqlAttemptId: prepared.attemptId, rowsProcessed: 0, chunksCreated: 0,
      error: "SQL_WORKFLOW_LEASE_LOST", completedAt: expect.any(Date)});
    expect(await db.workflowJob.findUnique({where: {id: job.id}})).toEqual(replacement);
  });
});
