import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
      upsert: vi.fn(),
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
  sendEmail: vi.fn(),
  env: { APP_URL: "https://app.example.test" },
}));

vi.mock("./agent-run-usage", async (importOriginal) => ({
  ...await importOriginal<typeof import("./agent-run-usage")>(),
  getWorkspaceMonthlyUsage: getWorkspaceMonthlyUsageMock,
}));

describe("cost budget notifications", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 4, 10));
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
    txMock.notification.upsert.mockResolvedValue({ id: "notification-1", workspaceId: "workspace-1", userId: "admin-user" });
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

    expect(txMock.notification.upsert).toHaveBeenCalledWith({
      where: { dedupeKey: `budget.threshold:budget-1:${new Date(2026, 9, 1).toISOString()}:admin-user` },
      update: {},
      create: expect.objectContaining({
        workspaceId: "workspace-1",
        userId: "admin-user",
        type: "budget.threshold_reached",
        entityType: "ModelUsageBudget",
        entityId: "budget-1",
        title: "Budget Alert",
        bodyMd: "Workspace agent usage has reached 85.0% of your monthly budget. ($85.00 of $100)",
      }),
      select: { id: true, workspaceId: true, userId: true },
    });
    expect(txMock.notification.createMany).not.toHaveBeenCalled();
    expect(txMock.modelUsageBudget.update).toHaveBeenCalledWith({
      where: { id: "budget-1" },
      data: { alertSentAt: expect.any(Date) },
    });
  });

  it("does not send the alert again when it was sent earlier in the same period", async () => {
    prismaMock.modelUsageBudget.findUnique.mockResolvedValueOnce({
      id: "budget-1",
      monthlyCostCapUsd: "100",
      alertThresholdPct: 80,
      periodStartDay: 1,
      alertSentAt: new Date(2026, 9, 1, 9),
    });
    const { checkBudget } = await import("./cost-budget");

    await checkBudget("workspace-1");

    expect(prismaMock.member.findMany).not.toHaveBeenCalled();
    expect(txMock.notification.upsert).not.toHaveBeenCalled();
  });

  it("uses the same dedupe key when overlapping checks read stale alert state", async () => {
    const { checkBudget } = await import("./cost-budget");

    await Promise.all([checkBudget("workspace-1"), checkBudget("workspace-1")]);

    expect(txMock.notification.upsert).toHaveBeenCalledTimes(2);
    expect(txMock.notification.upsert.mock.calls[0]?.[0].where).toEqual(
      txMock.notification.upsert.mock.calls[1]?.[0].where,
    );
  });

  it("uses the last day of a short month for a day-31 budget period", async () => {
    const { currentUsagePeriodStart } = await import("./agent-run-usage");

    expect(currentUsagePeriodStart(new Date(2026, 1, 27, 10), 31)).toEqual(new Date(2026, 0, 31));
    expect(currentUsagePeriodStart(new Date(2026, 1, 28, 10), 31)).toEqual(new Date(2026, 1, 28));
  });
});
