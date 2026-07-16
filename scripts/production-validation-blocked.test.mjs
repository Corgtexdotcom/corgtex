import { describe, expect, it } from "vitest";

import { createBlockedValidationRun } from "./production-validation-blocked.mjs";

describe("production validation blocked artifacts", () => {
  it("records missing prerequisites as blocked validation results", () => {
    const run = createBlockedValidationRun({
      runId: "blocked-crm",
      tenantSlug: "corgtex-validation",
      prNumbers: [696],
      baseUrl: "https://app.corgtex.com",
      method: "crm-production-smoke",
      intent: "CRM pending operation smoke",
      blocker: "ADMIN_EMAIL and ADMIN_PASSWORD are required.",
    });

    expect(run.status).toBe("running");
    expect(run.tenant.slug).toBe("corgtex-validation");
    expect(run.prNumbers).toEqual([696]);
    expect(run.results).toHaveLength(1);
    expect(run.results[0]).toMatchObject({
      prNumber: 696,
      method: "crm-production-smoke",
      result: "blocked",
      blocker: "ADMIN_EMAIL and ADMIN_PASSWORD are required.",
    });
    expect(run.blockers).toEqual([{
      prNumber: 696,
      intent: "CRM pending operation smoke",
      blocker: "ADMIN_EMAIL and ADMIN_PASSWORD are required.",
    }]);
  });

  it("records one blocked result per requested PR", () => {
    const run = createBlockedValidationRun({
      runId: "blocked-many",
      tenantSlug: "corgtex-validation",
      prNumbers: [696, 705],
      baseUrl: "https://app.corgtex.com",
      method: "crm-production-smoke",
      intent: "CRM pending operation smoke",
      blocker: "Production validation must run from main.",
    });

    expect(run.results.map((result) => result.prNumber)).toEqual([696, 705]);
    expect(run.results.every((result) => result.result === "blocked")).toBe(true);
    expect(run.blockers.map((blocker) => blocker.prNumber)).toEqual([696, 705]);
  });
});
