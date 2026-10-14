import type { AppActor } from "@corgtex/shared";
import type { ModelGateway } from "@corgtex/models";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock, modelGatewayMock } = vi.hoisted(() => {
  const knowledgeChunkMock = {
    findMany: vi.fn(),
    deleteMany: vi.fn(),
    createMany: vi.fn(),
  };
  return {
    prismaMock: {
      $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback({ ...prismaMock })),
      $queryRaw: vi.fn(async () => []),
      knowledgeChunk: knowledgeChunkMock,
      workspace: { findUnique: vi.fn() },
      agentCredential: { findFirst: vi.fn() },
      modelUsage: { create: vi.fn(), count: vi.fn(), findMany: vi.fn() },
      aiUsageLedgerEntry: { create: vi.fn() },
      brainArticle: { findMany: vi.fn() },
      document: { findMany: vi.fn(), findFirst: vi.fn() },
      meeting: { findMany: vi.fn() },
      proposal: { findMany: vi.fn() },
      externalContentSource: { findFirst: vi.fn(), findMany: vi.fn(async () => []) },
      sqlNativeRunInput: { findMany: vi.fn(async () => []) },
    },
    modelGatewayMock: {
      embed: vi.fn<ModelGateway["embed"]>(async ({ input }) => {
        const values = Array.isArray(input) ? input : [input];
        return {
          embeddings: values.map(() => [1, 0]),
          usage: {
            provider: "test",
            model: "fake-embed",
          },
        };
      }),
      rerank: vi.fn<ModelGateway["rerank"]>(async ({ documents, topK }) => ({
        results: documents.slice(0, topK).map((document, index) => ({
          index,
          document,
          score: 0.9 - (index * 0.1),
        })),
        usage: {
          provider: "test",
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
    env: new Proxy(actual.env, {
      get(target, key) {
        const fixture = { MODEL_PROVIDER: "openai", MODEL_BASE_URL: "https://model.fixture.invalid/v1",
          MODEL_API_KEY: "synthetic-test-key", MODEL_PROVIDER_ROUTES_JSON: undefined,
          MODEL_EMBEDDING_DEFAULT: "text-embedding-3-small" };
        return Object.hasOwn(fixture, key) ? fixture[key as keyof typeof fixture] : Reflect.get(target, key);
      },
    }),
  };
});

vi.mock("@corgtex/models", async (importOriginal) => ({
  ...await importOriginal<typeof import("@corgtex/models")>(),
  defaultModelGateway: modelGatewayMock,
  resolveModel: vi.fn().mockReturnValue("fake-model"),
}));

vi.mock("@corgtex/domain", () => {
  // Cache/gateway cases use synthetic source proofs. Actual source authority and
  // native provider publication are covered by the lineage and PG caller suites.
  const preflights = new WeakMap<object, { actor: unknown; workspaceId: string; roots: unknown }>();
  return {
    assertArtifactInputWriteFence: vi.fn().mockResolvedValue(undefined),
    recordArtifactInputLineage: vi.fn().mockResolvedValue(undefined),
    resolveKnowledgeAccessDomains: vi.fn(async () => ["WORKSPACE", "FINANCE"]),
    readableArtifactIds: vi.fn(async (_actor, _workspaceId, _kind, rows) => new Set(rows.map((row: any) => row.id))),
    lineageContentFingerprint: (kind: string, row: any) => `${kind}:${row.id}`,
    captureArtifactInputProof: vi.fn(async (_actor, _workspaceId, inputs) => inputs.map((input: any) => ({ kind: input.kind, id: input.id, fingerprint: `${input.kind}:${input.id}` }))),
    captureImmutableArtifactInputProof: vi.fn(async (_actor, _workspaceId, roots) => roots),
    prepareArtifactCommitPreflight: vi.fn(async (actor, workspaceId, roots) => {
      const token = Object.freeze({});
      preflights.set(token, { actor, workspaceId, roots: structuredClone(roots) });
      return token;
    }),
    withArtifactCommitPreflight: vi.fn(async (actor, workspaceId, tx, roots, token, work) => {
      const saved = preflights.get(token);
      if (!saved || saved.actor !== actor || saved.workspaceId !== workspaceId || tx === prismaMock
        || JSON.stringify(saved.roots) !== JSON.stringify(roots)) throw new Error("Synthetic commit binding changed.");
      preflights.delete(token);
      return work();
    }),
    isArtifactInputProofReadable: vi.fn().mockResolvedValue(true),
  };
});

let persistedChunks: any[] = [];
const persistedRows = (where: any) => structuredClone(persistedChunks.filter(row => row.workspaceId === where.workspaceId && where.id.in.includes(row.id)));

const actor: AppActor = { kind: "user", user: { id: "synthetic-user", email: "synthetic@example.test", displayName: "Synthetic user" } };
const sourceKinds: Record<string, string> = { DOCUMENT: "Document", BRAIN_ARTICLE: "BrainArticle", MEETING: "Meeting", PROPOSAL: "Proposal" };
// Existing cache/provider regressions use certified synthetic receipts. The lineage
// suite separately exercises unknown and permission-revoked source proofs.
const allSourceIds = ["doc-1", "doc-2", "doc-5", "doc-allowed", "doc-error", "doc-other", "doc-domain", "doc-answer-domain", "doc-ledger", "article-1", "old-article", "archived-article", "proposal-1"];
function certifyRows(rows: any[]) {
  return rows.map((row) => row.sourceType && row.sourceId ? {
    createdAt: new Date("2026-04-03T09:00:00Z"), ...row, metadata: { ...row.metadata, sourceContentHash: `${sourceKinds[row.sourceType]}:${row.sourceId}` },
  } : row);
}
import { openAICompatibleModelGateway } from "../../models/src/openai-compatible-gateway";
import { CatalogBudgetError, WorkspaceModelBudgetError } from "../../models/src/usage";
import { syncKnowledgeForSource } from "./chunks";
import { ModelProviderHttpError } from "../../models/src/provider-errors";
import { logger, resetLocalCacheStore } from "@corgtex/shared";
import { answerKnowledgeQuestion, searchIndexedKnowledge, invalidateKnowledgeCache } from "./retrieval";
import { readableArtifactIds } from "@corgtex/domain";

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

    persistedChunks = [];
    prismaMock.knowledgeChunk.findMany.mockReset().mockImplementation(async ({ where, select }: any) =>
      !select && where.id?.in ? persistedRows(where) : []);
    prismaMock.brainArticle.findMany.mockReset().mockImplementation(async ({ where }: any) =>
      (where.id?.in ?? allSourceIds).map((id: string) => ({ id })));
    prismaMock.document.findMany.mockReset().mockResolvedValue(certifyRows([]));
    prismaMock.knowledgeChunk.deleteMany.mockReset();
    prismaMock.knowledgeChunk.createMany.mockReset().mockImplementation(async ({ data }: any) => {
      persistedChunks.push(...structuredClone(data)); return { count: data.length };
    });
    prismaMock.brainArticle.findMany.mockReset().mockImplementation(async (query) =>
      (query.where.id?.in ?? allSourceIds).map((id: string) => ({ id })));
    prismaMock.document.findMany.mockReset().mockImplementation(async (query) =>
      (query.where.id?.in ?? allSourceIds).map((id: string) => ({ id })));
    prismaMock.meeting.findMany.mockReset().mockImplementation(async (query) => (query.where.id?.in ?? allSourceIds).map((id: string) => ({ id })));
    prismaMock.proposal.findMany.mockReset().mockImplementation(async (query) => (query.where.id?.in ?? allSourceIds).map((id: string) => ({ id })));
    vi.mocked(readableArtifactIds).mockImplementation(async (_actor, _workspaceId, _kind, rows) => new Set(rows.map(row => row.id)));
    modelGatewayMock.embed.mockClear();
    modelGatewayMock.rerank.mockClear();
    modelGatewayMock.chat.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  describe("credential accounting through the real gateway", () => {
    const scope = { workspaceId: "ws-1", catalogItemId: "catalog-1", agentCredentialId: "credential-1" };
    const searchScope = { ...scope, actor };
    const chunk = certifyRows([{ id: "ledger-chunk", sourceType: "DOCUMENT", sourceId: "doc-ledger", sourceTitle: "Travel policy",
      chunkIndex: 0, content: "Travel approval policy.", embedding: [1, 0], createdAt: new Date("2026-04-03T09:00:00Z") }])[0];
    let ledger: Array<Record<string, any>>;
    let modelRequests: number;
    let azureRequests: number;
    let azureStatus: number;
    let azureHits: Array<Record<string, unknown>>;

    beforeEach(() => {
      ledger = [];
      modelRequests = 0;
      azureRequests = 0;
      azureStatus = 200;
      azureHits = [{ ...chunk, "@search.score": 1 }];
      vi.stubEnv("MODEL_PRICE_OVERRIDES_JSON", "");
      prismaMock.knowledgeChunk.findMany.mockResolvedValue([chunk]);
      prismaMock.workspace.findUnique.mockReset().mockResolvedValue({ plan: "PRO", modelUsageBudget: null });
      prismaMock.agentCredential.findFirst.mockReset().mockResolvedValue({
        catalogItemId: scope.catalogItemId, isActive: true, dailyCallLimit: null, monthlyBudgetCents: null, catalogItem: null,
      });
      // Only the real gateway writes this ledger. The real budget gate reads it
      // back with credential/workspace/time filters on each subsequent operation.
      const matching = (where: Record<string, any>) => ledger.filter((row) =>
        row.workspaceId === where.workspaceId
        && (!where.agentCredentialId || row.agentCredentialId === where.agentCredentialId)
        && (!where.catalogItemId || row.catalogItemId === where.catalogItemId)
        && (!where.createdAt?.gte || row.createdAt >= where.createdAt.gte));
      prismaMock.modelUsage.create.mockReset().mockImplementation(async ({ data }) => {
        const row = { ...data, id: `usage-${ledger.length + 1}`, createdAt: new Date() };
        ledger.push(row);
        return row;
      });
      prismaMock.modelUsage.count.mockReset().mockImplementation(async ({ where }) => matching(where).length);
      prismaMock.modelUsage.findMany.mockReset().mockImplementation(async ({ where }) => matching(where));
      prismaMock.aiUsageLedgerEntry.create.mockReset().mockResolvedValue({});
      vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
        if (String(url) === "https://model.fixture.invalid/v1/embeddings") {
          modelRequests++;
          const { input } = JSON.parse(String(init?.body));
          return new Response(JSON.stringify({ data: input.map(() => ({ embedding: [1, 0] })), usage: { prompt_tokens: 1_000_000 } }), { status: 200 });
        }
        if (String(url).startsWith("https://search.fixture.invalid/")) {
          azureRequests++;
          return new Response(JSON.stringify({ value: azureHits }), { status: azureStatus });
        }
        throw new Error(`Unexpected network request blocked: ${url}`);
      }));
    });

    function useAzure(provider = "azure") {
      vi.stubEnv("KNOWLEDGE_SEARCH_PROVIDER", provider);
      vi.stubEnv("AZURE_SEARCH_ENDPOINT", "https://search.fixture.invalid");
      vi.stubEnv("AZURE_SEARCH_INDEX_NAME", "synthetic-knowledge");
      vi.stubEnv("AZURE_SEARCH_QUERY_KEY", "synthetic-test-key");
      vi.stubEnv("AZURE_SEARCH_VECTOR_DIMENSIONS", "2");
    }

    async function withRealGateway(run: () => Promise<void>) {
      const embed = modelGatewayMock.embed.getMockImplementation()!;
      const rerank = modelGatewayMock.rerank.getMockImplementation()!;
      try {
        modelGatewayMock.embed.mockImplementation(openAICompatibleModelGateway.embed);
        modelGatewayMock.rerank.mockImplementation(openAICompatibleModelGateway.rerank);
        await run();
      } finally {
        modelGatewayMock.embed.mockImplementation(embed);
        modelGatewayMock.rerank.mockImplementation(rerank);
      }
    }

    function expectUsage(tasks: string[]) {
      expect(ledger.map((row) => row.taskType)).toEqual(tasks);
      expect(modelRequests).toBe(tasks.length);
      expect(prismaMock.aiUsageLedgerEntry.create).toHaveBeenCalledTimes(tasks.length);
      for (const row of ledger) expect(row).toMatchObject({
        ...scope, provider: "openai", model: "text-embedding-3-small", inputTokens: 1_000_000,
        rawProviderCostUsd: "0.020000", billableCostUsd: "0.040000",
      });
      for (const [index, [{ data }]] of prismaMock.aiUsageLedgerEntry.create.mock.calls.entries()) {
        expect(data).toMatchObject({ workspaceId: scope.workspaceId, modelUsageId: ledger[index].id, taskType: tasks[index], billableCostUsd: "0.040000" });
      }
    }

    it.each(["daily", "monthly"].flatMap((kind) => [2, 3, 4].map((allowance) => [kind, allowance] as const)))(
      "consumes the real %s ledger across distinct uncached reads (allowance=%s) and blocks synthesis",
      async (kind, allowance) => {
        prismaMock.agentCredential.findFirst.mockResolvedValue({
          catalogItemId: scope.catalogItemId, isActive: true, catalogItem: null,
          dailyCallLimit: kind === "daily" ? allowance : null,
          monthlyBudgetCents: kind === "monthly" ? allowance * 4 : null,
        });
        const failure = { code: kind === "daily" ? "CATALOG_DAILY_LIMIT_EXCEEDED" : "CATALOG_MONTHLY_BUDGET_EXCEEDED", status: 429 };
        await withRealGateway(async () => {
          const first = await searchIndexedKnowledge({ ...searchScope, query: "travel policy" });
          expect(first).toHaveLength(1);
          expectUsage(["EMBEDDING", "RERANK"]);
          expect(await searchIndexedKnowledge({ ...searchScope, query: "travel policy" })).toEqual(first);
          expectUsage(["EMBEDDING", "RERANK"]); // A cache hit invents no model usage.
          if (allowance === 4) {
            expect(await searchIndexedKnowledge({ ...searchScope, query: "approval policy" })).toHaveLength(1);
            await expect(searchIndexedKnowledge({ ...searchScope, query: "another travel policy" })).rejects.toMatchObject(failure);
          } else {
            // At two calls, the next embed is blocked. At three, its rerank is blocked.
            await expect(searchIndexedKnowledge({ ...searchScope, query: "approval policy" })).rejects.toMatchObject(failure);
          }
          await expect(openAICompatibleModelGateway.chat({ ...scope, model: "gpt-4o-mini", taskType: "AGENT",
            messages: [{ role: "user", content: "Synthesize the policy." }],
          })).rejects.toMatchObject(failure);
          expectUsage(["EMBEDDING", "RERANK", "EMBEDDING", "RERANK"].slice(0, allowance));
          expect(prismaMock.agentCredential.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: scope.agentCredentialId, workspaceId: scope.workspaceId } }));
        });
      },
    );

    it.each(["azure", "dual_compare", "provider fallback", "stale refill", "cache refill"])(
      "attributes every model operation on the %s path", async (path) => {
        useAzure(path === "dual_compare" ? "dual_compare" : "azure");
        if (path === "provider fallback") azureStatus = 503;
        if (path === "stale refill") azureHits = [{ ...chunk, id: "stale-chunk", "@search.score": 1 }];
        await withRealGateway(async () => {
          expect(await searchIndexedKnowledge({ ...searchScope, query: "travel policy" })).toHaveLength(1);
          if (path === "cache refill") {
            prismaMock.knowledgeChunk.findMany.mockResolvedValue([{ ...chunk, id: "replacement-chunk" }]);
            expect(await searchIndexedKnowledge({ ...searchScope, query: "travel policy" })).toEqual([
              expect.objectContaining({ chunkId: "replacement-chunk" }),
            ]);
          }
          expect(azureRequests).toBe(1);
          expectUsage(path === "cache refill" ? ["EMBEDDING", "RERANK", "EMBEDDING", "RERANK"]
            : path === "provider fallback" ? ["EMBEDDING", "EMBEDDING", "RERANK"] : ["EMBEDDING", "RERANK"]);
        });
      },
    );

    it.each(["daily", "monthly"])("does not restart dual comparison when reranking exhausts the real %s allowance", async (kind) => {
      useAzure("dual_compare");
      prismaMock.agentCredential.findFirst.mockResolvedValue({
        catalogItemId: scope.catalogItemId, isActive: true, catalogItem: null,
        dailyCallLimit: kind === "daily" ? 1 : null, monthlyBudgetCents: kind === "monthly" ? 4 : null,
      });
      await withRealGateway(async () => {
        await expect(searchIndexedKnowledge({ ...searchScope, query: "travel policy" })).rejects.toMatchObject({
          code: kind === "daily" ? "CATALOG_DAILY_LIMIT_EXCEEDED" : "CATALOG_MONTHLY_BUDGET_EXCEEDED", status: 429,
        });
        expect(azureRequests).toBe(1);
        expectUsage(["EMBEDDING"]);
        expect(modelGatewayMock.embed).toHaveBeenCalledOnce();
        expect(modelGatewayMock.rerank).toHaveBeenCalledOnce();
      });
    });

    it.each(["daily", "monthly", "workspace"])("does not retry Azure retrieval after a canonical %s refusal", async (kind) => {
      useAzure();
      const error = kind === "workspace"
        ? new WorkspaceModelBudgetError("AI_BUDGET_EXCEEDED", "Synthetic workspace budget refusal.")
        : new CatalogBudgetError(kind === "daily" ? "CATALOG_DAILY_LIMIT_EXCEEDED" : "CATALOG_MONTHLY_BUDGET_EXCEEDED", "Synthetic catalog budget refusal.");
      modelGatewayMock.embed.mockRejectedValueOnce(error);
      await expect(searchIndexedKnowledge({ ...searchScope, query: "travel policy" })).rejects.toBe(error);
      expect(modelGatewayMock.embed).toHaveBeenCalledOnce();
      expect(modelGatewayMock.rerank).not.toHaveBeenCalled();
      expect(prismaMock.knowledgeChunk.findMany).not.toHaveBeenCalled();
      expectUsage([]);
      expect(azureRequests).toBe(0);
    });
  });

  it("reuses cached search results for repeated queries", async () => {
    prismaMock.knowledgeChunk.findMany.mockResolvedValue(certifyRows([
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
    ]));

    const first = await searchIndexedKnowledge({ actor,
      workspaceId: "ws-1",
      query: "travel reimbursement policy",
      limit: 3,
    });
    const second = await searchIndexedKnowledge({ actor,
      workspaceId: "ws-1",
      query: "travel reimbursement policy",
      limit: 3,
    });

    expect(first).toEqual(second);
    expect(prismaMock.knowledgeChunk.findMany.mock.calls.filter(([query]) => query.take === 500)).toHaveLength(1);
    expect(prismaMock.knowledgeChunk.findMany.mock.calls[0]?.[0]).toMatchObject({
      where: { accessDomain: { in: ["WORKSPACE"] } },
    });
    expect(modelGatewayMock.embed).toHaveBeenCalledTimes(1);
    expect(modelGatewayMock.rerank).toHaveBeenCalledTimes(1);
  });

  it("drops cached document snippets and answers as soon as the source is archived", async () => {
    const chunk = { id: "cached-document", sourceType: "DOCUMENT", sourceId: "doc-1", sourceTitle: "Synthetic policy",
      chunkIndex: 0, content: "Withdrawn reimbursement policy.", embedding: [1, 0], createdAt: new Date() };
    prismaMock.knowledgeChunk.findMany.mockResolvedValue(certifyRows([chunk]));
    const question = "What is the reimbursement policy?";
    expect((await answerKnowledgeQuestion({ actor, workspaceId: "ws-1", question })).citations).toHaveLength(1);
    prismaMock.document.findMany.mockResolvedValue(certifyRows([]));
    expect(await searchIndexedKnowledge({ actor, workspaceId: "ws-1", query: question, limit: 8 })).toEqual([]);
    expect(await answerKnowledgeQuestion({ actor, workspaceId: "ws-1", question })).toEqual({
      answer: "I could not find relevant indexed knowledge for that question.", citations: [],
    });
    expect(modelGatewayMock.chat).toHaveBeenCalledTimes(1);
  });

  it("drops cached active-article snippets and answers when their SQL chunk receipt is removed", async () => {
    const chunk = { id: "old-article-chunk", sourceType: "BRAIN_ARTICLE", sourceId: "article-1",
      sourceTitle: "Synthetic article", chunkIndex: 0, content: "Withdrawn source claim", embedding: [1, 0], createdAt: new Date() };
    let current = true;
    prismaMock.knowledgeChunk.findMany.mockImplementation(async (query) => {
      if (query.select?.content) return certifyRows(current ? [chunk] : []);
      return certifyRows([chunk]);
    });
    const question = "What is the source claim?";
    expect((await answerKnowledgeQuestion({ actor, workspaceId: "ws-1", question })).citations).toHaveLength(1);
    current = false; // Reviewed regeneration has committed; the index worker is still paused.
    expect(await searchIndexedKnowledge({ actor, workspaceId: "ws-1", query: question, limit: 8 })).toEqual([]);
    expect(await answerKnowledgeQuestion({ actor, workspaceId: "ws-1", question })).toEqual({
      answer: "I could not find relevant indexed knowledge for that question.", citations: [],
    });
    expect(modelGatewayMock.chat).toHaveBeenCalledTimes(1);
  });

  it("discards an article result when reviewed regeneration commits during reranking or answering", async () => {
    const chunk = { id: "in-flight-article", sourceType: "BRAIN_ARTICLE", sourceId: "article-1",
      sourceTitle: "Synthetic article", chunkIndex: 0, content: "Withdrawn source claim", embedding: [1, 0], createdAt: new Date() };
    let current = true;
    prismaMock.knowledgeChunk.findMany.mockImplementation(async (query) => {
      if (query.select?.content) return certifyRows(current ? [chunk] : []);
      return certifyRows([chunk]);
    });
    let releaseRerank!: () => void;
    let rerankEntered!: () => void;
    const holdRerank = new Promise<void>((resolve) => { releaseRerank = resolve; });
    const enteredRerank = new Promise<void>((resolve) => { rerankEntered = resolve; });
    modelGatewayMock.rerank.mockImplementationOnce(async () => {
      rerankEntered();
      await holdRerank;
      return { results: [{ index: 0, score: 0.9, document: "Withdrawn source claim" }], usage: { provider: "test", model: "fake-rerank" } };
    });
    const query = "Withdrawn source claim";
    const inFlightSearch = searchIndexedKnowledge({ actor, workspaceId: "ws-1", query });
    await enteredRerank;
    current = false;
    releaseRerank();
    expect(await inFlightSearch).toEqual([]);

    current = true;
    await invalidateKnowledgeCache("ws-1");
    let releaseChat!: () => void;
    let chatEntered!: () => void;
    const holdChat = new Promise<void>((resolve) => { releaseChat = resolve; });
    const enteredChat = new Promise<void>((resolve) => { chatEntered = resolve; });
    modelGatewayMock.chat.mockImplementationOnce(async () => {
      chatEntered();
      await holdChat;
      return { content: "Stale answer", usage: { model: "fake-chat" } };
    });
    const inFlightAnswer = answerKnowledgeQuestion({ actor, workspaceId: "ws-1", question: query });
    await enteredChat;
    current = false;
    releaseChat();
    expect(await inFlightAnswer).toEqual({
      answer: "I could not find relevant indexed knowledge for that question.", citations: [],
    });
  });

  it("filters stale Azure hits for an active article until the new chunk exists in SQL", async () => {
    process.env.KNOWLEDGE_SEARCH_PROVIDER = "azure";
    process.env.AZURE_SEARCH_ENDPOINT = "https://corgtex-search.search.windows.net";
    process.env.AZURE_SEARCH_INDEX_NAME = "client-knowledge";
    process.env.AZURE_SEARCH_QUERY_KEY = "query-key";
    process.env.AZURE_SEARCH_VECTOR_DIMENSIONS = "2";
    let azureChunk = {
      id: "old-article-chunk", sourceType: "BRAIN_ARTICLE", sourceId: "article-1",
      sourceTitle: "Active article", chunkIndex: 0, content: "Withdrawn source claim", "@search.score": 2,
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ value: [azureChunk] }), { status: 200 })));
    prismaMock.knowledgeChunk.findMany.mockResolvedValue(certifyRows([]));

    expect(await searchIndexedKnowledge({ actor, workspaceId: "ws-1", query: "Withdrawn source claim" })).toEqual([]);
    expect(prismaMock.knowledgeChunk.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ workspaceId: "ws-1", accessDomain: { in: ["WORKSPACE"] } }),
      take: 500,
      select: expect.objectContaining({ id: true, sourceId: true, sourceType: true, chunkIndex: true, content: true, metadata: true }),
    }));
    azureChunk = { ...azureChunk, id: "new-article-chunk", content: "Verified remaining claim" };
    prismaMock.knowledgeChunk.findMany.mockResolvedValue(certifyRows([{
      id: azureChunk.id, sourceType: "BRAIN_ARTICLE", sourceId: "article-1", sourceTitle: "Active article", chunkIndex: 0, content: azureChunk.content,
    }]));
    await invalidateKnowledgeCache("ws-1");
    expect(await searchIndexedKnowledge({ actor, workspaceId: "ws-1", query: "remaining claim" })).toEqual([
      expect.objectContaining({ chunkId: "new-article-chunk", snippet: "Verified remaining claim" }),
    ]);
  });

  it("filters Azure hits against active article rows even if index cleanup has failed", async () => {
    process.env.KNOWLEDGE_SEARCH_PROVIDER = "azure";
    process.env.AZURE_SEARCH_ENDPOINT = "https://corgtex-search.search.windows.net";
    process.env.AZURE_SEARCH_INDEX_NAME = "client-knowledge";
    process.env.AZURE_SEARCH_QUERY_KEY = "query-key";
    process.env.AZURE_SEARCH_VECTOR_DIMENSIONS = "2";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ value: [{
      id: "stale-azure-chunk", sourceType: "BRAIN_ARTICLE", sourceId: "archived-article",
      sourceTitle: "Archived article", chunkIndex: 0, content: "Withdrawn claim", "@search.score": 2,
    }] }), { status: 200 })));
    prismaMock.brainArticle.findMany.mockResolvedValue(certifyRows([]));

    expect(await searchIndexedKnowledge({ actor, workspaceId: "ws-1", query: "Withdrawn claim" })).toEqual([]);
    expect(prismaMock.brainArticle.findMany).toHaveBeenCalledWith({ take: 5001, where: {
      workspaceId: "ws-1", archivedAt: null, OR: [{ isPrivate: false }, { variantOfArticleId: { not: null }, isPrivate: true }],
    } });
    expect(prismaMock.knowledgeChunk.findMany).not.toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ sourceType: "BRAIN_ARTICLE" }) }));
  });

  it("returns authorized positive lexical matches when query embedding is rate limited", async () => {
    const chunk = { id: "allowed", sourceType: "DOCUMENT", sourceId: "doc-allowed", sourceTitle: "Travel policy", chunkIndex: 0, content: "Travel reimbursement policy.", embedding: [1, 0], createdAt: new Date("2026-04-03T09:00:00Z") };
    prismaMock.knowledgeChunk.findMany
      .mockResolvedValue(certifyRows([chunk]))
      .mockResolvedValueOnce(certifyRows([{ ...chunk, id: "withdrawn" }, chunk, { ...chunk, id: "unrelated", sourceTitle: "Other", content: "Bananas and pears" }]));
    vi.mocked(readableArtifactIds).mockImplementation(async (_actor, _workspaceId, _kind, rows) => new Set(rows.filter(row => row.id !== "withdrawn").map(row => row.id)));
    modelGatewayMock.embed.mockRejectedValueOnce(new ModelProviderHttpError(429, "provider fixture throttled"));

    const result = await searchIndexedKnowledge({ actor, workspaceId: "ws-1", query: "travel policy", limit: 1, sourceTypes: ["DOCUMENT"], accessDomains: ["WORKSPACE"], maxSensitivity: "INTERNAL" });

    expect(result).toEqual([expect.objectContaining({ chunkId: "allowed", sourceId: "doc-allowed", snippet: chunk.content, score: expect.any(Number) })]);
    expect(modelGatewayMock.rerank).not.toHaveBeenCalled();
    expect(modelGatewayMock.embed).toHaveBeenCalledWith(expect.objectContaining({ failFastOnRateLimit: true }));
    expect(prismaMock.knowledgeChunk.findMany.mock.calls[0][0]).toMatchObject({ where: { workspaceId: "ws-1", sourceType: "DOCUMENT", accessDomain: { in: ["WORKSPACE"] }, sensitivity: { in: ["PUBLIC", "INTERNAL"] } } });
    expect(prismaMock.knowledgeChunk.findMany.mock.calls.every(([query]) => query.select?.embedding && query.select?.content)).toBe(true);
    expect(await searchIndexedKnowledge({ actor, workspaceId: "ws-1", query: "travel policy", limit: 1, sourceTypes: ["DOCUMENT"], accessDomains: ["WORKSPACE"], maxSensitivity: "INTERNAL" })).toEqual(result);
    expect(modelGatewayMock.embed).toHaveBeenCalledTimes(1);
  });

  it("returns the combined ranking when reranking is rate limited", async () => {
    const chunk = { id: "lexical", sourceType: "DOCUMENT", sourceId: "doc-1", sourceTitle: "Policy", chunkIndex: 0, content: "travel policy", embedding: [-1, 0], createdAt: new Date("2026-04-03T09:00:00Z") };
    prismaMock.knowledgeChunk.findMany
      .mockResolvedValue(certifyRows([{ ...chunk, id: "semantic", content: "travel", embedding: [1, 0] }]))
      .mockResolvedValueOnce(certifyRows([chunk, { ...chunk, id: "semantic", content: "travel", embedding: [1, 0] }]));
    modelGatewayMock.rerank.mockRejectedValueOnce(new ModelProviderHttpError(429, "provider fixture throttled"));
    const result = await searchIndexedKnowledge({ actor, workspaceId: "ws-1", query: "travel policy", limit: 1 });
    expect(result).toEqual([expect.objectContaining({ chunkId: "semantic", score: expect.any(Number) })]);
    expect(modelGatewayMock.embed).toHaveBeenCalledTimes(1);
    expect(modelGatewayMock.rerank).toHaveBeenCalledWith(expect.objectContaining({ failFastOnRateLimit: true }));
  });

  it.each(["embed", "rerank"] as const)("does not conceal non-provider429 or other %s failures", async (stage) => {
    const chunk = { id: "chunk-error", sourceType: "DOCUMENT", sourceId: "doc-error", sourceTitle: "Policy", chunkIndex: 0, content: "travel policy", embedding: [1, 0], createdAt: new Date("2026-04-03T09:00:00Z") };
    prismaMock.knowledgeChunk.findMany.mockResolvedValue(certifyRows([chunk]));
    for (const error of [new ModelProviderHttpError(401, "auth fixture"), new ModelProviderHttpError(503, "unavailable fixture"), new Error("429 appears in unrelated error text"), Object.assign(new Error("budget fixture"), { status: 429 })]) {
      modelGatewayMock[stage].mockRejectedValueOnce(error);
      await expect(searchIndexedKnowledge({ actor, workspaceId: "ws-1", query: "travel policy" })).rejects.toBe(error);
    }
  });

  it("does not return zero-lexical matches or log provider content on query429", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      prismaMock.knowledgeChunk.findMany.mockResolvedValue(certifyRows([{ id: "unrelated", sourceType: "DOCUMENT", sourceId: "doc-other", sourceTitle: "Other", chunkIndex: 0, content: "Bananas and pears", embedding: [1, 0], createdAt: new Date("2026-04-03T09:00:00Z") }]));
      modelGatewayMock.embed.mockRejectedValueOnce(new ModelProviderHttpError(429, "PRIVATE_PROVIDER_CONTENT"));
      expect(await searchIndexedKnowledge({ actor, workspaceId: "ws-1", query: "travel policy" })).toEqual([]);
      expect(modelGatewayMock.rerank).not.toHaveBeenCalled();
      expect(JSON.stringify(warn.mock.calls)).not.toContain("PRIVATE_PROVIDER_CONTENT");
      expect(warn).toHaveBeenCalledWith(expect.any(String), { workspaceId: "ws-1", stage: "query_embedding", httpStatus: 429 });
    } finally {
      warn.mockRestore();
    }
  });

  it("partitions search caches by the normalized access-domain set", async () => {
    prismaMock.knowledgeChunk.findMany.mockResolvedValue(certifyRows([
      {
        id: "chunk-domain",
        sourceType: "DOCUMENT",
        sourceId: "doc-domain",
        sourceTitle: "Policy",
        chunkIndex: 0,
        content: "Finance policy for approvals.",
        embedding: [1, 0],
      },
    ]));

    await searchIndexedKnowledge({ actor,
      workspaceId: "ws-1",
      query: "finance policy",
      accessDomains: ["WORKSPACE"],
    });
    await searchIndexedKnowledge({ actor,
      workspaceId: "ws-1",
      query: "finance policy",
      accessDomains: ["WORKSPACE", "FINANCE", "WORKSPACE"],
    });
    await searchIndexedKnowledge({ actor,
      workspaceId: "ws-1",
      query: "finance policy",
      accessDomains: ["FINANCE", "WORKSPACE"],
    });

    expect(prismaMock.knowledgeChunk.findMany.mock.calls.filter(([query]) => query.take === 500)).toHaveLength(2);
    expect(prismaMock.knowledgeChunk.findMany.mock.calls[4]?.[0]).toMatchObject({
      where: { accessDomain: { in: ["FINANCE", "WORKSPACE"] } },
    });
    expect(modelGatewayMock.embed).toHaveBeenCalledTimes(2);
    expect(modelGatewayMock.rerank).toHaveBeenCalledTimes(2);
  });

  it("reuses cached grounded answers for repeated questions", async () => {
    prismaMock.knowledgeChunk.findMany.mockResolvedValue(certifyRows([
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
    ]));

    const first = await answerKnowledgeQuestion({ actor,
      workspaceId: "ws-1",
      question: "Who reviews finance approvals?",
      limit: 4,
    });
    const second = await answerKnowledgeQuestion({ actor,
      workspaceId: "ws-1",
      question: "Who reviews finance approvals?",
      limit: 4,
    });

    expect(first).toEqual(second);
    expect(modelGatewayMock.chat).toHaveBeenCalledTimes(1);
    expect(modelGatewayMock.embed).toHaveBeenCalledTimes(1);
    expect(modelGatewayMock.rerank).toHaveBeenCalledTimes(1);
  });

  it("rejects cached search and answer text after a source-linked article is quarantined", async () => {
    const oldChunk = {
      id: "old-article-chunk", sourceType: "BRAIN_ARTICLE", sourceId: "old-article",
      sourceTitle: "Prior policy", chunkIndex: 0, content: "The old approval rule applies.",
      embedding: [1, 0], createdAt: new Date("2026-04-03T09:00:00Z"),
    };
    prismaMock.knowledgeChunk.findMany.mockResolvedValue(certifyRows([oldChunk]));
    const first = await answerKnowledgeQuestion({ actor, workspaceId: "ws-1", question: "What is the approval rule?" });
    expect(first.citations).toHaveLength(1);

    // Replacement removes the SQL receipt; an old answer cache and Azure index
    // may still contain the old text until asynchronous cleanup finishes.
    prismaMock.knowledgeChunk.findMany.mockResolvedValue(certifyRows([]));
    prismaMock.brainArticle.findMany.mockResolvedValue(certifyRows([]));
    expect(await searchIndexedKnowledge({ actor, workspaceId: "ws-1", query: "approval rule" })).toEqual([]);
    expect(await answerKnowledgeQuestion({ actor, workspaceId: "ws-1", question: "What is the approval rule?" })).toEqual({
      answer: "I could not find relevant indexed knowledge for that question.", citations: [],
    });
    expect(modelGatewayMock.chat).toHaveBeenCalledTimes(1);
  });

  it("rejects an Azure hit whose SQL receipt was removed by file replacement", async () => {
    process.env.KNOWLEDGE_SEARCH_PROVIDER = "azure";
    process.env.AZURE_SEARCH_ENDPOINT = "https://corgtex-search.search.windows.net";
    process.env.AZURE_SEARCH_INDEX_NAME = "client-knowledge";
    process.env.AZURE_SEARCH_QUERY_KEY = "query-key";
    process.env.AZURE_SEARCH_VECTOR_DIMENSIONS = "2";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ value: [{
      id: "old-document-chunk", sourceType: "DOCUMENT", sourceId: "doc-1",
      sourceTitle: "Old policy", content: "Superseded file text", chunkIndex: 0,
      "@search.score": 1,
    }] }), { status: 200 })));
    prismaMock.knowledgeChunk.findMany.mockResolvedValue(certifyRows([]));

    expect(await searchIndexedKnowledge({ actor, workspaceId: "ws-1", query: "Superseded file text" })).toEqual([]);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each(["obsolete hit", "empty index"])("uses current Postgres chunks when Azure has an %s", async (caseName) => {
    process.env.KNOWLEDGE_SEARCH_PROVIDER = "azure";
    process.env.AZURE_SEARCH_ENDPOINT = "https://corgtex-search.search.windows.net";
    process.env.AZURE_SEARCH_INDEX_NAME = "client-knowledge";
    process.env.AZURE_SEARCH_QUERY_KEY = "query-key";
    process.env.AZURE_SEARCH_VECTOR_DIMENSIONS = "2";
    const azureHits = caseName === "obsolete hit" ? [{
      id: "old-document-chunk", sourceType: "DOCUMENT", sourceId: "doc-1",
      sourceTitle: "Prior policy", content: "Superseded approval rule", chunkIndex: 0,
      "@search.score": 1,
    }] : [];
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ value: azureHits }), { status: 200 })));
    prismaMock.knowledgeChunk.findMany.mockResolvedValue(certifyRows([{
      id: "new-document-chunk", sourceType: "DOCUMENT", sourceId: "doc-1",
      sourceTitle: "Current policy", chunkIndex: 0, content: "Current approval rule",
      embedding: [1, 0], createdAt: new Date("2026-04-03T09:05:00Z"),
    }]));

    const results = await searchIndexedKnowledge({ actor, workspaceId: "ws-1", query: "approval rule" });
    expect(results).toEqual([expect.objectContaining({
      chunkId: "new-document-chunk", sourceId: "doc-1", snippet: "Current approval rule",
    })]);
    expect(fetch).toHaveBeenCalledOnce();
    expect(prismaMock.knowledgeChunk.findMany.mock.calls.some(([args]) => args?.take === 500)).toBe(true);
  });

  it("recovers current chunks from a cached obsolete Azure hit after cache invalidation fails", async () => {
    process.env.KNOWLEDGE_SEARCH_PROVIDER = "azure";
    process.env.AZURE_SEARCH_ENDPOINT = "https://corgtex-search.search.windows.net";
    process.env.AZURE_SEARCH_INDEX_NAME = "client-knowledge";
    process.env.AZURE_SEARCH_QUERY_KEY = "query-key";
    process.env.AZURE_SEARCH_VECTOR_DIMENSIONS = "2";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ value: [{
      id: "old-document-chunk", sourceType: "DOCUMENT", sourceId: "doc-1",
      sourceTitle: "Prior policy", content: "Superseded approval rule", chunkIndex: 0,
      "@search.score": 1,
    }] }), { status: 200 })));
    const oldChunk = {
      id: "old-document-chunk", sourceType: "DOCUMENT", sourceId: "doc-1",
      sourceTitle: "Prior policy", chunkIndex: 0, content: "Superseded approval rule",
      embedding: [1, 0], createdAt: new Date("2026-04-03T09:00:00Z"),
    };
    const newChunk = {
      ...oldChunk, id: "new-document-chunk", sourceTitle: "Current policy",
      content: "Current approval rule", createdAt: new Date("2026-04-03T09:05:00Z"),
    };
    prismaMock.knowledgeChunk.findMany.mockResolvedValue(certifyRows([oldChunk]));
    expect((await searchIndexedKnowledge({ actor, workspaceId: "ws-1", query: "approval rule" }))[0]?.chunkId).toBe(oldChunk.id);

    // Model the committed replacement with an unchanged search-cache version.
    prismaMock.knowledgeChunk.findMany.mockResolvedValue(certifyRows([newChunk]));
    const current = await searchIndexedKnowledge({ actor, workspaceId: "ws-1", query: "approval rule" });
    expect(current).toEqual([expect.objectContaining({ chunkId: newChunk.id, snippet: newChunk.content })]);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("ranks the complete current SQL pool when Azure has a partially obsolete result", async () => {
    process.env.KNOWLEDGE_SEARCH_PROVIDER = "azure";
    process.env.AZURE_SEARCH_ENDPOINT = "https://corgtex-search.search.windows.net";
    process.env.AZURE_SEARCH_INDEX_NAME = "client-knowledge";
    process.env.AZURE_SEARCH_QUERY_KEY = "query-key";
    process.env.AZURE_SEARCH_VECTOR_DIMENSIONS = "2";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ value: [
      { id: "old-document-chunk", sourceType: "DOCUMENT", sourceId: "doc-1", sourceTitle: "Prior policy", content: "Old rule", chunkIndex: 0, "@search.score": 1 },
      { id: "other-chunk", sourceType: "DOCUMENT", sourceId: "doc-2", sourceTitle: "Other policy", content: "Other rule", chunkIndex: 0, "@search.score": 0.8 },
    ] }), { status: 200 })));
    prismaMock.knowledgeChunk.findMany.mockResolvedValue(certifyRows([
      { id: "new-document-chunk", sourceType: "DOCUMENT", sourceId: "doc-1", sourceTitle: "Current policy", chunkIndex: 0, content: "Current rule", embedding: [1, 0], createdAt: new Date("2026-04-03T09:05:00Z") },
      { id: "other-chunk", sourceType: "DOCUMENT", sourceId: "doc-2", sourceTitle: "Other policy", chunkIndex: 0, content: "Other rule", embedding: [1, 0], createdAt: new Date("2026-04-03T09:00:00Z") },
    ]));

    const results = await searchIndexedKnowledge({ actor, workspaceId: "ws-1", query: "rule" });
    expect(results.map((item) => item.chunkId)).toEqual(["new-document-chunk", "other-chunk"]);
    expect(results.find((item) => item.chunkId === "old-document-chunk")).toBeUndefined();
  });

  it("partitions grounded-answer caches by access domain and source type", async () => {
    prismaMock.knowledgeChunk.findMany.mockResolvedValue(certifyRows([
      {
        id: "chunk-answer-domain",
        sourceType: "DOCUMENT",
        sourceId: "doc-answer-domain",
        sourceTitle: "Finance policy",
        chunkIndex: 0,
        content: "Finance approvals require a steward review.",
        embedding: [1, 0],
      },
    ]));

    await answerKnowledgeQuestion({ actor,
      workspaceId: "ws-1",
      question: "Who reviews finance approvals?",
      accessDomains: ["WORKSPACE"],
    });
    await answerKnowledgeQuestion({ actor,
      workspaceId: "ws-1",
      question: "Who reviews finance approvals?",
      accessDomains: ["WORKSPACE", "FINANCE"],
    });
    await answerKnowledgeQuestion({ actor,
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
    await expect(searchIndexedKnowledge({ actor,
      workspaceId: "ws-1",
      query: "finance",
      accessDomains: [],
    })).resolves.toEqual([]);
    await expect(answerKnowledgeQuestion({ actor,
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
    prismaMock.knowledgeChunk.findMany.mockResolvedValue(certifyRows([
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
    ]));

    await answerKnowledgeQuestion({ actor,
      workspaceId: "ws-1",
      question: "Who reviews finance approvals?",
    });
    await answerKnowledgeQuestion({ actor,
      workspaceId: "ws-1",
      question: "Who reviews finance approvals?",
      limit: 4,
    });

    expect(modelGatewayMock.chat).toHaveBeenCalledTimes(2);
    expect(modelGatewayMock.embed).toHaveBeenCalledTimes(2);
    expect(modelGatewayMock.rerank).toHaveBeenCalledTimes(2);
  });

  it("keeps a 500-chunk Postgres candidate window per requested source type", async () => {
    prismaMock.knowledgeChunk.findMany.mockResolvedValue(certifyRows([
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
    ]));

    await searchIndexedKnowledge({ actor,
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
    const previousChunks = certifyRows([
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
    prismaMock.knowledgeChunk.findMany.mockImplementation(async ({ where, select }: any) =>
      !select && where.id?.in ? persistedRows(where) : previousChunks);

    await searchIndexedKnowledge({ actor,
      workspaceId: "ws-1",
      query: "policy language",
      limit: 2,
    });

    modelGatewayMock.embed.mockClear();
    modelGatewayMock.rerank.mockClear();

    prismaMock.document.findFirst.mockResolvedValue({ id: "doc-2", workspaceId: "ws-1", accessDomain: "WORKSPACE", archivedAt: null, title: "Updated policy", textContent: "New policy language with clarified approval steps." });
    await syncKnowledgeForSource({
      workspaceId: "ws-1",
      sourceType: "DOCUMENT",
      accessDomain: "WORKSPACE",
      sourceId: "doc-2",
      sourceTitle: "Updated policy",
      content: "New policy language with clarified approval steps.",
    });

    prismaMock.knowledgeChunk.findMany.mockResolvedValue(certifyRows([
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
    ]));

    await searchIndexedKnowledge({ actor,
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
    prismaMock.externalContentSource.findFirst.mockResolvedValue({ id: "doc-3", workspaceId: "ws-1",
      title: "Policy", metadata: { materializedContent: "Chunk me", custom: "value" }, archivedAt: null });
    await syncKnowledgeForSource({
      workspaceId: "ws-1",
      sourceType: "EXTERNAL_CONTENT",
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
            sourceType: "EXTERNAL_CONTENT",
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

    prismaMock.knowledgeChunk.findMany.mockResolvedValue(certifyRows([
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
    ]));

    const results = await searchIndexedKnowledge({ actor,
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
