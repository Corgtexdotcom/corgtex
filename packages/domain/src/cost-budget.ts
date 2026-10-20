import { createBudgetAlertActor } from "./internal-source-principal";
import { prisma } from "@corgtex/shared";
import { Prisma } from "@prisma/client";
import { currentUsagePeriodStart, getWorkspaceMonthlyUsage } from "./agent-run-usage";
import { AppError } from "./errors";
import type { AppActor } from "@corgtex/shared";
import { requireWorkspaceMembership } from "./auth";
import { createNotificationIntent } from "./notifications";
import { captureArtifactInputProof } from "./source-lineage";

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
  const workspaceDelegate = (prisma as typeof prisma & { workspace?: typeof prisma.workspace }).workspace;
  const workspace = workspaceDelegate
    ? await workspaceDelegate.findUnique({
        where: { id: workspaceId },
        select: {
          plan: true,
          trialEndsAt: true,
        },
      })
    : null;

  if (workspace?.plan === "CORE_FREE") {
    return { allowed: false, usedPct: 100, usedUsd: 0, capUsd: 0 };
  }

  const trialDelegate = (prisma as typeof prisma & { procurementTrial?: typeof prisma.procurementTrial }).procurementTrial;
  const trial = trialDelegate
    ? await trialDelegate.findUnique({
        where: { workspaceId },
        select: {
          id: true,
          workspaceId: true,
          status: true,
          agentCredentialId: true,
          trialExpiresAt: true,
        },
      })
    : null;
  if (trial) {
    if (trial.status !== "ACTIVE" && trial.status !== "CONVERTED") {
      return { allowed: false, usedPct: 100, usedUsd: 0, capUsd: 0 };
    }
    if (trial.status === "ACTIVE" && trial.trialExpiresAt.getTime() <= Date.now()) {
      await prisma.$transaction(async (tx) => {
        await tx.procurementTrial.update({
          where: { id: trial.id },
          data: { status: "EXPIRED" },
        });
        await tx.workspace.update({
          where: { id: workspaceId },
          data: {
            plan: "CORE_FREE",
            planActivatedAt: new Date(),
            trialEndsAt: trial.trialExpiresAt,
          },
        });
        await tx.modelUsageBudget.upsert({
          where: { workspaceId },
          create: { workspaceId, monthlyCostCapUsd: 0 },
          update: { monthlyCostCapUsd: 0 },
        });
        if (trial.agentCredentialId) {
          await tx.agentCredential.update({
            where: { id: trial.agentCredentialId },
            data: { isActive: false },
          });
        }
      });
      return { allowed: false, usedPct: 100, usedUsd: 0, capUsd: 0 };
    }
  }

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
    const startOfCurrentPeriod = currentUsagePeriodStart(new Date(), budget.periodStartDay);

    // Only alert once per period
    if (!budget.alertSentAt || budget.alertSentAt < startOfCurrentPeriod) {
      await prisma.$transaction(async (tx) => {
        // Serialize the period marker with budget edits and concurrent alert checks.
        await tx.$queryRaw`SELECT id FROM "ModelUsageBudget" WHERE "workspaceId" = ${workspaceId} FOR UPDATE`;
        const currentBudget = await tx.modelUsageBudget.findUnique({ where: { workspaceId } });
        if (!currentBudget) return;
        const currentCap = Number(currentBudget.monthlyCostCapUsd);
        if (currentCap <= 0) return;
        const currentPeriod = currentUsagePeriodStart(new Date(), currentBudget.periodStartDay);
        if (currentBudget.alertSentAt && currentBudget.alertSentAt >= currentPeriod) return;

        // The complete amount and its receipt must consume the same safe projection.
        const usages = await tx.modelUsage.findMany({
          where: { workspaceId, createdAt: { gte: currentPeriod } },
          select: { id: true, workspaceId: true, estimatedCostUsd: true, billableCostUsd: true, createdAt: true },
          orderBy: { id: "asc" }, take: 5001,
        });
        if (usages.length > 5000) {
          // Alert delivery is optional; quota admission above uses the exact SQL
          // total. Do not publish a truncated cost receipt or consume the period
          // marker when this notification exceeds its individual proof budget.
          console.warn("Budget threshold alert deferred: complete receipt exceeds the notification input budget.");
          return;
        }
        const lineageActor = createBudgetAlertActor(workspaceId);
        const lineageRoots = await captureArtifactInputProof(lineageActor, workspaceId, [
          { kind: "ModelUsageBudget", id: currentBudget.id, snapshot: currentBudget },
          ...usages.map((usage) => ({ kind: "ModelUsageCost" as const, id: usage.id, snapshot: usage })),
        ], tx);
        const currentUsed = usages.reduce((total, usage) => total.plus(usage.billableCostUsd ?? usage.estimatedCostUsd ?? 0), new Prisma.Decimal(0));
        const currentPct = currentUsed.div(currentBudget.monthlyCostCapUsd).times(100);
        if (currentPct.lessThan(currentBudget.alertThresholdPct)) return;
        const admins = await tx.member.findMany({
          where: { workspaceId, role: "ADMIN", isActive: true }, include: { user: { select: { id: true, email: true, displayName: true } } },
        });
        if (!admins.length) return;
        for (const admin of admins) {
          const audienceRoots = await captureArtifactInputProof(lineageActor, workspaceId, [
            { kind: "Member", id: admin.id, snapshot: admin }, { kind: "User", id: admin.userId, snapshot: admin.user },
          ], tx);
          await createNotificationIntent(tx, {
          workspaceId, lineageActor, lineageRoots: [...lineageRoots, ...audienceRoots],
          type: "budget.threshold_reached",
          recipientUserIds: [admin.userId],
          entityType: "ModelUsageBudget", entityId: currentBudget.id,
          title: "Budget Alert",
          bodyMd: `Workspace agent usage has reached ${currentPct.toFixed(1)}% of your monthly budget. ($${currentUsed.toFixed(2)} of $${currentCap})`,
          priority: "HIGH",
          dedupeKey: `budget.threshold:${currentBudget.id}:${currentPeriod.toISOString()}:${admin.id}`,
        });
        }
        await tx.modelUsageBudget.update({ where: { id: currentBudget.id }, data: { alertSentAt: new Date() } });
      });
    }
  }

  return { allowed, usedPct, usedUsd, capUsd };
}
