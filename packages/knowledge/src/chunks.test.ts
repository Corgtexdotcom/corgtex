import { describe, it, expect, vi, beforeEach } from "vitest";
import { getWorkspaceIndexingHealth, reindexWorkspace, syncKnowledgeForSource, syncBrainArticleKnowledge } from "./chunks";
import { prisma } from "@corgtex/shared";

vi.mock("@corgtex/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@corgtex/shared")>();
  return {
    ...actual,
    prisma: {
      $transaction: vi.fn(async (cb) => cb(prisma)),
      brainArticle: { findMany: vi.fn() },
      brainSource: { count: vi.fn() },
      document: { count: vi.fn(), findMany: vi.fn() },
      knowledgeChunk: { count: vi.fn(), findMany: vi.fn(), deleteMany: vi.fn(), createMany: vi.fn() },
      workflowJob: { findMany: vi.fn() },
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
});

vi.mock("@corgtex/models", () => ({
  defaultModelGateway: {
    embed: vi.fn().mockResolvedValue({ embeddings: [[1, 0]], usage: { model: "fake-embed" } }),
  },
  resolveModel: vi.fn().mockReturnValue("fake-model"),
}));

vi.mock("./retrieval", () => ({
  invalidateKnowledgeCache: vi.fn().mockResolvedValue(undefined),
}));

describe("Workspace Indexing Health", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should return healthy status when all articles have chunks", async () => {
    vi.mocked(prisma.brainArticle.findMany).mockResolvedValue([
      { id: "a1", title: "Article 1", slug: "a-1" } as any,
    ]);
    vi.mocked(prisma.brainSource.count).mockResolvedValue(1);
    vi.mocked(prisma.document.count).mockResolvedValue(0);
    vi.mocked(prisma.knowledgeChunk.count).mockResolvedValue(5);
    vi.mocked(prisma.workflowJob.findMany).mockResolvedValue([]);
    vi.mocked(prisma.knowledgeChunk.findMany).mockResolvedValue([
      { sourceId: "a1" } as any,
    ]);

    const health = await getWorkspaceIndexingHealth("ws_1");

    expect(health.status).toBe("healthy");
    expect(health.unchunkedArticles).toHaveLength(0);
    expect(health.metrics.totalArticles).toBe(1);
    expect(health.metrics.totalChunks).toBe(5);
  });

  it("should return degraded status when some articles lack chunks", async () => {
    vi.mocked(prisma.brainArticle.findMany).mockResolvedValue([
      { id: "a1", title: "Article 1", slug: "a-1" } as any,
      { id: "a2", title: "Article 2", slug: "a-2" } as any,
    ]);
    vi.mocked(prisma.brainSource.count).mockResolvedValue(2);
    vi.mocked(prisma.document.count).mockResolvedValue(0);
    vi.mocked(prisma.knowledgeChunk.count).mockResolvedValue(2);
    vi.mocked(prisma.workflowJob.findMany).mockResolvedValue([]);
    vi.mocked(prisma.knowledgeChunk.findMany).mockResolvedValue([
      { sourceId: "a1" } as any,
    ]);

    const health = await getWorkspaceIndexingHealth("ws_1");

    expect(health.status).toBe("degraded");
    expect(health.unchunkedArticles).toHaveLength(1);
    expect(health.unchunkedArticles[0].id).toBe("a2");
  });

  it("should return unhealthy status when all articles lack chunks", async () => {
    vi.mocked(prisma.brainArticle.findMany).mockResolvedValue([
      { id: "a1", title: "Article 1", slug: "a-1" } as any,
    ]);
    vi.mocked(prisma.brainSource.count).mockResolvedValue(1);
    vi.mocked(prisma.document.count).mockResolvedValue(0);
    vi.mocked(prisma.knowledgeChunk.count).mockResolvedValue(0);
    vi.mocked(prisma.workflowJob.findMany).mockResolvedValue([
      { type: "knowledge.sync.brain-article", error: "OpenAI error", createdAt: new Date() } as any,
    ]);
    vi.mocked(prisma.knowledgeChunk.findMany).mockResolvedValue([]);

    const health = await getWorkspaceIndexingHealth("ws_1");

    expect(health.status).toBe("unhealthy");
    expect(health.unchunkedArticles).toHaveLength(1);
    expect(health.recentErrors).toHaveLength(1);
    expect(health.recentErrors[0]).toContain("OpenAI error");
  });
});

describe("Workspace Reindex", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should reindex unchunked articles and documents", async () => {
    vi.mocked(prisma.brainArticle.findMany).mockResolvedValue([
      { id: "a1", title: "Article 1", bodyMd: "Body 1", slug: "a-1", type: "PRODUCT", authority: "REFERENCE" } as any,
      { id: "a2", title: "Article 2", bodyMd: "Body 2", slug: "a-2", type: "PROCESS", authority: "DRAFT" } as any,
    ]);
    vi.mocked(prisma.document.findMany).mockResolvedValue([
      { id: "d1", title: "Doc 1", textContent: "Text 1", source: "API", mimeType: "text/plain", storageKey: "d1.txt" } as any,
    ]);

    // a1 is chunked, a2 and d1 are not
    vi.mocked(prisma.knowledgeChunk.findMany).mockImplementation((async (args: any) => {
      const condition = args as any;
      if (condition.where?.sourceType === "BRAIN_ARTICLE") {
        return [{ sourceId: "a1" } as any];
      }
      return []; // No documents chunked
    }) as any);

    const result = await reindexWorkspace("ws_1");
    if (result.errors.length > 0) {
      console.error(result.errors);
    }
    expect(result.reindexedArticles).toBe(1);
    expect(result.reindexedDocuments).toBe(1);
    expect(result.errors).toHaveLength(0);

    const chunkModule = await import("./chunks");
    expect(chunkModule.reindexWorkspace).toBeDefined(); // Just to make sure we imported properly
    // Note: Since reindexWorkspace is in the same file as invalidateKnowledgeCache, 
    // it will call the real invalidateKnowledgeCache, not the mock we defined, because
    // of how module scopes work. So we just check the function executed without crashing.
  });
});
