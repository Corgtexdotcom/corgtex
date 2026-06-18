import { prisma } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import type { ActionStatus, Prisma } from "@prisma/client";
import { appendEvents } from "./events";
import { actorUserIdForWorkspace, requireWorkspaceMembership } from "./auth";
import { recordAudit } from "./audit-trail";
import { archiveFilterWhere, archiveWorkspaceArtifact, type ArchiveFilter } from "./archive";
import { invariant } from "./errors";
import { requireDraftManager } from "./draft-permissions";
import { resolveWorkspaceProposalLink } from "./proposal-links";
import { createWorkItemEvidenceLinks } from "./work-item-evidence";
import {
  changedDataFields,
  pickJsonSnapshot,
  recordWorkItemVersion,
  requireSubmittedWorkItemEditor,
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
  memberId?: string | null;
  createdFrom?: Date;
  createdTo?: Date;
  dueFrom?: Date;
  dueTo?: Date;
  sort?: WorkItemSort;
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
  if (opts?.circleId) where.circleId = opts.circleId;
  const createdAt = dateRangeWhere(opts?.createdFrom, opts?.createdTo);
  const dueAt = nullableDateRangeWhere(opts?.dueFrom, opts?.dueTo);
  if (createdAt) where.createdAt = createdAt;
  if (dueAt) where.dueAt = dueAt;
  if (opts?.memberId) {
    appendActionWhereAnd(where, {
      OR: [
        { assigneeMemberId: opts.memberId },
        {
          author: {
            memberships: {
              some: {
                id: opts.memberId,
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
  return { items, total, take, skip };
}

export async function getAction(actor: AppActor, params: {
  workspaceId: string;
  actionId: string;
}) {
  const membership = await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  const action = await prisma.action.findFirst({
    where: {
      id: params.actionId,
      workspaceId: params.workspaceId,
      ...privacyFilter(actor, membership),
      archivedAt: null,
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

export async function createAction(actor: AppActor, params: {
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
  _membership?: import("@corgtex/shared").MembershipSummary | null;
}) {
  const membership = await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
    resolvedMembership: params._membership,
  });

  const title = params.title.trim();
  invariant(title.length > 0, 400, "INVALID_INPUT", "Action title is required.");
  const isPrivate = params.isPrivate ?? true;
  const publishedAt = isPrivate ? null : new Date();

  return prisma.$transaction(async (tx) => {
    const proposalId = await resolveWorkspaceProposalLink(tx, actor, membership, params.workspaceId, params.proposalId);
    let authorUserId = actor.kind === "user"
      ? actor.user.id
      : await actorUserIdForWorkspace(actor, params.workspaceId);
    const attributedMemberId = params.authorMemberId || params.assigneeMemberId || null;
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
        assigneeMemberId: params.assigneeMemberId || null,
        dueAt: params.dueAt ?? null,
        proposalId,
        priority: params.priority ?? 0,
        status: isPrivate ? "DRAFT" : "OPEN",
        isPrivate,
        publishedAt,
      },
    });

    await recordAudit(tx, actor, {
      workspaceId: params.workspaceId,
      action: "action.created",
      entityType: "Action",
      entityId: action.id,
      meta: { title: action.title },
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
      || params.dueAt !== undefined;
    if (editsContent) {
      if (action.status === "DRAFT") {
        await requireDraftManager({ actor, workspaceId: params.workspaceId, record: action, resolvedMembership: membership });
      } else {
        invariant(action.status === "OPEN" || action.status === "IN_PROGRESS", 400, "INVALID_STATE", "Only draft, open, or in-progress actions can be edited.");
        requireSubmittedWorkItemEditor(actor, membership, action);
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
    if (params.assigneeMemberId !== undefined) data.assigneeMemberId = params.assigneeMemberId || null;
    if (params.dueAt !== undefined) data.dueAt = params.dueAt;
    if (params.isPrivate !== undefined) data.isPrivate = params.isPrivate;

    const contentFields = ["title", "bodyMd", "priority", "circleId", "assigneeMemberId", "dueAt"];
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
          "status",
          "version",
        ]),
      });
    }
    const changedUpdateFields = changedDataFields(action as unknown as Record<string, unknown>, data);
    if (changedUpdateFields.length === 0) return action;

    const updated = await tx.action.update({
      where: { id: params.actionId },
      data,
    });

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
