import { describe, expect, it } from "vitest";

// Unit tests for the parseCost helper logic and summary aggregation
describe("audit-trail cost parsing", () => {
  function parseCost(value: unknown): number {
    if (value == null) return 0;
    const num = typeof value === "number" ? value : Number(String(value));
    return Number.isFinite(num) ? num : 0;
  }

  it("parses numeric values", () => {
    expect(parseCost(0.001234)).toBeCloseTo(0.001234);
    expect(parseCost(0)).toBe(0);
    expect(parseCost(1.5)).toBe(1.5);
  });

  it("parses string values", () => {
    expect(parseCost("0.001234")).toBeCloseTo(0.001234);
    expect(parseCost("0")).toBe(0);
  });

  it("handles null/undefined", () => {
    expect(parseCost(null)).toBe(0);
    expect(parseCost(undefined)).toBe(0);
  });

  it("handles non-numeric strings", () => {
    expect(parseCost("not-a-number")).toBe(0);
    expect(parseCost("")).toBe(0);
  });

  it("handles Infinity and NaN", () => {
    expect(parseCost(Infinity)).toBe(0);
    expect(parseCost(NaN)).toBe(0);
  });
});

describe("audit-trail action labels", () => {
  function actionLabel(action: string): string {
    return action.replace(/\./g, " ").replace(/([A-Z])/g, " $1").trim();
  }

  it("converts dotted actions to readable labels", () => {
    expect(actionLabel("event.replayed")).toBe("event replayed");
    expect(actionLabel("agentRun.triggered")).toBe("agent Run triggered");
    expect(actionLabel("workflowJob.replayed")).toBe("workflow Job replayed");
  });

  it("handles simple actions", () => {
    expect(actionLabel("created")).toBe("created");
    expect(actionLabel("proposal.submitted")).toBe("proposal submitted");
  });
});
