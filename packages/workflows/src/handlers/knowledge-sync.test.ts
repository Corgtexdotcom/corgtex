import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  fetchCalendarEventsMock,
  fetchFilteredEmailMessagesMock,
  fetchSelectedDocumentsMock,
  materializeCrmCalendarTouchpointsMock,
  materializeCrmEmailTouchpointsMock,
  prismaMock,
  syncKnowledgeForSourceMock,
} = vi.hoisted(() => ({
  fetchCalendarEventsMock: vi.fn(),
  fetchFilteredEmailMessagesMock: vi.fn(),
  fetchSelectedDocumentsMock: vi.fn(),
  materializeCrmCalendarTouchpointsMock: vi.fn(),
  materializeCrmEmailTouchpointsMock: vi.fn(),
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
    meeting: {
      findUnique: vi.fn(),
    },
    oAuthConnection: {
      findUnique: vi.fn(),
      update: vi.fn(),
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
  fetchCalendarEvents: fetchCalendarEventsMock,
  fetchFilteredEmailMessages: fetchFilteredEmailMessagesMock,
  fetchSelectedDocuments: fetchSelectedDocumentsMock,
  materializeCrmCalendarTouchpoints: materializeCrmCalendarTouchpointsMock,
  materializeCrmEmailTouchpoints: materializeCrmEmailTouchpointsMock,
  syncCalendarEventRecorder: vi.fn(),
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

describe("handleMeetingKnowledgeSync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    syncKnowledgeForSourceMock.mockResolvedValue(undefined);
    prismaMock.meeting.findUnique.mockResolvedValue({
      id: "meeting-1",
      workspaceId: "workspace-1",
      title: "Weekly Tactical",
      source: "transcript-upload",
      transcript: "Jan: Milan owns onboarding.",
      summaryMd: "Milan owns onboarding.",
      ingestionGuidanceMd: "Highlight onboarding ownership.",
      recordedAt: new Date("2026-04-30T17:10:00.000Z"),
    });
  });

  it("keeps guidance out of meeting content and records only metadata", async () => {
    const { handleMeetingKnowledgeSync } = await import("./knowledge-sync");

    await handleMeetingKnowledgeSync("job-1", { meetingId: "meeting-1" }, "workspace-1");

    expect(syncKnowledgeForSourceMock).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.not.stringContaining("Highlight onboarding ownership."),
      metadata: expect.objectContaining({
        hasIngestionGuidance: true,
      }),
    }));
  });
});

describe("handleCalendarSync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.oAuthConnection.findUnique.mockResolvedValue({
      id: "conn-1",
      workspaceId: "workspace-1",
      provider: "GOOGLE",
      status: "ACTIVE",
      syncSettings: {
        calendar: { enabled: true },
      },
    });
    prismaMock.oAuthConnection.update.mockResolvedValue({});
    fetchCalendarEventsMock.mockResolvedValue([{
      id: "event-1",
      provider: "GOOGLE",
      title: "Customer pilot",
      description: "Pilot follow-up",
      startTime: new Date("2026-05-24T12:00:00.000Z"),
      endTime: new Date("2026-05-24T12:30:00.000Z"),
      attendees: ["customer@example.test", "owner@corgtex.com"],
      organizerEmail: "owner@corgtex.com",
      meetingUrl: null,
      htmlLink: "https://calendar.test/event-1",
      status: null,
      visibility: null,
      transparency: null,
      responseStatus: null,
    }]);
    materializeCrmCalendarTouchpointsMock.mockResolvedValue({});
    syncKnowledgeForSourceMock.mockResolvedValue(undefined);
  });

  it("materializes calendar relationship touchpoints after indexing eligible events", async () => {
    const { handleCalendarSync } = await import("./knowledge-sync");

    await handleCalendarSync("job-1", { connectionId: "conn-1" }, "workspace-1");

    expect(syncKnowledgeForSourceMock).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "workspace-1",
      sourceType: "MEETING",
      sourceId: "calendar-event-1",
      sourceTitle: "Customer pilot",
    }));
    expect(materializeCrmCalendarTouchpointsMock).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      connectionId: "conn-1",
      events: [expect.objectContaining({ id: "event-1", attendees: ["customer@example.test", "owner@corgtex.com"] })],
    });
  });
});

describe("OAuth document and email knowledge sync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.oAuthConnection.findUnique.mockResolvedValue({
      id: "conn-1",
      workspaceId: "workspace-1",
      provider: "GOOGLE",
      status: "ACTIVE",
      syncSettings: {},
    });
    prismaMock.oAuthConnection.update.mockResolvedValue({});
    fetchCalendarEventsMock.mockResolvedValue([]);
    fetchFilteredEmailMessagesMock.mockResolvedValue([]);
    fetchSelectedDocumentsMock.mockResolvedValue([]);
    materializeCrmCalendarTouchpointsMock.mockResolvedValue({});
    materializeCrmEmailTouchpointsMock.mockResolvedValue({});
    syncKnowledgeForSourceMock.mockResolvedValue(undefined);
  });

  it("does not index documents without explicit selected file IDs", async () => {
    prismaMock.oAuthConnection.findUnique.mockResolvedValueOnce({
      id: "conn-1",
      workspaceId: "workspace-1",
      provider: "GOOGLE",
      status: "ACTIVE",
      syncSettings: {
        documents: { enabled: true, selectedDriveIds: [] },
      },
    });
    const { handleOAuthDocumentsSync } = await import("./knowledge-sync");

    await handleOAuthDocumentsSync("job-1", { connectionId: "conn-1" }, "workspace-1");

    expect(fetchSelectedDocumentsMock).not.toHaveBeenCalled();
    expect(syncKnowledgeForSourceMock).not.toHaveBeenCalled();
  });

  it("indexes only selected OAuth documents and records sync health", async () => {
    prismaMock.oAuthConnection.findUnique.mockResolvedValueOnce({
      id: "conn-1",
      workspaceId: "workspace-1",
      provider: "GOOGLE",
      status: "ACTIVE",
      syncSettings: {
        documents: { enabled: true, selectedDriveIds: ["doc-1"] },
      },
    });
    fetchSelectedDocumentsMock.mockResolvedValueOnce([{
      id: "doc-1",
      provider: "GOOGLE",
      name: "Launch notes",
      mimeType: "text/plain",
      webUrl: "https://drive.test/doc-1",
      modifiedAt: new Date("2026-05-24T12:00:00.000Z"),
      contentText: "Only this selected document should be indexed.",
    }]);
    const { handleOAuthDocumentsSync } = await import("./knowledge-sync");

    await handleOAuthDocumentsSync("job-1", { connectionId: "conn-1" }, "workspace-1");

    expect(fetchSelectedDocumentsMock).toHaveBeenCalledWith("conn-1", ["doc-1"]);
    expect(syncKnowledgeForSourceMock).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "workspace-1",
      sourceType: "DOCUMENT",
      sourceId: "oauth-doc-conn-1-google-doc-1",
      sourceTitle: "Launch notes",
      content: expect.stringContaining("Only this selected document should be indexed."),
      metadata: expect.objectContaining({
        connectionId: "conn-1",
        provider: "GOOGLE",
        providerDocumentId: "doc-1",
        workflowJobId: "job-1",
      }),
    }));
    expect(prismaMock.oAuthConnection.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "conn-1" },
      data: expect.objectContaining({ lastSyncError: null, status: "ACTIVE" }),
    }));
  });

  it("does not index email without explicit source filters", async () => {
    prismaMock.oAuthConnection.findUnique.mockResolvedValueOnce({
      id: "conn-1",
      workspaceId: "workspace-1",
      provider: "MICROSOFT",
      status: "ACTIVE",
      syncSettings: {
        email: { enabled: true, filters: [] },
      },
    });
    const { handleOAuthEmailSync } = await import("./knowledge-sync");

    await handleOAuthEmailSync("job-1", { connectionId: "conn-1" }, "workspace-1");

    expect(fetchFilteredEmailMessagesMock).not.toHaveBeenCalled();
    expect(syncKnowledgeForSourceMock).not.toHaveBeenCalled();
    expect(materializeCrmEmailTouchpointsMock).not.toHaveBeenCalled();
  });

  it("indexes filtered OAuth email as document knowledge", async () => {
    prismaMock.oAuthConnection.findUnique.mockResolvedValueOnce({
      id: "conn-1",
      workspaceId: "workspace-1",
      provider: "MICROSOFT",
      status: "ACTIVE",
      syncSettings: {
        email: { enabled: true, filters: ["from:customer@example.test"] },
      },
    });
    fetchFilteredEmailMessagesMock.mockResolvedValueOnce([{
      id: "msg-1",
      provider: "MICROSOFT",
      subject: "ERP rollout",
      from: "customer@example.test",
      receivedAt: new Date("2026-05-24T12:00:00.000Z"),
      webUrl: "https://outlook.test/msg-1",
      snippet: "The ERP rollout should be enterprise managed.",
      filter: "from:customer@example.test",
    }]);
    const { handleOAuthEmailSync } = await import("./knowledge-sync");

    await handleOAuthEmailSync("job-1", { connectionId: "conn-1" }, "workspace-1");

    expect(fetchFilteredEmailMessagesMock).toHaveBeenCalledWith("conn-1", ["from:customer@example.test"]);
    expect(syncKnowledgeForSourceMock).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "workspace-1",
      sourceType: "DOCUMENT",
      sourceId: "oauth-email-conn-1-microsoft-msg-1",
      sourceTitle: "Email: ERP rollout",
      metadata: expect.objectContaining({
        sourceKind: "email",
        filter: "from:customer@example.test",
        workflowJobId: "job-1",
      }),
    }));
    expect(materializeCrmEmailTouchpointsMock).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      connectionId: "conn-1",
      messages: [expect.objectContaining({ id: "msg-1", filter: "from:customer@example.test" })],
    });
  });
});
