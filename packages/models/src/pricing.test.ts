import { describe, expect, it } from "vitest";
import { estimateModelCost, getModelPrice } from "./pricing";

describe("model pricing", () => {
  it("calculates raw provider cost and 100 percent markup for known models", () => {
    const estimate = estimateModelCost({
      provider: "openrouter",
      model: "qwen/qwen3-32b",
      inputTokens: 1000,
      outputTokens: 500,
    });

    expect(estimate).toMatchObject({
      rawProviderCostUsd: "0.000220",
      billableCostUsd: "0.000440",
      estimatedCostUsd: "0.000440",
      markupMultiplier: 2,
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
