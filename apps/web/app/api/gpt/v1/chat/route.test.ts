import { beforeEach, describe, expect, it, vi } from "vitest";

const { processConversationTurnMock, requireGptAuthMock } = vi.hoisted(() => ({
  processConversationTurnMock: vi.fn(),
  requireGptAuthMock: vi.fn(),
}));

vi.mock("@/lib/gpt-auth", () => ({
  requireGptAuth: requireGptAuthMock,
}));

vi.mock("@corgtex/agents", () => ({
  processConversationTurn: processConversationTurnMock,
}));

describe("POST /api/gpt/v1/chat", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    processConversationTurnMock.mockResolvedValue({ assistantMessage: "ok" });
  });

  it("passes the OAuth user actor into the conversation runtime", async () => {
    const actor = {
      kind: "user" as const,
      user: {
        id: "user-1",
        email: "user@example.com",
        displayName: "User",
      },
    };
    requireGptAuthMock.mockResolvedValue({
      workspaceId: "ws-1",
      actor,
      scopes: ["chat"],
    });

    const { POST } = await import("./route");
    const response = await POST(new Request("http://localhost/api/gpt/v1/chat", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer token",
      },
      body: JSON.stringify({ message: "show my tools" }),
    }) as never);

    expect(response.status).toBe(200);
    expect(processConversationTurnMock).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      sessionId: "gpt-ws-1-user-1",
      userId: "user-1",
      agentKey: "assistant",
      userMessage: "show my tools",
      actor,
    });
    await expect(response.json()).resolves.toEqual({ assistantMessage: "ok" });
  });
});
