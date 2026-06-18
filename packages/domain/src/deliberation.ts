import type { DeliberationEntry, Prisma } from "@prisma/client";
import type { AppActor } from "@corgtex/shared";
import { prisma } from "@corgtex/shared";
import { requireWorkspaceMembership, actorUserIdForWorkspace } from "./auth";
import { invariant } from "./errors";
import { appendEvents } from "./events";
import { getParentWorkItemVersion } from "./work-item-versions";

const VALID_ENTRY_TYPES = ["REACTION", "OBJECTION"];
const VALID_PARENT_TYPES = ["PROPOSAL", "SPEND", "TENSION", "MEETING", "BRAIN_ARTICLE", "ACTION"];
const deliberationEntryListInclude = {
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
} as const;
type ListedDeliberationEntry = Prisma.DeliberationEntryGetPayload<{ include: typeof deliberationEntryListInclude }>;
type DeliberationEntryRecord = DeliberationEntry;

function validateEntryType(entryType: string) {
  invariant(VALID_ENTRY_TYPES.includes(entryType), 400, "INVALID_INPUT", `Invalid entryType: ${entryType}`);
}

async function findActorMember(tx: Prisma.TransactionClient, workspaceId: string, actorUserId: string) {
  return tx.member.findFirst({
    where: {
      workspaceId,
      userId: actorUserId,
      isActive: true,
    },
    select: { id: true },
  });
}

async function isMemberOfTargetCircle(tx: Prisma.TransactionClient, memberId: string | null | undefined, circleId: string | null) {
  if (!memberId || !circleId) return false;
  const assignment = await tx.roleAssignment.findFirst({
    where: {
      memberId,
      role: {
        circleId,
      },
    },
    select: { id: true },
  });
  return Boolean(assignment);
}

async function isTargetedActor(tx: Prisma.TransactionClient, params: {
  entry: Pick<DeliberationEntryRecord, "targetMemberId" | "targetCircleId">;
  actorMemberId?: string | null;
}) {
  if (!params.actorMemberId) return false;
  if (params.entry.targetMemberId && params.entry.targetMemberId === params.actorMemberId) return true;
  return isMemberOfTargetCircle(tx, params.actorMemberId, params.entry.targetCircleId);
}

async function isResponsibleForParent(tx: Prisma.TransactionClient, params: {
  workspaceId: string;
  entry: Pick<DeliberationEntryRecord, "parentType" | "parentId">;
  actorUserId: string;
  actorMemberId?: string | null;
}) {
  if (params.entry.parentType === "PROPOSAL") {
    const parent = await tx.proposal.findUnique({ where: { id: params.entry.parentId }, select: { authorUserId: true } });
    return parent?.authorUserId === params.actorUserId;
  }
  if (params.entry.parentType === "SPEND") {
    const parent = await tx.spendRequest.findUnique({ where: { id: params.entry.parentId }, select: { requesterUserId: true } });
    return parent?.requesterUserId === params.actorUserId;
  }
  if (params.entry.parentType === "TENSION") {
    const parent = await tx.tension.findUnique({ where: { id: params.entry.parentId }, select: { authorUserId: true, assigneeMemberId: true } });
    return parent?.authorUserId === params.actorUserId || (!!params.actorMemberId && parent?.assigneeMemberId === params.actorMemberId);
  }
  if (params.entry.parentType === "ACTION") {
    const parent = await tx.action.findUnique({ where: { id: params.entry.parentId }, select: { authorUserId: true, assigneeMemberId: true } });
    return parent?.authorUserId === params.actorUserId || (!!params.actorMemberId && parent?.assigneeMemberId === params.actorMemberId);
  }
  if (params.entry.parentType === "MEETING") {
    const parent = await tx.meeting.findUnique({ where: { id: params.entry.parentId }, select: { participantIds: true } });
    return parent?.participantIds.includes(params.actorUserId) ?? false;
  }
  if (params.entry.parentType === "BRAIN_ARTICLE") {
    const parent = await tx.brainArticle.findUnique({ where: { id: params.entry.parentId }, select: { ownerMemberId: true } });
    return !!params.actorMemberId && parent?.ownerMemberId === params.actorMemberId;
  }
  return false;
}

async function assertCanManageDeliberationEntry(tx: Prisma.TransactionClient, params: {
  workspaceId: string;
  actorUserId: string;
  actorMemberId?: string | null;
  isAdmin: boolean;
  entry: DeliberationEntryRecord;
  action: "edit" | "resolve";
}) {
  const isEntryAuthor = params.entry.authorUserId === params.actorUserId;
  const isTargeted = await isTargetedActor(tx, {
    entry: params.entry,
    actorMemberId: params.actorMemberId,
  });
  const isParentResponsible = await isResponsibleForParent(tx, {
    workspaceId: params.workspaceId,
    entry: params.entry,
    actorUserId: params.actorUserId,
    actorMemberId: params.actorMemberId,
  });

  invariant(
    params.isAdmin || isEntryAuthor || isTargeted || isParentResponsible,
    403,
    "FORBIDDEN",
    params.action === "edit"
      ? "Only the entry author, target, parent owner, assigned member, or a workspace admin can edit this entry."
      : "Only the entry author, target, parent owner, assigned member, or a workspace admin can resolve this entry.",
  );
}

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

  validateEntryType(params.entryType);
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
    const parentVersion = await getParentWorkItemVersion(tx, {
      workspaceId: params.workspaceId,
      parentType: params.parentType,
      parentId: params.parentId,
    });

    const entry = await tx.deliberationEntry.create({
      data: {
        workspaceId: params.workspaceId,
        parentType: params.parentType,
        parentId: params.parentId,
        authorUserId,
        entryType: params.entryType,
        bodyMd,
        parentVersion,
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
        meta: { parentType: params.parentType, parentId: params.parentId, entryType: params.entryType, parentVersion }
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
          parentVersion,
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
    const actorMember = await findActorMember(tx, params.workspaceId, actorUserId);
    await assertCanManageDeliberationEntry(tx, {
      workspaceId: params.workspaceId,
      actorUserId,
      actorMemberId: actorMember?.id,
      isAdmin,
      entry,
      action: "resolve",
    });

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

export async function updateDeliberationEntry(actor: AppActor, params: {
  workspaceId: string;
  entryId: string;
  entryType?: string;
  bodyMd?: string;
}) {
  const membership = await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  const actorUserId = await actorUserIdForWorkspace(actor, params.workspaceId);
  const isAdmin = membership ? membership.role === "ADMIN" : actor.kind === "agent";

  return prisma.$transaction(async (tx) => {
    const entry = await tx.deliberationEntry.findUnique({
      where: { id: params.entryId },
    });

    invariant(entry && entry.workspaceId === params.workspaceId, 404, "NOT_FOUND", "Entry not found.");
    invariant(!entry.resolvedAt, 400, "INVALID_STATE", "Resolved deliberation entries cannot be edited.");

    const actorMember = await findActorMember(tx, params.workspaceId, actorUserId);
    await assertCanManageDeliberationEntry(tx, {
      workspaceId: params.workspaceId,
      actorUserId,
      actorMemberId: actorMember?.id,
      isAdmin,
      entry,
      action: "edit",
    });

    const data: Record<string, string> = {};
    if (params.entryType !== undefined) {
      validateEntryType(params.entryType);
      data.entryType = params.entryType;
    }
    if (params.bodyMd !== undefined) {
      const bodyMd = params.bodyMd.trim();
      invariant(bodyMd.length > 0, 400, "INVALID_INPUT", "Deliberation entries require a non-empty bodyMd.");
      data.bodyMd = bodyMd;
    }

    const changedFields = Object.keys(data).filter((field) => entry[field as keyof typeof entry] !== data[field]);
    if (changedFields.length === 0) return entry;

    const updated = await tx.deliberationEntry.update({
      where: { id: entry.id },
      data,
    });

    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId,
        action: "deliberation.entry_updated",
        entityType: "DeliberationEntry",
        entityId: entry.id,
        meta: {
          parentType: entry.parentType,
          parentId: entry.parentId,
          changedFields,
          previousState: {
            entryType: entry.entryType,
            bodyMd: entry.bodyMd,
          },
        },
      },
    });

    await appendEvents(tx, [
      {
        workspaceId: params.workspaceId,
        type: "deliberation.entry_updated",
        aggregateType: "DeliberationEntry",
        aggregateId: entry.id,
        payload: {
          entryId: entry.id,
          parentType: entry.parentType,
          parentId: entry.parentId,
          changedFields,
        },
      },
    ]);

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
    include: deliberationEntryListInclude,
    orderBy: { createdAt: "asc" }
  });
}

export async function listDeliberationEntriesForParents(actor: AppActor, params: {
  workspaceId: string;
  parentType: string;
  parentIds: string[];
}): Promise<Map<string, ListedDeliberationEntry[]>> {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  const parentIds = Array.from(new Set(params.parentIds.filter((parentId) => parentId.length > 0)));
  const entriesByParentId = new Map<string, ListedDeliberationEntry[]>();
  for (const parentId of parentIds) {
    entriesByParentId.set(parentId, []);
  }
  if (parentIds.length === 0) {
    return entriesByParentId;
  }

  const entries = await prisma.deliberationEntry.findMany({
    where: {
      workspaceId: params.workspaceId,
      parentType: params.parentType,
      parentId: { in: parentIds },
    },
    include: deliberationEntryListInclude,
    orderBy: { createdAt: "asc" }
  });

  for (const entry of entries) {
    entriesByParentId.get(entry.parentId)?.push(entry);
  }

  return entriesByParentId;
}
