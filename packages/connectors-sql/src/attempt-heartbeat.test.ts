import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startAttemptHeartbeat } from "./attempt-heartbeat";

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("SQL attempt heartbeat", () => {
  it("renews every minute without overlapping a slow renewal", async () => {
    let release!: () => void;
    const renew = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const heartbeat = startAttemptHeartbeat(renew);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(renew).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(renew).toHaveBeenCalledOnce();
    release();
    await heartbeat.assertHealthy();
    await heartbeat.stop();
  });

  it("waits for in-flight renewal before stopping and never renews after publication begins", async () => {
    let release!: () => void;
    const renew = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const heartbeat = startAttemptHeartbeat(renew);
    await vi.advanceTimersByTimeAsync(60_000);
    let stopped = false;
    const stopping = heartbeat.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release();
    await stopping;
    await vi.advanceTimersByTimeAsync(180_000);
    expect(renew).toHaveBeenCalledOnce();
    expect(stopped).toBe(true);
  });

  it("preserves the first failed renewal and aborts instead of reclaiming a new attempt", async () => {
    const error = new Error("SQL_INGESTION_FENCE_LOST");
    const renew = vi.fn().mockRejectedValue(error);
    const heartbeat = startAttemptHeartbeat(renew);
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(heartbeat.assertHealthy()).rejects.toBe(error);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(renew).toHaveBeenCalledOnce();
    await expect(heartbeat.stop()).rejects.toBe(error);
  });
});
