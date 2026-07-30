import { afterEach, describe, expect, it } from "vitest";
import { estimateModelCost, getModelPrice } from "./pricing";

const ORIGINAL_ENV = { ...process.env };

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
}

afterEach(() => {
  restoreEnv();
});

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

  it("loads explicit Azure deployment pricing from env overrides", () => {
    process.env.MODEL_PRICE_OVERRIDES_JSON = JSON.stringify([
      {
        provider: "azure-openai",
        model: "corgtex-chat-fast",
        inputUsdPerToken: 0.00000015,
        outputUsdPerToken: 0.0000006,
      },
    ]);

    expect(getModelPrice("azure-openai", "corgtex-chat-fast")).toMatchObject({
      inputUsdPerToken: 0.00000015,
      outputUsdPerToken: 0.0000006,
    });
    expect(estimateModelCost({
      provider: "azure-openai",
      model: "corgtex-chat-fast",
      inputTokens: 1000,
      outputTokens: 500,
    })).toMatchObject({
      rawProviderCostUsd: "0.000450",
      billableCostUsd: "0.000900",
      estimatedCostUsd: "0.000900",
    });
  });

  it("keeps Azure Direct Foundry deployment alias pricing explicit", () => {
    expect(getModelPrice("azure-foundry", "corgtex-ds-v4-flash")).toMatchObject({
      inputUsdPerToken: 0.00000019,
      outputUsdPerToken: 0.00000051,
    });
    expect(getModelPrice("azure-foundry", "corgtex-ds-v4-pro")).toMatchObject({
      inputUsdPerToken: 0.00000174,
      outputUsdPerToken: 0.00000348,
    });
    expect(getModelPrice("azure-foundry", "corgtex-kimi-k25")).toMatchObject({
      inputUsdPerToken: 0.0000006,
      outputUsdPerToken: 0.000003,
    });
    expect(getModelPrice("azure-foundry", "corgtex-kimi-k27-code")).toMatchObject({
      inputUsdPerToken: 0.00000095,
      outputUsdPerToken: 0.000004,
    });
    expect(getModelPrice("azure-foundry", "corgtex-gpt56-luna")).toMatchObject({
      inputUsdPerToken: 0.000001,
      outputUsdPerToken: 0.000006,
    });
  });
});
