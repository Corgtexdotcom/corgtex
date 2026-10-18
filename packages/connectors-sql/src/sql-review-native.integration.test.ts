import { randomUUID } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
import { prisma, type AppActor } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { encrypt } from "./encryption";
import { connectReadOnly, listTables } from "./postgres";
import { syncExternalDataSource } from "./puller";
import { sqlKnowledgeSourceId } from "../../knowledge/src/sql-source-identity";
import { fetchReadableKnowledgeChunk } from "../../knowledge/src/retrieval";
import { runPendingJobs, schedulePeriodicJobs } from "../../workflows/src/outbox";

vi.mock("@corgtex/models", async original => ({...await original<typeof import("@corgtex/models")>(),
  defaultModelGateway: {embed: async ({input}: {input: string | string[]}) => ({
    embeddings: (Array.isArray(input) ? input : [input]).map(() => [1, 0]), usage: {model: "synthetic-sql-review"}})}}));

beforeEach(truncateAllTables);

it("scans an actual PostgreSQL empty TEXT primary key and publishes a normally readable chunk", async () => {
  const workspace = await prisma.workspace.create({data: {name: "SQL review", slug: randomUUID()}});
  const user = await prisma.user.create({data: {email: `${randomUUID()}@example.test`, passwordHash: "synthetic"}});
  await prisma.member.create({data: {workspaceId: workspace.id, userId: user.id, role: "ADMIN"}});
  const actor: AppActor = {kind: "user", user};
  const name = `sql_review_${randomUUID().replaceAll("-", "")}`;
  await prisma.$executeRawUnsafe(`CREATE TABLE "${name}" (id text PRIMARY KEY, seq integer NOT NULL, payload text NOT NULL)`);
  try {
    await prisma.$executeRawUnsafe(`INSERT INTO "${name}" VALUES ('',1,'actual native empty primary key')`);
    const source = await prisma.externalDataSource.create({data: {workspaceId: workspace.id, label: "Native empty key",
      connectionStringEnc: encrypt(process.env.DATABASE_URL!), selectedTables: [`public.${name}`], cursorColumn: "seq"}});
    await syncExternalDataSource(source.id);
    const chunk = await prisma.knowledgeChunk.findFirstOrThrow({where: {workspaceId: workspace.id}});
    expect(chunk.sourceId).toBe(sqlKnowledgeSourceId(source.id, `public.${name}`, ""));
    expect(await fetchReadableKnowledgeChunk(actor, workspace.id, chunk.id)).toMatchObject({id: chunk.id});
    expect(await prisma.externalDataSyncLog.findFirst({where: {sourceId: source.id}})).toMatchObject({rowsProcessed: 1, chunksCreated: 1, error: null});
  } finally {await prisma.$executeRawUnsafe(`DROP TABLE "${name}"`);}
});

it("legacy empty sources stay discoverable but are not scheduled, and an already queued job terminates without provider work", async () => {
  const workspace = await prisma.workspace.create({data: {name: "Legacy discovery", slug: randomUUID()}});
  const source = await prisma.externalDataSource.create({data: {workspaceId: workspace.id, label: "Legacy empty",
    connectionStringEnc: encrypt(process.env.DATABASE_URL!), selectedTables: [], isActive: true}});
  const client = await connectReadOnly(process.env.DATABASE_URL!);
  try {expect(Array.isArray(await listTables(client))).toBe(true);} finally {await client.end();}
  await schedulePeriodicJobs();
  expect(await prisma.workflowJob.count({where: {type: "data-source.sync"}})).toBe(0);
  const job = await prisma.workflowJob.create({data: {workspaceId: workspace.id, type: "data-source.sync", payload: {sourceId: source.id}, status: "PENDING",
    // Deliberately already eligible under the existing generic job clock in a non-UTC fixture.
    runAfter: new Date(Date.now() - 24 * 60 * 60 * 1000)}});
  await runPendingJobs("synthetic-empty-source-worker", 1, 1);
  expect(await prisma.workflowJob.findUnique({where: {id: job.id}})).toMatchObject({status: "COMPLETED", attempts: 1});
  expect(await prisma.externalDataSyncLog.count()).toBe(0);
  expect(await prisma.sqlIngestionAttempt.count()).toBe(0);
  expect(await prisma.sqlNativeRunInput.count()).toBe(0);
  expect(await prisma.externalDataSource.findUnique({where: {id: source.id}})).toEqual(source);
});
