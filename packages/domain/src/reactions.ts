import { prisma } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import { requireWorkspaceMembership } from "./auth";
import { appendEvents } from "./events";
import { invariant } from "./errors";

export function normalizeProposalReaction(reaction: string) {
  const normalized = reaction.trim().toUpperCase();
  invariant(normalized.length > 0, 400, "INVALID_INPUT", "reaction is required.");
  invariant(normalized.length <= 32, 400, "INVALID_INPUT", "reaction must be 32 characters or fewer.");
  return normalized;
}

export async function listProposalReactions(workspaceId: string, proposalId: string) {
  const proposal = await prisma.proposal.findUnique({
    where: { id: proposalId },
    select: { workspaceId: true },
  });
  invariant(proposal && proposal.workspaceId === workspaceId, 404, "NOT_FOUND", "Proposal not found.");

  return prisma.proposalReaction.findMany({
    where: { proposalId },
    include: {
      user: {
        select: {
          id: true,
          email: true,
          displayName: true,
        },
      },
    },
    orderBy: { createdAt: "desc" },
  });
}

export async function reactToProposal(actor: AppActor, params: {
  workspaceId: string;
  proposalId: string;
  reaction: string;
}) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
  });
  invariant(actor.kind === "user", 400, "INVALID_ACTOR", "Only users can react to proposals.");

  const reaction = normalizeProposalReaction(params.reaction);

  return prisma.$transaction(async (tx) => {
    const proposal = await tx.proposal.findUnique({
      where: { id: params.proposalId },
      select: {
        id: true,
        workspaceId: true,
      },
    });
    invariant(proposal && proposal.workspaceId === params.workspaceId, 404, "NOT_FOUND", "Proposal not found.");

    const proposalReaction = await tx.proposalReaction.upsert({
      where: {
        proposalId_userId: {
          proposalId: params.proposalId,
          userId: actor.user.id,
        },
      },
      update: {
        reaction,
      },
      create: {
        proposalId: params.proposalId,
        userId: actor.user.id,
        reaction,
      },
    });

    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId: actor.user.id,
        action: "proposal.reacted",
        entityType: "ProposalReaction",
        entityId: proposalReaction.id,
        meta: {
          proposalId: params.proposalId,
          reaction,
        },
      },
    });

    await appendEvents(tx, [
      {
        workspaceId: params.workspaceId,
        type: "proposal.reacted",
        aggregateType: "Proposal",
        aggregateId: params.proposalId,
        payload: {
          proposalId: params.proposalId,
          reaction,
          userId: actor.user.id,
        },
      },
    ]);

    return proposalReaction;
  });
}
