import { installSourcePermissionEpochFixture } from "../../domain/src/source-permission-epochs.test-fixture";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fixture, resetFixture, known, alpha, beta, workspaceId } from "../../agents/src/agents/model-consumer.test-fixture";

const model = vi.hoisted(() => ({
  embed: vi.fn(async () => ({ embeddings: [[1, 0]], usage: { model: "synthetic" } })),
  rerank: vi.fn(async ({ documents, topK }: { documents: string[]; topK: number }) => ({
    results: documents.slice(0, topK).map((_value, index) => ({ index, score: 1 - index * 0.1 })),
  })),
  chat: vi.fn(async () => ({ content: "Synthetic answer" })),
}));
vi.mock("@corgtex/shared", async (original) => ({ ...await original<typeof import("@corgtex/shared")>(), prisma: fixture.prisma }));
vi.mock("../../domain/src/auth", () => ({ requireWorkspaceMembership: fixture.membership, isGlobalOperator: () => false }));
vi.mock("../../domain/src/brain-access", () => ({ resolveKnowledgeAccessDomains: async (actor: any) => fixture.domains.get(actor.user.id) ?? [] }));
vi.mock("@corgtex/domain", async () => ({ ...await import("../../domain/src/source-lineage"),
  ...await import("../../domain/src/brain-access"), ...await import("../../domain/src/artifact-commit-preflight") }));
vi.mock("@corgtex/models", async () => ({ ...await import("../../models/src/provider-errors"), defaultModelGateway: model, resolveModel: () => "synthetic-model" }));

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

const params = { actor: alpha, workspaceId, query: "policy", limit: 1 };

describe("knowledge ranking with actual current source proofs", () => {
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
