import { describe, expect, it } from "vitest";

import {
  BUDGET_RUNWAY_ATTENTION_WEEKS,
  collectAttention,
  projectAttentionItems,
  projectBudgetRunwayWeeks,
  projectNeedsSetup,
  projectRemainingCents,
  projectUsedRatio,
  summarizePracticeFinance,
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
});
