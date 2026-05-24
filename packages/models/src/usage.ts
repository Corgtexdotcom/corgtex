import { prisma } from "@corgtex/shared";
import type { ModelUsageInput } from "./contracts";

export class CatalogBudgetError extends Error {
  status: number;
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CatalogBudgetError";
    this.status = 429;
    this.code = code;
  }
}

export class WorkspaceModelBudgetError extends Error {
  status: number;
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "WorkspaceModelBudgetError";
    this.status = 429;
    this.code = code;
  }
}

type BudgetSubject = {
  catalogItemId: string | null;
  monthlyBudgetCents: number | null;
  dailyCallLimit: number | null;
};

function startOfUtcDay(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function startOfUtcMonth(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function decimalToNumber(value: unknown) {
  if (value == null) return 0;
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number(value) || 0;
  if (typeof value === "object" && "toString" in value) {
    return Number(value.toString()) || 0;
  }
  return 0;
}

function costUsdToCents(value: unknown) {
  const usd = decimalToNumber(value);
  if (usd <= 0) return 0;
  return Math.ceil(usd * 100);
}

async function resolveBudgetSubject(input: {
  workspaceId: string;
  catalogItemId?: string | null;
  agentCredentialId?: string | null;
}): Promise<BudgetSubject | null> {
  if (input.agentCredentialId) {
    const credential = await prisma.agentCredential.findFirst({
      where: {
        id: input.agentCredentialId,
        workspaceId: input.workspaceId,
      },
      select: {
        catalogItemId: true,
        isActive: true,
        monthlyBudgetCents: true,
        dailyCallLimit: true,
        catalogItem: {
          select: {
            monthlyBudgetCents: true,
            dailyCallLimit: true,
            archivedAt: true,
          },
        },
      },
    });

    if (!credential?.isActive) {
      throw new CatalogBudgetError("CATALOG_CREDENTIAL_REVOKED", "This catalog API key is inactive.");
    }

    if (credential.catalogItem?.archivedAt) {
      throw new CatalogBudgetError("CATALOG_ITEM_ARCHIVED", "This catalog item is archived.");
    }

    return {
      catalogItemId: credential.catalogItemId,
      monthlyBudgetCents: credential.monthlyBudgetCents ?? credential.catalogItem?.monthlyBudgetCents ?? null,
      dailyCallLimit: credential.dailyCallLimit ?? credential.catalogItem?.dailyCallLimit ?? null,
    };
  }

  if (!input.catalogItemId) {
    return null;
  }

  const catalogItem = await prisma.catalogItem.findFirst({
    where: {
      id: input.catalogItemId,
      workspaceId: input.workspaceId,
      archivedAt: null,
    },
    select: {
      id: true,
      monthlyBudgetCents: true,
      dailyCallLimit: true,
    },
  });

  if (!catalogItem) {
    return null;
  }

  return {
    catalogItemId: catalogItem.id,
    monthlyBudgetCents: catalogItem.monthlyBudgetCents,
    dailyCallLimit: catalogItem.dailyCallLimit,
  };
}

export async function assertCatalogModelBudget(input: {
  workspaceId: string;
  catalogItemId?: string | null;
  agentCredentialId?: string | null;
}) {
  if (!input.catalogItemId && !input.agentCredentialId) {
    return;
  }

  const subject = await resolveBudgetSubject(input);
  if (!subject || (subject.monthlyBudgetCents == null && subject.dailyCallLimit == null)) {
    return;
  }

  const usageScope = input.agentCredentialId
    ? { workspaceId: input.workspaceId, agentCredentialId: input.agentCredentialId }
    : { workspaceId: input.workspaceId, catalogItemId: subject.catalogItemId };

  if (subject.dailyCallLimit != null) {
    const callsToday = await prisma.modelUsage.count({
      where: {
        ...usageScope,
        createdAt: { gte: startOfUtcDay() },
      },
    });

    if (callsToday >= subject.dailyCallLimit) {
      throw new CatalogBudgetError("CATALOG_DAILY_LIMIT_EXCEEDED", "This catalog item has reached today's call limit.");
    }
  }

  if (subject.monthlyBudgetCents != null) {
    const usage = await prisma.modelUsage.findMany({
      where: {
        ...usageScope,
        createdAt: { gte: startOfUtcMonth() },
      },
      select: {
        estimatedCostUsd: true,
        billableCostUsd: true,
      },
    });
    const spentCents = usage.reduce((sum, row) => sum + costUsdToCents(row.billableCostUsd ?? row.estimatedCostUsd), 0);

    if (spentCents >= subject.monthlyBudgetCents) {
      throw new CatalogBudgetError("CATALOG_MONTHLY_BUDGET_EXCEEDED", "This catalog item has reached its monthly AI budget.");
    }
  }
}

export async function assertWorkspaceModelBudget(workspaceId: string) {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: {
      plan: true,
      trialEndsAt: true,
      modelUsageBudget: true,
      procurementTrials: {
        where: { status: "ACTIVE" },
        orderBy: { createdAt: "desc" },
        take: 1,
        select: {
          id: true,
          agentCredentialId: true,
          trialExpiresAt: true,
        },
      },
    },
  });

  if (!workspace) {
    throw new WorkspaceModelBudgetError("WORKSPACE_NOT_FOUND", "Workspace not found.");
  }

  if (workspace.plan === "CORE_FREE") {
    throw new WorkspaceModelBudgetError("AI_BUDGET_PAUSED", "AI usage is paused for this workspace.");
  }

  if (workspace.plan === "TRIAL" && workspace.trialEndsAt && workspace.trialEndsAt.getTime() <= Date.now()) {
    const activeTrial = workspace.procurementTrials[0];
    await prisma.$transaction(async (tx) => {
      await tx.workspace.update({
        where: { id: workspaceId },
        data: {
          plan: "CORE_FREE",
          planActivatedAt: new Date(),
        },
      });
      await tx.modelUsageBudget.upsert({
        where: { workspaceId },
        create: { workspaceId, monthlyCostCapUsd: 0 },
        update: { monthlyCostCapUsd: 0 },
      });
      if (activeTrial) {
        await tx.procurementTrial.update({
          where: { id: activeTrial.id },
          data: { status: "EXPIRED" },
        });
        if (activeTrial.agentCredentialId) {
          await tx.agentCredential.update({
            where: { id: activeTrial.agentCredentialId },
            data: { isActive: false },
          });
        }
      }
    });
    throw new WorkspaceModelBudgetError("TRIAL_EXPIRED", "Trial AI usage has expired.");
  }

  const budget = workspace.modelUsageBudget;
  if (!budget) {
    return;
  }

  const capUsd = decimalToNumber(budget.monthlyCostCapUsd);
  if (capUsd < 0) {
    return;
  }
  if (capUsd === 0) {
    throw new WorkspaceModelBudgetError("AI_BUDGET_PAUSED", "AI usage is paused for this workspace.");
  }

  const usage = await prisma.modelUsage.findMany({
    where: {
      workspaceId,
      createdAt: { gte: startOfUtcMonth() },
    },
    select: {
      estimatedCostUsd: true,
      billableCostUsd: true,
    },
  });
  const usedUsd = usage.reduce((sum, row) => sum + decimalToNumber(row.billableCostUsd ?? row.estimatedCostUsd), 0);
  if (usedUsd >= capUsd) {
    throw new WorkspaceModelBudgetError("AI_BUDGET_EXCEEDED", "This workspace has reached its AI budget.");
  }
}

export async function recordModelUsage(input: ModelUsageInput) {
  const modelUsage = await prisma.modelUsage.create({
    data: {
      workspaceId: input.workspaceId,
      workflowJobId: input.workflowJobId,
      agentRunId: input.agentRunId,
      catalogItemId: input.catalogItemId,
      agentCredentialId: input.agentCredentialId,
      provider: input.provider,
      model: input.model,
      taskType: input.taskType,
      inputTokens: input.inputTokens ?? 0,
      outputTokens: input.outputTokens ?? 0,
      latencyMs: input.latencyMs ?? 0,
      estimatedCostUsd: input.estimatedCostUsd ?? null,
      rawProviderCostUsd: input.rawProviderCostUsd ?? null,
      billableCostUsd: input.billableCostUsd ?? input.estimatedCostUsd ?? null,
    },
  });

  if (input.rawProviderCostUsd && input.billableCostUsd) {
    await prisma.aiUsageLedgerEntry.create({
      data: {
        workspaceId: input.workspaceId,
        modelUsageId: modelUsage.id,
        provider: input.provider,
        model: input.model,
        taskType: input.taskType,
        rawProviderCostUsd: input.rawProviderCostUsd,
        billableCostUsd: input.billableCostUsd,
      },
    });
  }
}
