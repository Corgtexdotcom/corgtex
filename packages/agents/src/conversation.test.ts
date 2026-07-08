import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  applyContextGraphProposedDiffMock,
  buildSelectedRegionContextMock,
  buildRoleOnboardingContextForConversationMock,
  checkBudgetMock,
  chatMock,
  completeActivityMock,
  conversationTurnFindManyMock,
  createActivityMock,
  createCommunicationSuggestionMock,
  createContextGraphProposedDiffMock,
  executeExternalMcpToolMock,
  fetchConnectedExternalMcpContextMock,
  getContextMapDataMock,
  listCrmActivitiesMock,
  listExternalMcpConnectionsMock,
  listWorkspaceToolLinksMock,
  loadRelevantMemoriesMock,
  searchConnectedExternalMcpContextMock,
  storeAgentMemoryMock,
  workspaceFeatureFlagFindManyMock,
} = vi.hoisted(() => ({
  applyContextGraphProposedDiffMock: vi.fn(),
  buildSelectedRegionContextMock: vi.fn(),
  buildRoleOnboardingContextForConversationMock: vi.fn(),
  checkBudgetMock: vi.fn(),
  chatMock: vi.fn(),
  completeActivityMock: vi.fn(),
  conversationTurnFindManyMock: vi.fn(),
  createActivityMock: vi.fn(),
  createCommunicationSuggestionMock: vi.fn(),
  createContextGraphProposedDiffMock: vi.fn(),
  executeExternalMcpToolMock: vi.fn(),
  fetchConnectedExternalMcpContextMock: vi.fn(),
  getContextMapDataMock: vi.fn(),
  listCrmActivitiesMock: vi.fn(),
  listExternalMcpConnectionsMock: vi.fn(),
  listWorkspaceToolLinksMock: vi.fn(),
  loadRelevantMemoriesMock: vi.fn(),
  searchConnectedExternalMcpContextMock: vi.fn(),
  storeAgentMemoryMock: vi.fn(),
  workspaceFeatureFlagFindManyMock: vi.fn(),
}));

vi.mock("@corgtex/shared", () => ({
  env: {
    MODEL_CHAT_CONVERSATION: "chat-model",
  },
  prisma: {
    conversationTurn: {
      findMany: conversationTurnFindManyMock,
    },
    brainArticle: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
    oAuthConnection: {
      findFirst: vi.fn(),
    },
    workspaceFeatureFlag: {
      findMany: workspaceFeatureFlagFindManyMock,
    },
  },
}));

vi.mock("@corgtex/knowledge", () => ({
  searchIndexedKnowledge: vi.fn().mockResolvedValue([]),
}));

vi.mock("@corgtex/models", () => ({
  defaultModelGateway: {
    chat: chatMock,
  },
}));

vi.mock("@corgtex/domain", () => ({
  AppError: class AppError extends Error {
    constructor(public status: number, public code: string, message: string) {
      super(message);
    }
  },
  archiveWorkspaceToolLink: vi.fn(),
  applyContextGraphProposedDiff: applyContextGraphProposedDiffMock,
  assignRole: vi.fn(),
  buildSelectedRegionContext: buildSelectedRegionContextMock,
  buildRoleOnboardingContextForConversation: buildRoleOnboardingContextForConversationMock,
  checkBudget: checkBudgetMock,
  completeActivity: completeActivityMock,
  createActivity: createActivityMock,
  createCommunicationSuggestion: createCommunicationSuggestionMock,
  createAction: vi.fn(),
  createContextGraphProposedDiff: createContextGraphProposedDiffMock,
  createGoal: vi.fn(),
  createProposal: vi.fn(),
  createTension: vi.fn(),
  executeExternalMcpTool: executeExternalMcpToolMock,
  fetchConnectedExternalMcpContext: fetchConnectedExternalMcpContextMock,
  getContextMapData: getContextMapDataMock,
  getMemberProfile: vi.fn(),
  ingestConversationOnDemand: vi.fn(),
  listCrmActivities: listCrmActivitiesMock,
  listExternalMcpConnections: listExternalMcpConnectionsMock,
  listMembersEnriched: vi.fn(),
  listWorkspaceToolLinks: listWorkspaceToolLinksMock,
  loadRelevantMemories: loadRelevantMemoriesMock,
  refreshOAuthTokenIfNeeded: vi.fn(),
  revealWorkspaceToolLinkCredential: vi.fn(),
  searchConnectedExternalMcpContext: searchConnectedExternalMcpContextMock,
  storeAgentMemory: storeAgentMemoryMock,
  unassignRole: vi.fn(),
  updateAction: vi.fn(),
  updateMember: vi.fn(),
  updateProposal: vi.fn(),
  updateTension: vi.fn(),
  upsertWorkspaceToolLink: vi.fn(),
}));

import { searchIndexedKnowledge } from "@corgtex/knowledge";

describe("processConversationTurn", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(searchIndexedKnowledge).mockReset().mockResolvedValue([]);
    checkBudgetMock.mockResolvedValue({ allowed: true, usedPct: 0, usedUsd: 0, capUsd: 5 });
    conversationTurnFindManyMock.mockResolvedValue([]);
    loadRelevantMemoriesMock.mockResolvedValue([]);
    storeAgentMemoryMock.mockResolvedValue(undefined);
    workspaceFeatureFlagFindManyMock.mockResolvedValue([]);
    createContextGraphProposedDiffMock.mockResolvedValue({ id: "diff-1", status: "pending" });
    applyContextGraphProposedDiffMock.mockResolvedValue({ id: "diff-1", status: "applied" });
    getContextMapDataMock.mockResolvedValue({
      mapView: { id: "map-1", name: "CRNA Critical Path", viewType: "process" },
      permissions: { canRead: true, canPropose: true, canApprove: true },
      objects: [
        { id: "step-1", objectType: "ProcessStep", title: "Decision to proceed", status: "approved", properties: {} },
      ],
      relationships: [],
    });
    buildSelectedRegionContextMock.mockResolvedValue({ objects: [], relationships: [], evidenceRefs: [] });
    buildRoleOnboardingContextForConversationMock.mockResolvedValue(null);
    executeExternalMcpToolMock.mockResolvedValue({ skipped: false, result: { ok: true } });
    fetchConnectedExternalMcpContextMock.mockResolvedValue({ providerKey: "notion", externalId: "page-1", content: {} });
    listCrmActivitiesMock.mockResolvedValue({ total: 1, items: [{ id: "activity-1", title: "Follow up", type: "TASK", accountId: "account-1", dueAt: new Date("2026-06-20T10:00:00.000Z"), completedAt: null }] });
    createActivityMock.mockResolvedValue({ id: "activity-1", title: "Follow up", type: "TASK", accountId: "account-1", dueAt: new Date("2026-06-20T10:00:00.000Z"), completedAt: null });
    completeActivityMock.mockResolvedValue({ id: "activity-1", title: "Follow up", type: "TASK", accountId: "account-1", completedAt: new Date("2026-06-20T11:00:00.000Z") });
    createCommunicationSuggestionMock.mockResolvedValue({ id: "suggestion-1", title: "Draft follow-up", status: "SUGGESTED", accountId: "account-1" });
    listExternalMcpConnectionsMock.mockResolvedValue([]);
    searchConnectedExternalMcpContextMock.mockResolvedValue({ results: [], errors: [] });
    listWorkspaceToolLinksMock.mockResolvedValue([
      {
        id: "tool-1",
        title: "Miro board",
        hasCredential: true,
      },
    ]);
  });

  function enableContextMapAi() {
    workspaceFeatureFlagFindManyMock.mockResolvedValue([
      { flag: "CONTEXT_MAPS", enabled: true },
      { flag: "CONTEXT_MAP_AI", enabled: true },
    ]);
  }

  it("executes chat tools with the real user actor", async () => {
    const actor = {
      kind: "user" as const,
      user: {
        id: "user-1",
        email: "user@example.com",
        displayName: "User",
      },
    };
    chatMock
      .mockResolvedValueOnce({
        content: "",
        tool_calls: [
          {
            id: "call-1",
            function: {
              name: "list_tool_links",
              arguments: "{}",
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        content: "The shared tool is Miro board.",
      });

    const { processConversationTurn } = await import("./conversation");
    const result = await processConversationTurn({
      workspaceId: "ws-1",
      sessionId: "session-1",
      userId: "user-1",
      agentKey: "assistant",
      userMessage: "What tools do we have?",
      actor,
    });

    expect(listWorkspaceToolLinksMock).toHaveBeenCalledWith(actor, { workspaceId: "ws-1" });
    expect(result.assistantMessage).toBe("The shared tool is Miro board.");
  });

  it("does not fall back to a bootstrap agent when no authenticated actor is provided", async () => {
    chatMock.mockResolvedValueOnce({
      content: "",
      tool_calls: [
        {
          id: "call-1",
          function: {
            name: "list_tool_links",
            arguments: "{}",
          },
        },
      ],
    });

    const { processConversationTurn } = await import("./conversation");

    await expect(processConversationTurn({
      workspaceId: "ws-1",
      sessionId: "session-1",
      userId: "user-1",
      agentKey: "assistant",
      userMessage: "What tools do we have?",
    })).rejects.toThrow("Authenticated actor is required");
    expect(listWorkspaceToolLinksMock).not.toHaveBeenCalled();
  });

  it("blocks model calls when the workspace budget is exhausted", async () => {
    checkBudgetMock.mockResolvedValueOnce({ allowed: false, usedPct: 100, usedUsd: 5, capUsd: 5 });

    const { processConversationTurn } = await import("./conversation");

    await expect(processConversationTurn({
      workspaceId: "ws-1",
      sessionId: "session-1",
      userId: "user-1",
      agentKey: "assistant",
      userMessage: "Can you summarize the workspace?",
    })).rejects.toMatchObject({
      status: 429,
      code: "BUDGET_EXCEEDED",
    });
    expect(chatMock).not.toHaveBeenCalled();
  });

  it("runs retrieval for short follow-up questions using recent conversation context", async () => {
    conversationTurnFindManyMock.mockResolvedValueOnce([{
      sequenceNumber: 1,
      userMessage: "Can you find the name from the meeting transcript?",
      assistantMessage: "I will check the meeting transcript for the name.",
    }]);
    vi.mocked(searchIndexedKnowledge).mockResolvedValueOnce([{
      chunkId: "chunk-1",
      sourceType: "MEETING",
      sourceId: "meeting-1",
      title: "Transcript",
      chunkIndex: 0,
      snippet: "The name mentioned was Jan.",
      score: 0.95,
    } as any]);
    chatMock.mockResolvedValueOnce({ content: "The name was Jan." });

    const { processConversationTurn } = await import("./conversation");
    const result = await processConversationTurn({
      workspaceId: "ws-1",
      sessionId: "session-1",
      userId: "user-1",
      agentKey: "assistant",
      userMessage: "any name?",
    });

    expect(searchIndexedKnowledge).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "ws-1",
      limit: 4,
      query: expect.stringContaining("Recent conversation context"),
    }));
    expect(vi.mocked(searchIndexedKnowledge).mock.calls[0]?.[0]?.query).toContain("meeting transcript");
    expect(result.contextUsed.knowledgeSearch).toMatchObject({
      hitCount: 1,
    });
    expect(chatMock).toHaveBeenCalledWith(expect.objectContaining({
      messages: expect.arrayContaining([
        expect.objectContaining({
          role: "system",
          content: expect.stringContaining("Knowledge retrieval already searched indexed workspace knowledge"),
        }),
      ]),
    }));
  });

  it("routes Slack follow-up retrieval to indexed Slack knowledge", async () => {
    conversationTurnFindManyMock.mockResolvedValueOnce([{
      sequenceNumber: 1,
      userMessage: "Who was discussed in the transcript?",
      assistantMessage: "The transcript context was inconclusive.",
    }]);
    chatMock.mockResolvedValueOnce({ content: "I did not find a Slack match." });

    const { processConversationTurn } = await import("./conversation");
    await processConversationTurn({
      workspaceId: "ws-1",
      sessionId: "session-1",
      userId: "user-1",
      agentKey: "assistant",
      userMessage: "can you check slack too",
    });

    expect(searchIndexedKnowledge).toHaveBeenCalledWith(expect.objectContaining({
      sourceTypes: ["SLACK"],
      query: expect.stringContaining("Who was discussed in the transcript?"),
    }));
    expect(chatMock).toHaveBeenCalledWith(expect.objectContaining({
      messages: expect.arrayContaining([
        expect.objectContaining({
          role: "system",
          content: expect.stringContaining("indexed public Slack knowledge"),
        }),
      ]),
    }));
  });

  it("warns the model not to claim source checks when retrieval fails", async () => {
    vi.mocked(searchIndexedKnowledge).mockRejectedValueOnce(new Error("search unavailable"));
    chatMock.mockResolvedValueOnce({ content: "I could not verify that from indexed Slack context." });

    const { processConversationTurn } = await import("./conversation");
    await processConversationTurn({
      workspaceId: "ws-1",
      sessionId: "session-1",
      userId: "user-1",
      agentKey: "assistant",
      userMessage: "can you check slack too",
    });

    expect(chatMock).toHaveBeenCalledWith(expect.objectContaining({
      messages: expect.arrayContaining([
        expect.objectContaining({
          role: "system",
          content: expect.stringContaining("Do not claim that you checked or searched that source"),
        }),
      ]),
    }));
  });

  it("guides the assistant to create proposals from tensions instead of action conversions", async () => {
    const actor = {
      kind: "user" as const,
      user: {
        id: "user-1",
        email: "user@example.com",
        displayName: "User",
      },
    };
    chatMock.mockResolvedValueOnce({ content: "I will use the tension as the source." });

    const { processConversationTurn } = await import("./conversation");
    await processConversationTurn({
      workspaceId: "ws-1",
      sessionId: "session-1",
      userId: "user-1",
      agentKey: "assistant",
      userMessage: "Turn the reimbursement tension into a proposal",
      actor,
    });

    expect(chatMock).toHaveBeenCalledWith(expect.objectContaining({
      messages: expect.arrayContaining([
        expect.objectContaining({
          role: "system",
          content: expect.stringContaining("sourceTensionId"),
        }),
      ]),
    }));
    expect(chatMock).toHaveBeenCalledWith(expect.objectContaining({
      messages: expect.arrayContaining([
        expect.objectContaining({
          role: "system",
          content: expect.stringContaining("Do not turn an action into a proposal unless the user explicitly asks"),
        }),
      ]),
    }));
    const firstCall = chatMock.mock.calls[0]?.[0];
    const toolNames = (firstCall.tools ?? []).map((tool: any) => tool.function.name);
    expect(toolNames).toEqual(expect.arrayContaining([
      "list_due_relationship_work",
      "record_relationship_activity",
      "create_communication_suggestion",
    ]));
    expect(firstCall.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: "system",
        content: expect.stringContaining("CRM write tools require explicit confirmation"),
      }),
      expect.objectContaining({
        role: "system",
        content: expect.stringContaining("must not send email directly"),
      }),
    ]));
  });

  it("injects role onboarding context for guided onboarding conversations", async () => {
    buildRoleOnboardingContextForConversationMock.mockResolvedValue("ROLE ONBOARDING CONTEXT\nRole: Integrator");
    chatMock.mockResolvedValueOnce({ content: "Welcome to the Integrator role." });

    const { processConversationTurn } = await import("./conversation");
    const result = await processConversationTurn({
      workspaceId: "ws-1",
      sessionId: "session-1",
      userId: "user-1",
      agentKey: "role-onboarding",
      userMessage: "What should I know first?",
    });

    expect(result.contextUsed.roleOnboardingContext).toContain("Integrator");
    expect(buildRoleOnboardingContextForConversationMock).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      conversationId: "session-1",
      userId: "user-1",
    });
    expect(chatMock).toHaveBeenCalledWith(expect.objectContaining({
      messages: expect.arrayContaining([
        expect.objectContaining({
          role: "system",
          content: expect.stringContaining("ROLE ONBOARDING CONTEXT"),
        }),
      ]),
    }));
  });

  it("exposes connected external MCP tools to the assistant", async () => {
    const actor = {
      kind: "user" as const,
      user: {
        id: "user-1",
        email: "user@example.com",
        displayName: "User",
      },
    };
    chatMock.mockResolvedValueOnce({ content: "I can search Notion live." });

    const { processConversationTurn } = await import("./conversation");
    await processConversationTurn({
      workspaceId: "ws-1",
      sessionId: "session-1",
      userId: "user-1",
      agentKey: "assistant",
      userMessage: "Find the customer rollout notes in Notion",
      actor,
    });

    expect(chatMock).toHaveBeenCalledWith(expect.objectContaining({
      tools: expect.arrayContaining([
        expect.objectContaining({
          function: expect.objectContaining({ name: "list_connected_tools" }),
        }),
        expect.objectContaining({
          function: expect.objectContaining({ name: "search_connected_context" }),
        }),
        expect.objectContaining({
          function: expect.objectContaining({ name: "fetch_connected_context" }),
        }),
        expect.objectContaining({
          function: expect.objectContaining({ name: "execute_external_tool" }),
        }),
      ]),
      messages: expect.arrayContaining([
        expect.objectContaining({
          role: "system",
          content: expect.stringContaining("Use live retrieval from connected tools first"),
        }),
      ]),
    }));
  });

  it("adds sanitized context map page context without changing the visible user message", async () => {
    const actor = {
      kind: "user" as const,
      user: {
        id: "user-1",
        email: "user@example.com",
        displayName: "User",
      },
    };
    chatMock.mockResolvedValueOnce({ content: "I know which map you are viewing." });

    const { processConversationTurn } = await import("./conversation");
    await processConversationTurn({
      workspaceId: "ws-1",
      sessionId: "session-1",
      userId: "user-1",
      agentKey: "assistant",
      userMessage: "yes, do it",
      actor,
      pageContext: {
        surface: "context-map",
        route: "/workspaces/ws-1/maps?view=map-1",
        mapView: { id: "map-1", name: "CRNA Critical Path", viewType: "process" },
        includeStale: false,
        selectedObjectIds: ["step-1"],
        selectedObjects: [{ id: "step-1", title: "Decision to proceed", objectType: "ProcessStep", status: "approved" }],
        selectedRelationship: null,
      },
    });

    expect(chatMock).toHaveBeenCalledWith(expect.objectContaining({
      messages: expect.arrayContaining([
        expect.objectContaining({
          role: "system",
          content: expect.stringContaining("CURRENT PAGE CONTEXT"),
        }),
        expect.objectContaining({
          role: "user",
          content: "yes, do it",
        }),
      ]),
    }));
  });

  it("sanitizes context map page context before model use", async () => {
    const { sanitizeConversationPageContext } = await import("./page-context");
    const context = sanitizeConversationPageContext({
      surface: "context-map",
      route: `/workspaces/ws-1/maps?${"x".repeat(400)}`,
      mapView: { id: "map-1", name: "CRNA Critical Path", viewType: "process" },
      selectedObjectIds: Array.from({ length: 20 }, (_, index) => `step-${index}`),
      selectedObjects: [{
        id: "step-1",
        title: "Decision to proceed",
        objectType: "ProcessStep",
        status: "approved",
        summary: "This should not be carried into page context.",
      }],
      selectedRelationship: null,
    });

    expect(context?.route?.length).toBe(240);
    expect(context?.surface).toBe("context-map");
    if (context?.surface !== "context-map") throw new Error("Expected context map context");
    expect(context?.selectedObjectIds).toHaveLength(12);
    expect(context?.selectedObjects[0]).toEqual({
      id: "step-1",
      title: "Decision to proceed",
      objectType: "ProcessStep",
      status: "approved",
    });
  });

  it("adds sanitized CRM page context without changing the visible user message", async () => {
    const actor = {
      kind: "user" as const,
      user: {
        id: "user-1",
        email: "user@example.com",
        displayName: "User",
      },
    };
    chatMock.mockResolvedValueOnce({ content: "You are viewing the Acme account." });

    const { processConversationTurn } = await import("./conversation");
    await processConversationTurn({
      workspaceId: "ws-1",
      sessionId: "session-1",
      userId: "user-1",
      agentKey: "assistant",
      userMessage: "What CRM account am I viewing?",
      actor,
      pageContext: {
        surface: "crm",
        route: "/workspaces/ws-1/leads/accounts/account-1",
        workspaceId: "ws-1",
        view: "account-detail",
        section: "overview",
        selectedIds: { accountId: "account-1", contactId: null, dealId: null, activityId: null, suggestionId: null },
        filters: { view: "overview" },
        pagination: { page: null, pageCount: null, total: null },
        visibleContext: {
          metrics: [{ label: "activeDeals", value: "2", detail: null }],
          accounts: [{
            id: "account-1",
            name: "Acme",
            domain: "acme.test",
            relationshipType: "CLIENT",
            lifecycleStage: "ACTIVE",
            webUrl: "/workspaces/ws-1/leads/accounts/account-1",
          }],
          contacts: [],
          deals: [],
          activities: [],
          suggestions: [],
        },
      },
    });

    expect(chatMock).toHaveBeenCalledWith(expect.objectContaining({
      messages: expect.arrayContaining([
        expect.objectContaining({
          role: "system",
          content: expect.stringContaining("user-visible CRM state"),
        }),
        expect.objectContaining({
          role: "system",
          content: expect.stringContaining('"accountId": "account-1"'),
        }),
        expect.objectContaining({
          role: "user",
          content: "What CRM account am I viewing?",
        }),
      ]),
    }));
  });

  it("sanitizes CRM page context before model use", async () => {
    const { sanitizeConversationPageContext } = await import("./page-context");
    const context = sanitizeConversationPageContext({
      surface: "crm",
      route: `/workspaces/ws-1/leads/accounts/account-1?${"x".repeat(400)}`,
      workspaceId: "ws-1",
      view: "account-detail",
      section: "overview",
      selectedIds: {
        accountId: "account-1",
        ignoredId: "should-not-pass",
      },
      filters: Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`filter-${index}`, `value-${index}`])),
      pagination: { page: "2", pageCount: 5, total: 80 },
      visibleContext: {
        accounts: Array.from({ length: 20 }, (_, index) => ({
          id: `account-${index}`,
          name: `Account ${index}`,
          domain: "example.test",
          bodyMd: "Do not pass descriptions.",
        })),
        suggestions: [{
          id: "suggestion-1",
          title: "Follow up",
          status: "SUGGESTED",
          bodyMd: "Do not pass draft bodies.",
          recipientEmail: "lead@example.test",
        }],
      },
      unsafe: "do not pass",
    });

    expect(context?.surface).toBe("crm");
    if (context?.surface !== "crm") throw new Error("Expected CRM context");
    expect(context.route?.length).toBe(240);
    expect(Object.keys(context.filters)).toHaveLength(12);
    expect(context.selectedIds).toEqual({
      accountId: "account-1",
      contactId: null,
      dealId: null,
      activityId: null,
      suggestionId: null,
    });
    expect(context.pagination).toEqual({ page: 2, pageCount: 5, total: 80 });
    expect(context.visibleContext.accounts).toHaveLength(12);
    expect(context.visibleContext.accounts[0]).toMatchObject({
      id: "account-0",
      name: "Account 0",
      domain: "example.test",
    });
    expect(context.visibleContext.suggestions[0]).toMatchObject({
      id: "suggestion-1",
      title: "Follow up",
      status: "SUGGESTED",
      recipientEmail: "lead@example.test",
    });
    expect(JSON.stringify(context)).not.toContain("bodyMd");
    expect(JSON.stringify(context)).not.toContain("unsafe");
  });

  it("blocks CRM write tool calls until the user explicitly confirms", async () => {
    const actor = {
      kind: "user" as const,
      user: {
        id: "user-1",
        email: "user@example.com",
        displayName: "User",
      },
    };
    chatMock
      .mockResolvedValueOnce({
        content: "",
        tool_calls: [{
          id: "call-1",
          function: {
            name: "record_relationship_activity",
            arguments: JSON.stringify({ title: "Follow up", type: "TASK", accountId: "account-1" }),
          },
        }],
      })
      .mockResolvedValueOnce({ content: "Please confirm before I create that CRM follow-up." });

    const { processConversationTurn } = await import("./conversation");
    const result = await processConversationTurn({
      workspaceId: "ws-1",
      sessionId: "session-1",
      userId: "user-1",
      agentKey: "assistant",
      userMessage: "Create a CRM follow-up for Acme.",
      actor,
    });

    const toolMessage = chatMock.mock.calls[1]?.[0]?.messages.find((message: any) => message.role === "tool");
    expect(toolMessage.content).toContain("CRM_WRITE_REQUIRES_CONFIRMATION");
    expect(createActivityMock).not.toHaveBeenCalled();
    expect(result.assistantMessage).toBe("Please confirm before I create that CRM follow-up.");
  });

  it("executes confirmed CRM writes through the same domain behavior", async () => {
    conversationTurnFindManyMock.mockResolvedValueOnce([{
      sequenceNumber: 1,
      userMessage: "Create a CRM follow-up for Acme.",
      assistantMessage: "I can create a CRM follow-up for Acme. Please confirm before I write it.",
    }]);
    const actor = {
      kind: "user" as const,
      user: {
        id: "user-1",
        email: "user@example.com",
        displayName: "User",
      },
    };
    chatMock
      .mockResolvedValueOnce({
        content: "",
        tool_calls: [{
          id: "call-1",
          function: {
            name: "record_relationship_activity",
            arguments: JSON.stringify({
              title: "Follow up",
              type: "TASK",
              accountId: "account-1",
              dueAt: "2026-06-20T10:00:00.000Z",
            }),
          },
        }],
      })
      .mockResolvedValueOnce({ content: "Created the CRM follow-up." });

    const { processConversationTurn } = await import("./conversation");
    const result = await processConversationTurn({
      workspaceId: "ws-1",
      sessionId: "session-1",
      userId: "user-1",
      agentKey: "assistant",
      userMessage: "yes, do it",
      actor,
    });

    expect(createActivityMock).toHaveBeenCalledWith(actor, expect.objectContaining({
      workspaceId: "ws-1",
      title: "Follow up",
      type: "TASK",
      accountId: "account-1",
      source: "workspace-chat",
      dueAt: new Date("2026-06-20T10:00:00.000Z"),
    }));
    const toolMessage = chatMock.mock.calls[1]?.[0]?.messages.find((message: any) => message.role === "tool");
    expect(toolMessage.content).toContain("\"success\":true");
    expect(result.assistantMessage).toBe("Created the CRM follow-up.");
  });

  it("does not expose context map tools when the premium AI flag is disabled", async () => {
    const actor = {
      kind: "user" as const,
      user: {
        id: "user-1",
        email: "user@example.com",
        displayName: "User",
      },
    };
    chatMock.mockResolvedValueOnce({ content: "Context map AI is not enabled." });

    const { processConversationTurn } = await import("./conversation");
    await processConversationTurn({
      workspaceId: "ws-1",
      sessionId: "session-1",
      userId: "user-1",
      agentKey: "assistant",
      userMessage: "Update this map",
      actor,
    });

    const tools = chatMock.mock.calls[0]?.[0]?.tools ?? [];
    const toolNames = tools.map((tool: any) => tool.function.name);
    expect(toolNames).not.toContain("get_context_map_info");
    expect(toolNames).not.toContain("apply_context_map_diff");
  });

  it("exposes context map tools and merge guidance when the premium AI flag is enabled", async () => {
    enableContextMapAi();
    const actor = {
      kind: "user" as const,
      user: {
        id: "user-1",
        email: "user@example.com",
        displayName: "User",
      },
    };
    chatMock.mockResolvedValueOnce({ content: "I can work with this map." });

    const { processConversationTurn } = await import("./conversation");
    await processConversationTurn({
      workspaceId: "ws-1",
      sessionId: "session-1",
      userId: "user-1",
      agentKey: "assistant",
      userMessage: "Merge these two process steps",
      actor,
    });

    const firstCall = chatMock.mock.calls[0]?.[0];
    const toolNames = (firstCall.tools ?? []).map((tool: any) => tool.function.name);
    expect(toolNames).toContain("get_context_map_info");
    expect(toolNames).toContain("apply_context_map_diff");
    expect(firstCall.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: "system",
        content: expect.stringContaining("For merge requests, ask which item survives if unclear"),
      }),
    ]));
  });

  it("applies context map diffs through the audited proposed-diff path", async () => {
    enableContextMapAi();
    const actor = {
      kind: "user" as const,
      user: {
        id: "user-1",
        email: "user@example.com",
        displayName: "User",
      },
    };
    chatMock
      .mockResolvedValueOnce({
        content: "",
        tool_calls: [{
          id: "call-1",
          function: {
            name: "apply_context_map_diff",
            arguments: JSON.stringify({
              reason: "Merge duplicate steps",
              diff: {
                objectUpdates: [
                  { id: "step-1", title: "Decision to proceed" },
                  { id: "step-2", status: "archived" },
                ],
              },
              evidence: {
                kind: "forged",
                pageContext: { unsafe: true },
              },
            }),
          },
        }],
      })
      .mockResolvedValueOnce({ content: "Applied the map change." });

    const { processConversationTurn } = await import("./conversation");
    const result = await processConversationTurn({
      workspaceId: "ws-1",
      sessionId: "session-1",
      userId: "user-1",
      agentKey: "assistant",
      userMessage: "yes, do it",
      actor,
    });

    expect(createContextGraphProposedDiffMock).toHaveBeenCalledWith(actor, expect.objectContaining({
      workspaceId: "ws-1",
      reason: "Merge duplicate steps",
      diff: expect.objectContaining({
        objectUpdates: expect.any(Array),
      }),
      evidence: expect.objectContaining({
        kind: "context-map-chat",
        pageContext: null,
      }),
    }));
    expect(applyContextGraphProposedDiffMock).toHaveBeenCalledWith(actor, {
      workspaceId: "ws-1",
      proposedDiffId: "diff-1",
    });
    expect(result.assistantMessage).toBe("Applied the map change.");
    expect(result.contextUsed.mapGraphChanged).toBe(true);
  });

  it("leaves a pending context map diff when direct apply lacks approval permission", async () => {
    enableContextMapAi();
    applyContextGraphProposedDiffMock.mockRejectedValueOnce(Object.assign(new Error("Forbidden"), {
      status: 403,
      code: "FORBIDDEN",
    }));
    const actor = {
      kind: "user" as const,
      user: {
        id: "user-1",
        email: "user@example.com",
        displayName: "User",
      },
    };
    chatMock
      .mockResolvedValueOnce({
        content: "",
        tool_calls: [{
          id: "call-1",
          function: {
            name: "apply_context_map_diff",
            arguments: JSON.stringify({
              diff: {
                objectUpdates: [{ id: "step-1", title: "Decision to proceed" }],
              },
            }),
          },
        }],
      })
      .mockResolvedValueOnce({ content: "I created a pending change for approval." });

    const { processConversationTurn } = await import("./conversation");
    const result = await processConversationTurn({
      workspaceId: "ws-1",
      sessionId: "session-1",
      userId: "user-1",
      agentKey: "assistant",
      userMessage: "do it",
      actor,
    });

    const toolMessage = chatMock.mock.calls[1]?.[0]?.messages.find((message: any) => message.role === "tool");
    expect(toolMessage.content).toContain("approval_required");
    expect(createContextGraphProposedDiffMock).toHaveBeenCalled();
    expect(result.contextUsed.mapGraphChanged).toBe(true);
  });

  it("rechecks budget before a tool-followup model call", async () => {
    const actor = {
      kind: "user" as const,
      user: {
        id: "user-1",
        email: "user@example.com",
        displayName: "User",
      },
    };
    checkBudgetMock
      .mockResolvedValueOnce({ allowed: true, usedPct: 80, usedUsd: 4, capUsd: 5 })
      .mockResolvedValueOnce({ allowed: false, usedPct: 100, usedUsd: 5, capUsd: 5 });
    chatMock.mockResolvedValueOnce({
      content: "",
      tool_calls: [
        {
          id: "call-1",
          function: {
            name: "list_tool_links",
            arguments: "{}",
          },
        },
      ],
    });

    const { processConversationTurn } = await import("./conversation");

    await expect(processConversationTurn({
      workspaceId: "ws-1",
      sessionId: "session-1",
      userId: "user-1",
      agentKey: "assistant",
      userMessage: "What tools do we have?",
      actor,
    })).rejects.toMatchObject({
      status: 429,
      code: "BUDGET_EXCEEDED",
    });
    expect(chatMock).toHaveBeenCalledTimes(1);
    expect(listWorkspaceToolLinksMock).toHaveBeenCalledWith(actor, { workspaceId: "ws-1" });
  });
});
