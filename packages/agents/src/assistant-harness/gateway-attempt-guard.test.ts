import { afterEach, describe, expect, it, vi } from "vitest";
import type { AssistantRuntime } from "./contracts";

const identity = vi.hoisted(() => ({ getToken: vi.fn() }));
vi.mock("@azure/identity", () => ({ DefaultAzureCredential: class { getToken = identity.getToken; } }));
vi.mock("../../../models/src/usage", () => ({
  assertWorkspaceModelBudget: vi.fn().mockResolvedValue(undefined),
  assertCatalogModelBudget: vi.fn().mockResolvedValue(undefined),
  recordModelUsage: vi.fn().mockResolvedValue(undefined),
}));
const originalEnv = { ...process.env };
afterEach(() => { process.env = { ...originalEnv }; vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.resetModules(); });

async function fixture(stream: boolean, managed = false) {
  Object.assign(process.env, {
    MODEL_PROVIDER: managed ? "azure-openai" : "openrouter", MODEL_API_KEY: "synthetic",
    MODEL_BASE_URL: managed ? "https://synthetic.openai.azure.com/openai/v1" : "https://models.example.test/v1",
    AZURE_OPENAI_AUTH_MODE: "managed_identity", MODEL_CHAT_DEFAULT: "guard-fixture",
    MODEL_REQUEST_TIMEOUT_MS: "180000", MODEL_PROVIDER_ROUTES_JSON: "[]",
  });
  process.env.MODEL_PRICE_OVERRIDES_JSON = JSON.stringify([{ provider: managed ? "azure-openai" : "openrouter", model: "guard-fixture", inputUsdPerToken: 0.000001, outputUsdPerToken: 0.000002 }]);
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0);
  const { AssistantHarnessError } = await import("./contracts");
  const { callAssistantGateway } = await import("./gateway-node");
  const { openAICompatibleModelGateway: gateway } = await import("../../../models/src/openai-compatible-gateway");
  const { recordModelUsage } = await import("../../../models/src/usage");
  vi.mocked(recordModelUsage).mockClear();
  const controller = new AbortController();
  const sources = [{ kind: "brain" as const, id: "a" }, { kind: "meeting" as const, id: "b" }];
  let denial: "SCOPE" | "CANCELLED" | "LIMIT" | undefined;
  const runtime: AssistantRuntime = {
    scope: { workspaceId: "ws", userId: "user", conversationId: "conversation", runId: "run", policyVersion: "policy", job: { id: "job", owner: "worker", attempt: 1 } },
    actor: { kind: "user", user: { id: "user", email: "synthetic@example.test", displayName: "Synthetic" } },
    signal: controller.signal,
    authorize: vi.fn(async (_operation, refs) => {
      expect(refs).toEqual([{ kind: "brain", id: "a" }, { kind: "meeting", id: "b" }]);
      expect(Object.isFrozen(refs)).toBe(true);
      if (denial) throw new AssistantHarnessError(denial);
    }),
    reserveDispatch: vi.fn(async () => {}),
  };
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  const run = () => callAssistantGateway({ gateway, runtime, sources, request: { messages: [{ role: "user", content: "Synthetic" }] }, maximumCalls: 2, maximumBytes: 4096, stream }).catch(error => error);
  const success = () => stream
    ? new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
    : Response.json({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
  return { runtime, sources, controller, fetchMock, run, success, recordModelUsage, deny: (code: typeof denial) => { denial = code; } };
}

describe("harness per-attempt authority through synthetic gateway transport", () => {
  it.each((["SCOPE", "LIMIT"] as const).flatMap(primary => ["deadline", "admitted cancellation"].map(stop => ({ primary, stop }))))
    ("retains error priorities for $primary with $stop during stream usage cleanup", async ({ primary, stop }) => {
      const f = await fixture(true);
      let releaseUsage!: () => void;
      vi.mocked(f.recordModelUsage).mockImplementationOnce(() => new Promise<void>(resolve => { releaseUsage = resolve; }));
      const content = primary === "LIMIT" ? "x".repeat(5000) : "Denied";
      let providerSignal!: AbortSignal;
      f.fetchMock.mockImplementationOnce(async (_url, init) => {
        providerSignal = init.signal;
        return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
      });
      if (primary === "SCOPE") f.runtime.delivery = {
        audience: { workspaceId: "ws", userId: "user", conversationId: "conversation" },
        deliver: vi.fn(async () => "DENIED" as const),
      };
      let settled = false;
      const pending = f.run().then(result => { settled = true; return result; });
      await vi.advanceTimersByTimeAsync(0);
      expect(f.recordModelUsage).toHaveBeenCalledOnce();
      expect(settled).toBe(false);
      expect(providerSignal.aborted).toBe(false);
      expect(f.controller.signal.aborted).toBe(false);
      if (stop === "admitted cancellation") f.controller.abort(new Error("private abort reason"));
      else await vi.advanceTimersByTimeAsync(120000);
      expect(providerSignal.aborted).toBe(true);
      expect(f.controller.signal.aborted).toBe(stop === "admitted cancellation");
      expect(settled).toBe(false);
      releaseUsage();
      const code = stop === "admitted cancellation" ? "CANCELLED" : primary;
      expect(await pending).toMatchObject({ code, message: `Assistant harness: ${code}` });
      expect(f.fetchMock).toHaveBeenCalledOnce();
      expect(f.runtime.reserveDispatch).toHaveBeenCalledExactlyOnceWith("model", 2);
      expect(f.recordModelUsage).toHaveBeenCalledOnce();
      expect(f.recordModelUsage).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws", agentRunId: "run", workflowJobId: "job" }));
      if (primary === "SCOPE") expect(f.runtime.delivery!.deliver).toHaveBeenCalledOnce();
    });

  it.each([false, true].flatMap(stream => ["revocation", "cancellation", "lost claim", "budget"].flatMap(change => ["headers", "retry"].map(stage => ({ stream, change, stage })))))
    ("blocks $change during $stage (stream=$stream)", async ({ stream, change, stage }) => {
      let release!: (value: { token: string; expiresOnTimestamp: number }) => void;
      identity.getToken.mockImplementation(() => new Promise(resolve => { release = resolve; }));
      const f = await fixture(stream, stage === "headers");
      f.fetchMock.mockResolvedValue(new Response("busy", { status: 429, headers: { "Retry-After": "30" } }));
      const pending = f.run();
      await vi.advanceTimersByTimeAsync(0);
      expect(f.fetchMock).toHaveBeenCalledTimes(stage === "headers" ? 0 : 1);
      f.deny(change === "cancellation" ? "CANCELLED" : change === "budget" ? "LIMIT" : "SCOPE");
      if (stage === "headers") release({ token: "synthetic", expiresOnTimestamp: Date.now() + 3600000 });
      else await vi.advanceTimersByTimeAsync(30000);
      expect(await pending).toMatchObject({ code: change === "cancellation" ? "CANCELLED" : change === "budget" ? "LIMIT" : "SCOPE" });
      expect(f.fetchMock).toHaveBeenCalledTimes(stage === "headers" ? 0 : 1);
      expect(f.runtime.reserveDispatch).toHaveBeenCalledOnce();
      expect(f.recordModelUsage).not.toHaveBeenCalled();
    });

  it.each([false, true])("keeps immutable sources, one reservation and guarded fallback on retries (stream=%s)", async stream => {
    const f = await fixture(stream);
    f.fetchMock.mockResolvedValueOnce(new Response("busy", { status: 503 })).mockImplementationOnce(async (_url, init) => {
      expect(JSON.parse(init.body).provider).toMatchObject({ allow_fallbacks: false });
      expect(init.signal).not.toBe(f.controller.signal);
      return f.success();
    });
    const pending = f.run();
    await vi.advanceTimersByTimeAsync(0);
    f.sources[0].id = "mutated";
    f.sources.pop();
    f.runtime.signal = new AbortController().signal;
    f.runtime.scope = { ...f.runtime.scope, workspaceId: "other", runId: "other", job: { id: "other", owner: "other", attempt: 2 } };
    f.runtime.actor.user.id = "other";
    f.runtime.authorize = vi.fn(async () => { throw new Error("replacement"); });
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({ content: "ok" });
    expect(f.fetchMock).toHaveBeenCalledTimes(2);
    expect(f.runtime.reserveDispatch).toHaveBeenCalledOnce();
    expect(f.recordModelUsage).toHaveBeenCalledOnce();
    expect(f.recordModelUsage).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws", agentRunId: "run", workflowJobId: "job" }));
  });

  it.each([false, true])("cancels pending authorization and ignores late rejection (stream=%s)", async stream => {
    const f = await fixture(stream);
    let reject!: (error: Error) => void;
    vi.mocked(f.runtime.authorize).mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined)
      .mockImplementationOnce(() => new Promise((_resolve, rejectPromise) => { reject = rejectPromise; }));
    const pending = f.run();
    await vi.advanceTimersByTimeAsync(0);
    f.controller.abort(new Error("private abort reason"));
    expect(await pending).toMatchObject({ code: "CANCELLED" });
    reject(new Error("private late authorization detail"));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.fetchMock).not.toHaveBeenCalled();
    expect(f.recordModelUsage).not.toHaveBeenCalled();
  });
  it.each([false, true].flatMap(stream => ["abort", "deadline"].flatMap(stop => ["resolve", "reject"].map(late => ({ stream, stop, late })))))
    ("observes $stop with late $late (stream=$stream)", async ({ stream, stop, late }) => {
      const f = await fixture(stream);
      let settle!: () => void;
      vi.mocked(f.runtime.authorize).mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined)
        .mockImplementationOnce(() => new Promise<void>((resolve, reject) => {
          settle = () => late === "resolve" ? resolve() : reject(new Error("private late detail"));
        }));
      const pending = f.run();
      await vi.advanceTimersByTimeAsync(0);
      if (stop === "abort") f.controller.abort();
      else await vi.advanceTimersByTimeAsync(stream ? 120000 : 180000);
      expect(await pending).toMatchObject({ code: "CANCELLED" });
      expect(f.controller.signal.aborted).toBe(stop === "abort");
      settle();
      await vi.advanceTimersByTimeAsync(0);
      expect(f.fetchMock).not.toHaveBeenCalled();
      expect(f.recordModelUsage).not.toHaveBeenCalled();
      expect(f.runtime.reserveDispatch).toHaveBeenCalledOnce();
    });

  it.each([false, true])("sanitizes arbitrary attempt authority failures (stream=%s)", async stream => {
    const f = await fixture(stream);
    vi.mocked(f.runtime.authorize).mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("private adapter detail"));
    const result = await f.run();
    expect(result).toMatchObject({ code: "SCOPE", message: "Assistant harness: SCOPE" });
    expect(result.cause).toBeUndefined();
    expect(result.stack).not.toContain("private adapter detail");
    expect(f.fetchMock).not.toHaveBeenCalled();
    expect(f.recordModelUsage).not.toHaveBeenCalled();
  });

  it.each([false, true].flatMap(stream => ["headers", "retry"].map(stage => ({ stream, stage }))))
    ("uses admitted cancellation during $stage (stream=$stream)", async ({ stream, stage }) => {
      let release!: (value: { token: string; expiresOnTimestamp: number }) => void;
      identity.getToken.mockImplementation(() => new Promise(resolve => { release = resolve; }));
      const f = await fixture(stream, stage === "headers");
      f.fetchMock.mockResolvedValue(new Response("busy", { status: 429, headers: { "Retry-After": "30" } }));
      const pending = f.run();
      await vi.advanceTimersByTimeAsync(0);
      f.runtime.signal = new AbortController().signal;
      f.controller.abort(new Error("private abort reason"));
      expect(await pending).toMatchObject({ code: "CANCELLED" });
      if (stage === "headers") release({ token: "late synthetic token", expiresOnTimestamp: Date.now() + 3600000 });
      await vi.advanceTimersByTimeAsync(30000);
      expect(f.fetchMock).toHaveBeenCalledTimes(stage === "headers" ? 0 : 1);
      expect(f.recordModelUsage).not.toHaveBeenCalled();
      expect(f.runtime.reserveDispatch).toHaveBeenCalledOnce();
    });

});
