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

function estimatedUsdToCents(value: unknown) {
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
      },
    });
    const spentCents = usage.reduce((sum, row) => sum + estimatedUsdToCents(row.estimatedCostUsd), 0);

    if (spentCents >= subject.monthlyBudgetCents) {
      throw new CatalogBudgetError("CATALOG_MONTHLY_BUDGET_EXCEEDED", "This catalog item has reached its monthly AI budget.");
    }
  }
}

export async function recordModelUsage(input: ModelUsageInput) {
  await prisma.modelUsage.create({
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
    },
  });
}
