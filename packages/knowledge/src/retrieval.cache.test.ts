import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock, modelGatewayMock } = vi.hoisted(() => ({
  prismaMock: {
    knowledgeChunk: {
      findMany: vi.fn(),
      deleteMany: vi.fn(),
      createMany: vi.fn(),
    },
  },
  modelGatewayMock: {
    embed: vi.fn(async ({ input }: { input: string | string[] }) => {
      const values = Array.isArray(input) ? input : [input];
      return {
        embeddings: values.map(() => [1, 0]),
        usage: {
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
}));

vi.mock("@corgtex/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@corgtex/shared")>();
  return {
    ...actual,
    prisma: prismaMock,
  };
});

vi.mock("@corgtex/models", () => ({
  defaultModelGateway: modelGatewayMock,
  resolveModel: vi.fn().mockReturnValue("fake-model"),
}));

import { syncKnowledgeForSource } from "./chunks";
import { answerKnowledgeQuestion, searchIndexedKnowledge, invalidateKnowledgeCache } from "./retrieval";

describe("knowledge retrieval cache", () => {
  beforeEach(() => {
    invalidateKnowledgeCache();

    prismaMock.knowledgeChunk.findMany.mockReset();
    prismaMock.knowledgeChunk.deleteMany.mockReset();
    prismaMock.knowledgeChunk.createMany.mockReset();
    modelGatewayMock.embed.mockClear();
    modelGatewayMock.rerank.mockClear();
    modelGatewayMock.chat.mockClear();
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
    expect(modelGatewayMock.embed).toHaveBeenCalledTimes(1);
    expect(modelGatewayMock.rerank).toHaveBeenCalledTimes(1);
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
          metadata: expect.objectContaining({
            chunkIndex: 0,
            sourceType: "DOCUMENT",
            custom: "value",
          }),
        }),
      ],
    });
  });
});
