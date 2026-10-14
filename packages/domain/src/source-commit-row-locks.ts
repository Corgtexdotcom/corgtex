import { Prisma } from "@prisma/client";
import { invariant } from "./errors";
import { assertSourceCommitAmbientPolicyCovered, assertSourceCommitPredicateRowsCovered,
  assertSourceCommitRowCovered, hasActiveSourceCommitLockPlan } from "./source-commit-lock-plan";
import { sourceAuthorityDelegate, SOURCE_AUTHORITY_TABLES } from "./source-authority-edges";
import type { McpOrigin } from "../../shared/src/mcp-context";

export function sourceAuthorityRowAlreadyLocked(tx: Prisma.TransactionClient,
  table: string, id: string, mode: "SHARE" | "UPDATE" = "SHARE"): boolean {
  if (!hasActiveSourceCommitLockPlan(tx)) return false;
  assertSourceCommitRowCovered(tx, table, id, mode);
  return true;
}

/** Legacy standalone adapters still take their physical locks. Under an outer
 * source plan these rows are already held at the required strongest mode. */
export async function lockSourceAuthorityRow(tx: Prisma.TransactionClient, table: string, id: string,
  workspaceId: string | undefined, mode: "SHARE" | "UPDATE" = "SHARE"): Promise<void> {
  if (hasActiveSourceCommitLockPlan(tx)) {
    assertSourceCommitRowCovered(tx, table, id, mode);
    return;
  }
  invariant(SOURCE_AUTHORITY_TABLES.includes(table), 409, "SOURCE_LOCK_UNSUPPORTED", "Source lock table is unavailable.");
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM ${Prisma.raw(`"${table}"`)} WHERE "id" = ${id}
    ${workspaceId === undefined ? Prisma.empty : Prisma.sql`AND "workspaceId" = ${workspaceId}`}
    ${Prisma.raw(mode === "UPDATE" ? "FOR UPDATE" : "FOR SHARE")}`);
}

/** The predicate and its exact result set must have been discovered together.
 * Checking coverage takes no later physical lock or authority capability. */
export async function lockSourceAuthorityPredicate(tx: Prisma.TransactionClient, table: string,
  where: Record<string, unknown>, legacyLock: () => Promise<unknown>): Promise<void> {
  if (!hasActiveSourceCommitLockPlan(tx)) { await legacyLock(); return; }
  const rows = await sourceAuthorityDelegate(tx, table).findMany({ where, select: { id: true } });
  const ids = rows.map(row => {
    invariant(typeof row.id === "string", 409, "SOURCE_LOCK_UNCOVERED", "Source predicate identity is unavailable.");
    return row.id;
  });
  assertSourceCommitPredicateRowsCovered(tx, table, where, ids);
  for (const id of ids) assertSourceCommitRowCovered(tx, table, id);
}

/** Domain validates coverage before entering Shared's existing OAuth epoch
 * checker, preserving the Shared→Domain dependency boundary. */
export async function assertSourceCommitMcpOriginCovered(tx: Prisma.TransactionClient,
  workspaceId: string, origin: McpOrigin): Promise<void> {
  if (!hasActiveSourceCommitLockPlan(tx)) return;
  invariant(origin.workspaceId === workspaceId, 409, "SOURCE_LOCK_UNCOVERED", "Serving grant workspace changed.");
  if (origin.kind === "agent") {
    assertSourceCommitRowCovered(tx, "AgentCredential", origin.id);
    return;
  }
  assertSourceCommitRowCovered(tx, "McpOAuthAccessToken", origin.id);
  const token = await tx.mcpOAuthAccessToken.findFirst({ where: { id: origin.id, workspaceId }, select: { clientId: true } });
  invariant(token, 409, "SOURCE_LOCK_UNCOVERED", "Serving grant is unavailable.");
  assertSourceCommitRowCovered(tx, "McpOAuthClient", token.clientId);
  assertSourceCommitAmbientPolicyCovered(tx, workspaceId,
    { kind: "McpOAuthGrantPolicy", id: origin.id, epoch: origin.grantEpoch ?? "" });
}
