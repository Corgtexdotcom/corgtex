import { prisma } from "@corgtex/shared";
import type { AppActor, MembershipSummary } from "@corgtex/shared";
import { appendEvents } from "./events";
import { requireWorkspaceMembership } from "./auth";
import { recordAudit } from "./audit-trail";
import { archiveFilterWhere, archiveWorkspaceArtifact, type ArchiveFilter } from "./archive";
import { invariant } from "./errors";
import type { GoalLevel, GoalCadence, GoalStatus } from "@prisma/client";

export async function createGoal(
  actor: AppActor,
  params: {
    workspaceId: string;
    title: string;
    descriptionMd?: string | null;
    level?: GoalLevel;
    cadence?: GoalCadence;
    status?: GoalStatus;
    targetDate?: Date | null;
    startDate?: Date | null;
    parentGoalId?: string | null;
    circleId?: string | null;
    ownerMemberId?: string | null;
    _membership?: MembershipSummary | null;
  }
) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
    resolvedMembership: params._membership,
  });

  const title = params.title.trim();
  invariant(title.length > 0, 400, "INVALID_INPUT", "Goal title is required.");

  return prisma.$transaction(async (tx) => {
    const goal = await tx.goal.create({
      data: {
        workspaceId: params.workspaceId,
        title,
        descriptionMd: params.descriptionMd || null,
        level: params.level,
        cadence: params.cadence,
        status: params.status,
        targetDate: params.targetDate || null,
        startDate: params.startDate || null,
        parentGoalId: params.parentGoalId || null,
        circleId: params.circleId || null,
        ownerMemberId: params.ownerMemberId || null,
      },
    });

    await recordAudit(tx, actor, {
      workspaceId: params.workspaceId,
      action: "goal.created",
      entityType: "Goal",
      entityId: goal.id,
      meta: { title: goal.title },
    });

    await appendEvents(tx, [
      {
        workspaceId: params.workspaceId,
        type: "goal.created",
        aggregateType: "Goal",
        aggregateId: goal.id,
        payload: {
          goalId: goal.id,
          title: goal.title,
        },
      },
    ]);

    return goal;
  });
}

export async function updateGoal(
  actor: AppActor,
  params: {
    workspaceId: string;
    goalId: string;
    title?: string;
    descriptionMd?: string | null;
    level?: GoalLevel;
    cadence?: GoalCadence;
    status?: GoalStatus;
    targetDate?: Date | null;
    startDate?: Date | null;
    parentGoalId?: string | null;
    circleId?: string | null;
    ownerMemberId?: string | null;
    _membership?: MembershipSummary | null;
  }
) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
    resolvedMembership: params._membership,
  });

  return prisma.$transaction(async (tx) => {
    const goal = await tx.goal.findUnique({
      where: { id: params.goalId },
    });

    invariant(goal && goal.workspaceId === params.workspaceId && !goal.archivedAt, 404, "NOT_FOUND", "Goal not found.");

    const data: Record<string, unknown> = {};
    if (params.title !== undefined) {
      const title = params.title.trim();
      invariant(title.length > 0, 400, "INVALID_INPUT", "Goal title is required.");
      data.title = title;
    }
    if (params.descriptionMd !== undefined) data.descriptionMd = params.descriptionMd || null;
    if (params.level !== undefined) data.level = params.level;
    if (params.cadence !== undefined) data.cadence = params.cadence;
    if (params.status !== undefined) data.status = params.status;
    if (params.targetDate !== undefined) data.targetDate = params.targetDate || null;
    if (params.startDate !== undefined) data.startDate = params.startDate || null;
    if (params.parentGoalId !== undefined) data.parentGoalId = params.parentGoalId || null;
    if (params.circleId !== undefined) data.circleId = params.circleId || null;
    if (params.ownerMemberId !== undefined) data.ownerMemberId = params.ownerMemberId || null;

    const updated = await tx.goal.update({
      where: { id: params.goalId },
      data,
    });

    await recordAudit(tx, actor, {
      workspaceId: params.workspaceId,
      action: "goal.updated",
      entityType: "Goal",
      entityId: updated.id,
      meta: { fields: Object.keys(data) },
    });

    await appendEvents(tx, [
      {
        workspaceId: params.workspaceId,
        type: "goal.updated",
        aggregateType: "Goal",
        aggregateId: updated.id,
        payload: {
          goalId: updated.id,
          fields: Object.keys(data),
        },
      },
    ]);

    return updated;
  });
}

export async function deleteGoal(
  actor: AppActor,
  params: {
    workspaceId: string;
    goalId: string;
    _membership?: MembershipSummary | null;
  }
) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
    resolvedMembership: params._membership,
  });

  await archiveWorkspaceArtifact(actor, {
    workspaceId: params.workspaceId,
    entityType: "Goal",
    entityId: params.goalId,
    reason: "Archived from goal delete path.",
  });
}

export async function getGoal(
  actor: AppActor,
  params: {
    workspaceId: string;
    goalId: string;
    _membership?: MembershipSummary | null;
  }
) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
    resolvedMembership: params._membership,
  });

  const goal = await prisma.goal.findUnique({
    where: { id: params.goalId },
    include: {
      ownerMember: {
        include: {
          user: {
            select: { displayName: true, email: true },
          },
        },
      },
      childGoals: true,
      keyResults: {
        orderBy: { sortOrder: "asc" },
      },
      updates: {
        orderBy: { createdAt: "desc" },
        include: {
          authorMember: {
            include: {
              user: {
                select: { displayName: true, email: true },
              },
            },
          },
        },
      },
    },
  });

  invariant(goal && goal.workspaceId === params.workspaceId && !goal.archivedAt, 404, "NOT_FOUND", "Goal not found.");
  return goal;
}

export async function listGoals(
  actor: AppActor,
  params: {
    workspaceId: string;
    level?: GoalLevel;
    cadence?: GoalCadence;
    circleId?: string | null;
    ownerMemberId?: string | null;
    status?: GoalStatus;
    parentGoalId?: string | null;
    archiveFilter?: ArchiveFilter;
    _membership?: MembershipSummary | null;
  }
) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
    resolvedMembership: params._membership,
  });

  const query: any = { workspaceId: params.workspaceId, ...archiveFilterWhere(params.archiveFilter) };
  if (params.level !== undefined) query.level = params.level;
  if (params.cadence !== undefined) query.cadence = params.cadence;
  if (params.circleId !== undefined) query.circleId = params.circleId;
  if (params.ownerMemberId !== undefined) query.ownerMemberId = params.ownerMemberId;
  if (params.status !== undefined) query.status = params.status;
  if (params.parentGoalId !== undefined) query.parentGoalId = params.parentGoalId;

  return prisma.goal.findMany({
    where: query,
    orderBy: [{ sortOrder: "asc" }, { createdAt: "desc" }],
    include: {
      ownerMember: {
        include: {
          user: { select: { displayName: true, email: true } },
        },
      },
      keyResults: true,
      circle: true,
    },
  });
}

export async function addKeyResult(
  actor: AppActor,
  params: {
    workspaceId: string;
    goalId: string;
    title: string;
    targetValue?: number | null;
    currentValue?: number | null;
    unit?: string | null;
    _membership?: MembershipSummary | null;
  }
) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
    resolvedMembership: params._membership,
  });

  const title = params.title.trim();
  invariant(title.length > 0, 400, "INVALID_INPUT", "Key Result title is required.");

  let progressPercent = 0;
  if (params.targetValue && params.targetValue > 0) {
    progressPercent = Math.min(100, Math.max(0, Math.round(((params.currentValue || 0) / params.targetValue) * 100)));
  }

  const kr = await prisma.keyResult.create({
    data: {
      goalId: params.goalId,
      title,
      targetValue: params.targetValue || null,
      currentValue: params.currentValue || 0,
      unit: params.unit || null,
      progressPercent,
    },
  });

  await recomputeGoalProgress(params.goalId);

  return kr;
}

export async function updateKeyResult(
  actor: AppActor,
  params: {
    workspaceId: string;
    krId: string;
    title?: string;
    targetValue?: number | null;
    currentValue?: number | null;
    unit?: string | null;
    _membership?: MembershipSummary | null;
  }
) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
    resolvedMembership: params._membership,
  });

  const kr = await prisma.keyResult.findUnique({
    where: { id: params.krId },
    include: { goal: true },
  });
  invariant(kr && kr.goal.workspaceId === params.workspaceId, 404, "NOT_FOUND", "Key Result not found.");

  const data: any = {};
  if (params.title !== undefined) {
    const title = params.title.trim();
    invariant(title.length > 0, 400, "INVALID_INPUT", "Key Result title is required.");
    data.title = title;
  }
  if (params.targetValue !== undefined) data.targetValue = params.targetValue;
  if (params.currentValue !== undefined) data.currentValue = params.currentValue;
  if (params.unit !== undefined) data.unit = params.unit;

  const newTarget = params.targetValue !== undefined ? params.targetValue : kr.targetValue;
  const newCurrent = params.currentValue !== undefined ? params.currentValue : kr.currentValue;

  let progressPercent = 0;
  if (newTarget && newTarget > 0) {
    progressPercent = Math.min(100, Math.max(0, Math.round(((newCurrent || 0) / newTarget) * 100)));
  }
  data.progressPercent = progressPercent;

  const updated = await prisma.keyResult.update({
    where: { id: params.krId },
    data,
  });

  await recomputeGoalProgress(updated.goalId);

  return updated;
}

export async function deleteKeyResult(
  actor: AppActor,
  params: {
    workspaceId: string;
    krId: string;
    _membership?: MembershipSummary | null;
  }
) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
    resolvedMembership: params._membership,
  });

  const kr = await prisma.keyResult.findUnique({
    where: { id: params.krId },
    include: { goal: true },
  });
  invariant(kr && kr.goal.workspaceId === params.workspaceId, 404, "NOT_FOUND", "Key Result not found.");

  await prisma.keyResult.delete({ where: { id: params.krId } });
  await recomputeGoalProgress(kr.goalId);
}

export async function postGoalUpdate(
  actor: AppActor,
  params: {
    workspaceId: string;
    goalId: string;
    bodyMd: string;
    authorMemberId?: string | null;
    statusChange?: GoalStatus | null;
    newProgress?: number | null;
    _membership?: MembershipSummary | null;
  }
) {
  const membership = await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
    resolvedMembership: params._membership,
  });

  const goal = await prisma.goal.findUnique({
    where: { id: params.goalId },
  });
  invariant(goal && goal.workspaceId === params.workspaceId, 404, "NOT_FOUND", "Goal not found.");

  return prisma.$transaction(async (tx) => {
    const update = await tx.goalUpdate.create({
      data: {
        goalId: params.goalId,
        bodyMd: params.bodyMd,
        authorMemberId: params.authorMemberId || membership!.id,
        statusChange: params.statusChange,
        newProgress: params.newProgress,
      },
    });

    const updateData: any = {};
    if (params.statusChange) updateData.status = params.statusChange;
    if (params.newProgress !== undefined && params.newProgress !== null) updateData.progressPercent = params.newProgress;
    
    if (Object.keys(updateData).length > 0) {
      await tx.goal.update({
        where: { id: params.goalId },
        data: updateData,
      });

      if (updateData.progressPercent !== undefined && goal.parentGoalId) {
        // Since we update progress, trigger recompute for parent independently after transaction
        process.nextTick(() => recomputeGoalProgress(goal.parentGoalId!));
      }
    }

    return update;
  });
}

export async function createGoalLink(
  actor: AppActor,
  params: {
    workspaceId: string;
    goalId: string;
    entityType: string;
    entityId: string;
    _membership?: MembershipSummary | null;
  }
) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
    resolvedMembership: params._membership,
  });

  const goal = await prisma.goal.findUnique({
    where: { id: params.goalId },
  });
  invariant(goal && goal.workspaceId === params.workspaceId, 404, "NOT_FOUND", "Goal not found.");

  return prisma.$transaction(async (tx) => {
    const link = await tx.goalLink.upsert({
      where: {
        goalId_entityType_entityId: {
          goalId: params.goalId,
          entityType: params.entityType,
          entityId: params.entityId,
        },
      },
      create: {
        goalId: params.goalId,
        entityType: params.entityType,
        entityId: params.entityId,
      },
      update: {}, // no update needed if it exists
    });

    await appendEvents(tx, [
      {
        workspaceId: params.workspaceId,
        type: "goal-link.created",
        aggregateType: "GoalLink",
        aggregateId: link.id,
        payload: {
          goalId: link.goalId,
          entityType: link.entityType,
          entityId: link.entityId,
        },
      },
    ]);

    return link;
  });
}

export async function deleteGoalLink(
  actor: AppActor,
  params: {
    workspaceId: string;
    linkId: string;
    _membership?: MembershipSummary | null;
  }
) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
    resolvedMembership: params._membership,
  });

  const link = await prisma.goalLink.findUnique({
    where: { id: params.linkId },
    include: { goal: true },
  });
  invariant(link && link.goal.workspaceId === params.workspaceId, 404, "NOT_FOUND", "Link not found.");

  await prisma.goalLink.delete({ where: { id: params.linkId } });
}

export async function findGoalLinksForEntity(entityType: string, entityId: string) {
  return prisma.goalLink.findMany({
    where: {
      entityType,
      entityId,
    },
    include: {
      goal: true,
    },
  });
}

export async function recomputeGoalProgress(goalId: string) {
  const goal = await prisma.goal.findUnique({
    where: { id: goalId },
    include: {
      keyResults: true,
      childGoals: true,
    },
  });

  if (!goal) return;

  let computedProgress = 0;

  if (goal.keyResults.length > 0) {
    const total = goal.keyResults.reduce((acc, kr) => acc + kr.progressPercent, 0);
    computedProgress = Math.round(total / goal.keyResults.length);
  } else if (goal.childGoals.length > 0) {
    const total = goal.childGoals.reduce((acc, g) => acc + g.progressPercent, 0);
    computedProgress = Math.round(total / goal.childGoals.length);
  } else {
    // leave as is if no drivers
    computedProgress = goal.progressPercent;
  }

  if (computedProgress !== goal.progressPercent) {
    await prisma.goal.update({
      where: { id: goalId },
      data: { progressPercent: computedProgress },
    });

    if (goal.parentGoalId) {
      await recomputeGoalProgress(goal.parentGoalId);
    }
  }
}

export async function getGoalTree(actor: AppActor, workspaceId: string, opts?: { cadence?: GoalCadence }) {
  await requireWorkspaceMembership({ actor, workspaceId });
  
  const query: any = { workspaceId };
  if (opts?.cadence) query.cadence = opts.cadence;
  
  const allGoals = await prisma.goal.findMany({
    where: query,
    include: {
      ownerMember: { include: { user: { select: { displayName: true, email: true } } } },
      keyResults: true,
      circle: true,
    },
    orderBy: { sortOrder: "asc" }
  });

  const goalsById = new Map<string, any>();
  for (const g of allGoals) {
    goalsById.set(g.id, { ...g, childGoals: [] });
  }

  const rootGoals: any[] = [];
  for (const g of allGoals) {
    const mapped = goalsById.get(g.id);
    if (g.parentGoalId && goalsById.has(g.parentGoalId)) {
      goalsById.get(g.parentGoalId).childGoals.push(mapped);
    } else {
      rootGoals.push(mapped);
    }
  }

  return rootGoals;
}

export async function getMyGoalSlice(actor: AppActor, memberId: string, workspaceId: string) {
  await requireWorkspaceMembership({ actor, workspaceId });

  const myGoals = await prisma.goal.findMany({
    where: { workspaceId, ownerMemberId: memberId },
    include: {
      circle: true,
      parentGoal: {
        include: {
          circle: true,
          parentGoal: {
            include: { circle: true }
          }
        }
      }
    }
  });

  return myGoals;
}

export async function createRecognition(
  actor: AppActor,
  params: {
    workspaceId: string;
    goalId?: string | null;
    recipientMemberId: string;
    title: string;
    storyMd: string;
    valueTags?: string[];
    visibility?: string;
    _membership?: MembershipSummary | null;
  }
) {
  const membership = await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
    resolvedMembership: params._membership,
  });

  return prisma.recognition.create({
    data: {
      workspaceId: params.workspaceId,
      goalId: params.goalId || null,
      recipientMemberId: params.recipientMemberId,
      authorMemberId: membership!.id,
      title: params.title,
      storyMd: params.storyMd,
      valueTags: params.valueTags || [],
      visibility: params.visibility || "WORKSPACE",
    },
  });
}

export async function listRecognitions(
  actor: AppActor,
  params: {
    workspaceId: string;
    recipientMemberId?: string;
    _membership?: MembershipSummary | null;
  }
) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
    resolvedMembership: params._membership,
  });

  const query: any = { workspaceId: params.workspaceId };
  if (params.recipientMemberId) query.recipientMemberId = params.recipientMemberId;

  return prisma.recognition.findMany({
    where: query,
    include: {
      author: { include: { user: { select: { displayName: true } } } },
      recipient: { include: { user: { select: { displayName: true } } } },
    },
    orderBy: { createdAt: "desc" },
  });
}
