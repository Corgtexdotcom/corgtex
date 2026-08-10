import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  prismaMock,
  chatMock,
  extractMock,
  createWorkItemMock,
  postDeliberationEntryMock,
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
      updateMany: vi.fn(),
    },
    communicationExternalUser: { findMany: vi.fn() },
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
      findMany: vi.fn(),
      create: vi.fn(),
    },
    action: {
      findMany: vi.fn(),
    },
    workflowJob: {
      upsert: vi.fn(),
    },
  },
  chatMock: vi.fn(),
  extractMock: vi.fn(),
  createWorkItemMock: vi.fn(),
  postDeliberationEntryMock: vi.fn(),
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
  postDeliberationEntry: postDeliberationEntryMock,
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

function setupPendingNudge(source: any, threadMessages = [source]) {
  prismaMock.communicationMessage.findMany
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce(threadMessages);
  prismaMock.communicationEntityLink.findMany
    .mockResolvedValueOnce([nudgeLink({ message: source })])
    .mockResolvedValueOnce([]);
}

function nudgeLink(overrides: Record<string, unknown> = {}) {
  const message = candidate({
    text: "Please confirm availability for the June 23 call.",
    messageTs: new Date("2026-04-28T15:30:00.000Z"),
  });
  return {
    id: "nudge-1",
    createdAt: new Date("2026-04-28T20:00:00.000Z"),
    externalUserId: "U1",
    messageId: message.id,
    message,
    ...overrides,
  };
}

function actionCreatedLink(overrides: Record<string, unknown> = {}) {
  const message = candidate({
    text: "Please confirm availability for the June 23 call.",
    messageTs: new Date("2026-04-28T15:30:00.000Z"),
  });
  return {
    id: "action-link-1",
    createdAt: new Date("2026-04-26T20:00:00.000Z"),
    entityId: "action-1",
    externalUserId: "U1",
    messageId: message.id,
    message,
    ...overrides,
  };
}

describe("Slack context jobs", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    vi.resetAllMocks();
    prismaMock.workspaceAgentConfig.findUnique.mockResolvedValue(null);
    prismaMock.communicationInstallation.findFirst.mockResolvedValue({
      id: "install-1",
      settings: {},
      botUserId: "bot-1",
    });
    prismaMock.communicationInstallation.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.communicationExternalUser.findMany.mockResolvedValue([{ externalUserId: "U1", displayName: "Jan Brezina" }, { externalUserId: "U2", displayName: "田中さん" }]);
    prismaMock.communicationMessage.findMany.mockResolvedValue([]);
    prismaMock.communicationMessage.count.mockResolvedValue(0);
    prismaMock.communicationChannel.findMany.mockResolvedValue([
      { externalChannelId: "C1" },
    ]);
    prismaMock.communicationChannel.findUnique.mockResolvedValue({ name: "general" });
    prismaMock.communicationContextSummary.upsert.mockResolvedValue({ id: "summary-1" });
    prismaMock.communicationContextSummary.deleteMany.mockResolvedValue({ count: 0 });
    prismaMock.communicationEntityLink.findFirst.mockResolvedValue(null);
    prismaMock.communicationEntityLink.findMany.mockResolvedValue([]);
    prismaMock.communicationEntityLink.create.mockResolvedValue({ id: "link-1" });
    prismaMock.action.findMany.mockResolvedValue([]);
    prismaMock.workflowJob.upsert.mockResolvedValue({ id: "job-1" });
    chatMock.mockResolvedValue({
      content: "The team agreed on the owner, budget cap, and remaining open questions.",
    });
    extractMock.mockResolvedValue({
      output: {
        resolutionState: "open",
        workDisposition: "ignore",
        confidence: 0,
      },
    });
    createWorkItemMock.mockResolvedValue({
      entityType: "Action",
      entityId: "action-1",
      webUrl: "https://app.example.test/workspaces/workspace-1/actions",
      opened: false,
    });
    postDeliberationEntryMock.mockResolvedValue({ id: "deliberation-1" });
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
        messageTs: new Date("2026-04-28T15:30:00.000Z"),
      }),
    ]);

    const { runSlackProactiveScan } = await import("./slack-context");
    await expect(runSlackProactiveScan({
      workspaceId: "workspace-1",
      installationId: "install-1",
      workflowJobId: "job-1",
    })).resolves.toEqual({ agendaJobs: 1, nudges: 1, actions: 0, followups: 0, drafts: 0 });

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
      text: "This looks unanswered.",
    }, expect.any(Array));
    expect(sendSlackMessageMock.mock.calls[0][2][0].text.text).toContain("bringing it back into awareness");
    expect(prismaMock.communicationEntityLink.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        action: "proactive_unanswered_nudge",
        messageId: "message-1",
      }),
    }));
  });

  it("does not nudge unanswered public Slack questions before 24 hours", async () => {
    const { runSlackProactiveScan } = await import("./slack-context");
    await expect(runSlackProactiveScan({
      workspaceId: "workspace-1",
      installationId: "install-1",
      workflowJobId: "job-1",
    })).resolves.toEqual({ agendaJobs: 0, nudges: 0, actions: 0, followups: 0, drafts: 0 });

    expect(prismaMock.communicationMessage.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        messageTs: expect.objectContaining({
          lte: new Date("2026-04-28T21:00:00.000Z"),
        }),
      }),
    }));
    expect(sendSlackMessageMock).not.toHaveBeenCalled();
    expect(prismaMock.communicationEntityLink.create).not.toHaveBeenCalled();
  });

  it("does not duplicate unanswered nudges on later hourly scans", async () => {
    prismaMock.communicationMessage.findMany.mockResolvedValueOnce([
      candidate({
        text: "Does anyone know who owns the customer follow-up?",
        messageTs: new Date("2026-04-28T15:30:00.000Z"),
      }),
    ]);
    prismaMock.communicationEntityLink.findFirst.mockResolvedValueOnce({ id: "nudge-1" });

    const { runSlackProactiveScan } = await import("./slack-context");
    await expect(runSlackProactiveScan({
      workspaceId: "workspace-1",
      installationId: "install-1",
      workflowJobId: "job-1",
    })).resolves.toEqual({ agendaJobs: 0, nudges: 0, actions: 0, followups: 0, drafts: 0 });

    expect(sendSlackMessageMock).not.toHaveBeenCalled();
    expect(prismaMock.communicationEntityLink.create).not.toHaveBeenCalled();
  });

  it("marks Slack installations reauth-required after invalid_auth and stops proactive work", async () => {
    prismaMock.communicationMessage.findMany.mockResolvedValueOnce([
      candidate({
        text: "Does anyone know who owns the customer follow-up?",
        messageTs: new Date("2026-04-28T15:30:00.000Z"),
      }),
    ]);
    sendSlackMessageMock.mockRejectedValueOnce(new Error("An API error occurred: invalid_auth"));

    const { runSlackProactiveScan } = await import("./slack-context");
    await expect(runSlackProactiveScan({
      workspaceId: "workspace-1",
      installationId: "install-1",
      workflowJobId: "job-1",
    })).resolves.toEqual({ skipped: true, reason: "slack_reauth_required" });

    expect(prismaMock.communicationInstallation.updateMany).toHaveBeenCalledWith({
      where: {
        id: "install-1",
        workspaceId: "workspace-1",
        provider: "SLACK",
      },
      data: expect.objectContaining({
        status: "ERROR",
        lastError: "invalid_auth",
        disconnectedAt: expect.any(Date),
      }),
    });
    expect(prismaMock.communicationInstallation.updateMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.communicationEntityLink.create).not.toHaveBeenCalled();
  });

  it("does not create proactive actions before 24 hours has passed since the nudge", async () => {
    const { runSlackProactiveScan } = await import("./slack-context");
    await expect(runSlackProactiveScan({
      workspaceId: "workspace-1",
      installationId: "install-1",
      workflowJobId: "job-1",
    })).resolves.toEqual({ agendaJobs: 0, nudges: 0, actions: 0, followups: 0, drafts: 0 });

    expect(prismaMock.communicationEntityLink.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        action: "proactive_unanswered_nudge",
        createdAt: { lte: new Date("2026-04-28T21:00:00.000Z") },
      }),
    }));
    expect(prismaMock.communicationExternalUser.findMany).not.toHaveBeenCalled();
  });

  it("respects proactive confidence thresholds before creating published actions", async () => {
    const source = candidate({
      text: "Jan should follow up by tomorrow.",
      messageTs: new Date("2026-04-28T15:30:00.000Z"),
    });
    setupPendingNudge(source);
    extractMock.mockResolvedValueOnce({
      output: {
        resolutionState: "open",
        workDisposition: "action",
        concreteNextStep: "follow up",
        ownerEvidence: "Jan",
        negativeCategory: false,
        couldNot: [],
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
    })).resolves.toEqual({ agendaJobs: 0, nudges: 0, actions: 0, followups: 0, drafts: 0 });

    expect(createWorkItemMock).not.toHaveBeenCalled();
  });

  it("creates published actions after the post-nudge wait when unresolved", async () => {
    const source = candidate({
      text: "Jan needs to confirm availability for the June 23 call.",
      messageTs: new Date("2026-04-28T15:30:00.000Z"),
    });
    setupPendingNudge(source);
    extractMock.mockResolvedValueOnce({
      output: {
        resolutionState: "open",
        workDisposition: "action",
        concreteNextStep: "confirm availability for the June 23 call",
        ownerEvidence: "Jan",
        confidence: 0.93,
        title: "Confirm availability",
        bodyMd: "Jan needs to confirm availability for the June 23 call.",
        negativeCategory: false,
        couldNot: [],
      },
    });

    const { runSlackProactiveScan } = await import("./slack-context");
    await expect(runSlackProactiveScan({
      workspaceId: "workspace-1",
      installationId: "install-1",
      workflowJobId: "job-1",
    })).resolves.toEqual({ agendaJobs: 0, nudges: 0, actions: 1, followups: 0, drafts: 1 });

    expect(createWorkItemMock).toHaveBeenCalledWith(expect.objectContaining({ kind: "agent" }), expect.objectContaining({
      workspaceId: "workspace-1",
      provider: "SLACK",
      kind: "ACTION",
      title: "confirm availability for the June 23 call",
      sourceMessageId: "message-1",
      open: true,
    }));
    expect(prismaMock.communicationEntityLink.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        action: "proactive_unanswered_action_created",
        entityType: "Action",
        entityId: "action-1",
      }),
    }));
    expect(sendSlackMessageMock).toHaveBeenCalledWith("install-1", {
      channel: "C1",
      threadTs: "1714320000.000100",
      text: "Created Corgtex action: confirm availability for the June 23 call",
    }, expect.any(Array));
    expect(sendSlackMessageMock.mock.calls[0][2][0].text.text).toContain("still looked unresolved after 24 hours");
  });

  it("does not create actions when thread review marks the item resolved or unsafe", async () => {
    const source = candidate({
      text: "Please confirm availability for the June 23 call.",
      messageTs: new Date("2026-04-28T15:30:00.000Z"),
    });
    setupPendingNudge(source);
    extractMock.mockResolvedValueOnce({
      output: {
        resolutionState: "open",
        workDisposition: "ignore",
        confidence: 0.99,
        couldNot: ["unsafe request"],
        negativeCategory: false,
      },
    });

    const { runSlackProactiveScan } = await import("./slack-context");
    await expect(runSlackProactiveScan({
      workspaceId: "workspace-1",
      installationId: "install-1",
      workflowJobId: "job-1",
    })).resolves.toEqual({ agendaJobs: 0, nudges: 0, actions: 0, followups: 0, drafts: 0 });

    expect(createWorkItemMock).not.toHaveBeenCalled();
    expect(prismaMock.communicationEntityLink.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        action: "proactive_unanswered_resolved",
        entityType: "CommunicationMessage",
        entityId: "message-1",
      }),
    }));
    expect(sendSlackMessageMock).not.toHaveBeenCalled();
  });

  it("posts waiting replies for linked actions even when the source is not work-like", async () => {
    const source = candidate({
      text: "Availability update.",
      messageTs: new Date("2026-04-28T15:30:00.000Z"),
    });
    const waitingReply = candidate({
      id: "message-2",
      externalMessageId: "1714323600.000100",
      text: "No need for more action yet. We are just waiting on the owner to confirm a time slot on June 23.",
      messageTs: new Date("2026-04-28T22:00:00.000Z"),
    });
    prismaMock.communicationMessage.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([source, waitingReply]);
    prismaMock.communicationEntityLink.findMany
      .mockResolvedValueOnce([nudgeLink({ message: source })])
      .mockResolvedValueOnce([]);
    prismaMock.communicationEntityLink.findFirst
      .mockResolvedValueOnce({ id: "existing-action-link", entityId: "action-1" })
      .mockResolvedValueOnce(null);
    extractMock.mockResolvedValueOnce({
      output: {
        resolutionState: "open",
        workDisposition: "action",
        confidence: 0.96,
        updateMd: "Daniel said no more action is needed yet; the team is waiting on the owner to confirm a June 23 time slot.",
        followupDelayMultiplier: 2,
        negativeCategory: false,
        couldNot: [],
      },
    });

    const { runSlackProactiveScan } = await import("./slack-context");
    await expect(runSlackProactiveScan({
      workspaceId: "workspace-1",
      installationId: "install-1",
      workflowJobId: "job-1",
    })).resolves.toEqual({ agendaJobs: 0, nudges: 0, actions: 0, followups: 0, drafts: 0 });

    expect(prismaMock.communicationExternalUser.findMany).not.toHaveBeenCalled();
    expect(postDeliberationEntryMock).toHaveBeenCalledWith(expect.objectContaining({ kind: "agent" }), expect.objectContaining({
      workspaceId: "workspace-1",
      parentType: "ACTION",
      parentId: "action-1",
      entryType: "REACTION",
      bodyMd: "Daniel said no more action is needed yet; the team is waiting on the owner to confirm a June 23 time slot.",
    }));
    expect(prismaMock.communicationEntityLink.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        action: "proactive_action_waiting_update",
        messageId: "message-2",
        entityType: "Action",
        entityId: "action-1",
      }),
    }));
    expect(prismaMock.communicationEntityLink.create).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: "proactive_unanswered_resolved" }) }));
    expect(sendSlackMessageMock).not.toHaveBeenCalled();
  });

  it("follows up after 72 hours for non-completed and non-archived proactive actions", async () => {
    prismaMock.communicationEntityLink.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([actionCreatedLink()]);
    prismaMock.action.findMany.mockResolvedValueOnce([
      { id: "action-1", title: "Confirm availability" },
    ]);

    const { runSlackProactiveScan } = await import("./slack-context");
    await expect(runSlackProactiveScan({
      workspaceId: "workspace-1",
      installationId: "install-1",
      workflowJobId: "job-1",
    })).resolves.toEqual({ agendaJobs: 0, nudges: 0, actions: 0, followups: 1, drafts: 0 });

    expect(prismaMock.action.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        archivedAt: null,
        status: { not: "COMPLETED" },
      }),
    }));
    expect(sendSlackMessageMock).toHaveBeenCalledWith("install-1", {
      channel: "C1",
      threadTs: "1714320000.000100",
      text: "Corgtex action still not completed: Confirm availability",
    }, expect.any(Array));
    expect(prismaMock.communicationEntityLink.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        action: "proactive_action_followup",
        entityType: "Action",
        entityId: "action-1",
      }),
    }));
  });

  it("does not follow up completed or archived proactive actions", async () => {
    prismaMock.communicationEntityLink.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([actionCreatedLink()]);
    prismaMock.action.findMany.mockResolvedValueOnce([]);

    const { runSlackProactiveScan } = await import("./slack-context");
    await expect(runSlackProactiveScan({
      workspaceId: "workspace-1",
      installationId: "install-1",
      workflowJobId: "job-1",
    })).resolves.toEqual({ agendaJobs: 0, nudges: 0, actions: 0, followups: 0, drafts: 0 });

    expect(prismaMock.action.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        archivedAt: null,
        status: { not: "COMPLETED" },
      }),
    }));
    expect(sendSlackMessageMock).not.toHaveBeenCalled();
    expect(prismaMock.communicationEntityLink.create).not.toHaveBeenCalled();
  });

  it("does not follow up actions with a recent waiting update inside the doubled window", async () => {
    prismaMock.communicationEntityLink.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([actionCreatedLink()]);
    prismaMock.action.findMany.mockResolvedValueOnce([
      { id: "action-1", title: "Confirm availability" },
    ]);
    prismaMock.communicationEntityLink.findFirst.mockResolvedValueOnce({ id: "waiting-update-1" });

    const { runSlackProactiveScan } = await import("./slack-context");
    await expect(runSlackProactiveScan({
      workspaceId: "workspace-1",
      installationId: "install-1",
      workflowJobId: "job-1",
    })).resolves.toEqual({ agendaJobs: 0, nudges: 0, actions: 0, followups: 0, drafts: 0 });

    expect(prismaMock.communicationEntityLink.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        action: "proactive_action_waiting_update",
        entityId: "action-1",
        createdAt: { gte: new Date("2026-04-23T21:00:00.000Z") },
      }),
    }));
    expect(sendSlackMessageMock).not.toHaveBeenCalled();
  });

  it("does not duplicate action follow-ups inside the 72 hour window", async () => {
    prismaMock.communicationEntityLink.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([actionCreatedLink()]);
    prismaMock.action.findMany.mockResolvedValueOnce([
      { id: "action-1", title: "Confirm availability" },
    ]);
    prismaMock.communicationEntityLink.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "followup-1" });

    const { runSlackProactiveScan } = await import("./slack-context");
    await expect(runSlackProactiveScan({
      workspaceId: "workspace-1",
      installationId: "install-1",
      workflowJobId: "job-1",
    })).resolves.toEqual({ agendaJobs: 0, nudges: 0, actions: 0, followups: 0, drafts: 0 });

    expect(prismaMock.communicationEntityLink.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        action: "proactive_action_followup",
        entityId: "action-1",
        createdAt: { gte: new Date("2026-04-26T21:00:00.000Z") },
      }),
    }));
    expect(sendSlackMessageMock).not.toHaveBeenCalled();
  });

  it("excludes direct installed-bot mentions at candidate nudge gate AND pending-review defense-in-depth", async () => {
    prismaMock.communicationMessage.findMany.mockResolvedValueOnce([
      candidate({ id: "msg-bot-1", text: "<@bot-1> can you check this status?", messageTs: new Date("2026-04-28T15:30:00.000Z") }),
      candidate({ id: "msg-bot-2", text: "Hey <@bot-1|Corgtex> please follow up", messageTs: new Date("2026-04-28T15:30:00.000Z") }),
    ]);
    const { runSlackProactiveScan } = await import("./slack-context");
    await expect(runSlackProactiveScan({
      workspaceId: "workspace-1",
      installationId: "install-1",
      workflowJobId: "job-1",
    })).resolves.toEqual({ agendaJobs: 0, nudges: 0, actions: 0, followups: 0, drafts: 0 });
    expect(sendSlackMessageMock).not.toHaveBeenCalled();
    expect(extractMock).not.toHaveBeenCalled();
    const botMentionSource1 = candidate({ id: "msg-bot-3", text: "Hey <@bot-1> please update docs", messageTs: new Date("2026-04-28T15:30:00.000Z") });
    const botMentionSource2 = candidate({ id: "msg-bot-4", text: "Hey <@bot-1|Corgtex> please update docs", messageTs: new Date("2026-04-28T15:30:00.000Z") });
    prismaMock.communicationEntityLink.findMany
      .mockResolvedValueOnce([nudgeLink({ message: botMentionSource1 }), nudgeLink({ message: botMentionSource2 })])
      .mockResolvedValueOnce([]);
    await expect(runSlackProactiveScan({
      workspaceId: "workspace-1",
      installationId: "install-1",
      workflowJobId: "job-1",
    })).resolves.toEqual({ agendaJobs: 0, nudges: 0, actions: 0, followups: 0, drafts: 0 });
    expect(extractMock).not.toHaveBeenCalled();
    expect(prismaMock.communicationEntityLink.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "proactive_unanswered_resolved", entityId: "msg-bot-3" }),
    });
    expect(prismaMock.communicationEntityLink.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "proactive_unanswered_resolved", entityId: "msg-bot-4" }),
    });
    const normalSource = candidate({ id: "msg-normal-1", text: "Can you update the docs?", messageTs: new Date("2026-04-28T15:30:00.000Z") });
    setupPendingNudge(normalSource);
    prismaMock.communicationMessage.findMany
      .mockReset()
      .mockResolvedValueOnce([]) // for drafts check
      .mockResolvedValueOnce([
        normalSource,
        candidate({ id: "reply-1", text: "Yes, I will tell <@bot-1> to do it.", messageTs: new Date("2026-04-28T15:35:00.000Z") })
      ]);
    prismaMock.communicationEntityLink.findFirst.mockResolvedValueOnce({ id: "existing-action-link", entityId: "action-1" });
    await expect(runSlackProactiveScan({
      workspaceId: "workspace-1",
      installationId: "install-1",
      workflowJobId: "job-1",
    })).resolves.toEqual({ agendaJobs: 0, nudges: 0, actions: 0, followups: 0, drafts: 0 });
    expect(extractMock).not.toHaveBeenCalled();
    expect(prismaMock.communicationEntityLink.create).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: "proactive_unanswered_resolved", entityId: "msg-normal-1" }) }));
  });

  it("allows non-bot mentions <@U999|Alice> to be nudged and evaluated", async () => {
    prismaMock.communicationMessage.findMany.mockResolvedValueOnce([
      candidate({ id: "msg-other-user", text: "<@U999|Alice> can someone help with the report?", messageTs: new Date("2026-04-28T15:30:00.000Z") }),
    ]);

    const { runSlackProactiveScan } = await import("./slack-context");
    await expect(runSlackProactiveScan({
      workspaceId: "workspace-1",
      installationId: "install-1",
      workflowJobId: "job-1",
    })).resolves.toEqual({ agendaJobs: 0, nudges: 1, actions: 0, followups: 0, drafts: 0 });

    expect(sendSlackMessageMock).toHaveBeenCalledTimes(1);
  });

  it("fails closed for auto-publication when botUserId is missing without broadly excluding mentions", async () => {
    prismaMock.communicationInstallation.findFirst.mockResolvedValueOnce({
      id: "install-1",
      settings: {},
      botUserId: null,
    });
    const source = candidate({ text: "Jan will send the proposal by Friday.", messageTs: new Date("2026-04-28T15:30:00.000Z") });
    setupPendingNudge(source);
    extractMock.mockResolvedValueOnce({
      output: {
        resolutionState: "open",
        workDisposition: "action",
        concreteNextStep: "send proposal",
        ownerEvidence: "Jan",
        confidence: 0.99,
        negativeCategory: false,
        couldNot: [],
        title: "Send proposal",
        bodyMd: "Jan will send the proposal by Friday.",
      },
    });

    const { runSlackProactiveScan } = await import("./slack-context");
    await expect(runSlackProactiveScan({
      workspaceId: "workspace-1",
      installationId: "install-1",
      workflowJobId: "job-1",
    })).resolves.toEqual({ agendaJobs: 0, nudges: 0, actions: 0, followups: 0, drafts: 0 });

    expect(extractMock).toHaveBeenCalledTimes(1);
    expect(createWorkItemMock).not.toHaveBeenCalled();
    expect(prismaMock.communicationEntityLink.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "proactive_unanswered_resolved",
        entityType: "CommunicationMessage",
        entityId: "message-1",
      }),
    });
  });

  it.each([
    { label: "routing test", text: "Please run this routing test for slack context", concreteNextStep: "run this routing test" },
    { label: "generic past-tense test marker", text: "This was only a test. Jan should send the report tomorrow.", concreteNextStep: "send the report" },
    { label: "FYI", text: "FYI: Jan needs to send the report by tomorrow.", concreteNextStep: "send the report" },
    { label: "acknowledgement", text: "Thanks, got it! Jan needs to send the report by tomorrow.", concreteNextStep: "send the report" },
    { label: "already-completed", text: "I already sent the report by tomorrow.", concreteNextStep: "send the report" },
    { label: "info-only", text: "Information only: Jan needs to send the report by tomorrow.", concreteNextStep: "send the report" },
  ])("vetoes action creation for $label source text despite high-confidence action model output", async ({ text, concreteNextStep }) => {
    const source = candidate({ text, messageTs: new Date("2026-04-28T15:30:00.000Z") });
    setupPendingNudge(source);
    extractMock.mockResolvedValueOnce({
      output: {
        resolutionState: "open",
        workDisposition: "action",
        concreteNextStep,
        ownerEvidence: "Jan",
        confidence: 0.99,
        negativeCategory: false,
        couldNot: [],
        title: "Test title",
      },
    });

    const { runSlackProactiveScan } = await import("./slack-context");
    await expect(runSlackProactiveScan({
      workspaceId: "workspace-1",
      installationId: "install-1",
      workflowJobId: "job-1",
    })).resolves.toEqual({ agendaJobs: 0, nudges: 0, actions: 0, followups: 0, drafts: 0 });

    expect(extractMock).toHaveBeenCalledTimes(1);
    expect(createWorkItemMock).not.toHaveBeenCalled();
    expect(prismaMock.communicationEntityLink.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "proactive_unanswered_resolved" }),
    });
  });

  it.each(["Ack", "Acknowledged"])("terminalizes standalone acknowledgement %s without model review", async (text) => {
    setupPendingNudge(candidate({ text, messageTs: new Date("2026-04-28T15:30:00.000Z") }));
    const { runSlackProactiveScan } = await import("./slack-context");
    await runSlackProactiveScan({ workspaceId: "workspace-1", installationId: "install-1", workflowJobId: "job-1" });
    expect(extractMock).not.toHaveBeenCalled();
    expect(createWorkItemMock).not.toHaveBeenCalled();
  });

  it.each([
    { label: "invalid resolutionState", output: { resolutionState: "invalid_state", workDisposition: "action", concreteNextStep: "send report", ownerEvidence: "Jan", confidence: 0.99, negativeCategory: false, couldNot: [] } },
    { label: "missing negativeCategory", output: { resolutionState: "open", workDisposition: "action", concreteNextStep: "send report", ownerEvidence: "Jan", confidence: 0.99, couldNot: [] } },
    { label: "missing couldNot", output: { resolutionState: "open", workDisposition: "action", concreteNextStep: "send report", ownerEvidence: "Jan", confidence: 0.99, negativeCategory: false } },
    { label: "non-empty couldNot reasons", output: { resolutionState: "open", workDisposition: "action", concreteNextStep: "send report", ownerEvidence: "Jan", confidence: 0.99, negativeCategory: false, couldNot: ["unsafe"] } },
    { label: "awareness-only model outcome on generic open question", output: { resolutionState: "open", workDisposition: "awareness", confidence: 0.95, negativeCategory: false, couldNot: [] }, text: "Can you let me know if the staging environment is up?" },
    { label: "ordinary information request", output: { resolutionState: "open", workDisposition: "action", ownerEvidence: "Jan", concreteNextStep: "know whether the server is up", confidence: 0.99, negativeCategory: false, couldNot: [], title: "Check server" }, text: "Jan needs to know whether the server is up?" },
    { label: "indefinite pronoun is not an owner", output: { resolutionState: "open", workDisposition: "action", ownerEvidence: "Someone", concreteNextStep: "send the report", confidence: 0.99, negativeCategory: false, couldNot: [], title: "Send report" }, text: "Someone needs to send the report by tomorrow." },
    { label: "hallucinated owner substring trap", output: { resolutionState: "open", workDisposition: "action", ownerEvidence: "IT", concreteNextStep: "confirm when waiting is finished", confidence: 0.99, negativeCategory: false, couldNot: [], title: "Confirm waiting" }, text: "Please confirm when waiting is finished for the report." },
    { label: "possessive name is not an assignment", output: { resolutionState: "open", workDisposition: "action", ownerEvidence: "Jan", concreteNextStep: "send the report", confidence: 0.99, negativeCategory: false, couldNot: [], title: "Send report" }, text: "Does anyone have Jan's report and need to send the report tomorrow?" },
    { label: "speaker scaffold is not an owner", output: { resolutionState: "open", workDisposition: "action", ownerEvidence: "U1", concreteNextStep: "send the report", confidence: 0.99, negativeCategory: false, couldNot: [], title: "Send report" }, text: "Please send the report by tomorrow." },
    { label: "inanimate grammatical subject is not an owner", output: { resolutionState: "open", workDisposition: "action", ownerEvidence: "Report", concreteNextStep: "go out tomorrow", confidence: 0.99, negativeCategory: false, couldNot: [], title: "Send report" }, text: "Report needs to go out tomorrow." },
    { label: "standalone completion reply", output: { resolutionState: "open", workDisposition: "action", ownerEvidence: "Jan", concreteNextStep: "send the report", confidence: 0.99, negativeCategory: false, couldNot: [], title: "Send report", reply: "Sent it." }, text: "Jan needs to send the report by tomorrow." },
    { label: "ambiguous single-token directory owner", output: { resolutionState: "open", workDisposition: "action", ownerEvidence: "Jan", concreteNextStep: "send the report", confidence: 0.99, negativeCategory: false, couldNot: [], title: "Send report" }, text: "Jan needs to send the report by tomorrow.", trustedUsers: [{ externalUserId: "U1", displayName: "Jan" }, { externalUserId: "U2", displayName: "Jan Brezina" }] },
    { label: "subject-is-completed reply", output: { resolutionState: "open", workDisposition: "action", ownerEvidence: "Jan", concreteNextStep: "send the report", confidence: 0.99, negativeCategory: false, couldNot: [], title: "Send report", reply: "The report is completed." }, text: "Jan needs to send the report by tomorrow." },
    { label: "completed reply with later future clause", output: { resolutionState: "open", workDisposition: "action", ownerEvidence: "Jan", concreteNextStep: "send the report", confidence: 0.99, negativeCategory: false, couldNot: [], title: "Send report", reply: "The report is completed. It will be archived tomorrow." }, text: "Jan needs to send the report by tomorrow." },
    { label: "subject-has-been-fixed reply", output: { resolutionState: "open", workDisposition: "action", ownerEvidence: "Jan", concreteNextStep: "send the report", confidence: 0.99, negativeCategory: false, couldNot: [], title: "Send report", reply: "The issue has been fixed." }, text: "Jan needs to send the report by tomorrow." },
    { label: "past-obligation confirmation", output: { resolutionState: "open", workDisposition: "action", ownerEvidence: "Jan", concreteNextStep: "send the report", confidence: 0.99, negativeCategory: false, couldNot: [], title: "Send report" }, text: "Jan should have sent the report earlier; can someone confirm?" },
    { label: "standalone deployed reply", output: { resolutionState: "open", workDisposition: "action", ownerEvidence: "Jan", concreteNextStep: "send the report", confidence: 0.99, negativeCategory: false, couldNot: [], title: "Send report", reply: "Deployed." }, text: "Jan needs to send the report by tomorrow." },
    { label: "inanimate finance phrase is not a role owner", output: { resolutionState: "open", workDisposition: "action", ownerEvidence: "Finance report", concreteNextStep: "be approved tomorrow", confidence: 0.99, negativeCategory: false, couldNot: [], title: "Approve report" }, text: "Finance report needs to be approved tomorrow." },
    { label: "capitalized Rain is not a trusted owner", output: { resolutionState: "open", workDisposition: "action", ownerEvidence: "Rain", concreteNextStep: "send the report", confidence: 0.99, negativeCategory: false, couldNot: [], title: "Send report" }, text: "Rain needs to send the report by tomorrow." },
    { label: "vague grounded verb is not a deliverable", output: { resolutionState: "open", workDisposition: "action", ownerEvidence: "Jan", concreteNextStep: "send", confidence: 0.99, negativeCategory: false, couldNot: [], title: "Send" }, text: "Jan needs to send something?" },
    { label: "punctuated negated assigned task", output: { resolutionState: "open", workDisposition: "action", ownerEvidence: "Jan", concreteNextStep: "send the report", confidence: 0.99, negativeCategory: false, couldNot: [], title: "Send report" }, text: "Jan should not, under any circumstances, send the report; can someone confirm?" },
    { label: "does-not-need task negation", output: { resolutionState: "open", workDisposition: "action", ownerEvidence: "Jan", concreteNextStep: "send the report", confidence: 0.99, negativeCategory: false, couldNot: [], title: "Send report" }, text: "Jan does not need to send the report; can someone confirm?" },
    { label: "natural create prohibition", output: { resolutionState: "open", workDisposition: "action", ownerEvidence: "Jan", concreteNextStep: "update the guide", confidence: 0.99, negativeCategory: false, couldNot: [], title: "Update guide" }, text: "Jan should update the guide, but Corgtex avoids creating an action item for it." },
    { label: "typographic no-open negation", output: { resolutionState: "open", workDisposition: "action", ownerEvidence: "Jan", concreteNextStep: "update the guide", confidence: 0.99, negativeCategory: false, couldNot: [], title: "Update guide" }, text: "Jan needs to update the guide, but Corgtex shouldn’t open an action item for it." },
    { label: "later human reply veto", output: { resolutionState: "open", workDisposition: "action", ownerEvidence: "Jan", concreteNextStep: "send the report", confidence: 0.99, negativeCategory: false, couldNot: [], title: "Send report", reply: "Don't create an action; this is already done." }, text: "Jan needs to send the report by tomorrow." },
    { label: "typographic-apostrophe negation", output: { resolutionState: "open", workDisposition: "action", concreteNextStep: "update the guide", ownerEvidence: "", explicitActionRequest: true, confidence: 0.95, title: "Update guide", negativeCategory: false, couldNot: [] }, text: "Don’t create an action item to update the guide.", id: "msg-typo-neg" },
    { label: "punctuated negation with intervening phrase", output: { resolutionState: "open", workDisposition: "action", concreteNextStep: "update the guide", ownerEvidence: "Jan", explicitActionRequest: true, confidence: 0.95, title: "Update guide", negativeCategory: false, couldNot: [] }, text: "Jan needs to update the guide, but Corgtex should not, under any circumstances, create an action item", id: "msg-punctuated-neg" },
    { label: "synthetic unknown owner", output: { resolutionState: "open", workDisposition: "action", concreteNextStep: "send report", ownerEvidence: "unknown", confidence: 0.99, negativeCategory: false, couldNot: [] }, text: "unknown needs to send the report.", id: "msg-unknown-owner" },
    { label: "generic ownerless request failing explicit exception", output: { resolutionState: "open", workDisposition: "action", concreteNextStep: "update the guide", ownerEvidence: "", explicitActionRequest: true, confidence: 0.95, title: "Update guide", negativeCategory: false, couldNot: [] }, text: "Can someone please create an action item to update the guide?", id: "msg-generic-explicit" },
    { label: "non-adjacent explicit request failing explicit exception", output: { resolutionState: "open", workDisposition: "action", concreteNextStep: "update the guide", ownerEvidence: "", explicitActionRequest: true, confidence: 0.95, title: "Update guide", negativeCategory: false, couldNot: [] }, text: "Corgtex status is red; can someone please create an action item to update the guide?", id: "msg-non-adjacent-explicit" }
  ])("fails closed on $label, records terminal marker, and later scan does not re-evaluate", async ({ output, text, id, trustedUsers }) => {
    const source = candidate({ id: id || "message-1", text: text || "Jan needs to send the report by tomorrow.", messageTs: new Date("2026-04-28T15:30:00.000Z") }); if (trustedUsers) prismaMock.communicationExternalUser.findMany.mockResolvedValue(trustedUsers);
    setupPendingNudge(source);
    if ("reply" in output) prismaMock.communicationMessage.findMany.mockReset().mockResolvedValueOnce([]).mockResolvedValueOnce([source, candidate({ id: "reply-1", text: output.reply })]);
    extractMock.mockResolvedValueOnce({ output });

    const { runSlackProactiveScan } = await import("./slack-context");
    await expect(runSlackProactiveScan({
      workspaceId: "workspace-1", installationId: "install-1", workflowJobId: "job-1",
    })).resolves.toEqual({ agendaJobs: 0, nudges: 0, actions: 0, followups: 0, drafts: 0 });

    expect(createWorkItemMock).not.toHaveBeenCalled();
    expect(prismaMock.communicationEntityLink.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "proactive_unanswered_resolved", entityId: id || "message-1" }),
    });

    setupPendingNudge(source);
    prismaMock.communicationEntityLink.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "terminal-1" });

    await runSlackProactiveScan({
      workspaceId: "workspace-1", installationId: "install-1", workflowJobId: "job-1",
    });

    expect(extractMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    { label: "will cue and grounded fields override hallucinated prose", text: "Jan will send the report Friday; can someone confirm?", step: "send the report", owner: "Jan", title: "Invent quarterly strategy", bodyMd: "Fabricated private context." },
    { label: "single-word investigate deliverable", text: "Jan should investigate by tomorrow.", step: "investigate", owner: "Jan", title: "Investigate", bodyMd: "Jan should investigate by tomorrow." },
    { label: "single-word deploy with bare future passive", text: "Jan should deploy by tomorrow.", step: "deploy", owner: "Jan", title: "Deploy", bodyMd: "Jan should deploy by tomorrow.", reply: "Will be deployed." },
    { label: "bare should-passive reply remains actionable", text: "Jan should fix the release by tomorrow.", step: "fix the release", owner: "Jan", title: "Fix release", bodyMd: "Jan should fix the release by tomorrow.", reply: "Should be fixed." },
    { label: "pronoun-prefixed modal perfect remains actionable", text: "Jan should deploy the release by tomorrow.", step: "deploy the release", owner: "Jan", title: "Deploy release", bodyMd: "Jan should deploy the release by tomorrow.", reply: "It will have been deployed." },
    { label: "subject-prefixed modal perfect remains actionable", text: "Jan should fix the release by tomorrow.", step: "fix the release", owner: "Jan", title: "Fix release", bodyMd: "Jan should fix the release by tomorrow.", reply: "The release might have been fixed." },
    { label: "named-owner please cue", text: "Jan, please send the report by tomorrow.", step: "send the report", owner: "Jan", title: "Send report", bodyMd: "Jan, please send the report by tomorrow." },
    { label: "single-word approve with role owner", text: "Finance team should approve by tomorrow.", step: "approve", owner: "Finance team", title: "Approve", bodyMd: "Finance team should approve by tomorrow." },
    { label: "requested ack deliverable", text: "Please have Jan ack the alert by tomorrow.", step: "ack the alert", owner: "Jan", title: "Acknowledge alert", bodyMd: "Please have Jan ack the alert by tomorrow." },
    { label: "CJK Unicode evidence", text: "田中さん needs to 確認する by tomorrow.", step: "確認する", owner: "田中さん", title: "Confirm by tomorrow", bodyMd: "田中さん needs to 確認する by tomorrow." },
    { label: "unrelated task negation does not veto deliverable", text: "Jan should send the report tomorrow, but we should not wait to notify Legal.", step: "send the report", owner: "Jan", title: "Send report", bodyMd: "Jan should send the report tomorrow, but we should not wait to notify Legal." },
    { label: "later actionable reply", text: "Can anyone help?", step: "send the report", owner: "Jan", title: "Send report", bodyMd: "Jan needs to send the report by tomorrow.", reply: "Jan needs to send the report by tomorrow." }
  ])("creates exactly one Action for $label and no duplicate on later scan", async ({ text, step, owner, title, bodyMd, reply }) => {
    const source = candidate({ text, messageTs: new Date("2026-04-28T15:30:00.000Z") });
    setupPendingNudge(source);
    if (reply) prismaMock.communicationMessage.findMany.mockReset().mockResolvedValueOnce([]).mockResolvedValueOnce([source, candidate({ id: "reply-actionable", text: reply })]);
    extractMock.mockResolvedValueOnce({
      output: {
        resolutionState: "open", workDisposition: "action", concreteNextStep: step, ownerEvidence: owner,
        confidence: 0.95, title, bodyMd, negativeCategory: false, couldNot: [],
      },
    });

    const { runSlackProactiveScan } = await import("./slack-context");
    await expect(runSlackProactiveScan({
      workspaceId: "workspace-1", installationId: "install-1", workflowJobId: "job-1",
    })).resolves.toEqual({ agendaJobs: 0, nudges: 0, actions: 1, followups: 0, drafts: 1 });

    expect(createWorkItemMock).toHaveBeenCalledTimes(1);
    expect(createWorkItemMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ title: step, bodyMd: reply ? `${text}\n${reply}` : text, sourceMessageId: "message-1" }));

    setupPendingNudge(source);
    prismaMock.communicationEntityLink.findFirst.mockResolvedValueOnce({ id: "action-link-1", entityId: "action-1" });

    await expect(runSlackProactiveScan({
      workspaceId: "workspace-1", installationId: "install-1", workflowJobId: "job-1",
    })).resolves.toEqual({ agendaJobs: 0, nudges: 0, actions: 0, followups: 0, drafts: 0 });

    expect(createWorkItemMock).toHaveBeenCalledTimes(1);
  });

  it("allows explicit-create exception only when source text deterministically requests it, and fails for negated source text", async () => {
    const validSource = candidate({ text: "Corgtex, create a task to fix the logo.", messageTs: new Date("2026-04-28T15:30:00.000Z") });
    setupPendingNudge(validSource);
    extractMock.mockResolvedValueOnce({
      output: {
        resolutionState: "open",
        workDisposition: "action",
        concreteNextStep: "fix the logo",
        ownerEvidence: "",
        explicitActionRequest: true,
        confidence: 0.95,
        negativeCategory: false,
        couldNot: [],
        title: "Fix the logo",
        bodyMd: "Fix the logo.",
      },
    });

    const { runSlackProactiveScan } = await import("./slack-context");
    await expect(runSlackProactiveScan({
      workspaceId: "workspace-1",
      installationId: "install-1",
      workflowJobId: "job-1",
    })).resolves.toEqual({ agendaJobs: 0, nudges: 0, actions: 1, followups: 0, drafts: 1 });

    expect(createWorkItemMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      title: "fix the logo",
    }));

    for (const pronoun of ["this", "that", "it"]) {
      const naturalSource = candidate({ id: `msg-natural-${pronoun}`, text: "Can anyone help?", messageTs: new Date("2026-04-28T15:30:00.000Z") });
      setupPendingNudge(naturalSource, [naturalSource, candidate({ id: `reply-explicit-${pronoun}`, text: `Corgtex, turn ${pronoun} into an action item: update the guide?` })]);
      extractMock.mockResolvedValueOnce({ output: {
        resolutionState: "open", workDisposition: "action", concreteNextStep: "update the guide", ownerEvidence: "",
        explicitActionRequest: true, confidence: 0.95, negativeCategory: false, couldNot: [], title: "Update guide",
      } });
      await expect(runSlackProactiveScan({
        workspaceId: "workspace-1", installationId: "install-1", workflowJobId: "job-1",
      })).resolves.toEqual({ agendaJobs: 0, nudges: 0, actions: 1, followups: 0, drafts: 1 });
      expect(createWorkItemMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ title: "update the guide" }));
    }

    const negatedSource = candidate({ id: "msg-negated", text: "Don't turn that into an action item for this issue.", messageTs: new Date("2026-04-28T15:30:00.000Z") });
    setupPendingNudge(negatedSource);
    extractMock.mockResolvedValueOnce({
      output: {
        resolutionState: "open",
        workDisposition: "action",
        concreteNextStep: "investigate issue",
        ownerEvidence: "",
        explicitActionRequest: true,
        confidence: 0.95,
        negativeCategory: false,
        couldNot: [],
        title: "Investigate issue",
      },
    });

    await expect(runSlackProactiveScan({
      workspaceId: "workspace-1",
      installationId: "install-1",
      workflowJobId: "job-1",
    })).resolves.toEqual({ agendaJobs: 0, nudges: 0, actions: 0, followups: 0, drafts: 0 });

    expect(prismaMock.communicationEntityLink.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: "proactive_unanswered_resolved", entityId: "msg-negated" }),
    }));
  });

  it("preserves retryability on model or network exception without recording a terminal marker, and succeeds on later retry", async () => {
    const source = candidate({ text: "Jan needs to send the report by tomorrow.", messageTs: new Date("2026-04-28T15:30:00.000Z") });
    prismaMock.communicationMessage.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([source]);
    prismaMock.communicationEntityLink.findMany
      .mockResolvedValueOnce([nudgeLink({ message: source })]);
    extractMock.mockRejectedValueOnce(new Error("Transient model gateway timeout"));

    const { runSlackProactiveScan } = await import("./slack-context");
    await expect(runSlackProactiveScan({
      workspaceId: "workspace-1",
      installationId: "install-1",
      workflowJobId: "job-1",
    })).rejects.toThrow("Transient model gateway timeout");
    expect(prismaMock.communicationEntityLink.create).not.toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: "proactive_unanswered_resolved" }),
    }));
    setupPendingNudge(source);
    extractMock.mockResolvedValueOnce({
      output: {
        resolutionState: "open",
        workDisposition: "action",
        concreteNextStep: "send the report",
        ownerEvidence: "Jan",
        confidence: 0.95,
        negativeCategory: false,
        couldNot: [],
        title: "Send report",
        bodyMd: "Jan needs to send the report by tomorrow.",
      },
    });

    await expect(runSlackProactiveScan({
      workspaceId: "workspace-1",
      installationId: "install-1",
      workflowJobId: "job-1",
    })).resolves.toEqual({ agendaJobs: 0, nudges: 0, actions: 1, followups: 0, drafts: 1 });
  });


  it("does not redundantly process or mark an installed-bot mention if a terminal marker already exists", async () => {
    const source = candidate({ id: "msg-bot-mention", text: "Hey <@bot-1> what's up?", messageTs: new Date("2026-04-28T15:30:00.000Z") });
    setupPendingNudge(source);

    prismaMock.communicationEntityLink.findFirst
      .mockResolvedValueOnce(null) // action lookup
      .mockResolvedValueOnce({ id: "terminal-marker" }); // resolved lookup

    prismaMock.communicationEntityLink.create.mockClear();
    extractMock.mockClear();

    const { runSlackProactiveScan } = await import("./slack-context");
    await expect(runSlackProactiveScan({
      workspaceId: "workspace-1",
      installationId: "install-1",
      workflowJobId: "job-1",
    })).resolves.toEqual({ agendaJobs: 0, nudges: 0, actions: 0, followups: 0, drafts: 0 });

    expect(prismaMock.communicationExternalUser.findMany).not.toHaveBeenCalled();
    expect(prismaMock.communicationEntityLink.create).not.toHaveBeenCalled();
  });
});
