import { prisma } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import { actorUserIdForWorkspace, requireWorkspaceMembership } from "./auth";
import { invariant } from "./errors";
import { appendEvents } from "./events";
import { parseMentions, createMentionNotifications } from "./mentions";

export async function listComments(
  actor: AppActor,
  params: { workspaceId: string; entityType: string; entityId: string }
) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  return prisma.comment.findMany({
    where: {
      workspaceId: params.workspaceId,
      entityType: params.entityType,
      entityId: params.entityId,
    },
    include: {
      author: {
        select: {
          id: true,
          displayName: true,
          email: true,
        },
      },
    },
    orderBy: { createdAt: "asc" },
  });
}

export async function postComment(
  actor: AppActor,
  params: { workspaceId: string; entityType: string; entityId: string; bodyMd: string }
) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  const authorUserId = await actorUserIdForWorkspace(actor, params.workspaceId);
  const bodyMd = params.bodyMd.trim();
  invariant(bodyMd.length > 0, 400, "INVALID_INPUT", "Comment body cannot be empty");

  const { memberIds, circleIds } = parseMentions(bodyMd);

  return prisma.$transaction(async (tx) => {
    const comment = await tx.comment.create({
      data: {
        workspaceId: params.workspaceId,
        entityType: params.entityType,
        entityId: params.entityId,
        authorUserId,
        bodyMd,
        mentionedMemberIds: memberIds,
        mentionedCircleIds: circleIds,
      },
    });

    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId: actor.kind === "user" ? actor.user.id : null,
        action: "comment.posted",
        entityType: "Comment",
        entityId: comment.id,
        meta: {
          targetEntityType: params.entityType,
          targetEntityId: params.entityId,
        },
      },
    });

    await appendEvents(tx, [
      {
        workspaceId: params.workspaceId,
        type: "comment.posted",
        aggregateType: "Comment",
        aggregateId: comment.id,
        payload: {
          commentId: comment.id,
          entityType: params.entityType,
          entityId: params.entityId,
        },
      },
    ]);

    await createMentionNotifications(tx, {
      workspaceId: params.workspaceId,
      actorUserId: authorUserId,
      entityType: params.entityType,
      entityId: params.entityId,
      title: `You were mentioned in a ${params.entityType} comment`,
      memberIds,
      circleIds,
    });

    return comment;
  });
}

export async function resolveComment(
  actor: AppActor,
  params: { workspaceId: string; commentId: string; resolvedNote?: string }
) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });

  return prisma.$transaction(async (tx) => {
    const comment = await tx.comment.findUnique({
      where: { id: params.commentId },
    });
    invariant(comment && comment.workspaceId === params.workspaceId, 404, "NOT_FOUND", "Comment not found");
    invariant(!comment.resolvedAt, 400, "INVALID_STATE", "Comment is already resolved");

    const updated = await tx.comment.update({
      where: { id: params.commentId },
      data: {
        resolvedAt: new Date(),
        resolvedNote: params.resolvedNote?.trim() || null,
      },
    });

    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId: actor.kind === "user" ? actor.user.id : null,
        action: "comment.resolved",
        entityType: "Comment",
        entityId: comment.id,
      },
    });

    await appendEvents(tx, [
      {
        workspaceId: params.workspaceId,
        type: "comment.resolved",
        aggregateType: "Comment",
        aggregateId: comment.id,
        payload: { commentId: comment.id },
      },
    ]);

    return updated;
  });
}

export async function deleteComment(
  actor: AppActor,
  params: { workspaceId: string; commentId: string }
) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  const authorUserId = await actorUserIdForWorkspace(actor, params.workspaceId);

  return prisma.$transaction(async (tx) => {
    const comment = await tx.comment.findUnique({
      where: { id: params.commentId },
    });
    invariant(comment && comment.workspaceId === params.workspaceId, 404, "NOT_FOUND", "Comment not found");
    invariant(comment.authorUserId === authorUserId || actor.kind === "agent", 403, "FORBIDDEN", "Only author can delete comment");

    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId: actor.kind === "user" ? actor.user.id : null,
        action: "comment.deleted",
        entityType: "Comment",
        entityId: comment.id,
      },
    });

    await tx.comment.delete({ where: { id: params.commentId } });
    return true;
  });
}
