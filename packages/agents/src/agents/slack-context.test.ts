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
      upsert: vi.fn(),
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

function actionableExtraction(overrides: Record<string, unknown> = {}) {
  return {
    intent: "create_action",
    resolutionState: "open",
    workDisposition: "action",
    concreteNextStep: "send the signed vendor agreement",
    ownerEvidence: "Jan",
    timingEvidence: "by Friday",
    explicitActionRequest: false,
    negativeCategory: false,
    confidence: 0.97,
    reason: "Jan owns a concrete future deliverable.",
    title: "Send signed vendor agreement",
    bodyMd: "Jan will send the signed vendor agreement by Friday.",
    couldNot: [],
    ...overrides,
  };
}

function preparePendingEvaluation(source: ReturnType<typeof candidate>, output: Record<string, unknown>) {
  prismaMock.communicationMessage.findMany
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([source]);
  prismaMock.communicationEntityLink.findMany
    .mockResolvedValueOnce([nudgeLink({ message: source })])
    .mockResolvedValueOnce([]);
  extractMock.mockResolvedValueOnce({ output });
}

describe("Slack context jobs", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.workspaceAgentConfig.findUnique.mockResolvedValue({
      configJson: { proactiveActionPublicationEnabled: true },
    });
    prismaMock.communicationInstallation.findFirst.mockResolvedValue({
      id: "install-1",
      settings: {},
      botUserId: "B1",
    });
    prismaMock.communicationInstallation.updateMany.mockResolvedValue({ count: 1 });
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
    prismaMock.communicationEntityLink.upsert.mockResolvedValue({ id: "link-1" });
    prismaMock.action.findMany.mockResolvedValue([]);
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

  it.each([
    ["plain mention", "<@B1> can you confirm the routing works?"],
    ["labeled mention", "<@B1|Corgtex> can you confirm the routing works?"],
  ])("excludes installed-bot %s before proactive nudging", async (_label, text) => {
    prismaMock.communicationMessage.findMany.mockResolvedValueOnce([
      candidate({ text, messageTs: new Date("2026-04-28T15:30:00.000Z") }),
    ]);

    const { runSlackProactiveScan } = await import("./slack-context");
    await expect(runSlackProactiveScan({
      workspaceId: "workspace-1",
      installationId: "install-1",
      workflowJobId: "job-1",
    })).resolves.toEqual({ agendaJobs: 0, nudges: 0, actions: 0, followups: 0, drafts: 0 });

    expect(sendSlackMessageMock).not.toHaveBeenCalled();
    expect(extractMock).not.toHaveBeenCalled();
    expect(createWorkItemMock).not.toHaveBeenCalled();
  });

  it("does not treat a different user's Slack mention as bot-directed", async () => {
    prismaMock.communicationMessage.findMany.mockResolvedValueOnce([
      candidate({
        text: "<@U2> can you confirm who owns the launch checklist?",
        messageTs: new Date("2026-04-28T15:30:00.000Z"),
      }),
    ]);

    const { runSlackProactiveScan } = await import("./slack-context");
    await runSlackProactiveScan({
      workspaceId: "workspace-1",
      installationId: "install-1",
      workflowJobId: "job-1",
    });

    expect(sendSlackMessageMock).toHaveBeenCalledTimes(1);
    expect(prismaMock.communicationEntityLink.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: "proactive_unanswered_nudge" }),
    }));
  });

  it("does not guess that any mention is Corgtex when botUserId is missing", async () => {
    prismaMock.communicationInstallation.findFirst.mockResolvedValueOnce({
      id: "install-1",
      settings: {},
      botUserId: null,
    });
    prismaMock.communicationMessage.findMany.mockResolvedValueOnce([
      candidate({
        text: "<@U2> can you confirm who owns the launch checklist?",
        messageTs: new Date("2026-04-28T15:30:00.000Z"),
      }),
    ]);

    const { runSlackProactiveScan } = await import("./slack-context");
    await runSlackProactiveScan({
      workspaceId: "workspace-1",
      installationId: "install-1",
      workflowJobId: "job-1",
    });

    expect(sendSlackMessageMock).toHaveBeenCalledTimes(1);
  });

  it("suppresses a proactive nudge when a human reply is already stored", async () => {
    prismaMock.communicationMessage.findMany.mockResolvedValueOnce([
      candidate({
        text: "Does anyone know who owns the launch checklist?",
        messageTs: new Date("2026-04-28T15:30:00.000Z"),
      }),
    ]);
    prismaMock.communicationMessage.count.mockResolvedValueOnce(1);

    const { runSlackProactiveScan } = await import("./slack-context");
    await runSlackProactiveScan({
      workspaceId: "workspace-1",
      installationId: "install-1",
      workflowJobId: "job-1",
    });

    expect(sendSlackMessageMock).not.toHaveBeenCalled();
    expect(prismaMock.communicationEntityLink.create).not.toHaveBeenCalled();
  });

  it("schedules agenda prep and nudges unanswered public Slack questions once", async () => {
    prismaMock.communicationInstallation.findFirst.mockResolvedValueOnce({
      id: "install-1",
      settings: { defaultAgendaChannelId: "C-agenda" },
      botUserId: "B1",
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
      text: "Bringing this back into view.",
    }, expect.any(Array));
    expect(sendSlackMessageMock.mock.calls[0][2][0].text.text).toBe("Bringing this back into view in case it still needs attention.");
    expect(sendSlackMessageMock.mock.calls[0][2][0].text.text).not.toMatch(/action|24 hours/i);
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
    expect(createWorkItemMock).not.toHaveBeenCalled();
  });

  it("respects proactive confidence thresholds before creating published actions", async () => {
    const source = candidate({
      text: "Jan should follow up by tomorrow.",
      messageTs: new Date("2026-04-28T15:30:00.000Z"),
    });
    prismaMock.communicationMessage.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([source]);
    prismaMock.communicationEntityLink.findMany
      .mockResolvedValueOnce([nudgeLink({ message: source })])
      .mockResolvedValueOnce([]);
    extractMock.mockResolvedValueOnce({
      output: actionableExtraction({
        confidence: 0.89,
        title: "Follow up",
        bodyMd: "Jan should follow up by tomorrow.",
        concreteNextStep: "follow up",
      }),
    });

    const { runSlackProactiveScan } = await import("./slack-context");
    await expect(runSlackProactiveScan({
      workspaceId: "workspace-1",
      installationId: "install-1",
      workflowJobId: "job-1",
    })).resolves.toEqual({ agendaJobs: 0, nudges: 0, actions: 0, followups: 0, drafts: 0 });

    expect(createWorkItemMock).not.toHaveBeenCalled();
    expect(prismaMock.communicationEntityLink.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ action: "proactive_unanswered_non_action" }),
    }));
  });

  it("terminalizes a legacy bot-directed nudge before semantic review", async () => {
    const source = candidate({
      text: "<@B1|Corgtex> please check whether routing works?",
      messageTs: new Date("2026-04-28T15:30:00.000Z"),
    });
    prismaMock.communicationMessage.findMany.mockResolvedValueOnce([]);
    prismaMock.communicationEntityLink.findMany
      .mockResolvedValueOnce([nudgeLink({ message: source })])
      .mockResolvedValueOnce([]);

    const { runSlackProactiveScan } = await import("./slack-context");
    await runSlackProactiveScan({
      workspaceId: "workspace-1",
      installationId: "install-1",
      workflowJobId: "job-1",
    });

    expect(extractMock).not.toHaveBeenCalled();
    expect(createWorkItemMock).not.toHaveBeenCalled();
    expect(prismaMock.communicationEntityLink.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        action: "proactive_unanswered_non_action",
        messageId: "message-1",
      }),
    }));
  });

  it.each([
    ["routing test", "Routing check: Jan, please send the signed vendor agreement by Friday."],
    ["FYI", "Quick FYI: Jan will send the signed vendor agreement by Friday."],
    ["acknowledgement", "Thanks."],
    ["completed request", "Jan finished the signed vendor agreement."],
    ["standalone completion", "Done. Jan handled the vendor agreement."],
    ["passive completion", "The vendor agreement was sent."],
    ["finished completion", "I finished it, thanks."],
    ["did-it completion", "I did it; no follow-up is needed."],
  ])("terminalizes %s content even when the model proposes a high-confidence Action", async (_label, text) => {
    const source = candidate({ text, messageTs: new Date("2026-04-28T15:30:00.000Z") });
    preparePendingEvaluation(source, actionableExtraction());

    const { runSlackProactiveScan } = await import("./slack-context");
    await runSlackProactiveScan({
      workspaceId: "workspace-1",
      installationId: "install-1",
      workflowJobId: "job-1",
    });

    expect(createWorkItemMock).not.toHaveBeenCalled();
    expect(prismaMock.communicationEntityLink.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ action: "proactive_unanswered_non_action" }),
    }));
  });

  it("terminalizes awareness-only open questions after the one neutral nudge", async () => {
    const source = candidate({
      text: "Does anyone know the current launch status?",
      messageTs: new Date("2026-04-28T15:30:00.000Z"),
    });
    preparePendingEvaluation(source, {
      intent: "ignore",
      resolutionState: "open",
      workDisposition: "awareness",
      concreteNextStep: "",
      ownerEvidence: "",
      timingEvidence: "",
      explicitActionRequest: false,
      negativeCategory: true,
      confidence: 0.99,
      reason: "The thread asks for awareness, not future work.",
      couldNot: [],
    });

    const { runSlackProactiveScan } = await import("./slack-context");
    await runSlackProactiveScan({
      workspaceId: "workspace-1",
      installationId: "install-1",
      workflowJobId: "job-1",
    });

    expect(createWorkItemMock).not.toHaveBeenCalled();
    expect(prismaMock.communicationEntityLink.upsert).toHaveBeenCalledTimes(1);
  });

  it("vetoes Action publication when a later human reply says the request is completed", async () => {
    const source = candidate({
      text: "Jan, please send the signed vendor agreement by Friday.",
      messageTs: new Date("2026-04-28T15:30:00.000Z"),
    });
    const completedReply = candidate({
      id: "message-2",
      externalMessageId: "1714323600.000100",
      threadExternalId: source.externalMessageId,
      text: "Already sent, thanks.",
      messageTs: new Date("2026-04-28T22:00:00.000Z"),
    });
    prismaMock.communicationMessage.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([source, completedReply]);
    prismaMock.communicationEntityLink.findMany
      .mockResolvedValueOnce([nudgeLink({ message: source })])
      .mockResolvedValueOnce([]);
    extractMock.mockResolvedValueOnce({ output: actionableExtraction() });

    const { runSlackProactiveScan } = await import("./slack-context");
    await runSlackProactiveScan({
      workspaceId: "workspace-1",
      installationId: "install-1",
      workflowJobId: "job-1",
    });

    expect(createWorkItemMock).not.toHaveBeenCalled();
    expect(prismaMock.communicationEntityLink.upsert).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["owner evidence", { ownerEvidence: "" }, undefined],
    ["non-owner token", { ownerEvidence: "by" }, undefined],
    ["concrete deliverable", { concreteNextStep: "" }, undefined],
    ["grounded deliverable evidence", { concreteNextStep: "prepare the budget" }, undefined],
    ["timing-only deliverable evidence", { ownerEvidence: "by", concreteNextStep: "by Friday" }, "Please send the agreement by Friday."],
  ])("fails closed when high-confidence Action output lacks %s", async (_label, overrides, sourceText) => {
    const source = candidate({
      text: sourceText ?? "Jan, please send the signed vendor agreement by Friday.",
      messageTs: new Date("2026-04-28T15:30:00.000Z"),
    });
    preparePendingEvaluation(source, actionableExtraction(overrides));

    const { runSlackProactiveScan } = await import("./slack-context");
    await runSlackProactiveScan({
      workspaceId: "workspace-1",
      installationId: "install-1",
      workflowJobId: "job-1",
    });

    expect(createWorkItemMock).not.toHaveBeenCalled();
    expect(prismaMock.communicationEntityLink.upsert).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["missing semantic fields", { intent: "create_action", confidence: 0.99, title: "Send agreement" }],
    ["invalid enum values", actionableExtraction({ resolutionState: "pending", workDisposition: "todo" })],
    ["negative model category", actionableExtraction({ negativeCategory: true })],
    ["contradictory intent", actionableExtraction({ intent: "ignore" })],
    ["string confidence", actionableExtraction({ confidence: "0.99" })],
    ["non-array couldNot", actionableExtraction({ couldNot: "none" })],
  ])("terminalizes %s instead of retrying or creating an Action", async (_label, output) => {
    const source = candidate({
      text: "Jan, please send the signed vendor agreement by Friday.",
      messageTs: new Date("2026-04-28T15:30:00.000Z"),
    });
    preparePendingEvaluation(source, output);

    const { runSlackProactiveScan } = await import("./slack-context");
    await runSlackProactiveScan({
      workspaceId: "workspace-1",
      installationId: "install-1",
      workflowJobId: "job-1",
    });

    expect(createWorkItemMock).not.toHaveBeenCalled();
    expect(prismaMock.communicationEntityLink.upsert).toHaveBeenCalledTimes(1);
  });

  it("keeps model failures retryable without recording a semantic terminal marker", async () => {
    const source = candidate({
      text: "Jan, please send the signed vendor agreement by Friday.",
      messageTs: new Date("2026-04-28T15:30:00.000Z"),
    });
    prismaMock.communicationMessage.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([source]);
    prismaMock.communicationEntityLink.findMany.mockResolvedValueOnce([nudgeLink({ message: source })]);
    extractMock.mockRejectedValueOnce(new Error("temporary model outage"));

    const { runSlackProactiveScan } = await import("./slack-context");
    await expect(runSlackProactiveScan({
      workspaceId: "workspace-1",
      installationId: "install-1",
      workflowJobId: "job-1",
    })).rejects.toThrow("temporary model outage");

    expect(createWorkItemMock).not.toHaveBeenCalled();
    expect(prismaMock.communicationEntityLink.upsert).not.toHaveBeenCalled();
  });

  it("keeps automatic publication default-off and terminalizes otherwise valid work", async () => {
    prismaMock.workspaceAgentConfig.findUnique.mockResolvedValueOnce(null);
    const source = candidate({
      text: "Jan, please send the signed vendor agreement by Friday.",
      messageTs: new Date("2026-04-28T15:30:00.000Z"),
    });
    preparePendingEvaluation(source, actionableExtraction());

    const { runSlackProactiveScan } = await import("./slack-context");
    await runSlackProactiveScan({
      workspaceId: "workspace-1",
      installationId: "install-1",
      workflowJobId: "job-1",
    });

    expect(createWorkItemMock).not.toHaveBeenCalled();
    expect(prismaMock.communicationEntityLink.upsert).toHaveBeenCalledTimes(1);
  });

  it("fails closed for automatic publication when the installation bot identity is missing", async () => {
    prismaMock.communicationInstallation.findFirst.mockResolvedValueOnce({
      id: "install-1",
      settings: {},
      botUserId: null,
    });
    const source = candidate({
      text: "Jan, please send the signed vendor agreement by Friday.",
      messageTs: new Date("2026-04-28T15:30:00.000Z"),
    });
    preparePendingEvaluation(source, actionableExtraction());

    const { runSlackProactiveScan } = await import("./slack-context");
    await runSlackProactiveScan({
      workspaceId: "workspace-1",
      installationId: "install-1",
      workflowJobId: "job-1",
    });

    expect(createWorkItemMock).not.toHaveBeenCalled();
    expect(prismaMock.communicationEntityLink.upsert).toHaveBeenCalledTimes(1);
  });

  it("creates one source-claimed published Action for owner-backed future work", async () => {
    const source = candidate({
      text: "Jan, please ensure the signed vendor agreement is completed by Friday.",
      messageTs: new Date("2026-04-28T15:30:00.000Z"),
    });
    prismaMock.communicationMessage.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([source]);
    prismaMock.communicationEntityLink.findMany
      .mockResolvedValueOnce([nudgeLink({ message: source })])
      .mockResolvedValueOnce([]);
    extractMock.mockResolvedValueOnce({
      output: actionableExtraction({ concreteNextStep: "ensure the signed vendor agreement is completed" }),
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
      title: "Ensure the signed vendor agreement is completed",
      bodyMd: "Jan, please ensure the signed vendor agreement is completed by Friday.",
      sourceMessageId: "message-1",
      open: true,
      claimKey: "slack-proactive-action:install-1:message-1",
    }));
    expect(createWorkItemMock).toHaveBeenCalledTimes(1);
    expect(sendSlackMessageMock).toHaveBeenCalledWith("install-1", {
      channel: "C1",
      threadTs: "1714320000.000100",
      text: "Created Corgtex action: Ensure the signed vendor agreement is completed",
    }, expect.any(Array));
    expect(sendSlackMessageMock.mock.calls[0][2][0].text.text).toContain("concrete future deliverable");
    expect(prismaMock.communicationEntityLink.create).not.toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: "proactive_unanswered_action_created" }),
    }));
  });

  it("allows the narrow source-grounded explicit-create exception without an owner", async () => {
    const source = candidate({
      text: "Please create a Corgtex Action to test the vendor agreement flow by Friday.",
      messageTs: new Date("2026-04-28T15:30:00.000Z"),
    });
    preparePendingEvaluation(source, actionableExtraction({
      ownerEvidence: "",
      concreteNextStep: "test the vendor agreement flow",
      explicitActionRequest: true,
    }));

    const { runSlackProactiveScan } = await import("./slack-context");
    await expect(runSlackProactiveScan({
      workspaceId: "workspace-1",
      installationId: "install-1",
      workflowJobId: "job-1",
    })).resolves.toEqual({ agendaJobs: 0, nudges: 0, actions: 1, followups: 0, drafts: 1 });

    expect(createWorkItemMock).toHaveBeenCalledTimes(1);
    expect(createWorkItemMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      claimKey: "slack-proactive-action:install-1:message-1",
    }));
  });

  it.each(["do not", "never", "must not"])("keeps the explicit-create exception negation-safe for '%s'", async (negation) => {
    const source = candidate({
      text: `Please ${negation} create a Corgtex Action; this is only a routing check.`,
      messageTs: new Date("2026-04-28T15:30:00.000Z"),
    });
    preparePendingEvaluation(source, actionableExtraction({
      ownerEvidence: "",
      concreteNextStep: "routing check",
      explicitActionRequest: true,
    }));

    const { runSlackProactiveScan } = await import("./slack-context");
    await runSlackProactiveScan({
      workspaceId: "workspace-1",
      installationId: "install-1",
      workflowJobId: "job-1",
    });

    expect(createWorkItemMock).not.toHaveBeenCalled();
    expect(prismaMock.communicationEntityLink.upsert).toHaveBeenCalledTimes(1);
  });

  it("does not reevaluate a source after a terminal non-action outcome", async () => {
    const source = candidate({
      text: "Does anyone know the current launch status?",
      messageTs: new Date("2026-04-28T15:30:00.000Z"),
    });
    prismaMock.communicationMessage.findMany.mockResolvedValueOnce([]);
    prismaMock.communicationEntityLink.findMany
      .mockResolvedValueOnce([nudgeLink({ message: source })])
      .mockResolvedValueOnce([]);
    prismaMock.communicationEntityLink.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "terminal-1" });

    const { runSlackProactiveScan } = await import("./slack-context");
    await runSlackProactiveScan({
      workspaceId: "workspace-1",
      installationId: "install-1",
      workflowJobId: "job-1",
    });

    expect(extractMock).not.toHaveBeenCalled();
    expect(createWorkItemMock).not.toHaveBeenCalled();
    expect(prismaMock.communicationEntityLink.upsert).not.toHaveBeenCalled();
  });

  it("does not create actions when thread review marks the item resolved or unsafe", async () => {
    const source = candidate({
      text: "Please confirm availability for the June 23 call.",
      messageTs: new Date("2026-04-28T15:30:00.000Z"),
    });
    prismaMock.communicationMessage.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([source]);
    prismaMock.communicationEntityLink.findMany
      .mockResolvedValueOnce([nudgeLink({ message: source })])
      .mockResolvedValueOnce([]);
    extractMock.mockResolvedValueOnce({
      output: {
        intent: "ignore",
        confidence: 0.99,
        couldNot: ["unsafe request"],
      },
    });

    const { runSlackProactiveScan } = await import("./slack-context");
    await expect(runSlackProactiveScan({
      workspaceId: "workspace-1",
      installationId: "install-1",
      workflowJobId: "job-1",
    })).resolves.toEqual({ agendaJobs: 0, nudges: 0, actions: 0, followups: 0, drafts: 0 });

    expect(createWorkItemMock).not.toHaveBeenCalled();
    expect(prismaMock.communicationEntityLink.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        action: "proactive_unanswered_non_action",
        entityType: "CommunicationMessage",
        entityId: "message-1",
        claimKey: "slack-proactive-non-action:install-1:message-1",
      }),
    }));
    expect(sendSlackMessageMock).not.toHaveBeenCalled();
  });

  it("posts waiting replies as updates to the existing linked action", async () => {
    const source = candidate({
      text: "Please confirm availability for the June 23 call.",
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
        intent: "wait_existing_action",
        confidence: 0.96,
        updateMd: "Daniel said no more action is needed yet; the team is waiting on the owner to confirm a June 23 time slot.",
        followupDelayMultiplier: 2,
      },
    });

    const { runSlackProactiveScan } = await import("./slack-context");
    await expect(runSlackProactiveScan({
      workspaceId: "workspace-1",
      installationId: "install-1",
      workflowJobId: "job-1",
    })).resolves.toEqual({ agendaJobs: 0, nudges: 0, actions: 0, followups: 0, drafts: 0 });

    expect(createWorkItemMock).not.toHaveBeenCalled();
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
    expect(prismaMock.communicationEntityLink.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        OR: expect.arrayContaining([
          expect.objectContaining({
            action: "create_action",
            claimKey: { startsWith: "slack-proactive-action:install-1:" },
          }),
        ]),
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
});
