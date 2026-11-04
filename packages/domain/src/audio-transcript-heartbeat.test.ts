import { afterEach, describe, expect, it, vi } from "vitest";
import { startAudioTranscriptHeartbeat } from "./audio-transcript-heartbeat";

afterEach(() => vi.useRealTimers());
describe("audio attempt heartbeat", () => {
  it("renews through a storage/provider wait longer than five minutes and stops before completion", async () => {
    vi.useFakeTimers();
    const renew = vi.fn().mockResolvedValue(undefined);
    const heartbeat = startAudioTranscriptHeartbeat(renew);
    await vi.advanceTimersByTimeAsync(6 * 60_000);
    expect(renew).toHaveBeenCalledTimes(6);
    await heartbeat.authorizeAttempt();
    expect(renew).toHaveBeenCalledTimes(7);
    await heartbeat.stop();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(renew).toHaveBeenCalledTimes(7);
  });
  it("serializes timer and provider checks and waits for renewal before finalizing", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const renew = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
    const heartbeat = startAudioTranscriptHeartbeat(renew);
    await vi.advanceTimersByTimeAsync(60_000);
    const attempt = heartbeat.authorizeAttempt();
    let stopped = false;
    const stop = heartbeat.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    expect(renew).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([attempt, stop]);
    expect(stopped).toBe(true);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(renew).toHaveBeenCalledTimes(1);
  });
  it("aborts after a timer error, permanently denies further sends and rejects completion", async () => {
    vi.useFakeTimers();
    const error = new Error("Lease CAS failed");
    const renew = vi.fn().mockRejectedValue(error);
    const heartbeat = startAudioTranscriptHeartbeat(renew);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(heartbeat.signal.aborted).toBe(true);
    expect(() => heartbeat.assertActive()).toThrow(error);
    await expect(heartbeat.authorizeAttempt()).rejects.toBe(error);
    await expect(heartbeat.stop()).rejects.toBe(error);
    expect(renew).toHaveBeenCalledTimes(1);
  });
});
