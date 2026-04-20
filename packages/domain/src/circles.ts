import { prisma } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import { appendEvents } from "./events";
import { requireWorkspaceMembership } from "./auth";
import { recordAudit } from "./audit-trail";
import { invariant } from "./errors";

export async function listCircles(workspaceId: string) {
  return prisma.circle.findMany({
    where: { workspaceId },
    include: {
      roles: {
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

    invariant(circle && circle.workspaceId === params.workspaceId, 404, "NOT_FOUND", "Circle not found.");

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

  return prisma.$transaction(async (tx) => {
    const circle = await tx.circle.findUnique({
      where: { id: params.circleId },
    });

    invariant(circle && circle.workspaceId === params.workspaceId, 404, "NOT_FOUND", "Circle not found.");

    await tx.circle.delete({ where: { id: params.circleId } });

    await recordAudit(tx, actor, {
      workspaceId: params.workspaceId,
      action: "circle.deleted",
      entityType: "Circle",
      entityId: params.circleId,
      meta: { name: circle.name },
    });

    return { id: params.circleId };
  });
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

