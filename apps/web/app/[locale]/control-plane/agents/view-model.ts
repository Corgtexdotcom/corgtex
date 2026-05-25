type RecentModelUsageRow = {
  inputTokens?: unknown;
  outputTokens?: unknown;
  estimatedCostUsd?: unknown;
  billableCostUsd?: unknown;
  agentRun?: {
    id?: string | null;
  } | null;
};

export type AggregatedRunUsage = {
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number | null;
  billableCostUsd: number | null;
};

function finiteNumber(value: unknown, fallback = 0) {
  const numeric = Number(value ?? fallback);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function addOptionalNumber(total: number | null, value: unknown) {
  if (value == null) return total;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return total;
  return (total ?? 0) + numeric;
}

export function aggregateModelUsageByRunId(usages: RecentModelUsageRow[] | null | undefined) {
  const usageByRunId = new Map<string, AggregatedRunUsage>();

  for (const usage of usages ?? []) {
    const runId = usage.agentRun?.id;
    if (!runId) continue;

    const current = usageByRunId.get(runId) ?? {
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostUsd: null,
      billableCostUsd: null,
    };

    usageByRunId.set(runId, {
      inputTokens: current.inputTokens + finiteNumber(usage.inputTokens),
      outputTokens: current.outputTokens + finiteNumber(usage.outputTokens),
      estimatedCostUsd: addOptionalNumber(current.estimatedCostUsd, usage.estimatedCostUsd),
      billableCostUsd: addOptionalNumber(current.billableCostUsd, usage.billableCostUsd),
    });
  }

  return usageByRunId;
}

export function sortAgentFleetRows<T extends { id: string; label?: string | null }>(rows: T[]) {
  return [...rows].sort((a, b) => String(a.label ?? a.id).localeCompare(String(b.label ?? b.id)));
}
