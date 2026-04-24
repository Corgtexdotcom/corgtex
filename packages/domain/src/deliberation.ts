import type { AppActor } from "@corgtex/shared";
import { prisma } from "@corgtex/shared";
import { requireWorkspaceMembership, actorUserIdForWorkspace } from "./auth";
import { invariant } from "./errors";
import { appendEvents } from "./events";
import { sha256 } from "@corgtex/shared";

const VALID_ENTRY_TYPES = ["SUPPORT", "QUESTION", "CONCERN", "OBJECTION", "REACTION", "ADVICE_REQUEST"];
const VALID_PARENT_TYPES = ["PROPOSAL", "SPEND", "TENSION", "MEETING", "BRAIN_ARTICLE"];

export async function postDeliberationEntry(actor: AppActor, params: {
  workspaceId: string;
  parentType: string;
  parentId: string;
  entryType: string;
  bodyMd?: string;
  targetMemberId?: string;
}) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  const authorUserId = await actorUserIdForWorkspace(actor, params.workspaceId);

  invariant(VALID_ENTRY_TYPES.includes(params.entryType), 400, "INVALID_INPUT", `Invalid entryType: ${params.entryType}`);
  invariant(VALID_PARENT_TYPES.includes(params.parentType), 400, "INVALID_INPUT", `Invalid parentType: ${params.parentType}`);

  if (params.entryType === "OBJECTION") {
    invariant(params.bodyMd && params.bodyMd.trim().length > 0, 400, "INVALID_INPUT", "Objections require a non-empty bodyMd.");
  }

  return prisma.$transaction(async (tx) => {
    let entry: any = null;
    let didCreate = true;

    if (params.entryType === "SUPPORT") {
      const hash = sha256(`${params.workspaceId}:${params.parentType}:${params.parentId}:${authorUserId}`).substring(0, 32);
      const deterministicId = `supp-${hash}`;

      const rows: any[] = await tx.$queryRaw`
        INSERT INTO "DeliberationEntry" ("id", "workspaceId", "parentType", "parentId", "authorUserId", "entryType", "bodyMd", "targetMemberId", "createdAt")
        VALUES (${deterministicId}, ${params.workspaceId}, ${params.parentType}, ${params.parentId}, ${authorUserId}, ${params.entryType}, ${params.bodyMd?.trim() || null}, ${params.targetMemberId || null}, NOW())
        ON CONFLICT ("id") DO NOTHING
        RETURNING *;
      `;

      if (rows.length === 0) {
        didCreate = false;
        entry = await tx.deliberationEntry.findUnique({ where: { id: deterministicId } });
      } else {
        entry = rows[0];
      }
    } else {
      entry = await tx.deliberationEntry.create({
        data: {
          workspaceId: params.workspaceId,
          parentType: params.parentType,
          parentId: params.parentId,
          authorUserId,
          entryType: params.entryType,
          bodyMd: params.bodyMd?.trim() || null,
          targetMemberId: params.targetMemberId || null,
        }
      });
    }

    if (!didCreate && entry) {
      return entry;
    }

    if (params.parentType === "SPEND" && params.entryType === "OBJECTION") {
      const spend = await tx.spendRequest.findUnique({ where: { id: params.parentId } });
      if (spend && spend.status === "SUBMITTED") {
        await tx.spendRequest.update({
          where: { id: spend.id },
          data: { status: "OBJECTED" },
        });
        await appendEvents(tx, [{
          workspaceId: params.workspaceId,
          type: "spend.objected",
          aggregateType: "SpendRequest",
          aggregateId: spend.id,
          payload: { spendId: spend.id },
        }]);
      }
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
  resolvedNote?: string;
}) {
  const membership = await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  const actorUserId = await actorUserIdForWorkspace(actor, params.workspaceId);
  const isAdmin = membership ? membership.role === "ADMIN" : actor.kind === "agent";

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
        resolvedNote: params.resolvedNote?.trim() || null,
      }
    });

    if (entry.parentType === "SPEND" && entry.entryType === "OBJECTION") {
      const spend = await tx.spendRequest.findUnique({ where: { id: entry.parentId } });
      if (spend && spend.status === "OBJECTED") {
        const otherOpenObjections = await tx.deliberationEntry.count({
          where: {
            parentType: "SPEND",
            parentId: spend.id,
            entryType: "OBJECTION",
            resolvedAt: null,
          }
        });
        if (otherOpenObjections === 0) {
          await tx.spendRequest.update({
            where: { id: spend.id },
            data: { status: "SUBMITTED" },
          });
        }
      }
    }

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
      }
    },
    orderBy: { createdAt: "asc" }
  });
}
