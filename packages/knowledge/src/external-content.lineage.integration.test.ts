import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { encryptSecret, prisma, type AppActor } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";

const remote = vi.hoisted(() => ({
  transport: vi.fn(), embed: vi.fn(), transactionDepth: 0, callsInTransaction: 0,
  publicationPause: null as null | { entered: (pid: number) => void; release: Promise<void> },
  details: { id: "synthetic-file", name: "Synthetic Box policy", etag: "same-version" },
  content: { text: "The synthetic Box policy assigns onboarding to the product team." },
}));
vi.mock("../../domain/src/external-mcp", async original => ({ ...await original<typeof import("../../domain/src/external-mcp")>(),
  readBoxExternalMcpNativeResponse: remote.transport }));
vi.mock("@corgtex/shared", async original => {
  const actual = await original<typeof import("@corgtex/shared")>();
  const instrumented = new Proxy(actual.prisma, { get(target, key) {
    if (key !== "$transaction") return Reflect.get(target, key, target);
    return async (...args: any[]) => {
      const run = target.$transaction.bind(target) as (...args: any[]) => Promise<any>;
      if (typeof args[0] !== "function") return run(...args);
      return run(async (tx: any) => {
        remote.transactionDepth++;
        try {
          const pause = remote.publicationPause;
          if (pause) {
            remote.publicationPause = null;
            const [backend] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
            pause.entered(backend.pid);
            await pause.release;
          }
          return await args[0](tx);
        } finally { remote.transactionDepth--; }
      }, ...args.slice(1));
    };
  } });
  return { ...actual, prisma: instrumented };
});
vi.mock("@corgtex/models", () => ({ defaultModelGateway: { embed: remote.embed } }));
vi.mock("./retrieval", () => ({ invalidateKnowledgeCache: vi.fn(async () => undefined) }));
vi.mock("./azure-search", () => ({ getKnowledgeSearchProvider: () => "postgres", isAzureKnowledgeSearchConfigured: () => false,
  syncAzureKnowledgeSource: vi.fn(async () => ({ skipped: true })), logAzureKnowledgeIndexingWarning: vi.fn() }));

import { enqueueExternalContentSourceSync, selectExternalContentSource, syncExternalContentSource } from "../../domain/src/external-content-sources";
import { createDocument } from "../../domain/src/documents";
import { readableArtifactIds } from "../../domain/src/source-lineage";
import { syncDocumentKnowledge, syncKnowledgeForSource } from "./chunks";

function gate<T>() {
  let open!: (value: T) => void;
  const promise = new Promise<T>(resolve => { open = resolve; });
  return { promise, open };
}

async function fixture() {
  const workspace = await prisma.workspace.create({ data: { name: "Synthetic Box index", slug: `box-index-${randomUUID()}` } });
  const owner = await prisma.user.create({ data: { email: `box-index-${randomUUID()}@example.test`, passwordHash: "synthetic" } });
  const other = await prisma.user.create({ data: { email: `box-other-${randomUUID()}@example.test`, passwordHash: "synthetic" } });
  await prisma.member.create({ data: { workspaceId: workspace.id, userId: owner.id, role: "ADMIN" } });
  await prisma.member.create({ data: { workspaceId: workspace.id, userId: other.id, role: "ADMIN" } });
  const actor: AppActor = { kind: "user", user: { id: owner.id, email: owner.email, displayName: null, globalRole: "USER" } };
  const otherActor: AppActor = { kind: "user", user: { id: other.id, email: other.email, displayName: null, globalRole: "USER" } };
  const connection = await prisma.externalMcpConnection.create({ data: { workspaceId: workspace.id, userId: owner.id,
    providerKey: "box", displayName: "Synthetic Box account", serverUrl: "https://mcp.box.com", providerAccountId: "box-owner",
    accessTokenEnc: encryptSecret("synthetic-only-token"), scopes: ["root_readwrite"] } });
  const source = await selectExternalContentSource(actor, { workspaceId: workspace.id, providerKey: "box", sourceKind: "FILE",
    externalId: "synthetic-file", connectionId: connection.id, title: "Selected synthetic file" });
  const job = await prisma.workflowJob.findFirstOrThrow({ where: { workspaceId: workspace.id,
    type: "knowledge.sync.external-content", payload: { path: ["sourceId"], equals: source.id } } });
  await claim(job.id);
  return { workspace, actor, otherActor, source, job };
}

async function claim(jobId: string) {
  await prisma.workflowJob.update({ where: { id: jobId }, data: { status: "RUNNING", attempts: 1,
    lockedBy: "synthetic-box-worker", lockedAt: new Date(), startedAt: new Date() } });
}

const sync = (f: Awaited<ReturnType<typeof fixture>>, jobId = f.job.id) => syncExternalContentSource({
  workspaceId: f.workspace.id, sourceId: f.source.id, workflowJobId: jobId,
  syncKnowledge: input => syncKnowledgeForSource({ ...input, accessDomain: "WORKSPACE" }),
});

describe("Box source indexing with real PostgreSQL receipts and commit scopes", () => {
  beforeEach(async () => {
    const target = new URL(process.env.DATABASE_URL ?? "");
    if (!["postgres:", "postgresql:"].includes(target.protocol)
      || !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname)
      || target.pathname !== "/corgtex_test" || target.searchParams.get("schema") !== "public") {
      throw new Error("This suite requires the disposable local test database.");
    }
    await truncateAllTables();
    remote.transactionDepth = 0; remote.callsInTransaction = 0;
    remote.publicationPause = null;
    remote.details = { id: "synthetic-file", name: "Synthetic Box policy", etag: "same-version" };
    remote.content = { text: "The synthetic Box policy assigns onboarding to the product team." };
    remote.transport.mockReset().mockImplementation(async ({ toolName }: { toolName: string }) => {
      if (remote.transactionDepth) { remote.callsInTransaction++; throw new Error("Box transport ran inside an interactive transaction."); }
      return structuredClone(toolName === "get_file_details" ? remote.details : remote.content);
    });
    remote.embed.mockReset().mockImplementation(async ({ input }: { input: string[] }) => ({
      embeddings: input.map(() => [0.1, 0.2]), usage: { provider: "synthetic", model: "synthetic-embedding" },
    }));
  });

  it("indexes the complete selected Box snapshot for its owner without a provider call in a transaction", async () => {
    const f = await fixture();
    const result = await sync(f);
    expect(result).toMatchObject({ status: "SYNCED", chunksCreated: 1 });
    const chunks = await prisma.knowledgeChunk.findMany({ where: { workspaceId: f.workspace.id, sourceType: "EXTERNAL_CONTENT", sourceId: f.source.id } });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toContain("product team");
    expect(chunks[0].metadata).toMatchObject({ sourceContentHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(await readableArtifactIds(f.actor, f.workspace.id, "KnowledgeChunk", chunks)).toEqual(new Set([chunks[0].id]));
    expect(await readableArtifactIds(f.otherActor, f.workspace.id, "KnowledgeChunk", chunks)).toEqual(new Set());
    expect(remote.callsInTransaction).toBe(0);
  });

  it("rejects provider byte drift after embedding and preserves the previously committed chunk", async () => {
    const f = await fixture();
    expect((await sync(f)).chunksCreated).toBe(1);
    const prior = await prisma.knowledgeChunk.findMany({ where: { workspaceId: f.workspace.id, sourceId: f.source.id } });
    await prisma.workflowJob.update({ where: { id: f.job.id }, data: { status: "COMPLETED" } });
    await enqueueExternalContentSourceSync(f.actor, { workspaceId: f.workspace.id, sourceId: f.source.id });
    const next = await prisma.workflowJob.findFirstOrThrow({ where: { workspaceId: f.workspace.id,
      type: "knowledge.sync.external-content", id: { not: f.job.id } } });
    await claim(next.id);
    remote.details.etag = "new-version";
    remote.embed.mockImplementationOnce(async ({ input }: { input: string[] }) => {
      remote.content.text = "Provider changed after embedding started.";
      return { embeddings: input.map(() => [0.3, 0.4]), usage: { provider: "synthetic", model: "synthetic-embedding" } };
    });
    await expect(sync(f, next.id)).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(await prisma.knowledgeChunk.findMany({ where: { workspaceId: f.workspace.id, sourceId: f.source.id } })).toEqual(prior);
    expect(remote.callsInTransaction).toBe(0);
  });

  it("retries the same copied hashes after indexing fails and becomes unchanged only after indexing succeeds", async () => {
    const f = await fixture();
    remote.embed.mockRejectedValueOnce(new Error("Synthetic embedding failure"));
    await expect(sync(f)).rejects.toMatchObject({ code: "EXTERNAL_CONTENT_SYNC_FAILED" });
    expect(await prisma.brainSource.count({ where: { workspaceId: f.workspace.id } })).toBe(1);
    expect(await prisma.knowledgeChunk.count({ where: { workspaceId: f.workspace.id } })).toBe(0);
    const failed = await prisma.externalContentSyncLog.findFirstOrThrow({ where: { sourceId: f.source.id, status: "ERROR" } });
    expect(failed.brainSourceId).toBeTruthy();
    await expect(sync(f)).resolves.toMatchObject({ status: "SYNCED", chunksCreated: 1 });
    expect(await prisma.knowledgeChunk.count({ where: { workspaceId: f.workspace.id, sourceId: f.source.id } })).toBe(1);
    expect(await prisma.brainSource.count({ where: { workspaceId: f.workspace.id } })).toBe(2);
    await expect(sync(f)).resolves.toMatchObject({ status: "UNCHANGED", chunksCreated: 0 });
    expect(remote.embed).toHaveBeenCalledTimes(2);
    expect(await prisma.brainSource.count({ where: { workspaceId: f.workspace.id } })).toBe(2);
    expect(remote.callsInTransaction).toBe(0);
  });

  it("does not reuse an older successful same-hash copy after a newer copy failed indexing", async () => {
    const f = await fixture(), original = remote.content.text;
    await expect(sync(f)).resolves.toMatchObject({ status: "SYNCED" });
    remote.content.text = "Synthetic changed provider bytes";
    remote.embed.mockRejectedValueOnce(new Error("Synthetic changed index failure"));
    await expect(sync(f)).rejects.toMatchObject({ code: "EXTERNAL_CONTENT_SYNC_FAILED" });
    remote.content.text = original;
    remote.embed.mockRejectedValueOnce(new Error("Synthetic original index failure"));
    await expect(sync(f)).rejects.toMatchObject({ code: "EXTERNAL_CONTENT_SYNC_FAILED" });
    await expect(sync(f)).resolves.toMatchObject({ status: "SYNCED", chunksCreated: 1 });
    await expect(sync(f)).resolves.toMatchObject({ status: "UNCHANGED" });
    expect(remote.embed).toHaveBeenCalledTimes(4);
    const chunks = await prisma.knowledgeChunk.findMany({ where: { workspaceId: f.workspace.id, sourceId: f.source.id } });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toContain(original);
    expect(await prisma.externalContentSyncLog.count({ where: { sourceId: f.source.id, status: "SYNCED" } })).toBe(2);
    expect(remote.callsInTransaction).toBe(0);
  });

  it.each(["membership", "job-head"] as const)("withholds failed-copy retry when its original %s authority is revoked", async change => {
    const f = await fixture();
    remote.embed.mockRejectedValueOnce(new Error("Synthetic indexing failure"));
    await expect(sync(f)).rejects.toMatchObject({ code: "EXTERNAL_CONTENT_SYNC_FAILED" });
    if (change === "membership") await prisma.member.updateMany({ where: { workspaceId: f.workspace.id, userId: f.actor.kind === "user" ? f.actor.user.id : "" }, data: { isActive: false } });
    else {
      const head = await prisma.artifactInputLineage.findFirstOrThrow({ where: { workspaceId: f.workspace.id,
        artifactType: "WorkflowJobInput", artifactId: f.job.id }, orderBy: { revision: "desc" } });
      await prisma.artifactInputLineage.create({ data: { workspaceId: f.workspace.id, artifactType: head.artifactType,
        artifactId: head.artifactId, revision: head.revision + 1, origin: "UNKNOWN", contentHash: head.contentHash,
        inputsJson: [], rootsJson: [] } });
    }
    await expect(sync(f)).rejects.toMatchObject({ code: expect.stringMatching(/SOURCE_|UNKNOWN_LINEAGE|NOT_A_MEMBER|FORBIDDEN/) });
    expect(remote.embed).toHaveBeenCalledTimes(1);
    expect(await prisma.knowledgeChunk.count({ where: { workspaceId: f.workspace.id, sourceId: f.source.id } })).toBe(0);
    expect(await prisma.externalContentSyncLog.count({ where: { sourceId: f.source.id, status: "SYNCED" } })).toBe(0);
    expect(remote.callsInTransaction).toBe(0);
  });

  it("waits on the Document row before source epochs while a privacy writer commits", async () => {
    const workspace = await prisma.workspace.create({ data: { name: "Synthetic document privacy race", slug: `doc-race-${randomUUID()}` } });
    const user = await prisma.user.create({ data: { email: `doc-race-${randomUUID()}@example.test`, passwordHash: "synthetic" } });
    await prisma.member.create({ data: { workspaceId: workspace.id, userId: user.id, role: "ADMIN" } });
    const actor: AppActor = { kind: "user", user: { id: user.id, email: user.email, displayName: null, globalRole: "USER" } };
    const document = await createDocument(actor, { workspaceId: workspace.id, title: "Synthetic privacy policy", source: "MANUAL",
      storageKey: `synthetic/${randomUUID()}`, mimeType: "text/plain", textContent: "The original synthetic policy text." });
    expect(await syncDocumentKnowledge({ workspaceId: workspace.id, documentId: document.id, lineageActor: actor })).toBe(1);
    const prior = await prisma.knowledgeChunk.findMany({ where: { workspaceId: workspace.id, sourceType: "DOCUMENT", sourceId: document.id } });
    expect(prior).toHaveLength(1);

    const indexEntered = gate<number>();
    const releaseIndex = gate<void>();
    const writerEntered = gate<void>();
    const releaseWriter = gate<void>();
    remote.embed.mockImplementationOnce(async ({ input }: { input: string[] }) => {
      remote.publicationPause = { entered: indexEntered.open, release: releaseIndex.promise };
      return { embeddings: input.map(() => [0.4, 0.6]), usage: { provider: "synthetic", model: "synthetic-embedding" } };
    });
    const indexing = syncDocumentKnowledge({ workspaceId: workspace.id, documentId: document.id, lineageActor: actor })
      .then(value => ({ value, error: null as unknown }), error => ({ value: null, error }));
    let writing: Promise<unknown> | undefined;
    try {
      const indexPid = await Promise.race([indexEntered.promise, indexing.then(() => {
        throw new Error("Indexing completed before its final publication transaction.");
      })]);
      writing = prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT "id" FROM "Document" WHERE "id" = ${document.id} AND "workspaceId" = ${workspace.id} FOR UPDATE`;
        await tx.document.update({ where: { id: document.id }, data: { archivedAt: new Date() } });
        writerEntered.open();
        await releaseWriter.promise;
      }, { timeout: 15_000 });
      await writerEntered.promise;
      releaseIndex.open();
      await vi.waitFor(async () => {
        const [state] = await prisma.$queryRaw<Array<{ wait_event_type: string | null; query: string; blockers: number[] }>>`
          SELECT wait_event_type, query, pg_blocking_pids(${indexPid}::int) AS blockers FROM pg_stat_activity WHERE pid = ${indexPid}`;
        expect(state?.wait_event_type).toBe("Lock");
        expect(state?.query).toContain("Document");
        expect(state?.blockers.length).toBeGreaterThan(0);
      }, { timeout: 5_000 });
      releaseWriter.open();
      await writing;
      const settled = await indexing;
      if (settled.error) expect(settled.error).toMatchObject({ code: "SOURCE_CHANGED" });
      else expect(settled.value).toBe(0);
      expect(await prisma.knowledgeChunk.findMany({ where: { workspaceId: workspace.id, sourceType: "DOCUMENT", sourceId: document.id } })).toEqual(prior);
      expect(await readableArtifactIds(actor, workspace.id, "KnowledgeChunk", prior)).toEqual(new Set());
      expect(remote.callsInTransaction).toBe(0);
    } finally {
      releaseIndex.open(); releaseWriter.open();
      await Promise.allSettled([indexing, writing]);
    }
  });
});
