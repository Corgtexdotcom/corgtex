#!/usr/bin/env node
import process from "node:process";

const REQUIRED_ENV = [
  "APP_URL",
  "NEXT_PUBLIC_APP_URL",
  "NEXT_PUBLIC_SITE_URL",
  "DATABASE_URL",
  "SESSION_COOKIE_SECRET",
  "ENCRYPTION_KEY",
  "MODEL_PROVIDER",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_PRICE_AI_USAGE_ID",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "MICROSOFT_CLIENT_ID",
  "MICROSOFT_CLIENT_SECRET",
  "RESEND_API_KEY",
  "EMAIL_FROM",
  "EMAIL_REPLY_TO",
  "WORKER_POLL_INTERVAL_MS",
  "WORKER_MAX_POLL_INTERVAL_MS",
  "WORKER_EVENT_BATCH_SIZE",
  "WORKER_JOB_BATCH_SIZE",
  "WORKER_HEALTH_PORT",
  "WORKER_SHUTDOWN_TIMEOUT_MS",
];

const REQUIRED_EMAIL_FROM_ADDRESS = "notifications@auth.corgtex.com";
const REQUIRED_EMAIL_REPLY_TO_ADDRESS = "support@corgtex.com";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SUPPORTED_MODEL_PROVIDERS = new Set(["openrouter", "openai", "azure-openai", "azure-foundry"]);
const AZURE_MODEL_PROVIDERS = new Set(["azure-openai", "azure-foundry"]);
const BUILT_IN_MODEL_PRICE_KEYS = new Set([
  "azure-foundry/corgtex-ds-v4-flash",
  "azure-foundry/corgtex-ds-v4-pro",
  "azure-foundry/corgtex-kimi-k25",
  "azure-foundry/corgtex-kimi-k27-code",
  "azure-foundry/corgtex-gpt56-luna",
  "azure-openai/corgtex-ds-v4-flash",
  "azure-openai/corgtex-ds-v4-pro",
  "azure-openai/corgtex-kimi-k25",
  "azure-openai/corgtex-kimi-k27-code",
  "azure-openai/corgtex-gpt56-luna",
]);
const MODEL_DEFAULTS = {
  MODEL_CHAT_DEFAULT: "deepseek/deepseek-v4-flash",
  MODEL_CHAT_FAST: "deepseek/deepseek-v4-flash",
  MODEL_CHAT_STANDARD: "deepseek/deepseek-v4-flash",
  MODEL_CHAT_QUALITY: "deepseek/deepseek-v4-pro",
  MODEL_CHAT_EXCELLENT: "deepseek/deepseek-r1-0528",
  MODEL_CHAT_CONVERSATION: "deepseek/deepseek-v4-pro",
  MODEL_EMBEDDING_DEFAULT: "google/gemini-embedding-001",
};
const MODEL_ENV_NAMES = Object.keys(MODEL_DEFAULTS);
let parsedModelPriceOverrides;

function arg(name) {
  const prefix = `--${name}=`;
  return process.argv.find((entry) => entry.startsWith(prefix))?.slice(prefix.length);
}

function pass(message) {
  console.log(`OK   ${message}`);
}

function warn(message) {
  console.log(`WARN ${message}`);
}

function fail(message) {
  console.error(`FAIL ${message}`);
  process.exitCode = 1;
}

function configured(name) {
  return Boolean(process.env[name]?.trim());
}

function envValue(name) {
  return process.env[name]?.trim() ?? "";
}

function looksLikeUuid(value) {
  return UUID_PATTERN.test(value);
}

function parseEmailAddress(value) {
  const raw = String(value ?? "").trim();
  const match = raw.match(/<([^<>]+)>/);
  return (match ? match[1] : raw).trim().toLowerCase();
}

function checkConfigured(name, strict, message) {
  if (configured(name)) {
    pass(`${name} configured`);
  } else if (strict) {
    fail(message ?? `${name} missing`);
  } else {
    warn(message ?? `${name} missing`);
  }
}

function providerLabel(provider) {
  if (provider === "azure-foundry") return "Azure Foundry";
  if (provider === "azure-openai") return "Azure OpenAI";
  if (provider === "openrouter") return "OpenRouter";
  if (provider === "openai") return "OpenAI";
  return provider || "model provider";
}

function isAzureProvider(provider) {
  return AZURE_MODEL_PROVIDERS.has(provider);
}

function priceKey(provider, model) {
  return `${provider.trim().toLowerCase()}/${model.trim().toLowerCase()}`;
}

function hasBuiltInModelPrice(provider, model) {
  return BUILT_IN_MODEL_PRICE_KEYS.has(priceKey(provider, model));
}

function modelNameFromEnv(name) {
  return envValue(name) || MODEL_DEFAULTS[name] || "";
}

function configuredModelNames() {
  const names = MODEL_ENV_NAMES.map(modelNameFromEnv).filter(Boolean);
  if (configured("MODEL_TRANSCRIPTION_DEFAULT")) {
    names.push(envValue("MODEL_TRANSCRIPTION_DEFAULT"));
  }
  return [...new Set(names)];
}

function parseModelPriceOverrides() {
  if (parsedModelPriceOverrides) {
    return parsedModelPriceOverrides;
  }

  if (!configured("MODEL_PRICE_OVERRIDES_JSON")) {
    parsedModelPriceOverrides = [];
    return parsedModelPriceOverrides;
  }

  let parsed;
  try {
    parsed = JSON.parse(envValue("MODEL_PRICE_OVERRIDES_JSON"));
  } catch {
    fail("MODEL_PRICE_OVERRIDES_JSON must be valid JSON.");
    parsedModelPriceOverrides = [];
    return parsedModelPriceOverrides;
  }

  if (!Array.isArray(parsed)) {
    fail("MODEL_PRICE_OVERRIDES_JSON must be an array.");
    parsedModelPriceOverrides = [];
    return parsedModelPriceOverrides;
  }

  parsedModelPriceOverrides = parsed.flatMap((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      fail(`MODEL_PRICE_OVERRIDES_JSON[${index}] must be an object.`);
      return [];
    }
    if (typeof entry.provider !== "string" || !entry.provider.trim() || typeof entry.model !== "string" || !entry.model.trim()) {
      fail(`MODEL_PRICE_OVERRIDES_JSON[${index}] requires provider and model strings.`);
      return [];
    }
    if (typeof entry.inputUsdPerToken !== "number" || !Number.isFinite(entry.inputUsdPerToken) || entry.inputUsdPerToken < 0) {
      fail(`MODEL_PRICE_OVERRIDES_JSON[${index}].inputUsdPerToken must be a non-negative number.`);
      return [];
    }
    if (typeof entry.outputUsdPerToken !== "number" || !Number.isFinite(entry.outputUsdPerToken) || entry.outputUsdPerToken < 0) {
      fail(`MODEL_PRICE_OVERRIDES_JSON[${index}].outputUsdPerToken must be a non-negative number.`);
      return [];
    }
    return [{
      provider: entry.provider.trim().toLowerCase(),
      model: entry.model.trim().toLowerCase(),
    }];
  });

  pass("MODEL_PRICE_OVERRIDES_JSON valid");
  return parsedModelPriceOverrides;
}

function requireKnownModelPrice(provider, model, strict) {
  const prices = configured("MODEL_PRICE_OVERRIDES_JSON") ? parseModelPriceOverrides() : [];
  const normalizedModel = model.trim().toLowerCase();
  const hasPrice = prices.some((price) => price.provider === provider && price.model === normalizedModel);
  if (hasPrice) {
    pass(`MODEL_PRICE_OVERRIDES_JSON includes ${provider}/${model}`);
  } else if (hasBuiltInModelPrice(provider, model)) {
    pass(`built-in price catalog includes ${provider}/${model}`);
  } else if (strict) {
    fail(`MODEL_PRICE_OVERRIDES_JSON missing price for ${provider}/${model}.`);
  } else {
    warn(`MODEL_PRICE_OVERRIDES_JSON missing price for ${provider}/${model}.`);
  }
}

function isHttpsBaseUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:";
  } catch {
    return false;
  }
}

function isTrustedAzureBaseUrl(provider, value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") {
      return false;
    }

    const host = url.hostname.toLowerCase();
    const path = url.pathname.replace(/\/+$/, "");
    const hasOpenAiPath = path === "/openai" || path.startsWith("/openai/");
    if (provider === "azure-foundry") {
      return host.endsWith(".services.ai.azure.com") && hasOpenAiPath;
    }
    if (provider === "azure-openai") {
      return host.endsWith(".openai.azure.com") && hasOpenAiPath;
    }
    return false;
  } catch {
    return false;
  }
}

function checkTrustedAzureAuthBaseUrl(provider, model, value, strict, authLabel) {
  const label = providerLabel(provider);
  if (value && isTrustedAzureBaseUrl(provider, value)) {
    pass(`${label} ${authLabel} route for ${model} uses a trusted Azure base URL`);
    return;
  }

  const message = `${label} ${authLabel} route for ${model} requires a trusted Azure OpenAI-compatible base URL.`;
  if (strict) {
    fail(message);
  } else {
    warn(message);
  }
}

function checkTrustedAzureManagedIdentityBaseUrl(provider, model, value, strict) {
  checkTrustedAzureAuthBaseUrl(provider, model, value, strict, "managed identity");
}

function checkTrustedAzureApiKeyBaseUrl(provider, model, value, strict) {
  checkTrustedAzureAuthBaseUrl(provider, model, value, strict, "API key");
}

function parseProviderRoutes() {
  if (!configured("MODEL_PROVIDER_ROUTES_JSON")) {
    return [];
  }

  let parsed;
  try {
    parsed = JSON.parse(envValue("MODEL_PROVIDER_ROUTES_JSON"));
  } catch {
    fail("MODEL_PROVIDER_ROUTES_JSON must be valid JSON.");
    return [];
  }

  if (!Array.isArray(parsed)) {
    fail("MODEL_PROVIDER_ROUTES_JSON must be an array.");
    return [];
  }

  const seenModels = new Set();
  return parsed.flatMap((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      fail(`MODEL_PROVIDER_ROUTES_JSON[${index}] must be an object.`);
      return [];
    }

    const route = entry;
    if (typeof route.model !== "string" || !route.model.trim() || typeof route.provider !== "string" || !route.provider.trim()) {
      fail(`MODEL_PROVIDER_ROUTES_JSON[${index}] requires model and provider strings.`);
      return [];
    }
    const model = route.model.trim();
    if (seenModels.has(model)) {
      fail(`MODEL_PROVIDER_ROUTES_JSON contains duplicate route for ${model}.`);
      return [];
    }
    seenModels.add(model);
    const normalizedProvider = route.provider.trim().toLowerCase();
    if (route.authMode !== undefined && route.authMode !== "api_key" && route.authMode !== "managed_identity") {
      fail(`MODEL_PROVIDER_ROUTES_JSON[${index}].authMode must be api_key or managed_identity.`);
      return [];
    }
    if (route.authMode === "managed_identity" && !isAzureProvider(normalizedProvider)) {
      fail(`MODEL_PROVIDER_ROUTES_JSON[${index}].authMode managed_identity is only supported for Azure routes.`);
      return [];
    }
    if (route.baseUrl !== undefined && (typeof route.baseUrl !== "string" || !route.baseUrl.trim())) {
      fail(`MODEL_PROVIDER_ROUTES_JSON[${index}].baseUrl must be a non-empty string when set.`);
      return [];
    }
    if (typeof route.baseUrl === "string" && route.baseUrl.trim() && !isHttpsBaseUrl(route.baseUrl.trim())) {
      fail(`MODEL_PROVIDER_ROUTES_JSON[${index}].baseUrl must be an HTTPS URL.`);
      return [];
    }
    if (route.apiKeyEnv !== undefined && (typeof route.apiKeyEnv !== "string" || !route.apiKeyEnv.trim())) {
      fail(`MODEL_PROVIDER_ROUTES_JSON[${index}].apiKeyEnv must be a non-empty string when set.`);
      return [];
    }

    return [{
      model,
      provider: normalizedProvider,
      baseUrl: typeof route.baseUrl === "string" ? route.baseUrl.trim() : "",
      authMode: typeof route.authMode === "string" ? route.authMode : "",
      apiKeyEnv: typeof route.apiKeyEnv === "string" ? route.apiKeyEnv.trim() : "",
      scope: typeof route.scope === "string" ? route.scope.trim() : "",
    }];
  });
}

function routeForModel(routes, model) {
  return routes.find((route) => route.model === model);
}

function resolvedProviderForModel(globalProvider, routes, model) {
  return routeForModel(routes, model)?.provider ?? globalProvider;
}

function checkEmailSenderConfiguration() {
  if (configured("EMAIL_FROM")) {
    const fromAddress = parseEmailAddress(envValue("EMAIL_FROM"));
    if (fromAddress === REQUIRED_EMAIL_FROM_ADDRESS) {
      pass(`EMAIL_FROM uses ${REQUIRED_EMAIL_FROM_ADDRESS}`);
    } else {
      fail(`EMAIL_FROM must use ${REQUIRED_EMAIL_FROM_ADDRESS}; got ${fromAddress || "empty"}`);
    }
  }

  if (configured("EMAIL_REPLY_TO")) {
    const replyToAddress = parseEmailAddress(envValue("EMAIL_REPLY_TO"));
    if (replyToAddress === REQUIRED_EMAIL_REPLY_TO_ADDRESS) {
      pass(`EMAIL_REPLY_TO uses ${REQUIRED_EMAIL_REPLY_TO_ADDRESS}`);
    } else {
      fail(`EMAIL_REPLY_TO must use ${REQUIRED_EMAIL_REPLY_TO_ADDRESS}; got ${replyToAddress || "empty"}`);
    }
  }
}

function checkHttpBaseUrlEnv(name, label, strict) {
  if (!configured(name)) {
    checkConfigured(name, strict, `${name} missing for ${label}.`);
    return;
  }

  if (isHttpsBaseUrl(envValue(name))) {
    pass(`${name} configured`);
  } else if (strict) {
    fail(`${name} must be an HTTPS URL for ${label}.`);
  } else {
    warn(`${name} must be an HTTPS URL for ${label}.`);
  }
}

function checkOptionalHttpBaseUrlEnv(name, label, strict) {
  if (!configured(name)) {
    return;
  }

  if (isHttpsBaseUrl(envValue(name))) {
    pass(`${name} configured`);
  } else if (strict) {
    fail(`${name} must be an HTTPS URL for ${label}.`);
  } else {
    warn(`${name} must be an HTTPS URL for ${label}.`);
  }
}

async function checkEndpoint(baseUrl, path, predicate, label) {
  try {
    const response = await fetch(new URL(path, baseUrl));
    const text = await response.text();
    if (!response.ok || !predicate(text, response)) {
      fail(`${label} returned unexpected response (${response.status})`);
      return;
    }
    pass(label);
  } catch (error) {
    fail(`${label} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function checkProviderRouteConfiguration(strict) {
  const routes = parseProviderRoutes();
  if (routes.length === 0) {
    return;
  }

  pass("MODEL_PROVIDER_ROUTES_JSON valid");

  const globalProvider = envValue("MODEL_PROVIDER") || "openrouter";
  for (const route of routes) {
    const label = providerLabel(route.provider);
    if (!SUPPORTED_MODEL_PROVIDERS.has(route.provider)) {
      fail(`MODEL_PROVIDER_ROUTES_JSON route for ${route.model} uses unsupported provider ${route.provider}.`);
      continue;
    }

    if (route.baseUrl || route.provider === globalProvider) {
      pass(`MODEL_PROVIDER_ROUTES_JSON route for ${route.model} has ${label} base URL`);
    } else if (strict) {
      fail(`MODEL_PROVIDER_ROUTES_JSON route for ${route.model} requires baseUrl.`);
    } else {
      warn(`MODEL_PROVIDER_ROUTES_JSON route for ${route.model} requires baseUrl.`);
    }

    if (isAzureProvider(route.provider)) {
      requireKnownModelPrice(route.provider, route.model, strict);
      const authMode = route.authMode || envValue("AZURE_OPENAI_AUTH_MODE") || "api_key";
      if (authMode === "managed_identity") {
        checkTrustedAzureManagedIdentityBaseUrl(
          route.provider,
          route.model,
          route.baseUrl || (route.provider === globalProvider ? envValue("MODEL_BASE_URL") : ""),
          strict,
        );
        pass(`MODEL_PROVIDER_ROUTES_JSON route for ${route.model} uses managed identity`);
        if (configured("AZURE_CLIENT_ID")) {
          pass("AZURE_CLIENT_ID configured");
        } else {
          warn(`${label} route for ${route.model} will rely on system-assigned managed identity.`);
        }
        continue;
      }

      if (authMode !== "api_key") {
        fail(`MODEL_PROVIDER_ROUTES_JSON route for ${route.model} authMode must be api_key or managed_identity.`);
        continue;
      }

      const routeBaseUrl = route.baseUrl || (route.provider === globalProvider ? envValue("MODEL_BASE_URL") : "");
      if (routeBaseUrl) {
        checkTrustedAzureApiKeyBaseUrl(route.provider, route.model, routeBaseUrl, strict);
      }
      if (route.apiKeyEnv) {
        checkConfigured(route.apiKeyEnv, strict, `${route.apiKeyEnv} missing for ${label} route ${route.model}.`);
      } else if (route.provider !== globalProvider || route.baseUrl) {
        const message = `${label} route for ${route.model} requires apiKeyEnv when using Azure API key authentication with a routed endpoint.`;
        if (strict) {
          fail(message);
        } else {
          warn(message);
        }
      } else if (configured("AZURE_OPENAI_API_KEY") || configured("MODEL_API_KEY")) {
        pass(`${label} API key configured for route ${route.model}`);
      } else {
        checkConfigured("AZURE_OPENAI_API_KEY", strict, `AZURE_OPENAI_API_KEY or MODEL_API_KEY missing for ${label} route ${route.model}.`);
      }
      continue;
    }

    if (route.apiKeyEnv) {
      checkConfigured(route.apiKeyEnv, strict, `${route.apiKeyEnv} missing for ${label} route ${route.model}.`);
    } else if (route.provider !== globalProvider) {
      if (strict) {
        fail(`${label} route for ${route.model} requires apiKeyEnv when provider differs from MODEL_PROVIDER.`);
      } else {
        warn(`${label} route for ${route.model} requires apiKeyEnv when provider differs from MODEL_PROVIDER.`);
      }
    } else if (route.baseUrl) {
      if (strict) {
        fail(`${label} route for ${route.model} requires apiKeyEnv when overriding baseUrl.`);
      } else {
        warn(`${label} route for ${route.model} requires apiKeyEnv when overriding baseUrl.`);
      }
    } else {
      checkConfigured("MODEL_API_KEY", strict, `MODEL_API_KEY missing for ${label} route ${route.model}.`);
    }
  }
}

function checkModelConfiguration(strict) {
  const provider = envValue("MODEL_PROVIDER") || "openrouter";
  if (provider === "fake") {
    warn("MODEL_PROVIDER is fake; do not use this for production launch.");
    return;
  }

  if (!SUPPORTED_MODEL_PROVIDERS.has(provider)) {
    fail(`MODEL_PROVIDER must be one of ${[...SUPPORTED_MODEL_PROVIDERS].join(", ")}.`);
    return;
  }

  const label = providerLabel(provider);
  if (isAzureProvider(provider)) {
    const routes = parseProviderRoutes();
    checkHttpBaseUrlEnv("MODEL_BASE_URL", label, strict);
    for (const model of configuredModelNames()) {
      const resolvedProvider = resolvedProviderForModel(provider, routes, model);
      if (isAzureProvider(resolvedProvider)) {
        requireKnownModelPrice(resolvedProvider, model, strict);
      }
    }
    const authMode = envValue("AZURE_OPENAI_AUTH_MODE") || "api_key";
    if (authMode === "managed_identity") {
      checkTrustedAzureManagedIdentityBaseUrl(provider, "global model traffic", envValue("MODEL_BASE_URL"), strict);
      pass("AZURE_OPENAI_AUTH_MODE configured for managed identity");
      if (configured("AZURE_CLIENT_ID")) {
        pass("AZURE_CLIENT_ID configured");
      } else {
        warn(`AZURE_CLIENT_ID missing; ${label} will rely on system-assigned managed identity.`);
      }
      return;
    }
    if (authMode !== "api_key") {
      fail("AZURE_OPENAI_AUTH_MODE must be api_key or managed_identity.");
      return;
    }
    checkTrustedAzureApiKeyBaseUrl(provider, "global model traffic", envValue("MODEL_BASE_URL"), strict);
    if (configured("AZURE_OPENAI_API_KEY") || configured("MODEL_API_KEY")) {
      pass(`${label} API key configured`);
    } else {
      checkConfigured("AZURE_OPENAI_API_KEY", strict, `AZURE_OPENAI_API_KEY or MODEL_API_KEY missing for ${label} API key auth.`);
    }
    return;
  }

  checkOptionalHttpBaseUrlEnv("MODEL_BASE_URL", label, strict);
  checkConfigured("MODEL_API_KEY", strict, "MODEL_API_KEY missing for OpenAI-compatible model provider.");
}

async function main() {
  const strict = process.argv.includes("--strict");
  const skipHttp = process.argv.includes("--skip-http");
  const baseUrl = arg("base-url") || process.env.SELF_SERVE_READINESS_BASE_URL || process.env.APP_URL;

  for (const name of REQUIRED_ENV) {
    if (configured(name)) {
      pass(`${name} configured`);
    } else if (strict) {
      fail(`${name} missing`);
    } else {
      warn(`${name} missing`);
    }
  }

  const microsoftClientSecret = envValue("MICROSOFT_CLIENT_SECRET");
  if (microsoftClientSecret && looksLikeUuid(microsoftClientSecret)) {
    fail("MICROSOFT_CLIENT_SECRET looks like an Entra Secret ID. Use the client secret Value instead.");
  }

  checkEmailSenderConfiguration();
  checkModelConfiguration(strict);
  checkProviderRouteConfiguration(strict);

  if (skipHttp) {
    pass("HTTP readiness checks skipped by request");
    return;
  }

  if (!baseUrl) {
    warn("No base URL supplied; skipping HTTP readiness checks");
    return;
  }

  await checkEndpoint(baseUrl, "/api/health", (text) => {
    const body = JSON.parse(text);
    return body.status === "ok" && body.service === "web" && body.database === "up";
  }, "/api/health reports ready web/database state");

  await checkEndpoint(baseUrl, "/api/procurement/v1/product", (text) => {
    const body = JSON.parse(text);
    return Boolean(body.procurementApi?.trialCreateUrl && body.trial?.trialDays === 30);
  }, "procurement product metadata advertises 30-day trial");

  await checkEndpoint(baseUrl, "/api/procurement/v1/openapi.json", (text) => {
    const body = JSON.parse(text);
    return Boolean(body.paths?.["/trials"]?.post && body.paths?.["/trials/{trialId}"]?.get);
  }, "procurement OpenAPI exposes trial create/status");

  await checkEndpoint(baseUrl, "/.well-known/agent-card.json", (text) => {
    const body = JSON.parse(text);
    return Array.isArray(body.capabilities) && body.capabilities.includes("instant_limited_trial");
  }, "agent card exposes instant limited trial capability");
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
