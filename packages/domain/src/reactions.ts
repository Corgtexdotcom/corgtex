import { prisma } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import { requireWorkspaceMembership } from "./auth";
import { appendEvents } from "./events";
import { invariant } from "./errors";

export function normalizeProposalReaction(reaction: string) {
  const normalized = reaction.trim().toUpperCase();
  invariant(normalized.length > 0, 400, "INVALID_INPUT", "reaction is required.");
  invariant(normalized.length <= 32, 400, "INVALID_INPUT", "reaction must be 32 characters or fewer.");
  invariant(["SUPPORT", "REACTION", "OBJECTION", "QUESTION", "CONCERN"].includes(normalized), 400, "INVALID_INPUT", "Invalid reaction type.");
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
    orderBy: { createdAt: "asc" },
  });
}

export async function postReaction(actor: AppActor, params: {
  workspaceId: string;
  proposalId: string;
  reaction: string;
  bodyMd?: string;
}) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
  });
  invariant(actor.kind === "user", 400, "INVALID_ACTOR", "Only users can react to proposals.");

  const reaction = normalizeProposalReaction(params.reaction);
  
  if (reaction === "OBJECTION") {
    invariant(params.bodyMd && params.bodyMd.trim().length > 0, 400, "INVALID_INPUT", "Objection must have a body.");
  }

  return prisma.$transaction(async (tx) => {
    const proposal = await tx.proposal.findUnique({
      where: { id: params.proposalId },
      select: {
        id: true,
        workspaceId: true,
        circleId: true,
      },
    });
    invariant(proposal && proposal.workspaceId === params.workspaceId, 404, "NOT_FOUND", "Proposal not found.");

    if (reaction === "OBJECTION" && proposal.circleId) {
      const isCircleMember = await tx.roleAssignment.findFirst({
        where: {
          member: { userId: actor.user.id },
          role: { circleId: proposal.circleId }
        }
      });
      invariant(isCircleMember, 403, "FORBIDDEN", "Only circle members can raise objections on circle-scoped proposals.");
    }

    if (reaction === "SUPPORT") {
      const existing = await tx.proposalReaction.findFirst({
        where: { proposalId: params.proposalId, userId: actor.user.id, reaction: "SUPPORT" }
      });
      if (existing) return existing;
    }

    const proposalReaction = await tx.proposalReaction.create({
      data: {
        proposalId: params.proposalId,
        userId: actor.user.id,
        reaction,
        bodyMd: params.bodyMd,
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

export async function resolveReaction(actor: AppActor, params: {
  workspaceId: string;
  reactionId: string;
  resolvedNote: string;
}) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
  });
  invariant(actor.kind === "user", 400, "INVALID_ACTOR", "Only users can resolve reactions.");
  invariant(params.resolvedNote && params.resolvedNote.trim().length > 0, 400, "INVALID_INPUT", "Must provide a resolution note.");

  return prisma.$transaction(async (tx) => {
    const reaction = await tx.proposalReaction.findUnique({
      where: { id: params.reactionId },
      include: {
        proposal: {
          select: { workspaceId: true, authorUserId: true }
        }
      }
    });

    invariant(reaction && reaction.proposal.workspaceId === params.workspaceId, 404, "NOT_FOUND", "Reaction not found.");
    invariant(reaction.proposal.authorUserId === actor.user.id, 403, "FORBIDDEN", "Only proposal author can resolve reactions.");

    const updated = await tx.proposalReaction.update({
      where: { id: params.reactionId },
      data: {
        resolvedAt: new Date(),
        resolvedNote: params.resolvedNote
      }
    });

    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId: actor.user.id,
        action: "proposal_reaction.resolved",
        entityType: "ProposalReaction",
        entityId: reaction.id,
        meta: { proposalId: reaction.proposalId }
      }
    });

    return updated;
  });
}
