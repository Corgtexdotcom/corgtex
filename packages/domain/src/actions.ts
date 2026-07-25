import { prisma } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import type { ActionStatus, Prisma } from "@prisma/client";
import { appendEvents } from "./events";
import { actorUserIdForWorkspace, requireWorkspaceMembership } from "./auth";
import { recordAudit } from "./audit-trail";
import { archiveFilterWhere, archiveWorkspaceArtifact, type ArchiveFilter } from "./archive";
import { loadAdviceRequestCountSummaries } from "./advice-requests";
import { invariant } from "./errors";
import { humanMemberIdentityWhere } from "./member-identity";
import { requireDraftManager } from "./draft-permissions";
import { requireCollaborativeWorkItemEditor } from "./collaborative-permissions";
import { resolveWorkspaceProposalLink } from "./proposal-links";
import { createWorkItemEvidenceLinks } from "./work-item-evidence";
import { ensureWorkspacePermalink, workspaceEntityCanonicalPath } from "./permalinks";
import {
  checkWorkspaceDuplicateGuard,
  duplicateGuardAuditMeta,
  duplicateGuardMergeText,
  type DuplicateGuardOptions,
} from "./duplicate-guard";
import {
  changedDataFields,
  pickJsonSnapshot,
  recordWorkItemVersion,
  resolveWorkspaceMemberUserId,
} from "./work-item-versions";

import { privacyFilter } from "./privacy";

export type WorkItemSort = "priority" | "date" | "alpha";

export type ListActionsOptions = {
  take?: number;
  skip?: number;
  archiveFilter?: ArchiveFilter;
  status?: ActionStatus;
  circleId?: string | null;
  circleIds?: string[] | null;
  assigneeMemberId?: string | null;
  assigneeMemberIds?: string[] | null;
  memberId?: string | null;
  memberIds?: string[] | null;
  createdFrom?: Date;
  createdTo?: Date;
  dueFrom?: Date;
  dueTo?: Date;
  sort?: WorkItemSort;
};

type ActionChecklistSummary = {
  checklistItemCount: number;
  checklistCompletedCount: number;
};

type CreateActionParams = {
  workspaceId: string;
  title: string;
  bodyMd?: string | null;
  circleId?: string | null;
  assigneeMemberId?: string | null;
  authorMemberId?: string | null;
  dueAt?: Date | null;
  proposalId?: string | null;
  isPrivate?: boolean;
  priority?: number | null;
  duplicateGuard?: DuplicateGuardOptions | null;
  _membership?: import("@corgtex/shared").MembershipSummary | null;
};

function dateRangeWhere(from?: Date, to?: Date): Prisma.DateTimeFilter<"Action"> | undefined {
  const filter: Prisma.DateTimeFilter<"Action"> = {};
  if (from) filter.gte = from;
  if (to) filter.lte = to;
  return Object.keys(filter).length > 0 ? filter : undefined;
}

function nullableDateRangeWhere(from?: Date, to?: Date): Prisma.DateTimeNullableFilter<"Action"> | undefined {
  const filter: Prisma.DateTimeNullableFilter<"Action"> = {};
  if (from) filter.gte = from;
  if (to) filter.lte = to;
  return Object.keys(filter).length > 0 ? filter : undefined;
}

function listFilterValues(values?: readonly (string | null | undefined)[] | null) {
  return [...new Set((values ?? []).map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];
}

function isPrismaNotFoundError(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "P2025";
}

function appendActionWhereAnd(where: Prisma.ActionWhereInput, condition: Prisma.ActionWhereInput) {
  const and = Array.isArray(where.AND) ? [...where.AND] : where.AND ? [where.AND] : [];
  if (where.OR) {
    and.push({ OR: where.OR });
    delete where.OR;
  }
  and.push(condition);
  where.AND = and;
}

function workItemOrderBy(sort: WorkItemSort | undefined): Prisma.ActionOrderByWithRelationInput[] {
  if (sort === "alpha") {
    return [{ title: "asc" }, { createdAt: "desc" }, { id: "desc" }];
  }
  if (sort === "date") {
    return [{ createdAt: "desc" }, { id: "desc" }];
  }
  return [{ priority: "desc" }, { createdAt: "desc" }, { id: "desc" }];
}

async function resolveAssigneeMemberId(tx: Prisma.TransactionClient, workspaceId: string, assigneeMemberId?: string | null) {
  if (!assigneeMemberId) return null;

  const member = await tx.member.findFirst({
    where: {
      id: assigneeMemberId,
      workspaceId,
      isActive: true,
      ...humanMemberIdentityWhere(),
    },
    select: { id: true },
  });
  invariant(member, 400, "INVALID_INPUT", "Action assignee must be an active human member of this workspace.");
  return member.id;
}

async function loadActionChecklistSummaries(workspaceId: string, actionIds: string[]) {
  const summaries = new Map<string, ActionChecklistSummary>();
  if (actionIds.length === 0) return summaries;

  const items = await prisma.actionChecklistItem.findMany({
    where: {
      workspaceId,
      actionId: { in: actionIds },
    },
    select: {
      actionId: true,
      completedAt: true,
    },
  });

  for (const item of items) {
    const current = summaries.get(item.actionId) ?? { checklistItemCount: 0, checklistCompletedCount: 0 };
    current.checklistItemCount += 1;
    if (item.completedAt) current.checklistCompletedCount += 1;
    summaries.set(item.actionId, current);
  }

  return summaries;
}

async function requireEditableActionForChecklist(
  tx: Prisma.TransactionClient,
  actor: AppActor,
  membership: import("@corgtex/shared").MembershipSummary | null,
  workspaceId: string,
  actionId: string,
) {
  const action = await tx.action.findFirst({
    where: {
      id: actionId,
      workspaceId,
      ...privacyFilter(actor, membership),
      archivedAt: null,
    },
  });

  invariant(action, 404, "NOT_FOUND", "Action not found.");
  if (action.status === "DRAFT") {
    await requireDraftManager({ actor, workspaceId, record: action, resolvedMembership: membership });
  } else {
    invariant(action.status === "OPEN" || action.status === "IN_PROGRESS", 400, "INVALID_STATE", "Only draft, open, or in-progress actions can change checklists.");
    requireCollaborativeWorkItemEditor(actor, membership, action);
  }
  return action;
}

async function lockEditableActionForChecklistMutation(
  tx: Prisma.TransactionClient,
  actor: AppActor,
  membership: import("@corgtex/shared").MembershipSummary | null,
  workspaceId: string,
  actionId: string,
) {
  const action = await requireEditableActionForChecklist(tx, actor, membership, workspaceId, actionId);
  const updateWhere: Record<string, unknown> = {
    id: action.id,
    workspaceId,
    archivedAt: null,
    status: action.status,
    isPrivate: action.isPrivate ?? false,
    version: action.version,
  };

  try {
    await tx.action.update({
      where: updateWhere as Prisma.ActionWhereUniqueInput,
      data: { updatedAt: new Date() },
    });
  } catch (error) {
    if (isPrismaNotFoundError(error)) {
      invariant(false, 409, "CONFLICT", "Action changed while editing. Refresh and try again.");
    }
    throw error;
  }

  return action;
}

function completedByUserIdForActor(actor: AppActor, workspaceId: string) {
  return actor.kind === "user" ? actor.user.id : actorUserIdForWorkspace(actor, workspaceId);
}

export async function listActions(actor: AppActor, workspaceId: string, opts?: ListActionsOptions) {
  const take = opts?.take ?? 20;
  const skip = opts?.skip ?? 0;
  const membership = await requireWorkspaceMembership({ actor, workspaceId });
  const where: Prisma.ActionWhereInput = {
    workspaceId,
    ...privacyFilter(actor, membership),
    ...archiveFilterWhere(opts?.archiveFilter),
  };
  if (opts?.status) where.status = opts.status;
  const circleIds = listFilterValues(opts?.circleIds);
  if (circleIds.length > 0) where.circleId = { in: circleIds };
  else if (opts?.circleId) where.circleId = opts.circleId;
  const assigneeMemberIds = listFilterValues([...(opts?.assigneeMemberIds ?? []), opts?.assigneeMemberId]);
  if (assigneeMemberIds.length > 0) where.assigneeMemberId = { in: assigneeMemberIds };
  const createdAt = dateRangeWhere(opts?.createdFrom, opts?.createdTo);
  const dueAt = nullableDateRangeWhere(opts?.dueFrom, opts?.dueTo);
  if (createdAt) where.createdAt = createdAt;
  if (dueAt) where.dueAt = dueAt;
  const memberIds = listFilterValues([...(opts?.memberIds ?? []), opts?.memberId]);
  if (memberIds.length > 0) {
    appendActionWhereAnd(where, {
      OR: [
        { assigneeMemberId: { in: memberIds } },
        {
          author: {
            memberships: {
              some: {
                id: { in: memberIds },
                workspaceId,
                isActive: true,
              },
            },
          },
        },
      ],
    });
  }
  
  const [items, total] = await Promise.all([
    prisma.action.findMany({
      where,
      include: {
        author: {
          select: {
            displayName: true,
            email: true,
          },
        },
        assigneeMember: {
          include: {
            user: {
              select: {
                displayName: true,
                email: true,
              },
            },
          },
        },
        circle: {
          select: {
            id: true,
            name: true,
          },
        },
        proposal: { select: { id: true, title: true } },
      },
      orderBy: workItemOrderBy(opts?.sort),
      take,
      skip,
    }),
    prisma.action.count({ where }),
  ]);
  const itemIds = items.map((item) => item.id);
  const [requestCountSummaries, checklistSummaries] = await Promise.all([
    loadAdviceRequestCountSummaries(workspaceId, "ACTION", itemIds),
    loadActionChecklistSummaries(workspaceId, itemIds),
  ]);
  return {
    items: items.map((item) => ({
      ...item,
      ...requestCountSummaries.get(item.id),
      checklistItemCount: checklistSummaries.get(item.id)?.checklistItemCount ?? 0,
      checklistCompletedCount: checklistSummaries.get(item.id)?.checklistCompletedCount ?? 0,
    })),
    total,
    take,
    skip,
  };
}

export async function getAction(actor: AppActor, params: {
  workspaceId: string;
  actionId: string;
  includeArchived?: boolean;
}) {
  const membership = await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  const action = await prisma.action.findFirst({
    where: {
      id: params.actionId,
      workspaceId: params.workspaceId,
      ...privacyFilter(actor, membership),
      ...(params.includeArchived ? {} : { archivedAt: null }),
    },
    include: {
      author: {
        select: {
          id: true,
          displayName: true,
          email: true,
        },
      },
      assigneeMember: {
        include: {
          user: {
            select: {
              displayName: true,
              email: true,
            },
          },
        },
      },
      circle: {
        select: {
          id: true,
          name: true,
        },
      },
      proposal: { select: { id: true, title: true } },
    },
  });
  invariant(action, 404, "NOT_FOUND", "Action not found.");
  return action;
}

export async function listActionChecklistItems(actor: AppActor, params: {
  workspaceId: string;
  actionId: string;
}) {
  await getAction(actor, { workspaceId: params.workspaceId, actionId: params.actionId });
  return prisma.actionChecklistItem.findMany({
    where: {
      workspaceId: params.workspaceId,
      actionId: params.actionId,
    },
    orderBy: [
      { sortOrder: "asc" },
      { createdAt: "asc" },
      { id: "asc" },
    ],
  });
}

export async function createActionChecklistItem(actor: AppActor, params: {
  workspaceId: string;
  actionId: string;
  title: string;
}) {
  const membership = await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  const title = params.title.trim();
  invariant(title.length > 0, 400, "INVALID_INPUT", "Checklist item title is required.");

  return prisma.$transaction(async (tx) => {
    await lockEditableActionForChecklistMutation(tx, actor, membership, params.workspaceId, params.actionId);
    const lastItem = await tx.actionChecklistItem.findFirst({
      where: {
        workspaceId: params.workspaceId,
        actionId: params.actionId,
      },
      orderBy: { sortOrder: "desc" },
      select: { sortOrder: true },
    });
    const item = await tx.actionChecklistItem.create({
      data: {
        workspaceId: params.workspaceId,
        actionId: params.actionId,
        title,
        sortOrder: (lastItem?.sortOrder ?? -1) + 1,
      },
    });

    await recordAudit(tx, actor, {
      workspaceId: params.workspaceId,
      action: "action.checklist_item.created",
      entityType: "Action",
      entityId: params.actionId,
      meta: { checklistItemId: item.id, title },
    });
    await appendEvents(tx, [{
      workspaceId: params.workspaceId,
      type: "action.checklist_item.created",
      aggregateType: "Action",
      aggregateId: params.actionId,
      payload: { actionId: params.actionId, checklistItemId: item.id },
    }]);

    return item;
  });
}

export async function updateActionChecklistItem(actor: AppActor, params: {
  workspaceId: string;
  checklistItemId: string;
  title?: string;
  completed?: boolean;
}) {
  const membership = await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });

  return prisma.$transaction(async (tx) => {
    const existing = await tx.actionChecklistItem.findFirst({
      where: {
        id: params.checklistItemId,
        workspaceId: params.workspaceId,
      },
    });
    invariant(existing, 404, "NOT_FOUND", "Checklist item not found.");
    await lockEditableActionForChecklistMutation(tx, actor, membership, params.workspaceId, existing.actionId);

    const data: Prisma.ActionChecklistItemUpdateInput = {};
    if (params.title !== undefined) {
      const title = params.title.trim();
      invariant(title.length > 0, 400, "INVALID_INPUT", "Checklist item title is required.");
      data.title = title;
    }
    if (params.completed !== undefined) {
      data.completedAt = params.completed ? new Date() : null;
      data.completedBy = params.completed
        ? { connect: { id: await completedByUserIdForActor(actor, params.workspaceId) } }
        : { disconnect: true };
    }

    const updated = Object.keys(data).length > 0
      ? await tx.actionChecklistItem.update({
        where: { id: existing.id },
        data,
      })
      : existing;

    await recordAudit(tx, actor, {
      workspaceId: params.workspaceId,
      action: "action.checklist_item.updated",
      entityType: "Action",
      entityId: existing.actionId,
      meta: {
        checklistItemId: existing.id,
        fields: [
          ...(params.title !== undefined ? ["title"] : []),
          ...(params.completed !== undefined ? ["completed"] : []),
        ],
      },
    });
    await appendEvents(tx, [{
      workspaceId: params.workspaceId,
      type: "action.checklist_item.updated",
      aggregateType: "Action",
      aggregateId: existing.actionId,
      payload: { actionId: existing.actionId, checklistItemId: existing.id },
    }]);

    return updated;
  });
}

export async function deleteActionChecklistItem(actor: AppActor, params: {
  workspaceId: string;
  checklistItemId: string;
}) {
  const membership = await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });

  return prisma.$transaction(async (tx) => {
    const existing = await tx.actionChecklistItem.findFirst({
      where: {
        id: params.checklistItemId,
        workspaceId: params.workspaceId,
      },
    });
    invariant(existing, 404, "NOT_FOUND", "Checklist item not found.");
    await lockEditableActionForChecklistMutation(tx, actor, membership, params.workspaceId, existing.actionId);

    await tx.actionChecklistItem.delete({ where: { id: existing.id } });
    await recordAudit(tx, actor, {
      workspaceId: params.workspaceId,
      action: "action.checklist_item.deleted",
      entityType: "Action",
      entityId: existing.actionId,
      meta: { checklistItemId: existing.id, title: existing.title },
    });
    await appendEvents(tx, [{
      workspaceId: params.workspaceId,
      type: "action.checklist_item.deleted",
      aggregateType: "Action",
      aggregateId: existing.actionId,
      payload: { actionId: existing.actionId, checklistItemId: existing.id },
    }]);

    return { id: existing.id };
  });
}

async function applyActionDuplicateUpdate(actor: AppActor, params: CreateActionParams, actionId: string) {
  const existing = await getAction(actor, { workspaceId: params.workspaceId, actionId });
  const mergedBody = duplicateGuardMergeText(existing.bodyMd, params.bodyMd);
  const updateParams: Parameters<typeof updateAction>[1] = {
    workspaceId: params.workspaceId,
    actionId,
  };
  if ((mergedBody ?? null) !== (existing.bodyMd ?? null)) updateParams.bodyMd = mergedBody;
  if (!existing.circleId && params.circleId) updateParams.circleId = params.circleId;
  if (!existing.assigneeMemberId && params.assigneeMemberId) updateParams.assigneeMemberId = params.assigneeMemberId;
  if (!existing.dueAt && params.dueAt) updateParams.dueAt = params.dueAt;
  if (!existing.proposalId && params.proposalId) updateParams.proposalId = params.proposalId;
  if (params.priority !== undefined && params.priority !== null && existing.priority !== params.priority) updateParams.priority = params.priority;
  return Object.keys(updateParams).length > 2 ? updateAction(actor, updateParams) : existing;
}

export async function createAction(actor: AppActor, params: CreateActionParams) {
  const membership = await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
    resolvedMembership: params._membership,
  });

  const title = params.title.trim();
  invariant(title.length > 0, 400, "INVALID_INPUT", "Action title is required.");
  const duplicateDecision = await checkWorkspaceDuplicateGuard({
    workspaceId: params.workspaceId,
    entityType: "Action",
    title,
    body: params.bodyMd,
    circleId: params.circleId,
    assigneeMemberId: params.assigneeMemberId,
    dueAt: params.dueAt,
    proposalId: params.proposalId,
    actorUserId: actor.kind === "user" ? actor.user.id : null,
    membershipId: membership?.id ?? null,
    includePrivate: actor.kind === "agent" || membership?.role === "ADMIN",
  }, params.duplicateGuard);
  if (duplicateDecision?.resolution === "use_existing") {
    return getAction(actor, { workspaceId: params.workspaceId, actionId: duplicateDecision.match.entityId });
  }
  if (duplicateDecision?.resolution === "update_existing") {
    return applyActionDuplicateUpdate(actor, params, duplicateDecision.match.entityId);
  }
  const isPrivate = params.isPrivate ?? true;
  const publishedAt = isPrivate ? null : new Date();

  return prisma.$transaction(async (tx) => {
    const assigneeMemberId = await resolveAssigneeMemberId(tx, params.workspaceId, params.assigneeMemberId);
    const proposalId = await resolveWorkspaceProposalLink(tx, actor, membership, params.workspaceId, params.proposalId);
    let authorUserId = actor.kind === "user"
      ? actor.user.id
      : await actorUserIdForWorkspace(actor, params.workspaceId);
    const attributedMemberId = params.authorMemberId || assigneeMemberId;
    if (actor.kind === "agent" && attributedMemberId) {
      authorUserId = await resolveWorkspaceMemberUserId(tx, params.workspaceId, attributedMemberId, "Action author must be an active member of this workspace.");
    }
    const action = await tx.action.create({
      data: {
        workspaceId: params.workspaceId,
        authorUserId,
        title,
        bodyMd: params.bodyMd?.trim() || null,
        circleId: params.circleId || null,
        assigneeMemberId,
        dueAt: params.dueAt ?? null,
        proposalId,
        priority: params.priority ?? 0,
        status: isPrivate ? "DRAFT" : "OPEN",
        isPrivate,
        publishedAt,
      },
    });

    await ensureWorkspacePermalink(tx, actor, {
      workspaceId: params.workspaceId,
      entityType: "Action",
      entityId: action.id,
      canonicalPath: workspaceEntityCanonicalPath(params.workspaceId, "Action", action),
    });

    await recordAudit(tx, actor, {
      workspaceId: params.workspaceId,
      action: "action.created",
      entityType: "Action",
      entityId: action.id,
      meta: { title: action.title, ...duplicateGuardAuditMeta(duplicateDecision) },
    });

    await appendEvents(tx, [
      {
        workspaceId: params.workspaceId,
        type: "action.created",
        aggregateType: "Action",
        aggregateId: action.id,
        payload: {
          actionId: action.id,
          title: action.title,
        },
      },
    ]);

    if (!isPrivate) {
      await recordAudit(tx, actor, {
        workspaceId: params.workspaceId,
        action: "action.published",
        entityType: "Action",
        entityId: action.id,
        meta: { title: action.title },
      });

      await appendEvents(tx, [
        {
          workspaceId: params.workspaceId,
          type: "action.published",
          aggregateType: "Action",
          aggregateId: action.id,
          payload: { actionId: action.id },
        },
      ]);
    }

    return action;
  });
}

export async function updateAction(actor: AppActor, params: {
  workspaceId: string;
  actionId: string;
  title?: string;
  bodyMd?: string | null;
  status?: "DRAFT" | "OPEN" | "IN_PROGRESS" | "COMPLETED";
  priority?: number;
  circleId?: string | null;
  assigneeMemberId?: string | null;
  dueAt?: Date | null;
  proposalId?: string | null;
  isPrivate?: boolean;
  completedVia?: string | null;
  evidenceDocumentIds?: string[] | null;
  _membership?: import("@corgtex/shared").MembershipSummary | null;
}) {
  const membership = await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
    resolvedMembership: params._membership,
  });

  return prisma.$transaction(async (tx) => {
    const action = await tx.action.findUnique({
      where: { id: params.actionId },
    });

    invariant(action && action.workspaceId === params.workspaceId, 404, "NOT_FOUND", "Action not found.");

    invariant(!action.archivedAt, 400, "INVALID_STATE", "Archived actions cannot be edited.");

    const data: Record<string, unknown> = {};
    const editsContent = params.title !== undefined
      || params.bodyMd !== undefined
      || params.priority !== undefined
      || params.circleId !== undefined
      || params.assigneeMemberId !== undefined
      || params.dueAt !== undefined
      || params.proposalId !== undefined;
    if (editsContent) {
      if (action.status === "DRAFT") {
        await requireDraftManager({ actor, workspaceId: params.workspaceId, record: action, resolvedMembership: membership });
      } else {
        invariant(action.status === "OPEN" || action.status === "IN_PROGRESS", 400, "INVALID_STATE", "Only draft, open, or in-progress actions can be edited.");
        requireCollaborativeWorkItemEditor(actor, membership, action);
      }
    }
    if (params.isPrivate !== undefined) {
      invariant(action.status === "DRAFT", 400, "INVALID_STATE", "Only draft actions can change privacy.");
      await requireDraftManager({ actor, workspaceId: params.workspaceId, record: action, resolvedMembership: membership });
    }
    if (params.title !== undefined) {
      const title = params.title.trim();
      invariant(title.length > 0, 400, "INVALID_INPUT", "Action title is required.");
      data.title = title;
    }
    if (params.bodyMd !== undefined) data.bodyMd = params.bodyMd?.trim() || null;
    if (params.priority !== undefined) data.priority = params.priority;
    if (params.status !== undefined) {
      if (params.status === "DRAFT") {
        await requireDraftManager({ actor, workspaceId: params.workspaceId, record: action, resolvedMembership: membership });
        data.isPrivate = true;
        data.publishedAt = null;
        data.completedVia = null;
      } else if (params.status === "COMPLETED") {
        if (action.status === "DRAFT") {
          await requireDraftManager({ actor, workspaceId: params.workspaceId, record: action, resolvedMembership: membership });
        }
      } else if (action.status === "DRAFT") {
        await requireDraftManager({ actor, workspaceId: params.workspaceId, record: action, resolvedMembership: membership });
      }
      data.status = params.status;
      if (params.status !== "DRAFT") {
        data.isPrivate = false;
        data.publishedAt = action.publishedAt || new Date();
      }
      if (params.status === "COMPLETED") {
        const completedVia = params.completedVia?.trim() || "";
        invariant(completedVia.length > 0, 400, "INVALID_INPUT", "Completion note is required.");
        data.completedVia = completedVia;
      } else if (params.status === "OPEN" || params.status === "IN_PROGRESS") {
        data.completedVia = null;
      }
    }
    if (params.circleId !== undefined) data.circleId = params.circleId || null;
    if (params.assigneeMemberId !== undefined) {
      data.assigneeMemberId = await resolveAssigneeMemberId(tx, params.workspaceId, params.assigneeMemberId);
    }
    if (params.dueAt !== undefined) data.dueAt = params.dueAt;
    if (params.proposalId !== undefined) {
      data.proposalId = await resolveWorkspaceProposalLink(tx, actor, membership, params.workspaceId, params.proposalId);
    }
    if (params.isPrivate !== undefined) data.isPrivate = params.isPrivate;

    const contentFields = ["title", "bodyMd", "priority", "circleId", "assigneeMemberId", "dueAt", "proposalId"];
    const changedFields = changedDataFields(action as unknown as Record<string, unknown>, data)
      .filter((field) => contentFields.includes(field));
    if (changedFields.length > 0) {
      data.version = await recordWorkItemVersion(tx, actor, {
        workspaceId: params.workspaceId,
        entityType: "Action",
        entityId: action.id,
        currentVersion: action.version,
        changedFields,
        previousState: pickJsonSnapshot(action as unknown as Record<string, unknown>, [
          "id",
          "workspaceId",
          "title",
          "bodyMd",
          "priority",
          "circleId",
          "assigneeMemberId",
          "dueAt",
          "proposalId",
          "status",
          "version",
        ]),
      });
    }
    const changedUpdateFields = changedDataFields(action as unknown as Record<string, unknown>, data);
    if (changedUpdateFields.length === 0) return action;

    const updateWhere: Record<string, unknown> = {
      id: params.actionId,
      workspaceId: params.workspaceId,
      archivedAt: null,
      status: action.status,
    };
    if (action.isPrivate !== undefined) updateWhere.isPrivate = action.isPrivate ?? false;
    if (action.version !== undefined) updateWhere.version = action.version;

    let updated;
    try {
      updated = await tx.action.update({
        where: updateWhere as Prisma.ActionWhereUniqueInput,
        data,
      });
    } catch (error) {
      if (isPrismaNotFoundError(error)) {
        invariant(false, 409, "CONFLICT", "Action changed while editing. Refresh and try again.");
      }
      throw error;
    }

    const evidenceDocumentIds = params.status === "COMPLETED"
      ? await createWorkItemEvidenceLinks(tx, {
        workspaceId: params.workspaceId,
        entityType: "Action",
        entityId: updated.id,
        documentIds: params.evidenceDocumentIds,
        purpose: "completion_evidence",
      })
      : [];

    await recordAudit(tx, actor, {
      workspaceId: params.workspaceId,
      action: "action.updated",
      entityType: "Action",
      entityId: updated.id,
      meta: { fields: changedUpdateFields, version: updated.version, evidenceDocumentIds },
    });

    await appendEvents(tx, [
      {
        workspaceId: params.workspaceId,
        type: "action.updated",
        aggregateType: "Action",
        aggregateId: updated.id,
        payload: {
          actionId: updated.id,
          fields: changedUpdateFields,
          evidenceDocumentIds,
        },
      },
    ]);

    return updated;
  });
}

export async function deleteAction(actor: AppActor, params: {
  workspaceId: string;
  actionId: string;
  _membership?: import("@corgtex/shared").MembershipSummary | null;
}) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
    resolvedMembership: params._membership,
  });

  await archiveWorkspaceArtifact(actor, {
    workspaceId: params.workspaceId,
    entityType: "Action",
    entityId: params.actionId,
    reason: "Archived from action delete path.",
  });

  return { id: params.actionId };
}

export async function publishAction(actor: AppActor, params: {
  workspaceId: string;
  actionId: string;
  _membership?: import("@corgtex/shared").MembershipSummary | null;
}) {
  const membership = await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
    resolvedMembership: params._membership,
  });

  return prisma.$transaction(async (tx) => {
    const action = await tx.action.findUnique({
      where: { id: params.actionId },
    });

    invariant(action && action.workspaceId === params.workspaceId, 404, "NOT_FOUND", "Action not found.");
    invariant(action.status === "DRAFT", 400, "INVALID_STATE", "Only draft actions can be opened.");
    await requireDraftManager({ actor, workspaceId: params.workspaceId, record: action, resolvedMembership: membership });

    const updated = await tx.action.update({
      where: { id: params.actionId },
      data: { status: "OPEN", isPrivate: false, publishedAt: new Date() },
    });

    await recordAudit(tx, actor, {
      workspaceId: params.workspaceId,
      action: "action.published",
      entityType: "Action",
      entityId: updated.id,
      meta: { title: updated.title },
    });

    await appendEvents(tx, [
      {
        workspaceId: params.workspaceId,
        type: "action.published",
        aggregateType: "Action",
        aggregateId: updated.id,
        payload: { actionId: updated.id },
      },
    ]);

    return updated;
  });
}

export async function returnActionToDraft(actor: AppActor, params: {
  workspaceId: string;
  actionId: string;
  _membership?: import("@corgtex/shared").MembershipSummary | null;
}) {
  const membership = await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
    resolvedMembership: params._membership,
  });

  return prisma.$transaction(async (tx) => {
    const action = await tx.action.findUnique({
      where: { id: params.actionId },
    });

    invariant(action && action.workspaceId === params.workspaceId, 404, "NOT_FOUND", "Action not found.");
    invariant(action.status === "OPEN" || action.status === "IN_PROGRESS" || action.status === "COMPLETED", 400, "INVALID_STATE", "Only open, in-progress, or completed actions can be returned to draft.");
    await requireDraftManager({ actor, workspaceId: params.workspaceId, record: action, resolvedMembership: membership });

    const updated = await tx.action.update({
      where: { id: params.actionId },
      data: {
        status: "DRAFT",
        isPrivate: true,
        publishedAt: null,
        completedVia: null,
      },
    });

    await recordAudit(tx, actor, {
      workspaceId: params.workspaceId,
      action: "action.returned_to_draft",
      entityType: "Action",
      entityId: updated.id,
      meta: { title: updated.title },
    });

    await appendEvents(tx, [
      {
        workspaceId: params.workspaceId,
        type: "action.returned_to_draft",
        aggregateType: "Action",
        aggregateId: updated.id,
        payload: { actionId: updated.id },
      },
    ]);

    return updated;
  });
}
