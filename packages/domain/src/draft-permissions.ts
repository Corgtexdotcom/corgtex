import type { Prisma } from "@prisma/client";
import type { AppActor, MembershipSummary } from "@corgtex/shared";
import { requireWorkspaceMembership } from "./auth";
import { AppError, invariant } from "./errors";

export type DraftManageableRecord = {
  workspaceId: string;
  authorUserId?: string | null;
  requesterUserId?: string | null;
  ownerMemberId?: string | null;
  archivedAt?: Date | null;
};

export function canManageDraftRecord(
  actor: AppActor,
  membership: MembershipSummary | null | undefined,
  record: DraftManageableRecord,
) {
  if (actor.kind === "agent") return true;
  if (!membership?.isActive) return false;
  if (membership.role === "ADMIN") return true;
  if (record.authorUserId && record.authorUserId === actor.user.id) return true;
  if (record.requesterUserId && record.requesterUserId === actor.user.id) return true;
  if (record.ownerMemberId && record.ownerMemberId === membership.id) return true;
  return false;
}

export async function requireDraftManager(params: {
  actor: AppActor;
  workspaceId: string;
  record: DraftManageableRecord;
  resolvedMembership?: MembershipSummary | null;
  tx?: Prisma.TransactionClient;
}) {
  invariant(params.record.workspaceId === params.workspaceId, 404, "NOT_FOUND", "Record not found.");
  invariant(!params.record.archivedAt, 400, "INVALID_STATE", "Archived records cannot be managed as drafts.");

  const membership = await requireWorkspaceMembership({
    actor: params.actor,
    workspaceId: params.workspaceId,
    resolvedMembership: params.resolvedMembership,
    tx: params.tx,
  });

  if (!canManageDraftRecord(params.actor, membership, params.record)) {
    throw new AppError(403, "FORBIDDEN", "Only the draft owner, workspace admins, or agents can manage this draft.");
  }

  return membership;
}
