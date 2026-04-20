import type { CycleStatus } from "@prisma/client";
import { prisma } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import { actorUserIdForWorkspace, requireWorkspaceMembership } from "./auth";
import { appendEvents } from "./events";
import { invariant } from "./errors";

const MUTABLE_CYCLE_STATUSES = new Set<CycleStatus>(["PLANNED", "OPEN_UPDATES", "OPEN_ALLOCATIONS", "REVIEW"]);

type CycleWindowInput = {
  startDate: Date;
  endDate: Date;
  pointsPerUser: number;
};

export function normalizeCycleWindow(params: CycleWindowInput) {
  invariant(Number.isInteger(params.pointsPerUser) && params.pointsPerUser > 0, 400, "INVALID_INPUT", "pointsPerUser must be a positive integer.");
  invariant(params.startDate instanceof Date && Number.isFinite(params.startDate.valueOf()), 400, "INVALID_INPUT", "startDate is required.");
  invariant(params.endDate instanceof Date && Number.isFinite(params.endDate.valueOf()), 400, "INVALID_INPUT", "endDate is required.");
  invariant(params.endDate > params.startDate, 400, "INVALID_INPUT", "endDate must be after startDate.");

  return {
    startDate: params.startDate,
    endDate: params.endDate,
    pointsPerUser: params.pointsPerUser,
  };
}

export function normalizeAllocationPoints(points: number) {
  invariant(Number.isInteger(points) && points > 0, 400, "INVALID_INPUT", "points must be a positive integer.");
  return points;
}

export async function listCycles(workspaceId: string, opts?: { take?: number; skip?: number }) {
  const take = opts?.take ?? 20;
  const skip = opts?.skip ?? 0;
  const [items, total] = await Promise.all([
    prisma.cycle.findMany({
      where: { workspaceId },
      include: {
        updates: {
          include: {
            user: {
              select: {
                id: true,
                email: true,
                displayName: true,
              },
            },
          },
          orderBy: { updatedAt: "desc" },
        },
        allocations: {
          include: {
            fromUser: {
              select: {
                id: true,
                email: true,
                displayName: true,
              },
            },
            toUser: {
              select: {
                id: true,
                email: true,
                displayName: true,
              },
            },
          },
          orderBy: { createdAt: "desc" },
        },
      },
      orderBy: [{ startDate: "desc" }, { createdAt: "desc" }],
      take,
      skip,
    }),
    prisma.cycle.count({ where: { workspaceId } }),
  ]);

  return { items, total, take, skip };
}

async function requireCycleMutationAccess(actor: AppActor, workspaceId: string) {
  return requireWorkspaceMembership({
    actor,
    workspaceId,
    allowedRoles: ["FACILITATOR", "ADMIN"],
  });
}

async function findCycleForWorkspace(tx: typeof prisma | Parameters<Parameters<typeof prisma.$transaction>[0]>[0], workspaceId: string, cycleId: string) {
  const cycle = await tx.cycle.findUnique({
    where: { id: cycleId },
  });
  invariant(cycle && cycle.workspaceId === workspaceId, 404, "NOT_FOUND", "Cycle not found.");
  return cycle;
}

async function requireActiveMemberUser(tx: typeof prisma | Parameters<Parameters<typeof prisma.$transaction>[0]>[0], workspaceId: string, userId: string) {
  const member = await tx.member.findUnique({
    where: {
      workspaceId_userId: {
        workspaceId,
        userId,
      },
    },
    select: {
      id: true,
      userId: true,
      role: true,
      isActive: true,
    },
  });
  invariant(member?.isActive, 400, "INVALID_INPUT", "User must be an active workspace member.");
  return member;
}

export async function createCycle(actor: AppActor, params: {
  workspaceId: string;
  name: string;
  cadence: string;
  startDate: Date;
  endDate: Date;
  pointsPerUser: number;
}) {
  await requireCycleMutationAccess(actor, params.workspaceId);

  const name = params.name.trim();
  const cadence = params.cadence.trim();
  invariant(name.length > 0, 400, "INVALID_INPUT", "Cycle name is required.");
  invariant(cadence.length > 0, 400, "INVALID_INPUT", "Cycle cadence is required.");
  const window = normalizeCycleWindow(params);

  return prisma.$transaction(async (tx) => {
    const cycle = await tx.cycle.create({
      data: {
        workspaceId: params.workspaceId,
        name,
        cadence,
        startDate: window.startDate,
        endDate: window.endDate,
        pointsPerUser: window.pointsPerUser,
      },
    });

    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId: actor.kind === "user" ? actor.user.id : null,
        action: "cycle.created",
        entityType: "Cycle",
        entityId: cycle.id,
        meta: {
          name: cycle.name,
          cadence: cycle.cadence,
        },
      },
    });

    await appendEvents(tx, [
      {
        workspaceId: params.workspaceId,
        type: "cycle.created",
        aggregateType: "Cycle",
        aggregateId: cycle.id,
        payload: {
          cycleId: cycle.id,
          status: cycle.status,
        },
      },
    ]);

    return cycle;
  });
}

export async function updateCycle(actor: AppActor, params: {
  workspaceId: string;
  cycleId: string;
  name?: string;
  cadence?: string;
  status?: CycleStatus;
  startDate?: Date;
  endDate?: Date;
  pointsPerUser?: number;
}) {
  await requireCycleMutationAccess(actor, params.workspaceId);

  return prisma.$transaction(async (tx) => {
    const cycle = await findCycleForWorkspace(tx, params.workspaceId, params.cycleId);
    invariant(MUTABLE_CYCLE_STATUSES.has(cycle.status) || params.status === cycle.status, 400, "INVALID_STATE", "Finalized cycles cannot be edited.");

    const data: Record<string, unknown> = {};
    if (params.name !== undefined) {
      const name = params.name.trim();
      invariant(name.length > 0, 400, "INVALID_INPUT", "Cycle name is required.");
      data.name = name;
    }
    if (params.cadence !== undefined) {
      const cadence = params.cadence.trim();
      invariant(cadence.length > 0, 400, "INVALID_INPUT", "Cycle cadence is required.");
      data.cadence = cadence;
    }
    if (params.pointsPerUser !== undefined || params.startDate !== undefined || params.endDate !== undefined) {
      const window = normalizeCycleWindow({
        startDate: params.startDate ?? cycle.startDate,
        endDate: params.endDate ?? cycle.endDate,
        pointsPerUser: params.pointsPerUser ?? cycle.pointsPerUser,
      });
      data.startDate = window.startDate;
      data.endDate = window.endDate;
      data.pointsPerUser = window.pointsPerUser;
    }
    if (params.status !== undefined) {
      data.status = params.status;
    }

    invariant(Object.keys(data).length > 0, 400, "INVALID_INPUT", "At least one field must be updated.");

    const updated = await tx.cycle.update({
      where: { id: params.cycleId },
      data,
    });

    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId: actor.kind === "user" ? actor.user.id : null,
        action: "cycle.updated",
        entityType: "Cycle",
        entityId: updated.id,
        meta: { fields: Object.keys(data) },
      },
    });

    await appendEvents(tx, [
      {
        workspaceId: params.workspaceId,
        type: "cycle.updated",
        aggregateType: "Cycle",
        aggregateId: updated.id,
        payload: {
          cycleId: updated.id,
          fields: Object.keys(data),
        },
      },
    ]);

    return updated;
  });
}

export async function upsertCycleUpdate(actor: AppActor, params: {
  workspaceId: string;
  cycleId: string;
  updateMd: string;
  cashPaidCents?: number | null;
  cashPaidCurrency?: string | null;
  valueEstimateCents?: number | null;
  valueEstimateCurrency?: string | null;
  valueConfidence?: string | null;
}) {
  const membership = await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
  });
  invariant(actor.kind === "user", 400, "INVALID_ACTOR", "Only users can post cycle updates.");

  const updateMd = params.updateMd.trim();
  invariant(updateMd.length > 0, 400, "INVALID_INPUT", "updateMd is required.");
  if (params.cashPaidCents !== undefined && params.cashPaidCents !== null) {
    invariant(Number.isInteger(params.cashPaidCents) && params.cashPaidCents >= 0, 400, "INVALID_INPUT", "cashPaidCents must be a non-negative integer.");
  }
  if (params.valueEstimateCents !== undefined && params.valueEstimateCents !== null) {
    invariant(Number.isInteger(params.valueEstimateCents) && params.valueEstimateCents >= 0, 400, "INVALID_INPUT", "valueEstimateCents must be a non-negative integer.");
  }

  return prisma.$transaction(async (tx) => {
    const cycle = await findCycleForWorkspace(tx, params.workspaceId, params.cycleId);
    invariant(cycle.status !== "FINALIZED", 400, "INVALID_STATE", "Finalized cycles cannot receive updates.");

    const cycleUpdate = await tx.cycleUpdate.upsert({
      where: {
        cycleId_userId: {
          cycleId: params.cycleId,
          userId: membership!.userId,
        },
      },
      update: {
        updateMd,
        cashPaidCents: params.cashPaidCents ?? null,
        cashPaidCurrency: params.cashPaidCurrency?.trim().toUpperCase() || null,
        valueEstimateCents: params.valueEstimateCents ?? null,
        valueEstimateCurrency: params.valueEstimateCurrency?.trim().toUpperCase() || null,
        valueConfidence: params.valueConfidence?.trim() || null,
      },
      create: {
        cycleId: params.cycleId,
        userId: membership!.userId,
        updateMd,
        cashPaidCents: params.cashPaidCents ?? null,
        cashPaidCurrency: params.cashPaidCurrency?.trim().toUpperCase() || null,
        valueEstimateCents: params.valueEstimateCents ?? null,
        valueEstimateCurrency: params.valueEstimateCurrency?.trim().toUpperCase() || null,
        valueConfidence: params.valueConfidence?.trim() || null,
      },
    });

    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId: membership!.userId,
        action: "cycle.update.upserted",
        entityType: "CycleUpdate",
        entityId: cycleUpdate.id,
        meta: {
          cycleId: params.cycleId,
        },
      },
    });

    await appendEvents(tx, [
      {
        workspaceId: params.workspaceId,
        type: "cycle.update.upserted",
        aggregateType: "Cycle",
        aggregateId: params.cycleId,
        payload: {
          cycleId: params.cycleId,
          cycleUpdateId: cycleUpdate.id,
          userId: membership!.userId,
        },
      },
    ]);

    return cycleUpdate;
  });
}

function normalizeFromUserId(actor: AppActor, requestedFromUserId: string | null | undefined) {
  invariant(actor.kind === "user", 400, "INVALID_ACTOR", "Only users can manage allocations.");
  const fromUserId = requestedFromUserId?.trim() || actor.user.id;
  return {
    fromUserId,
    isOnBehalfOfAnotherUser: fromUserId !== actor.user.id,
  };
}

export async function createAllocation(actor: AppActor, params: {
  workspaceId: string;
  cycleId: string;
  toUserId: string;
  points: number;
  note?: string | null;
  fromUserId?: string | null;
}) {
  const membership = await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
  });
  const { fromUserId, isOnBehalfOfAnotherUser } = normalizeFromUserId(actor, params.fromUserId);
  const actorUserId = actor.kind === "user" ? actor.user.id : null;

  if (isOnBehalfOfAnotherUser) {
    invariant(
      membership?.role === "ADMIN" || membership?.role === "FACILITATOR",
      403,
      "FORBIDDEN",
      "Only facilitators or admins can create allocations on behalf of another member.",
    );
  }

  const points = normalizeAllocationPoints(params.points);
  const note = params.note?.trim() || null;

  return prisma.$transaction(async (tx) => {
    const cycle = await findCycleForWorkspace(tx, params.workspaceId, params.cycleId);
    invariant(cycle.status !== "FINALIZED", 400, "INVALID_STATE", "Finalized cycles cannot be changed.");
    await requireActiveMemberUser(tx, params.workspaceId, fromUserId);
    await requireActiveMemberUser(tx, params.workspaceId, params.toUserId);
    invariant(fromUserId !== params.toUserId, 400, "INVALID_INPUT", "fromUserId and toUserId must be different.");

    const allocation = await tx.allocation.create({
      data: {
        cycleId: params.cycleId,
        fromUserId,
        toUserId: params.toUserId,
        points,
        note,
      },
    });

    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId,
        action: "allocation.created",
        entityType: "Allocation",
        entityId: allocation.id,
        meta: {
          cycleId: params.cycleId,
          fromUserId,
          toUserId: params.toUserId,
          points,
        },
      },
    });

    await appendEvents(tx, [
      {
        workspaceId: params.workspaceId,
        type: "allocation.created",
        aggregateType: "Cycle",
        aggregateId: params.cycleId,
        payload: {
          cycleId: params.cycleId,
          allocationId: allocation.id,
        },
      },
    ]);

    return allocation;
  });
}

export async function updateAllocation(actor: AppActor, params: {
  workspaceId: string;
  cycleId: string;
  allocationId: string;
  toUserId?: string;
  points?: number;
  note?: string | null;
}) {
  const membership = await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
  });
  invariant(actor.kind === "user", 400, "INVALID_ACTOR", "Only users can manage allocations.");
  const actorUserId = actor.user.id;

  return prisma.$transaction(async (tx) => {
    const allocation = await tx.allocation.findUnique({
      where: { id: params.allocationId },
    });
    invariant(allocation && allocation.cycleId === params.cycleId, 404, "NOT_FOUND", "Allocation not found.");
    const cycle = await findCycleForWorkspace(tx, params.workspaceId, params.cycleId);
    invariant(cycle.status !== "FINALIZED", 400, "INVALID_STATE", "Finalized cycles cannot be changed.");
    invariant(
      allocation.fromUserId === actor.user.id || membership?.role === "ADMIN" || membership?.role === "FACILITATOR",
      403,
      "FORBIDDEN",
      "Only the allocation owner, facilitators, or admins can update an allocation.",
    );

    const data: Record<string, unknown> = {};
    if (params.toUserId !== undefined) {
      await requireActiveMemberUser(tx, params.workspaceId, params.toUserId);
      invariant(params.toUserId !== allocation.fromUserId, 400, "INVALID_INPUT", "fromUserId and toUserId must be different.");
      data.toUserId = params.toUserId;
    }
    if (params.points !== undefined) {
      data.points = normalizeAllocationPoints(params.points);
    }
    if (params.note !== undefined) {
      data.note = params.note?.trim() || null;
    }

    invariant(Object.keys(data).length > 0, 400, "INVALID_INPUT", "At least one allocation field must be updated.");

    const updated = await tx.allocation.update({
      where: { id: params.allocationId },
      data,
    });

    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId,
        action: "allocation.updated",
        entityType: "Allocation",
        entityId: updated.id,
        meta: {
          cycleId: params.cycleId,
          fields: Object.keys(data),
        },
      },
    });

    await appendEvents(tx, [
      {
        workspaceId: params.workspaceId,
        type: "allocation.updated",
        aggregateType: "Cycle",
        aggregateId: params.cycleId,
        payload: {
          cycleId: params.cycleId,
          allocationId: updated.id,
          fields: Object.keys(data),
        },
      },
    ]);

    return updated;
  });
}

export async function deleteAllocation(actor: AppActor, params: {
  workspaceId: string;
  cycleId: string;
  allocationId: string;
}) {
  const membership = await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
  });
  invariant(actor.kind === "user", 400, "INVALID_ACTOR", "Only users can manage allocations.");
  const actorUserId = actor.user.id;

  return prisma.$transaction(async (tx) => {
    const allocation = await tx.allocation.findUnique({
      where: { id: params.allocationId },
    });
    invariant(allocation && allocation.cycleId === params.cycleId, 404, "NOT_FOUND", "Allocation not found.");
    const cycle = await findCycleForWorkspace(tx, params.workspaceId, params.cycleId);
    invariant(cycle.status !== "FINALIZED", 400, "INVALID_STATE", "Finalized cycles cannot be changed.");
    invariant(
      allocation.fromUserId === actor.user.id || membership?.role === "ADMIN" || membership?.role === "FACILITATOR",
      403,
      "FORBIDDEN",
      "Only the allocation owner, facilitators, or admins can delete an allocation.",
    );

    await tx.allocation.delete({
      where: { id: params.allocationId },
    });

    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId,
        action: "allocation.deleted",
        entityType: "Allocation",
        entityId: params.allocationId,
        meta: {
          cycleId: params.cycleId,
        },
      },
    });

    await appendEvents(tx, [
      {
        workspaceId: params.workspaceId,
        type: "allocation.deleted",
        aggregateType: "Cycle",
        aggregateId: params.cycleId,
        payload: {
          cycleId: params.cycleId,
          allocationId: params.allocationId,
        },
      },
    ]);

    return { id: params.allocationId };
  });
}

export async function getCycle(workspaceId: string, cycleId: string) {
  const cycle = await prisma.cycle.findUnique({
    where: { id: cycleId },
    include: {
      updates: {
        include: {
          user: {
            select: {
              id: true,
              email: true,
              displayName: true,
            },
          },
        },
        orderBy: { updatedAt: "desc" },
      },
      allocations: {
        include: {
          fromUser: {
            select: {
              id: true,
              email: true,
              displayName: true,
            },
          },
          toUser: {
            select: {
              id: true,
              email: true,
              displayName: true,
            },
          },
        },
        orderBy: { createdAt: "desc" },
      },
    },
  });
  invariant(cycle && cycle.workspaceId === workspaceId, 404, "NOT_FOUND", "Cycle not found.");
  return cycle;
}

export async function listCycleUpdates(workspaceId: string, cycleId: string) {
  await getCycle(workspaceId, cycleId);
  return prisma.cycleUpdate.findMany({
    where: { cycleId },
    include: {
      user: {
        select: {
          id: true,
          email: true,
          displayName: true,
        },
      },
    },
    orderBy: { updatedAt: "desc" },
  });
}

export async function listAllocations(workspaceId: string, cycleId: string) {
  await getCycle(workspaceId, cycleId);
  return prisma.allocation.findMany({
    where: { cycleId },
    include: {
      fromUser: {
        select: {
          id: true,
          email: true,
          displayName: true,
        },
      },
      toUser: {
        select: {
          id: true,
          email: true,
          displayName: true,
        },
      },
    },
    orderBy: { createdAt: "desc" },
  });
}
