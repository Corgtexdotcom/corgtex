import { beforeEach, describe, expect, it, vi } from "vitest";

const createSpendMock = vi.fn();
const submitSpendMock = vi.fn();
const createGoalMock = vi.fn();
const listGoalsMock = vi.fn();
const getGoalMock = vi.fn();
const updateGoalMock = vi.fn();
const deleteGoalMock = vi.fn();
const listWorkspaceToolLinksMock = vi.fn();
const upsertWorkspaceToolLinkMock = vi.fn();
const archiveWorkspaceToolLinkMock = vi.fn();
const revealWorkspaceToolLinkCredentialMock = vi.fn();

vi.mock("@corgtex/domain", () => ({
  CONTROL_PLANE_WORKSPACE_FEATURE_FLAGS: [
    { flag: "GOALS", label: "Goals", description: "Goals", defaultEnabled: true },
    { flag: "FINANCE", label: "Finance", description: "Finance", defaultEnabled: false },
  ],
  listProposals: vi.fn(),
  createProposal: vi.fn(),
  listActions: vi.fn(),
  createAction: vi.fn(),
  listTensions: vi.fn(),
  createTension: vi.fn(),
  listGoals: listGoalsMock,
  getGoal: getGoalMock,
  createGoal: createGoalMock,
  updateGoal: updateGoalMock,
  deleteGoal: deleteGoalMock,
  listMembers: vi.fn(),
  listMembersEnriched: vi.fn(),
  createMember: vi.fn(),
  updateMember: vi.fn(),
  deactivateMember: vi.fn(),
  resendMemberAccessLink: vi.fn(),
  sendMemberSetupEmail: vi.fn(),
  createDocument: vi.fn(),
  listMeetings: vi.fn(),
  getCurrentConstitution: vi.fn(),
  listPolicyCorpus: vi.fn(),
  listAgentRuns: vi.fn(),
  listCommunicationInstallations: vi.fn(),
  listExternalDataSources: vi.fn(),
  enqueueExternalDataSourceSync: vi.fn(),
  listWorkspaceToolLinks: listWorkspaceToolLinksMock,
  upsertWorkspaceToolLink: upsertWorkspaceToolLinkMock,
  archiveWorkspaceToolLink: archiveWorkspaceToolLinkMock,
  revealWorkspaceToolLinkCredential: revealWorkspaceToolLinkCredentialMock,
  listRuntimeJobs: vi.fn(),
  listFailedJobs: vi.fn(),
  replayWorkflowJob: vi.fn(),
  discardFailedJob: vi.fn(),
  createSpend: createSpendMock,
  submitSpend: submitSpendMock,
  listSpends: vi.fn(),
  listLedgerAccounts: vi.fn(),
}));

vi.mock("@corgtex/knowledge", () => ({
  searchIndexedKnowledge: vi.fn(),
}));

vi.mock("@corgtex/agents", () => ({
  processConversationTurn: vi.fn(),
}));

vi.mock("@corgtex/shared", () => ({
  prisma: {
    workspaceFeatureFlag: {
      findMany: vi.fn(),
      upsert: vi.fn(),
    },
  },
  env: { APP_URL: "https://app.test" },
}));

vi.mock("./auth", () => ({
  requireScope: vi.fn(),
}));

describe("createCorgtexMcpServer", () => {
  beforeEach(() => {
    createSpendMock.mockReset().mockResolvedValue({ id: "spend-1" });
    submitSpendMock.mockReset().mockResolvedValue({
      spendId: "spend-1",
    });
    createGoalMock.mockReset().mockResolvedValue({
      id: "goal-1",
      title: "Transform 1,000 businesses",
      status: "ACTIVE",
      cadence: "TEN_YEAR",
    });
    listGoalsMock.mockReset().mockResolvedValue([]);
    getGoalMock.mockReset().mockResolvedValue({ id: "goal-1", cadence: "QUARTERLY" });
    updateGoalMock.mockReset().mockResolvedValue({ id: "goal-1", status: "ACTIVE", cadence: "QUARTERLY" });
    deleteGoalMock.mockReset().mockResolvedValue(undefined);
    listWorkspaceToolLinksMock.mockReset().mockResolvedValue([]);
    upsertWorkspaceToolLinkMock.mockReset().mockResolvedValue({
      id: "tool-1",
      title: "Miro board",
      hasCredential: true,
    });
    archiveWorkspaceToolLinkMock.mockReset().mockResolvedValue({ id: "tool-1" });
    revealWorkspaceToolLinkCredentialMock.mockReset().mockResolvedValue({
      credentialLabel: "Board password",
      credentialSecret: "board-pass",
    });
  });

  it("returns the opened spend identifier from create_spend", async () => {
    const { createCorgtexMcpServer } = await import("./server");

    const server = createCorgtexMcpServer({
      actor: { kind: "agent", authProvider: "bootstrap" } as any,
      workspaceId: "ws-1",
      authKind: "agent",
    });

    const createSpendTool = (server as any)._registeredTools.create_spend;
    const response = await createSpendTool.handler({
      amountCents: 1500,
      currency: "USD",
      category: "software",
      description: "Copilot",
      requesterEmail: "user@example.com",
    });

    expect(createSpendMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "agent" }),
      expect.objectContaining({
        workspaceId: "ws-1",
        amountCents: 1500,
        currency: "USD",
        category: "software",
        description: "Copilot",
        requesterEmail: "user@example.com",
      }),
    );
    expect(submitSpendMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "agent" }),
      { workspaceId: "ws-1", spendId: "spend-1" },
    );
    expect(JSON.parse(response.content[0].text)).toEqual({
      id: "spend-1",
      status: "OPEN",
      webUrl: "https://app.test/workspaces/ws-1/finance/spend/spend-1",
    });
  });

  it("annotates read-only and destructive tools for connector approval reviews", async () => {
    const { createCorgtexMcpServer } = await import("./server");

    const server = createCorgtexMcpServer({
      actor: { kind: "agent", authProvider: "bootstrap" } as any,
      workspaceId: "ws-1",
      authKind: "agent",
    });

    expect((server as any)._registeredTools.search.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect((server as any)._registeredTools.fetch.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect((server as any)._registeredTools.delete_action.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
    });
    expect((server as any)._registeredTools.archive_goal.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
    });
    expect((server as any)._registeredTools.archive_tool_link.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
    });
    expect((server as any)._registeredTools.reveal_tool_link_credential.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      sensitiveHint: true,
      openWorldHint: false,
    });
  });

  it("returns the created goal identifier from create_goal", async () => {
    const { createCorgtexMcpServer } = await import("./server");
    const { requireScope } = await import("./auth");

    const server = createCorgtexMcpServer({
      actor: { kind: "agent", authProvider: "bootstrap" } as any,
      workspaceId: "ws-1",
      authKind: "agent",
    });

    const createGoalTool = (server as any)._registeredTools.create_goal;
    const response = await createGoalTool.handler({
      title: "Transform 1,000 businesses",
      cadence: "TEN_YEAR",
      keyResults: [{ title: "Acquire first pilot", targetValue: 1, currentValue: 0 }],
    });

    expect(createGoalMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "agent" }),
      expect.objectContaining({
        workspaceId: "ws-1",
        title: "Transform 1,000 businesses",
        cadence: "TEN_YEAR",
        keyResults: [{ title: "Acquire first pilot", targetValue: 1, currentValue: 0 }],
      }),
    );
    expect(vi.mocked(requireScope)).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws-1" }),
      "goals:write",
    );
    expect(JSON.parse(response.content[0].text)).toEqual({
      id: "goal-1",
      title: "Transform 1,000 businesses",
      status: "ACTIVE",
      webUrl: "https://app.test/workspaces/ws-1/goals?view=tree&cadence=TEN_YEAR",
    });
  });

  it("registers goal read, update, and archive tools with scopes and URLs", async () => {
    const { createCorgtexMcpServer } = await import("./server");
    const { requireScope } = await import("./auth");

    listGoalsMock.mockResolvedValueOnce([{
      id: "goal-1",
      title: "Quarterly traction",
      cadence: "QUARTERLY",
      level: "COMPANY",
      status: "ACTIVE",
      progressPercent: 20,
      circle: null,
      ownerMember: null,
      keyResults: [],
    }]);
    getGoalMock.mockResolvedValueOnce({ id: "goal-1", cadence: "QUARTERLY", title: "Quarterly traction" });
    updateGoalMock.mockResolvedValueOnce({ id: "goal-1", status: "ON_TRACK", cadence: "QUARTERLY" });

    const server = createCorgtexMcpServer({
      actor: { kind: "agent", authProvider: "bootstrap" } as any,
      workspaceId: "ws-1",
      authKind: "agent",
    });

    const listResponse = await (server as any)._registeredTools.list_goals.handler({ cadence: "QUARTERLY" });
    const getResponse = await (server as any)._registeredTools.get_goal.handler({ goalId: "goal-1" });
    const updateResponse = await (server as any)._registeredTools.update_goal.handler({ goalId: "goal-1", status: "ON_TRACK" });
    const archiveResponse = await (server as any)._registeredTools.archive_goal.handler({ goalId: "goal-1" });

    expect(vi.mocked(requireScope)).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws-1" }), "goals:read");
    expect(vi.mocked(requireScope)).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws-1" }), "goals:write");
    expect(JSON.parse(listResponse.content[0].text).items[0].webUrl).toBe("https://app.test/workspaces/ws-1/goals?view=tree&cadence=QUARTERLY");
    expect(JSON.parse(getResponse.content[0].text).webUrl).toBe("https://app.test/workspaces/ws-1/goals?view=tree&cadence=QUARTERLY");
    expect(JSON.parse(updateResponse.content[0].text)).toEqual({
      id: "goal-1",
      status: "ON_TRACK",
      webUrl: "https://app.test/workspaces/ws-1/goals?view=tree&cadence=QUARTERLY",
    });
    expect(JSON.parse(archiveResponse.content[0].text)).toEqual({
      id: "goal-1",
      archived: true,
      webUrl: "https://app.test/workspaces/ws-1/audit?tab=archive",
    });
  });

  it("upserts a shared tool link without returning credential material", async () => {
    const { createCorgtexMcpServer } = await import("./server");
    const { requireScope } = await import("./auth");

    const server = createCorgtexMcpServer({
      actor: { kind: "agent", authProvider: "bootstrap" } as any,
      workspaceId: "ws-1",
      authKind: "agent",
    });

    const upsertTool = (server as any)._registeredTools.upsert_tool_link;
    const response = await upsertTool.handler({
      title: "Miro board",
      url: "https://miro.com/app/board/example",
      category: "WHITEBOARD",
      credentialLabel: "Board password",
      credentialSecret: "replace with access code",
    });

    expect(upsertWorkspaceToolLinkMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "agent" }),
      expect.objectContaining({
        workspaceId: "ws-1",
        title: "Miro board",
        url: "https://miro.com/app/board/example",
        category: "WHITEBOARD",
        credentialLabel: "Board password",
        credentialSecret: "replace with access code",
      }),
    );
    expect(vi.mocked(requireScope)).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws-1" }),
      "tools:write",
    );
    expect(JSON.parse(response.content[0].text)).toEqual({
      id: "tool-1",
      title: "Miro board",
      hasCredential: true,
      webUrl: "https://app.test/workspaces/ws-1/tools",
    });
    expect(response.content[0].text).not.toContain("replace with access code");
  });

  it("reveals tool link credentials through a separate sensitive scoped tool", async () => {
    const { createCorgtexMcpServer } = await import("./server");
    const { requireScope } = await import("./auth");

    const actor = {
      kind: "user",
      user: { id: "user-1", email: "user@example.com", displayName: "User" },
    } as any;
    const server = createCorgtexMcpServer({
      actor,
      workspaceId: "ws-1",
      authKind: "oauth",
      scopes: ["tools:credentials:read"],
    });

    const revealTool = (server as any)._registeredTools.reveal_tool_link_credential;
    const response = await revealTool.handler({ toolLinkId: "tool-1" });

    expect(revealWorkspaceToolLinkCredentialMock).toHaveBeenCalledWith(
      actor,
      { workspaceId: "ws-1", toolLinkId: "tool-1" },
    );
    expect(vi.mocked(requireScope)).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws-1" }),
      "tools:credentials:read",
    );
    expect(JSON.parse(response.content[0].text)).toEqual({
      toolLinkId: "tool-1",
      credentialLabel: "Board password",
      credentialSecret: "board-pass",
    });
  });

  it("passes the real actor into MCP chat instead of falling back to a bootstrap agent", async () => {
    const { createCorgtexMcpServer } = await import("./server");
    const { processConversationTurn } = await import("@corgtex/agents");

    const actor = {
      kind: "user",
      user: { id: "user-1", email: "user@example.com", displayName: "User" },
    } as any;
    vi.mocked(processConversationTurn).mockResolvedValueOnce({
      assistantMessage: "done",
      contextUsed: {},
    } as any);

    const server = createCorgtexMcpServer({
      actor,
      workspaceId: "ws-1",
      authKind: "oauth",
      scopes: ["conversations:write"],
    });

    await (server as any)._registeredTools.chat.handler({ message: "show tools" });

    expect(processConversationTurn).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "ws-1",
      sessionId: "mcp-ws-1-user-1",
      userId: "user-1",
      userMessage: "show tools",
      actor,
    }));
  });
});
