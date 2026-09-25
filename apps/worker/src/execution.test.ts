import { describe, expect, it, vi } from "vitest";
import { parseSchedulerCadenceMinutes, parseWorkerExecutionMode, runWorkerCycle, type WorkerOperations } from "./execution";

function fixture() {
  const calls: string[] = [];
  const operations = Object.fromEntries(["finalize", "dispatch", "process", "daily", "periodic", "drip"].map((name, index) => [name, vi.fn(async () => { calls.push(name); return index + 1; })])) as unknown as WorkerOperations;
  return { calls, operations };
}

describe("worker execution modes", () => {
  it("defaults to continuous and rejects explicit malformed modes", () => {
    expect(parseWorkerExecutionMode(undefined)).toBe("continuous");
    for (const mode of ["continuous", "queue-only", "scheduler-once"] as const) expect(parseWorkerExecutionMode(mode)).toBe(mode);
    for (const mode of ["", "scheduler", "CONTINUOUS", "queue-only "]) expect(() => parseWorkerExecutionMode(mode)).toThrow("Invalid WORKER_EXECUTION_MODE");
  });
  it("accepts only the plan-bound scheduler cadences", () => {
    expect(parseSchedulerCadenceMinutes(undefined)).toBe(1);
    expect(parseSchedulerCadenceMinutes("1")).toBe(1);
    expect(parseSchedulerCadenceMinutes("5")).toBe(5);
    for (const value of ["", "0", "2", "10", "5 "]) expect(() => parseSchedulerCadenceMinutes(value)).toThrow("Invalid WORKER_SCHEDULER_CADENCE_MINUTES");
  });
  it("preserves the complete continuous cycle and order", async () => {
    const { calls, operations } = fixture();
    expect(await runWorkerCycle("continuous", operations)).toEqual({ finalized: 1, dispatched: 2, processed: 3, scheduled: 4, scheduledPeriodic: 5, scheduledDrip: 6 });
    expect(calls).toEqual(["finalize", "dispatch", "process", "daily", "periodic", "drip"]);
  });
  it("queue-only never finalizes approvals or schedules work", async () => {
    const { calls, operations } = fixture();
    expect(await runWorkerCycle("queue-only", operations)).toEqual({ finalized: 0, dispatched: 2, processed: 3, scheduled: 0, scheduledPeriodic: 0, scheduledDrip: 0 });
    expect(calls).toEqual(["dispatch", "process"]);
  });
  it("scheduler-once never dispatches events or consumes jobs", async () => {
    const { calls, operations } = fixture();
    expect(await runWorkerCycle("scheduler-once", operations)).toEqual({ finalized: 1, dispatched: 0, processed: 0, scheduled: 4, scheduledPeriodic: 5, scheduledDrip: 6 });
    expect(calls).toEqual(["finalize", "daily", "periodic", "drip"]);
  });
  it("propagates scheduling failure instead of reporting a successful cycle", async () => {
    const { calls, operations } = fixture();
    operations.daily = vi.fn().mockRejectedValue(new Error("failed"));
    await expect(runWorkerCycle("scheduler-once", operations)).rejects.toThrow("failed");
    expect(calls).toEqual(["finalize"]);
    expect(operations.periodic).not.toHaveBeenCalled();
    expect(operations.drip).not.toHaveBeenCalled();
  });
});
