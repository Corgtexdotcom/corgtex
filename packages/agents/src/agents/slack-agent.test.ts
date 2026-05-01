import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  prismaMock,
  createWorkItemMock,
  deleteActionMock,
  deleteProposalMock,
  deleteSourceMock,
  deleteTensionMock,
  deliverSlackAgentResponseMock,
  fetchSlackThreadMessagesMock,
  listMembersMock,
  extractMock,
  chatMock,
  answerKnowledgeQuestionMock,
  searchIndexedKnowledgeMock,
} = vi.hoisted(() => ({
  prismaMock: {
    agentRun: {
      findFirst: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    agentStep: {
      createMany: vi.fn(),
    },
    agentToolCall: {
      createMany: vi.fn(),
    },
    workspaceAgentConfig: {
      findUnique: vi.fn(),
    },
    modelUsageBudget: {
      findUnique: vi.fn(),
    },
    agentIdentity: {
      findUnique: vi.fn(),
    },
    event: {
      create: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
    },
    member: {
      findUnique: vi.fn(),
    },
    communicationExternalUser: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
    communicationMessage: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
    communicationContextSummary: {
      findMany: vi.fn(),
    },
    communicationEntityLink: {
      findMany: vi.fn(),
      create: vi.fn(),
    },
    action: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
    },
    tension: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
    },
    proposal: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
    },
    brainSource: {
      findFirst: vi.fn(),
    },
    $transaction: vi.fn(),
  },
  createWorkItemMock: vi.fn(),
  deleteActionMock: vi.fn(),
  deleteProposalMock: vi.fn(),
  deleteSourceMock: vi.fn(),
  deleteTensionMock: vi.fn(),
  deliverSlackAgentResponseMock: vi.fn(),
  fetchSlackThreadMessagesMock: vi.fn(),
  listMembersMock: vi.fn(),
  extractMock: vi.fn(),
  chatMock: vi.fn(),
  answerKnowledgeQuestionMock: vi.fn(),
  searchIndexedKnowledgeMock: vi.fn(),
}));

vi.mock("@corgtex/shared", () => ({
  prisma: prismaMock,
  env: {
    AGENT_KILL_SWITCH: false,
    WORKSPACE_AGENT_MAX_CONCURRENCY: 4,
  },
  toInputJson: (value: unknown) => JSON.parse(JSON.stringify(value ?? null)),
}));

vi.mock("@corgtex/domain", () => ({
  AGENT_REGISTRY: {
    "slack-agent": {
      defaultModelTier: "standard",
    },
  },
  checkBudget: vi.fn().mockResolvedValue({ allowed: true }),
  isAgentEnabled: vi.fn().mockResolvedValue(true),
  getAgentModelOverride: vi.fn().mockResolvedValue(undefined),
  resolveAgentIdentityLimits: vi.fn().mockResolvedValue(null),
  resolveAgentBehaviorContext: vi.fn().mockResolvedValue(null),
  createConstitutionVersion: vi.fn(),
  createWorkItemFromCommunicationSource: createWorkItemMock,
  deleteAction: deleteActionMock,
  deleteProposal: deleteProposalMock,
  deleteSource: deleteSourceMock,
  deleteTension: deleteTensionMock,
  deliverSlackAgentResponse: deliverSlackAgentResponseMock,
  fetchSlackThreadMessages: fetchSlackThreadMessagesMock,
  listMembers: listMembersMock,
}));

vi.mock("@corgtex/models", () => ({
  resolveModel: vi.fn().mockReturnValue("fake-model"),
  defaultModelGateway: {
    extract: extractMock,
    chat: chatMock,
  },
}));

vi.mock("@corgtex/knowledge", () => ({
  searchIndexedKnowledge: searchIndexedKnowledgeMock,
  answerKnowledgeQuestion: answerKnowledgeQuestionMock,
}));

function basePayload() {
  return {
    source: "slash_command" as const,
    installationId: "install-1",
    workspaceId: "workspace-1",
    actorUserId: "user-1",
    externalUserId: "U1",
    prompt: "Jan should follow up with Milan tomorrow",
    channelId: "C1",
    responseUrlEnc: "enc:https://hooks.slack.test/response",
    workflowJobId: "job-1",
  };
}

describe("runSlackAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.$transaction.mockImplementation(async (fn: any) => fn(prismaMock));
    prismaMock.agentRun.findFirst.mockResolvedValue(null);
    prismaMock.agentRun.count.mockResolvedValue(0);
    prismaMock.agentRun.create.mockResolvedValue({ id: "run-1" });
    prismaMock.agentRun.update.mockImplementation(async ({ where, data }: any) => ({
      id: where.id,
      ...data,
    }));
    prismaMock.agentStep.createMany.mockResolvedValue({ count: 0 });
    prismaMock.agentToolCall.createMany.mockResolvedValue({ count: 0 });
    prismaMock.workspaceAgentConfig.findUnique.mockResolvedValue(null);
    prismaMock.modelUsageBudget.findUnique.mockResolvedValue(null);
    prismaMock.agentIdentity.findUnique.mockResolvedValue(null);
    prismaMock.event.create.mockResolvedValue({ id: "event-1" });
    prismaMock.user.findUnique.mockResolvedValue({
      id: "user-1",
      email: "user@example.test",
      displayName: "User",
      globalRole: "USER",
    });
    prismaMock.member.findUnique.mockResolvedValue({
      id: "actor-member-1",
      isActive: true,
    });
    prismaMock.communicationExternalUser.findUnique.mockResolvedValue({
      rawProfile: { tz: "America/Los_Angeles" },
    });
    prismaMock.communicationExternalUser.findMany.mockResolvedValue([]);
    prismaMock.communicationMessage.findUnique.mockResolvedValue(null);
    prismaMock.communicationMessage.findMany.mockResolvedValue([]);
    prismaMock.communicationContextSummary.findMany.mockResolvedValue([]);
    prismaMock.communicationEntityLink.findMany.mockResolvedValue([]);
    prismaMock.communicationEntityLink.create.mockResolvedValue({ id: "undo-link-1" });
    prismaMock.action.findMany.mockResolvedValue([]);
    prismaMock.action.findFirst.mockResolvedValue(null);
    prismaMock.tension.findMany.mockResolvedValue([]);
    prismaMock.tension.findFirst.mockResolvedValue(null);
    prismaMock.proposal.findMany.mockResolvedValue([]);
    prismaMock.proposal.findFirst.mockResolvedValue(null);
    prismaMock.brainSource.findFirst.mockResolvedValue(null);
    listMembersMock.mockResolvedValue([
      {
        id: "member-1",
        userId: "assignee-user-1",
        user: {
          email: "milan@example.test",
          displayName: "Milan",
        },
      },
    ]);
    fetchSlackThreadMessagesMock.mockResolvedValue([]);
    deliverSlackAgentResponseMock.mockResolvedValue(undefined);
    createWorkItemMock.mockResolvedValue({
      entityType: "Action",
      entityId: "action-1",
      webUrl: "https://app.example.test/workspaces/workspace-1/actions",
      opened: true,
    });
    deleteActionMock.mockResolvedValue({ id: "action-1" });
    deleteProposalMock.mockResolvedValue({ id: "proposal-1" });
    deleteSourceMock.mockResolvedValue({ id: "source-1" });
    deleteTensionMock.mockResolvedValue({ id: "tension-1" });
    answerKnowledgeQuestionMock.mockResolvedValue({
      answer: "The workspace handbook says to use advice routing for proposal risks.",
      citations: [],
    });
    searchIndexedKnowledgeMock.mockResolvedValue([]);
    chatMock.mockResolvedValue({
      content: "The workspace handbook says to use advice routing for proposal risks.",
    });
  });

  it("creates and opens high-confidence actions with assignee and due date", async () => {
    extractMock.mockResolvedValueOnce({
      output: {
        intent: "create_action",
        confidence: 0.91,
        title: "Follow up with Milan",
        bodyMd: "Jan should follow up with Milan tomorrow.",
        assigneeHint: "Milan",
        dueDateISO: "2026-04-28T16:00:00.000Z",
        publish: true,
      },
    });

    const { runSlackAgent } = await import("./slack-agent");
    await runSlackAgent(basePayload());

    expect(createWorkItemMock).toHaveBeenCalledWith(expect.objectContaining({ kind: "user" }), expect.objectContaining({
      kind: "ACTION",
      title: "Follow up with Milan",
      assigneeMemberId: "member-1",
      dueAt: new Date("2026-04-28T16:00:00.000Z"),
      open: true,
    }));
    expect(deliverSlackAgentResponseMock).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({
      text: expect.stringContaining("Done:"),
    }));
  });

  it("creates and submits high-confidence proposals", async () => {
    extractMock.mockResolvedValueOnce({
      output: {
        intent: "create_proposal",
        confidence: 0.86,
        title: "Clarify onboarding ownership",
        bodyMd: "Proposal body.",
      },
    });
    createWorkItemMock.mockResolvedValueOnce({
      entityType: "Proposal",
      entityId: "proposal-1",
      webUrl: "https://app.example.test/workspaces/workspace-1/proposals/proposal-1",
      opened: true,
    });

    const { runSlackAgent } = await import("./slack-agent");
    await runSlackAgent({ ...basePayload(), prompt: "Create a proposal about onboarding ownership" });

    expect(createWorkItemMock).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({
      kind: "PROPOSAL",
      open: true,
    }));
  });

  it("keeps medium-confidence work as a private draft", async () => {
    extractMock.mockResolvedValueOnce({
      output: {
        intent: "create_tension",
        confidence: 0.71,
        title: "Onboarding ownership is unclear",
        bodyMd: "The handoff owner is unclear.",
      },
    });
    createWorkItemMock.mockResolvedValueOnce({
      entityType: "Tension",
      entityId: "tension-1",
      webUrl: "https://app.example.test/workspaces/workspace-1/tensions/tension-1",
      opened: false,
    });

    const { runSlackAgent } = await import("./slack-agent");
    await runSlackAgent({ ...basePayload(), prompt: "Turn this into a tension" });

    expect(createWorkItemMock).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({
      kind: "TENSION",
      open: false,
    }));
    expect(deliverSlackAgentResponseMock.mock.calls[0][1].text).toContain("private draft");
  });

  it("asks for clarification when confidence is low", async () => {
    extractMock.mockResolvedValueOnce({
      output: {
        intent: "create_action",
        confidence: 0.42,
        title: "Unclear request",
        bodyMd: "Maybe do something.",
      },
    });

    const { runSlackAgent } = await import("./slack-agent");
    await runSlackAgent({ ...basePayload(), prompt: "maybe this thing" });

    expect(createWorkItemMock).not.toHaveBeenCalled();
    expect(deliverSlackAgentResponseMock.mock.calls[0][1].text).toContain("not confident");
  });

  it("answers capabilities questions without calling the model", async () => {
    const { runSlackAgent } = await import("./slack-agent");
    await runSlackAgent({ ...basePayload(), prompt: "what can you do from Slack now?" });

    expect(extractMock).not.toHaveBeenCalled();
    expect(answerKnowledgeQuestionMock).not.toHaveBeenCalled();
    expect(createWorkItemMock).not.toHaveBeenCalled();
    expect(deliverSlackAgentResponseMock.mock.calls[0][1].text).toContain("actions, tensions, proposals");
    expect(deliverSlackAgentResponseMock.mock.calls[0][1].text).toContain("Try `/corgtex Jan should follow up with Milan tomorrow`");
  });

  it("does not treat creation prompts containing help as capabilities questions", async () => {
    extractMock.mockResolvedValueOnce({
      output: {
        intent: "create_action",
        confidence: 0.89,
        title: "Help Jan follow up",
        bodyMd: "Help Jan follow up tomorrow.",
        assigneeHint: "Milan",
        dueDateISO: "2026-04-28T16:00:00.000Z",
      },
    });

    const { runSlackAgent } = await import("./slack-agent");
    await runSlackAgent({ ...basePayload(), prompt: "help Jan follow up tomorrow" });

    expect(extractMock).toHaveBeenCalled();
    expect(createWorkItemMock).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({
      kind: "ACTION",
      title: "Help Jan follow up",
      open: true,
    }));
    expect(deliverSlackAgentResponseMock.mock.calls[0][1].text).not.toContain("I can turn plain Slack text into Corgtex work");
  });

  it("declines unsupported destructive requests without creating records", async () => {
    extractMock.mockResolvedValueOnce({
      output: {
        intent: "create_action",
        confidence: 0.95,
        title: "Delete stale actions",
        bodyMd: "Delete old actions.",
      },
    });

    const { runSlackAgent } = await import("./slack-agent");
    await runSlackAgent({ ...basePayload(), prompt: "delete all old actions" });

    expect(createWorkItemMock).not.toHaveBeenCalled();
    expect(deleteActionMock).not.toHaveBeenCalled();
    expect(deleteProposalMock).not.toHaveBeenCalled();
    expect(deliverSlackAgentResponseMock.mock.calls[0][1].text).toContain("I cannot do that from Slack");
  });

  it("archives the most recent Slack-created proposal from the same thread", async () => {
    prismaMock.communicationEntityLink.findMany.mockResolvedValueOnce([
      {
        id: "link-1",
        action: "create_proposal",
        entityType: "Proposal",
        entityId: "proposal-1",
        createdAt: new Date("2026-04-28T16:00:00.000Z"),
      },
    ]);
    prismaMock.proposal.findFirst.mockResolvedValueOnce({
      id: "proposal-1",
      title: "Clarify onboarding ownership",
      archivedAt: null,
    });

    const { runSlackAgent } = await import("./slack-agent");
    await runSlackAgent({
      ...basePayload(),
      source: "app_mention",
      prompt: "can you delete that proposal you just created",
      sourceMessageId: "delete-message-1",
      channelId: "C1",
      threadTs: "1714320000.000100",
      messageTs: "1714320100.000100",
    });

    expect(extractMock).not.toHaveBeenCalled();
    expect(createWorkItemMock).not.toHaveBeenCalled();
    expect(prismaMock.communicationEntityLink.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        installationId: "install-1",
        externalUserId: "U1",
        entityType: { in: ["Proposal"] },
        message: expect.objectContaining({
          externalChannelId: "C1",
          OR: [
            { externalMessageId: "1714320000.000100" },
            { threadExternalId: "1714320000.000100" },
          ],
        }),
      }),
      orderBy: { createdAt: "desc" },
    }));
    expect(deleteProposalMock).toHaveBeenCalledWith(expect.objectContaining({ kind: "user" }), {
      workspaceId: "workspace-1",
      proposalId: "proposal-1",
    });
    expect(prismaMock.communicationEntityLink.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        installationId: "install-1",
        workspaceId: "workspace-1",
        provider: "SLACK",
        messageId: "delete-message-1",
        externalUserId: "U1",
        entityType: "Proposal",
        entityId: "proposal-1",
        action: "undo_create_proposal",
      }),
    });
    expect(deliverSlackAgentResponseMock.mock.calls[0][1].text).toContain("Archived Proposal");
    expect(deliverSlackAgentResponseMock.mock.calls[0][1].text).toContain("Clarify onboarding ownership");
  });

  it("does not archive arbitrary records when no Slack-created undo target exists", async () => {
    const { runSlackAgent } = await import("./slack-agent");
    await runSlackAgent({ ...basePayload(), prompt: "undo that last action" });

    expect(extractMock).not.toHaveBeenCalled();
    expect(deleteActionMock).not.toHaveBeenCalled();
    expect(deleteProposalMock).not.toHaveBeenCalled();
    expect(prismaMock.communicationEntityLink.create).not.toHaveBeenCalled();
    expect(deliverSlackAgentResponseMock.mock.calls[0][1].text).toContain("could not find an active Slack-created item");
  });

  it("answers workspace questions from indexed knowledge", async () => {
    extractMock.mockResolvedValueOnce({
      output: {
        intent: "answer_question",
        confidence: 0.82,
        title: "Advice routing",
        bodyMd: "What does advice routing do?",
      },
    });

    const { runSlackAgent } = await import("./slack-agent");
    await runSlackAgent({ ...basePayload(), prompt: "What does advice routing do?" });

    expect(answerKnowledgeQuestionMock).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "workspace-1",
      question: "What does advice routing do?",
    }));
    expect(chatMock).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "workspace-1",
      taskType: "AGENT",
    }));
    expect(createWorkItemMock).not.toHaveBeenCalled();
    expect(deliverSlackAgentResponseMock.mock.calls[0][1].text).toContain("workspace handbook");
    expect(deliverSlackAgentResponseMock.mock.calls[0][1].text).not.toContain("Done:");
  });

  it("answers using stored Slack thread, channel, summaries, and Brain chunks", async () => {
    extractMock.mockResolvedValueOnce({
      output: {
        intent: "answer_question",
        confidence: 0.84,
        title: "Budget cap",
        bodyMd: "What budget cap was agreed in this thread?",
      },
    });
    prismaMock.communicationMessage.findMany
      .mockResolvedValueOnce([
        {
          id: "thread-message-1",
          text: "We agreed the pilot budget cap is $20k.",
          externalUserId: "U2",
          externalMessageId: "1714320000.000100",
          threadExternalId: "1714320000.000100",
          messageTs: new Date("2024-04-28T16:00:00.000Z"),
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "channel-message-1",
          text: "Finance also asked for weekly spend updates.",
          externalUserId: "U3",
          externalMessageId: "1714319900.000100",
          threadExternalId: null,
          messageTs: new Date("2024-04-28T15:58:20.000Z"),
        },
      ]);
    prismaMock.communicationContextSummary.findMany.mockResolvedValueOnce([
      {
        title: "Slack #general thread 2024-04-28",
        summaryMd: "The thread settled on a $20k pilot budget cap and weekly spend updates.",
        threadExternalId: "1714320000.000100",
        summaryDate: new Date("2024-04-28T00:00:00.000Z"),
        messageCount: 3,
      },
    ]);
    searchIndexedKnowledgeMock.mockResolvedValueOnce([
      {
        sourceTitle: "Slack #general",
        content: "Slack message confirms the pilot budget cap is $20k.",
        metadata: { permalink: "https://slack.test/archives/C1/p1714320000000100" },
      },
    ]);
    chatMock.mockResolvedValueOnce({ content: "The agreed pilot budget cap is $20k." });

    const { runSlackAgent } = await import("./slack-agent");
    await runSlackAgent({
      ...basePayload(),
      source: "app_mention",
      prompt: "What budget cap was agreed in this thread?",
      threadTs: "1714320000.000100",
      messageTs: "1714320100.000100",
    });

    expect(searchIndexedKnowledgeMock).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "workspace-1",
      sourceTypes: ["SLACK"],
      query: "What budget cap was agreed in this thread?",
    }));
    const conversationCall = chatMock.mock.calls.find((call) => call[0]?.taskType === "AGENT");
    expect(conversationCall).toBeDefined();
    const promptPayload = JSON.parse(conversationCall?.[0].messages[1].content);
    expect(promptPayload.threadMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: "We agreed the pilot budget cap is $20k." }),
    ]));
    expect(promptPayload.channelMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: "Finance also asked for weekly spend updates." }),
    ]));
    expect(promptPayload.slackContextSummaries).toEqual(expect.arrayContaining([
      expect.objectContaining({ summaryMd: expect.stringContaining("$20k") }),
    ]));
    expect(promptPayload.slackKnowledge).toEqual(expect.arrayContaining([
      expect.objectContaining({ content: expect.stringContaining("$20k") }),
    ]));
    expect(deliverSlackAgentResponseMock.mock.calls[0][1].text).toContain("$20k");
  });

  it("answers read-only member list requests conversationally", async () => {
    extractMock.mockResolvedValueOnce({
      output: {
        intent: "unsupported",
        confidence: 0.2,
        title: "List members",
        bodyMd: "list all the members",
      },
    });
    listMembersMock.mockResolvedValueOnce([
      {
        id: "member-1",
        userId: "user-1",
        role: "ADMIN",
        user: {
          email: "user@example.test",
          displayName: "User",
        },
      },
      {
        id: "member-2",
        userId: "user-2",
        role: "CONTRIBUTOR",
        user: {
          email: "milan@example.test",
          displayName: "Milan",
        },
      },
    ]);

    const { runSlackAgent } = await import("./slack-agent");
    await runSlackAgent({ ...basePayload(), prompt: "list all the members" });

    expect(createWorkItemMock).not.toHaveBeenCalled();
    expect(answerKnowledgeQuestionMock).not.toHaveBeenCalled();
    expect(chatMock).not.toHaveBeenCalled();
    expect(deliverSlackAgentResponseMock.mock.calls[0][1].text).toContain("I found 2 active members");
    expect(deliverSlackAgentResponseMock.mock.calls[0][1].text).toContain("Milan");
    expect(deliverSlackAgentResponseMock.mock.calls[0][1].text).not.toContain("Done:");
  });

  it("answers account lookup requests for the linked Slack user", async () => {
    extractMock.mockResolvedValueOnce({
      output: {
        intent: "unsupported",
        confidence: 0.1,
        title: "Find account",
        bodyMd: "can you find my account now",
      },
    });
    prismaMock.communicationExternalUser.findMany.mockResolvedValueOnce([
      {
        externalUserId: "U1",
        userId: "user-1",
        memberId: "member-1",
        email: "user@example.test",
        displayName: "User",
      },
    ]);
    listMembersMock.mockResolvedValueOnce([
      {
        id: "member-1",
        userId: "user-1",
        role: "ADMIN",
        user: {
          email: "user@example.test",
          displayName: "User",
        },
      },
    ]);

    const { runSlackAgent } = await import("./slack-agent");
    await runSlackAgent({ ...basePayload(), prompt: "can you find my account now" });

    expect(createWorkItemMock).not.toHaveBeenCalled();
    expect(deliverSlackAgentResponseMock.mock.calls[0][1].text).toContain("I found your Corgtex account");
    expect(deliverSlackAgentResponseMock.mock.calls[0][1].text).toContain("user@example.test");
    expect(deliverSlackAgentResponseMock.mock.calls[0][1].text).not.toContain("Done:");
  });

  it("does not expose workspace data when the Slack user is not an active member", async () => {
    prismaMock.member.findUnique.mockResolvedValueOnce(null);

    const { runSlackAgent } = await import("./slack-agent");
    await runSlackAgent({ ...basePayload(), prompt: "list all the members" });

    expect(extractMock).not.toHaveBeenCalled();
    expect(listMembersMock).not.toHaveBeenCalled();
    expect(createWorkItemMock).not.toHaveBeenCalled();
    expect(deliverSlackAgentResponseMock.mock.calls[0][1].text).toContain("could not match your Slack user");
    expect(deliverSlackAgentResponseMock.mock.calls[0][1].text).not.toContain("Milan");
  });
});
