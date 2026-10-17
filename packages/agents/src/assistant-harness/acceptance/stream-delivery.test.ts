import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { AssistantReadTool, AssistantDeliveryPort, AssistantDeliveryContext, AssistantEvent } from "../contracts";
import { acceptanceFixture, barrier, input } from "./fixture";

vi.mock("../../../../models/src/usage", () => ({
  assertWorkspaceModelBudget: vi.fn().mockResolvedValue(undefined),
  assertCatalogModelBudget: vi.fn().mockResolvedValue(undefined),
  recordModelUsage: vi.fn().mockResolvedValue(undefined),
}));

beforeEach(() => { vi.clearAllMocks(); });

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

const encoder = new TextEncoder();
const delta = (content: string) => `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\n`;
const finish = 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';

// These controllable HTTP bodies and MemorySaver checkpoints prove synthetic
// composition boundaries, NOT real PostgreSQL durability or transactional sends.
function transport() {
  let body!: ReadableStreamDefaultController<Uint8Array>;
  const cancelled = vi.fn();
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) { body = controller; },
    cancel: cancelled,
  }));
  return { response, cancelled, send: (text: string) => body.enqueue(encoder.encode(text)) };
}

async function savedData(f: Awaited<ReturnType<typeof acceptanceFixture>>) {
  const tuple = await f.memory.getTuple({ configurable: { thread_id: f.runtime.scope.runId } });
  return tuple?.checkpoint.channel_values.data;
}

describe("actual assistant harness and gateway streaming acceptance", () => {
  it("binds parsed-read source evidence to a guarded streaming handoff despite adapter mutation and revocation", async () => {
    const retained = {
      content: "Synthetic permitted evidence",
      sources: [{ kind: "brain" as const, id: "brain-original" }, { kind: "meeting" as const, id: "meeting-original" }],
    };
    const expectedSources = structuredClone(retained.sources);
    const read: AssistantReadTool = {
      name: "read_brain", description: "Read synthetic evidence",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      arguments: z.object({}).strict(),
      execute: vi.fn(async () => retained),
    };
    const f = await acceptanceFixture({ stream: true, capabilities: { reads: [read] } });
    const http = transport();
    const entered = barrier();
    const decision = barrier();
    const sent: AssistantEvent[] = [];
    let handoff: AssistantDeliveryContext | undefined;
    f.runtime.delivery!.deliver = vi.fn<AssistantDeliveryPort["deliver"]>(async (context, event) => {
      if (event.type !== "content_delta") {
        if (event.type === "tool_end") {
          expect(context.sources).toEqual(expectedSources);
          retained.sources[0].id = "adapter-replacement";
          retained.sources.pop();
        }
        sent.push(event);
        return "DELIVERED";
      }
      handoff = context;
      entered.release();
      await decision.promise;
      // This synthetic port owns both the recipient check and the send. A revoked
      // exact source denies the handoff; the harness must stop subsequent chunks.
      if (context.sources.some(source => f.authority.revokedSources.has(source.id))) return "DENIED";
      sent.push(event);
      return "DELIVERED";
    });
    const tool = { index: 0, id: "read-call", type: "function", function: { name: "read_brain", arguments: "{}" } };
    const first = `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [tool] }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`;
    f.fetchMock.mockResolvedValueOnce(new Response(first)).mockResolvedValueOnce(http.response);
    const pending = f.runner().run(input);
    const rejected = expect(pending).rejects.toThrow(/^Assistant harness: SCOPE$/);
    http.send(delta("source-dependent private answer") + delta("later private chunk"));
    await entered.promise;
    expect(read.execute).toHaveBeenCalledOnce();
    expect(f.fetchMock).toHaveBeenCalledTimes(2);
    expect(handoff!.sources).toEqual(expectedSources);
    expect(Object.isFrozen(handoff!.sources)).toBe(true);
    expect(handoff!.sources.every(Object.isFrozen)).toBe(true);
    expect(handoff!.scope).toEqual(f.runtime.scope);
    expect(handoff!.actor).toEqual(f.runtime.actor);
    retained.sources[0].id = "another-adapter-replacement";
    f.authority.revokedSources.add("meeting-original");
    decision.release();
    await rejected;
    expect(handoff!.sources).toEqual(expectedSources);
    expect(sent).toEqual([{ type: "tool_start", name: "read_brain" }, { type: "tool_end", name: "read_brain", outcome: "ok" }]);
    expect(f.runtime.delivery!.deliver).toHaveBeenCalledTimes(3);
    expect(http.cancelled).toHaveBeenCalledOnce();
    expect(f.reservations).toEqual({ model: 2, tool: 1 });
    expect(JSON.stringify(await savedData(f))).not.toContain("source-dependent private answer");
  });

  it("stops a denied guarded handoff, closes HTTP and accounts without checkpointing denied content", async () => {
    const f = await acceptanceFixture({ stream: true });
    const http = transport();
    const entered = barrier();
    const decision = barrier();
    const contexts: AssistantDeliveryContext[] = [];
    f.runtime.delivery!.deliver = vi.fn<AssistantDeliveryPort["deliver"]>(async (context, event) => {
      contexts.push(context);
      entered.release();
      await decision.promise;
      // Synthetic recipient authority and handoff are serialized in this port.
      // DENIED performs no send, even though the provider already emitted text.
      expect(event).toEqual({ type: "content_delta", content: "private first chunk" });
      return "DENIED";
    });
    f.fetchMock.mockResolvedValueOnce(http.response);
    const pending = f.runner().run(input);
    const rejected = expect(pending).rejects.toThrow(/^Assistant harness: SCOPE$/);
    http.send(delta("private first chunk") + delta("must never be handed off"));
    await entered.promise;
    expect(f.reservations.model).toBe(1);
    expect(http.cancelled).not.toHaveBeenCalled();
    expect(contexts[0]).toMatchObject({ scope: f.runtime.scope, actor: f.runtime.actor, sources: [] });
    expect(Object.isFrozen(contexts[0])).toBe(true);
    expect(Object.isFrozen(contexts[0].scope.job)).toBe(true);
    expect(Object.isFrozen(contexts[0].sources)).toBe(true);
    decision.release();
    await rejected;
    expect(f.runtime.delivery!.deliver).toHaveBeenCalledOnce();
    expect(http.cancelled).toHaveBeenCalledOnce();
    expect(f.fetchMock).toHaveBeenCalledOnce();
    expect(JSON.stringify(await savedData(f))).not.toContain("private first chunk");
    const { recordModelUsage } = await import("../../../../models/src/usage");
    expect(recordModelUsage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ workspaceId: "ws-acceptance", agentRunId: "run-acceptance", workflowJobId: "job-acceptance" }));
  });

  it("allows detached delivery to finish and replay its synthetic checkpoint without new HTTP or sends", async () => {
    const f = await acceptanceFixture({ stream: true });
    const http = transport();
    const attempted: AssistantEvent[] = [];
    f.runtime.delivery!.deliver = vi.fn<AssistantDeliveryPort["deliver"]>(async (_context, event) => {
      attempted.push(event);
      return "DETACHED";
    });
    f.fetchMock.mockResolvedValueOnce(http.response);
    http.send(delta("one ") + delta("two") + finish);
    const completed = await f.runner().run(input);
    expect(completed).toMatchObject({ status: "completed", content: "one two" });
    expect(attempted).toEqual([{ type: "content_delta", content: "one " }, { type: "content_delta", content: "two" }]);
    expect(await f.runner().run()).toEqual(completed);
    expect(f.runtime.delivery!.deliver).toHaveBeenCalledTimes(2);
    expect(f.fetchMock).toHaveBeenCalledOnce();
    expect(http.cancelled).toHaveBeenCalledOnce();
    expect(f.reservations).toEqual({ model: 1, tool: 0 });
  });

  it("cancels an outstanding HTTP body read and accounts cleanup without delivery", async () => {
    const f = await acceptanceFixture({ stream: true });
    const entered = barrier();
    const cancelled = vi.fn();
    f.fetchMock.mockImplementationOnce(async (_url, init) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(init?.signal).not.toBe(f.controller.signal);
      return new Response(new ReadableStream<Uint8Array>({
        pull() { entered.release(); },
        cancel: cancelled,
      }, { highWaterMark: 0 }));
    });
    const pending = f.runner().run(input);
    const rejected = expect(pending).rejects.toThrow(/^Assistant harness: CANCELLED$/);
    await entered.promise;
    f.controller.abort(new Error("private cancellation reason"));
    await rejected;
    expect(cancelled).toHaveBeenCalledOnce();
    expect(f.runtime.delivery!.deliver).not.toHaveBeenCalled();
    expect(f.reservations).toEqual({ model: 1, tool: 0 });
    const { recordModelUsage } = await import("../../../../models/src/usage");
    expect(recordModelUsage).toHaveBeenCalledOnce();
  });

  it("observes cancellation while a detached handoff is awaited and does not request another chunk", async () => {
    const f = await acceptanceFixture({ stream: true });
    const http = transport();
    const entered = barrier();
    const release = barrier();
    f.runtime.delivery!.deliver = vi.fn<AssistantDeliveryPort["deliver"]>(async () => {
      entered.release();
      await release.promise;
      return "DETACHED";
    });
    f.fetchMock.mockResolvedValueOnce(http.response);
    const pending = f.runner().run(input);
    const rejected = expect(pending).rejects.toThrow(/^Assistant harness: CANCELLED$/);
    http.send(delta("first") + delta("second"));
    await entered.promise;
    f.controller.abort();
    release.release();
    await rejected;
    expect(f.runtime.delivery!.deliver).toHaveBeenCalledOnce();
    expect(http.cancelled).toHaveBeenCalledOnce();
    expect(JSON.stringify(await savedData(f))).not.toContain('"content":"first"');
  });
});
