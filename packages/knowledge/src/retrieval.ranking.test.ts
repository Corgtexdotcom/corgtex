import type { ChatCompletionRequest, EmbeddingRequest, ModelAttemptGuard, ModelRequestControls, RerankRequest } from "@corgtex/models";
import { installSourcePermissionEpochFixture } from "../../domain/src/source-permission-epochs.test-fixture";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fixture, resetFixture, known, alpha, beta, workspaceId } from "../../agents/src/agents/model-consumer.test-fixture";

const model = vi.hoisted(() => ({
  embed: vi.fn(async (_request: EmbeddingRequest) => ({ embeddings: [[1, 0]], usage: { model: "synthetic" } })),
  rerank: vi.fn(async ({ documents, topK }: RerankRequest) => ({
    results: documents.slice(0, topK).map((_value, index) => ({ index, score: 1 - index * 0.1 })),
  })),
  chat: vi.fn(async (_request: ChatCompletionRequest) => ({ content: "Synthetic answer" })),
}));
vi.mock("@corgtex/shared", async (original) => ({ ...await original<typeof import("@corgtex/shared")>(), prisma: fixture.prisma }));
vi.mock("../../domain/src/auth", () => ({ requireWorkspaceMembership: fixture.membership, isGlobalOperator: () => false }));
vi.mock("../../domain/src/brain-access", () => ({ resolveKnowledgeAccessDomains: async (actor: any) => fixture.domains.get(actor.user.id) ?? [] }));
vi.mock("@corgtex/domain", async () => ({ ...await import("../../domain/src/source-lineage"),
  ...await import("../../domain/src/brain-access"), ...await import("../../domain/src/artifact-commit-preflight") }));
vi.mock("@corgtex/models", async () => ({ ...await import("../../models/src/provider-errors"), ...await import("../../models/src/usage"), defaultModelGateway: model, resolveModel: () => "synthetic-model" }));

import { resetLocalCacheStore } from "@corgtex/shared";
import { answerKnowledgeQuestion, getKnowledgeSearchInputRoots, searchIndexedKnowledge } from "./retrieval";
import { syncKnowledgeForSource } from "./chunks";

async function chunkFor(source: any) {
  await syncKnowledgeForSource({ workspaceId: source.workspaceId, sourceType: "BRAIN_ARTICLE", sourceId: source.id,
    sourceTitle: source.title, content: source.bodyMd, accessDomain: "WORKSPACE", lineageActor: beta });
  return fixture.rows.knowledgeChunk.find(row => row.sourceId === source.id);
}
async function original(id: string, overrides: Record<string, unknown> = {}) {
  const source = fixture.add("brainArticle", { id, workspaceId, title: `Synthetic policy ${id}`, bodyMd: `Policy ${id}`,
    isPrivate: false, ownerMemberId: "member-alpha", variantOfArticleId: null, archivedAt: null, ...overrides });
  await known("BrainArticle", source, [], beta);
  return source;
}

beforeEach(async () => {
  await resetFixture();
  resetLocalCacheStore();
  fixture.rows.knowledgeChunk = [];
  fixture.prisma.externalContentSource = { findMany: vi.fn(async () => []) };
  fixture.prisma.$queryRaw = vi.fn(async () => []);
  fixture.prisma.$transaction.mockImplementation(async (work: any) => {
    const before = structuredClone(fixture.rows);
    try { return await work({ ...fixture.prisma }); }
    catch (error) { for (const name of Object.keys(before)) fixture.rows[name] = before[name]; throw error; }
  });
  fixture.prisma.knowledgeChunk = {
    findFirst: vi.fn(async ({ where }: any) => structuredClone(fixture.rows.knowledgeChunk.find(row => row.id === where.id && row.workspaceId === where.workspaceId) ?? null)),
    deleteMany: vi.fn(async ({ where }: any) => { fixture.rows.knowledgeChunk = fixture.rows.knowledgeChunk.filter(row => row.sourceId !== where.sourceId || row.workspaceId !== where.workspaceId); return { count: 1 }; }),
    createMany: vi.fn(async ({ data }: any) => { fixture.rows.knowledgeChunk.push(...structuredClone(data)); return { count: data.length }; }),
    findMany: vi.fn(async ({ where, select, take }: any) => fixture.rows.knowledgeChunk.filter(row => row.workspaceId === where.workspaceId
      && (!where.accessDomain || where.accessDomain.in.includes(row.accessDomain))
      && (!where.sourceType || (typeof where.sourceType === "string" ? where.sourceType === row.sourceType : where.sourceType.in.includes(row.sourceType)))
      && (!where.id || where.id.in.includes(row.id))
      && (!where.OR || where.OR.some((parent: any) => parent.sourceType === row.sourceType && parent.sourceId === row.sourceId
        && parent.metadata.equals === row.metadata.sourceContentHash)))
      .slice(0, take ?? fixture.rows.knowledgeChunk.length).map(row => select
        ? Object.fromEntries(Object.keys(select).map(key => [key, structuredClone(row[key])])) : structuredClone(row))),
  };
  model.embed.mockReset().mockResolvedValue({ embeddings: [[1, 0]], usage: { model: "synthetic" } });
  model.rerank.mockReset().mockImplementation(async ({ documents, topK }) => ({ results: documents.slice(0, topK).map((_value, index) => ({ index, score: 1 - index * 0.1 })) }));
  model.chat.mockReset().mockResolvedValue({ content: "Synthetic answer" });
  delete process.env.KNOWLEDGE_SEARCH_PROVIDER;
  installSourcePermissionEpochFixture(fixture.prisma);
});

afterEach(() => vi.unstubAllGlobals());

const params = { actor: alpha, workspaceId, query: "policy", limit: 1 };

describe("knowledge ranking with actual current source proofs", () => {
  it.each([
    ["embed", "credentials"], ["embed", "retry"],
    ["rerank", "credentials"], ["rerank", "retry"],
    ["chat", "credentials"], ["chat", "retry"],
  ] as const)("blocks outbound %s sends after authority changes during %s", async (method, phase) => {
    const source = await original("attempt-source");
    await chunkFor(source);
    let sends = 0;
    let entered = false;
    const attemptContext = { signal: new AbortController().signal };
    const send = async (request: ModelRequestControls) => {
      entered = true;
      if (phase === "credentials") source.isPrivate = true;
      // Alpha cannot read a now-private row owned by beta.
      if (phase === "credentials") source.ownerMemberId = "member-beta";
      await request.authorizeAttempt?.(attemptContext);
      sends++;
      if (phase === "retry") {
        source.isPrivate = true; source.ownerMemberId = "member-beta";
        await request.authorizeAttempt?.(attemptContext);
        sends++;
      }
    };
    if (method === "embed") model.embed.mockImplementationOnce(async request => {
      await send(request); return { embeddings: [[1, 0]], usage: { model: "synthetic" } };
    });
    if (method === "rerank") model.rerank.mockImplementationOnce(async request => {
      await send(request); return { results: [{ index: 0, score: 1 }] };
    });
    if (method === "chat") model.chat.mockImplementationOnce(async request => {
      await send(request); return { content: "Synthetic answer" };
    });
    const run = method === "chat" ? answerKnowledgeQuestion({ ...params, question: params.query }) : searchIndexedKnowledge(params);
    await run.catch(() => undefined);
    expect(entered).toBe(true);
    expect(sends).toBe(phase === "credentials" ? 0 : 1);
  });

  it.each(["embed", "rerank", "chat"] as const)("preserves %s caller guard context and cancellation, without recapturing heads", async method => {
    const source = await original("guarded-source");
    await chunkFor(source);
    const caller = new AbortController();
    const deadline = new AbortController();
    const attemptContext = { signal: deadline.signal };
    let checked = false;
    let replaceHead = false;
    const upstream = vi.fn<ModelAttemptGuard>(async context => {
      expect(context).toBe(attemptContext);
      if (replaceHead) await known("BrainArticle", source, [], beta);
    });
    let sends = 0;
    const send = async (request: ModelRequestControls) => {
      expect(request.signal).toBe(caller.signal);
      expect(request.authorizeAttempt).toBeTypeOf("function");
      await request.authorizeAttempt!(attemptContext);
      sends++;
      replaceHead = true;
      await expect(request.authorizeAttempt!(attemptContext)).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
      expect(upstream).toHaveBeenCalledTimes(2);
      deadline.abort(new Error("Synthetic deadline"));
      await expect(request.authorizeAttempt!(attemptContext)).rejects.toThrow("Synthetic deadline");
      caller.abort(new Error("Synthetic caller cancellation"));
      await expect(request.authorizeAttempt!(attemptContext)).rejects.toThrow("Synthetic caller cancellation");
      expect(upstream).toHaveBeenCalledTimes(2);
      checked = true;
    };
    if (method === "embed") model.embed.mockImplementationOnce(async request => {
      await send(request); return { embeddings: [[1, 0]], usage: { model: "synthetic" } };
    });
    if (method === "rerank") model.rerank.mockImplementationOnce(async request => {
      await send(request); return { results: [{ index: 0, score: 1 }] };
    });
    if (method === "chat") model.chat.mockImplementationOnce(async request => {
      await send(request); return { content: "Synthetic answer" };
    });
    const controls = { signal: caller.signal, authorizeAttempt: upstream };
    const run = method === "chat" ? answerKnowledgeQuestion({ ...params, ...controls, question: params.query })
      : searchIndexedKnowledge({ ...params, ...controls });
    await run.catch(() => undefined);
    expect(checked).toBe(true);
    expect(sends).toBe(1);
  });

  it.each(["embed", "rerank", "chat"] as const)("permits %s retries with unchanged original authority", async method => {
    await chunkFor(await original("permitted-attempt"));
    const caller = new AbortController();
    const context = { signal: new AbortController().signal };
    const upstream = vi.fn<ModelAttemptGuard>(async received => { expect(received).toBe(context); });
    const send = async (request: ModelRequestControls) => {
      expect(request.signal).toBe(caller.signal);
      await request.authorizeAttempt!(context);
      await request.authorizeAttempt!(context);
    };
    if (method === "embed") model.embed.mockImplementationOnce(async request => {
      await send(request); return { embeddings: [[1, 0]], usage: { model: "synthetic" } };
    });
    if (method === "rerank") model.rerank.mockImplementationOnce(async request => {
      await send(request); return { results: [{ index: 0, score: 1 }] };
    });
    if (method === "chat") model.chat.mockImplementationOnce(async request => {
      await send(request); return { content: "Synthetic answer" };
    });
    const controls = { signal: caller.signal, authorizeAttempt: upstream };
    if (method === "chat") {
      expect(await answerKnowledgeQuestion({ ...params, ...controls, question: params.query })).toMatchObject({ answer: "Synthetic answer" });
    } else expect(await searchIndexedKnowledge({ ...params, ...controls })).toHaveLength(1);
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it.each(["credentials", "retry", "permitted"] as const)("binds the canonical cohort before Azure embedding %s waits", async phase => {
    const source = await original("azure-attempt-source");
    await chunkFor(source);
    vi.stubEnv("KNOWLEDGE_SEARCH_PROVIDER", "azure");
    vi.stubEnv("AZURE_SEARCH_ENDPOINT", "https://synthetic.search.windows.net");
    vi.stubEnv("AZURE_SEARCH_INDEX_NAME", "synthetic-index");
    vi.stubEnv("AZURE_SEARCH_QUERY_KEY", "synthetic-test-key");
    vi.stubEnv("AZURE_SEARCH_VECTOR_DIMENSIONS", "2");
    const azure = vi.fn(async () => new Response(JSON.stringify({ value: [] }), { status: 200 }));
    vi.stubGlobal("fetch", azure);
    let sends = 0;
    model.embed.mockImplementationOnce(async request => {
      const context = { signal: new AbortController().signal };
      if (phase === "credentials") { source.isPrivate = true; source.ownerMemberId = "member-beta"; }
      await request.authorizeAttempt?.(context);
      sends++;
      if (phase === "retry") { source.isPrivate = true; source.ownerMemberId = "member-beta"; }
      await request.authorizeAttempt?.(context);
      sends++;
      return { embeddings: [[1, 0]], usage: { model: "synthetic" } };
    });
    try {
      const results = await searchIndexedKnowledge(params).catch(() => []);
      expect(sends).toBe(phase === "credentials" ? 0 : phase === "retry" ? 1 : 2);
      if (phase === "permitted") {
        expect(results).toHaveLength(1);
        expect(azure).toHaveBeenCalledOnce();
      } else {
        expect(results).toEqual([]);
        expect(azure).not.toHaveBeenCalled();
        expect(model.rerank).not.toHaveBeenCalled();
      }
    } finally { vi.unstubAllEnvs(); }
  });

  it.each([false, true])("retains original heads across Azure response and fallback (failure=%s)", async failure => {
    const source = await original("azure-original-head");
    await chunkFor(source);
    vi.stubEnv("KNOWLEDGE_SEARCH_PROVIDER", "azure");
    vi.stubEnv("AZURE_SEARCH_ENDPOINT", "https://synthetic.search.windows.net");
    vi.stubEnv("AZURE_SEARCH_INDEX_NAME", "synthetic-index");
    vi.stubEnv("AZURE_SEARCH_QUERY_KEY", "synthetic-test-key");
    vi.stubEnv("AZURE_SEARCH_VECTOR_DIMENSIONS", "2");
    const azure = vi.fn(async () => {
      await known("BrainArticle", source, [], beta);
      return new Response(JSON.stringify({ value: [] }), { status: failure ? 401 : 200 });
    });
    vi.stubGlobal("fetch", azure);
    model.embed.mockClear();
    try {
      expect(await searchIndexedKnowledge(params)).toEqual([]);
      expect(azure).toHaveBeenCalledOnce();
      expect(model.embed).toHaveBeenCalledOnce();
      expect(model.rerank).not.toHaveBeenCalled();
    } finally { vi.unstubAllEnvs(); }
  });

  it("captures full ranking fields once and excludes missing/private parents for two current members", async () => {
    const visible = await chunkFor(await original("public"));
    const privateParent = await original("private-parent", { isPrivate: true, ownerMemberId: "member-beta" });
    const copied = fixture.add("brainArticle", { ...privateParent, id: "copied", isPrivate: false, title: "Restricted policy", bodyMd: "Restricted policy copy" });
    await known("BrainArticle", copied, [{ kind: "BrainArticle", id: privateParent.id }], beta);
    await chunkFor(copied);
    fixture.add("knowledgeChunk", { ...visible, id: "missing-parent", sourceId: "missing" });
    fixture.add("knowledgeChunk", { ...visible, id: "foreign", workspaceId: "ws-b" });
    const first = await searchIndexedKnowledge({ ...params, limit: 5 });
    expect(first.map(row => row.sourceId)).toEqual(["public"]);
    expect(model.rerank.mock.calls[0][0].documents).toEqual(["Synthetic policy public\nPolicy public"]);
    const rankingReads = fixture.prisma.knowledgeChunk.findMany.mock.calls.filter(([query]: any[]) => query.select);
    expect(rankingReads.every(([query]: any[]) => query.select.content && query.select.embedding && query.select.embeddingModel && query.select.tokenCount)).toBe(true);
    expect(rankingReads[0][0].select).toMatchObject({ embedding: true, embeddingModel: true, tokenCount: true });
    expect(fixture.prisma.knowledgeChunk.findMany.mock.calls.some(([query]: any[]) => !query.select && query.where.id?.in.includes(visible.id))).toBe(true);
    expect(await getKnowledgeSearchInputRoots(alpha, workspaceId, first)).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "KnowledgeChunk", id: visible.id })]));
    expect(await getKnowledgeSearchInputRoots(beta, workspaceId, first).catch(() => null)).toBeNull();
    expect((await searchIndexedKnowledge({ ...params, actor: beta, limit: 5 })).map(row => row.sourceId).sort()).toEqual(["copied", "public"]);
  });

  it.each(["embedding", "embeddingModel", "tokenCount"] as const)("withholds search and answer caches after unattested %s changes until real rebuild", async field => {
    const source = await original("cached");
    const chunk = await chunkFor(source);
    const first = await searchIndexedKnowledge(params);
    await answerKnowledgeQuestion({ actor: alpha, workspaceId, question: "policy", limit: 1 });
    const initialQueries = model.embed.mock.calls.length;
    const originalDate = chunk.createdAt;
    chunk[field] = field === "embedding" ? [0, 1] : field === "embeddingModel" ? "changed-model" : 500;
    await expect(getKnowledgeSearchInputRoots(alpha, workspaceId, first)).rejects.toThrow("changed");
    expect(await searchIndexedKnowledge(params)).toEqual([]);
    expect(await answerKnowledgeQuestion({ actor: alpha, workspaceId, question: "policy", limit: 1 })).toEqual({
      answer: "I could not find relevant indexed knowledge for that question.", citations: [],
    });
    expect(model.chat).toHaveBeenCalledTimes(1);
    await chunkFor(source);
    expect((await searchIndexedKnowledge(params))[0].sourceId).toBe("cached");
    await answerKnowledgeQuestion({ actor: alpha, workspaceId, question: "policy", limit: 1 });
    expect(model.embed.mock.calls.length).toBeGreaterThan(initialQueries);
    expect(model.chat).toHaveBeenCalledTimes(2);
    expect(chunk.createdAt).toBe(originalDate);
  });

  it("withholds ranks when an uncited candidate vector changes while query embedding is in flight", async () => {
    await chunkFor(await original("winner"));
    const uncited = await chunkFor(await original("uncited"));
    model.embed.mockImplementationOnce(async () => {
      uncited.embedding = [0, 1];
      return { embeddings: [[1, 0]], usage: { model: "synthetic" } };
    });
    expect(await searchIndexedKnowledge(params)).toEqual([]);
    expect(model.rerank).not.toHaveBeenCalled();
  });

  it("withholds a completed rank when the captured vector changes during model reranking", async () => {
    const chunk = await chunkFor(await original("during-rerank"));
    model.rerank.mockImplementationOnce(async () => { chunk.embedding = [0, 1]; return { results: [{ index: 0, score: 0.99 }] }; });
    expect(await searchIndexedKnowledge(params)).toEqual([]);
  });
});
