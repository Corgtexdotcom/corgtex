import type { Prisma } from "@prisma/client";
import { prisma } from "@corgtex/shared";

// Reserve process memory before claiming any jobs. Production ticks already run
// serially; this FIFO also covers overlapping callers without preclaiming work.
let admissionTail: Promise<void> = Promise.resolve();
export async function withSqlJobAdmission<T>(run: () => Promise<T>): Promise<T> {
  const previous = admissionTail;
  let release!: () => void;
  admissionTail = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try { return await run(); } finally { release(); }
}

export interface SqlJobIdentity {
  id: string;
  workspaceId: string;
  lockedBy: string;
  attempts: number;
  sourceId: string;
}

export function startSqlJobLease(job: SqlJobIdentity) {
  let pending: Promise<void> | undefined;
  let failure: unknown;
  let stopped = false;
  const signal = new AbortController();
  const lost = () => new Error("SQL_WORKFLOW_LEASE_LOST");
  const remember = (error: unknown) => {
    failure ??= error;
    signal.abort(failure);
  };
  async function renew() {
    const rows = await prisma.$queryRaw<{ id: string }[]>`
      UPDATE "WorkflowJob" SET "lockedAt" = clock_timestamp()
      WHERE id = ${job.id} AND "workspaceId" = ${job.workspaceId}
        AND type = 'data-source.sync' AND status = 'RUNNING'
        AND "lockedBy" = ${job.lockedBy} AND attempts = ${job.attempts}
        AND payload->>'sourceId' = ${job.sourceId}
        AND "lockedAt" > clock_timestamp() - interval '5 minutes'
      RETURNING id`;
    if (rows.length !== 1) throw lost();
  }
  const timer = setInterval(() => {
    if (stopped || failure || pending) return;
    pending = renew().catch(remember).finally(() => { pending = undefined; });
  }, 60_000);
  timer.unref();
  async function stop() {
    stopped = true;
    clearInterval(timer);
    await pending;
  }
  return {
    workspaceId: job.workspaceId,
    signal: signal.signal,
    async assertCurrent(tx?: Prisma.TransactionClient) {
      await pending;
      if (failure) throw failure;
      // A publication callback holds this row until commit. A stale reclaimer
      // cannot cross the same transaction's cursor, chunk and success-log writes.
      const rows = tx ? await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM "WorkflowJob" WHERE id = ${job.id} AND "workspaceId" = ${job.workspaceId}
          AND type = 'data-source.sync' AND status = 'RUNNING'
          AND "lockedBy" = ${job.lockedBy} AND attempts = ${job.attempts}
          AND payload->>'sourceId' = ${job.sourceId}
          AND "lockedAt" > clock_timestamp() - interval '5 minutes' FOR UPDATE`
        : await prisma.$queryRaw<{ id: string }[]>`
        SELECT id FROM "WorkflowJob" WHERE id = ${job.id} AND "workspaceId" = ${job.workspaceId}
          AND type = 'data-source.sync' AND status = 'RUNNING'
          AND "lockedBy" = ${job.lockedBy} AND attempts = ${job.attempts}
          AND payload->>'sourceId' = ${job.sourceId}
          AND "lockedAt" > clock_timestamp() - interval '5 minutes'`;
      if (rows.length !== 1) { remember(lost()); throw failure; }
    },
    async beforePublication() {
      await stop();
      if (failure) throw failure;
      // Renew once before the bounded publication TX; no timer waits on a row
      // locked by that transaction. The existing five-minute lease is unchanged.
      try { await renew(); } catch (error) { remember(error); throw error; }
    },
    stop,
  };
}
