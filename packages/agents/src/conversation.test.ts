import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  applyContextGraphProposedDiffMock,
  buildSelectedRegionContextMock,
  checkBudgetMock,
  chatMock,
  createContextGraphProposedDiffMock,
  executeExternalMcpToolMock,
  fetchConnectedExternalMcpContextMock,
  getContextMapDataMock,
  listExternalMcpConnectionsMock,
  listWorkspaceToolLinksMock,
  loadRelevantMemoriesMock,
  searchConnectedExternalMcpContextMock,
  storeAgentMemoryMock,
  workspaceFeatureFlagFindManyMock,
} = vi.hoisted(() => ({
  applyContextGraphProposedDiffMock: vi.fn(),
  buildSelectedRegionContextMock: vi.fn(),
  checkBudgetMock: vi.fn(),
  chatMock: vi.fn(),
  createContextGraphProposedDiffMock: vi.fn(),
  executeExternalMcpToolMock: vi.fn(),
  fetchConnectedExternalMcpContextMock: vi.fn(),
  getContextMapDataMock: vi.fn(),
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
      findMany: vi.fn().mockResolvedValue([]),
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
  checkBudget: checkBudgetMock,
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

describe("processConversationTurn", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    checkBudgetMock.mockResolvedValue({ allowed: true, usedPct: 0, usedUsd: 0, capUsd: 5 });
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
    executeExternalMcpToolMock.mockResolvedValue({ skipped: false, result: { ok: true } });
    fetchConnectedExternalMcpContextMock.mockResolvedValue({ providerKey: "notion", externalId: "page-1", content: {} });
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
    expect(context?.selectedObjectIds).toHaveLength(12);
    expect(context?.selectedObjects[0]).toEqual({
      id: "step-1",
      title: "Decision to proceed",
      objectType: "ProcessStep",
      status: "approved",
    });
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
    }));
    expect(applyContextGraphProposedDiffMock).toHaveBeenCalledWith(actor, {
      workspaceId: "ws-1",
      proposedDiffId: "diff-1",
    });
    expect(result.assistantMessage).toBe("Applied the map change.");
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
    await processConversationTurn({
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
