import type { ModelTaskType, Prisma } from "@prisma/client";

type ModelUsageLike = {
  provider: string;
  model: string;
  taskType: ModelTaskType;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  estimatedCostUsd: Prisma.Decimal | string | number | null;
  billableCostUsd?: Prisma.Decimal | string | number | null;
};

type AgentRunModelUsageSummary = {
  provider: string;
  model: string;
  taskType: ModelTaskType;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  estimatedCostUsd: string;
};

function asCostNumber(value: Prisma.Decimal | string | number | null) {
  if (value == null) {
    return 0;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }

  const normalized = typeof value === "string" ? value : value.toString();
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function summarizeAgentRunModelUsage(usages: ModelUsageLike[]) {
  const grouped = new Map<string, AgentRunModelUsageSummary>();

  for (const usage of usages) {
    const key = [usage.provider, usage.model, usage.taskType].join("::");
    const current = grouped.get(key);
    const estimatedCostUsd = asCostNumber(usage.billableCostUsd ?? usage.estimatedCostUsd);

    if (current) {
      current.inputTokens += usage.inputTokens;
      current.outputTokens += usage.outputTokens;
      current.latencyMs += usage.latencyMs;
      current.estimatedCostUsd = (Number(current.estimatedCostUsd) + estimatedCostUsd).toFixed(6);
      continue;
    }

    grouped.set(key, {
      provider: usage.provider,
      model: usage.model,
      taskType: usage.taskType,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      latencyMs: usage.latencyMs,
      estimatedCostUsd: estimatedCostUsd.toFixed(6),
    });
  }

  return [...grouped.values()].sort((left, right) => {
    if (left.taskType === right.taskType) {
      return left.model.localeCompare(right.model);
    }

    return left.taskType.localeCompare(right.taskType);
  });
}

export function withAgentRunModelUsageSummary<TRun extends { modelUsage: ModelUsageLike[] }>(run: TRun) {
  const { modelUsage, ...rest } = run;

  return {
    ...rest,
    modelUsageSummary: summarizeAgentRunModelUsage(modelUsage),
  };
}

export function currentUsagePeriodStart(now: Date, periodStartDay: number): Date {
  const startInMonth = (year: number, month: number) => {
    const lastDay = new Date(year, month + 1, 0).getDate();
    return new Date(year, month, Math.min(periodStartDay, lastDay));
  };
  const currentMonthStart = startInMonth(now.getFullYear(), now.getMonth());
  return now >= currentMonthStart
    ? currentMonthStart
    : startInMonth(now.getFullYear(), now.getMonth() - 1);
}

export async function getWorkspaceMonthlyUsage(workspaceId: string, periodStartDay: number = 1): Promise<number> {
  const { prisma } = await import("@corgtex/shared");
  const periodStart = currentUsagePeriodStart(new Date(), periodStartDay);

  const usages = await prisma.modelUsage.findMany({
    where: {
      workspaceId,
      createdAt: {
        gte: periodStart
      }
    },
    select: {
      estimatedCostUsd: true,
      billableCostUsd: true,
    }
  });

  return usages.reduce((total, usage) => total + asCostNumber(usage.billableCostUsd ?? usage.estimatedCostUsd), 0);
}
