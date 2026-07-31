import { describe, expect, it } from "vitest";
import { RISK_CAPS, sizePolicyForFiles } from "./check-plan-policy.mjs";

describe("check-plan size policy", () => {
  it("allows 700 lines for normal high-risk work", () => {
    expect(sizePolicyForFiles("high", ["packages/workflows/src/outbox.ts"])).toEqual({
      effectiveRiskTier: "high",
      caps: { codeLoc: 700, files: 15 },
    });
  });

  it("keeps an explicit critical plan at 400 lines", () => {
    expect(sizePolicyForFiles("critical", ["packages/domain/src/finance-imports.ts"])).toEqual({
      effectiveRiskTier: "critical",
      caps: { codeLoc: 400, files: 15 },
    });
  });

  it.each([
    "prisma/migrations/20260731_example/migration.sql",
    "packages/domain/src/auth.ts",
    "scripts/check-plan.mjs",
    "AGENTS.md",
    ".codex/ops/reviewer.md",
    ".github/pull_request_template.md",
    "docs/contributing/pull-requests.mdx",
  ])("forces the critical cap for protected path %s", (file) => {
    expect(sizePolicyForFiles("high", [file])).toEqual({
      effectiveRiskTier: "critical",
      caps: { codeLoc: 400, files: 15 },
    });
  });

  it("leaves low and standard limits unchanged", () => {
    expect(RISK_CAPS.low).toEqual({ codeLoc: 1200, files: 50 });
    expect(RISK_CAPS.standard).toEqual({ codeLoc: 800, files: 25 });
  });
});
