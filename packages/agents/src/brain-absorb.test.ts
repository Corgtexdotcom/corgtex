import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock, modelGatewayMock, markSourceAbsorbedMock, rebuildBacklinksMock, syncBrainArticleKnowledgeMock } = vi.hoisted(() => ({
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
  createArticle: vi.fn(),
  updateArticle: vi.fn(),
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
});
