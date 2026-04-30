import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  prismaMock,
  chatMock,
  extractMock,
  sendEmailMock,
  batchIngestDailyConversationsMock,
  createArticleMock,
  listSlackMessagesForDigestMock,
  updateArticleMock,
  rebuildBacklinksMock,
} = vi.hoisted(() => ({
  prismaMock: {
    conversationSession: {
      findMany: vi.fn(),
    },
    buildArtifact: {
      findMany: vi.fn(),
    },
    brainSource: {
      create: vi.fn(),
    },
    brainArticle: {
      findUnique: vi.fn(),
    },
    member: {
      findMany: vi.fn(),
    },
  },
  chatMock: vi.fn(),
  extractMock: vi.fn(),
  sendEmailMock: vi.fn(),
  batchIngestDailyConversationsMock: vi.fn(),
  createArticleMock: vi.fn(),
  listSlackMessagesForDigestMock: vi.fn(),
  updateArticleMock: vi.fn(),
  rebuildBacklinksMock: vi.fn(),
}));

vi.mock("@corgtex/shared", () => ({
  prisma: prismaMock,
  sendEmail: sendEmailMock,
}));

vi.mock("@corgtex/models", () => ({
  defaultModelGateway: {
    chat: chatMock,
    extract: extractMock,
  },
  resolveModel: vi.fn().mockReturnValue("fake-model"),
}));

vi.mock("@corgtex/domain", () => ({
  AGENT_REGISTRY: {
    "daily-digest": {
      defaultModelTier: "standard",
    },
  },
  getAgentModelOverride: vi.fn().mockResolvedValue(undefined),
  batchIngestDailyConversations: batchIngestDailyConversationsMock,
  createArticle: createArticleMock,
  listSlackMessagesForDigest: listSlackMessagesForDigestMock,
  updateArticle: updateArticleMock,
  rebuildBacklinks: rebuildBacklinksMock,
}));

describe("runDailyDigest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    batchIngestDailyConversationsMock.mockResolvedValue(undefined);
    prismaMock.conversationSession.findMany.mockResolvedValue([]);
    listSlackMessagesForDigestMock.mockResolvedValue([]);
    prismaMock.buildArtifact.findMany.mockResolvedValue([]);
    prismaMock.member.findMany.mockResolvedValue([]);
    prismaMock.brainSource.create.mockResolvedValue({ id: "source-1" });
    prismaMock.brainArticle.findUnique.mockResolvedValue(null);
    chatMock.mockResolvedValue({ content: "Digest body" });
    extractMock.mockResolvedValue({ output: {} });
    createArticleMock.mockResolvedValue({ id: "article-1" });
    updateArticleMock.mockResolvedValue({ id: "article-1" });
    rebuildBacklinksMock.mockResolvedValue(undefined);
    sendEmailMock.mockResolvedValue(undefined);
  });

  it("includes recent active and merged build artifacts in the digest input", async () => {
    prismaMock.buildArtifact.findMany.mockResolvedValue([
      {
        repositoryOwner: "puncar-dev",
        repositoryName: "corgtex",
        pullRequestNumber: 42,
        pullRequestUrl: "https://github.com/puncar-dev/corgtex/pull/42",
        branchName: "feat/outcome-board",
        title: "Built outcome board",
        summaryMd: "Plan and acceptance criteria.",
        status: "OPEN",
        mergedAt: null,
        closedAt: null,
        updatedAt: new Date("2026-04-30T09:00:00.000Z"),
        assets: [
          {
            kind: "SCREENSHOT",
            label: "In-progress board",
            captionMd: "Shows active PR work.",
          },
        ],
      },
      {
        repositoryOwner: "puncar-dev",
        repositoryName: "corgtex",
        pullRequestNumber: 41,
        pullRequestUrl: "https://github.com/puncar-dev/corgtex/pull/41",
        branchName: "feat/tools",
        title: "Tools directory",
        summaryMd: "Merged tools outcome.",
        status: "MERGED",
        mergedAt: new Date("2026-04-30T08:00:00.000Z"),
        closedAt: new Date("2026-04-30T08:00:00.000Z"),
        updatedAt: new Date("2026-04-30T08:00:00.000Z"),
        assets: [],
      },
    ]);

    const { runDailyDigest } = await import("./daily-digest");
    await runDailyDigest({
      workspaceId: "workspace-1",
      dateISO: "2026-04-30T12:00:00.000Z",
    });

    const digestInput = chatMock.mock.calls[0][0].messages[1].content;
    expect(digestInput).toContain("Built / PR activity for accomplishments and shipped work");
    expect(digestInput).toContain("Active PR work");
    expect(digestInput).toContain("Built outcome board");
    expect(digestInput).toContain("Visual proof: In-progress board (SCREENSHOT): Shows active PR work.");
    expect(digestInput).toContain("Merged PRs / shipped outcomes");
    expect(digestInput).toContain("Tools directory");
    expect(createArticleMock).toHaveBeenCalledWith(expect.objectContaining({ kind: "agent" }), expect.objectContaining({
      workspaceId: "workspace-1",
      type: "DIGEST",
      bodyMd: "Digest body",
    }));
  });
});
