import { prepareProducerLineage, finishProducerLineage, type ProducerLineageParams } from "./producer-lineage";
import { prisma } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import type { Circle, Prisma } from "@prisma/client";
import { appendEvents } from "./events";
import { requireWorkspaceMembership } from "./auth";
import { recordAudit } from "./audit-trail";
import { archiveFilterWhere, archiveWorkspaceArtifact, type ArchiveFilter } from "./archive";
import { invariant } from "./errors";
import { closeRoleLifecycleForCircleTree } from "./role-onboarding";
import { readableArtifactIds } from "./source-lineage";
import { filterReadableRoleAssignments } from "./roles";

async function validateParentCircle(tx: Prisma.TransactionClient, params: {
  workspaceId: string;
  circleId?: string;
  parentCircleId?: string | null;
}) {
  const parentCircleId = params.parentCircleId?.trim() || null;
  if (!parentCircleId) return null;

  invariant(parentCircleId !== params.circleId, 400, "INVALID_INPUT", "A circle cannot be its own parent.");

  const parent = await tx.circle.findUnique({
    where: { id: parentCircleId },
    select: {
      id: true,
      workspaceId: true,
      parentCircleId: true,
      archivedAt: true,
    },
  });

  invariant(parent && parent.workspaceId === params.workspaceId && !parent.archivedAt, 404, "NOT_FOUND", "Parent circle not found.");

  if (!params.circleId) return parentCircleId;

  const visited = new Set<string>([parent.id]);
  let nextParentId = parent.parentCircleId;

  while (nextParentId) {
    invariant(nextParentId !== params.circleId, 400, "INVALID_INPUT", "A circle cannot be moved under one of its descendants.");
    if (visited.has(nextParentId)) break;
    visited.add(nextParentId);

    const ancestor = await tx.circle.findUnique({
      where: { id: nextParentId },
      select: {
        id: true,
        workspaceId: true,
        parentCircleId: true,
        archivedAt: true,
      },
    });

    if (!ancestor || ancestor.workspaceId !== params.workspaceId || ancestor.archivedAt) break;
    nextParentId = ancestor.parentCircleId;
  }

  return parentCircleId;
}

async function circleMutationResult(tx: Prisma.TransactionClient, actor: AppActor, workspaceId: string,
  circle: Circle) {
  const visible = await readableArtifactIds(actor, workspaceId, "Circle", [circle], tx);
  if (!visible.has(circle.id)) return { id: circle.id, contentWithheld: true as const };
  if (!circle.parentCircleId) return circle;
  const parent = await tx.circle.findUnique({ where: { id: circle.parentCircleId } });
  const visibleParents = await readableArtifactIds(actor, workspaceId, "Circle", parent ? [parent] : [], tx);
  return { ...circle, parentCircleId: visibleParents.has(circle.parentCircleId) ? circle.parentCircleId : null };
}

export async function listCircles(actor: AppActor, workspaceId: string, opts?: { archiveFilter?: ArchiveFilter }) {
  await requireWorkspaceMembership({ actor, workspaceId });
  const circles = await prisma.circle.findMany({
    where: { workspaceId, ...archiveFilterWhere(opts?.archiveFilter) },
    include: {
      parentCircle: true,
      roles: {
        where: { archivedAt: null },
      },
    },
  });
  const visibleCircles = await readableArtifactIds(actor, workspaceId, "Circle", circles);
  const admitted = circles.filter((circle) => visibleCircles.has(circle.id));
  const visibleParents = await readableArtifactIds(actor, workspaceId, "Circle", admitted.flatMap((circle) => circle.parentCircle ? [circle.parentCircle] : []));
  const visibleRoles = await readableArtifactIds(actor, workspaceId, "Role", admitted.flatMap((circle) => circle.roles));
  return admitted.sort(compareCircleOrder).map(({ parentCircle: _parentCircle, ...circle }) => ({ ...circle,
    parentCircleId: circle.parentCircleId && visibleParents.has(circle.parentCircleId) ? circle.parentCircleId : null,
    roles: circle.roles.filter((role) => visibleRoles.has(role.id)).sort(compareCircleOrder),
  }));
}

function compareCircleOrder(left: { sortOrder: number; createdAt: Date }, right: { sortOrder: number; createdAt: Date }) {
  return left.sortOrder - right.sortOrder || left.createdAt.getTime() - right.createdAt.getTime();
}

export async function createCircle(actor: AppActor, params: ProducerLineageParams & {
  workspaceId: string;
  name: string;
  purposeMd?: string | null;
  domainMd?: string | null;
  parentCircleId?: string | null;
  maturityStage?: string;
  _membership?: import("@corgtex/shared").MembershipSummary | null;
}) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
    allowedRoles: ["FACILITATOR", "ADMIN"],
    resolvedMembership: params._membership,
  });

  const name = params.name.trim();
  invariant(name.length > 0, 400, "INVALID_INPUT", "Circle name is required.");

  return prisma.$transaction(async (tx) => {
    const parentCircleId = await validateParentCircle(tx, {
      workspaceId: params.workspaceId,
      parentCircleId: params.parentCircleId,
    });

    const receipt = await prepareProducerLineage({ tx, actor, workspaceId: params.workspaceId, capture: params });
    const circle = await tx.circle.create({
      data: {
        workspaceId: params.workspaceId,
        name,
        purposeMd: params.purposeMd?.trim() || null,
        domainMd: params.domainMd?.trim() || null,
        parentCircleId,
        maturityStage: params.maturityStage || "GETTING_STARTED",
      },
    });
    await finishProducerLineage({ tx, actor, workspaceId: params.workspaceId,
      artifact: { kind: "Circle", id: circle.id }, content: circle, receipt });


    await recordAudit(tx, actor, {
      workspaceId: params.workspaceId,
      action: "circle.created",
      entityType: "Circle",
      entityId: circle.id,
      meta: { name: circle.name },
    });

    await appendEvents(tx, [
      {
        workspaceId: params.workspaceId,
        type: "circle.created",
        aggregateType: "Circle",
        aggregateId: circle.id,
        payload: {
          circleId: circle.id,
          name: circle.name,
        },
      },
    ]);

    return circleMutationResult(tx, actor, params.workspaceId, circle);
  });
}

export async function updateCircle(actor: AppActor, params: ProducerLineageParams & {
  workspaceId: string;
  circleId: string;
  name?: string;
  purposeMd?: string | null;
  domainMd?: string | null;
  parentCircleId?: string | null;
  maturityStage?: string;
  _membership?: import("@corgtex/shared").MembershipSummary | null;
}) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
    allowedRoles: ["FACILITATOR", "ADMIN"],
    resolvedMembership: params._membership,
  });

  return prisma.$transaction(async (tx) => {
    const circle = await tx.circle.findUnique({
      where: { id: params.circleId },
    });

    invariant(circle && circle.workspaceId === params.workspaceId && !circle.archivedAt, 404, "NOT_FOUND", "Circle not found.");

    const data: Record<string, unknown> = {};
    if (params.name !== undefined) {
      const name = params.name.trim();
      invariant(name.length > 0, 400, "INVALID_INPUT", "Circle name is required.");
      data.name = name;
    }
    if (params.purposeMd !== undefined) data.purposeMd = params.purposeMd?.trim() || null;
    if (params.domainMd !== undefined) data.domainMd = params.domainMd?.trim() || null;
    if (params.parentCircleId !== undefined) {
      data.parentCircleId = await validateParentCircle(tx, {
        workspaceId: params.workspaceId,
        circleId: circle.id,
        parentCircleId: params.parentCircleId,
      });
    }
    if (params.maturityStage !== undefined) data.maturityStage = params.maturityStage;

    const receipt = await prepareProducerLineage({ tx, actor, workspaceId: params.workspaceId,
      artifact: { kind: "Circle", id: circle.id }, before: circle, capture: params });
    const updated = await tx.circle.update({
      where: { id: params.circleId },
      data,
    });
    await finishProducerLineage({ tx, actor, workspaceId: params.workspaceId,
      artifact: { kind: "Circle", id: updated.id }, content: updated, receipt });


    await recordAudit(tx, actor, {
      workspaceId: params.workspaceId,
      action: "circle.updated",
      entityType: "Circle",
      entityId: updated.id,
      meta: { fields: Object.keys(data) },
    });

    return circleMutationResult(tx, actor, params.workspaceId, updated);
  });
}

export async function deleteCircle(actor: AppActor, params: {
  workspaceId: string;
  circleId: string;
  _membership?: import("@corgtex/shared").MembershipSummary | null;
}) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
    allowedRoles: ["FACILITATOR", "ADMIN"],
    resolvedMembership: params._membership,
  });

  await archiveWorkspaceArtifact(actor, {
    workspaceId: params.workspaceId,
    entityType: "Circle",
    entityId: params.circleId,
    reason: "Archived from circle delete path.",
  });

  await prisma.$transaction(async (tx) => {
    await closeRoleLifecycleForCircleTree(tx, {
      workspaceId: params.workspaceId,
      circleId: params.circleId,
      actor,
    });
  });

  return { id: params.circleId };
}

export async function suggestMaturityUpgrade(actor: AppActor, workspaceId: string, circleId: string) {
  await requireWorkspaceMembership({ actor, workspaceId });
  const circle = await prisma.circle.findUnique({
    where: { id: circleId },
    include: {
      tensions: {
        where: {
          status: "RESOLVED",
          archivedAt: null,
          updatedAt: {
            gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), // last 30 days
          },
        },
      },
    },
  });

  invariant(circle && circle.workspaceId === workspaceId, 404, "NOT_FOUND", "Circle not found.");
  const visible = await readableArtifactIds(actor, workspaceId, "Circle", [circle]);
  invariant(visible.has(circle.id), 404, "NOT_FOUND", "Circle not found.");

  if (circle.maturityStage === "FULL_O2") {
    return { ready: false, reason: "Already at highest maturity stage." };
  }

  const visibleTensions = await readableArtifactIds(actor, workspaceId, "Tension", circle.tensions);
  const recentResolvedTensions = circle.tensions.filter((tension) => visibleTensions.has(tension.id)).length;

  if (circle.maturityStage === "GETTING_STARTED") {
    if (recentResolvedTensions >= 5) {
      return { ready: true, reason: `Circle has resolved ${recentResolvedTensions} tensions recently. Ready to practice proposals.` };
    }
  }

  if (circle.maturityStage === "BUILDING_MUSCLE") {
    if (recentResolvedTensions >= 20) {
      return { ready: true, reason: `Circle has resolved ${recentResolvedTensions} tensions recently. Ready for full O2 (artifacts, links).` };
    }
  }

  return { ready: false, reason: "Not enough recent activity to suggest upgrade." };
}

export type CircleTreeItem = {
  id: string;
  workspaceId: string;
  parentCircleId: string | null;
  name: string;
  purposeMd: string | null;
  domainMd: string | null;
  maturityStage: string;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
  parentCircle: { id: string; name: string } | null;
  roles: any[]; // we'll use generic any for role structure for now to keep it simple across packages
  childCircles: CircleTreeItem[];
};

export async function listCircleTree(actor: AppActor, workspaceId: string, opts?: { archiveFilter?: ArchiveFilter }) {
  await requireWorkspaceMembership({ actor, workspaceId });
  const circles = await prisma.circle.findMany({
    where: { workspaceId, ...archiveFilterWhere(opts?.archiveFilter) },
    include: {
      parentCircle: true,
      roles: {
        where: { archivedAt: null },
        include: {
          assignments: {
            include: {
              member: {
                include: {
                  user: {
                    select: {
                      id: true,
                      email: true,
                      displayName: true,
                      avatarUrl: true,
                      bio: true,
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  });
  const visibleCircles = await readableArtifactIds(actor, workspaceId, "Circle", circles);
  const admitted = circles.filter((circle) => visibleCircles.has(circle.id));
  const visibleParents = await readableArtifactIds(actor, workspaceId, "Circle", admitted.flatMap((circle) => circle.parentCircle ? [circle.parentCircle] : []));
  const visibleRoles = await readableArtifactIds(actor, workspaceId, "Role", admitted.flatMap((circle) => circle.roles));
  const assignments = await filterReadableRoleAssignments(actor, workspaceId,
    admitted.flatMap((circle) => circle.roles.filter((role) => visibleRoles.has(role.id)).flatMap((role) => role.assignments)));
  const visibleAssignments = new Set(assignments.map((assignment) => assignment.id));
  const safeCircles = admitted.sort(compareCircleOrder).map((circle) => ({ ...circle,
    parentCircleId: circle.parentCircleId && visibleParents.has(circle.parentCircleId) ? circle.parentCircleId : null,
    parentCircle: circle.parentCircle && visibleParents.has(circle.parentCircle.id)
      ? { id: circle.parentCircle.id, name: circle.parentCircle.name } : null,
    roles: circle.roles.filter((role) => visibleRoles.has(role.id)).sort(compareCircleOrder).map((role) => ({ ...role,
      assignments: role.assignments.filter((assignment) => visibleAssignments.has(assignment.id))
        .sort((left, right) => right.assignedAt.getTime() - left.assignedAt.getTime()),
    })),
  }));
  return buildCircleTree(safeCircles);
}

function buildCircleTree(flatList: any[]): CircleTreeItem[] {
  const map = new Map<string, CircleTreeItem>();
  const roots: CircleTreeItem[] = [];

  for (const item of flatList) {
    map.set(item.id, { ...item, childCircles: [] });
  }

  for (const item of flatList) {
    const mapped = map.get(item.id)!;
    if (item.parentCircleId && map.has(item.parentCircleId)) {
      map.get(item.parentCircleId)!.childCircles.push(mapped);
    } else {
      roots.push(mapped);
    }
  }

  return roots;
}
