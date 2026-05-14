import { describe, expect, it } from "vitest";
import { applyGuidanceTermCorrections, extractGuidanceTermCorrections } from "./ingestion-guidance";

describe("ingestion guidance corrections", () => {
  it("extracts explicit not-this-use-that terminology corrections", () => {
    expect(extractGuidanceTermCorrections("Its not Karina - its Corporate-rebels.com or corporate rebels depends on the context")).toEqual([
      { from: "Karina", to: "Corporate-rebels.com", domainTo: "Corporate-rebels.com", nameTo: "corporate rebels" },
    ]);
  });

  it("applies corrections to standalone, email, and domain contexts", () => {
    const guidance = "Additional guidance: Its not Karina - its Corporate-rebels.com or corporate rebels depends on the context";
    const summary = [
      "The company name for Karina was discussed.",
      "Puncar should configure info@karina.com.",
      "The old karina.com domain is still pending.",
    ].join("\n");

    expect(applyGuidanceTermCorrections(summary, guidance)).toBe([
      "The company name for corporate rebels was discussed.",
      "Puncar should configure info@corporate-rebels.com.",
      "The old corporate-rebels.com domain is still pending.",
    ].join("\n"));
  });

  it("ignores depending-on-context qualifiers when there is no readable-name alternative", () => {
    const guidance = "Additional guidance: Its not Karina - use Corporate-rebels.com depending on context";

    expect(applyGuidanceTermCorrections("Karina should use info@karina.com.", guidance)).toBe(
      "Corporate-rebels.com should use info@corporate-rebels.com.",
    );
  });

  it("corrects full-domain stale terms without rewriting inferred subdomains", () => {
    const guidance = "Additional guidance: Its not karina.com - use corporate-rebels.com";
    const summary = [
      "Send mail to info@karina.com.",
      "The old karina.com domain is still pending.",
      "The vendor portal.karina.com should not be inferred from the correction.",
    ].join("\n");

    expect(applyGuidanceTermCorrections(summary, guidance)).toBe([
      "Send mail to info@corporate-rebels.com.",
      "The old corporate-rebels.com domain is still pending.",
      "The vendor portal.karina.com should not be inferred from the correction.",
    ].join("\n"));
  });

  it("preserves explicit replacement casing", () => {
    expect(applyGuidanceTermCorrections("Acme approved the migration.", "It is not Acme - use IBM")).toBe(
      "IBM approved the migration.",
    );
  });
});
