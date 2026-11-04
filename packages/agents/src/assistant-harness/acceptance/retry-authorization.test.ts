import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { acceptanceFixture, barrier, input, success as jsonSuccess, toolCall } from "./fixture";
import type { AssistantReadTool } from "../contracts";

vi.mock("../../../../models/src/usage", () => ({
  assertWorkspaceModelBudget: vi.fn().mockResolvedValue(undefined),
  assertCatalogModelBudget: vi.fn().mockResolvedValue(undefined),
  recordModelUsage: vi.fn().mockResolvedValue(undefined),
}));
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetModules(); });

function readFixture() {
  const evidence = { content: "Synthetic private evidence", sources: [{ kind: "brain" as const, id: "source-original" }] };
  const read: AssistantReadTool = {
    name: "read_brain", description: "Synthetic read", parameters: { type: "object", properties: {}, additionalProperties: false },
    arguments: z.object({}).strict(), execute: vi.fn(async () => evidence),
  };
  return { evidence, read };
}

describe.each([false, true])("composed harness authorization at synthetic HTTP retry boundaries (stream=%s)", stream => {
  const success = (content = "Synthetic answer", calls?: ReturnType<typeof toolCall>[]) => stream
    ? new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content, tool_calls: calls?.map((call, index) => ({ ...call, index })) }, finish_reason: calls ? "tool_calls" : "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2 } })}\n\ndata: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } })
    : jsonSuccess(content, calls);
  it.each(["membership", "claim", "cancellation", "source"] as const)("prevents a retry after %s revocation", async change => {
    const { read } = readFixture();
    const f = await acceptanceFixture({ stream, capabilities: { reads: [read] } });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { recordModelUsage } = await import("../../../../models/src/usage");
    vi.mocked(recordModelUsage).mockClear();
    const reachedRetry = barrier();
    f.fetchMock.mockResolvedValueOnce(success("", [toolCall("read_brain")]))
      .mockImplementationOnce(async () => { reachedRetry.release(); return new Response("busy", { status: 429, headers: { "Retry-After": "30" } }); });
    const pending = f.runner().run(input).catch(error => error);
    await vi.advanceTimersByTimeAsync(0);
    await Promise.race([reachedRetry.promise, pending.then(error => { throw error; })]);
    expect(f.fetchMock).toHaveBeenCalledTimes(2);
    if (change === "membership") f.authority.member = false;
    if (change === "claim") f.authority.claim = false;
    if (change === "cancellation") f.authority.cancelled = true;
    if (change === "source") f.authority.revokedSources.add("source-original");
    await vi.advanceTimersByTimeAsync(30000);
    expect(await pending).toMatchObject({ code: change === "cancellation" ? "CANCELLED" : "SCOPE" });
    expect(f.fetchMock).toHaveBeenCalledTimes(2);
    expect(f.reservations).toEqual({ model: 2, tool: 1 });
    expect(recordModelUsage).toHaveBeenCalledOnce();
    expect(vi.mocked(f.runtime.authorize).mock.calls.some(([operation, sources]) => operation === "model" && sources.some(source => source.id === "source-original"))).toBe(true);
  });

  it("checks membership even when a retried invocation has no saved sources", async () => {
    const f = await acceptanceFixture({ stream });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.spyOn(Math, "random").mockReturnValue(0);
    const attempted = barrier();
    f.fetchMock.mockImplementationOnce(async () => { attempted.release(); return new Response("busy", { status: 429, headers: { "Retry-After": "30" } }); });
    const pending = f.runner().run(input).catch(error => error);
    await vi.advanceTimersByTimeAsync(0);
    await Promise.race([attempted.promise, pending.then(error => { throw error; })]);
    const checks = vi.mocked(f.runtime.authorize).mock.calls.length;
    f.authority.member = false;
    await vi.advanceTimersByTimeAsync(30000);
    expect(await pending).toMatchObject({ code: "SCOPE" });
    expect(f.fetchMock).toHaveBeenCalledOnce();
    expect(vi.mocked(f.runtime.authorize).mock.calls.slice(checks)).toContainEqual(["model", []]);
    expect(f.reservations.model).toBe(1);
  });

  it("keeps one invocation reservation across three real gateway HTTP attempts", async () => {
    const f = await acceptanceFixture({ stream, limits: { modelCalls: 1 } });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { recordModelUsage } = await import("../../../../models/src/usage");
    vi.mocked(recordModelUsage).mockClear();
    f.fetchMock.mockResolvedValueOnce(new Response("busy", { status: 429, headers: { "Retry-After": "1" } }))
      .mockResolvedValueOnce(new Response("busy", { status: 429, headers: { "Retry-After": "1" } }))
      .mockResolvedValueOnce(success("Recovered"));
    const pending = f.runner().run(input);
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toMatchObject({ status: "completed", content: "Recovered" });
    expect(f.fetchMock).toHaveBeenCalledTimes(3);
    expect(recordModelUsage).toHaveBeenCalledOnce();
    expect(f.runtime.reserveDispatch).toHaveBeenCalledExactlyOnceWith("model", 1);
    for (const [, init] of f.fetchMock.mock.calls) expect(JSON.parse(init!.body as string).provider).toMatchObject({ allow_fallbacks: false });
  });

  it("retains immutable original read provenance across HTTP retries and caller mutation", async () => {
    const { evidence, read } = readFixture();
    const f = await acceptanceFixture({ stream, capabilities: { reads: [read] } });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.spyOn(Math, "random").mockReturnValue(0);
    const attempted = barrier();
    f.fetchMock.mockResolvedValueOnce(success("", [toolCall("read_brain")]))
      .mockImplementationOnce(async () => { attempted.release(); return new Response("busy", { status: 429, headers: { "Retry-After": "1" } }); })
      .mockResolvedValueOnce(success("Bound answer"));
    const pending = f.runner().run(input);
    await vi.advanceTimersByTimeAsync(0);
    await Promise.race([attempted.promise, pending.then(error => { throw error; })]);
    evidence.sources[0].id = "source-mutated";
    evidence.sources.push({ kind: "brain", id: "source-added" });
    evidence.content = "Mutated evidence";
    await vi.advanceTimersByTimeAsync(1000);
    await expect(pending).resolves.toMatchObject({ content: "Bound answer" });
    const checks = vi.mocked(f.runtime.authorize).mock.calls.filter(([, sources]) => sources.length);
    expect(checks.length).toBeGreaterThan(1);
    for (const [, sources] of checks) {
      expect(sources).toEqual([{ kind: "brain", id: "source-original" }]);
      expect(Object.isFrozen(sources)).toBe(true);
      expect(Object.isFrozen(sources[0])).toBe(true);
    }
    const lastBody = JSON.parse(f.fetchMock.mock.calls[2][1]!.body as string);
    expect(lastBody.messages.at(-1).content).toBe('{"untrustedEvidence":"Synthetic private evidence"}');
    expect(f.reservations).toEqual({ model: 2, tool: 1 });
  });

  it.each(["resolve", "reject"] as const)("aborts an awaited retry authorization before its late %s", async late => {
    const f = await acceptanceFixture({ stream });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.spyOn(Math, "random").mockReturnValue(0);
    const entered = barrier();
    const gate = barrier();
    let firstAttempt = true;
    const authorize = f.runtime.authorize;
    f.runtime.authorize = vi.fn(async (operation, sources) => {
      if (!firstAttempt && operation === "model") {
        entered.release();
        await gate.promise;
        if (late === "reject") throw new Error("Synthetic private late authorization error");
      }
      await authorize(operation, sources);
    });
    f.fetchMock.mockImplementationOnce(async () => {
      firstAttempt = false;
      return new Response("busy", { status: 429, headers: { "Retry-After": "1" } });
    });
    const pending = f.runner().run(input).catch(error => error);
    await vi.advanceTimersByTimeAsync(1000);
    await entered.promise;
    f.controller.abort(new Error("Synthetic private abort reason"));
    expect(await pending).toMatchObject({ code: "CANCELLED", message: "Assistant harness: CANCELLED" });
    gate.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.fetchMock).toHaveBeenCalledOnce();
    expect(f.reservations.model).toBe(1);
  });
});
