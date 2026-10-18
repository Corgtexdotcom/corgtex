import type { Prisma } from "@prisma/client";
import type { AppActor, MembershipSummary } from "@corgtex/shared";
import { requireWorkspaceMembership } from "./auth";
import { AppError, invariant } from "./errors";
import { getMcpToolInputRoots } from "./mcp-tool-input-context";
import { isArtifactInputProofReadable, type LineageRoot } from "./source-lineage";

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
  // A bearer credential or service label is not a current human delegation.
  if (actor.kind !== "user" || !membership?.isActive) return false;
  if (membership.workspaceId !== record.workspaceId || membership.userId !== actor.user.id) return false;
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
    tx: params.tx,
  });

  if (!canManageDraftRecord(params.actor, membership, params.record)) {
    throw new AppError(403, "FORBIDDEN", "Only the draft owner or a current workspace administrator can manage this draft.");
  }

  return membership;
}

/** Admit actual creation inputs before duplicate reads, generation or persistence. */
export async function requireCreationInputRoots(params: {
  actor: AppActor;
  workspaceId: string;
  isPrivate: boolean;
  roots?: readonly LineageRoot[];
  tx?: Prisma.TransactionClient;
}): Promise<LineageRoot[] | undefined> {
  const roots = new Map<string, LineageRoot>();
  for (const root of [...(params.roots ?? []), ...getMcpToolInputRoots(params.actor, params.workspaceId)]) {
    const key = `${root.kind}:${root.id}`;
    invariant(!roots.has(key) || roots.get(key)!.fingerprint === root.fingerprint, 409, "SOURCE_CHANGED", "Creation input revisions conflict.");
    roots.set(key, root);
  }
  invariant(params.actor.kind === "user" || !params.isPrivate, 403, "PRIVATE_AGENT_ARTIFACT_UNSUPPORTED",
    "Private drafts require a current human owner; credentials cannot own private drafts.");
  const complete = [...roots.values()];
  invariant(params.actor.kind === "user" || complete.length > 0, 409, "UNKNOWN_LINEAGE", "Agent creation requires complete captured inputs.");
  if (complete.length) invariant(await isArtifactInputProofReadable(params.actor, params.workspaceId, complete, params.tx),
    409, "SOURCE_CHANGED", "Creation inputs are no longer accessible.");
  return complete.length ? complete : undefined;
}
