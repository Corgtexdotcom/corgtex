import { describe, expect, it } from "vitest";

import { summarizeQaResults } from "./client-readiness-production-smoke.mjs";

describe("client readiness production smoke", () => {
  it("summarizes route results, findings, and console errors", () => {
    expect(summarizeQaResults({
      routeResults: [{ name: "desktop-leads" }, { name: "mobile-leads" }],
      findings: [{ name: "fatal" }],
      consoleErrors: [],
    })).toBe("2 routes checked, 1 findings, 0 console errors");
  });

  it("handles missing QA output for partial validation artifacts", () => {
    expect(summarizeQaResults(null)).toBe("Client readiness QA results were not written.");
  });
});
