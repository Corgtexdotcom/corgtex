import type { Prisma } from "@prisma/client";
import { prisma } from "@corgtex/shared";
import { invariant } from "./errors";
import type { LineageInput } from "./source-lineage";
import { assertSourceCommitOutputHeadReserved, assertSourceCommitTransactionCompatible,
  hasActiveSourceCommitLockPlan, sourceCommitHeadAdvisoryKey } from "./source-commit-lock-plan";

declare const reservationBrand: unique symbol;
/** Lock intent only: this is never a content, permission or epoch receipt. */
export type ArtifactWriteHeadReservation = Readonly<{ [reservationBrand]: true }>;
type Reservation = { tx: Prisma.TransactionClient; workspaceId: string; keys: readonly string[] };
type Held = { keys: Set<string>; tail: Promise<void> };
const reservations = new WeakMap<object, Reservation>();
const transactions = new WeakMap<object, Held>();
const MAX_TARGETS = 10_000;

function targetsFor(tx: Prisma.TransactionClient, workspaceId: string, targets: readonly LineageInput[]) {
  // An active plan on another client must never fall through to legacy SQL.
  assertSourceCommitTransactionCompatible(tx);
  invariant(tx !== prisma && typeof tx?.$executeRaw === "function", 409, "SOURCE_LOCK_UNAVAILABLE", "Write heads require the caller's transaction.");
  invariant(typeof workspaceId === "string" && workspaceId.length > 0 && Array.isArray(targets)
    && targets.length <= MAX_TARGETS, 409, "SOURCE_LOCK_UNAVAILABLE", "Write head targets must be bounded and workspace-scoped.");
  const inputs = targets.map(target => {
    invariant(target && typeof target.kind === "string" && typeof target.id === "string" && target.id.length > 0,
      409, "SOURCE_LOCK_UNSUPPORTED", "A write head requires an exact source identity.");
    return Object.freeze({kind: target.kind, id: target.id});
  });
  const keys = [...new Set(inputs.map(input => sourceCommitHeadAdvisoryKey(workspaceId, input)))].sort();
  return {inputs, keys};
}
function heldFor(tx: Prisma.TransactionClient): Held {
  let held = transactions.get(tx);
  if (!held) { held = {keys: new Set(), tail: Promise.resolve()}; transactions.set(tx, held); }
  return held;
}
function receipt(tx: Prisma.TransactionClient, workspaceId: string, keys: readonly string[]) {
  const token = Object.freeze({}) as ArtifactWriteHeadReservation;
  reservations.set(token, {tx, workspaceId, keys: Object.freeze([...keys])});
  return token;
}

/** Reserve the COMPLETE known output set before its first body/advisory row lock
 * or source capture. Callers retain responsibility for discovering that set.
 * Later calls may reuse held heads; they cannot repair an earlier lock inversion.
 * SQL is sequential and canonical physical aliases share one exclusive head. */
export async function reserveArtifactWriteHeads(tx: Prisma.TransactionClient, workspaceId: string,
  targets: readonly LineageInput[]): Promise<ArtifactWriteHeadReservation> {
  const {inputs, keys} = targetsFor(tx, workspaceId, targets);
  if (hasActiveSourceCommitLockPlan(tx)) {
    // Every logical output must be declared, including aliases of a held row.
    for (const input of inputs) assertSourceCommitOutputHeadReserved(tx, workspaceId, input);
    for (const key of keys) heldFor(tx).keys.add(key);
    return receipt(tx, workspaceId, keys);
  }
  const held = heldFor(tx);
  const acquiring = held.tail.then(async () => {
    assertSourceCommitTransactionCompatible(tx);
    for (const key of keys) {
      if (held.keys.has(key)) continue;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
      held.keys.add(key);
    }
  });
  // Serialize concurrent calls on the same transaction. A failed reservation
  // remains failed; a later publication cannot mistake a partial set for success.
  held.tail = acquiring;
  await acquiring;
  return receipt(tx, workspaceId, keys);
}

/** Reusable transaction-bound intent check; no read authority is conferred. */
export function assertArtifactWriteHeadsReserved(tx: Prisma.TransactionClient, workspaceId: string,
  targets: readonly LineageInput[], token?: ArtifactWriteHeadReservation): void {
  const {inputs, keys} = targetsFor(tx, workspaceId, targets);
  if (hasActiveSourceCommitLockPlan(tx)) {
    for (const input of inputs) assertSourceCommitOutputHeadReserved(tx, workspaceId, input);
  }
  if (token !== undefined) {
    const saved = reservations.get(token);
    invariant(saved?.tx === tx && saved.workspaceId === workspaceId && keys.every(key => saved.keys.includes(key)),
      409, "SOURCE_LOCK_UNCOVERED", "Write head reservation belongs to another transaction or target set.");
  } else invariant(keys.every(key => transactions.get(tx)?.keys.has(key)) || hasActiveSourceCommitLockPlan(tx),
    409, "SOURCE_LOCK_UNCOVERED", "Output heads must be reserved before body mutation.");
}
