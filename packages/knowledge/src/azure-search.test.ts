import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildAzureKnowledgeIndexDefinition,
  createOrUpdateAzureKnowledgeIndex,
  mapKnowledgeChunkToAzureDocument,
  normalizeKnowledgeAccessDomains,
  searchAzureKnowledge,
  syncAzureKnowledgeSource,
  uploadAzureKnowledgeDocuments,
} from "./azure-search";

const ORIGINAL_ENV = { ...process.env };
let indexSequence = 0;

function configureAzureSearchEnv() {
  process.env.AZURE_SEARCH_ENDPOINT = "https://corgtex-search.search.windows.net/";
  process.env.AZURE_SEARCH_INDEX_NAME = `client-knowledge-${indexSequence++}`;
  process.env.AZURE_SEARCH_AUTH_MODE = "api_key";
  process.env.AZURE_SEARCH_ADMIN_KEY = "admin-key";
  process.env.AZURE_SEARCH_QUERY_KEY = "query-key";
  process.env.AZURE_SEARCH_VECTOR_DIMENSIONS = "2";
}

describe("Azure knowledge search adapter", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    configureAzureSearchEnv();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ value: [] }), { status: 200 })));
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.unstubAllGlobals();
  });

  it("builds the expected vector and semantic index definition", () => {
    const definition = buildAzureKnowledgeIndexDefinition("client-knowledge");

    expect(definition.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "id", key: true }),
      expect.objectContaining({ name: "workspaceId", filterable: true }),
      expect.objectContaining({ name: "accessDomain", filterable: true, facetable: true }),
      expect.objectContaining({ name: "contentVector", dimensions: 2, vectorSearchProfile: "knowledge-vector-profile" }),
    ]));
    expect(definition.semantic.defaultConfiguration).toBe("knowledge-semantic");
    expect(definition.vectorSearch.algorithms[0]).toMatchObject({
      name: "knowledge-hnsw",
      kind: "hnsw",
      hnswParameters: { metric: "cosine" },
    });
  });

  it("maps knowledge chunks into Azure Search documents without raw metadata objects", () => {
    const document = mapKnowledgeChunkToAzureDocument({
      id: "chunk-1",
      workspaceId: "ws-1",
      sourceType: "MEETING",
      accessDomain: "FINANCE",
      sourceId: "meeting-1",
      sourceTitle: "Weekly sync",
      chunkIndex: 2,
      content: "Jan mentioned Azure Search.",
      embedding: [0.1, 0.2],
      metadata: { recordedAt: "2026-07-06T19:00:00.000Z" },
      sensitivity: "PUBLIC",
      createdAt: new Date("2026-07-06T20:00:00.000Z"),
    });

    expect(document).toMatchObject({
      id: "chunk-1",
      workspaceId: "ws-1",
      sourceType: "MEETING",
      accessDomain: "FINANCE",
      sourceId: "meeting-1",
      chunkIndex: 2,
      contentVector: [0.1, 0.2],
      metadataJson: JSON.stringify({ recordedAt: "2026-07-06T19:00:00.000Z" }),
      createdAt: "2026-07-06T20:00:00.000Z",
    });
  });

  it("uploads documents with mergeOrUpload actions using the admin key", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ name: process.env.AZURE_SEARCH_INDEX_NAME }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ value: [{ key: "chunk-1", status: true, statusCode: 201 }] }), { status: 200 }));

    await uploadAzureKnowledgeDocuments([
      mapKnowledgeChunkToAzureDocument({
        id: "chunk-1",
        workspaceId: "ws-1",
        sourceType: "DOCUMENT",
        accessDomain: "WORKSPACE",
        sourceId: "doc-1",
        sourceTitle: "Policy",
        chunkIndex: 0,
        content: "Policy body",
        embedding: [1, 0],
        metadata: {},
        sensitivity: "PUBLIC",
        createdAt: "2026-07-06T20:00:00.000Z",
      }),
    ]);

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(`/indexes('${process.env.AZURE_SEARCH_INDEX_NAME}')?api-version=2026-04-01`);
    const [url, init] = fetchMock.mock.calls[1];
    expect(String(url)).toContain(`/indexes('${process.env.AZURE_SEARCH_INDEX_NAME}')/docs/search.index?api-version=2026-04-01`);
    expect((init?.headers as Record<string, string>)["api-key"]).toBe("admin-key");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      value: [
        {
          "@search.action": "mergeOrUpload",
          id: "chunk-1",
        },
      ],
    });
  });

  it("queries Azure Search with workspace filters, semantic ranking, and vector search", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ name: process.env.AZURE_SEARCH_INDEX_NAME }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        value: [{
          "@search.score": 1.2,
          "@search.rerankerScore": 2.5,
          id: "chunk-1",
          sourceType: "SLACK",
          sourceId: "message-1",
          sourceTitle: "Slack thread",
          chunkIndex: 0,
          content: "Jan mentioned the name.",
        }],
      }), { status: 200 }));

    const results = await searchAzureKnowledge({
      workspaceId: "ws-1",
      query: "check slack for the name",
      queryEmbedding: [0.3, 0.4],
      limit: 4,
      sourceTypes: ["SLACK"],
      maxSensitivity: "INTERNAL",
      accessDomains: ["FINANCE", "WORKSPACE", "FINANCE"],
    });

    expect(results[0]).toMatchObject({
      chunkId: "chunk-1",
      sourceType: "SLACK",
      sourceId: "message-1",
      score: 2.5,
    });
    const [, init] = fetchMock.mock.calls[1];
    expect((init?.headers as Record<string, string>)["api-key"]).toBe("query-key");
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({
      search: "check slack for the name",
      queryType: "semantic",
      semanticConfiguration: "knowledge-semantic",
      vectorFilterMode: "preFilter",
    });
    expect(body.filter).toContain("workspaceId eq 'ws-1'");
    expect(body.filter).toContain("search.in(accessDomain, 'FINANCE,WORKSPACE')");
    expect(body.filter).toContain("or accessDomain eq null");
    expect(body.filter).toContain("search.in(sourceType, 'SLACK')");
    expect(body.filter).toContain("search.in(sensitivity, 'PUBLIC,INTERNAL')");
    expect(body.vectorQueries[0]).toMatchObject({
      kind: "vector",
      fields: "contentVector",
      k: 50,
    });
  });

  it("does not treat legacy domain-less documents as Finance-only knowledge", async () => {
    await searchAzureKnowledge({
      workspaceId: "ws-1",
      query: "finance",
      queryEmbedding: [0.3, 0.4],
      accessDomains: ["FINANCE"],
    });

    const [, init] = vi.mocked(fetch).mock.calls[1];
    const body = JSON.parse(String(init?.body));
    expect(body.filter).toContain("search.in(accessDomain, 'FINANCE')");
    expect(body.filter).not.toContain("accessDomain eq null");
  });

  it("normalizes legacy and explicit access-domain sets without widening empty access", async () => {
    expect(normalizeKnowledgeAccessDomains()).toEqual(["WORKSPACE"]);
    expect(normalizeKnowledgeAccessDomains(["WORKSPACE", "FINANCE", "WORKSPACE"])).toEqual(["FINANCE", "WORKSPACE"]);
    expect(normalizeKnowledgeAccessDomains([])).toEqual([]);

    await expect(searchAzureKnowledge({
      workspaceId: "ws-1",
      query: "finance",
      queryEmbedding: [0.3, 0.4],
      accessDomains: [],
    })).resolves.toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("creates or updates the configured index using the admin key", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ name: "client-knowledge" }), { status: 200 }));

    await createOrUpdateAzureKnowledgeIndex();

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain(`/indexes('${process.env.AZURE_SEARCH_INDEX_NAME}')?api-version=2026-04-01`);
    expect(init?.method).toBe("PUT");
    expect((init?.headers as Record<string, string>)["api-key"]).toBe("admin-key");
  });

  it("upgrades the index before a source sync deletes prior documents", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ name: process.env.AZURE_SEARCH_INDEX_NAME }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ value: [{ id: "old-chunk" }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ value: [{ key: "old-chunk", status: true }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ value: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ value: [{ key: "new-chunk", status: true }] }), { status: 200 }));

    await syncAzureKnowledgeSource({
      workspaceId: "ws-1",
      sourceType: "DOCUMENT",
      sourceId: "report-1",
      chunks: [{
        id: "new-chunk",
        workspaceId: "ws-1",
        sourceType: "DOCUMENT",
        accessDomain: "FINANCE",
        sourceId: "report-1",
        sourceTitle: "Finance report",
        chunkIndex: 0,
        content: "Revenue actuals",
        embedding: [1, 0],
        metadata: {},
        sensitivity: "CONFIDENTIAL",
      }],
    });

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(`/indexes('${process.env.AZURE_SEARCH_INDEX_NAME}')?`);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("/docs/search?");
    expect(String(fetchMock.mock.calls[2]?.[0])).toContain("/docs/search.index?");
    expect(String(fetchMock.mock.calls[4]?.[0])).toContain("/docs/search.index?");
    expect(JSON.parse(String(fetchMock.mock.calls[4]?.[1]?.body))).toMatchObject({
      value: [expect.objectContaining({ id: "new-chunk", accessDomain: "FINANCE" })],
    });
  });
});
