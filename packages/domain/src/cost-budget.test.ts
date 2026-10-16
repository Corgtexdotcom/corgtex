import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock, txMock, getWorkspaceMonthlyUsageMock, createNotificationIntentMock, captureArtifactInputProofMock } = vi.hoisted(() => {
  const tx = {
    $queryRaw: vi.fn(),
    member: { findMany: vi.fn() },
    modelUsage: { findMany: vi.fn() },
    modelUsageBudget: { findUnique: vi.fn(), update: vi.fn() },
  };
  return {
    txMock: tx,
    prismaMock: {
      $transaction: vi.fn(), workspace: { findUnique: vi.fn() },
      procurementTrial: { findUnique: vi.fn() }, modelUsageBudget: { findUnique: vi.fn() },
    },
    getWorkspaceMonthlyUsageMock: vi.fn(), createNotificationIntentMock: vi.fn(), captureArtifactInputProofMock: vi.fn(),
  };
});
vi.mock("@corgtex/shared", () => ({ prisma: prismaMock }));
vi.mock("./notifications", () => ({ createNotificationIntent: createNotificationIntentMock }));
vi.mock("./source-lineage", () => ({ captureArtifactInputProof: captureArtifactInputProofMock }));
vi.mock("./agent-run-usage", async (importOriginal) => ({
  ...await importOriginal<typeof import("./agent-run-usage")>(),
  getWorkspaceMonthlyUsage: getWorkspaceMonthlyUsageMock,
}));

const budget = { id: "budget-1", workspaceId: "workspace-1", monthlyCostCapUsd: "100", alertThresholdPct: 80, periodStartDay: 1, alertSentAt: null };
const admin = { id: "admin-member", workspaceId: "workspace-1", userId: "admin-user", role: "ADMIN", isActive: true,
  user: { id: "admin-user", email: "admin@example.test", displayName: "Admin" } };
const usages = [
  { id: "usage-1", workspaceId: "workspace-1", estimatedCostUsd: "10", billableCostUsd: "40", createdAt: new Date(2026, 9, 2) },
  { id: "usage-2", workspaceId: "workspace-1", estimatedCostUsd: "45", billableCostUsd: null, createdAt: new Date(2026, 9, 3) },
];

describe("cost budget notifications", () => {
  afterEach(() => vi.useRealTimers());
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 4, 10));
    prismaMock.$transaction.mockImplementation(async (callback: (tx: typeof txMock) => Promise<unknown>) => callback(txMock));
    prismaMock.workspace.findUnique.mockResolvedValue({ plan: "PAYG_AI", trialEndsAt: null });
    prismaMock.procurementTrial.findUnique.mockResolvedValue(null);
    prismaMock.modelUsageBudget.findUnique.mockResolvedValue(budget);
    txMock.modelUsageBudget.findUnique.mockResolvedValue(budget);
    txMock.modelUsage.findMany.mockResolvedValue(usages);
    txMock.member.findMany.mockResolvedValue([admin]);
    getWorkspaceMonthlyUsageMock.mockResolvedValue(85);
    captureArtifactInputProofMock.mockImplementation(async (_actor, _workspaceId, inputs) => inputs.map((input: { kind: string; id: string }) => ({ kind: input.kind, id: input.id, fingerprint: "a".repeat(64) })));
  });

  it("calculates the alert from exactly the budget and all cost projections in its receipt", async () => {
    const { checkBudget } = await import("./cost-budget");
    // Authorization/cached decision stays unchanged; notification uses the fresh rows.
    getWorkspaceMonthlyUsageMock.mockResolvedValue(90);
    await expect(checkBudget("workspace-1")).resolves.toMatchObject({ allowed: true, usedPct: 90, usedUsd: 90, capUsd: 100 });
    const actor = captureArtifactInputProofMock.mock.calls[0][0];
    expect(actor).toMatchObject({ kind: "agent", authProvider: "bootstrap", label: "BUDGET_ALERT", workspaceIds: ["workspace-1"] });
    expect(Object.isFrozen(actor)).toBe(true);
    expect(captureArtifactInputProofMock).toHaveBeenCalledWith(actor, "workspace-1", [
      { kind: "ModelUsageBudget", id: budget.id, snapshot: budget },
      ...usages.map((usage) => ({ kind: "ModelUsageCost", id: usage.id, snapshot: usage })),
    ], txMock);
    expect(txMock.modelUsage.findMany).toHaveBeenCalledWith({
      where: { workspaceId: "workspace-1", createdAt: { gte: new Date(2026, 9, 1) } },
      select: { id: true, workspaceId: true, estimatedCostUsd: true, billableCostUsd: true, createdAt: true },
      orderBy: { id: "asc" }, take: 5001,
    });
    expect(createNotificationIntentMock).toHaveBeenCalledWith(txMock, expect.objectContaining({
      workspaceId: "workspace-1", recipientUserIds: ["admin-user"], lineageActor: actor,
      lineageRoots: [
        { kind: "ModelUsageBudget", id: "budget-1", fingerprint: "a".repeat(64) },
        ...usages.map((usage) => ({ kind: "ModelUsageCost", id: usage.id, fingerprint: "a".repeat(64) })),
        { kind: "Member", id: admin.id, fingerprint: "a".repeat(64) },
        { kind: "User", id: admin.userId, fingerprint: "a".repeat(64) },
      ],
      type: "budget.threshold_reached", entityType: "ModelUsageBudget", entityId: "budget-1", title: "Budget Alert",
      bodyMd: "Workspace agent usage has reached 85.0% of your monthly budget. ($85.00 of $100)",
      dedupeKey: `budget.threshold:budget-1:${new Date(2026, 9, 1).toISOString()}:${admin.id}`,
    }));
    expect(txMock.member.findMany).toHaveBeenCalledWith({ where: { workspaceId: "workspace-1", role: "ADMIN", isActive: true }, include: { user: { select: { id: true, email: true, displayName: true } } } });
    expect(txMock.modelUsageBudget.update).toHaveBeenCalledWith({ where: { id: "budget-1" }, data: { alertSentAt: expect.any(Date) } });
  });

  it("captures each admin independently and does not tie another recipient to its departure", async () => {
    const second = { ...admin, id: "second-admin-member", userId: "second-admin-user", user: { id: "second-admin-user", email: "second@example.test", displayName: "Second" } };
    txMock.member.findMany.mockResolvedValue([admin, second]);
    const { checkBudget } = await import("./cost-budget");
    await checkBudget("workspace-1");
    expect(createNotificationIntentMock).toHaveBeenCalledTimes(2);
    const notifications = createNotificationIntentMock.mock.calls.map((call) => call[1]);
    expect(notifications.map((notification) => notification.recipientUserIds)).toEqual([[admin.userId], [second.userId]]);
    expect(notifications[0].lineageRoots).toContainEqual({ kind: "Member", id: admin.id, fingerprint: "a".repeat(64) });
    expect(notifications[1].lineageRoots).toContainEqual({ kind: "Member", id: second.id, fingerprint: "a".repeat(64) });
    expect(notifications[1].lineageRoots.some((root: { kind: string; id: string }) => root.kind === "Member" && root.id === admin.id)).toBe(false);
    expect(captureArtifactInputProofMock).toHaveBeenCalledWith(notifications[1].lineageActor, "workspace-1", [
      { kind: "Member", id: second.id, snapshot: second }, { kind: "User", id: second.userId, snapshot: second.user },
    ], txMock);
  });

  it("does not send an alert already recorded in the current period", async () => {
    prismaMock.modelUsageBudget.findUnique.mockResolvedValue({ ...budget, alertSentAt: new Date(2026, 9, 1, 9) });
    const { checkBudget } = await import("./cost-budget");
    await checkBudget("workspace-1");
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    expect(createNotificationIntentMock).not.toHaveBeenCalled();
  });

  it("rechecks the marker after locking a budget read by an overlapping checker", async () => {
    txMock.modelUsageBudget.findUnique.mockResolvedValue({ ...budget, alertSentAt: new Date(2026, 9, 1, 9) });
    const { checkBudget } = await import("./cost-budget");
    await checkBudget("workspace-1");
    expect(txMock.$queryRaw).toHaveBeenCalledTimes(1);
    expect(txMock.modelUsage.findMany).not.toHaveBeenCalled();
    expect(createNotificationIntentMock).not.toHaveBeenCalled();
  });

  it("does not copy an obsolete cap when the budget changed before alert creation", async () => {
    txMock.modelUsageBudget.findUnique.mockResolvedValue({ ...budget, monthlyCostCapUsd: "200" });
    const { checkBudget } = await import("./cost-budget");
    await checkBudget("workspace-1");
    expect(captureArtifactInputProofMock.mock.calls[0]?.[2][0].snapshot.monthlyCostCapUsd).toBe("200");
    expect(createNotificationIntentMock).not.toHaveBeenCalled();
    expect(txMock.modelUsageBudget.update).not.toHaveBeenCalled();
  });

  it("fails explicitly when complete cost inputs exceed the bounded scan", async () => {
    txMock.modelUsage.findMany.mockResolvedValue(Array.from({ length: 5001 }, (_, i) => ({ ...usages[0], id: `usage-${i}` })));
    const { checkBudget } = await import("./cost-budget");
    await expect(checkBudget("workspace-1")).rejects.toMatchObject({ code: "INPUT_SCAN_LIMIT" });
    expect(captureArtifactInputProofMock).not.toHaveBeenCalled();
    expect(createNotificationIntentMock).not.toHaveBeenCalled();
    expect(txMock.modelUsageBudget.update).not.toHaveBeenCalled();
  });

  it("does not set the period marker or create an alert when input proof changes", async () => {
    captureArtifactInputProofMock.mockRejectedValue(Object.assign(new Error("Changed source"), { code: "SOURCE_CHANGED" }));
    const { checkBudget } = await import("./cost-budget");
    await expect(checkBudget("workspace-1")).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(createNotificationIntentMock).not.toHaveBeenCalled();
    expect(txMock.modelUsageBudget.update).not.toHaveBeenCalled();
  });

  it("uses the last day of a short month for a day-31 budget period", async () => {
    const { currentUsagePeriodStart } = await import("./agent-run-usage");
    expect(currentUsagePeriodStart(new Date(2026, 1, 27, 10), 31)).toEqual(new Date(2026, 0, 31));
    expect(currentUsagePeriodStart(new Date(2026, 1, 28, 10), 31)).toEqual(new Date(2026, 1, 28));
  });
});
