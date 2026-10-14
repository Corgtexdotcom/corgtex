import { describe, expect, it, vi } from "vitest";
import type { ChatCompletionResponse } from "@corgtex/models";
import { callAssistantGateway } from "./gateway-node";
import { AssistantHarnessError } from "./contracts";
import type { AssistantDeliveryPort, AssistantEvent, AssistantGateway, AssistantRuntime } from "./contracts";

const response: ChatCompletionResponse = { content: "First second", usage: { provider: "scripted", model: "scripted", inputTokens: 1, outputTokens: 2 } };

/** Synthetic transport authority. No DB, socket, provider request or production guarantee. */
function fixture() {
  const controller = new AbortController();
  const connection = { workspaceId: "workspace-a", userId: "user-a", conversationId: "conversation-a", attached: true };
  const sources = [{ kind: "brain" as const, id: "brain-a" }, { kind: "meeting" as const, id: "meeting-a" }];
  const grants = new Map([["workspace-a:user-a:conversation-a", new Set(["brain:brain-a", "meeting:meeting-a"])]]);
  const sent: AssistantEvent[] = [];
  const cleanup = vi.fn();
  let durableCancelled = false;
  let claimOwner = "worker-a";
  let beforeDelta: (index: number) => void = () => {};
  let beforeHandoff: () => Promise<void> = async () => {};
  const runtime: AssistantRuntime = {
    scope: { workspaceId: "workspace-a", userId: "user-a", conversationId: "conversation-a", runId: "run-a", policyVersion: "policy-a", job: { id: "job-a", owner: "worker-a", attempt: 1 } },
    actor: { kind: "user", user: { id: "user-a", email: "fixture@example.test", displayName: "Fixture" } },
    signal: controller.signal,
    authorize: vi.fn<AssistantRuntime["authorize"]>(async (_operation, refs) => {
      if (durableCancelled) throw new AssistantHarnessError("CANCELLED");
      if (runtime.scope.job.owner !== claimOwner) throw new AssistantHarnessError("SCOPE");
      const allowed = grants.get(`${runtime.scope.workspaceId}:${runtime.scope.userId}:${runtime.scope.conversationId}`);
      if (refs.some(source => !allowed?.has(`${source.kind}:${source.id}`))) throw new AssistantHarnessError("SCOPE");
    }),
    reserveDispatch: vi.fn(async () => {}),
    delivery: {
      audience: { workspaceId: connection.workspaceId, userId: connection.userId, conversationId: connection.conversationId },
      deliver: vi.fn<AssistantDeliveryPort["deliver"]>(async (context, event) => {
        await beforeHandoff();
        // Check the ACTUAL connection and current grants at synthetic handoff, with
        // no await between this decision and enqueue. A real adapter must serialize
        // this boundary with authoritative revocation, not copy this in-memory fixture.
        if (context.signal.aborted) throw new AssistantHarnessError("CANCELLED");
        if (!connection.attached) return "DETACHED";
        if (connection.workspaceId !== context.scope.workspaceId || connection.userId !== context.scope.userId ||
            connection.conversationId !== context.scope.conversationId || context.actor.user.id !== connection.userId) return "DENIED";
        const allowed = grants.get(`${connection.workspaceId}:${connection.userId}:${connection.conversationId}`);
        if (!allowed || context.sources.some(source => !allowed.has(`${source.kind}:${source.id}`))) return "DENIED";
        sent.push(event);
        return "DELIVERED";
      }),
    },
  };
  const gateway: AssistantGateway = {
    chat: vi.fn(async () => response),
    chatEventStream: vi.fn<AssistantGateway["chatEventStream"]>(async function* (request) {
      expect(request.signal).toBe(controller.signal);
      try {
        yield { type: "tool_call_delta" as const, index: 0, argumentsDelta: "never a client event" };
        for (const [index, content] of ["First ", "second"].entries()) {
          beforeDelta(index);
          yield { type: "content_delta" as const, content };
        }
        return response;
      } finally { cleanup(); }
    }),
  };
  return {
    runtime, sources, gateway, sent, cleanup, controller, connection,
    beforeDelta: (callback: typeof beforeDelta) => { beforeDelta = callback; },
    beforeHandoff: (callback: typeof beforeHandoff) => { beforeHandoff = callback; },
    revoke: () => { grants.get("workspace-a:user-a:conversation-a")!.delete("meeting:meeting-a"); },
    cancelDurably: () => { durableCancelled = true; },
    loseClaim: () => { claimOwner = "worker-b"; },
    run: (stream = true) => callAssistantGateway({ gateway, runtime, sources, request: { messages: [{ role: "user", content: "Synthetic question" }, { role: "tool", content: "SYNTHETIC_PRIVATE_SAVED_EVIDENCE", tool_call_id: "source-read" }] }, maximumCalls: 2, maximumBytes: 4096, stream }),
  };
}

describe("assistant stream delivery authority", () => {

  it.each(["SCOPE", "LIMIT"] as const)("preserves %s when generator cleanup also fails", async code => {
    const f = fixture();
    vi.mocked(f.gateway.chatEventStream).mockImplementation(async function* () {
      try {
        if (code === "LIMIT") yield { type: "content_delta", content: "x".repeat(5000) };
        else yield { type: "content_delta", content: "Denied" };
        return response;
      } finally { f.cleanup(); throw new Error("private cleanup failure"); }
    });
    if (code === "SCOPE") f.beforeHandoff(async () => { throw new AssistantHarnessError("SCOPE"); });
    await expect(f.run()).rejects.toThrow(code);
    expect(f.cleanup).toHaveBeenCalledTimes(1);
    expect(f.sent).toEqual([]);
    expect(f.runtime.reserveDispatch).toHaveBeenCalledTimes(1);
  });

  it.each([1, 1000])("accepts the same bounded content streamed in chunks of %i characters", async chunkSize => {
    const f = fixture();
    const content = "a".repeat(1000);
    const completed = { ...response, content };
    vi.mocked(f.gateway.chatEventStream).mockImplementation(async function* () {
      try {
        for (let offset = 0; offset < content.length; offset += chunkSize) {
          yield { type: "content_delta", content: content.slice(offset, offset + chunkSize) };
        }
        return completed;
      } finally { f.cleanup(); }
    });
    await expect(callAssistantGateway({ gateway: f.gateway, runtime: f.runtime, sources: f.sources,
      request: { messages: [{ role: "user", content: "Question" }] }, maximumCalls: 2, maximumBytes: 1500, stream: true,
    })).resolves.toEqual(completed);
    expect(f.sent.map(event => event.type === "content_delta" ? event.content : "").join("")).toBe(content);
    expect(f.cleanup).toHaveBeenCalledTimes(1);
  });

  it.each([1, 1000])("counts tool argument payload rather than envelopes for chunks of %i characters", async chunkSize => {
    const f = fixture();
    const args = JSON.stringify({ value: "a".repeat(1000) });
    const completed: ChatCompletionResponse = { ...response, content: "", tool_calls: [{ id: "call-a", type: "function", function: { name: "read_brain", arguments: args } }] };
    vi.mocked(f.gateway.chatEventStream).mockImplementation(async function* () {
      try {
        yield { type: "tool_call_delta", index: 0, idDelta: "call-a", nameDelta: "read_brain", argumentsDelta: "" };
        for (let offset = 0; offset < args.length; offset += chunkSize) {
          yield { type: "tool_call_delta", index: 0, argumentsDelta: args.slice(offset, offset + chunkSize) };
        }
        return completed;
      } finally { f.cleanup(); }
    });
    await expect(callAssistantGateway({ gateway: f.gateway, runtime: f.runtime, sources: f.sources,
      request: { messages: [{ role: "user", content: "Question" }] }, maximumCalls: 2, maximumBytes: 1500, stream: true,
    })).resolves.toEqual(completed);
    expect(f.sent).toEqual([]);
    expect(f.cleanup).toHaveBeenCalledTimes(1);
  });

  it("bounds empty stream events independently of their payload size", async () => {
    const f = fixture();
    vi.mocked(f.gateway.chatEventStream).mockImplementation(async function* () {
      try {
        while (true) yield { type: "tool_call_delta", index: 0, argumentsDelta: "" };
      } finally { f.cleanup(); }
    });
    await expect(callAssistantGateway({ gateway: f.gateway, runtime: f.runtime, sources: f.sources,
      request: { messages: [{ role: "user", content: "Question" }] }, maximumCalls: 2, maximumBytes: 1500, stream: true,
    })).rejects.toThrow("LIMIT");
    expect(f.sent).toEqual([]);
    expect(f.cleanup).toHaveBeenCalledTimes(1);
  });

  it.each([false, true].flatMap(stream => ["source", "durable-cancel", "claim"].map(change => ({ stream, change }))))("blocks $change during reservation before stream=$stream dispatch", async ({ stream, change }) => {
    const f = fixture();
    let entered!: () => void;
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    let reserved = 0;
    vi.mocked(f.runtime.reserveDispatch).mockImplementation(async () => { reserved++; entered(); await gate; });
    const operation = f.run(stream);
    await waiting;
    if (change === "source") f.revoke();
    else if (change === "durable-cancel") f.cancelDurably();
    else f.loseClaim();
    release();
    await expect(operation).rejects.toThrow(change === "durable-cancel" ? "CANCELLED" : "SCOPE");
    expect(f.gateway.chat).not.toHaveBeenCalled();
    expect(f.gateway.chatEventStream).not.toHaveBeenCalled();
    expect(f.sent).toEqual([]);
    expect(reserved).toBe(1); // A denied reservation is not refunded or billed by this harness.
    expect(f.cleanup).not.toHaveBeenCalled(); // No generator was opened.
  });

  it.each([false, true])("fails closed on unknown authority after reservation for stream=%s", async stream => {
    const f = fixture();
    vi.mocked(f.runtime.authorize).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("private authorization backend detail"));
    await expect(f.run(stream)).rejects.toThrow(/^Assistant harness: SCOPE$/);
    expect(f.runtime.reserveDispatch).toHaveBeenCalledTimes(1);
    expect(f.gateway.chat).not.toHaveBeenCalled();
    expect(f.gateway.chatEventStream).not.toHaveBeenCalled();
  });

  it("reauthorizes a new harness invocation after a failed gateway call", async () => {
    const f = fixture();
    vi.mocked(f.gateway.chat).mockRejectedValueOnce(new Error("provider failure"));
    await expect(f.run(false)).rejects.toThrow("UNAVAILABLE");
    f.revoke();
    await expect(f.run(false)).rejects.toThrow("SCOPE");
    expect(f.gateway.chat).toHaveBeenCalledTimes(1);
    expect(f.runtime.reserveDispatch).toHaveBeenCalledTimes(1);
  });

  it("keeps a normal nonstreaming invocation to one reservation and one gateway call", async () => {
    const f = fixture();
    await expect(f.run(false)).resolves.toEqual(response);
    expect(f.runtime.reserveDispatch).toHaveBeenCalledTimes(1);
    expect(f.gateway.chat).toHaveBeenCalledTimes(1);
  });

  it("delivers multiple deltas with exact personal authority and all prompt sources", async () => {
    const f = fixture();
    await expect(f.run()).resolves.toEqual(response);
    expect(f.sent).toEqual([{ type: "content_delta", content: "First " }, { type: "content_delta", content: "second" }]);
    expect(f.runtime.delivery!.deliver).toHaveBeenCalledTimes(2);
    for (const [context] of vi.mocked(f.runtime.delivery!.deliver).mock.calls) {
      expect(context).toEqual({ scope: f.runtime.scope, actor: f.runtime.actor, signal: f.runtime.signal, sources: f.sources });
      expect(Object.isFrozen(context)).toBe(true);
      expect(Object.isFrozen(context.scope.job)).toBe(true);
      expect(Object.isFrozen(context.sources[0])).toBe(true);
    }
    expect(f.runtime.reserveDispatch).toHaveBeenCalledExactlyOnceWith("model", 2);
    expect(f.gateway.chatEventStream).toHaveBeenCalledTimes(1);
    expect(f.cleanup).toHaveBeenCalledTimes(1);
  });

  it.each([0, 1])("denies source revocation after dispatch before delta %i and closes the gateway", async index => {
    const f = fixture();
    f.beforeDelta(i => { if (i === index) f.revoke(); });
    await expect(f.run()).rejects.toThrow("SCOPE");
    expect(f.sent).toEqual(index ? [{ type: "content_delta", content: "First " }] : []);
    expect(f.cleanup).toHaveBeenCalledTimes(1);
    expect(f.runtime.authorize).toHaveBeenCalledTimes(2);
    expect(f.runtime.authorize).toHaveBeenNthCalledWith(1, "model", f.sources);
    expect(f.runtime.authorize).toHaveBeenNthCalledWith(2, "model", f.sources);
    expect(f.runtime.delivery!.deliver).toHaveBeenCalledTimes(index + 1);
    expect(f.runtime.reserveDispatch).toHaveBeenCalledTimes(1);
  });

  it("revalidates source authority after an asynchronous delivery wait", async () => {
    const f = fixture();
    let waiting!: () => void;
    let release!: () => void;
    const started = new Promise<void>(resolve => { waiting = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    f.beforeHandoff(async () => { waiting(); await gate; });
    const rejected = expect(f.run()).rejects.toThrow("SCOPE");
    await started;
    f.revoke();
    release();
    await rejected;
    expect(f.sent).toEqual([]);
    expect(f.cleanup).toHaveBeenCalledTimes(1);
  });

  it("fails closed on unknown authorization errors instead of treating them as disconnects", async () => {
    const f = fixture();
    f.beforeHandoff(async () => { throw new Error("private authorization backend detail"); });
    await expect(f.run()).rejects.toThrow(/^Assistant harness: SCOPE$/);
    expect(f.sent).toEqual([]);
    expect(f.cleanup).toHaveBeenCalledTimes(1);
  });

  it.each(["workspaceId", "userId", "conversationId"] as const)("rejects a different declared %s before calling the port", async key => {
    const f = fixture();
    f.runtime.delivery = { ...f.runtime.delivery!, audience: { ...f.runtime.delivery!.audience, [key]: "other" } };
    await expect(f.run()).rejects.toThrow("SCOPE");
    expect(f.runtime.delivery.deliver).not.toHaveBeenCalled();
    expect(f.sent).toEqual([]);
    expect(f.cleanup).toHaveBeenCalledTimes(1);
  });

  it("binds delivery to the actual connection instead of trusting an audience label", async () => {
    const f = fixture();
    f.beforeHandoff(async () => { f.connection.userId = "other-user"; });
    await expect(f.run()).rejects.toThrow("SCOPE");
    expect(f.sent).toEqual([]);
    expect(f.cleanup).toHaveBeenCalledTimes(1);
  });

  it.each(["before-delta", "during-delivery"])("blocks cancellation %s and closes the generator", async when => {
    const f = fixture();
    if (when === "before-delta") f.beforeDelta(() => f.controller.abort());
    else f.beforeHandoff(async () => { f.controller.abort(); });
    await expect(f.run()).rejects.toThrow("CANCELLED");
    expect(f.sent).toEqual([]);
    expect(f.cleanup).toHaveBeenCalledTimes(1);
    if (when === "before-delta") expect(f.runtime.delivery!.deliver).not.toHaveBeenCalled();
  });

  it("detaches without cancelling or redispatching admitted work", async () => {
    const f = fixture();
    f.beforeDelta(i => { if (i === 1) f.connection.attached = false; });
    await expect(f.run()).resolves.toEqual(response);
    expect(f.sent).toEqual([{ type: "content_delta", content: "First " }]);
    expect(f.controller.signal.aborted).toBe(false);
    expect(f.runtime.reserveDispatch).toHaveBeenCalledTimes(1);
    expect(f.gateway.chatEventStream).toHaveBeenCalledTimes(1);
    expect(f.cleanup).toHaveBeenCalledTimes(1);
  });

  it("suppresses incremental delivery when no guarded port is supplied", async () => {
    const f = fixture();
    f.runtime.delivery = undefined;
    await expect(f.run()).resolves.toEqual(response);
    expect(f.sent).toEqual([]);
    expect(f.cleanup).toHaveBeenCalledTimes(1);
  });
});
