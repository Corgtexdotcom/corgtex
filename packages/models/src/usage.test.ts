import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@corgtex/shared", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    prisma: {
      $transaction: vi.fn(),
      workspace: { findUnique: vi.fn(), update: vi.fn() },
      modelUsageBudget: { upsert: vi.fn() },
      procurementTrial: { update: vi.fn() },
      agentCredential: { findFirst: vi.fn(), update: vi.fn() },
      catalogItem: { findFirst: vi.fn() },
      modelUsage: {
        count: vi.fn(),
        findMany: vi.fn(),
        create: vi.fn(),
      },
      aiUsageLedgerEntry: {
        create: vi.fn(),
      },
    },
  };
});

beforeEach(async () => {
  const { prisma } = await import("@corgtex/shared");
  vi.mocked(prisma.$transaction).mockReset();
  vi.mocked(prisma.$transaction).mockImplementation(async (callback: any) => callback(prisma));
  vi.mocked(prisma.workspace.findUnique).mockReset();
  vi.mocked(prisma.workspace.update).mockReset();
  vi.mocked(prisma.modelUsageBudget.upsert).mockReset();
  vi.mocked(prisma.procurementTrial.update).mockReset();
  vi.mocked(prisma.agentCredential.update).mockReset();
  vi.mocked(prisma.agentCredential.findFirst).mockReset();
  vi.mocked(prisma.catalogItem.findFirst).mockReset();
  vi.mocked(prisma.modelUsage.count).mockReset();
  vi.mocked(prisma.modelUsage.findMany).mockReset();
  vi.mocked(prisma.modelUsage.create).mockReset();
  vi.mocked(prisma.aiUsageLedgerEntry.create).mockReset();
});

describe("catalog model budgets", () => {
  it("does not query limits when usage is not catalog scoped", async () => {
    const { prisma } = await import("@corgtex/shared");
    const { assertCatalogModelBudget } = await import("./usage");

    await assertCatalogModelBudget({ workspaceId: "ws-1" });

    expect(prisma.agentCredential.findFirst).not.toHaveBeenCalled();
    expect(prisma.catalogItem.findFirst).not.toHaveBeenCalled();
  });

  it("blocks workspaces whose AI is paused on CORE_FREE", async () => {
    const { prisma } = await import("@corgtex/shared");
    const { assertWorkspaceModelBudget } = await import("./usage");

    vi.mocked(prisma.workspace.findUnique).mockResolvedValue({
      plan: "CORE_FREE",
      trialEndsAt: null,
      modelUsageBudget: null,
      procurementTrials: [],
    } as any);

    await expect(assertWorkspaceModelBudget("ws-1")).rejects.toMatchObject({
      code: "AI_BUDGET_PAUSED",
      status: 429,
    });
  });

  it("expires trial workspaces before a provider call when the trial window has passed", async () => {
    const { prisma } = await import("@corgtex/shared");
    const { assertWorkspaceModelBudget } = await import("./usage");

    vi.mocked(prisma.workspace.findUnique).mockResolvedValue({
      plan: "TRIAL",
      trialEndsAt: new Date(Date.now() - 60_000),
      modelUsageBudget: { monthlyCostCapUsd: "5.00" },
      procurementTrials: [{ id: "trial-1", agentCredentialId: "cred-1", trialExpiresAt: new Date(Date.now() - 60_000) }],
    } as any);

    await expect(assertWorkspaceModelBudget("ws-1")).rejects.toMatchObject({
      code: "TRIAL_EXPIRED",
      status: 429,
    });
    expect(prisma.workspace.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "ws-1" },
      data: expect.objectContaining({ plan: "CORE_FREE" }),
    }));
    expect(prisma.modelUsageBudget.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { workspaceId: "ws-1" },
      update: { monthlyCostCapUsd: 0 },
    }));
    expect(prisma.procurementTrial.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "trial-1" },
      data: { status: "EXPIRED" },
    }));
    expect(prisma.agentCredential.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "cred-1" },
      data: { isActive: false },
    }));
  });

  it("allows usage below a catalog-issued key's daily and monthly limits", async () => {
    const { prisma } = await import("@corgtex/shared");
    const { assertCatalogModelBudget, recordModelUsage } = await import("./usage");

    vi.mocked(prisma.agentCredential.findFirst).mockResolvedValue({
      catalogItemId: "catalog-1",
      isActive: true,
      monthlyBudgetCents: 500,
      dailyCallLimit: 2,
      catalogItem: {
        monthlyBudgetCents: 1000,
        dailyCallLimit: 10,
        archivedAt: null,
      },
    } as any);
    vi.mocked(prisma.modelUsage.count).mockResolvedValue(1);
    vi.mocked(prisma.modelUsage.findMany).mockResolvedValue([
      { estimatedCostUsd: "1.23" },
    ] as any);
    vi.mocked(prisma.modelUsage.create).mockResolvedValue({ id: "usage-1" } as any);

    await assertCatalogModelBudget({
      workspaceId: "ws-1",
      catalogItemId: "catalog-1",
      agentCredentialId: "cred-1",
    });
    await recordModelUsage({
      workspaceId: "ws-1",
      catalogItemId: "catalog-1",
      agentCredentialId: "cred-1",
      provider: "fake",
      model: "fake",
      taskType: "CHAT",
      estimatedCostUsd: "0.010000",
    });

    expect(prisma.modelUsage.count).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        workspaceId: "ws-1",
        agentCredentialId: "cred-1",
      }),
    }));
    expect(prisma.modelUsage.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        catalogItemId: "catalog-1",
        agentCredentialId: "cred-1",
      }),
    }));
  });

  it("records raw and billable cost in the usage ledger", async () => {
    const { prisma } = await import("@corgtex/shared");
    const { recordModelUsage } = await import("./usage");

    vi.mocked(prisma.modelUsage.create).mockResolvedValue({ id: "usage-1" } as any);
    vi.mocked(prisma.aiUsageLedgerEntry.create).mockResolvedValue({ id: "ledger-1" } as any);

    await recordModelUsage({
      workspaceId: "ws-1",
      provider: "openrouter",
      model: "qwen/qwen3-32b",
      taskType: "CHAT",
      inputTokens: 1000,
      outputTokens: 500,
      estimatedCostUsd: "0.000440",
      rawProviderCostUsd: "0.000220",
      billableCostUsd: "0.000440",
    });

    expect(prisma.modelUsage.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        rawProviderCostUsd: "0.000220",
        billableCostUsd: "0.000440",
      }),
    }));
    expect(prisma.aiUsageLedgerEntry.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        workspaceId: "ws-1",
        modelUsageId: "usage-1",
        rawProviderCostUsd: "0.000220",
        billableCostUsd: "0.000440",
      }),
    }));
  });

  it("denies catalog-issued keys that have exhausted their daily limit", async () => {
    const { prisma } = await import("@corgtex/shared");
    const { assertCatalogModelBudget } = await import("./usage");

    vi.mocked(prisma.agentCredential.findFirst).mockResolvedValue({
      catalogItemId: "catalog-1",
      isActive: true,
      monthlyBudgetCents: null,
      dailyCallLimit: 2,
      catalogItem: null,
    } as any);
    vi.mocked(prisma.modelUsage.count).mockResolvedValue(2);

    await expect(assertCatalogModelBudget({
      workspaceId: "ws-1",
      agentCredentialId: "cred-1",
    })).rejects.toMatchObject({
      code: "CATALOG_DAILY_LIMIT_EXCEEDED",
      status: 429,
    });
  });

  it("denies catalog items that have exhausted their monthly budget", async () => {
    const { prisma } = await import("@corgtex/shared");
    const { assertCatalogModelBudget } = await import("./usage");

    vi.mocked(prisma.catalogItem.findFirst).mockResolvedValue({
      id: "catalog-1",
      monthlyBudgetCents: 500,
      dailyCallLimit: null,
    } as any);
    vi.mocked(prisma.modelUsage.findMany).mockResolvedValue([
      { estimatedCostUsd: "2.455", billableCostUsd: "4.91" },
      { estimatedCostUsd: "0.045", billableCostUsd: "0.09" },
    ] as any);

    await expect(assertCatalogModelBudget({
      workspaceId: "ws-1",
      catalogItemId: "catalog-1",
    })).rejects.toMatchObject({
      code: "CATALOG_MONTHLY_BUDGET_EXCEEDED",
      status: 429,
    });
  });

  it("denies inactive catalog-issued keys", async () => {
    const { prisma } = await import("@corgtex/shared");
    const { assertCatalogModelBudget } = await import("./usage");

    vi.mocked(prisma.agentCredential.findFirst).mockResolvedValue({
      isActive: false,
    } as any);

    await expect(assertCatalogModelBudget({
      workspaceId: "ws-1",
      agentCredentialId: "cred-1",
    })).rejects.toMatchObject({
      code: "CATALOG_CREDENTIAL_REVOKED",
      status: 429,
    });
  });
});
