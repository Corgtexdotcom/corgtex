import { prisma } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import { appendEvents } from "./events";
import { actorUserIdForWorkspace, requireWorkspaceMembership } from "./auth";
import { invariant } from "./errors";

import { privacyFilter } from "./privacy";

export async function listTensions(actor: AppActor, workspaceId: string, opts?: { take?: number; skip?: number }) {
  const take = opts?.take ?? 20;
  const skip = opts?.skip ?? 0;
  const where = { workspaceId, ...privacyFilter(actor) };

  const [items, total] = await Promise.all([
    prisma.tension.findMany({
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
        upvotes: true,
        proposal: { select: { id: true, title: true } },
      },
      orderBy: { createdAt: "desc" },
      take,
      skip,
    }),
    prisma.tension.count({ where }),
  ]);
  return { items, total, take, skip };
}

export async function createTension(actor: AppActor, params: {
  workspaceId: string;
  title: string;
  bodyMd?: string | null;
  circleId?: string | null;
  assigneeMemberId?: string | null;
  proposalId?: string | null;
  isPrivate?: boolean;
  meetingId?: string | null;
}) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
  });

  const title = params.title.trim();
  invariant(title.length > 0, 400, "INVALID_INPUT", "Tension title is required.");
  const authorUserId = await actorUserIdForWorkspace(actor, params.workspaceId);

  return prisma.$transaction(async (tx) => {
    const tension = await tx.tension.create({
      data: {
        workspaceId: params.workspaceId,
        authorUserId,
        title,
        bodyMd: params.bodyMd?.trim() || null,
        circleId: params.circleId || null,
        assigneeMemberId: params.assigneeMemberId || null,
        proposalId: params.proposalId || null,
        isPrivate: params.isPrivate ?? false,
        meetingId: params.meetingId || null,
        publishedAt: params.isPrivate ? null : new Date(),
      },
    });

    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId: actor.kind === "user" ? actor.user.id : null,
        action: "tension.created",
        entityType: "Tension",
        entityId: tension.id,
        meta: { title: tension.title },
      },
    });

    await appendEvents(tx, [
      {
        workspaceId: params.workspaceId,
        type: "tension.created",
        aggregateType: "Tension",
        aggregateId: tension.id,
        payload: {
          tensionId: tension.id,
          title: tension.title,
        },
      },
    ]);

    return tension;
  });
}

export async function updateTension(actor: AppActor, params: {
  workspaceId: string;
  tensionId: string;
  title?: string;
  bodyMd?: string | null;
  status?: "OPEN" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED";
  circleId?: string | null;
  assigneeMemberId?: string | null;
  priority?: number;
  isPrivate?: boolean;
}) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
  });

  return prisma.$transaction(async (tx) => {
    const tension = await tx.tension.findUnique({
      where: { id: params.tensionId },
    });

    invariant(tension && tension.workspaceId === params.workspaceId, 404, "NOT_FOUND", "Tension not found.");

    const data: Record<string, unknown> = {};
    if (params.title !== undefined) {
      const title = params.title.trim();
      invariant(title.length > 0, 400, "INVALID_INPUT", "Tension title is required.");
      data.title = title;
    }
    if (params.bodyMd !== undefined) data.bodyMd = params.bodyMd?.trim() || null;
    if (params.status !== undefined) data.status = params.status;
    if (params.circleId !== undefined) data.circleId = params.circleId || null;
    if (params.assigneeMemberId !== undefined) data.assigneeMemberId = params.assigneeMemberId || null;
    if (params.priority !== undefined) data.priority = params.priority;
    if (params.isPrivate !== undefined) data.isPrivate = params.isPrivate;

    const updated = await tx.tension.update({
      where: { id: params.tensionId },
      data,
    });

    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId: actor.kind === "user" ? actor.user.id : null,
        action: "tension.updated",
        entityType: "Tension",
        entityId: updated.id,
        meta: { fields: Object.keys(data) },
      },
    });

    await appendEvents(tx, [
      {
        workspaceId: params.workspaceId,
        type: "tension.updated",
        aggregateType: "Tension",
        aggregateId: updated.id,
        payload: {
          tensionId: updated.id,
          fields: Object.keys(data),
        },
      },
    ]);

    return updated;
  });
}

export async function deleteTension(actor: AppActor, params: {
  workspaceId: string;
  tensionId: string;
}) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
  });

  return prisma.$transaction(async (tx) => {
    const tension = await tx.tension.findUnique({
      where: { id: params.tensionId },
    });

    invariant(tension && tension.workspaceId === params.workspaceId, 404, "NOT_FOUND", "Tension not found.");

    await tx.tension.delete({ where: { id: params.tensionId } });

    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId: actor.kind === "user" ? actor.user.id : null,
        action: "tension.deleted",
        entityType: "Tension",
        entityId: params.tensionId,
        meta: { title: tension.title },
      },
    });

    return { id: params.tensionId };
  });
}

export async function upvoteTension(actor: AppActor, params: {
  workspaceId: string;
  tensionId: string;
}) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
  });

  invariant(actor.kind === "user", 400, "INVALID_ACTOR", "Only users can upvote.");

  const tension = await prisma.tension.findUnique({
    where: { id: params.tensionId },
  });

  invariant(tension && tension.workspaceId === params.workspaceId, 404, "NOT_FOUND", "Tension not found.");

  return prisma.tensionUpvote.upsert({
    where: {
      tensionId_userId: {
        tensionId: params.tensionId,
        userId: actor.user.id,
      },
    },
    update: {},
    create: {
      tensionId: params.tensionId,
      userId: actor.user.id,
    },
  });
}

export async function publishTension(actor: AppActor, params: {
  workspaceId: string;
  tensionId: string;
}) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
  });

  return prisma.$transaction(async (tx) => {
    const tension = await tx.tension.findUnique({
      where: { id: params.tensionId },
    });

    invariant(tension && tension.workspaceId === params.workspaceId, 404, "NOT_FOUND", "Tension not found.");
    invariant(tension.isPrivate, 400, "INVALID_STATE", "Tension is already public.");
    invariant(actor.kind === "user" && tension.authorUserId === actor.user.id, 403, "FORBIDDEN", "Only the author can publish this tension.");

    const updated = await tx.tension.update({
      where: { id: params.tensionId },
      data: { isPrivate: false, publishedAt: new Date() },
    });

    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId: actor.kind === "user" ? actor.user.id : null,
        action: "tension.published",
        entityType: "Tension",
        entityId: updated.id,
        meta: { title: updated.title },
      },
    });

    await appendEvents(tx, [
      {
        workspaceId: params.workspaceId,
        type: "tension.published",
        aggregateType: "Tension",
        aggregateId: updated.id,
        payload: { tensionId: updated.id },
      },
    ]);

    return updated;
  });
}
