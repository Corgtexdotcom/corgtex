import type { WorkflowJob } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { db } = vi.hoisted(() => ({ db: { $transaction: vi.fn(), $queryRaw: vi.fn(),
  workflowJob: { findFirst: vi.fn(), updateMany: vi.fn() } } }));
vi.mock("@corgtex/shared", () => ({ prisma: db }));
import { startBrainSourceRemovalAttempt } from "./brain-source-removal-attempt";
let job: WorkflowJob;
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks();
  job = { id: "job", workspaceId: "ws", type: "agent.brain-source-regenerate", status: "RUNNING", attempts: 1,
    lockedBy: "worker", lockedAt: new Date(), startedAt: new Date(), payload: { phase: "GENERATING", generationToken: "original" } } as unknown as WorkflowJob;
  db.$transaction.mockImplementation(async callback => callback(db)); db.$queryRaw.mockResolvedValue([]);
  db.workflowJob.findFirst.mockImplementation(async () => structuredClone(job));
  db.workflowJob.updateMany.mockImplementation(async ({ where, data }) => {
    expect(where).toMatchObject({ id: job.id, workspaceId: job.workspaceId, status: "RUNNING", attempts: 1,
      lockedBy: "worker", startedAt: job.startedAt, payload: { equals: job.payload }, lockedAt: { equals: job.lockedAt } });
    expect(Object.keys(data)).toEqual(["lockedAt"]); job = { ...job, ...data }; return { count: 1 };
  });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
describe("removal whole-operation heartbeat", () => {
  it("serializes a fresh provider replay after the timer and drains both before stop", async () => {
    let unblock!: () => void;
    const gate = new Promise<void>(resolve => { unblock = resolve; });
    const proof = vi.fn(async () => gate);
    const attempt = startBrainSourceRemovalAttempt(job, proof);
    vi.advanceTimersByTime(60_000);
    const send = attempt.controls.authorizeAttempt({ signal: attempt.controls.signal });
    let stopped = false; const stop = attempt.stop().then(() => { stopped = true; });
    await Promise.resolve(); expect(stopped).toBe(false); expect(proof).toHaveBeenCalledTimes(1);
    unblock(); await Promise.all([send, stop]);
    expect(db.workflowJob.updateMany).toHaveBeenCalledTimes(2);
    expect(proof).toHaveBeenCalledTimes(2);
    attempt.assertCurrent(job);
    vi.advanceTimersByTime(600_000); await Promise.resolve();
    expect(db.workflowJob.updateMany).toHaveBeenCalledTimes(2);
  });
  it("replays newly admitted roots when a timer is already waiting in its lease CAS", async () => {
    let unblock!: () => void;
    const gate = new Promise<void>(resolve => { unblock = resolve; });
    const originalUpdate = db.workflowJob.updateMany.getMockImplementation()!;
    db.workflowJob.updateMany.mockImplementationOnce(async args => {
      await gate;
      return originalUpdate(args);
    });
    let nextArticleRevoked = false;
    const failure = new Error("new article authority changed");
    const proof = vi.fn(async () => { if (nextArticleRevoked) throw failure; });
    const attempt = startBrainSourceRemovalAttempt(job, proof);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(db.workflowJob.updateMany).toHaveBeenCalledTimes(1);
    expect(proof).toHaveBeenCalledTimes(1);
    nextArticleRevoked = true;
    const send = attempt.controls.authorizeAttempt({ signal: attempt.controls.signal });
    const rejected = expect(send).rejects.toBe(failure);
    unblock();
    await rejected;
    expect(proof).toHaveBeenCalledTimes(2);
    expect(db.workflowJob.updateMany).toHaveBeenCalledTimes(1);
    expect(attempt.controls.signal.aborted).toBe(true);
    await expect(attempt.stop()).rejects.toBe(failure);
  });
  it("latches a failed CAS and does not retry or advance the private stamp", async () => {
    const original = structuredClone(job);
    db.workflowJob.updateMany.mockResolvedValue({ count: 0 });
    const attempt = startBrainSourceRemovalAttempt(job, async () => {});
    await expect(attempt.controls.authorizeAttempt({ signal: attempt.controls.signal })).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(attempt.controls.signal.aborted).toBe(true); expect(job).toEqual(original);
    db.workflowJob.updateMany.mockResolvedValue({ count: 1 });
    await expect(attempt.controls.authorizeAttempt({ signal: attempt.controls.signal })).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(db.workflowJob.updateMany).toHaveBeenCalledTimes(1);
    await expect(attempt.stop()).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  });
  it("aborts on asynchronous proof failure without an unhandled timer rejection", async () => {
    const error = new Error("proof unavailable");
    const attempt = startBrainSourceRemovalAttempt(job, async () => { throw error; });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(attempt.controls.signal.aborted).toBe(true);
    expect(db.workflowJob.updateMany).not.toHaveBeenCalled();
    await expect(attempt.stop()).rejects.toBe(error);
  });
});
