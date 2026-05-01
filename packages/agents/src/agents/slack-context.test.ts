import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  prismaMock,
  chatMock,
  extractMock,
  createWorkItemMock,
  isAgentEnabledMock,
  sendSlackMessageMock,
  getAgentModelOverrideMock,
} = vi.hoisted(() => ({
  prismaMock: {
    workspaceAgentConfig: {
      findUnique: vi.fn(),
    },
    communicationInstallation: {
      findFirst: vi.fn(),
    },
    communicationMessage: {
      findMany: vi.fn(),
      count: vi.fn(),
    },
    communicationChannel: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
    },
    communicationContextSummary: {
      upsert: vi.fn(),
      deleteMany: vi.fn(),
    },
    communicationEntityLink: {
      findFirst: vi.fn(),
      create: vi.fn(),
    },
    workflowJob: {
      upsert: vi.fn(),
    },
  },
  chatMock: vi.fn(),
  extractMock: vi.fn(),
  createWorkItemMock: vi.fn(),
  isAgentEnabledMock: vi.fn(),
  sendSlackMessageMock: vi.fn(),
  getAgentModelOverrideMock: vi.fn(),
}));

vi.mock("@corgtex/shared", () => ({
  prisma: prismaMock,
  toInputJson: (value: unknown) => JSON.parse(JSON.stringify(value ?? null)),
}));

vi.mock("@corgtex/models", () => ({
  resolveModel: vi.fn().mockReturnValue("fake-model"),
  defaultModelGateway: {
    chat: chatMock,
    extract: extractMock,
  },
}));

vi.mock("@corgtex/domain", () => ({
  AGENT_REGISTRY: {
    "slack-agent": {
      defaultModelTier: "standard",
    },
  },
  createWorkItemFromCommunicationSource: createWorkItemMock,
  getAgentModelOverride: getAgentModelOverrideMock,
  isAgentEnabled: isAgentEnabledMock,
  sendSlackMessage: sendSlackMessageMock,
}));

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    id: "message-1",
    installationId: "install-1",
    workspaceId: "workspace-1",
    provider: "SLACK",
    externalChannelId: "C1",
    externalMessageId: "1714320000.000100",
    externalUserId: "U1",
    threadExternalId: null,
    text: "Jan should follow up by tomorrow.",
    messageTs: new Date("2026-04-29T16:00:00.000Z"),
    ...overrides,
  };
}

describe("Slack context jobs", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.workspaceAgentConfig.findUnique.mockResolvedValue(null);
    prismaMock.communicationInstallation.findFirst.mockResolvedValue({
      id: "install-1",
      settings: {},
    });
    prismaMock.communicationMessage.findMany.mockResolvedValue([]);
    prismaMock.communicationMessage.count.mockResolvedValue(0);
    prismaMock.communicationChannel.findMany.mockResolvedValue([
      { externalChannelId: "C1" },
    ]);
    prismaMock.communicationChannel.findUnique.mockResolvedValue({ name: "general" });
    prismaMock.communicationContextSummary.upsert.mockResolvedValue({ id: "summary-1" });
    prismaMock.communicationContextSummary.deleteMany.mockResolvedValue({ count: 0 });
    prismaMock.communicationEntityLink.findFirst.mockResolvedValue(null);
    prismaMock.communicationEntityLink.create.mockResolvedValue({ id: "link-1" });
    prismaMock.workflowJob.upsert.mockResolvedValue({ id: "job-1" });
    chatMock.mockResolvedValue({
      content: "The team agreed on the owner, budget cap, and remaining open questions.",
    });
    extractMock.mockResolvedValue({
      output: {
        intent: "ignore",
        confidence: 0,
      },
    });
    createWorkItemMock.mockResolvedValue({
      entityType: "Action",
      entityId: "action-1",
      webUrl: "https://app.example.test/workspaces/workspace-1/actions",
      opened: false,
    });
    isAgentEnabledMock.mockResolvedValue(true);
    sendSlackMessageMock.mockResolvedValue({ ok: true, ts: "1714320999.000100" });
    getAgentModelOverrideMock.mockResolvedValue(undefined);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-29T21:00:00Z"));
  });

  it("summarizes stored Slack messages into durable context summaries", async () => {
    prismaMock.communicationMessage.findMany.mockResolvedValueOnce([
      candidate({ id: "message-1", text: "Alice owns the launch checklist." }),
      candidate({ id: "message-2", externalMessageId: "1714320100.000100", text: "Bob will confirm the support window." }),
    ]);

    const { runSlackContextSummary } = await import("./slack-context");
    await expect(runSlackContextSummary({
      workspaceId: "workspace-1",
      installationId: "install-1",
      channelId: "C1",
      threadTs: "1714320000.000100",
      dayISO: "2026-04-29",
      workflowJobId: "job-1",
    })).resolves.toEqual({ summarized: true, messageCount: 2 });

    expect(chatMock).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "workspace-1",
      taskType: "SUMMARY",
    }));
    expect(prismaMock.communicationContextSummary.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        installationId_summaryKey: {
          installationId: "install-1",
          summaryKey: "channel:C1:thread:1714320000.000100:day:2026-04-29",
        },
      },
      create: expect.objectContaining({
        workspaceId: "workspace-1",
        provider: "SLACK",
        externalChannelId: "C1",
        threadExternalId: "1714320000.000100",
        summaryMd: expect.stringContaining("owner"),
        sourceMessageIds: ["message-1", "message-2"],
      }),
    }));
  });

  it("skips proactive scans for muted public channels", async () => {
    prismaMock.workspaceAgentConfig.findUnique.mockResolvedValueOnce({
      configJson: {
        publicIngestionEnabled: true,
        proactiveEnabled: true,
        mutedChannelIds: ["C1"],
      },
    });

    const { runSlackProactiveScan } = await import("./slack-context");
    await expect(runSlackProactiveScan({
      workspaceId: "workspace-1",
      installationId: "install-1",
      workflowJobId: "job-1",
    })).resolves.toEqual({ skipped: true, reason: "no_channels" });

    expect(prismaMock.communicationMessage.findMany).not.toHaveBeenCalled();
    expect(sendSlackMessageMock).not.toHaveBeenCalled();
  });

  it("schedules agenda prep and nudges unanswered public Slack questions once", async () => {
    prismaMock.communicationInstallation.findFirst.mockResolvedValueOnce({
      id: "install-1",
      settings: { defaultAgendaChannelId: "C-agenda" },
    });
    prismaMock.communicationMessage.findMany.mockResolvedValueOnce([
      candidate({
        text: "Does anyone know who owns the customer follow-up?",
        messageTs: new Date("2026-04-29T15:30:00.000Z"),
      }),
    ]);

    const { runSlackProactiveScan } = await import("./slack-context");
    await expect(runSlackProactiveScan({
      workspaceId: "workspace-1",
      installationId: "install-1",
      workflowJobId: "job-1",
    })).resolves.toEqual({ agendaJobs: 1, nudges: 1, drafts: 0 });

    expect(prismaMock.workflowJob.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        workspaceId: "workspace-1",
        type: "meeting.agenda.prepare",
        payload: { targetDateISO: "2026-04-30" },
      }),
    }));
    expect(sendSlackMessageMock).toHaveBeenCalledWith("install-1", {
      channel: "C1",
      threadTs: "1714320000.000100",
    }, expect.any(Array), "This looks unanswered.");
    expect(prismaMock.communicationEntityLink.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        action: "proactive_unanswered_nudge",
        messageId: "message-1",
      }),
    }));
  });

  it("respects proactive confidence thresholds before creating private drafts", async () => {
    prismaMock.communicationMessage.findMany.mockResolvedValueOnce([
      candidate({ text: "Jan should follow up by tomorrow." }),
    ]);
    extractMock.mockResolvedValueOnce({
      output: {
        intent: "create_action",
        confidence: 0.89,
        title: "Follow up",
        bodyMd: "Jan should follow up by tomorrow.",
      },
    });

    const { runSlackProactiveScan } = await import("./slack-context");
    await expect(runSlackProactiveScan({
      workspaceId: "workspace-1",
      installationId: "install-1",
      workflowJobId: "job-1",
    })).resolves.toEqual({ agendaJobs: 0, nudges: 0, drafts: 0 });

    expect(createWorkItemMock).not.toHaveBeenCalled();
  });

  it("creates private drafts and replies only for high-confidence safe work items", async () => {
    prismaMock.communicationMessage.findMany.mockResolvedValueOnce([
      candidate({ text: "Jan should follow up by tomorrow." }),
    ]);
    extractMock.mockResolvedValueOnce({
      output: {
        intent: "create_action",
        confidence: 0.93,
        title: "Follow up",
        bodyMd: "Jan should follow up by tomorrow.",
      },
    });

    const { runSlackProactiveScan } = await import("./slack-context");
    await expect(runSlackProactiveScan({
      workspaceId: "workspace-1",
      installationId: "install-1",
      workflowJobId: "job-1",
    })).resolves.toEqual({ agendaJobs: 0, nudges: 0, drafts: 1 });

    expect(createWorkItemMock).toHaveBeenCalledWith(expect.objectContaining({ kind: "agent" }), expect.objectContaining({
      workspaceId: "workspace-1",
      provider: "SLACK",
      kind: "ACTION",
      title: "Follow up",
      sourceMessageId: "message-1",
      open: false,
    }));
    expect(sendSlackMessageMock).toHaveBeenCalledWith("install-1", {
      channel: "C1",
      threadTs: "1714320000.000100",
    }, expect.any(Array), "Created a private Corgtex draft: Follow up");
  });
});
