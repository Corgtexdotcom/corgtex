import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock, requireWorkspaceMembershipMock } = vi.hoisted(() => ({
  prismaMock: {
    $queryRaw: vi.fn(),
    crmAccount: {
      findUnique: vi.fn(),
    },
    crmDeal: {
      findUnique: vi.fn(),
    },
    member: {
      findFirst: vi.fn(),
    },
    practiceContributionEntry: {
      create: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      groupBy: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    practiceClient: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
    practiceConsultant: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
    practiceExpense: {
      create: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
    },
    practiceProject: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
    practiceTimeEntry: {
      create: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
    },
    workspaceFeatureFlag: {
      findUnique: vi.fn(),
    },
    user: {
      findMany: vi.fn(),
    },
  },
  requireWorkspaceMembershipMock: vi.fn(),
}));

vi.mock("@corgtex/shared", () => ({
  prisma: prismaMock,
}));

vi.mock("./auth", () => ({
  requireWorkspaceMembership: requireWorkspaceMembershipMock,
}));

import {
  BUDGET_RUNWAY_ATTENTION_WEEKS,
  SLICING_PIE_EXPENSE_MULTIPLIER,
  SLICING_PIE_TIME_MULTIPLIER,
  calculatePracticeContributionAmount,
  calculatePracticeContributionSlices,
  calculateNativePracticeConsultantUtilization,
  calculateNativePracticeProjectHealth,
  canManagePracticeFinanceProjects,
  collectAttention,
  collectNativePracticeAttention,
  createNativePracticeExpense,
  createNativePracticeTimeEntry,
  createPracticeContributionEntry,
  createPracticeProject,
  createPracticeProjectFromWonDeal,
  getCrmAccountPracticeFinance,
  getNativePracticeFinanceDashboard,
  getPracticeFinanceDashboard,
  getSlicingPieSummary,
  listNativePracticeProjectHealth,
  listPracticeContributionEntries,
  listRequestedPracticeContributionPayables,
  listPracticeProjects,
  markPracticeContributionEntryPaid,
  nativePracticeProjectAttentionItems,
  previewSlicingPieContributionFromExpense,
  previewSlicingPieContributionFromTimeEntry,
  projectAttentionItems,
  projectBudgetRunwayWeeks,
  projectNeedsSetup,
  projectRemainingCents,
  projectUsedRatio,
  summarizeNativePracticeFinance,
  summarizePracticeFinance,
  updatePracticeProject,
} from "./practice-finance";

type Fixture = Parameters<typeof projectAttentionItems>[0];

function project(overrides: Partial<Fixture> = {}): Fixture {
  return {
    id: "p1",
    name: "Demo Project",
    status: "ACTIVE",
    poValueCents: 18_000_00,
    serviceBudgetCents: 15_000_00,
    expenseBudgetCents: 1_000_00,
    usedCents: 2_000_00,
    weeklyBurnCents: 0,
    targetMarginBps: 5500,
    currentMarginBps: 6400,
    ...overrides,
  };
}

type NativeProjectFixture = Parameters<typeof calculateNativePracticeProjectHealth>[0]["project"];
type NativeTimeEntryFixture = Parameters<typeof calculateNativePracticeProjectHealth>[0]["timeEntries"][number];
type NativeExpenseFixture = Parameters<typeof calculateNativePracticeProjectHealth>[0]["expenses"][number];
type NativeConsultantFixture = Parameters<typeof calculateNativePracticeConsultantUtilization>[0]["consultant"];

function decimal(value: number): NativeTimeEntryFixture["hours"] {
  return {
    toNumber: () => value,
    toString: () => String(value),
  } as NativeTimeEntryFixture["hours"];
}

function prismaSqlText(value: unknown): string {
  const query = value as { sql?: string; text?: string; strings?: readonly string[] };
  return query.sql ?? query.text ?? query.strings?.join("?") ?? String(value);
}

function nativeProject(overrides: Partial<NativeProjectFixture> = {}): NativeProjectFixture {
  return {
    id: "project-1",
    code: "DPRJ-001",
    name: "Native project",
    clientName: "Example",
    clientId: "client-1",
    status: "ACTIVE",
    currency: "USD",
    poValueCents: 10_000_00,
    serviceBudgetCents: 8_000_00,
    expenseBudgetCents: 2_000_00,
    targetMarginBps: 5000,
    ...overrides,
  };
}

function nativeTimeEntry(overrides: Partial<NativeTimeEntryFixture> = {}): NativeTimeEntryFixture {
  return {
    id: "time-1",
    projectId: "project-1",
    consultantId: "consultant-1",
    workedOn: new Date("2026-06-27T00:00:00.000Z"),
    weekEndingOn: new Date("2026-06-29T00:00:00.000Z"),
    hours: decimal(10),
    currency: "USD",
    billCurrency: null,
    costCurrency: null,
    functionalCurrency: null,
    billRateCents: 15_000,
    costRateCents: 8_000,
    billAmountCents: null,
    costAmountCents: null,
    paidAmountCents: null,
    paymentBatchId: null,
    status: "POSTED",
    ...overrides,
  };
}

function nativeExpense(overrides: Partial<NativeExpenseFixture> = {}): NativeExpenseFixture {
  return {
    id: "expense-1",
    projectId: "project-1",
    consultantId: "consultant-1",
    spentOn: new Date("2026-06-28T00:00:00.000Z"),
    category: "Travel",
    amountCents: 40_000,
    currency: "USD",
    amountFunctionalCents: null,
    functionalCurrency: null,
    billable: true,
    paymentBatchId: null,
    status: "POSTED",
    ...overrides,
  };
}

function nativeConsultant(overrides: Partial<NativeConsultantFixture> = {}): NativeConsultantFixture {
  return {
    id: "consultant-1",
    name: "Priya Shah",
    email: "priya@example.test",
    active: true,
    ...overrides,
  };
}

describe("practice-finance pure derivations", () => {
  it("computes remaining and used ratio", () => {
    const p = project({ poValueCents: 10_000_00, usedCents: 2_500_00 });
    expect(projectRemainingCents(p)).toBe(7_500_00);
    expect(projectUsedRatio(p)).toBeCloseTo(0.25);
  });

  it("treats a zero budget as 0% used (no divide-by-zero)", () => {
    expect(projectUsedRatio(project({ poValueCents: 0, usedCents: 500_00 }))).toBe(0);
  });

  it("computes budget runway weeks, null without burn and 0 when exhausted", () => {
    expect(projectBudgetRunwayWeeks(project({ weeklyBurnCents: 0 }))).toBeNull();
    expect(
      projectBudgetRunwayWeeks(project({ poValueCents: 7_453_00, usedCents: 2_182_00, weeklyBurnCents: 2_182_00 })),
    ).toBeCloseTo(2.415, 2);
    expect(projectBudgetRunwayWeeks(project({ poValueCents: 1000, usedCents: 5000, weeklyBurnCents: 100 }))).toBe(0);
  });

  it("flags setup-incomplete projects", () => {
    expect(projectNeedsSetup(project())).toBe(false);
    expect(projectNeedsSetup(project({ poValueCents: 0 }))).toBe(true);
    expect(projectNeedsSetup(project({ targetMarginBps: null }))).toBe(true);
    expect(projectNeedsSetup(project({ expenseBudgetCents: 0 }))).toBe(true);
  });

  it("surfaces a setup attention item and short-circuits other checks", () => {
    const items = projectAttentionItems(project({ poValueCents: 0, weeklyBurnCents: 9_999_00, currentMarginBps: 10 }));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ issue: "setup", weeks: null });
  });

  it("surfaces a budget runway attention item with a dollar/week detail", () => {
    const items = projectAttentionItems(
      project({ poValueCents: 7_453_00, usedCents: 2_182_00, weeklyBurnCents: 2_182_00, currentMarginBps: 6400, targetMarginBps: 5500 }),
    );
    const budget = items.find((i) => i.issue === "budget");
    expect(budget).toBeDefined();
    expect(budget?.weeks).toBe(2.4);
    expect(budget?.detail).toBe("$5,271 remaining at $2,182 / week.");
  });

  it("surfaces a margin attention item when below target", () => {
    const items = projectAttentionItems(
      project({ weeklyBurnCents: 0, currentMarginBps: 5260, targetMarginBps: 5500 }),
    );
    const margin = items.find((i) => i.issue === "margin");
    expect(margin?.detail).toBe("Current margin 52.6% vs target 55.0%.");
  });

  it("ignores non-active projects for attention", () => {
    expect(projectAttentionItems(project({ status: "CLOSED", poValueCents: 0 }))).toEqual([]);
  });

  it("does not flag budget attention when runway exceeds the threshold", () => {
    const items = projectAttentionItems(
      project({ poValueCents: 100_000_00, usedCents: 0, weeklyBurnCents: 100_00 }),
    );
    // 1000 weeks of runway -> well above threshold
    expect(items.find((i) => i.issue === "budget")).toBeUndefined();
    expect(BUDGET_RUNWAY_ATTENTION_WEEKS).toBeGreaterThan(0);
  });

  it("summarizes the portfolio across active projects only, with PO-weighted margin", () => {
    const summary = summarizePracticeFinance([
      project({ id: "a", status: "ACTIVE", poValueCents: 100_000_00, usedCents: 10_000_00, currentMarginBps: 6000 }),
      project({ id: "b", status: "ACTIVE", poValueCents: 300_000_00, usedCents: 30_000_00, currentMarginBps: 7000 }),
      project({ id: "c", status: "CLOSED", poValueCents: 999_000_00, usedCents: 999_000_00, currentMarginBps: 100 }),
    ]);
    expect(summary.activeProjects).toBe(2);
    expect(summary.budgetCents).toBe(400_000_00);
    expect(summary.usedCents).toBe(40_000_00);
    expect(summary.remainingCents).toBe(360_000_00);
    // PO-weighted: (6000*100 + 7000*300) / 400 = 6750
    expect(summary.marginBps).toBe(6750);
  });

  it("returns null portfolio margin when no active project has a margin", () => {
    expect(summarizePracticeFinance([project({ status: "ACTIVE", currentMarginBps: null })]).marginBps).toBeNull();
  });

  it("collects attention across many projects", () => {
    const all = collectAttention([
      project({ id: "s", poValueCents: 0 }),
      project({ id: "ok", weeklyBurnCents: 0 }),
    ]);
    expect(all.map((i) => i.projectId)).toEqual(["s"]);
  });

  it("calculates native project health from posted time and expenses", () => {
    const health = calculateNativePracticeProjectHealth({
      project: nativeProject(),
      now: new Date("2026-06-30T00:00:00.000Z"),
      timeEntries: [
        nativeTimeEntry(),
        nativeTimeEntry({
          id: "time-reversed",
          billAmountCents: 9_999_00,
          costAmountCents: 9_999_00,
          status: "REVERSED",
        }),
      ],
      expenses: [
        nativeExpense(),
        nativeExpense({
          id: "expense-nonbillable",
          amountCents: 10_000,
          billable: false,
        }),
      ],
    });

    expect(health).toMatchObject({
      projectId: "project-1",
      budgetCents: 10_000_00,
      usedBudgetCents: 190_000,
      remainingBudgetCents: 810_000,
      directCostCents: 130_000,
      grossProfitCents: 60_000,
      grossMarginBps: 3158,
      recentBudgetBurnPerWeekCents: 47_500,
      recentCostBurnPerWeekCents: 32_500,
      weeksToTargetMarginRisk: 0,
      hasBudgetSetup: true,
      hasRecentBurn: true,
    });
    expect(health.weeksToBudgetExhaustion).toBeCloseTo(17.052, 2);
  });

  it("marks native project health as setup-incomplete until budget and margin inputs exist", () => {
    const health = calculateNativePracticeProjectHealth({
      project: nativeProject({ targetMarginBps: null }),
      now: new Date("2026-06-30T00:00:00.000Z"),
      timeEntries: [nativeTimeEntry()],
      expenses: [],
    });

    expect(health.hasBudgetSetup).toBe(false);
    expect(health.weeksToBudgetExhaustion).toBeNull();
    expect(nativePracticeProjectAttentionItems(health)).toEqual([{
      projectId: "project-1",
      projectName: "Native project",
      issue: "setup",
      weeks: null,
      detail: "Add PO value, service budget, expense budget, and target margin before forecasting.",
    }]);
  });

  it("counts current-week work in recent native project and consultant burn", () => {
    const currentWeekEntry = nativeTimeEntry({
      workedOn: new Date("2026-06-27T00:00:00.000Z"),
      weekEndingOn: new Date("2026-07-03T00:00:00.000Z"),
    });
    const health = calculateNativePracticeProjectHealth({
      project: nativeProject(),
      now: new Date("2026-06-28T00:00:00.000Z"),
      recentWindowWeeks: 1,
      timeEntries: [currentWeekEntry],
      expenses: [],
    });
    const utilization = calculateNativePracticeConsultantUtilization({
      consultant: nativeConsultant(),
      now: new Date("2026-06-28T00:00:00.000Z"),
      recentWindowWeeks: 1,
      timeEntries: [currentWeekEntry],
      expenses: [],
    });

    expect(health.recentBudgetBurnPerWeekCents).toBe(150_000);
    expect(health.recentCostBurnPerWeekCents).toBe(80_000);
    expect(utilization.recentHours).toBe(10);
  });

  it("excludes lower-boundary rows from recent native windows", () => {
    const boundaryTime = nativeTimeEntry({
      id: "boundary-time",
      workedOn: new Date("2026-01-01T00:00:00.000Z"),
      weekEndingOn: new Date("2026-01-05T00:00:00.000Z"),
      hours: decimal(4),
      billAmountCents: 100_00,
      costAmountCents: 40_00,
    });
    const insideTime = nativeTimeEntry({
      id: "inside-time",
      workedOn: new Date("2026-01-02T00:00:00.000Z"),
      weekEndingOn: new Date("2026-01-05T00:00:00.000Z"),
      hours: decimal(2),
      billAmountCents: 200_00,
      costAmountCents: 80_00,
    });
    const boundaryExpense = nativeExpense({
      id: "boundary-expense",
      spentOn: new Date("2026-01-01T00:00:00.000Z"),
      amountCents: 300_00,
    });
    const insideExpense = nativeExpense({
      id: "inside-expense",
      spentOn: new Date("2026-01-02T00:00:00.000Z"),
      amountCents: 400_00,
    });

    const health = calculateNativePracticeProjectHealth({
      project: nativeProject(),
      now: new Date("2026-01-29T00:00:00.000Z"),
      recentWindowWeeks: 4,
      timeEntries: [boundaryTime, insideTime],
      expenses: [boundaryExpense, insideExpense],
    });
    const utilization = calculateNativePracticeConsultantUtilization({
      consultant: nativeConsultant(),
      now: new Date("2026-01-29T00:00:00.000Z"),
      recentWindowWeeks: 4,
      timeEntries: [boundaryTime, insideTime],
      expenses: [],
    });

    expect(health.recentBudgetBurnPerWeekCents).toBe(150_00);
    expect(health.recentCostBurnPerWeekCents).toBe(120_00);
    expect(utilization.recentHours).toBe(2);
  });

  it("summarizes native project health and collects margin attention", () => {
    const risky = calculateNativePracticeProjectHealth({
      project: nativeProject({ id: "risk", name: "Risky" }),
      now: new Date("2026-06-30T00:00:00.000Z"),
      timeEntries: [nativeTimeEntry({ projectId: "risk" })],
      expenses: [nativeExpense({ projectId: "risk" })],
    });
    const closed = calculateNativePracticeProjectHealth({
      project: nativeProject({ id: "closed", status: "CLOSED" }),
      timeEntries: [],
      expenses: [],
      now: new Date("2026-06-30T00:00:00.000Z"),
    });

    const summary = summarizeNativePracticeFinance([risky, closed]);
    expect(summary.activeProjects).toBe(1);
    expect(summary.currency).toBe("USD");
    expect(summary.usedCents).toBe(190_000);
    expect(summary.directCostCents).toBe(120_000);
    expect(summary.marginBps).toBe(3684);
    expect(summary.riskMarginCount).toBe(1);
    expect(collectNativePracticeAttention([risky, closed]).map((item) => item.issue)).toEqual(["margin"]);
  });

  it("preserves native project overruns in portfolio remaining totals", () => {
    const overrun = calculateNativePracticeProjectHealth({
      project: nativeProject({
        id: "overrun",
        poValueCents: 100_00,
        serviceBudgetCents: 80_00,
        expenseBudgetCents: 20_00,
      }),
      timeEntries: [nativeTimeEntry({
        projectId: "overrun",
        billAmountCents: 200_00,
        costAmountCents: 0,
      })],
      expenses: [],
    });
    const untouched = calculateNativePracticeProjectHealth({
      project: nativeProject({
        id: "untouched",
        poValueCents: 100_00,
        serviceBudgetCents: 80_00,
        expenseBudgetCents: 20_00,
      }),
      timeEntries: [],
      expenses: [],
    });

    const summary = summarizeNativePracticeFinance([overrun, untouched]);
    expect(overrun.remainingBudgetCents).toBe(-100_00);
    expect(overrun.weeksToBudgetExhaustion).toBe(0);
    expect(summary.remainingCents).toBe(0);
  });

  it("compares unrounded native budget runway against the attention threshold", () => {
    const nearThreshold = calculateNativePracticeProjectHealth({
      project: nativeProject({
        poValueCents: 704,
        serviceBudgetCents: 1,
        expenseBudgetCents: 1,
        targetMarginBps: 0,
      }),
      now: new Date("2026-06-30T00:00:00.000Z"),
      recentWindowWeeks: 1,
      timeEntries: [nativeTimeEntry({
        billAmountCents: 100,
        costAmountCents: 0,
      })],
      expenses: [],
    });

    const summary = summarizeNativePracticeFinance([nearThreshold]);
    expect(nearThreshold.weeksToBudgetExhaustion).toBeCloseTo(6.04, 2);
    expect(summary.riskBudgetCount).toBe(0);
    expect(collectNativePracticeAttention([nearThreshold])).toEqual([]);
  });

  it("uses exact native weekly budget burn for runway decisions", () => {
    const nearThreshold = calculateNativePracticeProjectHealth({
      project: nativeProject({
        poValueCents: 997,
        serviceBudgetCents: 1,
        expenseBudgetCents: 1,
        targetMarginBps: 0,
      }),
      now: new Date("2026-06-30T00:00:00.000Z"),
      recentWindowWeeks: 4,
      timeEntries: [nativeTimeEntry({
        billAmountCents: 398,
        costAmountCents: 0,
      })],
      expenses: [],
    });

    const summary = summarizeNativePracticeFinance([nearThreshold]);
    expect(nearThreshold.recentBudgetBurnPerWeekCents).toBe(100);
    expect(nearThreshold.weeksToBudgetExhaustion).toBeCloseTo(6.02, 2);
    expect(summary.riskBudgetCount).toBe(0);
    expect(collectNativePracticeAttention([nearThreshold])).toEqual([]);
  });

  it("compares unrounded native margin runway against the attention threshold", () => {
    const nearThreshold = calculateNativePracticeProjectHealth({
      project: nativeProject({
        poValueCents: 10_000_00,
        targetMarginBps: 5000,
      }),
      now: new Date("2026-06-30T00:00:00.000Z"),
      recentWindowWeeks: 1,
      timeEntries: [
        nativeTimeEntry({
          id: "old-margin-headroom",
          workedOn: new Date("2026-01-01T00:00:00.000Z"),
          weekEndingOn: new Date("2026-01-05T00:00:00.000Z"),
          billAmountCents: 1900,
          costAmountCents: 711,
        }),
        nativeTimeEntry({
          id: "recent-margin-drift",
          billAmountCents: 100,
          costAmountCents: 84,
        }),
      ],
      expenses: [],
    });

    const summary = summarizeNativePracticeFinance([nearThreshold]);
    expect(nearThreshold.weeksToTargetMarginRisk).toBeCloseTo(6.029, 2);
    expect(summary.riskMarginCount).toBe(0);
    expect(collectNativePracticeAttention([nearThreshold])).toEqual([]);
  });

  it("uses exact native weekly margin burn for runway decisions", () => {
    const nearThreshold = calculateNativePracticeProjectHealth({
      project: nativeProject({
        poValueCents: 10_000_00,
        targetMarginBps: 5000,
      }),
      now: new Date("2026-06-30T00:00:00.000Z"),
      recentWindowWeeks: 4,
      timeEntries: [
        nativeTimeEntry({
          id: "old-margin-headroom",
          workedOn: new Date("2026-01-01T00:00:00.000Z"),
          weekEndingOn: new Date("2026-01-05T00:00:00.000Z"),
          billAmountCents: 2000,
          costAmountCents: 491,
        }),
        nativeTimeEntry({
          id: "recent-margin-drift",
          billAmountCents: 398,
          costAmountCents: 402,
        }),
      ],
      expenses: [],
    });

    const summary = summarizeNativePracticeFinance([nearThreshold]);
    expect(nearThreshold.recentBudgetBurnPerWeekCents).toBe(100);
    expect(nearThreshold.recentCostBurnPerWeekCents).toBe(101);
    expect(nearThreshold.weeksToTargetMarginRisk).toBeCloseTo(6.03, 2);
    expect(summary.riskMarginCount).toBe(0);
    expect(collectNativePracticeAttention([nearThreshold])).toEqual([]);
  });

  it("flags exhausted native project budgets even without recent burn", () => {
    const overrun = calculateNativePracticeProjectHealth({
      project: nativeProject({
        poValueCents: 100_00,
        serviceBudgetCents: 80_00,
        expenseBudgetCents: 20_00,
      }),
      now: new Date("2026-06-30T00:00:00.000Z"),
      timeEntries: [nativeTimeEntry({
        workedOn: new Date("2026-01-01T00:00:00.000Z"),
        weekEndingOn: new Date("2026-01-05T00:00:00.000Z"),
        billAmountCents: 200_00,
        costAmountCents: 0,
      })],
      expenses: [],
    });

    expect(overrun.recentBudgetBurnPerWeekCents).toBe(0);
    expect(overrun.weeksToBudgetExhaustion).toBe(0);
    expect(collectNativePracticeAttention([overrun]).map((item) => item.issue)).toEqual(["budget"]);
  });

  it("formats native budget attention in the project currency", () => {
    const health = calculateNativePracticeProjectHealth({
      project: nativeProject({
        currency: "EUR",
        poValueCents: 100_00,
        serviceBudgetCents: 80_00,
        expenseBudgetCents: 20_00,
      }),
      now: new Date("2026-06-30T00:00:00.000Z"),
      recentWindowWeeks: 4,
      timeEntries: [nativeTimeEntry({
        currency: "EUR",
        billCurrency: "EUR",
        costCurrency: "EUR",
        billAmountCents: 90_00,
        costAmountCents: 40_00,
      })],
      expenses: [],
    });

    expect(nativePracticeProjectAttentionItems(health)[0]).toMatchObject({
      issue: "budget",
      detail: "€10 remaining at €23 / week.",
    });
  });

  it("does not count setup-incomplete projects as native margin risks", () => {
    const incomplete = calculateNativePracticeProjectHealth({
      project: nativeProject({ expenseBudgetCents: 0 }),
      timeEntries: [nativeTimeEntry({
        billAmountCents: 100_00,
        costAmountCents: 80_00,
      })],
      expenses: [],
    });

    const summary = summarizeNativePracticeFinance([incomplete]);
    expect(incomplete.hasBudgetSetup).toBe(false);
    expect(incomplete.weeksToTargetMarginRisk).toBe(0);
    expect(summary.riskMarginCount).toBe(0);
    expect(collectNativePracticeAttention([incomplete]).map((item) => item.issue)).toEqual(["setup"]);
  });

  it("flags negative native project margin against a zero percent target", () => {
    const negativeMargin = calculateNativePracticeProjectHealth({
      project: nativeProject({ targetMarginBps: 0 }),
      timeEntries: [nativeTimeEntry({
        billAmountCents: 100_00,
        costAmountCents: 120_00,
      })],
      expenses: [],
    });

    const summary = summarizeNativePracticeFinance([negativeMargin]);
    expect(negativeMargin.grossMarginBps).toBe(-2000);
    expect(negativeMargin.weeksToTargetMarginRisk).toBe(0);
    expect(summary.riskMarginCount).toBe(1);
    expect(collectNativePracticeAttention([negativeMargin]).map((item) => item.issue)).toEqual(["margin"]);
  });

  it("flags historical native margin losses even without recent burn", () => {
    const costOnlyLoss = calculateNativePracticeProjectHealth({
      project: nativeProject(),
      now: new Date("2026-06-30T00:00:00.000Z"),
      timeEntries: [],
      expenses: [nativeExpense({
        amountCents: 100_00,
        billable: false,
        spentOn: new Date("2026-01-01T00:00:00.000Z"),
      })],
    });

    const summary = summarizeNativePracticeFinance([costOnlyLoss]);
    expect(costOnlyLoss.recentBudgetBurnPerWeekCents).toBe(0);
    expect(costOnlyLoss.weeksToTargetMarginRisk).toBe(0);
    expect(summary.riskMarginCount).toBe(1);
    expect(collectNativePracticeAttention([costOnlyLoss]).map((item) => item.issue)).toEqual(["margin"]);
  });

  it("does not flag exact target margin when the recent trend improves", () => {
    const steadyMargin = calculateNativePracticeProjectHealth({
      project: nativeProject({ targetMarginBps: 5000 }),
      now: new Date("2026-06-30T00:00:00.000Z"),
      timeEntries: [
        nativeTimeEntry({
          id: "old-margin",
          workedOn: new Date("2026-01-01T00:00:00.000Z"),
          weekEndingOn: new Date("2026-01-05T00:00:00.000Z"),
          billAmountCents: 100_00,
          costAmountCents: 80_00,
        }),
        nativeTimeEntry({
          id: "recent-margin",
          billAmountCents: 100_00,
          costAmountCents: 20_00,
        }),
      ],
      expenses: [],
    });

    const summary = summarizeNativePracticeFinance([steadyMargin]);
    expect(steadyMargin.grossMarginBps).toBe(5000);
    expect(steadyMargin.weeksToTargetMarginRisk).toBeNull();
    expect(summary.riskMarginCount).toBe(0);
    expect(collectNativePracticeAttention([steadyMargin])).toEqual([]);
  });

  it("marks mixed active currencies without aggregating native finance money totals", () => {
    const usd = calculateNativePracticeProjectHealth({
      project: nativeProject({ id: "usd", currency: "USD" }),
      timeEntries: [],
      expenses: [],
    });
    const eur = calculateNativePracticeProjectHealth({
      project: nativeProject({ id: "eur", currency: "EUR" }),
      timeEntries: [],
      expenses: [],
    });

    const summary = summarizeNativePracticeFinance([usd, eur]);
    expect(summary.activeProjects).toBe(2);
    expect(summary.currency).toBeNull();
    expect(summary.budgetCents).toBe(0);
    expect(summary.usedCents).toBe(0);
    expect(summary.remainingCents).toBe(0);
    expect(summary.marginBps).toBeNull();
  });

  it("canonicalizes equivalent native project currency labels before summarizing", () => {
    const uppercase = calculateNativePracticeProjectHealth({
      project: nativeProject({ id: "uppercase", currency: "USD" }),
      timeEntries: [],
      expenses: [],
    });
    const lowercase = calculateNativePracticeProjectHealth({
      project: nativeProject({ id: "lowercase", currency: "usd" }),
      timeEntries: [],
      expenses: [],
    });

    const summary = summarizeNativePracticeFinance([uppercase, lowercase]);
    expect(summary.activeProjects).toBe(2);
    expect(summary.currency).toBe("USD");
  });

  it("rejects active native projects without a portfolio currency", () => {
    try {
      calculateNativePracticeProjectHealth({
        project: nativeProject({ currency: " " }),
        timeEntries: [],
        expenses: [],
      });
      throw new Error("Expected active native projects without currency to be rejected.");
    } catch (error) {
      expect(error).toMatchObject({ code: "MIXED_CURRENCY" });
    }

    try {
      calculateNativePracticeProjectHealth({
        project: nativeProject({ currency: " ", status: "CLOSED" }),
        timeEntries: [],
        expenses: [],
      });
      throw new Error("Expected rowless inactive native projects without currency to be rejected.");
    } catch (error) {
      expect(error).toMatchObject({ code: "MIXED_CURRENCY" });
    }
  });

  it("rejects posted native ledger rows when project and row currencies are both missing", () => {
    try {
      calculateNativePracticeProjectHealth({
        project: nativeProject({ currency: " " }),
        timeEntries: [nativeTimeEntry({
          currency: " ",
          billCurrency: null,
          costCurrency: null,
          functionalCurrency: null,
          billAmountCents: 100,
          costAmountCents: 80,
        })],
        expenses: [],
      });
      throw new Error("Expected both-null time entry currencies to be rejected.");
    } catch (error) {
      expect(error).toMatchObject({ code: "MIXED_CURRENCY" });
    }

    try {
      calculateNativePracticeProjectHealth({
        project: nativeProject({ currency: " " }),
        timeEntries: [],
        expenses: [nativeExpense({
          currency: " ",
          functionalCurrency: null,
          amountFunctionalCents: null,
          amountCents: 100,
        })],
      });
      throw new Error("Expected both-null expense currencies to be rejected.");
    } catch (error) {
      expect(error).toMatchObject({ code: "MIXED_CURRENCY" });
    }
  });

  it("returns the normalized portfolio currency for non-USD native summaries", () => {
    const eur = calculateNativePracticeProjectHealth({
      project: nativeProject({ id: "eur", currency: "eur" }),
      timeEntries: [nativeTimeEntry({
        projectId: "eur",
        currency: "EUR",
        billCurrency: "EUR",
        costCurrency: "EUR",
        billAmountCents: 100_00,
        costAmountCents: 80_00,
      })],
      expenses: [],
    });

    expect(summarizeNativePracticeFinance([eur])).toMatchObject({
      currency: "EUR",
      budgetCents: 10_000_00,
      usedCents: 100_00,
      directCostCents: 80_00,
    });
  });

  it("derives rate-based native cents with decimal arithmetic", () => {
    const timeEntry = nativeTimeEntry({
      hours: decimal(0.29),
      billRateCents: 50,
      costRateCents: 50,
      billAmountCents: null,
      costAmountCents: null,
    });

    const health = calculateNativePracticeProjectHealth({
      project: nativeProject(),
      timeEntries: [timeEntry],
      expenses: [],
    });

    expect(health.usedBudgetCents).toBe(15);
    expect(health.directCostCents).toBe(15);
    expect(previewSlicingPieContributionFromTimeEntry(timeEntry)).toMatchObject({
      marketValueCents: 15,
      slices: 30,
    });
  });

  it("rejects ledger rows that are not normalized to the native project currency", () => {
    try {
      calculateNativePracticeProjectHealth({
        project: nativeProject({ currency: "USD" }),
        timeEntries: [
          nativeTimeEntry({ billCurrency: "EUR", costCurrency: "USD" }),
        ],
        expenses: [],
      });
      throw new Error("Expected mixed time entry currencies to be rejected.");
    } catch (error) {
      expect(error).toMatchObject({ code: "MIXED_CURRENCY" });
    }

    try {
      calculateNativePracticeProjectHealth({
        project: nativeProject({ currency: "USD" }),
        timeEntries: [
          nativeTimeEntry({
            functionalCurrency: "USD",
            billCurrency: "EUR",
            costCurrency: "USD",
            billAmountCents: null,
            costAmountCents: null,
          }),
        ],
        expenses: [],
      });
      throw new Error("Expected rate-derived time entry amounts to use bill and cost currencies.");
    } catch (error) {
      expect(error).toMatchObject({ code: "MIXED_CURRENCY" });
    }

    expect(calculateNativePracticeProjectHealth({
      project: nativeProject({ currency: "USD" }),
      timeEntries: [
        nativeTimeEntry({
          functionalCurrency: "USD",
          billCurrency: "EUR",
          costCurrency: "EUR",
          billAmountCents: 100_00,
          costAmountCents: 80_00,
        }),
      ],
      expenses: [],
    })).toMatchObject({
      usedBudgetCents: 100_00,
      directCostCents: 80_00,
    });

    try {
      calculateNativePracticeProjectHealth({
        project: nativeProject({ currency: "USD" }),
        timeEntries: [],
        expenses: [
          nativeExpense({ currency: "EUR" }),
        ],
      });
      throw new Error("Expected mixed expense currencies to be rejected.");
    } catch (error) {
      expect(error).toMatchObject({ code: "MIXED_CURRENCY" });
    }

    try {
      calculateNativePracticeProjectHealth({
        project: nativeProject({ currency: "USD" }),
        timeEntries: [],
        expenses: [
          nativeExpense({ currency: "EUR", functionalCurrency: "USD", amountFunctionalCents: null }),
        ],
      });
      throw new Error("Expected expenses without functional amounts to use their source currency.");
    } catch (error) {
      expect(error).toMatchObject({ code: "MIXED_CURRENCY" });
    }

    try {
      calculateNativePracticeProjectHealth({
        project: nativeProject({ currency: "USD" }),
        timeEntries: [],
        expenses: [
          nativeExpense({ currency: "EUR", amountFunctionalCents: 12_345, functionalCurrency: null }),
        ],
      });
      throw new Error("Expected expenses without functional currency labels to use their source currency.");
    } catch (error) {
      expect(error).toMatchObject({ code: "MIXED_CURRENCY" });
    }
  });

  it("rejects mixed currencies in native consultant financial totals", () => {
    try {
      calculateNativePracticeConsultantUtilization({
        consultant: nativeConsultant(),
        timeEntries: [
          nativeTimeEntry({ billCurrency: "USD", costCurrency: "USD" }),
          nativeTimeEntry({ id: "eur-time", billCurrency: "EUR", costCurrency: "EUR" }),
        ],
        expenses: [],
      });
      throw new Error("Expected mixed consultant currencies to be rejected.");
    } catch (error) {
      expect(error).toMatchObject({ code: "MIXED_CURRENCY" });
    }
  });

  it("rejects unknown currencies in native consultant financial totals", () => {
    try {
      calculateNativePracticeConsultantUtilization({
        consultant: nativeConsultant(),
        timeEntries: [
          nativeTimeEntry({
            currency: " ",
            billCurrency: " ",
            costCurrency: " ",
            billAmountCents: 100_00,
            costAmountCents: 80_00,
          }),
        ],
        expenses: [],
      });
      throw new Error("Expected unknown consultant time currencies to be rejected.");
    } catch (error) {
      expect(error).toMatchObject({ code: "MIXED_CURRENCY" });
    }

    try {
      calculateNativePracticeConsultantUtilization({
        consultant: nativeConsultant(),
        timeEntries: [],
        expenses: [
          nativeExpense({ currency: " ", amountCents: 12_00 }),
        ],
      });
      throw new Error("Expected unknown consultant expense currencies to be rejected.");
    } catch (error) {
      expect(error).toMatchObject({ code: "MIXED_CURRENCY" });
    }
  });

  it("rejects negative native time entry hours before calculating utilization", () => {
    try {
      calculateNativePracticeConsultantUtilization({
        consultant: nativeConsultant(),
        timeEntries: [
          nativeTimeEntry({
            hours: decimal(-1),
            billAmountCents: 100_00,
            costAmountCents: 80_00,
          }),
        ],
        expenses: [],
      });
      throw new Error("Expected negative consultant time entry hours to be rejected.");
    } catch (error) {
      expect(error).toMatchObject({ code: "INVALID_INPUT" });
    }
  });

  it("rejects invalid native consultant capacity inputs", () => {
    for (const capacityHoursPerWeek of [-40, Number.POSITIVE_INFINITY]) {
      try {
        calculateNativePracticeConsultantUtilization({
          consultant: nativeConsultant(),
          capacityHoursPerWeek,
          timeEntries: [nativeTimeEntry()],
          expenses: [],
        });
        throw new Error("Expected invalid consultant capacity to be rejected.");
      } catch (error) {
        expect(error).toMatchObject({ code: "INVALID_INPUT" });
      }
    }
  });

  it("returns the normalized currency for native consultant financial totals", () => {
    const utilization = calculateNativePracticeConsultantUtilization({
      consultant: nativeConsultant(),
      timeEntries: [nativeTimeEntry({
        currency: "eur",
        billCurrency: "EUR",
        costCurrency: "EUR",
        billAmountCents: 100_00,
        costAmountCents: 80_00,
      })],
      expenses: [nativeExpense({ amountCents: 12_00, currency: "EUR" })],
    });

    expect(utilization).toMatchObject({
      currency: "EUR",
      billedCents: 100_00,
      costCents: 80_00,
      expenseCents: 12_00,
    });
  });

  it("calculates native consultant utilization from posted time and expenses", () => {
    const utilization = calculateNativePracticeConsultantUtilization({
      consultant: nativeConsultant(),
      now: new Date("2026-06-30T00:00:00.000Z"),
      recentWindowWeeks: 4,
      capacityHoursPerWeek: 40,
      timeEntries: [
        nativeTimeEntry({ hours: decimal(12), billRateCents: 20_000, costRateCents: 10_000 }),
        nativeTimeEntry({ id: "old", workedOn: new Date("2026-01-01T00:00:00.000Z"), weekEndingOn: new Date("2026-01-05T00:00:00.000Z"), hours: decimal(4) }),
      ],
      expenses: [nativeExpense({ amountFunctionalCents: 12_345, functionalCurrency: "USD" })],
    });

    expect(utilization).toMatchObject({
      consultantId: "consultant-1",
      projectIds: ["project-1"],
      recentHours: 12,
      averageWeeklyHours: 3,
      utilizationBps: 750,
      currency: "USD",
      billedCents: 300_000,
      costCents: 152_000,
      expenseCents: 12_345,
    });
  });

  it("calculates native consultant utilization from unrounded weekly hours", () => {
    const utilization = calculateNativePracticeConsultantUtilization({
      consultant: nativeConsultant(),
      now: new Date("2026-06-30T00:00:00.000Z"),
      recentWindowWeeks: 4,
      capacityHoursPerWeek: 40,
      timeEntries: [nativeTimeEntry({
        hours: decimal(0.1),
        billAmountCents: 0,
        costAmountCents: 0,
      })],
      expenses: [],
    });

    expect(utilization.averageWeeklyHours).toBe(0);
    expect(utilization.utilizationBps).toBe(6);
  });

  it("previews Slicing Pie contribution data from native time and expense rows", () => {
    expect(previewSlicingPieContributionFromTimeEntry(nativeTimeEntry({
      costAmountCents: 40_000,
      currency: "usd",
      paidAmountCents: 15_000,
      paymentBatchId: "batch-1",
    }))).toMatchObject({
      sourceType: "TIME_ENTRY",
      sourceId: "time-1",
      currency: "USD",
      marketValueCents: 40_000,
      paidAmountCents: 15_000,
      unpaidAmountCents: 25_000,
      multiplier: SLICING_PIE_TIME_MULTIPLIER,
      slices: 50_000,
      paymentBatchId: "batch-1",
    });

    expect(previewSlicingPieContributionFromExpense(nativeExpense({
      amountFunctionalCents: 12_000,
      functionalCurrency: "USD",
      paymentBatchId: "mixed-batch",
    }), { paidAmountCents: 5_000 })).toMatchObject({
      sourceType: "EXPENSE",
      sourceId: "expense-1",
      marketValueCents: 12_000,
      paidAmountCents: 5_000,
      unpaidAmountCents: 7_000,
      multiplier: SLICING_PIE_EXPENSE_MULTIPLIER,
      slices: 28_000,
      paymentBatchId: "mixed-batch",
    });
  });

  it("rejects non-USD native Slicing Pie contribution previews until conversion is supported", () => {
    try {
      previewSlicingPieContributionFromTimeEntry(nativeTimeEntry({
        currency: " ",
        costCurrency: null,
        functionalCurrency: null,
        costAmountCents: null,
      }));
      throw new Error("Expected unknown time contribution preview currencies to be rejected.");
    } catch (error) {
      expect(error).toMatchObject({ code: "MIXED_CURRENCY" });
    }

    try {
      previewSlicingPieContributionFromTimeEntry(nativeTimeEntry({
        currency: "EUR",
        costCurrency: "eur",
        functionalCurrency: "USD",
        costAmountCents: null,
      }));
      throw new Error("Expected non-USD time contribution previews to be rejected.");
    } catch (error) {
      expect(error).toMatchObject({ code: "MIXED_CURRENCY" });
    }

    try {
      previewSlicingPieContributionFromExpense(nativeExpense({
        amountCents: 12_000,
        amountFunctionalCents: null,
        currency: "EUR",
        functionalCurrency: "USD",
      }));
      throw new Error("Expected non-USD expense contribution previews to be rejected.");
    } catch (error) {
      expect(error).toMatchObject({ code: "MIXED_CURRENCY" });
    }
  });

  it("rejects reversed native rows when previewing Slicing Pie contributions", () => {
    try {
      previewSlicingPieContributionFromTimeEntry(nativeTimeEntry({ status: "REVERSED" }));
      throw new Error("Expected reversed time entry to be rejected.");
    } catch (error) {
      expect(error).toMatchObject({ code: "INVALID_STATE" });
    }
    try {
      previewSlicingPieContributionFromExpense(nativeExpense({ status: "REVERSED" }));
      throw new Error("Expected reversed expense to be rejected.");
    } catch (error) {
      expect(error).toMatchObject({ code: "INVALID_STATE" });
    }
  });

  it("rejects negative market values when previewing Slicing Pie contributions", () => {
    try {
      previewSlicingPieContributionFromTimeEntry(nativeTimeEntry({ costAmountCents: -100 }));
      throw new Error("Expected negative time contribution value to be rejected.");
    } catch (error) {
      expect(error).toMatchObject({ code: "INVALID_INPUT" });
    }
    try {
      previewSlicingPieContributionFromExpense(nativeExpense({ amountFunctionalCents: -100, functionalCurrency: "USD" }));
      throw new Error("Expected negative expense contribution value to be rejected.");
    } catch (error) {
      expect(error).toMatchObject({ code: "INVALID_INPUT" });
    }
    try {
      previewSlicingPieContributionFromTimeEntry(nativeTimeEntry({ costAmountCents: Number.POSITIVE_INFINITY }));
      throw new Error("Expected non-finite time contribution value to be rejected.");
    } catch (error) {
      expect(error).toMatchObject({ code: "INVALID_INPUT" });
    }
  });

  it("rejects invalid paid amounts when previewing Slicing Pie contributions", () => {
    for (const paidAmountCents of [12.5, Number.POSITIVE_INFINITY, -1]) {
      try {
        previewSlicingPieContributionFromExpense(nativeExpense(), { paidAmountCents });
        throw new Error("Expected invalid paid amount to be rejected.");
      } catch (error) {
        expect(error).toMatchObject({ code: "INVALID_INPUT" });
      }
    }
  });

  it("rejects unattributed expense contribution previews", () => {
    try {
      previewSlicingPieContributionFromExpense(nativeExpense({ consultantId: null }));
      throw new Error("Expected unattributed expenses to be rejected.");
    } catch (error) {
      expect(error).toMatchObject({ code: "INVALID_INPUT" });
    }
  });

  it("requires paid allocation overrides for batched expense contribution previews", () => {
    try {
      previewSlicingPieContributionFromExpense(nativeExpense({ paymentBatchId: "batch-1" }));
      throw new Error("Expected batched expenses without paid allocations to be rejected.");
    } catch (error) {
      expect(error).toMatchObject({ code: "INVALID_INPUT" });
    }
  });

  it("requires paid allocation data for batched time contribution previews", () => {
    try {
      previewSlicingPieContributionFromTimeEntry(nativeTimeEntry({ paymentBatchId: "batch-1", paidAmountCents: null }));
      throw new Error("Expected batched time without paid allocation to be rejected.");
    } catch (error) {
      expect(error).toMatchObject({ code: "INVALID_INPUT" });
    }
  });

  it("calculates contribution values and fixed Slicing Pie multipliers", () => {
    const timeAmount = calculatePracticeContributionAmount({
      type: "TIME",
      hoursTenths: 25,
      rateCents: 12_000,
    });
    expect(timeAmount).toMatchObject({
      amountCents: 30_000,
      hoursTenths: 25,
      rateCents: 12_000,
    });
    expect(calculatePracticeContributionSlices({
      type: "TIME",
      paymentChoice: "SLICING_PIE",
      amountCents: timeAmount.amountCents,
    })).toEqual({
      sliceMultiplier: SLICING_PIE_TIME_MULTIPLIER,
      slices: 60_000,
      cashStatus: "NOT_APPLICABLE",
    });

    const expenseAmount = calculatePracticeContributionAmount({
      type: "EXPENSE",
      amountCents: 12_345,
    });
    expect(expenseAmount).toMatchObject({
      amountCents: 12_345,
      hoursTenths: null,
      rateCents: null,
    });
    expect(calculatePracticeContributionSlices({
      type: "EXPENSE",
      paymentChoice: "SLICING_PIE",
      amountCents: expenseAmount.amountCents,
    })).toEqual({
      sliceMultiplier: SLICING_PIE_EXPENSE_MULTIPLIER,
      slices: 49_380,
      cashStatus: "NOT_APPLICABLE",
    });

    expect(calculatePracticeContributionSlices({
      type: "EXPENSE",
      paymentChoice: "CASH",
      amountCents: 12_345,
    })).toEqual({
      sliceMultiplier: 0,
      slices: 0,
      cashStatus: "REQUESTED",
    });
  });
});

describe("practice-finance I/O", () => {
  const actor = {
    kind: "user" as const,
    user: {
      id: "user-1",
      email: "user@example.com",
      displayName: "User",
      globalRole: "USER" as const,
    },
  };

  function contributionEntry(overrides: Record<string, unknown> = {}) {
    return {
      id: "contribution-1",
      workspaceId: "workspace-1",
      projectId: "project-1",
      contributorUserId: "user-1",
      type: "TIME",
      paymentChoice: "SLICING_PIE",
      cashStatus: "NOT_APPLICABLE",
      description: "Contribution",
      occurredAt: new Date("2026-06-18T00:00:00.000Z"),
      hoursTenths: 10,
      rateCents: 10_000,
      amountCents: 10_000,
      currency: "USD",
      receiptUrl: null,
      sliceMultiplier: 2,
      slices: 20_000,
      paidAt: null,
      paidByUserId: null,
      createdAt: new Date("2026-06-18T00:00:00.000Z"),
      updatedAt: new Date("2026-06-18T00:00:00.000Z"),
      contributor: {
        id: "user-1",
        displayName: "User",
        email: "user@example.com",
      },
      paidBy: null,
      project: {
        id: "project-1",
        code: "DPRJ-001",
        name: "Demo project",
        clientName: "Example",
      },
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.$queryRaw.mockResolvedValue([]);
    requireWorkspaceMembershipMock.mockResolvedValue({ id: "member-1", role: "ADMIN" });
    prismaMock.workspaceFeatureFlag.findUnique.mockResolvedValue({ enabled: true, config: null });
    prismaMock.member.findFirst.mockResolvedValue({ id: "member-1" });
    prismaMock.user.findMany.mockResolvedValue([]);
    prismaMock.practiceContributionEntry.create.mockResolvedValue({
      id: "contribution-1",
      workspaceId: "workspace-1",
      projectId: "project-1",
      contributorUserId: "user-1",
      type: "TIME",
      paymentChoice: "SLICING_PIE",
      cashStatus: "NOT_APPLICABLE",
      description: "Contribution",
      occurredAt: new Date("2026-06-18T00:00:00.000Z"),
      hoursTenths: 10,
      rateCents: 10_000,
      amountCents: 10_000,
      currency: "USD",
      receiptUrl: null,
      sliceMultiplier: 2,
      slices: 20_000,
      paidAt: null,
      paidByUserId: null,
      createdAt: new Date("2026-06-18T00:00:00.000Z"),
      updatedAt: new Date("2026-06-18T00:00:00.000Z"),
    });
    prismaMock.practiceContributionEntry.findMany.mockResolvedValue([]);
    prismaMock.practiceContributionEntry.findUnique.mockResolvedValue(null);
    prismaMock.practiceContributionEntry.groupBy.mockResolvedValue([]);
    prismaMock.practiceContributionEntry.updateMany.mockResolvedValue({ count: 0 });
    prismaMock.practiceClient.create.mockResolvedValue({ id: "client-1" });
    prismaMock.practiceClient.findFirst.mockResolvedValue(null);
    prismaMock.practiceClient.findUnique.mockResolvedValue(null);
    prismaMock.practiceClient.upsert.mockResolvedValue({ id: "client-1" });
    prismaMock.practiceConsultant.create.mockResolvedValue({ id: "consultant-1" });
    prismaMock.practiceConsultant.findFirst.mockResolvedValue(null);
    prismaMock.practiceConsultant.findMany.mockResolvedValue([]);
    prismaMock.practiceExpense.create.mockResolvedValue({
      id: "expense-1",
      workspaceId: "workspace-1",
      clientId: "client-1",
      billingCodeId: null,
      projectId: "project-1",
      projectLineId: null,
      consultantId: null,
      sourceDocumentId: null,
      paymentBatchId: null,
      spentOn: new Date("2026-06-18T00:00:00.000Z"),
      vendor: null,
      category: "Travel",
      businessPurpose: "Client meeting",
      amountCents: 12_345,
      currency: "USD",
      amountFunctionalCents: 12_345,
      functionalCurrency: "USD",
      billable: true,
      status: "POSTED",
      sourceSatelliteId: null,
      idempotencyKey: null,
      createdAt: new Date("2026-06-18T00:00:00.000Z"),
      updatedAt: new Date("2026-06-18T00:00:00.000Z"),
    });
    prismaMock.practiceExpense.findMany.mockResolvedValue([]);
    prismaMock.practiceExpense.findUnique.mockResolvedValue(null);
    prismaMock.practiceTimeEntry.create.mockResolvedValue({
      id: "time-1",
      workspaceId: "workspace-1",
      clientId: "client-1",
      billingCodeId: null,
      projectId: "project-1",
      projectLineId: null,
      consultantId: "consultant-1",
      sourceDocumentId: null,
      paymentBatchId: null,
      workedOn: new Date("2026-06-18T00:00:00.000Z"),
      weekEndingOn: new Date("2026-06-21T00:00:00.000Z"),
      hours: decimal(2.5),
      assignmentType: "CONSULTING",
      currency: "USD",
      billCurrency: "USD",
      costCurrency: "USD",
      functionalCurrency: "USD",
      billRateCents: 12_000,
      costRateCents: 8_000,
      billAmountCents: 30_000,
      costAmountCents: 20_000,
      paidAmountCents: null,
      status: "POSTED",
      sourceSatelliteId: null,
      idempotencyKey: null,
      createdAt: new Date("2026-06-18T00:00:00.000Z"),
      updatedAt: new Date("2026-06-18T00:00:00.000Z"),
    });
    prismaMock.practiceTimeEntry.findMany.mockResolvedValue([]);
    prismaMock.practiceTimeEntry.findUnique.mockResolvedValue(null);
    prismaMock.practiceContributionEntry.update.mockResolvedValue({
      id: "contribution-1",
      workspaceId: "workspace-1",
      projectId: "project-1",
      contributorUserId: "user-1",
      type: "EXPENSE",
      paymentChoice: "CASH",
      cashStatus: "PAID",
      description: "Cash reimbursement",
      occurredAt: new Date("2026-06-18T00:00:00.000Z"),
      hoursTenths: null,
      rateCents: null,
      amountCents: 4_400,
      currency: "USD",
      receiptUrl: null,
      sliceMultiplier: 0,
      slices: 0,
      paidAt: new Date("2026-06-19T00:00:00.000Z"),
      paidByUserId: "user-1",
      createdAt: new Date("2026-06-18T00:00:00.000Z"),
      updatedAt: new Date("2026-06-19T00:00:00.000Z"),
    });
    prismaMock.crmAccount.findUnique.mockResolvedValue({
      id: "account-1",
      workspaceId: "workspace-1",
      archivedAt: null,
    });
    prismaMock.crmDeal.findUnique.mockResolvedValue({
      id: "deal-1",
      workspaceId: "workspace-1",
      accountId: "account-1",
      contactId: "contact-1",
      title: "Pilot rollout",
      stage: "CLOSED_WON",
      valueCents: 25_000_00,
      archivedAt: null,
      account: {
        id: "account-1",
        workspaceId: "workspace-1",
        name: "Example",
        slug: "example",
      },
      contact: {
        id: "contact-1",
        workspaceId: "workspace-1",
        email: "buyer@example.test",
        company: "Example",
      },
    });
    prismaMock.practiceProject.create.mockResolvedValue({
      id: "project-1",
      workspaceId: "workspace-1",
      crmAccountId: "account-1",
      crmDealId: "deal-1",
      code: "EXAMPLE-DEAL-1",
      name: "Pilot rollout",
      clientName: "Example",
      status: "ACTIVE",
      poValueCents: 25_000_00,
      serviceBudgetCents: 0,
      expenseBudgetCents: 0,
      usedCents: 0,
      weeklyBurnCents: 0,
      targetMarginBps: null,
      currentMarginBps: null,
      sourceSatelliteId: null,
      createdAt: new Date("2026-06-18T00:00:00.000Z"),
      updatedAt: new Date("2026-06-18T00:00:00.000Z"),
    });
    prismaMock.practiceProject.update.mockResolvedValue({
      id: "project-1",
      workspaceId: "workspace-1",
      crmAccountId: null,
      crmDealId: null,
      code: "DPRJ-001",
      name: "Updated project",
      clientName: "Example",
      status: "ON_HOLD",
      poValueCents: 40_000_00,
      serviceBudgetCents: 25_000_00,
      expenseBudgetCents: 5_000_00,
      usedCents: 12_000_00,
      weeklyBurnCents: 2_000_00,
      targetMarginBps: 5500,
      currentMarginBps: 5200,
      sourceSatelliteId: null,
      createdAt: new Date("2026-06-18T00:00:00.000Z"),
      updatedAt: new Date("2026-06-19T00:00:00.000Z"),
    });
    prismaMock.practiceProject.findUnique.mockResolvedValue(null);
    prismaMock.practiceProject.findMany.mockResolvedValue([]);
  });

  it("lists practice projects with a bounded default page", async () => {
    await listPracticeProjects(actor, "workspace-1");

    expect(requireWorkspaceMembershipMock).toHaveBeenCalledWith({ actor, workspaceId: "workspace-1" });
    expect(prismaMock.practiceProject.findMany).toHaveBeenCalledWith({
      where: { workspaceId: "workspace-1" },
      orderBy: [{ status: "asc" }, { code: "asc" }, { id: "asc" }],
      take: 100,
    });
  });

  it("clamps practice project take and applies a cursor", async () => {
    await listPracticeProjects(actor, "workspace-1", { take: 500, cursor: " project-10 " });

    expect(prismaMock.practiceProject.findMany).toHaveBeenCalledWith({
      where: { workspaceId: "workspace-1" },
      orderBy: [{ status: "asc" }, { code: "asc" }, { id: "asc" }],
      take: 200,
      cursor: { id: "project-10" },
      skip: 1,
    });
  });

  it("builds the dashboard from the bounded project list", async () => {
    prismaMock.practiceProject.findMany.mockResolvedValueOnce([
      project({ id: "active-1", poValueCents: 10_000_00, usedCents: 1_000_00 }),
    ]);

    const dashboard = await getPracticeFinanceDashboard(actor, "workspace-1");

    expect(dashboard.projects).toHaveLength(1);
    expect(dashboard.summary.activeProjects).toBe(1);
    expect(prismaMock.practiceProject.findMany).toHaveBeenCalledWith(expect.objectContaining({
      take: 100,
    }));
  });

  it("lists native project health through a bounded project page and scoped ledger rows", async () => {
    prismaMock.practiceProject.findMany.mockResolvedValueOnce([
      nativeProject(),
    ]);
    prismaMock.$queryRaw
      .mockResolvedValueOnce([{
        projectId: "project-1",
        timeRevenueCents: 150_000n,
        timeCostCents: 80_000n,
        recentTimeRevenueCents: 150_000n,
        recentTimeCostCents: 80_000n,
        invalidHoursRows: 0n,
        invalidCurrencyRows: 0n,
      }])
      .mockResolvedValueOnce([{
        projectId: "project-1",
        billableExpenseCents: 40_000n,
        directExpenseCents: 40_000n,
        recentBillableExpenseCents: 40_000n,
        recentDirectExpenseCents: 40_000n,
        invalidCurrencyRows: 0n,
      }]);

    const health = await listNativePracticeProjectHealth(actor, "workspace-1", {
      take: 5,
      cursor: " project-0 ",
      now: new Date("2026-06-30T00:00:00.000Z"),
    });

    expect(health[0]).toMatchObject({
      projectId: "project-1",
      usedBudgetCents: 190_000,
      directCostCents: 120_000,
    });
    expect(prismaMock.practiceProject.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { workspaceId: "workspace-1" },
      take: 5,
      cursor: { id: "project-0" },
      skip: 1,
    }));
    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(2);
    expect(prismaMock.practiceTimeEntry.findMany).not.toHaveBeenCalled();
    expect(prismaMock.practiceExpense.findMany).not.toHaveBeenCalled();
    expect(prismaSqlText(prismaMock.$queryRaw.mock.calls[0]?.[0])).toContain(
      "NULLIF(BTRIM(p.\"currency\"), '') IS NULL",
    );
    expect(prismaSqlText(prismaMock.$queryRaw.mock.calls[0]?.[0])).toContain(
      "t.\"hours\" < 0",
    );
    expect(prismaSqlText(prismaMock.$queryRaw.mock.calls[1]?.[0])).toContain(
      "NULLIF(BTRIM(p.\"currency\"), '') IS NULL",
    );
  });

  it("rejects native project health rows with unnormalized ledger currencies", async () => {
    prismaMock.practiceProject.findMany.mockResolvedValueOnce([
      nativeProject(),
    ]);
    prismaMock.$queryRaw
      .mockResolvedValueOnce([{
        projectId: "project-1",
        timeRevenueCents: 150_000n,
        timeCostCents: 80_000n,
        recentTimeRevenueCents: 150_000n,
        recentTimeCostCents: 80_000n,
        invalidHoursRows: 0n,
        invalidCurrencyRows: 1n,
      }])
      .mockResolvedValueOnce([]);

    try {
      await listNativePracticeProjectHealth(actor, "workspace-1");
      throw new Error("Expected native project health to reject mixed ledger currencies.");
    } catch (error) {
      expect(error).toMatchObject({ code: "MIXED_CURRENCY" });
    }
  });

  it("rejects native project health rows with negative SQL time entry hours", async () => {
    prismaMock.practiceProject.findMany.mockResolvedValueOnce([
      nativeProject(),
    ]);
    prismaMock.$queryRaw
      .mockResolvedValueOnce([{
        projectId: "project-1",
        timeRevenueCents: -150_000n,
        timeCostCents: -80_000n,
        recentTimeRevenueCents: -150_000n,
        recentTimeCostCents: -80_000n,
        invalidHoursRows: 1n,
        invalidCurrencyRows: 0n,
      }])
      .mockResolvedValueOnce([]);

    try {
      await listNativePracticeProjectHealth(actor, "workspace-1");
      throw new Error("Expected native project health to reject negative SQL time entry hours.");
    } catch (error) {
      expect(error).toMatchObject({ code: "INVALID_INPUT" });
    }
  });

  it("builds the native finance dashboard from project health", async () => {
    prismaMock.practiceProject.findMany.mockResolvedValueOnce([
      nativeProject({ targetMarginBps: null }),
    ]);

    const dashboard = await getNativePracticeFinanceDashboard(actor, "workspace-1", {
      now: new Date("2026-06-30T00:00:00.000Z"),
    });

    expect(dashboard.summary.activeProjects).toBe(1);
    expect(dashboard.attention).toHaveLength(1);
    expect(dashboard.attention[0]).toMatchObject({ issue: "setup" });
    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(2);
  });

  it("builds the native finance dashboard from every project health page", async () => {
    const firstPage = Array.from({ length: 200 }, (_, index) => nativeProject({
      id: `project-${String(index + 1).padStart(3, "0")}`,
      code: `DPRJ-${String(index + 1).padStart(3, "0")}`,
    }));
    const secondPage = [
      nativeProject({
        id: "project-201",
        code: "DPRJ-201",
      }),
    ];
    prismaMock.practiceProject.findMany
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce(secondPage);

    const dashboard = await getNativePracticeFinanceDashboard(actor, "workspace-1", {
      take: 5,
      cursor: "ignored-for-dashboard",
      now: new Date("2026-06-30T00:00:00.000Z"),
    });

    expect(dashboard.projectHealth).toHaveLength(201);
    expect(dashboard.summary.activeProjects).toBe(201);
    expect(prismaMock.practiceProject.findMany).toHaveBeenCalledTimes(2);
    expect(prismaMock.practiceProject.findMany).toHaveBeenNthCalledWith(1, expect.objectContaining({
      take: 200,
    }));
    expect(prismaMock.practiceProject.findMany.mock.calls[0]?.[0]).not.toHaveProperty("cursor");
    expect(prismaMock.practiceProject.findMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
      take: 200,
      cursor: { id: "project-200" },
      skip: 1,
    }));
    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(4);
  });

  it("lists Practice Ledger contribution entries with contributor and project evidence", async () => {
    prismaMock.practiceContributionEntry.findMany.mockResolvedValueOnce([contributionEntry()]);

    const entries = await listPracticeContributionEntries(actor, "workspace-1", {
      take: 25,
      cursor: " contribution-0 ",
    });

    expect(entries).toHaveLength(1);
    expect(requireWorkspaceMembershipMock).toHaveBeenCalledWith({ actor, workspaceId: "workspace-1" });
    expect(prismaMock.practiceContributionEntry.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { workspaceId: "workspace-1" },
      take: 26,
      cursor: { id: "contribution-0" },
      skip: 1,
    }));
  });

  it("lists requested cash payables through a dedicated paginated query", async () => {
    prismaMock.practiceContributionEntry.findMany.mockResolvedValueOnce([
      contributionEntry({ id: "payable-1", paymentChoice: "CASH", cashStatus: "REQUESTED" }),
      contributionEntry({ id: "payable-2", paymentChoice: "CASH", cashStatus: "REQUESTED" }),
    ]);

    const page = await listRequestedPracticeContributionPayables(actor, "workspace-1", {
      take: 1,
    });

    expect(page.entries).toHaveLength(1);
    expect(page.nextCursor).toBe("payable-1");
    expect(prismaMock.practiceContributionEntry.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        workspaceId: "workspace-1",
        paymentChoice: "CASH",
        cashStatus: "REQUESTED",
      },
      take: 2,
    }));
  });

  it("creates Slicing Pie time entries as resolved slices with the fixed 2x multiplier", async () => {
    prismaMock.practiceProject.findUnique.mockResolvedValueOnce({
      id: "project-1",
      workspaceId: "workspace-1",
    });

    await createPracticeContributionEntry(actor, "workspace-1", {
      projectId: " project-1 ",
      type: "TIME",
      paymentChoice: "SLICING_PIE",
      description: " Architecture session ",
      occurredAt: new Date("2026-06-18T00:00:00.000Z"),
      hoursTenths: 25,
      rateCents: 12_000,
    });

    expect(prismaMock.member.findFirst).toHaveBeenCalledWith({
      where: {
        workspaceId: "workspace-1",
        userId: "user-1",
        isActive: true,
        mergedAt: null,
      },
      select: { id: true },
    });
    expect(prismaMock.practiceContributionEntry.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: "workspace-1",
        projectId: "project-1",
        contributorUserId: "user-1",
        type: "TIME",
        paymentChoice: "SLICING_PIE",
        cashStatus: "NOT_APPLICABLE",
        description: "Architecture session",
        hoursTenths: 25,
        rateCents: 12_000,
        amountCents: 30_000,
        sliceMultiplier: 2,
        slices: 60_000,
      }),
    });
  });

  it("creates cash expense entries as requested payables without slices", async () => {
    prismaMock.practiceProject.findUnique.mockResolvedValueOnce({
      id: "project-1",
      workspaceId: "workspace-1",
    });

    await createPracticeContributionEntry(actor, "workspace-1", {
      projectId: "project-1",
      type: "EXPENSE",
      paymentChoice: "CASH",
      description: "Client travel",
      occurredAt: new Date("2026-06-18T00:00:00.000Z"),
      amountCents: 4_400,
      currency: " usd ",
      receiptUrl: " https://receipts.example/1 ",
    });

    expect(prismaMock.practiceContributionEntry.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: "EXPENSE",
        paymentChoice: "CASH",
        cashStatus: "REQUESTED",
        amountCents: 4_400,
        currency: "USD",
        receiptUrl: "https://receipts.example/1",
        sliceMultiplier: 0,
        slices: 0,
      }),
    });
  });

  it("rejects non-USD contribution currencies until conversion is supported", async () => {
    prismaMock.practiceProject.findUnique.mockResolvedValueOnce({
      id: "project-1",
      workspaceId: "workspace-1",
    });

    await expect(createPracticeContributionEntry(actor, "workspace-1", {
      projectId: "project-1",
      type: "EXPENSE",
      paymentChoice: "SLICING_PIE",
      description: "Client travel",
      occurredAt: new Date("2026-06-18T00:00:00.000Z"),
      amountCents: 4_400,
      currency: "EUR",
    })).rejects.toMatchObject({ status: 400, code: "INVALID_INPUT" });
    expect(prismaMock.practiceContributionEntry.create).not.toHaveBeenCalled();
  });

  it("marks cash contribution entries paid through finance-manager access", async () => {
    prismaMock.practiceContributionEntry.findUnique
      .mockResolvedValueOnce({
        id: "contribution-1",
        workspaceId: "workspace-1",
        paymentChoice: "CASH",
        cashStatus: "REQUESTED",
      })
      .mockResolvedValueOnce(contributionEntry({
        id: "contribution-1",
        paymentChoice: "CASH",
        cashStatus: "PAID",
        sliceMultiplier: 0,
        slices: 0,
      }));
    prismaMock.practiceContributionEntry.updateMany.mockResolvedValueOnce({ count: 1 });

    await markPracticeContributionEntryPaid(actor, "workspace-1", " contribution-1 ");

    expect(requireWorkspaceMembershipMock).toHaveBeenCalledWith({
      actor,
      workspaceId: "workspace-1",
      allowedRoles: expect.arrayContaining(["FINANCE_STEWARD", "ADMIN"]),
    });
    expect(prismaMock.practiceContributionEntry.updateMany).toHaveBeenCalledWith({
      where: {
        id: "contribution-1",
        workspaceId: "workspace-1",
        paymentChoice: "CASH",
        cashStatus: "REQUESTED",
      },
      data: {
        cashStatus: "PAID",
        paidAt: expect.any(Date),
        paidByUserId: "user-1",
      },
    });
  });

  it("rejects stale cash payable payment attempts after a concurrent update", async () => {
    prismaMock.practiceContributionEntry.findUnique.mockResolvedValueOnce({
      id: "contribution-1",
      workspaceId: "workspace-1",
      paymentChoice: "CASH",
      cashStatus: "REQUESTED",
    });
    prismaMock.practiceContributionEntry.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(markPracticeContributionEntryPaid(actor, "workspace-1", " contribution-1 "))
      .rejects.toMatchObject({ status: 409, code: "CONFLICT" });
  });

  it("rejects marking Slicing Pie contribution entries paid", async () => {
    prismaMock.practiceContributionEntry.findUnique.mockResolvedValueOnce({
      id: "contribution-1",
      workspaceId: "workspace-1",
      paymentChoice: "SLICING_PIE",
      cashStatus: "NOT_APPLICABLE",
    });

    await expect(markPracticeContributionEntryPaid(actor, "workspace-1", "contribution-1"))
      .rejects.toMatchObject({ status: 400, code: "INVALID_STATE" });
    expect(prismaMock.practiceContributionEntry.updateMany).not.toHaveBeenCalled();
  });

  it("derives Slicing Pie ownership and cash totals from contribution entries", async () => {
    prismaMock.practiceContributionEntry.findMany.mockResolvedValueOnce([
      contributionEntry({
        id: "time-1",
        contributorUserId: "user-1",
        type: "TIME",
        paymentChoice: "SLICING_PIE",
        amountCents: 10_000,
        sliceMultiplier: 2,
        slices: 20_000,
        contributor: { id: "user-1", displayName: "Alice", email: "alice@example.com" },
      }),
      contributionEntry({
        id: "expense-1",
        contributorUserId: "user-2",
        type: "EXPENSE",
        paymentChoice: "SLICING_PIE",
        amountCents: 5_000,
        sliceMultiplier: 4,
        slices: 20_000,
        contributor: { id: "user-2", displayName: "Bob", email: "bob@example.com" },
      }),
      contributionEntry({
        id: "cash-paid-1",
        contributorUserId: "user-1",
        type: "EXPENSE",
        paymentChoice: "CASH",
        cashStatus: "PAID",
        amountCents: 3_000,
        sliceMultiplier: 0,
        slices: 0,
        contributor: { id: "user-1", displayName: "Alice", email: "alice@example.com" },
      }),
      contributionEntry({
        id: "cash-requested-1",
        contributorUserId: "user-2",
        type: "EXPENSE",
        paymentChoice: "CASH",
        cashStatus: "REQUESTED",
        amountCents: 1_000,
        sliceMultiplier: 0,
        slices: 0,
        contributor: { id: "user-2", displayName: "Bob", email: "bob@example.com" },
      }),
    ]);
    prismaMock.practiceContributionEntry.groupBy.mockResolvedValueOnce([
      {
        contributorUserId: "user-1",
        type: "TIME",
        paymentChoice: "SLICING_PIE",
        cashStatus: "NOT_APPLICABLE",
        _sum: { amountCents: 10_000, slices: 20_000 },
      },
      {
        contributorUserId: "user-2",
        type: "EXPENSE",
        paymentChoice: "SLICING_PIE",
        cashStatus: "NOT_APPLICABLE",
        _sum: { amountCents: 5_000, slices: 20_000 },
      },
      {
        contributorUserId: "user-1",
        type: "EXPENSE",
        paymentChoice: "CASH",
        cashStatus: "PAID",
        _sum: { amountCents: 3_000, slices: 0 },
      },
      {
        contributorUserId: "user-2",
        type: "EXPENSE",
        paymentChoice: "CASH",
        cashStatus: "REQUESTED",
        _sum: { amountCents: 1_000, slices: 0 },
      },
    ]);
    prismaMock.user.findMany.mockResolvedValueOnce([
      { id: "user-1", displayName: "Alice", email: "alice@example.com" },
      { id: "user-2", displayName: "Bob", email: "bob@example.com" },
    ]);

    const summary = await getSlicingPieSummary(actor, "workspace-1");

    expect(summary.totalSlices).toBe(40_000);
    expect(summary.contributors).toEqual([
      expect.objectContaining({
        userId: "user-1",
        timeValueCents: 10_000,
        expenseValueCents: 0,
        cashPaidCents: 3_000,
        cashRequestedCents: 0,
        slices: 20_000,
        ownershipBps: 5000,
      }),
      expect.objectContaining({
        userId: "user-2",
        timeValueCents: 0,
        expenseValueCents: 5_000,
        cashPaidCents: 0,
        cashRequestedCents: 1_000,
        slices: 20_000,
        ownershipBps: 5000,
      }),
    ]);
  });

  it("returns CRM account-linked finance rollups from authoritative practice projects", async () => {
    prismaMock.practiceProject.findMany.mockResolvedValueOnce([
      {
        ...project({
          id: "project-1",
          poValueCents: 50_000_00,
          usedCents: 15_000_00,
          currentMarginBps: 6200,
        }),
        workspaceId: "workspace-1",
        crmAccountId: "account-1",
        crmDealId: "deal-1",
        clientId: "client-1",
        billingCodeId: null,
        code: "EXAMPLE-1",
        clientName: "Example",
        currency: "USD",
        weeklyBurnCents: 5_000_00,
        startsOn: null,
        endsOn: null,
        sourceSatelliteId: null,
        createdAt: new Date("2026-06-18T00:00:00.000Z"),
        updatedAt: new Date("2026-06-18T00:00:00.000Z"),
        crmDeal: {
          id: "deal-1",
          title: "Pilot rollout",
          stage: "CLOSED_WON",
          valueCents: 50_000_00,
          currency: "USD",
        },
      },
    ]);
    prismaMock.$queryRaw
      .mockResolvedValueOnce([{
        projectId: "project-1",
        timeRevenueCents: 150_000n,
        timeCostCents: 80_000n,
        recentTimeRevenueCents: 150_000n,
        recentTimeCostCents: 80_000n,
        invalidHoursRows: 0n,
        invalidCurrencyRows: 0n,
      }])
      .mockResolvedValueOnce([{
        projectId: "project-1",
        billableExpenseCents: 40_000n,
        directExpenseCents: 40_000n,
        recentBillableExpenseCents: 40_000n,
        recentDirectExpenseCents: 40_000n,
        invalidCurrencyRows: 0n,
      }]);

    const result = await getCrmAccountPracticeFinance(actor, {
      workspaceId: "workspace-1",
      accountId: "account-1",
    });

    expect(requireWorkspaceMembershipMock).toHaveBeenCalledWith({ actor, workspaceId: "workspace-1" });
    expect(prismaMock.crmAccount.findUnique).toHaveBeenCalledWith({
      where: { id: "account-1" },
      select: { id: true, workspaceId: true, archivedAt: true },
    });
    expect(result.summary).toMatchObject({
      activeProjects: 1,
      budgetCents: 50_000_00,
      usedCents: 190_000,
      remainingCents: 4_810_000,
      marginBps: 3684,
    });
    expect(result.projectHealth[0]).toMatchObject({
      projectId: "project-1",
      usedBudgetCents: 190_000,
      directCostCents: 120_000,
    });
    expect(result.projects[0]?.crmDeal?.valueCents).toBe(50_000_00);
  });

  it("creates native time entries against a workspace project and attaches client and consultant context", async () => {
    prismaMock.practiceProject.findUnique.mockResolvedValueOnce({
      id: "project-1",
      workspaceId: "workspace-1",
      crmAccountId: "account-1",
      clientId: null,
      billingCodeId: "billing-1",
      code: "EXAMPLE-1",
      clientName: "Example",
      currency: "USD",
    });

    await createNativePracticeTimeEntry(actor, "workspace-1", {
      projectId: " project-1 ",
      consultantName: " Priya Shah ",
      consultantEmail: " PRIYA@EXAMPLE.TEST ",
      workedOn: new Date("2026-06-18T00:00:00.000Z"),
      hours: 2.5,
      assignmentType: " Strategy ",
      billRateCents: 12_000,
      costRateCents: 8_000,
    });

    expect(prismaMock.practiceClient.findFirst).toHaveBeenCalledWith({
      where: { workspaceId: "workspace-1", crmAccountId: "account-1" },
      select: { id: true },
    });
    expect(prismaMock.practiceClient.findUnique).toHaveBeenCalledWith({
      where: { workspaceId_code: { workspaceId: "workspace-1", code: "EXAMPLE" } },
      select: { id: true, crmAccountId: true, name: true },
    });
    expect(prismaMock.practiceClient.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: "workspace-1",
        crmAccountId: "account-1",
        code: "EXAMPLE",
        name: "Example",
      }),
      select: { id: true },
    });
    expect(prismaMock.practiceProject.update).toHaveBeenCalledWith({
      where: { id: "project-1" },
      data: { clientId: "client-1" },
    });
    expect(prismaMock.practiceConsultant.findMany).toHaveBeenCalledWith({
      where: {
        workspaceId: "workspace-1",
        email: { equals: "priya@example.test", mode: "insensitive" },
      },
      select: { id: true },
      orderBy: [{ id: "asc" }],
      take: 2,
    });
    expect(prismaMock.practiceConsultant.create).toHaveBeenCalledWith({
      data: {
        workspaceId: "workspace-1",
        name: "Priya Shah",
        email: "priya@example.test",
        sourceSatelliteId: null,
        active: true,
      },
      select: { id: true },
    });
    expect(prismaMock.practiceTimeEntry.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: "workspace-1",
        clientId: "client-1",
        billingCodeId: "billing-1",
        projectId: "project-1",
        consultantId: "consultant-1",
        workedOn: new Date("2026-06-18T00:00:00.000Z"),
        weekEndingOn: new Date("2026-06-21T00:00:00.000Z"),
        assignmentType: "Strategy",
        currency: "USD",
        billCurrency: "USD",
        costCurrency: "USD",
        functionalCurrency: "USD",
        billRateCents: 12_000,
        costRateCents: 8_000,
        billAmountCents: 30_000,
        costAmountCents: 20_000,
        status: "POSTED",
      }),
    });
    const created = prismaMock.practiceTimeEntry.create.mock.calls[0]?.[0].data;
    expect(created.hours.toString()).toBe("2.5");
  });

  it("creates native expenses with existing project client and reusable consultant", async () => {
    prismaMock.practiceProject.findUnique.mockResolvedValueOnce({
      id: "project-1",
      workspaceId: "workspace-1",
      crmAccountId: "account-1",
      clientId: "client-existing",
      billingCodeId: null,
      code: "EXAMPLE-1",
      clientName: "Example",
      currency: "USD",
    });
    prismaMock.practiceConsultant.findMany.mockResolvedValueOnce([{ id: "consultant-2" }]);

    await createNativePracticeExpense(actor, "workspace-1", {
      projectId: "project-1",
      consultantName: "Priya Shah",
      consultantEmail: "priya@example.test",
      spentOn: new Date("2026-06-19T00:00:00.000Z"),
      vendor: "Airline",
      category: "Travel",
      businessPurpose: "Client workshop",
      amountCents: 45_678,
      currency: "usd",
      billable: false,
    });

    expect(prismaMock.practiceClient.create).not.toHaveBeenCalled();
    expect(prismaMock.practiceClient.upsert).not.toHaveBeenCalled();
    expect(prismaMock.practiceConsultant.create).not.toHaveBeenCalled();
    expect(prismaMock.practiceExpense.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: "workspace-1",
        clientId: "client-existing",
        projectId: "project-1",
        consultantId: "consultant-2",
        spentOn: new Date("2026-06-19T00:00:00.000Z"),
        vendor: "Airline",
        category: "Travel",
        businessPurpose: "Client workshop",
        amountCents: 45_678,
        currency: "USD",
        amountFunctionalCents: 45_678,
        functionalCurrency: "USD",
        billable: false,
        status: "POSTED",
      }),
    });
  });

  it("returns an existing native time entry for duplicate manual idempotency keys", async () => {
    const existingEntry = { id: "time-existing", workspaceId: "workspace-1" };
    prismaMock.practiceProject.findUnique.mockResolvedValueOnce({
      id: "project-1",
      workspaceId: "workspace-1",
      crmAccountId: "account-1",
      clientId: null,
      billingCodeId: "billing-1",
      code: "EXAMPLE-1",
      clientName: "Example",
      currency: "USD",
    });
    prismaMock.practiceTimeEntry.findUnique.mockResolvedValueOnce(existingEntry);

    const result = await createNativePracticeTimeEntry(actor, "workspace-1", {
      projectId: "project-1",
      consultantName: "Priya Shah",
      workedOn: new Date("2026-06-18T00:00:00.000Z"),
      hours: 2.5,
      billRateCents: 12_000,
      costRateCents: 8_000,
      idempotencyKey: "manual-time-key",
    });

    expect(result).toBe(existingEntry);
    expect(prismaMock.practiceClient.create).not.toHaveBeenCalled();
    expect(prismaMock.practiceConsultant.findFirst).not.toHaveBeenCalled();
    expect(prismaMock.practiceConsultant.findMany).not.toHaveBeenCalled();
    expect(prismaMock.practiceTimeEntry.create).not.toHaveBeenCalled();
  });

  it("rejects ambiguous name-only consultants for native ledger submissions", async () => {
    prismaMock.practiceProject.findUnique.mockResolvedValueOnce({
      id: "project-1",
      workspaceId: "workspace-1",
      crmAccountId: "account-1",
      clientId: "client-existing",
      billingCodeId: "billing-1",
      code: "EXAMPLE-1",
      clientName: "Example",
      currency: "USD",
    });
    prismaMock.practiceConsultant.findMany.mockResolvedValueOnce([{ id: "consultant-1" }, { id: "consultant-2" }]);

    await expect(createNativePracticeTimeEntry(actor, "workspace-1", {
      projectId: "project-1",
      consultantName: "Priya Shah",
      workedOn: new Date("2026-06-18T00:00:00.000Z"),
      hours: 2.5,
      billRateCents: 12_000,
      costRateCents: 8_000,
    })).rejects.toMatchObject({ status: 409, code: "AMBIGUOUS_CONSULTANT" });

    expect(prismaMock.practiceConsultant.create).not.toHaveBeenCalled();
    expect(prismaMock.practiceTimeEntry.create).not.toHaveBeenCalled();
  });

  it("reuses idempotency-scoped consultants when duplicate manual creation races", async () => {
    prismaMock.practiceProject.findUnique.mockResolvedValueOnce({
      id: "project-1",
      workspaceId: "workspace-1",
      crmAccountId: "account-1",
      clientId: "client-existing",
      billingCodeId: "billing-1",
      code: "EXAMPLE-1",
      clientName: "Example",
      currency: "USD",
    });
    prismaMock.practiceConsultant.findMany.mockResolvedValueOnce([]);
    prismaMock.practiceConsultant.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "consultant-race" });
    prismaMock.practiceConsultant.create.mockRejectedValueOnce(Object.assign(new Error("Unique constraint failed"), { code: "P2002" }));

    await createNativePracticeTimeEntry(actor, "workspace-1", {
      projectId: "project-1",
      consultantName: "Priya Shah",
      workedOn: new Date("2026-06-18T00:00:00.000Z"),
      hours: 2.5,
      billRateCents: 12_000,
      costRateCents: 8_000,
      idempotencyKey: "manual-time-key",
    });

    expect(prismaMock.practiceConsultant.findFirst).toHaveBeenCalledWith({
      where: {
        workspaceId: "workspace-1",
        sourceSatelliteId: "manual-ledger-consultant:manual-time-key",
      },
      select: { id: true },
    });
    expect(prismaMock.practiceConsultant.create).toHaveBeenCalledWith({
      data: {
        workspaceId: "workspace-1",
        name: "Priya Shah",
        email: null,
        sourceSatelliteId: "manual-ledger-consultant:manual-time-key",
        active: true,
      },
      select: { id: true },
    });
    expect(prismaMock.practiceTimeEntry.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        consultantId: "consultant-race",
        idempotencyKey: "manual-time-key",
      }),
    });
  });

  it("validates native expense input before creating related client or consultant records", async () => {
    prismaMock.practiceProject.findUnique.mockResolvedValueOnce({
      id: "project-1",
      workspaceId: "workspace-1",
      crmAccountId: "account-1",
      clientId: null,
      billingCodeId: "billing-1",
      code: "EXAMPLE-1",
      clientName: "Example",
      currency: "USD",
    });

    await expect(createNativePracticeExpense(actor, "workspace-1", {
      projectId: "project-1",
      spentOn: new Date("2026-06-19T00:00:00.000Z"),
      category: "Travel",
      businessPurpose: "Client workshop",
      amountCents: 0,
      currency: "usd",
    })).rejects.toMatchObject({ status: 400, code: "INVALID_INPUT" });

    expect(prismaMock.practiceClient.create).not.toHaveBeenCalled();
    expect(prismaMock.practiceConsultant.findFirst).not.toHaveBeenCalled();
    expect(prismaMock.practiceConsultant.findMany).not.toHaveBeenCalled();
    expect(prismaMock.practiceConsultant.create).not.toHaveBeenCalled();
    expect(prismaMock.practiceExpense.create).not.toHaveBeenCalled();
  });

  it("rejects native time hours that round to zero before creating related records", async () => {
    prismaMock.practiceProject.findUnique.mockResolvedValueOnce({
      id: "project-1",
      workspaceId: "workspace-1",
      crmAccountId: "account-1",
      clientId: null,
      billingCodeId: "billing-1",
      code: "EXAMPLE-1",
      clientName: "Example",
      currency: "USD",
    });

    await expect(createNativePracticeTimeEntry(actor, "workspace-1", {
      projectId: "project-1",
      consultantName: "Priya Shah",
      workedOn: new Date("2026-06-18T00:00:00.000Z"),
      hours: 0.004,
      billRateCents: 12_000,
      costRateCents: 8_000,
    })).rejects.toMatchObject({ status: 400, code: "INVALID_INPUT" });

    expect(prismaMock.practiceClient.create).not.toHaveBeenCalled();
    expect(prismaMock.practiceConsultant.findFirst).not.toHaveBeenCalled();
    expect(prismaMock.practiceConsultant.findMany).not.toHaveBeenCalled();
    expect(prismaMock.practiceConsultant.create).not.toHaveBeenCalled();
    expect(prismaMock.practiceTimeEntry.create).not.toHaveBeenCalled();
  });

  it("creates a collision-safe native client code instead of relinking an unrelated client", async () => {
    prismaMock.practiceProject.findUnique.mockResolvedValueOnce({
      id: "project-1",
      workspaceId: "workspace-1",
      crmAccountId: "account-2",
      clientId: null,
      billingCodeId: null,
      code: "PROJECT-1",
      clientName: "Foo Bar",
      currency: "USD",
    });
    prismaMock.practiceClient.findUnique.mockResolvedValueOnce({
      id: "client-collision",
      crmAccountId: "account-1",
      name: "Foo & Bar",
    });

    await createNativePracticeExpense(actor, "workspace-1", {
      projectId: "project-1",
      spentOn: new Date("2026-06-19T00:00:00.000Z"),
      category: "Travel",
      businessPurpose: "Client workshop",
      amountCents: 45_678,
      currency: "usd",
    });

    expect(prismaMock.practiceClient.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: "workspace-1",
        crmAccountId: "account-2",
        code: "FOO-BAR-project-1",
        name: "Foo Bar",
      }),
      select: { id: true },
    });
    expect(prismaMock.practiceProject.update).toHaveBeenCalledWith({
      where: { id: "project-1" },
      data: { clientId: "client-1" },
    });
  });

  it("creates a fallback native client code for client names without ASCII code characters", async () => {
    prismaMock.practiceProject.findUnique.mockResolvedValueOnce({
      id: "project-abc-123",
      workspaceId: "workspace-1",
      crmAccountId: "account-2",
      clientId: null,
      billingCodeId: null,
      code: "PROJECT-1",
      clientName: "株式会社例",
      currency: "USD",
    });

    await createNativePracticeExpense(actor, "workspace-1", {
      projectId: "project-abc-123",
      spentOn: new Date("2026-06-19T00:00:00.000Z"),
      category: "Travel",
      businessPurpose: "Client workshop",
      amountCents: 45_678,
      currency: "usd",
    });

    expect(prismaMock.practiceClient.findUnique).toHaveBeenCalledWith({
      where: { workspaceId_code: { workspaceId: "workspace-1", code: "CLIENT-PROJECTABC12" } },
      select: { id: true, crmAccountId: true, name: true },
    });
    expect(prismaMock.practiceClient.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: "workspace-1",
        crmAccountId: "account-2",
        code: "CLIENT-PROJECTABC12",
        name: "株式会社例",
      }),
      select: { id: true },
    });
    expect(prismaMock.practiceProject.update).toHaveBeenCalledWith({
      where: { id: "project-abc-123" },
      data: { clientId: "client-1" },
    });
  });

  it("creates a manual practice project behind finance-write access", async () => {
    const projectResult = await createPracticeProject(actor, "workspace-1", {
      code: "DPRJ-001",
      name: "Manual rollout",
      clientName: "Example",
      status: "ACTIVE",
      poValueCents: 40_000_00,
      serviceBudgetCents: 25_000_00,
      expenseBudgetCents: 5_000_00,
      usedCents: 12_000_00,
      weeklyBurnCents: 2_000_00,
      targetMarginBps: 5500,
      currentMarginBps: 5200,
    });

    expect(requireWorkspaceMembershipMock).toHaveBeenCalledWith({
      actor,
      workspaceId: "workspace-1",
    });
    expect(projectResult.id).toBe("project-1");
    expect(prismaMock.practiceProject.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: "workspace-1",
        code: "DPRJ-001",
        name: "Manual rollout",
        clientName: "Example",
        status: "ACTIVE",
        poValueCents: 40_000_00,
        targetMarginBps: 5500,
      }),
    });
  });

  it("rejects ordinary contributors without explicit all-member finance write config for manual practice projects", async () => {
    requireWorkspaceMembershipMock.mockResolvedValueOnce({ id: "member-1", role: "CONTRIBUTOR" });
    prismaMock.workspaceFeatureFlag.findUnique.mockResolvedValueOnce({ enabled: true, config: null });

    await expect(createPracticeProject(actor, "workspace-1", {
      code: "DPRJ-001",
      name: "Manual rollout",
      clientName: "Example",
    })).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
    expect(prismaMock.practiceProject.create).not.toHaveBeenCalled();
  });

  it("allows contributors to create and update practice projects when all-member finance writes are configured", async () => {
    requireWorkspaceMembershipMock.mockResolvedValue({ id: "member-1", role: "CONTRIBUTOR" });
    prismaMock.workspaceFeatureFlag.findUnique.mockResolvedValue({
      enabled: true,
      config: { practiceProjectsAllMemberWrite: true },
    });

    await createPracticeProject(actor, "workspace-1", {
      code: "DPRJ-001",
      name: "Manual rollout",
      clientName: "Example",
    });

    prismaMock.practiceProject.findUnique.mockResolvedValueOnce({
      id: "project-1",
      workspaceId: "workspace-1",
    });

    await updatePracticeProject(actor, "workspace-1", {
      projectId: "project-1",
      status: "ON_HOLD",
    });

    expect(prismaMock.practiceProject.create).toHaveBeenCalled();
    expect(prismaMock.practiceProject.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "project-1" },
    }));
  });

  it("keeps the finance manage helper aligned with configured all-member writes", async () => {
    requireWorkspaceMembershipMock.mockResolvedValue({ id: "member-1", role: "CONTRIBUTOR" });
    prismaMock.workspaceFeatureFlag.findUnique.mockResolvedValueOnce({
      enabled: true,
      config: { practiceProjectsAllMemberWrite: true },
    });
    await expect(canManagePracticeFinanceProjects(actor, "workspace-1")).resolves.toBe(true);

    prismaMock.workspaceFeatureFlag.findUnique.mockResolvedValueOnce({ enabled: true, config: null });
    await expect(canManagePracticeFinanceProjects(actor, "workspace-1")).resolves.toBe(false);

    await expect(canManagePracticeFinanceProjects(actor, "workspace-1", {
      resolvedMembership: { role: "FINANCE_STEWARD" },
    })).resolves.toBe(true);
    await expect(canManagePracticeFinanceProjects(actor, "workspace-1", {
      resolvedMembership: { role: "ADMIN" },
    })).resolves.toBe(true);
  });

  it("updates a workspace-scoped practice project behind finance-write access", async () => {
    prismaMock.practiceProject.findUnique.mockResolvedValueOnce({
      id: "project-1",
      workspaceId: "workspace-1",
    });

    const projectResult = await updatePracticeProject(actor, "workspace-1", {
      projectId: " project-1 ",
      code: "DPRJ-002",
      name: "Updated project",
      clientName: "Example",
      status: "ON_HOLD",
      poValueCents: 40_000_00,
      serviceBudgetCents: 25_000_00,
      expenseBudgetCents: 5_000_00,
      usedCents: 12_000_00,
      weeklyBurnCents: 2_000_00,
      targetMarginBps: 5500,
      currentMarginBps: 5200,
    });

    expect(requireWorkspaceMembershipMock).toHaveBeenCalledWith({
      actor,
      workspaceId: "workspace-1",
    });
    expect(projectResult.status).toBe("ON_HOLD");
    expect(prismaMock.practiceProject.findUnique).toHaveBeenCalledWith({
      where: { id: "project-1" },
      select: { id: true, workspaceId: true },
    });
    expect(prismaMock.practiceProject.update).toHaveBeenCalledWith({
      where: { id: "project-1" },
      data: expect.objectContaining({
        code: "DPRJ-002",
        name: "Updated project",
        clientName: "Example",
        status: "ON_HOLD",
        poValueCents: 40_000_00,
        currentMarginBps: 5200,
      }),
    });
  });

  it("rejects practice project updates across workspace boundaries", async () => {
    prismaMock.practiceProject.findUnique.mockResolvedValueOnce({
      id: "project-1",
      workspaceId: "other-workspace",
    });

    await expect(updatePracticeProject(actor, "workspace-1", {
      projectId: "project-1",
      status: "CLOSED",
    })).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
    expect(prismaMock.practiceProject.update).not.toHaveBeenCalled();
  });

  it("rejects account finance rollups across workspace boundaries", async () => {
    prismaMock.crmAccount.findUnique.mockResolvedValueOnce({
      id: "account-1",
      workspaceId: "other-workspace",
      archivedAt: null,
    });

    await expect(getCrmAccountPracticeFinance(actor, {
      workspaceId: "workspace-1",
      accountId: "account-1",
    })).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
    expect(prismaMock.practiceProject.findMany).not.toHaveBeenCalled();
  });

  it("creates one finance project from a closed-won CRM deal behind finance-write access", async () => {
    const projectResult = await createPracticeProjectFromWonDeal(actor, "workspace-1", {
      dealId: "deal-1",
      serviceBudgetCents: 15_000_00,
      expenseBudgetCents: 2_000_00,
      targetMarginBps: 5500,
    });

    expect(requireWorkspaceMembershipMock).toHaveBeenCalledWith({
      actor,
      workspaceId: "workspace-1",
    });
    expect(projectResult.id).toBe("project-1");
    expect(prismaMock.practiceProject.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: "workspace-1",
        crmAccountId: "account-1",
        crmDealId: "deal-1",
        name: "Pilot rollout",
        clientName: "Example",
        poValueCents: 25_000_00,
        serviceBudgetCents: 15_000_00,
        expenseBudgetCents: 2_000_00,
        targetMarginBps: 5500,
      }),
    });
  });

  it("returns the existing linked finance project on repeated won-deal conversion", async () => {
    prismaMock.practiceProject.findUnique.mockResolvedValueOnce({
      id: "project-existing",
      workspaceId: "workspace-1",
    });

    const projectResult = await createPracticeProjectFromWonDeal(actor, "workspace-1", { dealId: "deal-1" });

    expect(projectResult.id).toBe("project-existing");
    expect(prismaMock.practiceProject.create).not.toHaveBeenCalled();
  });

  it("rejects project conversion unless the deal is closed won and workspace-scoped", async () => {
    prismaMock.crmDeal.findUnique.mockResolvedValueOnce({
      id: "deal-1",
      workspaceId: "workspace-1",
      accountId: "account-1",
      contactId: "contact-1",
      title: "Pilot rollout",
      stage: "NEGOTIATION",
      valueCents: 25_000_00,
      archivedAt: null,
      account: {
        id: "account-1",
        workspaceId: "workspace-1",
        name: "Example",
        slug: "example",
      },
      contact: {
        id: "contact-1",
        workspaceId: "workspace-1",
        email: "buyer@example.test",
        company: "Example",
      },
    });

    await expect(createPracticeProjectFromWonDeal(actor, "workspace-1", { dealId: "deal-1" }))
      .rejects.toMatchObject({ status: 400, code: "INVALID_STATE" });
    expect(prismaMock.practiceProject.create).not.toHaveBeenCalled();

    prismaMock.crmDeal.findUnique.mockResolvedValueOnce({
      id: "deal-2",
      workspaceId: "workspace-1",
      accountId: "account-other",
      contactId: "contact-1",
      title: "Expansion",
      stage: "CLOSED_WON",
      valueCents: 10_000_00,
      archivedAt: null,
      account: {
        id: "account-other",
        workspaceId: "other-workspace",
        name: "Other",
        slug: "other",
      },
      contact: {
        id: "contact-1",
        workspaceId: "workspace-1",
        email: "buyer@example.test",
        company: "Example",
      },
    });

    await expect(createPracticeProjectFromWonDeal(actor, "workspace-1", { dealId: "deal-2" }))
      .rejects.toMatchObject({ status: 400, code: "INVALID_STATE" });
    expect(prismaMock.practiceProject.create).not.toHaveBeenCalled();
  });
});
