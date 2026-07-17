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
    practiceExpense: {
      findMany: vi.fn(),
    },
    practiceProject: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
    practiceTimeEntry: {
      findMany: vi.fn(),
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
  return { toNumber: () => value } as NativeTimeEntryFixture["hours"];
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
      weeksToBudgetExhaustion: 17.1,
      weeksToTargetMarginRisk: 0,
      hasBudgetSetup: true,
      hasRecentBurn: true,
    });
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

  it("rejects mixed active currencies before aggregating native finance summaries", () => {
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

    try {
      summarizeNativePracticeFinance([usd, eur]);
      throw new Error("Expected summarizeNativePracticeFinance to reject mixed currencies.");
    } catch (error) {
      expect(error).toMatchObject({ code: "MIXED_CURRENCY" });
    }
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

    expect(summarizeNativePracticeFinance([uppercase, lowercase]).activeProjects).toBe(2);
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
      billedCents: 300_000,
      costCents: 152_000,
      expenseCents: 12_345,
    });
  });

  it("previews Slicing Pie contribution data from native time and expense rows", () => {
    expect(previewSlicingPieContributionFromTimeEntry(nativeTimeEntry({
      costAmountCents: 40_000,
      paidAmountCents: 15_000,
      paymentBatchId: "batch-1",
    }))).toMatchObject({
      sourceType: "TIME_ENTRY",
      sourceId: "time-1",
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
    }))).toMatchObject({
      sourceType: "EXPENSE",
      sourceId: "expense-1",
      marketValueCents: 12_000,
      paidAmountCents: 0,
      unpaidAmountCents: 12_000,
      multiplier: SLICING_PIE_EXPENSE_MULTIPLIER,
      slices: 48_000,
      paymentBatchId: "mixed-batch",
    });

    expect(previewSlicingPieContributionFromExpense(nativeExpense({
      amountCents: 12_000,
      amountFunctionalCents: null,
      currency: "EUR",
      functionalCurrency: "USD",
    }))).toMatchObject({
      currency: "EUR",
      marketValueCents: 12_000,
    });

    expect(previewSlicingPieContributionFromExpense(nativeExpense({
      amountCents: 12_000,
      amountFunctionalCents: 13_500,
      currency: "EUR",
      functionalCurrency: null,
    }))).toMatchObject({
      currency: "EUR",
      marketValueCents: 12_000,
    });
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
    prismaMock.practiceExpense.findMany.mockResolvedValue([]);
    prismaMock.practiceTimeEntry.findMany.mockResolvedValue([]);
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
        code: "EXAMPLE-1",
        clientName: "Example",
        weeklyBurnCents: 5_000_00,
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
      usedCents: 15_000_00,
      remainingCents: 35_000_00,
      marginBps: 6200,
    });
    expect(result.projects[0]?.crmDeal?.valueCents).toBe(50_000_00);
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
