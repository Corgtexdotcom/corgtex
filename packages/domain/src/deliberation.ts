import type { AppActor } from "@corgtex/shared";
import { prisma } from "@corgtex/shared";
import { requireWorkspaceMembership, actorUserIdForWorkspace } from "./auth";
import { invariant } from "./errors";
import { appendEvents } from "./events";

const VALID_ENTRY_TYPES = ["REACTION", "OBJECTION"];
const VALID_PARENT_TYPES = ["PROPOSAL", "SPEND", "TENSION", "MEETING", "BRAIN_ARTICLE"];

export async function postDeliberationEntry(actor: AppActor, params: {
  workspaceId: string;
  parentType: string;
  parentId: string;
  entryType: string;
  bodyMd?: string;
  targetMemberId?: string;
  targetCircleId?: string;
}) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  const authorUserId = await actorUserIdForWorkspace(actor, params.workspaceId);

  invariant(VALID_ENTRY_TYPES.includes(params.entryType), 400, "INVALID_INPUT", `Invalid entryType: ${params.entryType}`);
  invariant(VALID_PARENT_TYPES.includes(params.parentType), 400, "INVALID_INPUT", `Invalid parentType: ${params.parentType}`);

  const bodyMd = params.bodyMd?.trim() || "";
  invariant(bodyMd.length > 0, 400, "INVALID_INPUT", "Deliberation entries require a non-empty bodyMd.");
  invariant(!(params.targetMemberId && params.targetCircleId), 400, "INVALID_INPUT", "Choose either a person or a circle target, not both.");

  return prisma.$transaction(async (tx) => {
    if (params.targetMemberId) {
      const targetMember = await tx.member.findUnique({ where: { id: params.targetMemberId } });
      invariant(targetMember && targetMember.workspaceId === params.workspaceId && targetMember.isActive, 400, "INVALID_INPUT", "Target member must belong to this workspace.");
    }
    if (params.targetCircleId) {
      const targetCircle = await tx.circle.findUnique({ where: { id: params.targetCircleId } });
      invariant(targetCircle && targetCircle.workspaceId === params.workspaceId && !targetCircle.archivedAt, 400, "INVALID_INPUT", "Target circle must belong to this workspace.");
    }

    const entry = await tx.deliberationEntry.create({
      data: {
        workspaceId: params.workspaceId,
        parentType: params.parentType,
        parentId: params.parentId,
        authorUserId,
        entryType: params.entryType,
        bodyMd,
        targetMemberId: params.targetMemberId || null,
        targetCircleId: params.targetCircleId || null,
      }
    });

    if (params.parentType === "SPEND" && params.entryType === "OBJECTION") {
      await appendEvents(tx, [{
        workspaceId: params.workspaceId,
        type: "spend.objected",
        aggregateType: "SpendRequest",
        aggregateId: params.parentId,
        payload: { spendId: params.parentId },
      }]);
    }

    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId: authorUserId,
        action: "deliberation.entry_posted",
        entityType: "DeliberationEntry",
        entityId: entry.id,
        meta: { parentType: params.parentType, parentId: params.parentId, entryType: params.entryType }
      }
    });

    await appendEvents(tx, [
      {
        workspaceId: params.workspaceId,
        type: "deliberation.entry_posted",
        aggregateType: "DeliberationEntry",
        aggregateId: entry.id,
        payload: {
          entryId: entry.id,
          parentType: params.parentType,
          parentId: params.parentId,
          entryType: params.entryType,
        }
      }
    ]);

    return entry;
  });
}

export async function resolveDeliberationEntry(actor: AppActor, params: {
  workspaceId: string;
  entryId: string;
  resolvedNote: string;
}) {
  const membership = await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  const actorUserId = await actorUserIdForWorkspace(actor, params.workspaceId);
  const isAdmin = membership ? membership.role === "ADMIN" : actor.kind === "agent";
  const resolvedNote = params.resolvedNote?.trim() || "";
  invariant(resolvedNote.length > 0, 400, "INVALID_INPUT", "Resolution note is required.");

  return prisma.$transaction(async (tx) => {
    const entry = await tx.deliberationEntry.findUnique({
      where: { id: params.entryId }
    });

    invariant(entry && entry.workspaceId === params.workspaceId, 404, "NOT_FOUND", "Entry not found.");
    
    let isParentAuthor = false;
    if (entry.parentType === "PROPOSAL") {
      const parent = await tx.proposal.findUnique({ where: { id: entry.parentId }, select: { authorUserId: true } });
      isParentAuthor = parent?.authorUserId === actorUserId;
    } else if (entry.parentType === "SPEND") {
      const parent = await tx.spendRequest.findUnique({ where: { id: entry.parentId }, select: { requesterUserId: true } });
      isParentAuthor = parent?.requesterUserId === actorUserId;
    } else if (entry.parentType === "TENSION") {
      const parent = await tx.tension.findUnique({ where: { id: entry.parentId }, select: { authorUserId: true } });
      isParentAuthor = parent?.authorUserId === actorUserId;
    } else if (entry.parentType === "MEETING") {
      const parent = await tx.meeting.findUnique({ where: { id: entry.parentId }, select: { participantIds: true } });
      isParentAuthor = parent?.participantIds.includes(actorUserId) ?? false;
    } else if (entry.parentType === "BRAIN_ARTICLE") {
      const parent = await tx.brainArticle.findUnique({ where: { id: entry.parentId }, select: { ownerMemberId: true } });
      if (parent?.ownerMemberId) {
        const memberCheck = await tx.member.findFirst({ where: { workspaceId: params.workspaceId, userId: actorUserId } });
        if (memberCheck && memberCheck.id === parent.ownerMemberId) {
          isParentAuthor = true;
        }
      }
    }

    const isEntryAuthor = entry.authorUserId === actorUserId;

    invariant(isAdmin || isParentAuthor || isEntryAuthor, 403, "FORBIDDEN", "Only the entry author, parent author, or a workspace admin can resolve this entry.");

    const updated = await tx.deliberationEntry.update({
      where: { id: entry.id },
      data: {
        resolvedAt: new Date(),
        resolvedNote,
      }
    });

    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId: actorUserId,
        action: "deliberation.entry_resolved",
        entityType: "DeliberationEntry",
        entityId: entry.id,
        meta: {}
      }
    });

    return updated;
  });
}

export async function listDeliberationEntries(actor: AppActor, params: {
  workspaceId: string;
  parentType: string;
  parentId: string;
}) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  return prisma.deliberationEntry.findMany({
    where: {
      workspaceId: params.workspaceId,
      parentType: params.parentType,
      parentId: params.parentId,
    },
    include: {
      author: {
        select: {
          id: true,
          displayName: true,
          email: true,
        }
      },
      targetCircle: {
        select: {
          id: true,
          name: true,
        }
      },
      targetMember: {
        include: {
          user: {
            select: {
              id: true,
              displayName: true,
              email: true,
            }
          }
        }
      }
    },
    orderBy: { createdAt: "asc" }
  });
}
