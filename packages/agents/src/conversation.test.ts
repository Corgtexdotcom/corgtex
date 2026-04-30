import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  chatMock,
  listWorkspaceToolLinksMock,
  loadRelevantMemoriesMock,
  storeAgentMemoryMock,
} = vi.hoisted(() => ({
  chatMock: vi.fn(),
  listWorkspaceToolLinksMock: vi.fn(),
  loadRelevantMemoriesMock: vi.fn(),
  storeAgentMemoryMock: vi.fn(),
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
  archiveWorkspaceToolLink: vi.fn(),
  assignRole: vi.fn(),
  createAction: vi.fn(),
  createGoal: vi.fn(),
  createProposal: vi.fn(),
  createTension: vi.fn(),
  getMemberProfile: vi.fn(),
  ingestConversationOnDemand: vi.fn(),
  listMembersEnriched: vi.fn(),
  listWorkspaceToolLinks: listWorkspaceToolLinksMock,
  loadRelevantMemories: loadRelevantMemoriesMock,
  refreshOAuthTokenIfNeeded: vi.fn(),
  revealWorkspaceToolLinkCredential: vi.fn(),
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
    loadRelevantMemoriesMock.mockResolvedValue([]);
    storeAgentMemoryMock.mockResolvedValue(undefined);
    listWorkspaceToolLinksMock.mockResolvedValue([
      {
        id: "tool-1",
        title: "Miro board",
        hasCredential: true,
      },
    ]);
  });

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
});
