import { describe, expect, it } from "vitest";

import { validationSeedConfig } from "./seed-internal-validation-workspace.mjs";

describe("internal validation workspace seed", () => {
  it("enables only the clean Finance shell flag", () => {
    expect(validationSeedConfig.featureFlags).toMatchObject({
      FINANCE: true,
    });
    expect(validationSeedConfig.featureFlags).not.toHaveProperty("FINANCE_PROJECTS");
    expect(validationSeedConfig.featureFlags).not.toHaveProperty("FINANCE_SLICING_PIE");
    expect(validationSeedConfig.featureFlags).not.toHaveProperty("PRACTICE_PROJECTS");
    expect(validationSeedConfig.featureFlags).not.toHaveProperty("SLICING_PIE");
  });
});
