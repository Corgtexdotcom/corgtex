import { describe, expect, it } from "vitest";
import { applyGuidanceTermCorrections, extractGuidanceTermCorrections } from "./ingestion-guidance";

describe("ingestion guidance corrections", () => {
  it("extracts explicit not-this-use-that terminology corrections", () => {
    expect(extractGuidanceTermCorrections("Its not Karina - its Corporate-rebels.com or corporate rebels depends on the context")).toEqual([
      { from: "Karina", to: "Corporate-rebels.com" },
    ]);
  });

  it("applies corrections to standalone summary terms and matching email/domain references", () => {
    const guidance = "Additional guidance: Its not Karina - its Corporate-rebels.com or corporate rebels depends on the context";
    const summary = [
      "The company name for Karina was discussed.",
      "Puncar should configure info@karina.com.",
      "The old karina.com domain is still pending.",
      "The vendor portal.karina.com should not be inferred from the correction.",
    ].join("\n");

    expect(applyGuidanceTermCorrections(summary, guidance)).toBe([
      "The company name for Corporate-rebels.com was discussed.",
      "Puncar should configure info@corporate-rebels.com.",
      "The old Corporate-rebels.com domain is still pending.",
      "The vendor portal.karina.com should not be inferred from the correction.",
    ].join("\n"));
  });
});
