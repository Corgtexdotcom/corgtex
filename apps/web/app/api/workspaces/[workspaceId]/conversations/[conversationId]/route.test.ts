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
  isArtifactInputProofReadable,
  requireWorkspaceMembership,
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
  isArtifactInputProofReadable: vi.fn(),
  requireWorkspaceMembership: vi.fn(),
}));

vi.mock("@corgtex/domain", () => ({
  addConversationTurn,
  completeRoleOnboardingConversation,
  deleteConversation,
  getConversation,
  isArtifactInputProofReadable,
  requireWorkspaceMembership,
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
    titleChat.mockReset().mockResolvedValue({ content: "Generated title" });
    requireWorkspaceMembership.mockReset().mockResolvedValue({ id: "member-1" });
    resolveRequestActor.mockResolvedValue(actor);
    isArtifactInputProofReadable.mockReset().mockResolvedValue(true);
    addConversationTurn.mockResolvedValue({id: "persisted-turn-1", sequenceNumber: 1, createdAt: new Date("2026-10-14T00:00:00Z")});
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

  it.each(["before-title", "after-title"])("closes a committed response when title permission is denied %s", async (phase) => {
    getConversation.mockResolvedValue({ agentKey: "assistant", systemPrompt: null, topic: null });
    isArtifactInputProofReadable.mockResolvedValueOnce(phase === "after-title").mockResolvedValueOnce(false);
    titleChat.mockResolvedValue({ content: "Generated title" });
    async function* reply() {
      yield "Saved reply";
      return { assistantMessage: "Saved reply", contextUsed: {}, promptInputId: "prompt-1", lineageRoots: [{ kind: "PROMPT", id: "prompt-1" }] };
    }
    processConversationTurnStream.mockReturnValue(reply());
    const { POST } = await import("./route");
    const response = await POST(request() as never, routeParams());
    const body = await response.text();
    expect(body).toContain('"committedTurn":{"id":"persisted-turn-1"');
    expect(body).toContain("data: [DONE]");
    expect(addConversationTurn).toHaveBeenCalledOnce();
    expect(renameConversation).not.toHaveBeenCalled();
    expect(titleChat).toHaveBeenCalledTimes(phase === "after-title" ? 1 : 0);
  }, 2_000);

  it.each([["credentials", "lineage"], ["retry", "lineage"], ["credentials", "caller"], ["retry", "caller"]] as const)("does not send an auto-title during %s after %s revocation", async (phase, authority) => {
    getConversation.mockResolvedValue({ agentKey: "assistant", systemPrompt: null, topic: null });
    const roots = [{ kind: "ConversationPromptInput", id: "original-prompt", fingerprint: "original-fingerprint" }];
    let permitted = true;
    isArtifactInputProofReadable.mockImplementation(async (_actor, _workspaceId, proof) => {
      expect(proof).toEqual(roots);
      return authority === "lineage" ? permitted : true;
    });
    requireWorkspaceMembership.mockImplementation(async () => {
      if (authority === "caller" && !permitted) throw new Error("Caller revoked");
      return { id: "member-1" };
    });
    let sends = 0;
    titleChat.mockImplementation(async request => {
      if (phase === "retry") {
        await request.authorizeAttempt?.({ signal: request.signal });
        sends++;
      }
      // Credential acquisition / retry delay completed after authority changed.
      permitted = false;
      await request.authorizeAttempt?.({ signal: request.signal });
      sends++;
      return { content: "Must not publish" };
    });
    async function* reply() { yield "Saved reply"; return { assistantMessage: "Saved reply", contextUsed: {}, lineageRoots: roots }; }
    processConversationTurnStream.mockReturnValue(reply());
    const { POST } = await import("./route");
    const body = await (await POST(request() as never, routeParams())).text();
    expect(sends).toBe(phase === "retry" ? 1 : 0);
    expect(renameConversation).not.toHaveBeenCalled();
    expect(body).toContain('"committedTurn"');
    expect(body).toContain("data: [DONE]");
  });

  it("retains the original proof through every authorized title attempt and rename", async () => {
    getConversation.mockResolvedValue({ agentKey: "assistant", systemPrompt: null, topic: null });
    const roots = [{ kind: "ConversationPromptInput", id: "original-prompt", fingerprint: "original-fingerprint" }];
    titleChat.mockImplementation(async input => {
      expect(input.signal).toBeInstanceOf(AbortSignal);
      expect(input.messages[1]).toEqual({ role: "user", content: "Hello" });
      await input.authorizeAttempt({ signal: input.signal });
      await input.authorizeAttempt({ signal: input.signal });
      return { content: "  Original title  " };
    });
    async function* reply() { yield "Saved reply"; return { assistantMessage: "Saved reply", contextUsed: {}, lineageRoots: roots }; }
    processConversationTurnStream.mockReturnValue(reply());
    const { POST } = await import("./route");
    const body = await (await POST(request() as never, routeParams())).text();
    expect(requireWorkspaceMembership).toHaveBeenCalledTimes(2);
    expect(requireWorkspaceMembership).toHaveBeenCalledWith({ actor, workspaceId: "ws-1" });
    expect(isArtifactInputProofReadable).toHaveBeenCalledTimes(4);
    const original = isArtifactInputProofReadable.mock.calls[0][2];
    expect(original).toEqual(roots);
    expect(original).not.toBe(roots);
    for (const call of isArtifactInputProofReadable.mock.calls) expect(call[2]).toBe(original);
    expect(renameConversation).toHaveBeenCalledWith(actor, { workspaceId: "ws-1", conversationId: "conversation-1", topic: "Original title", lineageRoots: original });
    expect(body).toContain('"topic":"Original title"');
    expect(body).toContain("data: [DONE]");
  });

  it.each(["before", "during-membership", "during-lineage"] as const)("preserves title attempt cancellation %s", async phase => {
    getConversation.mockResolvedValue({ agentKey: "assistant", systemPrompt: null, topic: null });
    const attempt = new AbortController();
    let inAttempt = false;
    isArtifactInputProofReadable.mockImplementation(async () => {
      if (inAttempt && phase === "during-lineage") attempt.abort();
      return true;
    });
    requireWorkspaceMembership.mockImplementation(async () => {
      if (phase === "during-membership") attempt.abort();
      return { id: "member-1" };
    });
    let sends = 0;
    titleChat.mockImplementation(async input => {
      inAttempt = true;
      if (phase === "before") attempt.abort();
      await input.authorizeAttempt({ signal: attempt.signal });
      sends++;
      return { content: "Must not publish" };
    });
    async function* reply() { yield "Saved reply"; return { assistantMessage: "Saved reply", contextUsed: {}, lineageRoots: [{ kind: "ConversationPromptInput", id: "original" }] }; }
    processConversationTurnStream.mockReturnValue(reply());
    const { POST } = await import("./route");
    const body = await (await POST(request() as never, routeParams())).text();
    expect(sends).toBe(0);
    expect(renameConversation).not.toHaveBeenCalled();
    expect(body).toContain("data: [DONE]");
    expect(requireWorkspaceMembership).toHaveBeenCalledTimes(phase === "before" ? 0 : 1);
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
    expect(remaining).toContain('"committedTurn":{"id":"persisted-turn-1","sequenceNumber":1');
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

  it("closes the conversation stream iterator when the response body is canceled", async () => {
    const returnMock = vi.fn().mockResolvedValue({
      done: true,
      value: {
        assistantMessage: "",
        contextUsed: {},
      },
    });
    const iterator = {
      next: vi.fn(() => new Promise<IteratorResult<string, any>>(() => {})),
      return: returnMock,
      [Symbol.asyncIterator]() {
        return this;
      },
    };

    processConversationTurnStream.mockReturnValue(iterator as never);

    const { POST } = await import("./route");
    const response = await POST(request() as never, routeParams());
    const reader = response.body!.getReader();

    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(decodeChunk(first.value)).toContain("\"keepAlive\":true");

    await reader.cancel();

    expect(returnMock).toHaveBeenCalledWith({
      assistantMessage: "",
      contextUsed: {},
      lineageRoots: [],
      promptInputId: "",
    });
    const conversationContext = processConversationTurnStream.mock.calls[0]?.[0] as { signal?: AbortSignal } | undefined;
    expect(conversationContext?.signal).toBeInstanceOf(AbortSignal);
    expect(conversationContext?.signal?.aborted).toBe(true);
    expect(addConversationTurn).not.toHaveBeenCalled();
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

  it("streams and persists a clear fallback when the generator finishes blank", async () => {
    async function* blankConversationStream() {
      return {
        assistantMessage: "",
        contextUsed: { pageContext: { surface: "crm" } },
      };
    }

    processConversationTurnStream.mockReturnValue(blankConversationStream());

    const { POST } = await import("./route");
    const response = await POST(request() as never, routeParams());
    const reader = response.body!.getReader();
    const body = await readRemainingBody(reader);

    expect(body).toContain("\"keepAlive\":true");
    expect(body).toContain("The assistant did not return a response");
    expect(body).toContain("data: [DONE]");
    expect(addConversationTurn).toHaveBeenCalledWith(actor, expect.objectContaining({
      assistantMessage: expect.stringContaining("The assistant did not return a response"),
      contextJson: { pageContext: { surface: "crm" } },
    }));
  });
});
