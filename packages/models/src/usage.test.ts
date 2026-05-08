import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@corgtex/shared", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    prisma: {
      agentCredential: { findFirst: vi.fn() },
      catalogItem: { findFirst: vi.fn() },
      modelUsage: {
        count: vi.fn(),
        findMany: vi.fn(),
        create: vi.fn(),
      },
    },
  };
});

beforeEach(async () => {
  const { prisma } = await import("@corgtex/shared");
  vi.mocked(prisma.agentCredential.findFirst).mockReset();
  vi.mocked(prisma.catalogItem.findFirst).mockReset();
  vi.mocked(prisma.modelUsage.count).mockReset();
  vi.mocked(prisma.modelUsage.findMany).mockReset();
  vi.mocked(prisma.modelUsage.create).mockReset();
});

describe("catalog model budgets", () => {
  it("does not query limits when usage is not catalog scoped", async () => {
    const { prisma } = await import("@corgtex/shared");
    const { assertCatalogModelBudget } = await import("./usage");

    await assertCatalogModelBudget({ workspaceId: "ws-1" });

    expect(prisma.agentCredential.findFirst).not.toHaveBeenCalled();
    expect(prisma.catalogItem.findFirst).not.toHaveBeenCalled();
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
    vi.mocked(prisma.modelUsage.create).mockResolvedValue({} as any);

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
      { estimatedCostUsd: "4.91" },
      { estimatedCostUsd: "0.09" },
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
