import { prisma } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import { appendEvents } from "./events";
import { actorUserIdForWorkspace, requireWorkspaceMembership } from "./auth";
import { recordAudit } from "./audit-trail";
import { invariant } from "./errors";
import { parseMentions, createMentionNotifications } from "./mentions";

import { privacyFilter } from "./privacy";

export async function listActions(actor: AppActor, workspaceId: string, opts?: { take?: number; skip?: number }) {
  const take = opts?.take ?? 20;
  const skip = opts?.skip ?? 0;
  const where = { workspaceId, ...privacyFilter(actor) };
  
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
  dueAt?: Date | null;
  proposalId?: string | null;
  isPrivate?: boolean;
  _membership?: import("@corgtex/shared").MembershipSummary | null;
}) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
    resolvedMembership: params._membership,
  });

  const title = params.title.trim();
  invariant(title.length > 0, 400, "INVALID_INPUT", "Action title is required.");
  const authorUserId = await actorUserIdForWorkspace(actor, params.workspaceId);

  return prisma.$transaction(async (tx) => {
    const action = await tx.action.create({
      data: {
        workspaceId: params.workspaceId,
        authorUserId,
        title,
        bodyMd: params.bodyMd?.trim() || null,
        circleId: params.circleId || null,
        assigneeMemberId: params.assigneeMemberId || null,
        dueAt: params.dueAt ?? null,
        proposalId: params.proposalId || null,
        isPrivate: params.isPrivate ?? false,
        publishedAt: params.isPrivate ? null : new Date(),
      },
    });

    const { memberIds, circleIds } = parseMentions(action.bodyMd);
    await createMentionNotifications(tx, {
      workspaceId: params.workspaceId,
      actorUserId: authorUserId,
      entityType: "Action",
      entityId: action.id,
      title: `You were mentioned in an action`,
      memberIds,
      circleIds,
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

    return action;
  });
}

export async function updateAction(actor: AppActor, params: {
  workspaceId: string;
  actionId: string;
  title?: string;
  bodyMd?: string | null;
  status?: "OPEN" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED";
  circleId?: string | null;
  assigneeMemberId?: string | null;
  dueAt?: Date | null;
  isPrivate?: boolean;
  _membership?: import("@corgtex/shared").MembershipSummary | null;
}) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
    resolvedMembership: params._membership,
  });

  return prisma.$transaction(async (tx) => {
    const action = await tx.action.findUnique({
      where: { id: params.actionId },
    });

    invariant(action && action.workspaceId === params.workspaceId, 404, "NOT_FOUND", "Action not found.");

    const data: Record<string, unknown> = {};
    if (params.title !== undefined) {
      const title = params.title.trim();
      invariant(title.length > 0, 400, "INVALID_INPUT", "Action title is required.");
      data.title = title;
    }
    if (params.bodyMd !== undefined) data.bodyMd = params.bodyMd?.trim() || null;
    if (params.status !== undefined) data.status = params.status;
    if (params.circleId !== undefined) data.circleId = params.circleId || null;
    if (params.assigneeMemberId !== undefined) data.assigneeMemberId = params.assigneeMemberId || null;
    if (params.dueAt !== undefined) data.dueAt = params.dueAt;
    if (params.isPrivate !== undefined) data.isPrivate = params.isPrivate;

    const updated = await tx.action.update({
      where: { id: params.actionId },
      data,
    });

    if (params.bodyMd !== undefined && params.bodyMd !== action.bodyMd) {
      const { memberIds, circleIds } = parseMentions(updated.bodyMd);
      await createMentionNotifications(tx, {
        workspaceId: params.workspaceId,
        actorUserId: actor.kind === "user" ? actor.user.id : "",
        entityType: "Action",
        entityId: updated.id,
        title: `You were mentioned in an action`,
        memberIds,
        circleIds,
      });
    }

    await recordAudit(tx, actor, {
      workspaceId: params.workspaceId,
      action: "action.updated",
      entityType: "Action",
      entityId: updated.id,
      meta: { fields: Object.keys(data) },
    });

    await appendEvents(tx, [
      {
        workspaceId: params.workspaceId,
        type: "action.updated",
        aggregateType: "Action",
        aggregateId: updated.id,
        payload: {
          actionId: updated.id,
          fields: Object.keys(data),
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

  return prisma.$transaction(async (tx) => {
    const action = await tx.action.findUnique({
      where: { id: params.actionId },
    });

    invariant(action && action.workspaceId === params.workspaceId, 404, "NOT_FOUND", "Action not found.");

    await tx.action.delete({ where: { id: params.actionId } });

    await recordAudit(tx, actor, {
      workspaceId: params.workspaceId,
      action: "action.deleted",
      entityType: "Action",
      entityId: params.actionId,
      meta: { title: action.title },
    });

    return { id: params.actionId };
  });
}

export async function publishAction(actor: AppActor, params: {
  workspaceId: string;
  actionId: string;
  _membership?: import("@corgtex/shared").MembershipSummary | null;
}) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
    resolvedMembership: params._membership,
  });

  return prisma.$transaction(async (tx) => {
    const action = await tx.action.findUnique({
      where: { id: params.actionId },
    });

    invariant(action && action.workspaceId === params.workspaceId, 404, "NOT_FOUND", "Action not found.");
    invariant(action.isPrivate, 400, "INVALID_STATE", "Action is already public.");
    invariant(actor.kind === "user" && action.authorUserId === actor.user.id, 403, "FORBIDDEN", "Only the author can publish this action.");

    const updated = await tx.action.update({
      where: { id: params.actionId },
      data: { isPrivate: false, publishedAt: new Date() },
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

export async function resolveAction(actor: AppActor, params: {
  workspaceId: string;
  actionId: string;
  resolvedVia?: string;
  _membership?: import("@corgtex/shared").MembershipSummary | null;
}) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
    resolvedMembership: params._membership,
  });

  return prisma.$transaction(async (tx) => {
    const action = await tx.action.findUnique({
      where: { id: params.actionId },
    });

    invariant(action && action.workspaceId === params.workspaceId, 404, "NOT_FOUND", "Action not found.");
    invariant(action.status !== "COMPLETED", 400, "INVALID_STATE", "Action is already resolved.");

    const updated = await tx.action.update({
      where: { id: params.actionId },
      data: {
        status: "COMPLETED",
        resolvedVia: params.resolvedVia?.trim() || null,
        resolvedAt: new Date(),
      },
    });

    await recordAudit(tx, actor, {
      workspaceId: params.workspaceId,
      action: "action.resolved",
      entityType: "Action",
      entityId: updated.id,
    });

    await appendEvents(tx, [
      {
        workspaceId: params.workspaceId,
        type: "action.resolved",
        aggregateType: "Action",
        aggregateId: updated.id,
        payload: { actionId: updated.id },
      },
    ]);

    return updated;
  });
}
