import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  prismaMock,
  createWorkItemMock,
  deliverSlackAgentResponseMock,
  fetchSlackThreadMessagesMock,
  listMembersMock,
  extractMock,
  chatMock,
  answerKnowledgeQuestionMock,
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
    communicationExternalUser: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
    communicationMessage: {
      findUnique: vi.fn(),
    },
    action: {
      findMany: vi.fn(),
    },
    tension: {
      findMany: vi.fn(),
    },
    proposal: {
      findMany: vi.fn(),
    },
    $transaction: vi.fn(),
  },
  createWorkItemMock: vi.fn(),
  deliverSlackAgentResponseMock: vi.fn(),
  fetchSlackThreadMessagesMock: vi.fn(),
  listMembersMock: vi.fn(),
  extractMock: vi.fn(),
  chatMock: vi.fn(),
  answerKnowledgeQuestionMock: vi.fn(),
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
  searchIndexedKnowledge: vi.fn().mockResolvedValue([]),
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
    prismaMock.communicationExternalUser.findUnique.mockResolvedValue({
      rawProfile: { tz: "America/Los_Angeles" },
    });
    prismaMock.communicationExternalUser.findMany.mockResolvedValue([]);
    prismaMock.communicationMessage.findUnique.mockResolvedValue(null);
    prismaMock.action.findMany.mockResolvedValue([]);
    prismaMock.tension.findMany.mockResolvedValue([]);
    prismaMock.proposal.findMany.mockResolvedValue([]);
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
    answerKnowledgeQuestionMock.mockResolvedValue({
      answer: "The workspace handbook says to use advice routing for proposal risks.",
      citations: [],
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
    expect(deliverSlackAgentResponseMock.mock.calls[0][1].text).toContain("outside Slack-agent v1");
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
    expect(createWorkItemMock).not.toHaveBeenCalled();
    expect(deliverSlackAgentResponseMock.mock.calls[0][1].text).toContain("workspace handbook");
  });
});
