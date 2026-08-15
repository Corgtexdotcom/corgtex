import { describe, expect, it } from "vitest";
import { RISK_CAPS, sizePolicyForFiles } from "./check-plan-policy.mjs";

describe("check-plan size policy", () => {
  it("allows an agent-sized cohesive high-risk change", () => {
    expect(sizePolicyForFiles("high", ["packages/workflows/src/outbox.ts"])).toEqual({
      effectiveRiskTier: "high",
      caps: { codeLoc: 1800, files: 40 },
    });
  });

  it("allows a larger independently reviewed critical change", () => {
    expect(sizePolicyForFiles("critical", ["packages/domain/src/finance-imports.ts"])).toEqual({
      effectiveRiskTier: "critical",
      caps: { codeLoc: 1200, files: 30 },
    });
  });

  it.each([
    "prisma/migrations/20260731_example/migration.sql",
    "packages/domain/src/auth.ts",
    "scripts/check-plan.mjs",
    "scripts/review-snapshot-integrity.mjs",
    "AGENTS.md",
    ".codex/ops/reviewer.md",
    ".github/pull_request_template.md",
    "docs/contributing/pull-requests.mdx",
  ])("forces the critical review budget for protected path %s", (file) => {
    expect(sizePolicyForFiles("high", [file])).toEqual({
      effectiveRiskTier: "critical",
      caps: { codeLoc: 1200, files: 30 },
    });
  });

  it("uses larger agent-native budgets for low and standard work", () => {
    expect(RISK_CAPS.low).toEqual({ codeLoc: 4000, files: 100 });
    expect(RISK_CAPS.standard).toEqual({ codeLoc: 2500, files: 60 });
  });
});
