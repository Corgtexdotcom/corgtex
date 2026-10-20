import { describe, expect, it, vi } from "vitest";
import {
  recoverConversationTurns,
  type ConversationRecoveryCandidate,
  type ConversationRecoveryPort,
} from "./conversation-recovery";

function candidate(overrides: Partial<ConversationRecoveryCandidate> = {}): ConversationRecoveryCandidate {
  return {
    runId: "run-a",
    generation: 0,
    status: "RUNNABLE",
    decisionReady: false,
    checkpointWaiting: false,
    resultMissing: false,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function fixture(rows: ConversationRecoveryCandidate[] = []) {
  return {
    candidates: vi.fn(async (_limit: number) => rows),
    repair: vi.fn(async (_row: ConversationRecoveryCandidate, _intent: Parameters<ConversationRecoveryPort["repair"]>[1]) => "repaired" as "repaired" | "unchanged"),
  };
}

// These are callable port contracts; the synthetic ports implement no database or queue.
describe("recoverConversationTurns port ordering", () => {
  it.each([0, -1, 101, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid limit %s before querying or repairing",
    async limit => {
      const port = fixture([candidate()]);
      await expect(recoverConversationTurns(port, limit)).rejects.toThrow("Invalid conversation recovery limit");
      expect(port.candidates).not.toHaveBeenCalled();
      expect(port.repair).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, 1, 100])("passes the default or boundary limit %s to one empty query", async limit => {
    const port = fixture();
    await expect(recoverConversationTurns(port, limit)).resolves.toEqual({ inspected: 0, repaired: 0 });
    expect(port.candidates).toHaveBeenCalledExactlyOnceWith(limit ?? 25);
    expect(port.repair).not.toHaveBeenCalled();
  });

  it("rejects an over-bound response before repairing even its valid first row", async () => {
    const port = fixture([candidate(), candidate({ runId: "run-b" })]);
    await expect(recoverConversationTurns(port, 1)).rejects.toThrow("Conversation recovery exceeded its bound");
    expect(port.candidates).toHaveBeenCalledExactlyOnceWith(1);
    expect(port.repair).not.toHaveBeenCalled();
  });

  it.each([
    { runId: "" },
    { generation: -1 },
    { generation: 0.5 },
    { generation: NaN },
    { generation: Infinity },
    { generation: Number.MAX_SAFE_INTEGER + 1 },
  ])("rejects invalid candidate %j before delegating it or later candidates", async invalid => {
    const port = fixture([candidate(invalid), candidate({ runId: "later" })]);
    await expect(recoverConversationTurns(port)).rejects.toThrow("Invalid conversation recovery candidate");
    expect(port.repair).not.toHaveBeenCalled();
  });

  it("validates identity and generation even for a candidate that would otherwise be skipped", async () => {
    const port = fixture([candidate({ status: "CANCELLED", generation: -1 })]);
    await expect(recoverConversationTurns(port)).rejects.toThrow("Invalid conversation recovery candidate");
    expect(port.repair).not.toHaveBeenCalled();
  });

  it("includes skipped and unchanged rows in inspected while counting only repaired results", async () => {
    const execute = candidate();
    const resume = candidate({ runId: "run-b", generation: Number.MAX_SAFE_INTEGER, status: "WAITING", decisionReady: true, checkpointWaiting: true });
    const reconcile = candidate({ runId: "run-c", status: "COMPLETED", resultMissing: true });
    const port = fixture([
      candidate({ status: "CANCELLED", decisionReady: true, resultMissing: true }),
      candidate({ status: "UNKNOWN", decisionReady: true, resultMissing: true }),
      candidate({ status: "WAITING", checkpointWaiting: true }),
      candidate({ status: "COMPLETED", decisionReady: true }),
      execute, resume, reconcile,
    ]);
    port.repair.mockResolvedValueOnce("unchanged").mockResolvedValueOnce("repaired").mockResolvedValueOnce("unchanged");
    await expect(recoverConversationTurns(port)).resolves.toEqual({ inspected: 7, repaired: 1 });
    expect(port.repair.mock.calls).toEqual([[execute, "EXECUTE"], [resume, "RESUME"], [reconcile, "RECONCILE_RESULT"]]);
    expect(port.repair.mock.calls[0][0]).toBe(execute);
  });

  it("awaits the query and each repair in order before returning the total", async () => {
    const rows = [candidate(), candidate({ runId: "run-b" })];
    const query = deferred<ConversationRecoveryCandidate[]>();
    const first = deferred<"repaired" | "unchanged">();
    const second = deferred<"repaired" | "unchanged">();
    const firstEntered = deferred<void>();
    const secondEntered = deferred<void>();
    const calls: string[] = [];
    const port: ConversationRecoveryPort = {
      candidates: async limit => { calls.push(`query:${limit}`); return query.promise; },
      repair: async row => {
        calls.push(`repair:${row.runId}`);
        if (row === rows[0]) { firstEntered.resolve(); return first.promise; }
        secondEntered.resolve();
        return second.promise;
      },
    };
    let settled = false;
    const operation = recoverConversationTurns(port, 2).then(result => { settled = true; return result; });
    expect(calls).toEqual(["query:2"]);
    expect(settled).toBe(false);
    query.resolve(rows);
    await firstEntered.promise;
    expect(calls).toEqual(["query:2", "repair:run-a"]);
    expect(settled).toBe(false);
    first.resolve("repaired");
    await secondEntered.promise;
    expect(calls).toEqual(["query:2", "repair:run-a", "repair:run-b"]);
    expect(settled).toBe(false);
    second.resolve("unchanged");
    await expect(operation).resolves.toEqual({ inspected: 2, repaired: 1 });
  });

  it("propagates a delayed query failure without repairing or retrying and queries afresh next sweep", async () => {
    const failedQuery = deferred<ConversationRecoveryCandidate[]>();
    const error = new Error("query unavailable");
    const port = fixture([candidate()]);
    port.candidates.mockReturnValueOnce(failedQuery.promise);
    const operation = recoverConversationTurns(port);
    const rejection = expect(operation).rejects.toBe(error);
    failedQuery.reject(error);
    await rejection;
    expect(port.candidates).toHaveBeenCalledTimes(1);
    expect(port.repair).not.toHaveBeenCalled();
    await expect(recoverConversationTurns(port)).resolves.toEqual({ inspected: 1, repaired: 1 });
    expect(port.candidates).toHaveBeenCalledTimes(2);
    expect(port.repair).toHaveBeenCalledTimes(1);
  });

  it("propagates a delayed repair failure, stops later repairs, and delegates fresh rows next sweep", async () => {
    const first = candidate();
    const failing = candidate({ runId: "run-b" });
    const later = candidate({ runId: "run-c" });
    const fresh = candidate({ runId: "run-d", generation: 1 });
    const failure = deferred<"repaired" | "unchanged">();
    const entered = deferred<void>();
    const error = new Error("repair unavailable");
    const port = fixture([first, failing, later]);
    port.repair.mockImplementationOnce(async () => "repaired").mockImplementationOnce(async () => {
      entered.resolve();
      return failure.promise;
    });
    const operation = recoverConversationTurns(port);
    const rejection = expect(operation).rejects.toBe(error);
    await entered.promise;
    expect(port.repair.mock.calls.map(([row]) => row)).toEqual([first, failing]);
    failure.reject(error);
    await rejection;
    expect(port.candidates).toHaveBeenCalledTimes(1);
    expect(port.repair).toHaveBeenCalledTimes(2);
    port.candidates.mockResolvedValueOnce([fresh]);
    await expect(recoverConversationTurns(port)).resolves.toEqual({ inspected: 1, repaired: 1 });
    expect(port.candidates).toHaveBeenCalledTimes(2);
    expect(port.repair).toHaveBeenLastCalledWith(fresh, "EXECUTE");
  });

  it("stops at a later invalid candidate after awaiting preceding repair", async () => {
    const first = candidate();
    const port = fixture([first, candidate({ generation: -1 }), candidate({ runId: "later" })]);
    await expect(recoverConversationTurns(port)).rejects.toThrow("Invalid conversation recovery candidate");
    expect(port.repair).toHaveBeenCalledExactlyOnceWith(first, "EXECUTE");
  });

  it("re-queries an early decision and routes to RESUME only once the later snapshot is waiting", async () => {
    const early = candidate({ status: "WAITING", decisionReady: true });
    const waiting = { ...early, checkpointWaiting: true };
    const port = fixture([early]);
    port.repair.mockResolvedValueOnce("unchanged");
    await expect(recoverConversationTurns(port)).resolves.toEqual({ inspected: 1, repaired: 0 });
    expect(port.repair).toHaveBeenLastCalledWith(early, "WAIT_FOR_CHECKPOINT");
    port.candidates.mockResolvedValueOnce([waiting]);
    await expect(recoverConversationTurns(port)).resolves.toEqual({ inspected: 1, repaired: 1 });
    expect(port.candidates).toHaveBeenCalledTimes(2);
    expect(port.repair).toHaveBeenLastCalledWith(waiting, "RESUME");
  });

  it("delegates duplicate occurrences and repeated sweeps to the repair port without local deduplication", async () => {
    const row = candidate();
    const port = fixture([row, row]);
    port.repair.mockResolvedValueOnce("repaired").mockResolvedValueOnce("unchanged");
    await expect(recoverConversationTurns(port, 2)).resolves.toEqual({ inspected: 2, repaired: 1 });
    await expect(recoverConversationTurns(port, 2)).resolves.toEqual({ inspected: 2, repaired: 2 });
    expect(port.candidates).toHaveBeenCalledTimes(2);
    expect(port.repair.mock.calls).toEqual(Array.from({ length: 4 }, () => [row, "EXECUTE"]));
  });
});
