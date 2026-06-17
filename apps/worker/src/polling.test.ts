import { describe, expect, it } from "vitest";
import { getNextPollIntervalMs, getWorkerPollOutcome } from "./polling";

describe("worker polling", () => {
  it("fast-drains when a job batch is full", () => {
    const outcome = getWorkerPollOutcome({
      dispatched: 0,
      eventBatchSize: 25,
      processed: 25,
      jobBatchSize: 25,
      scheduled: 0,
      scheduledPeriodic: 0,
      scheduledDrip: 0,
      finalized: 0,
    });

    expect(outcome).toEqual({ workDone: true, fastDrain: true });
    expect(getNextPollIntervalMs({
      outcome,
      pollIntervalMs: 5_000,
      maxPollIntervalMs: 30_000,
      currentPollIntervalMs: 5_000,
    })).toBe(0);
  });

  it("fast-drains when an event batch is full", () => {
    const outcome = getWorkerPollOutcome({
      dispatched: 25,
      eventBatchSize: 25,
      processed: 0,
      jobBatchSize: 25,
      scheduled: 0,
      scheduledPeriodic: 0,
      scheduledDrip: 0,
      finalized: 0,
    });

    expect(outcome).toEqual({ workDone: true, fastDrain: true });
  });

  it("resets to the configured poll interval after partial work", () => {
    const outcome = getWorkerPollOutcome({
      dispatched: 0,
      eventBatchSize: 25,
      processed: 3,
      jobBatchSize: 25,
      scheduled: 0,
      scheduledPeriodic: 0,
      scheduledDrip: 0,
      finalized: 0,
    });

    expect(outcome).toEqual({ workDone: true, fastDrain: false });
    expect(getNextPollIntervalMs({
      outcome,
      pollIntervalMs: 5_000,
      maxPollIntervalMs: 30_000,
      currentPollIntervalMs: 10_000,
    })).toBe(5_000);
  });

  it("backs off idle ticks up to the configured maximum", () => {
    const outcome = getWorkerPollOutcome({
      dispatched: 0,
      eventBatchSize: 25,
      processed: 0,
      jobBatchSize: 25,
      scheduled: 0,
      scheduledPeriodic: 0,
      scheduledDrip: 0,
      finalized: 0,
    });

    expect(outcome).toEqual({ workDone: false, fastDrain: false });
    expect(getNextPollIntervalMs({
      outcome,
      pollIntervalMs: 5_000,
      maxPollIntervalMs: 30_000,
      currentPollIntervalMs: 20_000,
    })).toBe(30_000);
  });

  it("backs off from the configured poll interval after a fast-drain tick goes idle", () => {
    const outcome = getWorkerPollOutcome({
      dispatched: 0,
      eventBatchSize: 25,
      processed: 0,
      jobBatchSize: 25,
      scheduled: 0,
      scheduledPeriodic: 0,
      scheduledDrip: 0,
      finalized: 0,
    });

    expect(getNextPollIntervalMs({
      outcome,
      pollIntervalMs: 5_000,
      maxPollIntervalMs: 30_000,
      currentPollIntervalMs: 0,
    })).toBe(5_000);
  });
});
