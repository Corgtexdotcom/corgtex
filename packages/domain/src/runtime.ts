import type { Prisma } from "@prisma/client";
import { prisma } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import { requireWorkspaceMembership } from "./auth";
import { invariant } from "./errors";

const DEFAULT_RUNTIME_TAKE = 25;
const MAX_RUNTIME_TAKE = 100;

function normalizeTake(take?: number) {
  if (!Number.isFinite(take)) {
    return DEFAULT_RUNTIME_TAKE;
  }

  return Math.max(1, Math.min(MAX_RUNTIME_TAKE, Math.floor(take ?? DEFAULT_RUNTIME_TAKE)));
}

function isJsonObject(value: Prisma.JsonValue | null | undefined): value is Prisma.JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function buildReplayPayload(
  payload: Prisma.JsonValue,
  replayMeta: {
    replayOfEventId?: string;
    replayOfJobId?: string;
  },
): Prisma.InputJsonValue {
  const metadata: Prisma.InputJsonObject = {
    ...replayMeta,
    replayRequestedAt: new Date().toISOString(),
  };

  if (isJsonObject(payload)) {
    const existingMeta = isJsonObject(payload.runtimeMeta as Prisma.JsonValue | undefined)
      ? (payload.runtimeMeta as Prisma.InputJsonObject)
      : {};

    return {
      ...(payload as Prisma.InputJsonObject),
      runtimeMeta: {
        ...existingMeta,
        ...metadata,
      },
    };
  }

  return {
    runtimeMeta: metadata,
    replayPayload: payload as Prisma.InputJsonValue,
  };
}

export async function listRuntimeEvents(actor: AppActor, workspaceId: string, opts?: { take?: number }) {
  await requireWorkspaceMembership({
    actor,
    workspaceId,
  });

  return prisma.event.findMany({
    where: { workspaceId },
    select: {
      id: true,
      type: true,
      aggregateType: true,
      aggregateId: true,
      status: true,
      attempts: true,
      availableAt: true,
      lockedAt: true,
      lockedBy: true,
      dispatchedAt: true,
      error: true,
      createdAt: true,
      jobs: {
        select: {
          id: true,
          type: true,
          status: true,
          createdAt: true,
        },
        orderBy: { createdAt: "desc" },
        take: 3,
      },
    },
    orderBy: { createdAt: "desc" },
    take: normalizeTake(opts?.take),
  });
}

export async function listRuntimeJobs(actor: AppActor, workspaceId: string, opts?: { take?: number }) {
  await requireWorkspaceMembership({
    actor,
    workspaceId,
  });

  return prisma.workflowJob.findMany({
    where: { workspaceId },
    select: {
      id: true,
      eventId: true,
      type: true,
      status: true,
      dedupeKey: true,
      attempts: true,
      runAfter: true,
      lockedAt: true,
      lockedBy: true,
      startedAt: true,
      completedAt: true,
      error: true,
      createdAt: true,
      updatedAt: true,
      event: {
        select: {
          id: true,
          type: true,
          status: true,
        },
      },
    },
    orderBy: { createdAt: "desc" },
    take: normalizeTake(opts?.take),
  });
}

export async function replayEvent(actor: AppActor, params: {
  workspaceId: string;
  eventId: string;
}) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
    allowedRoles: ["ADMIN", "FACILITATOR"],
  });

  return prisma.$transaction(async (tx) => {
    const event = await tx.event.findUnique({
      where: { id: params.eventId },
      select: {
        id: true,
        workspaceId: true,
        type: true,
        aggregateType: true,
        aggregateId: true,
        payload: true,
      },
    });

    invariant(event && event.workspaceId === params.workspaceId, 404, "NOT_FOUND", "Event not found.");

    const replayedEvent = await tx.event.create({
      data: {
        workspaceId: event.workspaceId,
        type: event.type,
        aggregateType: event.aggregateType,
        aggregateId: event.aggregateId,
        payload: buildReplayPayload(event.payload, {
          replayOfEventId: event.id,
        }),
      },
      select: {
        id: true,
        workspaceId: true,
        type: true,
        status: true,
        createdAt: true,
      },
    });

    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId: actor.kind === "user" ? actor.user.id : null,
        action: "event.replayed",
        entityType: "Event",
        entityId: event.id,
        meta: {
          replayEventId: replayedEvent.id,
          type: event.type,
        },
      },
    });

    return replayedEvent;
  });
}

export async function replayWorkflowJob(actor: AppActor, params: {
  workspaceId: string;
  workflowJobId: string;
}) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
    allowedRoles: ["ADMIN", "FACILITATOR"],
  });

  return prisma.$transaction(async (tx) => {
    const job = await tx.workflowJob.findUnique({
      where: { id: params.workflowJobId },
      select: {
        id: true,
        workspaceId: true,
        eventId: true,
        type: true,
        payload: true,
      },
    });

    invariant(job && job.workspaceId === params.workspaceId, 404, "NOT_FOUND", "Workflow job not found.");

    const replayedJob = await tx.workflowJob.create({
      data: {
        workspaceId: job.workspaceId,
        eventId: job.eventId,
        type: job.type,
        payload: buildReplayPayload(job.payload, {
          replayOfJobId: job.id,
        }),
        dedupeKey: null,
        runAfter: new Date(),
      },
      select: {
        id: true,
        workspaceId: true,
        type: true,
        status: true,
        createdAt: true,
      },
    });

    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId: actor.kind === "user" ? actor.user.id : null,
        action: "workflowJob.replayed",
        entityType: "WorkflowJob",
        entityId: job.id,
        meta: {
          replayWorkflowJobId: replayedJob.id,
          type: job.type,
        },
      },
    });

    return replayedJob;
  });
}

export async function listFailedJobs(actor: AppActor, workspaceId: string, opts?: { take?: number; skip?: number }) {
  await requireWorkspaceMembership({ actor, workspaceId, allowedRoles: ["ADMIN", "FACILITATOR"] });

  return prisma.workflowJob.findMany({
    where: {
      workspaceId,
      status: "FAILED"
    },
    orderBy: { createdAt: "desc" },
    take: opts?.take ?? 50,
    skip: opts?.skip ?? 0
  });
}

export async function discardFailedJob(actor: AppActor, params: { workspaceId: string; workflowJobId: string }) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId, allowedRoles: ["ADMIN", "FACILITATOR"] });

  return prisma.workflowJob.updateMany({
    where: {
      id: params.workflowJobId,
      workspaceId: params.workspaceId,
      status: "FAILED"
    },
    data: {
      status: "CANCELLED"
    }
  });
}

