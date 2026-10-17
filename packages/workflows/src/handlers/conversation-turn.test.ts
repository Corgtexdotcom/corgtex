import { describe, expect, it, vi } from "vitest";
import type { AssistantOutcome, AssistantScope } from "@corgtex/agents/assistant-harness";
import { handleConversationTurn, type ConversationTurnClaim, type ConversationTurnPorts } from "./conversation-turn";

// Callable port contracts only: these fixtures do not implement durable claims or fencing.
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const claim: ConversationTurnClaim = { jobId: "job-a", owner: "worker-a", attempt: 2 };
const scope: AssistantScope = {
  runId: "run-a", workspaceId: "workspace-a", userId: "user-a",
  conversationId: "conversation-a", policyVersion: "policy-a",
  job: { id: claim.jobId, owner: claim.owner, attempt: claim.attempt },
};
const completed: AssistantOutcome = { status: "completed", content: "Synthetic result", receiptIds: ["receipt-a", "receipt-b"] };

function fixture(outcome: AssistantOutcome = completed) {
  const run = vi.fn(async () => outcome);
  const ports = {
    load: vi.fn(async (_claim: ConversationTurnClaim) => ({ scope, run })),
    finish: vi.fn(async (_claim: ConversationTurnClaim, _outcome: AssistantOutcome) => {}),
  } satisfies ConversationTurnPorts;
  return { ports, run };
}

describe("handleConversationTurn port ordering", () => {
  it.each([
    { ...claim, jobId: "" }, { ...claim, owner: "" },
    ...[0, -1, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1].map(attempt => ({ ...claim, attempt })),
  ])("rejects invalid claim %j before loading", async invalid => {
    const { ports, run } = fixture();
    await expect(handleConversationTurn(invalid, ports)).rejects.toThrow("Invalid conversation claim");
    expect(ports.load).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(ports.finish).not.toHaveBeenCalled();
  });

  it.each([
    { ...scope.job, id: "other-job" },
    { ...scope.job, owner: "other-worker" },
    { ...scope.job, attempt: claim.attempt + 1 },
  ])("rejects loaded job mismatch %j before run or finish", async job => {
    const { ports, run } = fixture();
    ports.load.mockResolvedValue({ scope: { ...scope, job }, run });
    await expect(handleConversationTurn(claim, ports)).rejects.toThrow("Stale conversation claim");
    expect(ports.load).toHaveBeenCalledExactlyOnceWith(claim);
    expect(run).not.toHaveBeenCalled();
    expect(ports.finish).not.toHaveBeenCalled();
  });

  it("awaits load, run and finish in order before exposing the identical outcome", async () => {
    const loaded = deferred<Awaited<ReturnType<ConversationTurnPorts["load"]>>>();
    const ran = deferred<AssistantOutcome>();
    const finished = deferred<void>();
    const runEntered = deferred<void>();
    const finishEntered = deferred<void>();
    const calls: string[] = [];
    const run = vi.fn(() => { calls.push("run"); runEntered.resolve(); return ran.promise; });
    const ports: ConversationTurnPorts = {
      load: vi.fn(received => { expect(received).toBe(claim); calls.push("load"); return loaded.promise; }),
      finish: vi.fn((received, outcome) => {
        expect(received).toBe(claim); expect(outcome).toBe(completed);
        calls.push("finish"); finishEntered.resolve(); return finished.promise;
      }),
    };
    let settled = false;
    const pending = handleConversationTurn(claim, ports).then(outcome => { settled = true; calls.push("returned"); return outcome; });
    expect(calls).toEqual(["load"]);
    expect(settled).toBe(false);
    loaded.resolve({ scope, run });
    await runEntered.promise;
    expect(calls).toEqual(["load", "run"]);
    expect(settled).toBe(false);
    ran.resolve(completed);
    await finishEntered.promise;
    expect(calls).toEqual(["load", "run", "finish"]);
    expect(settled).toBe(false);
    finished.resolve();
    expect(await pending).toBe(completed);
    expect(calls).toEqual(["load", "run", "finish", "returned"]);
    expect(ports.load).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(ports.finish).toHaveBeenCalledTimes(1);
  });

  it.each(["load", "run", "finish"] as const)("propagates deferred %s rejection without retry or later calls", async stage => {
    const failure = new Error(`synthetic ${stage} failure`);
    const gate = deferred<never>();
    const entered = deferred<void>();
    const calls: string[] = [];
    const run = vi.fn(async () => {
      calls.push("run");
      if (stage === "run") { entered.resolve(); return gate.promise; }
      return completed;
    });
    const ports: ConversationTurnPorts = {
      load: vi.fn(async () => {
        calls.push("load");
        if (stage === "load") { entered.resolve(); return gate.promise; }
        return { scope, run };
      }),
      finish: vi.fn(async () => {
        calls.push("finish"); entered.resolve(); return gate.promise;
      }),
    };
    const pending = handleConversationTurn(claim, ports);
    const rejection = expect(pending).rejects.toBe(failure);
    await entered.promise;
    const expected = stage === "load" ? ["load"] : stage === "run" ? ["load", "run"] : ["load", "run", "finish"];
    expect(calls).toEqual(expected);
    gate.reject(failure);
    await rejection;
    expect(calls).toEqual(expected);
    expect(ports.load).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(stage === "load" ? 0 : 1);
    expect(ports.finish).toHaveBeenCalledTimes(stage === "finish" ? 1 : 0);
  });

  it("propagates an obsolete-attempt finish rejection without rerunning or acknowledging success", async () => {
    const { ports, run } = fixture();
    const runResult = deferred<AssistantOutcome>();
    const started = deferred<void>();
    let currentAttempt = claim.attempt;
    run.mockImplementation(() => { started.resolve(); return runResult.promise; });
    const stale = new Error("synthetic finish rejected obsolete attempt");
    ports.finish.mockImplementation(async received => {
      if (received.attempt !== currentAttempt) throw stale;
    });
    const pending = handleConversationTurn(claim, ports);
    const rejection = expect(pending).rejects.toBe(stale);
    await started.promise;
    currentAttempt += 1;
    runResult.resolve(completed);
    await rejection;
    expect(ports.load).toHaveBeenCalledExactlyOnceWith(claim);
    expect(run).toHaveBeenCalledTimes(1);
    expect(ports.finish).toHaveBeenCalledExactlyOnceWith(claim, completed);
  });

  it.each<AssistantOutcome>([
    completed,
    { status: "completed", content: "", receiptIds: [] },
    { status: "waiting", approvalId: "approval-a" },
    { status: "reconciliation_required" },
  ])("passes $status outcome unchanged to finish and the caller", async outcome => {
    const { ports, run } = fixture(outcome);
    expect(await handleConversationTurn(claim, ports)).toBe(outcome);
    expect(ports.load.mock.calls[0][0]).toBe(claim);
    expect(run).toHaveBeenCalledExactlyOnceWith();
    expect(ports.finish).toHaveBeenCalledExactlyOnceWith(claim, outcome);
    expect(ports.finish.mock.calls[0][1]).toBe(outcome);
  });
});
