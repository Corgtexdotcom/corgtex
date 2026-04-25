import { prisma } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import { appendEvents } from "./events";
import { requireWorkspaceMembership } from "./auth";
import { recordAudit } from "./audit-trail";
import { archiveFilterWhere, archiveWorkspaceArtifact, type ArchiveFilter } from "./archive";
import { invariant } from "./errors";

export async function listCircles(workspaceId: string, opts?: { archiveFilter?: ArchiveFilter }) {
  return prisma.circle.findMany({
    where: { workspaceId, ...archiveFilterWhere(opts?.archiveFilter) },
    include: {
      roles: {
        where: { archivedAt: null },
        orderBy: { sortOrder: "asc" },
      },
    },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });
}

export async function createCircle(actor: AppActor, params: {
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
    const circle = await tx.circle.create({
      data: {
        workspaceId: params.workspaceId,
        name,
        purposeMd: params.purposeMd?.trim() || null,
        domainMd: params.domainMd?.trim() || null,
        parentCircleId: params.parentCircleId || null,
        maturityStage: params.maturityStage || "GETTING_STARTED",
      },
    });

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

    return circle;
  });
}

export async function updateCircle(actor: AppActor, params: {
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
    if (params.parentCircleId !== undefined) data.parentCircleId = params.parentCircleId || null;
    if (params.maturityStage !== undefined) data.maturityStage = params.maturityStage;

    const updated = await tx.circle.update({
      where: { id: params.circleId },
      data,
    });

    await recordAudit(tx, actor, {
      workspaceId: params.workspaceId,
      action: "circle.updated",
      entityType: "Circle",
      entityId: updated.id,
      meta: { fields: Object.keys(data) },
    });

    return updated;
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

  return { id: params.circleId };
}

export async function suggestMaturityUpgrade(workspaceId: string, circleId: string) {
  const circle = await prisma.circle.findUnique({
    where: { id: circleId },
    include: {
      tensions: {
        where: {
          status: {
            in: ["COMPLETED", "CANCELLED"],
          },
          archivedAt: null,
          updatedAt: {
            gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), // last 30 days
          },
        },
      },
    },
  });

  if (!circle || circle.workspaceId !== workspaceId) {
    throw new Error("Circle not found.");
  }

  if (circle.maturityStage === "FULL_O2") {
    return { ready: false, reason: "Already at highest maturity stage." };
  }

  const recentResolvedTensions = circle.tensions.length;

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

export async function listCircleTree(workspaceId: string, opts?: { archiveFilter?: ArchiveFilter }) {
  const circles = await prisma.circle.findMany({
    where: { workspaceId, ...archiveFilterWhere(opts?.archiveFilter) },
    include: {
      parentCircle: { select: { id: true, name: true } },
      roles: {
        where: { archivedAt: null },
        include: {
          assignments: {
            include: {
              member: {
                include: { user: { select: { displayName: true, email: true } } },
              },
            },
          },
        },
        orderBy: { sortOrder: "asc" },
      },
    },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });

  return buildCircleTree(circles);
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
