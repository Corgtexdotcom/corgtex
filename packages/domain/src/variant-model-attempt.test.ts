import { describe, expect, it, vi } from "vitest";
import { createVariantModelControls, variantGenerationClaimStamp, assertVariantGenerationClaim } from "./variant-model-attempt";

describe("variant model attempt cancellation", () => {
  it("checks gateway cancellation before authority work", async () => {
    const check = vi.fn(async () => {}); const attempt = createVariantModelControls(check);
    const controller = new AbortController(); const error = new Error("deadline"); controller.abort(error);
    await expect(attempt.controls.authorizeAttempt({ signal: controller.signal })).rejects.toBe(error);
    expect(check).not.toHaveBeenCalled();
    expect(() => attempt.assertActive()).toThrow(error);
  });
  it("checks gateway cancellation after asynchronous authority work", async () => {
    const controller = new AbortController(); const error = new Error("deadline");
    const attempt = createVariantModelControls(async () => { await Promise.resolve(); controller.abort(error); });
    await expect(attempt.controls.authorizeAttempt({ signal: controller.signal })).rejects.toBe(error);
    expect(attempt.controls.signal.aborted).toBe(true);
    expect(() => attempt.assertActive()).toThrow(error);
  });
  it("latches a transient authority failure even when an adapter tries again", async () => {
    const error = new Error("proof storage unavailable"); const check = vi.fn(async (): Promise<void> => { throw error; });
    const attempt = createVariantModelControls(check);
    await expect(attempt.controls.authorizeAttempt({ signal: new AbortController().signal })).rejects.toBe(error);
    check.mockResolvedValue(undefined);
    await expect(attempt.controls.authorizeAttempt({ signal: new AbortController().signal })).rejects.toBe(error);
    expect(check).toHaveBeenCalledTimes(1);
    expect(() => attempt.assertActive()).toThrow(error);
  });
});


it("preserves exact JSON claim semantics across PostgreSQL JSONB key ordering", () => {
  const job = { id: "job", workspaceId: "ws", type: "agent.brain-article-variant", status: "RUNNING" as const,
    attempts: 1, lockedBy: "worker", lockedAt: new Date(), startedAt: new Date(),
    payload: { phase: "GENERATING", generationToken: "original", nested: { z: 1, a: 2 } } };
  const stamp = variantGenerationClaimStamp(job);
  expect(() => assertVariantGenerationClaim(stamp, { ...job,
    payload: { nested: { a: 2, z: 1 }, generationToken: "original", phase: "GENERATING" } })).not.toThrow();
  expect(() => assertVariantGenerationClaim(stamp, { ...job, payload: { ...job.payload, generationToken: "replacement" } })).toThrow();
});
