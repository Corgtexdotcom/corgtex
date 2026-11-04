import { AsyncLocalStorage } from "node:async_hooks";
import { isDeepStrictEqual } from "node:util";
import type { Prisma } from "@prisma/client";
import { prisma } from "@corgtex/shared";
import { AppError, invariant } from "../../../domain/src/errors";

export type EventKnowledgeSyncClaim = {
  id: string; workspaceId: string | null; type: string; payload: unknown; attempts: number;
  lockedBy: string | null; lockedAt: Date | null; startedAt: Date | null;
};
const LEASE_MS = 5 * 60_000;
const owners = new AsyncLocalStorage<EventKnowledgeSyncLease>();
const exclusiveOwner = new AsyncLocalStorage<EventKnowledgeSyncLease>();
export interface EventKnowledgeSyncLease {
  signal: AbortSignal;
  matches(claim: EventKnowledgeSyncClaim): boolean;
  assertActive(): void;
  assertCurrentRow(claim: EventKnowledgeSyncClaim | null): void;
  assertTransactionOwner(): void;
  sourceTransactionGuard<T>(operation: () => Promise<T>): Promise<T>;
  readGuard<T>(operation: () => Promise<T>): Promise<T>;
  settle(data: Prisma.WorkflowJobUpdateManyMutationInput): Promise<{count: number}>;
  run<T>(operation: () => Promise<T>): Promise<T>;
  stopAndDrain(): Promise<void>;
  dispose(): Promise<void>;
}
function recipe(row: EventKnowledgeSyncClaim): EventKnowledgeSyncClaim {
  return {id: row.id, workspaceId: row.workspaceId, type: row.type, payload: row.payload,
    attempts: row.attempts, lockedBy: row.lockedBy, lockedAt: row.lockedAt, startedAt: row.startedAt};
}

/** One server-owned attempt. Only a successful exact, unexpired CAS advances its
 * private stamp. Neither a handler nor settlement can adopt a later DB claim. */
export function createEventKnowledgeSyncLease(claim: EventKnowledgeSyncClaim) {
  invariant(claim.type === "knowledge.sync.event", 409, "SOURCE_CHANGED", "Event lease requires an Event indexing job.");
  const original = structuredClone(recipe(claim));
  let lockedAt = original.lockedAt && new Date(original.lockedAt);
  let failure: unknown;
  let stopped = false;
  let tail: Promise<unknown> = Promise.resolve();
  let renewing = false;
  const abort = new AbortController();
  const sameRecipe = (row: EventKnowledgeSyncClaim) => isDeepStrictEqual(
    {...row, lockedAt: null}, {...original, lockedAt: null});
  const fail = (error: unknown) => { failure ??= error; abort.abort(failure); return failure; };
  const assertActive = () => {
    if (failure) throw failure;
    try {
      invariant(lockedAt && original.lockedBy && original.startedAt && lockedAt.getTime() > Date.now() - LEASE_MS,
        409, "SOURCE_CHANGED", "Event indexing lease expired or was lost.");
    } catch (error) { throw fail(error); }
  };
  const where = (): Prisma.WorkflowJobWhereInput => ({id: original.id, workspaceId: original.workspaceId,
    type: original.type, status: "RUNNING", attempts: original.attempts, lockedBy: original.lockedBy,
    startedAt: original.startedAt, payload: {equals: original.payload as Prisma.InputJsonValue},
    lockedAt: {equals: lockedAt, gt: new Date(Date.now() - LEASE_MS)}});
  const exclusive = async <T>(operation: () => Promise<T>): Promise<T> => {
    if (exclusiveOwner.getStore() === owner) { assertActive(); return operation(); }
    const pending = tail.then(() => exclusiveOwner.run(owner, async () => {
      assertActive();
      return operation();
    }));
    tail = pending.catch(() => {});
    return pending;
  };
  const renew = async () => exclusive(async () => {
    if (stopped) return;
    try {
      const next = await prisma.$transaction(async tx => {
        const rows = await tx.$queryRaw<Array<EventKnowledgeSyncClaim & {status: string}>>`
          SELECT id, "workspaceId", type, payload, attempts, "lockedBy", "lockedAt", "startedAt", status
          FROM "WorkflowJob" WHERE id=${original.id} FOR UPDATE`;
        // Lock waits count toward expiry. Compute freshness and the next stamp
        // only after the row lock, never from a pre-wait cutoff.
        owner.assertCurrentRow(rows[0] ?? null);
        invariant(rows[0]?.status === "RUNNING", 409, "SOURCE_CHANGED", "Event indexing lease was replaced.");
        const stamp = new Date(Math.max(Date.now(), lockedAt!.getTime() + 1));
        const changed = await tx.workflowJob.updateMany({where: where(), data: {lockedAt: stamp}});
        invariant(changed.count === 1, 409, "SOURCE_CHANGED", "Event indexing lease was replaced.");
        return stamp;
      });
      lockedAt = next;
      assertActive();
    } catch (error) { throw fail(error); }
  });
  const owner: EventKnowledgeSyncLease = {
    signal: abort.signal,
    matches: (expected: EventKnowledgeSyncClaim) => isDeepStrictEqual(recipe(expected), original),
    assertActive,
    assertCurrentRow(row: EventKnowledgeSyncClaim | null) {
      assertActive();
      try {
        // Select only the immutable claim recipe; DB rows also carry bookkeeping.
        const recipe = row && {id: row.id, workspaceId: row.workspaceId, type: row.type, payload: row.payload,
          attempts: row.attempts, lockedBy: row.lockedBy, lockedAt: row.lockedAt, startedAt: row.startedAt};
        invariant(recipe && sameRecipe(recipe) && recipe.lockedAt?.getTime() === lockedAt?.getTime(),
          409, "SOURCE_CHANGED", "Event indexing lease was replaced.");
      } catch (error) { throw fail(error); }
    },
    assertTransactionOwner() {
      invariant(exclusiveOwner.getStore() === owner, 409, "SOURCE_CHANGED", "Event publication requires its serialized lease owner.");
      assertActive();
    },
    sourceTransactionGuard: exclusive,
    readGuard: exclusive,
    async settle(data: Prisma.WorkflowJobUpdateManyMutationInput) {
      await owner.dispose();
      if (failure) return {count: 0};
      try {
        return await exclusive(() => prisma.$transaction(async tx => {
          const rows = await tx.$queryRaw<Array<EventKnowledgeSyncClaim & {status: string}>>`
            SELECT id, "workspaceId", type, payload, attempts, "lockedBy", "lockedAt", "startedAt", status
            FROM "WorkflowJob" WHERE id=${original.id} FOR UPDATE`;
          owner.assertCurrentRow(rows[0] ?? null);
          invariant(rows[0]?.status === "RUNNING", 409, "SOURCE_CHANGED", "Event indexing lease was replaced.");
          return tx.workflowJob.updateMany({where: where(), data});
        }));
      } catch (error) {
        if (error instanceof AppError && error.code === "SOURCE_CHANGED") return {count: 0};
        throw error;
      }
    },
    async run<T>(operation: () => Promise<T>): Promise<T> {
      assertActive();
      const result = await owners.run(owner, operation);
      assertActive();
      return result;
    },
    async stopAndDrain() {
      stopped = true;
      clearInterval(timer);
      await tail;
      assertActive();
    },
    async dispose() { stopped = true; clearInterval(timer); await tail; },
  };
  const timer = setInterval(() => {
    if (stopped || failure || renewing) return;
    renewing = true;
    void renew().catch(fail).finally(() => { renewing = false; });
  }, 60_000);
  timer.unref?.();
  return owner;
}

export function currentEventKnowledgeSyncLease(claim: EventKnowledgeSyncClaim): EventKnowledgeSyncLease {
  const owner = owners.getStore();
  invariant(owner && owner.matches(claim), 409, "SOURCE_CHANGED", "Event indexing requires its original lease owner.");
  return owner;
}
export async function withEventKnowledgeSyncLease<T>(claim: EventKnowledgeSyncClaim, operation: () => Promise<T>): Promise<T> {
  const existing = owners.getStore();
  if (existing) {
    invariant(existing.matches(claim), 409, "SOURCE_CHANGED", "Event indexing claim changed.");
    return operation();
  }
  const owner = createEventKnowledgeSyncLease(claim);
  try { return await owner.run(operation); }
  finally { await owner.dispose(); }
}
