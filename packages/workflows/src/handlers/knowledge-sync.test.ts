import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock, syncKnowledgeForSourceMock } = vi.hoisted(() => ({
  prismaMock: {
    communicationMessage: {
      findUnique: vi.fn(),
    },
    communicationChannel: {
      findUnique: vi.fn(),
    },
    knowledgeChunk: {
      deleteMany: vi.fn(),
    },
  },
  syncKnowledgeForSourceMock: vi.fn(),
}));

vi.mock("@corgtex/shared", () => ({
  prisma: prismaMock,
}));

vi.mock("@corgtex/knowledge", () => ({
  syncKnowledgeForSource: syncKnowledgeForSourceMock,
  syncBrainArticleKnowledge: vi.fn(),
}));

vi.mock("@corgtex/domain", () => ({
  fetchCalendarEvents: vi.fn(),
}));

function slackMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: "message-1",
    workspaceId: "workspace-1",
    provider: "SLACK",
    installationId: "install-1",
    externalChannelId: "C1",
    externalMessageId: "1714320000.000100",
    externalUserId: "U1",
    threadExternalId: "1714320000.000100",
    messageTs: new Date("2026-04-29T16:00:00.000Z"),
    text: "The launch owner is Alice.",
    textRedactedAt: null,
    isBot: false,
    isHidden: false,
    isDeleted: false,
    permalink: "https://slack.test/archives/C1/p1714320000000100",
    installation: {
      id: "install-1",
      externalTeamName: "Corgtex",
    },
    ...overrides,
  };
}

describe("handleSlackMessageKnowledgeSync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.communicationMessage.findUnique.mockResolvedValue(slackMessage());
    prismaMock.communicationChannel.findUnique.mockResolvedValue({ name: "general", kind: "PUBLIC" });
    prismaMock.knowledgeChunk.deleteMany.mockResolvedValue({ count: 0 });
    syncKnowledgeForSourceMock.mockResolvedValue(undefined);
  });

  it("indexes eligible public Slack messages into Brain chunks", async () => {
    const { handleSlackMessageKnowledgeSync } = await import("./knowledge-sync");

    await handleSlackMessageKnowledgeSync("job-1", { messageId: "message-1" }, "workspace-1");

    expect(syncKnowledgeForSourceMock).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "workspace-1",
      sourceType: "SLACK",
      sourceId: "message-1",
      sourceTitle: "Slack #general",
      content: expect.stringContaining("The launch owner is Alice."),
      metadata: expect.objectContaining({
        installationId: "install-1",
        externalChannelId: "C1",
        externalMessageId: "1714320000.000100",
        permalink: "https://slack.test/archives/C1/p1714320000000100",
        workflowJobId: "job-1",
      }),
      workflowJobId: "job-1",
    }));
    expect(prismaMock.knowledgeChunk.deleteMany).not.toHaveBeenCalled();
  });

  it("deletes Slack Brain chunks when raw messages are redacted or deleted", async () => {
    prismaMock.communicationMessage.findUnique.mockResolvedValueOnce(slackMessage({
      text: null,
      textRedactedAt: new Date("2026-04-30T00:00:00.000Z"),
      isDeleted: true,
    }));
    const { handleSlackMessageKnowledgeSync } = await import("./knowledge-sync");

    await handleSlackMessageKnowledgeSync("job-1", { messageId: "message-1" }, "workspace-1");

    expect(syncKnowledgeForSourceMock).not.toHaveBeenCalled();
    expect(prismaMock.knowledgeChunk.deleteMany).toHaveBeenCalledWith({
      where: {
        workspaceId: "workspace-1",
        sourceType: "SLACK",
        sourceId: "message-1",
      },
    });
  });

  it("does not index private Slack channels in v1", async () => {
    prismaMock.communicationChannel.findUnique.mockResolvedValueOnce({ name: "private", kind: "PRIVATE" });
    const { handleSlackMessageKnowledgeSync } = await import("./knowledge-sync");

    await handleSlackMessageKnowledgeSync("job-1", { messageId: "message-1" }, "workspace-1");

    expect(syncKnowledgeForSourceMock).not.toHaveBeenCalled();
  });
});
