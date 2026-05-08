import type { AppActor, MembershipSummary } from "@corgtex/shared";
import type { Prisma } from "@prisma/client";
import { invariant } from "./errors";
import { privacyFilter } from "./privacy";

export async function resolveWorkspaceProposalLink(
  tx: Prisma.TransactionClient,
  actor: AppActor,
  membership: MembershipSummary | null,
  workspaceId: string,
  proposalId?: string | null,
) {
  const normalizedProposalId = proposalId?.trim();
  if (!normalizedProposalId) return null;

  const proposal = await tx.proposal.findFirst({
    where: {
      id: normalizedProposalId,
      workspaceId,
      archivedAt: null,
      ...privacyFilter(actor, membership),
    },
    select: { id: true },
  });

  invariant(proposal, 404, "NOT_FOUND", "Linked proposal not found.");
  return proposal.id;
}
