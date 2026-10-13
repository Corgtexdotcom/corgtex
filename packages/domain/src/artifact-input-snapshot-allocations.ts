import { AsyncLocalStorage } from "node:async_hooks";
import type { Prisma } from "@prisma/client";
import { prisma, type AppActor } from "@corgtex/shared";
import { invariant } from "./errors";
import { assertSourceCommitOutputHeadReserved, assertSourceCommitTransactionCompatible,
  assertSourceCommitSnapshotInputCovered, hasActiveSourceCommitLockPlan } from "./source-commit-lock-plan";
import type { LineageRoot } from "./source-lineage";

export type ArtifactInputSnapshotAllocation = Readonly<{ input: LineageRoot; id: string }>;
type Scope = { actor: AppActor; workspaceId: string; tx: Prisma.TransactionClient;
  active: boolean; pending: Map<string, string[]>; used: Map<string, string> };
const allocations = new AsyncLocalStorage<Scope>();
const key = (input: LineageRoot) => JSON.stringify([input.kind, input.id, input.fingerprint]);

/** Coordinates preallocated OUTPUT identities. It grants no source authority;
 * the source plan and snapshot constructor still validate every original input. */
export async function withArtifactInputSnapshotAllocations<T>(actor: AppActor, workspaceId: string,
  tx: Prisma.TransactionClient, submitted: readonly ArtifactInputSnapshotAllocation[], work: () => Promise<T>): Promise<T> {
  assertSourceCommitTransactionCompatible(tx);
  invariant(tx !== prisma && !allocations.getStore(), 409, "SOURCE_LOCK_UNCOVERED",
    "Snapshot allocation requires its exact interactive writer.");
  const pending = new Map<string, string[]>(), ids = new Set<string>();
  for (const allocation of structuredClone([...submitted])) {
    invariant(typeof allocation.id === "string" && allocation.id.length > 0 && allocation.id.length <= 1024
      && !ids.has(allocation.id) && typeof allocation.input.id === "string" && allocation.input.id.length > 0
      && /^[a-f0-9]{64}$/.test(allocation.input.fingerprint),
    409, "SOURCE_LOCK_UNCOVERED", "Snapshot output allocations must be exact and unique.");
    ids.add(allocation.id);
    const inputKey = key(allocation.input), queued = pending.get(inputKey) ?? [];
    queued.push(allocation.id); pending.set(inputKey, queued);
  }
  const scope: Scope = { actor, workspaceId, tx, active: true, pending, used: new Map() };
  return allocations.run(scope, async () => {
    try { return await work(); }
    finally { scope.active = false; }
  });
}

/** Internal snapshot insertion seam. Automatic IDs are allowed only outside a
 * source plan; planned writers must hold every exact newborn head before DML. */
export function allocateArtifactInputSnapshotId(actor: AppActor, workspaceId: string,
  tx: Prisma.TransactionClient, input: LineageRoot): string | undefined {
  assertSourceCommitTransactionCompatible(tx);
  const scope = allocations.getStore();
  if (!scope) {
    invariant(!hasActiveSourceCommitLockPlan(tx), 409, "SOURCE_LOCK_UNCOVERED",
      "Planned snapshot writes require preallocated output identities.");
    return undefined;
  }
  invariant(scope.active && scope.actor === actor && scope.workspaceId === workspaceId && scope.tx === tx,
    409, "SOURCE_LOCK_UNCOVERED", "Snapshot allocation belongs to another writer.");
  const inputKey = key(input);
  const id = scope.pending.get(inputKey)?.shift() ?? scope.used.get(inputKey);
  invariant(id, 409, "SOURCE_LOCK_UNCOVERED", "Snapshot output identity was not preallocated for this input revision.");
  if (hasActiveSourceCommitLockPlan(tx)) {
    assertSourceCommitOutputHeadReserved(tx, workspaceId, { kind: "ArtifactInputSnapshot", id });
    assertSourceCommitSnapshotInputCovered(tx, workspaceId, id, input);
  }
  scope.used.set(inputKey, id);
  return id;
}
