import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock, modelGatewayMock } = vi.hoisted(() => {
  const knowledgeChunkMock = {
    findMany: vi.fn(),
    deleteMany: vi.fn(),
    createMany: vi.fn(),
  };
  return {
    prismaMock: {
      $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback({ knowledgeChunk: knowledgeChunkMock })),
      knowledgeChunk: knowledgeChunkMock,
    },
    modelGatewayMock: {
      embed: vi.fn(async ({ input }: { input: string | string[] }) => {
        const values = Array.isArray(input) ? input : [input];
        return {
          embeddings: values.map(() => [1, 0]),
          usage: {
            provider: "test",
            model: "fake-embed",
          },
        };
      }),
      rerank: vi.fn(async ({ documents, topK }: { documents: string[]; topK: number }) => ({
        results: documents.slice(0, topK).map((_, index) => ({
          index,
          score: 0.9 - (index * 0.1),
        })),
        usage: {
          model: "fake-rerank",
        },
      })),
      chat: vi.fn(async () => ({
        content: "Grounded answer",
        usage: {
          model: "fake-chat",
        },
      })),
    },
  };
});

vi.mock("@corgtex/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@corgtex/shared")>();
  return {
    ...actual,
    prisma: prismaMock,
  };
});

vi.mock("@corgtex/models", async () => ({
  ...await import("../../models/src/provider-errors"),
  defaultModelGateway: modelGatewayMock,
  resolveModel: vi.fn().mockReturnValue("fake-model"),
}));

import { syncKnowledgeForSource } from "./chunks";
import { ModelProviderHttpError } from "../../models/src/provider-errors";
import { logger, resetLocalCacheStore } from "@corgtex/shared";
import { answerKnowledgeQuestion, searchIndexedKnowledge, invalidateKnowledgeCache } from "./retrieval";

describe("knowledge retrieval cache", () => {
  beforeEach(async () => {
    delete process.env.KNOWLEDGE_SEARCH_PROVIDER;
    delete process.env.AZURE_SEARCH_ENDPOINT;
    delete process.env.AZURE_SEARCH_INDEX_NAME;
    delete process.env.AZURE_SEARCH_ADMIN_KEY;
    delete process.env.AZURE_SEARCH_QUERY_KEY;
    delete process.env.AZURE_SEARCH_VECTOR_DIMENSIONS;
    resetLocalCacheStore();
    await invalidateKnowledgeCache();

    prismaMock.knowledgeChunk.findMany.mockReset();
    prismaMock.knowledgeChunk.deleteMany.mockReset();
    prismaMock.knowledgeChunk.createMany.mockReset();
    modelGatewayMock.embed.mockClear();
    modelGatewayMock.rerank.mockClear();
    modelGatewayMock.chat.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reuses cached search results for repeated queries", async () => {
    prismaMock.knowledgeChunk.findMany.mockResolvedValue([
      {
        id: "chunk-1",
        sourceType: "DOCUMENT",
        sourceId: "doc-1",
        sourceTitle: "Policy",
        chunkIndex: 0,
        content: "Budget policy for travel reimbursement.",
        embedding: [1, 0],
        createdAt: new Date("2026-04-03T09:00:00.000Z"),
      },
    ]);

    const first = await searchIndexedKnowledge({
      workspaceId: "ws-1",
      query: "travel reimbursement policy",
      limit: 3,
    });
    const second = await searchIndexedKnowledge({
      workspaceId: "ws-1",
      query: "travel reimbursement policy",
      limit: 3,
    });

    expect(first).toEqual(second);
    expect(prismaMock.knowledgeChunk.findMany).toHaveBeenCalledTimes(2);
    expect(prismaMock.knowledgeChunk.findMany.mock.calls[0]?.[0]).toMatchObject({
      where: { accessDomain: { in: ["WORKSPACE"] } },
    });
    expect(modelGatewayMock.embed).toHaveBeenCalledTimes(1);
    expect(modelGatewayMock.rerank).toHaveBeenCalledTimes(1);
  });

  it("returns authorized positive lexical matches when query embedding is rate limited", async () => {
    const chunk = { id: "allowed", sourceType: "DOCUMENT", sourceId: "doc-allowed", sourceTitle: "Travel policy", chunkIndex: 0, content: "Travel reimbursement policy.", createdAt: new Date("2026-04-03T09:00:00Z") };
    prismaMock.knowledgeChunk.findMany
      .mockResolvedValueOnce([{ ...chunk, id: "withdrawn" }, chunk, { ...chunk, id: "unrelated", sourceTitle: "Other", content: "Bananas and pears" }])
      .mockResolvedValueOnce([{ id: "allowed", embedding: [1, 0] }, { id: "unrelated", embedding: [1, 0] }]);
    modelGatewayMock.embed.mockRejectedValueOnce(new ModelProviderHttpError(429, "provider fixture throttled"));

    const result = await searchIndexedKnowledge({ workspaceId: "ws-1", query: "travel policy", limit: 1, sourceTypes: ["DOCUMENT"], accessDomains: ["WORKSPACE"], maxSensitivity: "INTERNAL" });

    expect(result).toEqual([expect.objectContaining({ chunkId: "allowed", sourceId: "doc-allowed", snippet: chunk.content, score: expect.any(Number) })]);
    expect(modelGatewayMock.rerank).not.toHaveBeenCalled();
    expect(modelGatewayMock.embed).toHaveBeenCalledWith(expect.objectContaining({ failFastOnRateLimit: true }));
    expect(prismaMock.knowledgeChunk.findMany.mock.calls[0][0]).toMatchObject({ where: { workspaceId: "ws-1", sourceType: "DOCUMENT", accessDomain: { in: ["WORKSPACE"] }, sensitivity: { in: ["PUBLIC", "INTERNAL"] } } });
    expect(prismaMock.knowledgeChunk.findMany.mock.calls[1][0]).toMatchObject({ where: { workspaceId: "ws-1", accessDomain: { in: ["WORKSPACE"] }, sourceType: { in: ["DOCUMENT"] }, sensitivity: { in: ["PUBLIC", "INTERNAL"] } } });
    expect(await searchIndexedKnowledge({ workspaceId: "ws-1", query: "travel policy", limit: 1, sourceTypes: ["DOCUMENT"], accessDomains: ["WORKSPACE"], maxSensitivity: "INTERNAL" })).toEqual(result);
    expect(modelGatewayMock.embed).toHaveBeenCalledTimes(1);
  });

  it("returns the combined ranking when reranking is rate limited", async () => {
    const chunk = { id: "lexical", sourceType: "DOCUMENT", sourceId: "doc-1", sourceTitle: "Policy", chunkIndex: 0, content: "travel policy", createdAt: new Date("2026-04-03T09:00:00Z") };
    prismaMock.knowledgeChunk.findMany
      .mockResolvedValueOnce([chunk, { ...chunk, id: "semantic", content: "travel" }])
      .mockResolvedValueOnce([{ id: "lexical", embedding: [-1, 0] }, { id: "semantic", embedding: [1, 0] }]);
    modelGatewayMock.rerank.mockRejectedValueOnce(new ModelProviderHttpError(429, "provider fixture throttled"));
    const result = await searchIndexedKnowledge({ workspaceId: "ws-1", query: "travel policy", limit: 1 });
    expect(result).toEqual([expect.objectContaining({ chunkId: "semantic", score: expect.any(Number) })]);
    expect(modelGatewayMock.embed).toHaveBeenCalledTimes(1);
    expect(modelGatewayMock.rerank).toHaveBeenCalledWith(expect.objectContaining({ failFastOnRateLimit: true }));
  });

  it.each(["embed", "rerank"] as const)("does not conceal non-provider429 or other %s failures", async (stage) => {
    const chunk = { id: "chunk-error", sourceType: "DOCUMENT", sourceId: "doc-error", sourceTitle: "Policy", chunkIndex: 0, content: "travel policy", embedding: [1, 0], createdAt: new Date("2026-04-03T09:00:00Z") };
    prismaMock.knowledgeChunk.findMany.mockResolvedValue([chunk]);
    for (const error of [new ModelProviderHttpError(401, "auth fixture"), new ModelProviderHttpError(503, "unavailable fixture"), new Error("429 appears in unrelated error text"), Object.assign(new Error("budget fixture"), { status: 429 })]) {
      modelGatewayMock[stage].mockRejectedValueOnce(error);
      await expect(searchIndexedKnowledge({ workspaceId: "ws-1", query: "travel policy" })).rejects.toBe(error);
    }
  });

  it("does not return zero-lexical matches or log provider content on query429", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      prismaMock.knowledgeChunk.findMany.mockResolvedValue([{ id: "unrelated", sourceType: "DOCUMENT", sourceId: "doc-other", sourceTitle: "Other", chunkIndex: 0, content: "Bananas and pears", embedding: [1, 0], createdAt: new Date("2026-04-03T09:00:00Z") }]);
      modelGatewayMock.embed.mockRejectedValueOnce(new ModelProviderHttpError(429, "PRIVATE_PROVIDER_CONTENT"));
      expect(await searchIndexedKnowledge({ workspaceId: "ws-1", query: "travel policy" })).toEqual([]);
      expect(modelGatewayMock.rerank).not.toHaveBeenCalled();
      expect(JSON.stringify(warn.mock.calls)).not.toContain("PRIVATE_PROVIDER_CONTENT");
      expect(warn).toHaveBeenCalledWith(expect.any(String), { workspaceId: "ws-1", stage: "query_embedding", httpStatus: 429 });
    } finally {
      warn.mockRestore();
    }
  });

  it("partitions search caches by the normalized access-domain set", async () => {
    prismaMock.knowledgeChunk.findMany.mockResolvedValue([
      {
        id: "chunk-domain",
        sourceType: "DOCUMENT",
        sourceId: "doc-domain",
        sourceTitle: "Policy",
        chunkIndex: 0,
        content: "Finance policy for approvals.",
        embedding: [1, 0],
      },
    ]);

    await searchIndexedKnowledge({
      workspaceId: "ws-1",
      query: "finance policy",
      accessDomains: ["WORKSPACE"],
    });
    await searchIndexedKnowledge({
      workspaceId: "ws-1",
      query: "finance policy",
      accessDomains: ["WORKSPACE", "FINANCE", "WORKSPACE"],
    });
    await searchIndexedKnowledge({
      workspaceId: "ws-1",
      query: "finance policy",
      accessDomains: ["FINANCE", "WORKSPACE"],
    });

    expect(prismaMock.knowledgeChunk.findMany).toHaveBeenCalledTimes(4);
    expect(prismaMock.knowledgeChunk.findMany.mock.calls[2]?.[0]).toMatchObject({
      where: { accessDomain: { in: ["FINANCE", "WORKSPACE"] } },
    });
    expect(modelGatewayMock.embed).toHaveBeenCalledTimes(2);
    expect(modelGatewayMock.rerank).toHaveBeenCalledTimes(2);
  });

  it("reuses cached grounded answers for repeated questions", async () => {
    prismaMock.knowledgeChunk.findMany.mockResolvedValue([
      {
        id: "chunk-2",
        sourceType: "PROPOSAL",
        sourceId: "proposal-1",
        sourceTitle: "Finance policy",
        chunkIndex: 0,
        content: "Finance approvals require a steward review.",
        embedding: [1, 0],
        createdAt: new Date("2026-04-03T09:00:00.000Z"),
      },
    ]);

    const first = await answerKnowledgeQuestion({
      workspaceId: "ws-1",
      question: "Who reviews finance approvals?",
      limit: 4,
    });
    const second = await answerKnowledgeQuestion({
      workspaceId: "ws-1",
      question: "Who reviews finance approvals?",
      limit: 4,
    });

    expect(first).toEqual(second);
    expect(modelGatewayMock.chat).toHaveBeenCalledTimes(1);
    expect(modelGatewayMock.embed).toHaveBeenCalledTimes(1);
    expect(modelGatewayMock.rerank).toHaveBeenCalledTimes(1);
  });

  it("partitions grounded-answer caches by access domain and source type", async () => {
    prismaMock.knowledgeChunk.findMany.mockResolvedValue([
      {
        id: "chunk-answer-domain",
        sourceType: "DOCUMENT",
        sourceId: "doc-answer-domain",
        sourceTitle: "Finance policy",
        chunkIndex: 0,
        content: "Finance approvals require a steward review.",
        embedding: [1, 0],
      },
    ]);

    await answerKnowledgeQuestion({
      workspaceId: "ws-1",
      question: "Who reviews finance approvals?",
      accessDomains: ["WORKSPACE"],
    });
    await answerKnowledgeQuestion({
      workspaceId: "ws-1",
      question: "Who reviews finance approvals?",
      accessDomains: ["WORKSPACE", "FINANCE"],
    });
    await answerKnowledgeQuestion({
      workspaceId: "ws-1",
      question: "Who reviews finance approvals?",
      accessDomains: ["WORKSPACE", "FINANCE"],
      sourceTypes: ["DOCUMENT"],
    });

    expect(modelGatewayMock.chat).toHaveBeenCalledTimes(3);
    expect(modelGatewayMock.embed).toHaveBeenCalledTimes(3);
    expect(modelGatewayMock.rerank).toHaveBeenCalledTimes(3);
  });

  it("returns no results or citations for an explicitly empty domain set", async () => {
    await expect(searchIndexedKnowledge({
      workspaceId: "ws-1",
      query: "finance",
      accessDomains: [],
    })).resolves.toEqual([]);
    await expect(answerKnowledgeQuestion({
      workspaceId: "ws-1",
      question: "finance",
      accessDomains: [],
    })).resolves.toEqual({
      answer: "I could not find relevant indexed knowledge for that question.",
      citations: [],
    });

    expect(prismaMock.knowledgeChunk.findMany).not.toHaveBeenCalled();
    expect(modelGatewayMock.embed).not.toHaveBeenCalled();
    expect(modelGatewayMock.chat).not.toHaveBeenCalled();
  });

  it("does not alias the default answer limit with an explicit smaller limit", async () => {
    prismaMock.knowledgeChunk.findMany.mockResolvedValue([
      {
        id: "chunk-2",
        sourceType: "PROPOSAL",
        sourceId: "proposal-1",
        sourceTitle: "Finance policy",
        chunkIndex: 0,
        content: "Finance approvals require a steward review.",
        embedding: [1, 0],
        createdAt: new Date("2026-04-03T09:00:00.000Z"),
      },
    ]);

    await answerKnowledgeQuestion({
      workspaceId: "ws-1",
      question: "Who reviews finance approvals?",
    });
    await answerKnowledgeQuestion({
      workspaceId: "ws-1",
      question: "Who reviews finance approvals?",
      limit: 4,
    });

    expect(modelGatewayMock.chat).toHaveBeenCalledTimes(2);
    expect(modelGatewayMock.embed).toHaveBeenCalledTimes(2);
    expect(modelGatewayMock.rerank).toHaveBeenCalledTimes(2);
  });

  it("keeps a 500-chunk Postgres candidate window per requested source type", async () => {
    prismaMock.knowledgeChunk.findMany.mockResolvedValue([
      {
        id: "chunk-brain",
        sourceType: "BRAIN_ARTICLE",
        sourceId: "article-1",
        sourceTitle: "Brain article",
        chunkIndex: 0,
        content: "Brain article content about deployment runbooks.",
        embedding: [1, 0],
        createdAt: new Date("2026-04-03T09:00:00.000Z"),
      },
    ]);

    await searchIndexedKnowledge({
      workspaceId: "ws-1",
      query: "deployment runbooks",
      sourceTypes: ["BRAIN_ARTICLE", "DOCUMENT", "MEETING"],
      limit: 3,
    });

    expect(prismaMock.knowledgeChunk.findMany.mock.calls.slice(0, 3).map(([query]) => query))
      .toEqual(["BRAIN_ARTICLE", "DOCUMENT", "MEETING"].map((sourceType) => expect.objectContaining({
        where: expect.objectContaining({ sourceType }),
        take: 500,
      })));
  });

  it("invalidates cached retrieval when a source is resynced", async () => {
    prismaMock.knowledgeChunk.findMany.mockResolvedValue([
      {
        id: "chunk-3",
        sourceType: "DOCUMENT",
        sourceId: "doc-2",
        sourceTitle: "Draft policy",
        chunkIndex: 0,
        content: "Old policy language.",
        embedding: [1, 0],
        createdAt: new Date("2026-04-03T09:00:00.000Z"),
      },
    ]);

    await searchIndexedKnowledge({
      workspaceId: "ws-1",
      query: "policy language",
      limit: 2,
    });

    modelGatewayMock.embed.mockClear();
    modelGatewayMock.rerank.mockClear();

    await syncKnowledgeForSource({
      workspaceId: "ws-1",
      sourceType: "DOCUMENT",
      accessDomain: "WORKSPACE",
      sourceId: "doc-2",
      sourceTitle: "Updated policy",
      content: "New policy language with clarified approval steps.",
    });

    prismaMock.knowledgeChunk.findMany.mockResolvedValue([
      {
        id: "chunk-4",
        sourceType: "DOCUMENT",
        sourceId: "doc-2",
        sourceTitle: "Updated policy",
        chunkIndex: 0,
        content: "New policy language with clarified approval steps.",
        embedding: [1, 0],
        createdAt: new Date("2026-04-03T09:05:00.000Z"),
      },
    ]);

    await searchIndexedKnowledge({
      workspaceId: "ws-1",
      query: "policy language",
      limit: 2,
    });

    expect(prismaMock.knowledgeChunk.deleteMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.knowledgeChunk.createMany).toHaveBeenCalledTimes(1);
    expect(modelGatewayMock.embed).toHaveBeenCalledTimes(2);
    expect(modelGatewayMock.rerank).toHaveBeenCalledTimes(1);
  });

  it("preserves reserved chunk metadata when syncing a source", async () => {
    await syncKnowledgeForSource({
      workspaceId: "ws-1",
      sourceType: "DOCUMENT",
      accessDomain: "WORKSPACE",
      sourceId: "doc-3",
      sourceTitle: "Policy",
      content: "Chunk me",
      metadata: {
        chunkIndex: 99,
        sourceType: "PROPOSAL",
        custom: "value",
      },
    });

    expect(prismaMock.knowledgeChunk.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          id: expect.any(String),
          metadata: expect.objectContaining({
            chunkIndex: 0,
            sourceType: "DOCUMENT",
            custom: "value",
          }),
        }),
      ],
    });
  });

  it("falls back to domain-filtered Postgres retrieval when a query-only Azure index is not upgraded", async () => {
    process.env.KNOWLEDGE_SEARCH_PROVIDER = "azure";
    process.env.AZURE_SEARCH_ENDPOINT = "https://corgtex-search.search.windows.net";
    process.env.AZURE_SEARCH_INDEX_NAME = "client-knowledge";
    process.env.AZURE_SEARCH_QUERY_KEY = "query-key";
    process.env.AZURE_SEARCH_VECTOR_DIMENSIONS = "2";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      error: { message: "Invalid expression: Could not find a property named 'accessDomain'." },
    }), { status: 400 })));

    prismaMock.knowledgeChunk.findMany.mockResolvedValue([
      {
        id: "chunk-5",
        sourceType: "DOCUMENT",
        sourceId: "doc-5",
        sourceTitle: "Fallback policy",
        chunkIndex: 0,
        content: "Fallback policy mentions travel.",
        embedding: [1, 0],
        createdAt: new Date("2026-04-03T09:00:00.000Z"),
      },
    ]);

    const results = await searchIndexedKnowledge({
      workspaceId: "ws-1",
      query: "travel policy",
      limit: 2,
      accessDomains: ["FINANCE"],
    });

    expect(results[0]).toMatchObject({
      chunkId: "chunk-5",
      sourceType: "DOCUMENT",
      sourceId: "doc-5",
    });
    expect(prismaMock.knowledgeChunk.findMany.mock.calls[0]?.[0]).toMatchObject({
      where: { accessDomain: { in: ["FINANCE"] } },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(modelGatewayMock.embed).toHaveBeenCalledTimes(2);
    expect(modelGatewayMock.rerank).toHaveBeenCalledTimes(1);
  });
});
