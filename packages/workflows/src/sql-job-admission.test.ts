import { afterEach, describe, expect, it, vi } from "vitest";
const query = vi.hoisted(() => vi.fn());
vi.mock("@corgtex/shared", () => ({ prisma: { $queryRaw: query } }));
import { startSqlJobLease, withSqlJobAdmission } from "./sql-job-admission";

const job = { id: "job", workspaceId: "workspace", lockedBy: "worker", attempts: 2, sourceId: "source" };
afterEach(() => { vi.useRealTimers(); query.mockReset(); });

describe("SQL job memory admission", () => {
  it("queues before claiming, preserves FIFO, and releases after failure", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const order: string[] = [];
    const first = withSqlJobAdmission(async () => { order.push("nonSQL start"); await gate; order.push("nonSQL end"); });
    const second = withSqlJobAdmission(async () => { order.push("SQL"); throw new Error("failed SQL"); });
    const failed = expect(second).rejects.toThrow("failed SQL");
    const third = withSqlJobAdmission(async () => { order.push("next nonSQL"); });
    await Promise.resolve();
    expect(order).toEqual(["nonSQL start"]);
    release();
    await Promise.all([first, failed, third]);
    expect(order).toEqual(["nonSQL start", "nonSQL end", "SQL", "next nonSQL"]);
  });

  it("latches failed renewal, aborts execution and never refreshes a reclaimed lease", async () => {
    vi.useFakeTimers();
    query.mockResolvedValueOnce([{ id: "job" }]).mockResolvedValue([]);
    const lease = startSqlJobLease(job);
    await lease.assertCurrent();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(lease.signal.aborted).toBe(true);
    await expect(lease.assertCurrent()).rejects.toThrow("SQL_WORKFLOW_LEASE_LOST");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(query).toHaveBeenCalledTimes(2);
    await lease.stop();
  });

  it("quiesces heartbeat before publication and locks the exact attempt in its real transaction", async () => {
    vi.useFakeTimers();
    query.mockResolvedValue([{ id: "job" }]);
    const lease = startSqlJobLease(job);
    await lease.beforePublication();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(query).toHaveBeenCalledTimes(1);
    const txQuery = vi.fn().mockResolvedValue([{ id: "job" }]);
    await lease.assertCurrent({ $queryRaw: txQuery } as never);
    const [strings, ...values] = txQuery.mock.calls[0];
    expect(strings.join("?")).toContain("FOR UPDATE");
    expect(values).toEqual([job.id, job.workspaceId, job.lockedBy, job.attempts, job.sourceId]);
    txQuery.mockResolvedValue([]);
    await expect(lease.assertCurrent({ $queryRaw: txQuery } as never)).rejects.toThrow("SQL_WORKFLOW_LEASE_LOST");
    await lease.stop();
  });
});
