import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock, txMock, getWorkspaceMonthlyUsageMock } = vi.hoisted(() => {
  const tx = {
    member: {
      findMany: vi.fn(),
    },
    notificationPreference: {
      findMany: vi.fn(),
    },
    notification: {
      createMany: vi.fn(),
    },
    modelUsageBudget: {
      update: vi.fn(),
    },
  };
  return {
    txMock: tx,
    prismaMock: {
      $transaction: vi.fn(),
      workspace: {
        findUnique: vi.fn(),
      },
      procurementTrial: {
        findUnique: vi.fn(),
      },
      modelUsageBudget: {
        findUnique: vi.fn(),
      },
      member: {
        findMany: vi.fn(),
      },
    },
    getWorkspaceMonthlyUsageMock: vi.fn(),
  };
});

vi.mock("@corgtex/shared", () => ({
  prisma: prismaMock,
}));

vi.mock("./agent-run-usage", () => ({
  getWorkspaceMonthlyUsage: getWorkspaceMonthlyUsageMock,
}));

describe("cost budget notifications", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.$transaction.mockImplementation(async (callback: (tx: typeof txMock) => Promise<unknown>) => callback(txMock));
    prismaMock.workspace.findUnique.mockResolvedValue({ plan: "PAYG_AI", trialEndsAt: null });
    prismaMock.procurementTrial.findUnique.mockResolvedValue(null);
    prismaMock.modelUsageBudget.findUnique.mockResolvedValue({
      id: "budget-1",
      monthlyCostCapUsd: "100",
      alertThresholdPct: 80,
      periodStartDay: 1,
      alertSentAt: null,
    });
    prismaMock.member.findMany.mockResolvedValue([{ userId: "admin-user" }]);
    txMock.member.findMany.mockResolvedValue([{ userId: "admin-user" }]);
    txMock.notificationPreference.findMany.mockResolvedValue([]);
    txMock.notification.createMany.mockResolvedValue({ count: 1 });
    txMock.modelUsageBudget.update.mockResolvedValue({});
    getWorkspaceMonthlyUsageMock.mockResolvedValue(85);
  });

  it("creates current-schema budget threshold notifications for active admins", async () => {
    const { checkBudget } = await import("./cost-budget");

    await expect(checkBudget("workspace-1")).resolves.toMatchObject({
      allowed: true,
      usedPct: 85,
      usedUsd: 85,
      capUsd: 100,
    });

    expect(txMock.notification.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          workspaceId: "workspace-1",
          userId: "admin-user",
          type: "budget.threshold_reached",
          entityType: "ModelUsageBudget",
          entityId: "budget-1",
          title: "Budget Alert",
          bodyMd: "Workspace agent usage has reached 85.0% of your monthly budget. ($85.00 of $100)",
        }),
      ],
    });
    expect(txMock.notification.createMany.mock.calls[0]?.[0].data[0]).not.toHaveProperty("message");
    expect(txMock.notification.createMany.mock.calls[0]?.[0].data[0]).not.toHaveProperty("redirectUrl");
    expect(txMock.modelUsageBudget.update).toHaveBeenCalledWith({
      where: { id: "budget-1" },
      data: { alertSentAt: expect.any(Date) },
    });
  });
});
