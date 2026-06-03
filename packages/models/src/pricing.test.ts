import { describe, expect, it } from "vitest";
import { estimateModelCost, getModelPrice } from "./pricing";

describe("model pricing", () => {
  it("calculates raw provider cost and 100 percent markup for DeepSeek quality models", () => {
    const estimate = estimateModelCost({
      provider: "openrouter",
      model: "deepseek/deepseek-v4-pro",
      inputTokens: 1000,
      outputTokens: 500,
    });

    expect(estimate).toMatchObject({
      rawProviderCostUsd: "0.000870",
      billableCostUsd: "0.001740",
      estimatedCostUsd: "0.001740",
      markupMultiplier: 2,
    });
  });

  it("keeps prices for the routed DeepSeek defaults", () => {
    expect(getModelPrice("openrouter", "deepseek/deepseek-v4-flash")).toMatchObject({
      inputUsdPerToken: 0.0000000983,
      outputUsdPerToken: 0.0000001966,
    });
    expect(getModelPrice("openrouter", "deepseek/deepseek-r1-0528")).toMatchObject({
      inputUsdPerToken: 0.0000005,
      outputUsdPerToken: 0.00000215,
    });
  });

  it("returns null for missing prices so billing launch cannot silently guess", () => {
    expect(getModelPrice("unknown", "unknown")).toBeNull();
    expect(estimateModelCost({
      provider: "unknown",
      model: "unknown",
      inputTokens: 1000,
      outputTokens: 1000,
    })).toBeNull();
  });
});
