import modelPrices from "./model-prices.json";

export type ModelPrice = {
  provider: string;
  model: string;
  inputUsdPerToken: number;
  outputUsdPerToken: number;
};

export type ModelCostEstimate = {
  rawProviderCostUsd: string;
  billableCostUsd: string;
  estimatedCostUsd: string;
  markupMultiplier: number;
};

const DEFAULT_AI_MARKUP_MULTIPLIER = 2;

const MODEL_PRICES: ModelPrice[] = modelPrices;

function parseModelPriceOverrides() {
  const raw = process.env.MODEL_PRICE_OVERRIDES_JSON?.trim();
  if (!raw) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("MODEL_PRICE_OVERRIDES_JSON must be valid JSON.");
  }

  if (!Array.isArray(parsed)) {
    throw new Error("MODEL_PRICE_OVERRIDES_JSON must be an array.");
  }

  return parsed.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`MODEL_PRICE_OVERRIDES_JSON[${index}] must be an object.`);
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.provider !== "string" || typeof record.model !== "string") {
      throw new Error(`MODEL_PRICE_OVERRIDES_JSON[${index}] requires provider and model strings.`);
    }
    if (typeof record.inputUsdPerToken !== "number" || typeof record.outputUsdPerToken !== "number") {
      throw new Error(`MODEL_PRICE_OVERRIDES_JSON[${index}] requires numeric token prices.`);
    }
    if (!Number.isFinite(record.inputUsdPerToken) || record.inputUsdPerToken < 0) {
      throw new Error(`MODEL_PRICE_OVERRIDES_JSON[${index}].inputUsdPerToken must be a non-negative number.`);
    }
    if (!Number.isFinite(record.outputUsdPerToken) || record.outputUsdPerToken < 0) {
      throw new Error(`MODEL_PRICE_OVERRIDES_JSON[${index}].outputUsdPerToken must be a non-negative number.`);
    }

    return {
      provider: record.provider,
      model: record.model,
      inputUsdPerToken: record.inputUsdPerToken,
      outputUsdPerToken: record.outputUsdPerToken,
    };
  });
}

function normalizeProvider(provider: string) {
  return provider.trim().toLowerCase();
}

function normalizeModel(model: string) {
  return model.trim().toLowerCase();
}

function formatUsd(value: number) {
  return value.toFixed(6);
}

export function getModelPrice(provider: string, model: string) {
  const normalizedProvider = normalizeProvider(provider);
  const normalizedModel = normalizeModel(model);
  return [...parseModelPriceOverrides(), ...MODEL_PRICES].find((price) => (
    normalizeProvider(price.provider) === normalizedProvider &&
    normalizeModel(price.model) === normalizedModel
  )) ?? null;
}

export function estimateModelCost(params: {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  markupMultiplier?: number;
}): ModelCostEstimate | null {
  const price = getModelPrice(params.provider, params.model);
  if (!price) {
    return null;
  }

  const inputTokens = Math.max(0, Math.trunc(params.inputTokens));
  const outputTokens = Math.max(0, Math.trunc(params.outputTokens));
  const markupMultiplier = params.markupMultiplier ?? DEFAULT_AI_MARKUP_MULTIPLIER;
  const rawProviderCost = inputTokens * price.inputUsdPerToken + outputTokens * price.outputUsdPerToken;
  const billableCost = rawProviderCost * markupMultiplier;

  return {
    rawProviderCostUsd: formatUsd(rawProviderCost),
    billableCostUsd: formatUsd(billableCost),
    estimatedCostUsd: formatUsd(billableCost),
    markupMultiplier,
  };
}
