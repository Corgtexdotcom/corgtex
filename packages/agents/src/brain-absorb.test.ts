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
      archivedAt: null,
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
    modelGatewayMock.chat.mockResolvedValue({ content: "## Launch notes\n\nLaunch context." });
    createArticleMock.mockResolvedValue({ id: "article-created", slug: "launch-notes" });
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

  it("skips archived sources before sending content to the model", async () => {
    prismaMock.brainSource.findUnique.mockResolvedValueOnce({
      id: "source-1",
      workspaceId: "workspace-1",
      sourceType: "DOC",
      tier: 1,
      title: "Launch notes",
      channel: "text-paste",
      content: "Launch content",
      ingestionGuidanceMd: null,
      absorbedAt: null,
      archivedAt: new Date("2026-08-20T10:00:00.000Z"),
    });

    const { absorbSource } = await import("./brain-absorb");
    const result = await absorbSource({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      agentRunId: "run-1",
    });

    expect(result).toEqual({ skipped: true, reason: "archived" });
    expect(modelGatewayMock.extract).not.toHaveBeenCalled();
    expect(createArticleMock).not.toHaveBeenCalled();
    expect(updateArticleMock).not.toHaveBeenCalled();
    expect(markSourceAbsorbedMock).not.toHaveBeenCalled();
  });

  it("skips article writes when a source is archived after analysis", async () => {
    prismaMock.brainSource.findUnique
      .mockResolvedValueOnce({
        id: "source-1",
        workspaceId: "workspace-1",
        sourceType: "DOC",
        tier: 1,
        title: "Launch notes",
        channel: "text-paste",
        content: "Launch content",
        ingestionGuidanceMd: null,
        absorbedAt: null,
        archivedAt: null,
      })
      .mockResolvedValueOnce({
        workspaceId: "workspace-1",
        absorbedAt: null,
        archivedAt: new Date("2026-08-20T10:00:00.000Z"),
      });

    const { absorbSource } = await import("./brain-absorb");
    const result = await absorbSource({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      agentRunId: "run-1",
    });

    expect(result).toEqual({ skipped: true, reason: "archived", sourceId: "source-1" });
    expect(modelGatewayMock.extract).toHaveBeenCalled();
    expect(createArticleMock).not.toHaveBeenCalled();
    expect(updateArticleMock).not.toHaveBeenCalled();
    expect(markSourceAbsorbedMock).not.toHaveBeenCalled();
  });

  it("skips article creation when a source is archived after drafting", async () => {
    prismaMock.brainSource.findUnique
      .mockResolvedValueOnce({
        id: "source-1",
        workspaceId: "workspace-1",
        sourceType: "DOC",
        tier: 1,
        title: "Launch notes",
        channel: "text-paste",
        content: "Launch content",
        ingestionGuidanceMd: null,
        absorbedAt: null,
        archivedAt: null,
      })
      .mockResolvedValueOnce({
        workspaceId: "workspace-1",
        absorbedAt: null,
        archivedAt: null,
      })
      .mockResolvedValueOnce({
        workspaceId: "workspace-1",
        absorbedAt: null,
        archivedAt: new Date("2026-08-20T10:00:00.000Z"),
      });
    modelGatewayMock.extract.mockResolvedValue({
      output: {
        articleType: "PROJECT",
        updateSlugs: [],
        createNew: { title: "Launch notes", slug: "launch-notes" },
        summary: "Launch context",
      },
    });

    const { absorbSource } = await import("./brain-absorb");
    const result = await absorbSource({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      agentRunId: "run-1",
    });

    expect(result).toEqual({ skipped: true, reason: "archived", sourceId: "source-1" });
    expect(modelGatewayMock.chat).toHaveBeenCalled();
    expect(createArticleMock).not.toHaveBeenCalled();
    expect(updateArticleMock).not.toHaveBeenCalled();
    expect(markSourceAbsorbedMock).not.toHaveBeenCalled();
  });

  it("creates a public reference recap when document sources match non-draft articles", async () => {
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
      absorbed: true,
      skippedSlugs: ["launch"],
      createdSlug: "launch-notes",
      touchedArticleCount: 1,
    }));
    expect(updateArticleMock).not.toHaveBeenCalled();
    expect(createArticleMock).toHaveBeenCalledWith(expect.objectContaining({ label: "brain-absorb" }), expect.objectContaining({
      workspaceId: "workspace-1",
      slug: "launch-notes",
      title: "Launch notes",
      authority: "REFERENCE",
      sourceIds: ["source-1"],
    }));
    expect(markSourceAbsorbedMock).toHaveBeenCalledWith(expect.objectContaining({ label: "brain-absorb" }), { sourceId: "source-1" });
  });
});
