import { prisma } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import { appendEvents } from "./events";
import { actorUserIdForWorkspace, requireWorkspaceMembership } from "./auth";
import { recordAudit } from "./audit-trail";
import { archiveFilterWhere, archiveWorkspaceArtifact, type ArchiveFilter } from "./archive";
import { invariant } from "./errors";
import { requireDraftManager } from "./draft-permissions";
import { resolveWorkspaceProposalLink } from "./proposal-links";
import {
  changedDataFields,
  pickJsonSnapshot,
  recordWorkItemVersion,
  requireSubmittedWorkItemAuthor,
  resolveWorkspaceMemberUserId,
} from "./work-item-versions";

import { privacyFilter } from "./privacy";

export async function listActions(actor: AppActor, workspaceId: string, opts?: { take?: number; skip?: number; archiveFilter?: ArchiveFilter }) {
  const take = opts?.take ?? 20;
  const skip = opts?.skip ?? 0;
  const membership = await requireWorkspaceMembership({ actor, workspaceId });
  const where = { workspaceId, ...privacyFilter(actor, membership), ...archiveFilterWhere(opts?.archiveFilter) };
  
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
        proposal: { select: { id: true, title: true } },
      },
      orderBy: { createdAt: "desc" },
      take,
      skip,
    }),
    prisma.action.count({ where }),
  ]);
  return { items, total, take, skip };
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
  circleId?: string | null;
  assigneeMemberId?: string | null;
  dueAt?: Date | null;
  isPrivate?: boolean;
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
      || params.circleId !== undefined
      || params.assigneeMemberId !== undefined
      || params.dueAt !== undefined;
    if (editsContent) {
      if (action.status === "DRAFT") {
        await requireDraftManager({ actor, workspaceId: params.workspaceId, record: action, resolvedMembership: membership });
      } else {
        invariant(action.status === "OPEN" || action.status === "IN_PROGRESS", 400, "INVALID_STATE", "Only draft, open, or in-progress actions can be edited.");
        requireSubmittedWorkItemAuthor(actor, action.authorUserId);
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
    if (params.status !== undefined) {
      if (params.status === "DRAFT") {
        invariant(action.status !== "COMPLETED", 400, "INVALID_STATE", "Completed actions cannot be returned to draft.");
        await requireDraftManager({ actor, workspaceId: params.workspaceId, record: action, resolvedMembership: membership });
        data.isPrivate = true;
        data.publishedAt = null;
        data.completedVia = null;
      } else if (action.status === "DRAFT") {
        await requireDraftManager({ actor, workspaceId: params.workspaceId, record: action, resolvedMembership: membership });
      }
      data.status = params.status;
      if (params.status !== "DRAFT") {
        data.isPrivate = false;
        data.publishedAt = action.publishedAt || new Date();
      }
    }
    if (params.circleId !== undefined) data.circleId = params.circleId || null;
    if (params.assigneeMemberId !== undefined) data.assigneeMemberId = params.assigneeMemberId || null;
    if (params.dueAt !== undefined) data.dueAt = params.dueAt;
    if (params.isPrivate !== undefined) data.isPrivate = params.isPrivate;

    const contentFields = ["title", "bodyMd", "circleId", "assigneeMemberId", "dueAt"];
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

    await recordAudit(tx, actor, {
      workspaceId: params.workspaceId,
      action: "action.updated",
      entityType: "Action",
      entityId: updated.id,
      meta: { fields: changedUpdateFields, version: updated.version },
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
    invariant(action.status === "OPEN" || action.status === "IN_PROGRESS", 400, "INVALID_STATE", "Only open or in-progress actions can be returned to draft.");
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
