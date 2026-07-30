import { env } from "@corgtex/shared";

export type ModelTier = "fast" | "standard" | "quality" | "excellent" | "none";

function tierModel(tier: ModelTier) {
  switch (tier) {
    case "fast":      return env.MODEL_CHAT_FAST;
    case "standard":  return env.MODEL_CHAT_STANDARD;
    case "quality":   return env.MODEL_CHAT_QUALITY;
    case "excellent": return env.MODEL_CHAT_EXCELLENT;
    case "none":      return env.MODEL_CHAT_DEFAULT;
  }
}

function isAzureDirectProvider() {
  return env.MODEL_PROVIDER === "azure-openai" || env.MODEL_PROVIDER === "azure-foundry";
}

function isProviderScopedModel(model: string) {
  return model.includes("/");
}

function unsupportedAzureOverrideMessage(model: string) {
  return `Model override ${model} is not configured for direct Azure routing. Clear the override or add an explicit MODEL_PROVIDER_ROUTES_JSON route before enabling Azure model traffic.`;
}

function configuredProviderRouteModels() {
  const raw = env.MODEL_PROVIDER_ROUTES_JSON;
  if (!raw) {
    return new Set<string>();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("MODEL_PROVIDER_ROUTES_JSON must be valid JSON.");
  }

  if (!Array.isArray(parsed)) {
    throw new Error("MODEL_PROVIDER_ROUTES_JSON must be an array.");
  }

  return new Set(parsed.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return [];
    }
    const model = (entry as { model?: unknown }).model;
    return typeof model === "string" && model.trim() ? [model.trim()] : [];
  }));
}

export function assertSupportedModelOverride(override?: string | null) {
  if (
    override
    && isAzureDirectProvider()
    && isProviderScopedModel(override)
    && !configuredProviderRouteModels().has(override)
  ) {
    throw new Error(unsupportedAzureOverrideMessage(override));
  }
}

export function resolveModel(tier: ModelTier, override?: string | null): string {
  const fallbackModel = tierModel(tier);
  if (!override) {
    return fallbackModel;
  }

  assertSupportedModelOverride(override);

  return override;
}
