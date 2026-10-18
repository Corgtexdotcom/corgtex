import type { WorkflowJob, Prisma } from "@prisma/client";
import { prisma } from "@corgtex/shared";
import { invariant } from "./errors";
import { assertVariantGenerationClaim, createVariantModelControls, variantGenerationClaimStamp } from "./variant-model-attempt";

/** A private renewable claim for one removal generation. Only lockedAt changes;
 * owner, attempt, start, generation token, and the complete payload stay fixed. */
export function startBrainSourceRemovalAttempt(job: WorkflowJob, assertOriginalSources: () => Promise<void>) {
  let current = structuredClone(job);
  let stamp = variantGenerationClaimStamp(current);
  assertVariantGenerationClaim(stamp, current);
  let pending: Promise<void> | undefined;
  let stopped = false;
  const renew = () => {
    invariant(!stopped, 409, "SOURCE_CHANGED", "Removal generation has ended.");
    const previous = pending;
    const renewal = (async () => {
      // A provider send queues its own replay after any earlier timer renewal.
      // Its admitted source set may have grown while that renewal was pending.
      await previous;
      // Provider replay stays outside the transaction; never recapture roots.
      await assertOriginalSources();
      const renewed = await prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT id FROM "WorkflowJob" WHERE id = ${job.id} AND "workspaceId" = ${job.workspaceId} FOR UPDATE`;
        const live = await tx.workflowJob.findFirst({ where: { id: job.id, workspaceId: job.workspaceId, type: job.type } });
        assertVariantGenerationClaim(stamp, live);
        const nextLockedAt = new Date();
        const result = await tx.workflowJob.updateMany({ where: {
          id: current.id, workspaceId: current.workspaceId, type: current.type, status: "RUNNING",
          attempts: current.attempts, lockedBy: current.lockedBy, startedAt: current.startedAt,
          payload: { equals: current.payload as Prisma.InputJsonValue },
          lockedAt: { equals: current.lockedAt!, gt: new Date(nextLockedAt.getTime() - 300_000) },
        }, data: { lockedAt: nextLockedAt } });
        invariant(result.count === 1, 409, "SOURCE_CHANGED", "Removal generation lease changed.");
        return { ...current, lockedAt: nextLockedAt };
      });
      // A failed/rolled-back CAS can never advance the private expected stamp.
      current = renewed;
      stamp = variantGenerationClaimStamp(current);
    })().finally(() => { if (pending === renewal) pending = undefined; });
    pending = renewal;
    return renewal;
  };
  const attempt = createVariantModelControls(renew);
  const timer = setInterval(() => {
    if (pending) return;
    void attempt.controls.authorizeAttempt({ signal: attempt.controls.signal }).catch(() => undefined);
  }, 60_000);
  timer.unref?.();
  return {
    ...attempt,
    assertCurrent: (live: WorkflowJob | null) => assertVariantGenerationClaim(stamp, live),
    async stop() {
      stopped = true;
      clearInterval(timer);
      await pending;
      attempt.assertActive();
    },
  };
}
