import { prisma } from "@corgtex/shared";
import { getWorkspaceMonthlyUsage } from "./agent-run-usage";
import { AppError } from "./errors";
import type { AppActor } from "@corgtex/shared";
import { requireWorkspaceMembership } from "./auth";

export async function getModelUsageBudget(actor: AppActor, workspaceId: string) {
  await requireWorkspaceMembership({ actor, workspaceId, allowedRoles: ["ADMIN"] });
  return prisma.modelUsageBudget.findUnique({
    where: { workspaceId }
  });
}

export async function updateModelUsageBudget(actor: AppActor, params: {
  workspaceId: string;
  monthlyCostCapUsd: number;
  alertThresholdPct?: number;
  periodStartDay?: number;
}) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId, allowedRoles: ["ADMIN"] });

  if (!Number.isFinite(params.monthlyCostCapUsd)) {
    throw new AppError(400, "INVALID_INPUT", "Budget must be a number.");
  }
  if (
    params.alertThresholdPct !== undefined &&
    (!Number.isInteger(params.alertThresholdPct) || params.alertThresholdPct < 1 || params.alertThresholdPct > 100)
  ) {
    throw new AppError(400, "INVALID_INPUT", "Alert threshold must be between 1 and 100.");
  }
  if (
    params.periodStartDay !== undefined &&
    (!Number.isInteger(params.periodStartDay) || params.periodStartDay < 1 || params.periodStartDay > 31)
  ) {
    throw new AppError(400, "INVALID_INPUT", "Billing cycle start day must be between 1 and 31.");
  }

  return prisma.modelUsageBudget.upsert({
    where: { workspaceId: params.workspaceId },
    create: {
      workspaceId: params.workspaceId,
      monthlyCostCapUsd: params.monthlyCostCapUsd,
      alertThresholdPct: params.alertThresholdPct ?? 80,
      periodStartDay: params.periodStartDay ?? 1,
    },
    update: {
      monthlyCostCapUsd: params.monthlyCostCapUsd,
      ...(params.alertThresholdPct !== undefined && { alertThresholdPct: params.alertThresholdPct }),
      ...(params.periodStartDay !== undefined && { periodStartDay: params.periodStartDay }),
    }
  });
}

export async function checkBudget(workspaceId: string): Promise<{
  allowed: boolean;
  usedPct: number;
  usedUsd: number;
  capUsd: number;
}> {
  const budget = await prisma.modelUsageBudget.findUnique({
    where: { workspaceId }
  });

  // If no budget is set, allow unlimited
  if (!budget) {
    return { allowed: true, usedPct: 0, usedUsd: 0, capUsd: -1 };
  }

  const capUsd = Number(budget.monthlyCostCapUsd);
  if (capUsd < 0) {
    return { allowed: true, usedPct: 0, usedUsd: 0, capUsd };
  }

  if (capUsd === 0) {
    return { allowed: false, usedPct: 100, usedUsd: 0, capUsd };
  }

  const usedUsd = await getWorkspaceMonthlyUsage(workspaceId, budget.periodStartDay);
  const usedPct = (usedUsd / capUsd) * 100;

  const allowed = usedUsd < capUsd;

  // Check alert threshold
  if (usedPct >= budget.alertThresholdPct) {
    const startOfCurrentPeriod = new Date();
    startOfCurrentPeriod.setDate(budget.periodStartDay);
    if (startOfCurrentPeriod.getTime() > Date.now()) {
      startOfCurrentPeriod.setMonth(startOfCurrentPeriod.getMonth() - 1);
    }

    // Only alert once per period
    if (!budget.alertSentAt || budget.alertSentAt < startOfCurrentPeriod) {
      // Create a notification for admins
      const admins = await prisma.member.findMany({
        where: { workspaceId, role: "ADMIN", isActive: true },
        select: { userId: true }
      });

      if (admins.length > 0) {
        await prisma.notification.createMany({
          data: admins.map(admin => ({
            userId: admin.userId,
            workspaceId,
            type: "system",
            title: "Budget Alert",
            message: `Workspace agent usage has reached ${usedPct.toFixed(1)}% of your monthly budget. ($${usedUsd.toFixed(2)} of $${capUsd})`,
            redirectUrl: `/workspaces/${workspaceId}/settings?tab=agents`
          }))
        });

        await prisma.modelUsageBudget.update({
          where: { id: budget.id },
          data: { alertSentAt: new Date() }
        });
      }
    }
  }

  return { allowed, usedPct, usedUsd, capUsd };
}
