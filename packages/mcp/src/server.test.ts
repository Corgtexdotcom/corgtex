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
const supportReopenResolvedProposalsMock = vi.fn();
const listAgentCredentialsMock = vi.fn();
const updateAgentCredentialScopesMock = vi.fn();
const revokeAgentCredentialMock = vi.fn();
const listAgentConfigsMock = vi.fn();
const updateAgentConfigMock = vi.fn();
const getModelUsageBudgetMock = vi.fn();
const updateModelUsageBudgetMock = vi.fn();
const executeExternalMcpToolMock = vi.fn();
const fetchConnectedExternalMcpContextMock = vi.fn();
const listExternalMcpConnectionsMock = vi.fn();
const searchConnectedExternalMcpContextMock = vi.fn();
const recordAuditMock = vi.fn();
const searchIndexedKnowledgeMock = vi.fn();
const buildSelectedRegionContextMock = vi.fn();
const createContextGraphProposedDiffMock = vi.fn();
const importContextGraphMapMock = vi.fn();
const getContextMapDataMock = vi.fn();
const createExecutionRequestMock = vi.fn();
const getExecutionPacketMock = vi.fn();
const getCompanyContextMock = vi.fn();
const listWritebackTargetsMock = vi.fn();
const submitExecutionResultMock = vi.fn();

vi.mock("@corgtex/domain", () => ({
  CONTROL_PLANE_WORKSPACE_FEATURE_FLAGS: [
    { flag: "GOALS", label: "Goals", description: "Goals", defaultEnabled: true },
    { flag: "FINANCE", label: "Finance", description: "Finance", defaultEnabled: false },
  ],
  listProposals: vi.fn(),
  createProposal: vi.fn(),
  supportReopenResolvedProposals: supportReopenResolvedProposalsMock,
  evaluateDelegatedActionPolicy: vi.fn((input: { toolName?: string | null; operation?: "read" | "write" | null; confidence?: number | null; explicitUserIntent?: boolean }) => {
    if ([
      "reveal_tool_link_credential",
      "record_support_audit",
      "support_reopen_resolved_proposals",
      "update_agent_credential_scopes",
      "revoke_agent_credential",
      "update_agent_policy",
      "update_model_budget",
    ].includes(input.toolName ?? "")) {
      return { policyClass: "sensitive", autoRunAllowed: false, requiresSensitiveHandling: true, reason: "test sensitive" };
    }
    if (input.operation === "read") {
      return { policyClass: "read", autoRunAllowed: true, requiresSensitiveHandling: false, reason: "test read" };
    }
    if (input.explicitUserIntent || input.confidence == null || input.confidence >= 0.8) {
      return { policyClass: "normal_write", autoRunAllowed: true, requiresSensitiveHandling: false, reason: "test normal write" };
    }
    return { policyClass: "draft_or_clarify", autoRunAllowed: false, requiresSensitiveHandling: false, reason: "test draft" };
  }),
  executeExternalMcpTool: executeExternalMcpToolMock,
  fetchConnectedExternalMcpContext: fetchConnectedExternalMcpContextMock,
  listActions: vi.fn(),
  createAction: vi.fn(),
  listTensions: vi.fn(),
  createTension: vi.fn(),
  listExternalMcpConnections: listExternalMcpConnectionsMock,
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
  listAgentCredentials: listAgentCredentialsMock,
  updateAgentCredentialScopes: updateAgentCredentialScopesMock,
  revokeAgentCredential: revokeAgentCredentialMock,
  listAgentConfigs: listAgentConfigsMock,
  updateAgentConfig: updateAgentConfigMock,
  getModelUsageBudget: getModelUsageBudgetMock,
  updateModelUsageBudget: updateModelUsageBudgetMock,
  listCommunicationInstallations: vi.fn(),
  listExternalDataSources: vi.fn(),
  enqueueExternalDataSourceSync: vi.fn(),
  listWorkspaceToolLinks: listWorkspaceToolLinksMock,
  upsertWorkspaceToolLink: upsertWorkspaceToolLinkMock,
  archiveWorkspaceToolLink: archiveWorkspaceToolLinkMock,
  revealWorkspaceToolLinkCredential: revealWorkspaceToolLinkCredentialMock,
  recordAudit: recordAuditMock,
  buildSelectedRegionContext: buildSelectedRegionContextMock,
  createContextGraphProposedDiff: createContextGraphProposedDiffMock,
  importContextGraphMap: importContextGraphMapMock,
  getContextMapData: getContextMapDataMock,
  createExecutionRequest: createExecutionRequestMock,
  getExecutionPacket: getExecutionPacketMock,
  getCompanyContext: getCompanyContextMock,
  listWritebackTargets: listWritebackTargetsMock,
  submitExecutionResult: submitExecutionResultMock,
  searchConnectedExternalMcpContext: searchConnectedExternalMcpContextMock,
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
  searchIndexedKnowledge: searchIndexedKnowledgeMock,
}));

vi.mock("@corgtex/agents", () => ({
  processConversationTurn: vi.fn(),
}));

vi.mock("@corgtex/shared", () => ({
  prisma: {
    $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback({})),
    workspaceFeatureFlag: {
      findMany: vi.fn(),
      upsert: vi.fn(),
    },
  },
  env: { APP_URL: "https://app.test" },
  toInputJson: (value: unknown) => value,
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
    supportReopenResolvedProposalsMock.mockReset().mockResolvedValue({
      workspaceId: "ws-1",
      reopened: [{ id: "proposal-1", status: "OPEN", flowId: "flow-1", policyCorpusRowsDeleted: 1 }],
    });
    listAgentCredentialsMock.mockReset().mockResolvedValue([]);
    updateAgentCredentialScopesMock.mockReset().mockResolvedValue({ id: "cred-1", label: "Production MCP", scopes: ["workspace:read"], isActive: true });
    revokeAgentCredentialMock.mockReset().mockResolvedValue({ id: "cred-1", label: "Production MCP", scopes: ["workspace:read"], isActive: false });
    listAgentConfigsMock.mockReset().mockResolvedValue([]);
    updateAgentConfigMock.mockReset().mockResolvedValue({
      id: "config-1",
      agentKey: "meeting-summary",
      enabled: true,
      modelOverride: null,
      governancePolicy: null,
      updatedAt: new Date("2026-05-01T00:00:00.000Z"),
    });
    getModelUsageBudgetMock.mockReset().mockResolvedValue(null);
    updateModelUsageBudgetMock.mockReset().mockResolvedValue({ id: "budget-1", monthlyCostCapUsd: "250.00" });
    executeExternalMcpToolMock.mockReset().mockResolvedValue({ skipped: false, result: { ok: true } });
    fetchConnectedExternalMcpContextMock.mockReset().mockResolvedValue({ providerKey: "notion", externalId: "page-1", content: { title: "Launch" } });
    listExternalMcpConnectionsMock.mockReset().mockResolvedValue([]);
    recordAuditMock.mockReset().mockResolvedValue({ id: "audit-1" });
    searchConnectedExternalMcpContextMock.mockReset().mockResolvedValue({ results: [], errors: [] });
    searchIndexedKnowledgeMock.mockReset().mockResolvedValue([]);
    createExecutionRequestMock.mockReset().mockResolvedValue({ id: "request-1", status: "PENDING" });
    getExecutionPacketMock.mockReset().mockResolvedValue({ id: "request-1", goal: "Draft follow-up" });
    getCompanyContextMock.mockReset().mockResolvedValue({ workspace: { id: "ws-1", name: "Acme" } });
    listWritebackTargetsMock.mockReset().mockResolvedValue({ items: [{ type: "ACTION", id: "action-1", title: "Follow up" }] });
    submitExecutionResultMock.mockReset().mockResolvedValue({ id: "result-1", status: "ACCEPTED" });
    importContextGraphMapMock.mockReset().mockResolvedValue({
      mapViewId: "map-1",
      objectCount: 2,
      relationshipCount: 1,
      evidenceCount: 2,
      layoutItemCount: 2,
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

  it("creates execution requests and returns execution packet context", async () => {
    const { createCorgtexMcpServer } = await import("./server");
    const { requireScope } = await import("./auth");

    const server = createCorgtexMcpServer({
      actor: { kind: "agent", authProvider: "bootstrap" } as any,
      workspaceId: "ws-1",
      authKind: "agent",
    });

    const createResponse = await (server as any)._registeredTools.create_execution_request.handler({
      goal: "Draft the implementation follow-up",
      provider: "OPENWORK",
      writebackTargetType: "ACTION",
      idempotencyKey: "request-key",
    });
    const packetResponse = await (server as any)._registeredTools.get_execution_packet.handler({
      requestId: "request-1",
    });

    expect((server as any)._registeredTools.get_execution_packet.annotations).toMatchObject({
      readOnlyHint: false,
      idempotentHint: false,
      destructiveHint: false,
      openWorldHint: false,
    });
    expect(vi.mocked(requireScope)).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws-1" }), "execution:write");
    expect(vi.mocked(requireScope)).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws-1" }), "execution:read");
    expect(createExecutionRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "agent" }),
      expect.objectContaining({
        workspaceId: "ws-1",
        goal: "Draft the implementation follow-up",
        provider: "OPENWORK",
        writebackTargetType: "ACTION",
        idempotencyKey: "request-key",
      }),
    );
    expect(getExecutionPacketMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "agent" }),
      { workspaceId: "ws-1", requestId: "request-1" },
    );
    expect(JSON.parse(createResponse.content[0].text)).toMatchObject({
      id: "request-1",
      webUrl: "https://app.test/workspaces/ws-1/settings?tab=ai-workspaces&executionRequest=request-1",
    });
    expect(JSON.parse(packetResponse.content[0].text)).toEqual({ id: "request-1", goal: "Draft follow-up" });
  });

  it("returns company context and write-back targets for execution clients", async () => {
    const { createCorgtexMcpServer } = await import("./server");
    const { requireScope } = await import("./auth");

    const server = createCorgtexMcpServer({
      actor: { kind: "agent", authProvider: "bootstrap" } as any,
      workspaceId: "ws-1",
      authKind: "agent",
    });

    const contextResponse = await (server as any)._registeredTools.get_company_context.handler({});
    const targetsResponse = await (server as any)._registeredTools.list_writeback_targets.handler({
      query: "Follow",
      targetTypes: ["ACTION"],
      take: 5,
    });

    expect(vi.mocked(requireScope)).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws-1" }), "workspace:read");
    expect(vi.mocked(requireScope)).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws-1" }), "execution:read");
    expect(vi.mocked(requireScope)).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws-1" }), "actions:read");
    expect(vi.mocked(requireScope)).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws-1" }), "tensions:read");
    expect(vi.mocked(requireScope)).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws-1" }), "proposals:read");
    expect(vi.mocked(requireScope)).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws-1" }), "meetings:read");
    expect(vi.mocked(requireScope)).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws-1" }), "brain:read");
    expect(getCompanyContextMock).toHaveBeenCalledWith(expect.objectContaining({ kind: "agent" }), "ws-1");
    expect(listWritebackTargetsMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "agent" }),
      { workspaceId: "ws-1", query: "Follow", targetTypes: ["ACTION"], take: 5 },
    );
    expect(JSON.parse(contextResponse.content[0].text)).toEqual({ workspace: { id: "ws-1", name: "Acme" } });
    expect(JSON.parse(targetsResponse.content[0].text).items[0]).toEqual(expect.objectContaining({ type: "ACTION", id: "action-1" }));
  });

  it("submits idempotent execution results through the audited write-back path", async () => {
    const { createCorgtexMcpServer } = await import("./server");
    const { requireScope } = await import("./auth");

    const server = createCorgtexMcpServer({
      actor: { kind: "agent", authProvider: "bootstrap" } as any,
      workspaceId: "ws-1",
      authKind: "agent",
    });

    const response = await (server as any)._registeredTools.submit_execution_result.handler({
      requestId: "request-1",
      idempotencyKey: "result-key",
      targetType: "ACTION",
      output: { title: "Follow up" },
    });

    expect(vi.mocked(requireScope)).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws-1" }), "execution:write");
    expect(submitExecutionResultMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "agent" }),
      {
        workspaceId: "ws-1",
        requestId: "request-1",
        idempotencyKey: "result-key",
        targetType: "ACTION",
        output: { title: "Follow up" },
      },
    );
    expect(JSON.parse(response.content[0].text)).toMatchObject({
      id: "result-1",
      status: "ACCEPTED",
      webUrl: "https://app.test/workspaces/ws-1/settings?tab=ai-workspaces&executionRequest=request-1",
    });
  });

  it("lists and sets feature flag config for customer support operations", async () => {
    const { createCorgtexMcpServer } = await import("./server");
    const { prisma } = await import("@corgtex/shared");
    vi.mocked(prisma.workspaceFeatureFlag.findMany).mockResolvedValueOnce([
      {
        flag: "FINANCE",
        enabled: true,
        config: { channelId: "C123" },
        updatedAt: new Date("2026-05-20T00:00:00.000Z"),
      },
    ] as never);
    vi.mocked(prisma.workspaceFeatureFlag.upsert).mockResolvedValueOnce({
      flag: "FINANCE",
      enabled: true,
      config: { channelId: "C456" },
    } as never);

    const server = createCorgtexMcpServer({
      actor: { kind: "agent", authProvider: "bootstrap" } as any,
      workspaceId: "ws-1",
      authKind: "agent",
    });

    const listResponse = await (server as any)._registeredTools.list_feature_flags.handler({});
    expect(JSON.parse(listResponse.content[0].text).flags.find((flag: { flag: string }) => flag.flag === "FINANCE")).toMatchObject({
      enabled: true,
      config: { channelId: "C123" },
    });

    const setResponse = await (server as any)._registeredTools.set_feature_flag.handler({
      flag: "FINANCE",
      enabled: true,
      config: { channelId: "C456" },
    });

    expect(prisma.workspaceFeatureFlag.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({ enabled: true, config: { channelId: "C456" } }),
      create: expect.objectContaining({ enabled: true, config: { channelId: "C456" } }),
    }));
    expect(JSON.parse(setResponse.content[0].text)).toMatchObject({
      flag: "FINANCE",
      enabled: true,
      config: { channelId: "C456" },
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
      destructiveHint: false,
      openWorldHint: false,
    });
    expect((server as any)._registeredTools.archive_goal.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    });
    expect((server as any)._registeredTools.archive_tool_link.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    });
    expect((server as any)._registeredTools.reveal_tool_link_credential.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      sensitiveHint: true,
      openWorldHint: false,
    });
    expect((server as any)._registeredTools.support_reopen_resolved_proposals.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      sensitiveHint: true,
      openWorldHint: false,
    });
    expect((server as any)._registeredTools.import_context_graph_map.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      sensitiveHint: true,
      openWorldHint: false,
    });
    expect((server as any)._registeredTools.list_agent_credentials.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    });
    expect((server as any)._registeredTools.update_agent_policy.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      sensitiveHint: true,
      openWorldHint: false,
    });
    expect((server as any)._registeredTools.revoke_agent_credential.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      sensitiveHint: true,
      openWorldHint: false,
    });
  });

  it("lists agent credentials without returning token hashes or private reason text", async () => {
    const { createCorgtexMcpServer } = await import("./server");
    const { requireScope } = await import("./auth");
    listAgentCredentialsMock.mockResolvedValueOnce([
      {
        id: "cred-1",
        label: "Production MCP",
        scopes: ["workspace:read", "agents:read"],
        catalogItemId: "catalog-1",
        reasonMd: "Private customer setup note.",
        tokenHash: "sha256-secret",
        monthlyBudgetCents: null,
        dailyCallLimit: null,
        isActive: true,
        lastUsedAt: null,
        createdAt: new Date("2026-05-01T00:00:00.000Z"),
        updatedAt: new Date("2026-05-01T00:00:00.000Z"),
      },
    ]);

    const server = createCorgtexMcpServer({
      actor: { kind: "agent", authProvider: "bootstrap" } as any,
      workspaceId: "ws-1",
      authKind: "agent",
    });

    const response = await (server as any)._registeredTools.list_agent_credentials.handler({});
    const body = JSON.parse(response.content[0].text);

    expect(vi.mocked(requireScope)).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws-1" }), "agents:read");
    expect(body.items[0]).toEqual(expect.objectContaining({
      id: "cred-1",
      label: "Production MCP",
      scopes: ["workspace:read", "agents:read"],
      isActive: true,
    }));
    expect(body.items[0]).not.toHaveProperty("reasonMd");
    expect(body.items[0]).not.toHaveProperty("tokenHash");
    expect(response.content[0].text).not.toContain("Private customer setup note");
    expect(response.content[0].text).not.toContain("sha256-secret");
  });

  it("redacts agent governance policy bodies from support config reads and writes", async () => {
    const { createCorgtexMcpServer } = await import("./server");
    const { requireScope } = await import("./auth");
    listAgentConfigsMock.mockResolvedValueOnce([
      {
        agentKey: "meeting-summary",
        label: "Meeting Summary",
        category: "knowledge",
        enabled: true,
        modelOverride: "openai/gpt-test",
        governancePolicy: "Do not expose raw customer policy.",
        costTier: "medium",
      },
    ]);
    updateAgentConfigMock.mockResolvedValueOnce({
      id: "config-1",
      agentKey: "meeting-summary",
      enabled: true,
      modelOverride: "openai/gpt-test",
      governancePolicy: "Do not expose updated policy.",
      updatedAt: new Date("2026-05-01T00:00:00.000Z"),
    });

    const server = createCorgtexMcpServer({
      actor: { kind: "agent", authProvider: "bootstrap" } as any,
      workspaceId: "ws-1",
      authKind: "agent",
    });

    const listResponse = await (server as any)._registeredTools.list_agent_configs.handler({});
    const updateResponse = await (server as any)._registeredTools.update_agent_policy.handler({
      agentKey: "meeting-summary",
      governancePolicy: "Replacement policy body.",
      modelOverride: "openai/gpt-test",
    });

    expect(vi.mocked(requireScope)).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws-1" }), "agents:read");
    expect(vi.mocked(requireScope)).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws-1" }), "support:write");
    expect(JSON.parse(listResponse.content[0].text).items[0]).toEqual(expect.objectContaining({
      agentKey: "meeting-summary",
      modelOverride: "openai/gpt-test",
      hasGovernancePolicy: true,
    }));
    expect(JSON.parse(updateResponse.content[0].text).config).toEqual(expect.objectContaining({
      agentKey: "meeting-summary",
      modelOverride: "openai/gpt-test",
      hasGovernancePolicy: true,
    }));
    expect(listResponse.content[0].text).not.toContain("Do not expose raw customer policy");
    expect(updateResponse.content[0].text).not.toContain("Do not expose updated policy");
  });

  it("updates and revokes agent credentials through support-scoped tools without returning token material", async () => {
    const { createCorgtexMcpServer } = await import("./server");
    const { requireScope } = await import("./auth");
    updateAgentCredentialScopesMock.mockResolvedValueOnce({
      id: "cred-1",
      label: "Production MCP",
      scopes: ["workspace:read"],
      isActive: true,
      tokenHash: "sha256-secret",
    });
    revokeAgentCredentialMock.mockResolvedValueOnce({
      id: "cred-1",
      label: "Production MCP",
      scopes: ["workspace:read"],
      isActive: false,
      tokenHash: "sha256-secret",
    });

    const server = createCorgtexMcpServer({
      actor: { kind: "agent", authProvider: "bootstrap" } as any,
      workspaceId: "ws-1",
      authKind: "agent",
    });

    const updateResponse = await (server as any)._registeredTools.update_agent_credential_scopes.handler({
      credentialId: "cred-1",
      scopes: ["workspace:read"],
    });
    const revokeResponse = await (server as any)._registeredTools.revoke_agent_credential.handler({
      credentialId: "cred-1",
    });

    expect(vi.mocked(requireScope)).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws-1" }), "support:write");
    expect(updateAgentCredentialScopesMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "agent" }),
      { workspaceId: "ws-1", credentialId: "cred-1", scopes: ["workspace:read"] },
    );
    expect(revokeAgentCredentialMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "agent" }),
      { workspaceId: "ws-1", credentialId: "cred-1" },
    );
    expect(updateResponse.content[0].text).not.toContain("sha256-secret");
    expect(revokeResponse.content[0].text).not.toContain("sha256-secret");
  });

  it("runs the support proposal repair tool with support and proposal scopes", async () => {
    const { createCorgtexMcpServer } = await import("./server");
    const { requireScope } = await import("./auth");

    const server = createCorgtexMcpServer({
      actor: { kind: "agent", authProvider: "bootstrap" } as any,
      workspaceId: "ws-1",
      authKind: "agent",
    });

    const repairTool = (server as any)._registeredTools.support_reopen_resolved_proposals;
    const response = await repairTool.handler({
      proposalIds: ["proposal-1"],
      reason: "Undo accidental system auto-resolution.",
    });

    expect(vi.mocked(requireScope)).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws-1" }), "support:write");
    expect(vi.mocked(requireScope)).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws-1" }), "proposals:write");
    expect(supportReopenResolvedProposalsMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "agent" }),
      {
        workspaceId: "ws-1",
        proposalIds: ["proposal-1"],
        reason: "Undo accidental system auto-resolution.",
      },
    );
    expect(JSON.parse(response.content[0].text)).toEqual({
      workspaceId: "ws-1",
      reopened: [{ id: "proposal-1", status: "OPEN", flowId: "flow-1", policyCorpusRowsDeleted: 1 }],
      webUrls: ["https://app.test/workspaces/ws-1/proposals/proposal-1"],
    });
  });

  it("imports an approved context graph map through the sensitive context-map tool", async () => {
    const { createCorgtexMcpServer } = await import("./server");
    const { requireScope } = await import("./auth");

    const server = createCorgtexMcpServer({
      actor: { kind: "agent", authProvider: "bootstrap" } as any,
      workspaceId: "ws-1",
      authKind: "agent",
    });

    const response = await (server as any)._registeredTools.import_context_graph_map.handler({
      name: "CRNA Critical Path",
      objects: [
        { ref: "process", objectType: "Process", title: "CR North America critical path" },
        { ref: "step", objectType: "ProcessStep", title: "Decision to proceed" },
      ],
      relationships: [
        { sourceRef: "step", targetRef: "process", relationshipType: "part_of" },
      ],
      evidenceRefs: [
        { objectRef: "step", sourceType: "DOCUMENT", sourceId: "doc-1" },
      ],
      layoutItems: [
        { objectRef: "step", x: 280, y: 120 },
      ],
    });

    expect(vi.mocked(requireScope)).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws-1" }), "context-graph:approve");
    expect(importContextGraphMapMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "agent" }),
      expect.objectContaining({
        workspaceId: "ws-1",
        name: "CRNA Critical Path",
        objects: expect.arrayContaining([expect.objectContaining({ title: "Decision to proceed" })]),
      }),
    );
    expect(JSON.parse(response.content[0].text)).toEqual({
      mapViewId: "map-1",
      objectCount: 2,
      relationshipCount: 1,
      evidenceCount: 2,
      layoutItemCount: 2,
      webUrl: "https://app.test/workspaces/ws-1/maps?view=map-1",
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

  it("lists same-user connected external tools with external tool scope", async () => {
    const { createCorgtexMcpServer } = await import("./server");
    const { requireScope } = await import("./auth");
    listExternalMcpConnectionsMock.mockResolvedValueOnce([
      {
        providerKey: "notion",
        displayName: "Notion",
        status: "connected",
        connectionId: "connection-1",
        connectionOwnerUserId: "user-1",
        scopes: ["search"],
        capabilities: { searchToolName: "notion-search" },
      },
    ]);

    const actor = {
      kind: "user",
      user: { id: "user-1", email: "user@example.com", displayName: "User" },
    } as any;
    const server = createCorgtexMcpServer({
      actor,
      workspaceId: "ws-1",
      authKind: "oauth",
      scopes: ["external-tools:read"],
    });

    const response = await (server as any)._registeredTools.list_connected_tools.handler({});

    expect(vi.mocked(requireScope)).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws-1" }), "external-tools:read");
    expect(listExternalMcpConnectionsMock).toHaveBeenCalledWith(actor, "ws-1");
    expect(JSON.parse(response.content[0].text).items[0]).toEqual(expect.objectContaining({
      providerKey: "notion",
      status: "connected",
    }));
    expect((server as any)._registeredTools.list_connected_tools.annotations).toMatchObject({
      readOnlyHint: true,
      openWorldHint: true,
    });
  });

  it("searches connected Corgtex and external context with provenance", async () => {
    const { createCorgtexMcpServer } = await import("./server");
    const { requireScope } = await import("./auth");
    searchIndexedKnowledgeMock.mockResolvedValueOnce([
      {
        chunkId: "chunk-1",
        title: "Corgtex rollout",
        sourceType: "BrainArticle",
        sourceId: "article-1",
        chunkIndex: 0,
        score: 0.91,
        snippet: "Corgtex source",
      },
    ]);
    searchConnectedExternalMcpContextMock.mockResolvedValueOnce({
      results: [
        {
          id: "notion:page-1",
          source: "external_mcp",
          providerKey: "notion",
          providerDisplayName: "Notion",
          externalId: "page-1",
          title: "Notion rollout",
          text: "Notion source",
        },
      ],
      errors: [],
    });

    const actor = {
      kind: "user",
      user: { id: "user-1", email: "user@example.com", displayName: "User" },
    } as any;
    const server = createCorgtexMcpServer({
      actor,
      workspaceId: "ws-1",
      authKind: "oauth",
      scopes: ["external-tools:read", "brain:read"],
    });

    const response = await (server as any)._registeredTools.search_connected_context.handler({
      query: "rollout",
      limit: 5,
    });
    const body = JSON.parse(response.content[0].text);

    expect(vi.mocked(requireScope)).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws-1" }), "external-tools:read");
    expect(vi.mocked(requireScope)).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws-1" }), "brain:read");
    expect(body.results).toEqual([
      expect.objectContaining({
        id: "corgtex:chunk-1",
        source: "corgtex",
        providerDisplayName: "Corgtex Brain",
      }),
      expect.objectContaining({
        id: "notion:page-1",
        source: "external_mcp",
        providerDisplayName: "Notion",
      }),
    ]);
    expect(body.externalErrors).toEqual([]);
  });

  it("executes external tools through delegated policy and scope enforcement", async () => {
    const { createCorgtexMcpServer } = await import("./server");
    const { requireScope } = await import("./auth");
    executeExternalMcpToolMock.mockResolvedValueOnce({
      skipped: false,
      providerKey: "notion",
      toolName: "notion-create-page",
      result: { id: "page-1" },
    });

    const actor = {
      kind: "user",
      user: { id: "user-1", email: "user@example.com", displayName: "User" },
    } as any;
    const server = createCorgtexMcpServer({
      actor,
      workspaceId: "ws-1",
      authKind: "oauth",
      scopes: ["external-tools:write"],
    });

    const response = await (server as any)._registeredTools.execute_external_tool.handler({
      providerKey: "notion",
      toolName: "notion-create-page",
      arguments: { title: "Decision log" },
      confidence: 0.95,
    });

    expect(vi.mocked(requireScope)).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws-1" }), "external-tools:write");
    expect(executeExternalMcpToolMock).toHaveBeenCalledWith(actor, {
      workspaceId: "ws-1",
      providerKey: "notion",
      toolName: "notion-create-page",
      arguments: { title: "Decision log" },
      operation: undefined,
      confidence: 0.95,
      explicitUserIntent: false,
    });
    expect(JSON.parse(response.content[0].text)).toEqual(expect.objectContaining({
      skipped: false,
      providerKey: "notion",
      toolName: "notion-create-page",
    }));
    expect((server as any)._registeredTools.execute_external_tool.annotations).toMatchObject({
      readOnlyHint: false,
      openWorldHint: true,
    });
  });
});
