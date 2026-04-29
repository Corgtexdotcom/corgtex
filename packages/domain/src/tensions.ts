import { prisma } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import type { Prisma } from "@prisma/client";
import { appendEvents } from "./events";
import { actorUserIdForWorkspace, requireWorkspaceMembership } from "./auth";
import { archiveFilterWhere, archiveWorkspaceArtifact, type ArchiveFilter } from "./archive";
import { invariant } from "./errors";
import { requireDraftManager } from "./draft-permissions";

import { privacyFilter } from "./privacy";

async function resolveRaisedByMemberId(tx: Prisma.TransactionClient, workspaceId: string, raisedByMemberId?: string | null) {
  if (!raisedByMemberId) return null;

  const member = await tx.member.findFirst({
    where: {
      id: raisedByMemberId,
      workspaceId,
      isActive: true,
    },
    select: { id: true },
  });
  invariant(member, 400, "INVALID_INPUT", "Raised-by member must be an active member of this workspace.");
  return member.id;
}

export async function listTensions(actor: AppActor, workspaceId: string, opts?: { take?: number; skip?: number; archiveFilter?: ArchiveFilter }) {
  const take = opts?.take ?? 20;
  const skip = opts?.skip ?? 0;
  const membership = await requireWorkspaceMembership({ actor, workspaceId });
  const where = { workspaceId, ...privacyFilter(actor, membership), ...archiveFilterWhere(opts?.archiveFilter) };

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
        raisedByMember: {
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
  raisedByMemberId?: string | null;
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
    const raisedByMemberId = await resolveRaisedByMemberId(tx, params.workspaceId, params.raisedByMemberId);
    const tension = await tx.tension.create({
      data: {
        workspaceId: params.workspaceId,
        authorUserId,
        title,
        bodyMd: params.bodyMd?.trim() || null,
        circleId: params.circleId || null,
        assigneeMemberId: params.assigneeMemberId || null,
        raisedByMemberId,
        proposalId: params.proposalId || null,
        status: "DRAFT",
        isPrivate: params.isPrivate ?? true,
        meetingId: params.meetingId || null,
        publishedAt: null,
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
  status?: "DRAFT" | "OPEN" | "RESOLVED";
  resolvedVia?: string | null;
  circleId?: string | null;
  assigneeMemberId?: string | null;
  raisedByMemberId?: string | null;
  priority?: number;
  isPrivate?: boolean;
}) {
  const membership = await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
  });

  return prisma.$transaction(async (tx) => {
    const tension = await tx.tension.findUnique({
      where: { id: params.tensionId },
    });

    invariant(tension && tension.workspaceId === params.workspaceId, 404, "NOT_FOUND", "Tension not found.");

    const data: Record<string, unknown> = {};
    const editsDraftContent = params.title !== undefined
      || params.bodyMd !== undefined
      || params.circleId !== undefined
      || params.assigneeMemberId !== undefined
      || params.raisedByMemberId !== undefined
      || params.priority !== undefined
      || params.isPrivate !== undefined;
    if (editsDraftContent) {
      invariant(tension.status === "DRAFT", 400, "INVALID_STATE", "Only draft tensions can be edited.");
      await requireDraftManager({ actor, workspaceId: params.workspaceId, record: tension, resolvedMembership: membership });
    }
    if (params.title !== undefined) {
      const title = params.title.trim();
      invariant(title.length > 0, 400, "INVALID_INPUT", "Tension title is required.");
      data.title = title;
    }
    if (params.bodyMd !== undefined) data.bodyMd = params.bodyMd?.trim() || null;
    if (params.status !== undefined) {
      if (params.status === "DRAFT") {
        invariant(tension.status === "OPEN", 400, "INVALID_STATE", "Only open tensions can be returned to draft.");
        await requireDraftManager({ actor, workspaceId: params.workspaceId, record: tension, resolvedMembership: membership });
        data.isPrivate = true;
        data.publishedAt = null;
        data.resolvedVia = null;
      } else if (tension.status === "DRAFT") {
        await requireDraftManager({ actor, workspaceId: params.workspaceId, record: tension, resolvedMembership: membership });
      }
      data.status = params.status;
      if (params.status !== "DRAFT") {
        data.isPrivate = false;
        data.publishedAt = tension.publishedAt || new Date();
      }
      if (params.status === "RESOLVED") {
        const resolvedVia = params.resolvedVia?.trim() || "";
        invariant(resolvedVia.length > 0, 400, "INVALID_INPUT", "Resolution note is required.");
        data.resolvedVia = resolvedVia;
      }
    }
    if (params.resolvedVia !== undefined && params.status !== "RESOLVED") {
      data.resolvedVia = params.resolvedVia?.trim() || null;
    }
    if (params.circleId !== undefined) data.circleId = params.circleId || null;
    if (params.assigneeMemberId !== undefined) data.assigneeMemberId = params.assigneeMemberId || null;
    if (params.raisedByMemberId !== undefined) {
      data.raisedByMemberId = await resolveRaisedByMemberId(tx, params.workspaceId, params.raisedByMemberId);
    }
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

  await archiveWorkspaceArtifact(actor, {
    workspaceId: params.workspaceId,
    entityType: "Tension",
    entityId: params.tensionId,
    reason: "Archived from tension delete path.",
  });

  return { id: params.tensionId };
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
  const membership = await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
  });

  return prisma.$transaction(async (tx) => {
    const tension = await tx.tension.findUnique({
      where: { id: params.tensionId },
    });

    invariant(tension && tension.workspaceId === params.workspaceId, 404, "NOT_FOUND", "Tension not found.");
    invariant(tension.isPrivate, 400, "INVALID_STATE", "Tension is already public.");
    invariant(tension.status === "DRAFT", 400, "INVALID_STATE", "Only draft tensions can be opened.");
    await requireDraftManager({ actor, workspaceId: params.workspaceId, record: tension, resolvedMembership: membership });

    const updated = await tx.tension.update({
      where: { id: params.tensionId },
      data: { status: "OPEN", isPrivate: false, publishedAt: new Date() },
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

export async function returnTensionToDraft(actor: AppActor, params: {
  workspaceId: string;
  tensionId: string;
}) {
  const membership = await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
  });

  return prisma.$transaction(async (tx) => {
    const tension = await tx.tension.findUnique({
      where: { id: params.tensionId },
    });

    invariant(tension && tension.workspaceId === params.workspaceId, 404, "NOT_FOUND", "Tension not found.");
    invariant(tension.status === "OPEN", 400, "INVALID_STATE", "Only open tensions can be returned to draft.");
    await requireDraftManager({ actor, workspaceId: params.workspaceId, record: tension, resolvedMembership: membership });

    const updated = await tx.tension.update({
      where: { id: params.tensionId },
      data: {
        status: "DRAFT",
        isPrivate: true,
        publishedAt: null,
        resolvedVia: null,
      },
    });

    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId: actor.kind === "user" ? actor.user.id : null,
        action: "tension.returned_to_draft",
        entityType: "Tension",
        entityId: updated.id,
        meta: { title: updated.title },
      },
    });

    await appendEvents(tx, [
      {
        workspaceId: params.workspaceId,
        type: "tension.returned_to_draft",
        aggregateType: "Tension",
        aggregateId: updated.id,
        payload: { tensionId: updated.id },
      },
    ]);

    return updated;
  });
}

export async function getTension(actor: AppActor, params: { workspaceId: string; tensionId: string }) {
  const membership = await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  const tension = await prisma.tension.findFirst({
    where: {
      id: params.tensionId,
      workspaceId: params.workspaceId,
      ...privacyFilter(actor, membership),
    },
    include: {
      author: { select: { id: true, displayName: true, email: true } },
      circle: { select: { id: true, name: true } },
      raisedByMember: { include: { user: { select: { displayName: true, email: true } } } },
      proposal: { select: { id: true, title: true, status: true } },
      upvotes: true,
    },
  });
  invariant(tension, 404, "NOT_FOUND", "Tension not found.");
  return tension;
}
