import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  prismaMock,
  modelGatewayMock,
  createArticleMock,
  updateArticleMock,
  markSourceAbsorbedMock,
  rebuildBacklinksMock,
  syncBrainArticleKnowledgeMock,
} = vi.hoisted(() => ({
  prismaMock: {
    brainSource: {
      findUnique: vi.fn(),
    },
    brainArticle: {
      findMany: vi.fn(),
    },
    brainBacklink: {
      findMany: vi.fn(),
    },
  },
  modelGatewayMock: {
    extract: vi.fn(),
    chat: vi.fn(),
  },
  createArticleMock: vi.fn(),
  updateArticleMock: vi.fn(),
  markSourceAbsorbedMock: vi.fn(),
  rebuildBacklinksMock: vi.fn(),
  syncBrainArticleKnowledgeMock: vi.fn(),
}));

vi.mock("@corgtex/shared", () => ({
  prisma: prismaMock,
}));

vi.mock("@corgtex/models", () => ({
  defaultModelGateway: modelGatewayMock,
  resolveModel: vi.fn(() => "gpt-4o-mini"),
}));

vi.mock("@corgtex/domain", () => ({
  AGENT_REGISTRY: {
    "brain-absorb": { defaultModelTier: "fast" },
  },
  createArticle: createArticleMock,
  updateArticle: updateArticleMock,
  markSourceAbsorbed: markSourceAbsorbedMock,
  rebuildBacklinks: rebuildBacklinksMock,
}));

vi.mock("@corgtex/knowledge", () => ({
  syncBrainArticleKnowledge: syncBrainArticleKnowledgeMock,
}));

describe("absorbSource", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.brainSource.findUnique.mockResolvedValue({
      id: "source-1",
      workspaceId: "workspace-1",
      sourceType: "DOC",
      tier: 1,
      title: "Launch notes",
      channel: "text-paste",
      content: "Launch content",
      ingestionGuidanceMd: "Prioritize launch blockers.",
      absorbedAt: null,
    });
    prismaMock.brainArticle.findMany.mockResolvedValue([]);
    prismaMock.brainBacklink.findMany.mockResolvedValue([]);
    modelGatewayMock.extract.mockResolvedValue({
      output: {
        articleType: "PROJECT",
        updateSlugs: [],
        createNew: null,
        summary: "Launch context",
      },
    });
    rebuildBacklinksMock.mockResolvedValue(undefined);
    markSourceAbsorbedMock.mockResolvedValue(undefined);
  });

  it("passes ingestion guidance into source analysis", async () => {
    const { absorbSource } = await import("./brain-absorb");

    await absorbSource({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      agentRunId: "run-1",
    });

    expect(modelGatewayMock.extract).toHaveBeenCalledWith(expect.objectContaining({
      instruction: expect.stringContaining("Prioritize launch blockers."),
      input: expect.stringContaining("Prioritize launch blockers."),
    }));
  });

  it("skips non-draft article updates without failing the run", async () => {
    prismaMock.brainArticle.findMany.mockResolvedValue([
      {
        id: "article-1",
        slug: "launch",
        title: "Launch",
        type: "PROJECT",
        authority: "REFERENCE",
        bodyMd: "Published launch notes",
        sourceIds: [],
        frontmatterJson: null,
      },
    ]);
    modelGatewayMock.extract.mockResolvedValue({
      output: {
        articleType: "PROJECT",
        updateSlugs: ["launch"],
        createNew: null,
        summary: "Launch context",
      },
    });

    const { absorbSource } = await import("./brain-absorb");
    const result = await absorbSource({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      agentRunId: "run-1",
    });

    expect(result).toEqual(expect.objectContaining({
      skipped: true,
      reason: "non_draft_article",
      skippedSlugs: ["launch"],
    }));
    expect(modelGatewayMock.chat).not.toHaveBeenCalled();
    expect(updateArticleMock).not.toHaveBeenCalled();
    expect(markSourceAbsorbedMock).not.toHaveBeenCalled();
  });
});
