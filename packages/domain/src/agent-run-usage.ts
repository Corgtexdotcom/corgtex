import type { ModelTaskType, Prisma } from "@prisma/client";

type ModelUsageLike = {
  provider: string;
  model: string;
  taskType: ModelTaskType;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  estimatedCostUsd: Prisma.Decimal | string | number | null;
};

export type AgentRunModelUsageSummary = {
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

export function summarizeAgentRunModelUsage(usages: ModelUsageLike[]) {
  const grouped = new Map<string, AgentRunModelUsageSummary>();

  for (const usage of usages) {
    const key = [usage.provider, usage.model, usage.taskType].join("::");
    const current = grouped.get(key);
    const estimatedCostUsd = asCostNumber(usage.estimatedCostUsd);

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

export async function getWorkspaceMonthlyUsage(workspaceId: string, periodStartDay: number = 1): Promise<number> {
  const { prisma } = await import("@corgtex/shared");
  const now = new Date();
  
  // Calculate the start of the current period based on periodStartDay
  let periodStart = new Date(now.getFullYear(), now.getMonth(), periodStartDay);
  
  if (now.getDate() < periodStartDay) {
    // If we're before the start day in the current month, the period started last month
    periodStart = new Date(now.getFullYear(), now.getMonth() - 1, periodStartDay);
  }

  const usages = await prisma.modelUsage.findMany({
    where: {
      workspaceId,
      createdAt: {
        gte: periodStart
      }
    },
    select: {
      estimatedCostUsd: true
    }
  });

  return usages.reduce((total, usage) => total + asCostNumber(usage.estimatedCostUsd), 0);
}

