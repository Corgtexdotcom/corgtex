import { describe, expect, it } from "vitest";
import { validateObjectionCriteria } from "./objection-validation";

describe("validateObjectionCriteria", () => {
  const baseParams = {
    objectionBodyMd: "This proposal slows down our deployment process.",
    degradationClaim: "Deployment takes 2 extra days.",
    causalityClaim: "The proposal adds an approval step.",
    dataBasedClaim: "We have data showing this step always takes 2 days.",
    isCatastrophicHarm: false,
    affectedRoleId: "role-1",
    objectorRoleIds: ["role-1", "role-2"],
  };

  it("validates objection meeting all 4 criteria", () => {
    const result = validateObjectionCriteria(baseParams);
    expect(result.isValid).toBe(true);
    expect(result.criteria.degradation.met).toBe(true);
    expect(result.criteria.causality.met).toBe(true);
    expect(result.criteria.dataBased.met).toBe(true);
    expect(result.criteria.roleRelated.met).toBe(true);
  });

  it("rejects objection missing degradation claim", () => {
    const result = validateObjectionCriteria({
      ...baseParams,
      degradationClaim: "",
    });
    expect(result.isValid).toBe(false);
    expect(result.criteria.degradation.met).toBe(false);
  });

  it("rejects objection unrelated to objector roles", () => {
    const result = validateObjectionCriteria({
      ...baseParams,
      objectorRoleIds: ["role-3"],
    });
    expect(result.isValid).toBe(false);
    expect(result.criteria.roleRelated.met).toBe(false);
  });

  it("accepts objection with catastrophic future harm (waives data-based)", () => {
    const result = validateObjectionCriteria({
      ...baseParams,
      dataBasedClaim: "", // No present data
      isCatastrophicHarm: true, // But catastrophic
    });
    expect(result.isValid).toBe(true);
    expect(result.criteria.dataBased.met).toBe(true);
    expect(result.criteria.dataBased.rationale).toContain("Waived");
  });
});
