import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  beginOAuthKnowledgeSyncMock,
  checkpointMock,
  recordFailureMock,
  sourceGuardMock,
  fetchCalendarEventsMock,
  fetchFilteredEmailMessagesMock,
  fetchSelectedDocumentsMock,
  externalResourceKnowledgeInputMock,
  materializeCrmCalendarTouchpointsMock,
  materializeCrmEmailTouchpointsMock,
  prismaMock,
  syncExternalContentSourceMock,
  syncKnowledgeForSourceMock,
  syncDocumentKnowledgeMock,
} = vi.hoisted(() => ({
  beginOAuthKnowledgeSyncMock: vi.fn(),
  checkpointMock: vi.fn(),
  recordFailureMock: vi.fn(),
  sourceGuardMock: vi.fn(),
  fetchCalendarEventsMock: vi.fn(),
  fetchFilteredEmailMessagesMock: vi.fn(),
  fetchSelectedDocumentsMock: vi.fn(),
  externalResourceKnowledgeInputMock: vi.fn(),
  materializeCrmCalendarTouchpointsMock: vi.fn(),
  materializeCrmEmailTouchpointsMock: vi.fn(),
  syncExternalContentSourceMock: vi.fn(),
  prismaMock: {
    communicationMessage: {
      findUnique: vi.fn(),
    },
    communicationChannel: {
      findUnique: vi.fn(),
    },
    document: {
      findUnique: vi.fn(),
    },
    knowledgeChunk: {
      deleteMany: vi.fn(),
    },
    meeting: {
      findUnique: vi.fn(),
    },
    oAuthConnection: {
      updateMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
  syncKnowledgeForSourceMock: vi.fn(),
  syncDocumentKnowledgeMock: vi.fn(),
}));

vi.mock("../../../domain/src/oauth-provider-native", () => ({beginOAuthKnowledgeSync: beginOAuthKnowledgeSyncMock}));

vi.mock("@corgtex/shared", () => ({
  prisma: prismaMock,
}));

vi.mock("@corgtex/knowledge", () => ({
  syncKnowledgeForSource: syncKnowledgeForSourceMock,
  syncDocumentKnowledge: syncDocumentKnowledgeMock,
  syncBrainArticleKnowledge: vi.fn(),
}));

vi.mock("@corgtex/domain", () => ({
  fetchCalendarEvents: fetchCalendarEventsMock,
  fetchFilteredEmailMessages: fetchFilteredEmailMessagesMock,
  fetchSelectedDocuments: fetchSelectedDocumentsMock,
  externalResourceKnowledgeInput: externalResourceKnowledgeInputMock,
  materializeCrmCalendarTouchpoints: materializeCrmCalendarTouchpointsMock,
  materializeCrmEmailTouchpoints: materializeCrmEmailTouchpointsMock,
  syncExternalContentSource: syncExternalContentSourceMock,
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

describe("handleDocumentKnowledgeSync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    syncDocumentKnowledgeMock.mockResolvedValue(1);
  });

  it("routes document indexing through the archive-safe synchronization path", async () => {
    const { handleDocumentKnowledgeSync } = await import("./knowledge-sync");

    await handleDocumentKnowledgeSync("job-1", { documentId: "document-1" }, "workspace-1");

    expect(syncDocumentKnowledgeMock).toHaveBeenCalledWith({ workspaceId: "workspace-1", documentId: "document-1", workflowJobId: "job-1" });
  });
});

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

describe("handleExternalResourceKnowledgeSync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    externalResourceKnowledgeInputMock.mockResolvedValue({
      workspaceId: "workspace-1",
      sourceType: "EXTERNAL_RESOURCE",
      sourceId: "resource-1",
      sourceTitle: "Budget model",
      content: "Budget model\n\nProvider: box",
      metadata: {
        providerKey: "box",
        category: "FILES",
      },
    });
    syncKnowledgeForSourceMock.mockResolvedValue(undefined);
  });

  it("indexes captured external resources into Brain chunks", async () => {
    const { handleExternalResourceKnowledgeSync } = await import("./knowledge-sync");

    await handleExternalResourceKnowledgeSync("job-1", { resourceId: "resource-1" }, "workspace-1");

    expect(externalResourceKnowledgeInputMock).toHaveBeenCalledWith("resource-1", "workspace-1");
    expect(syncKnowledgeForSourceMock).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "workspace-1",
      sourceType: "EXTERNAL_RESOURCE",
      sourceId: "resource-1",
      sourceTitle: "Budget model",
      metadata: expect.objectContaining({
        providerKey: "box",
        workflowJobId: "job-1",
      }),
      workflowJobId: "job-1",
    }));
  });
});

describe("handleExternalContentKnowledgeSync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    syncExternalContentSourceMock.mockResolvedValue({
      status: "SYNCED",
      chunksCreated: 2,
      brainSourceId: "brain-source-1",
    });
  });

  it("delegates selected external content sync through the domain source state machine", async () => {
    const { handleExternalContentKnowledgeSync } = await import("./knowledge-sync");

    await handleExternalContentKnowledgeSync("job-1", { sourceId: "source-1" }, "workspace-1");

    expect(syncExternalContentSourceMock).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      workflowJobId: "job-1",
      syncKnowledge: expect.any(Function),
    });
    const syncKnowledge = syncExternalContentSourceMock.mock.calls[0][0].syncKnowledge;
    await syncKnowledge({
      workspaceId: "workspace-1",
      sourceType: "EXTERNAL_CONTENT",
      sourceId: "source-1",
      sourceTitle: "Box source",
      content: "Box source content",
      metadata: { providerKey: "box" },
      lineageActor: { kind: "agent", label: "opaque-worker" },
      workflowJobId: "job-1",
    });
    expect(syncKnowledgeForSourceMock).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "workspace-1",
      sourceType: "EXTERNAL_CONTENT",
      sourceId: "source-1",
      sourceTitle: "Box source",
      workflowJobId: "job-1",
      lineageActor: expect.objectContaining({ label: "opaque-worker" }),
    }));
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
    prismaMock.oAuthConnection.findFirst.mockResolvedValue({id: "conn-1"});
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
  const claimTime = new Date();
  const claim = (kind: string) => ({id: "job-1", workspaceId: "workspace-1", type: `oauth.${kind}.sync`, payload: {connectionId: "conn-1"}, attempts: 1, lockedBy: "worker", lockedAt: claimTime, startedAt: claimTime});
  const actor = {kind: "user", user: {id: "owner", email: "owner@example.test", displayName: null}};
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.oAuthConnection.findUnique.mockResolvedValue({id: "conn-1", workspaceId: "workspace-1", provider: "GOOGLE", status: "ACTIVE",
      syncSettings: {documents: {enabled: true, selectedDriveIds: ["doc-1"]}, email: {enabled: true, filters: ["from:customer@example.test"]}}});
    prismaMock.oAuthConnection.updateMany.mockResolvedValue({count: 1});
    sourceGuardMock.mockResolvedValue(undefined);
    checkpointMock.mockResolvedValue(undefined);
    recordFailureMock.mockResolvedValue(undefined);
    syncKnowledgeForSourceMock.mockResolvedValue(1);
    beginOAuthKnowledgeSyncMock.mockResolvedValue({sourceTransactionGuard: (operation: () => Promise<unknown>) => operation(), actor, sourceGuard: sourceGuardMock, assertCurrent: sourceGuardMock, checkpoint: checkpointMock, recordFailure: recordFailureMock,
      documents: [{id: "canonical-document", title: "Selected content", textContent: "Only the captured body", accessDomain: "WORKSPACE", updatedAt: new Date("2026-05-24Z")}],
      emailPublication: {}, messages: [{id: "msg-1", filter: "from:customer@example.test"}]});
  });
  it.each(["documents", "email"] as const)("does not fetch %s without an explicit selection", async kind => {
    prismaMock.oAuthConnection.findUnique.mockResolvedValueOnce({id: "conn-1", workspaceId: "workspace-1", status: "ACTIVE",
      syncSettings: {[kind]: {enabled: true, selectedDriveIds: [], filters: []}}});
    const handlers = await import("./knowledge-sync");
    await (kind === "documents" ? handlers.handleOAuthDocumentsSync : handlers.handleOAuthEmailSync)("job-1", {connectionId: "conn-1"}, "workspace-1", claim(kind));
    expect(beginOAuthKnowledgeSyncMock).not.toHaveBeenCalled();
    expect(syncKnowledgeForSourceMock).not.toHaveBeenCalled();
    expect(checkpointMock).not.toHaveBeenCalled();
  });
  it.each(["documents", "email"] as const)("indexes canonical %s with original owner/job guard before checkpoint", async kind => {
    const handlers = await import("./knowledge-sync");
    await (kind === "documents" ? handlers.handleOAuthDocumentsSync : handlers.handleOAuthEmailSync)("job-1", {connectionId: "conn-1"}, "workspace-1", claim(kind));
    expect(beginOAuthKnowledgeSyncMock).toHaveBeenCalledWith({workspaceId: "workspace-1", connectionId: "conn-1", workflowJobId: "job-1", kind, expectedClaim: claim(kind)});
    expect(syncKnowledgeForSourceMock).toHaveBeenCalledWith(expect.objectContaining({workspaceId: "workspace-1", sourceType: "DOCUMENT", sourceId: "canonical-document",
      content: "Selected content\n\nOnly the captured body", lineageActor: actor, sourceGuard: sourceGuardMock, sourceTransactionGuard: expect.any(Function)}));
    expect(checkpointMock).toHaveBeenCalledOnce();
    expect(checkpointMock.mock.invocationCallOrder[0]).toBeGreaterThan(syncKnowledgeForSourceMock.mock.invocationCallOrder[0]);
    if (kind === "email") expect(materializeCrmEmailTouchpointsMock).toHaveBeenCalledWith({workspaceId: "workspace-1", connectionId: "conn-1", messages: [{id: "msg-1", filter: "from:customer@example.test"}], publication: {}});
  });
  it.each(["documents", "email"] as const)("does not report %s success when nonempty canonical content is withheld", async kind => {
    syncKnowledgeForSourceMock.mockResolvedValueOnce(0);
    const handlers = await import("./knowledge-sync");
    await expect((kind === "documents" ? handlers.handleOAuthDocumentsSync : handlers.handleOAuthEmailSync)("job-1", {connectionId: "conn-1"}, "workspace-1", claim(kind))).rejects.toMatchObject({code: "SOURCE_CHANGED"});
    expect(checkpointMock).not.toHaveBeenCalled();
    expect(materializeCrmEmailTouchpointsMock).not.toHaveBeenCalled();
    expect(recordFailureMock).toHaveBeenCalledTimes(1);
    expect(prismaMock.oAuthConnection.updateMany).not.toHaveBeenCalled();
  });
});
