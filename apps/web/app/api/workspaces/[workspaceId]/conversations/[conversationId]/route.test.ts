import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  addConversationTurn,
  completeRoleOnboardingConversation,
  deleteConversation,
  getConversation,
  handleRouteError,
  processConversationTurnStream,
  renameConversation,
  resolveRequestActor,
  titleChat,
} = vi.hoisted(() => ({
  addConversationTurn: vi.fn(),
  completeRoleOnboardingConversation: vi.fn(),
  deleteConversation: vi.fn(),
  getConversation: vi.fn(),
  handleRouteError: vi.fn(),
  processConversationTurnStream: vi.fn(),
  renameConversation: vi.fn(),
  resolveRequestActor: vi.fn(),
  titleChat: vi.fn(),
}));

vi.mock("@corgtex/domain", () => ({
  addConversationTurn,
  completeRoleOnboardingConversation,
  deleteConversation,
  getConversation,
  renameConversation,
}));

vi.mock("@corgtex/agents", () => ({
  processConversationTurnStream,
  sanitizeConversationPageContext: (value: unknown) => value,
}));

vi.mock("@corgtex/models", () => ({
  defaultModelGateway: {
    chat: titleChat,
  },
}));

vi.mock("@/lib/auth", () => ({
  resolveRequestActor,
}));

vi.mock("@/lib/http", () => ({
  handleRouteError,
}));

const actor = {
  kind: "user" as const,
  user: {
    id: "user-1",
    email: "user@example.com",
    displayName: "User",
  },
};

function request(body: Record<string, unknown> = { message: "Hello" }) {
  return new Request("http://localhost/api/workspaces/ws-1/conversations/conversation-1", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function routeParams() {
  return {
    params: Promise.resolve({
      workspaceId: "ws-1",
      conversationId: "conversation-1",
    }),
  };
}

function decodeChunk(value: Uint8Array | undefined) {
  return new TextDecoder().decode(value);
}

async function readRemainingBody(reader: ReadableStreamDefaultReader<Uint8Array>) {
  let body = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) return body;
    body += decodeChunk(value);
  }
}

describe("POST /api/workspaces/[workspaceId]/conversations/[conversationId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveRequestActor.mockResolvedValue(actor);
    getConversation.mockResolvedValue({
      agentKey: "assistant",
      systemPrompt: null,
      topic: "Existing topic",
    });
    handleRouteError.mockImplementation((error: unknown) => Response.json({ error: String(error) }, { status: 500 }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("flushes keepalive frames while waiting for the first assistant chunk", async () => {
    vi.useFakeTimers();
    let releaseStream!: () => void;

    async function* delayedConversationStream() {
      await new Promise<void>((resolve) => {
        releaseStream = resolve;
      });
      yield "Assistant reply";
      return {
        assistantMessage: "Assistant reply",
        contextUsed: {},
      };
    }

    processConversationTurnStream.mockReturnValue(delayedConversationStream());

    const { POST } = await import("./route");
    const response = await POST(request() as never, routeParams());

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.body).toBeTruthy();

    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(decodeChunk(first.value)).toContain("\"keepAlive\":true");
    expect(addConversationTurn).not.toHaveBeenCalled();

    const secondRead = reader.read();
    await vi.advanceTimersByTimeAsync(10_000);
    const second = await secondRead;
    expect(second.done).toBe(false);
    expect(decodeChunk(second.value)).toContain("\"keepAlive\":true");

    releaseStream();
    const remaining = await readRemainingBody(reader);
    expect(remaining).toContain("Assistant reply");
    expect(remaining).toContain("data: [DONE]");
    expect(addConversationTurn).toHaveBeenCalledWith(actor, expect.objectContaining({
      workspaceId: "ws-1",
      conversationId: "conversation-1",
      userMessage: "Hello",
      assistantMessage: "Assistant reply",
    }));
  });

  it("clears keepalive timers when assistant chunks arrive before the interval", async () => {
    const clearTimeoutSpy = vi.spyOn(global, "clearTimeout");

    async function* immediateConversationStream() {
      yield "Fast reply";
      return {
        assistantMessage: "Fast reply",
        contextUsed: {},
      };
    }

    processConversationTurnStream.mockReturnValue(immediateConversationStream());

    const { POST } = await import("./route");
    const response = await POST(request() as never, routeParams());
    const reader = response.body!.getReader();
    const body = await readRemainingBody(reader);

    expect(body).toContain("\"keepAlive\":true");
    expect(body).toContain("Fast reply");
    expect(clearTimeoutSpy).toHaveBeenCalled();

    clearTimeoutSpy.mockRestore();
  });

  it("streams final assistant text when the generator returns without chunks", async () => {
    async function* finalOnlyConversationStream() {
      return {
        assistantMessage: "Final assistant reply",
        contextUsed: {},
      };
    }

    processConversationTurnStream.mockReturnValue(finalOnlyConversationStream());

    const { POST } = await import("./route");
    const response = await POST(request() as never, routeParams());
    const reader = response.body!.getReader();
    const body = await readRemainingBody(reader);

    expect(body).toContain("\"keepAlive\":true");
    expect(body).toContain("Final assistant reply");
    expect(body).toContain("data: [DONE]");
    expect(addConversationTurn).toHaveBeenCalledWith(actor, expect.objectContaining({
      assistantMessage: "Final assistant reply",
    }));
  });
});
