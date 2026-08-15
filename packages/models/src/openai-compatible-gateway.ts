import { env, cosineSimilarity } from "@corgtex/shared";
import { DefaultAzureCredential } from "@azure/identity";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatStreamEvent,
  EmbeddingRequest,
  ExtractionRequest,
  ModelGateway,
  ModelUsageInput,
  RerankRequest,
  AudioTranscriptionRequest,
} from "./contracts";
import { assertCatalogModelBudget, assertWorkspaceModelBudget, recordModelUsage } from "./usage";
import { estimateModelCost, getModelPrice } from "./pricing";

type UsageDetails = {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  estimatedCostUsd: string;
  rawProviderCostUsd: string;
  billableCostUsd: string;
};

type ChatCompletionApiResponse = {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
      tool_calls?: import("./contracts").ToolCall[];
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
};

type EmbeddingApiResponse = {
  data?: Array<{
    embedding?: number[];
  }>;
  usage?: {
    prompt_tokens?: number;
  };
};

type AudioTranscriptionApiResponse = {
  text?: string;
};

type AzureOpenAiAuthMode = "api_key" | "managed_identity";

type ModelProviderRoute = {
  model: string;
  provider: string;
  baseUrl?: string;
  authMode?: AzureOpenAiAuthMode;
  apiKeyEnv?: string;
  scope?: string;
};

const REQUEST_TIMEOUT_MS = env.MODEL_REQUEST_TIMEOUT_MS;
const STREAM_TIMEOUT_MS = 120_000;
const MAX_REQUEST_RETRIES = 2;
const OPENROUTER_TITLE = "Corgtex";
const AZURE_TOKEN_REFRESH_SKEW_MS = 60_000;
const AZURE_FOUNDRY_SCOPE = "https://ai.azure.com/.default";
const AZURE_OPENAI_SCOPE = "https://cognitiveservices.azure.com/.default";
const SUPPORTED_MODEL_PROVIDERS = new Set(["openrouter", "openai", "azure-openai", "azure-foundry"]);
const BUILT_IN_TEMPERATURE_UNSUPPORTED_MODELS = new Set([
  "corgtex-gpt56-luna",
  "corgtex-gpt56-terra",
  "corgtex-gpt56-sol",
]);

class ExtractionParseError extends Error {
  readonly raw: string;
  readonly repairedRaw?: string;

  constructor(message: string, options: {
    raw: string;
    repairedRaw?: string;
  }) {
    super(message);
    this.name = "ExtractionParseError";
    this.raw = options.raw;
    this.repairedRaw = options.repairedRaw;
  }
}

let azureCredential: DefaultAzureCredential | null = null;
const azureAccessTokenCache = new Map<string, {
  token: string;
  expiresOnTimestamp: number;
}>();

function routeStringField(record: Record<string, unknown>, field: string) {
  const value = record[field];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isHttpsBaseUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.port && !url.search && !url.hash;
  } catch {
    return false;
  }
}

function parseModelProviderRoutes() {
  const raw = env.MODEL_PROVIDER_ROUTES_JSON;
  if (!raw) {
    return [];
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

  const seenModels = new Set<string>();
  return parsed.map((entry, index): ModelProviderRoute => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`MODEL_PROVIDER_ROUTES_JSON[${index}] must be an object.`);
    }

    const record = entry as Record<string, unknown>;
    const model = routeStringField(record, "model");
    const provider = routeStringField(record, "provider");
    const authModeRaw = routeStringField(record, "authMode");
    if (!model || !provider) {
      throw new Error(`MODEL_PROVIDER_ROUTES_JSON[${index}] requires model and provider strings.`);
    }
    const normalizedProvider = provider.toLowerCase();
    if (!SUPPORTED_MODEL_PROVIDERS.has(normalizedProvider)) {
      throw new Error(`MODEL_PROVIDER_ROUTES_JSON[${index}].provider must be one of ${[...SUPPORTED_MODEL_PROVIDERS].join(", ")}.`);
    }
    if (seenModels.has(model)) {
      throw new Error(`MODEL_PROVIDER_ROUTES_JSON contains duplicate route for ${model}.`);
    }
    seenModels.add(model);
    if (authModeRaw && authModeRaw !== "api_key" && authModeRaw !== "managed_identity") {
      throw new Error(`MODEL_PROVIDER_ROUTES_JSON[${index}].authMode must be api_key or managed_identity.`);
    }
    const authMode = authModeRaw as AzureOpenAiAuthMode | undefined;
    if (authMode === "managed_identity" && !isAzureProvider(normalizedProvider)) {
      throw new Error(`MODEL_PROVIDER_ROUTES_JSON[${index}].authMode managed_identity is only supported for Azure routes.`);
    }
    const routeBaseUrl = routeStringField(record, "baseUrl");
    if (routeBaseUrl && !isHttpsBaseUrl(routeBaseUrl)) {
      throw new Error(`MODEL_PROVIDER_ROUTES_JSON[${index}].baseUrl must be an HTTPS URL without query or fragment, credentials, or non-default port.`);
    }

    return {
      model,
      provider: normalizedProvider,
      baseUrl: routeBaseUrl,
      authMode,
      apiKeyEnv: routeStringField(record, "apiKeyEnv"),
      scope: routeStringField(record, "scope"),
    };
  });
}

function providerRouteForModel(model: string) {
  return parseModelProviderRoutes().find((route) => route.model === model);
}

function providerForRoute(route?: ModelProviderRoute) {
  return route?.provider ?? env.MODEL_PROVIDER;
}

function baseUrl(route?: ModelProviderRoute) {
  if (route?.baseUrl) {
    return route.baseUrl.replace(/\/+$/, "");
  }

  if (route && route.provider !== env.MODEL_PROVIDER) {
    throw new Error(`MODEL_PROVIDER_ROUTES_JSON route for ${route.model} requires baseUrl when provider differs from MODEL_PROVIDER.`);
  }

  if (!env.MODEL_BASE_URL) {
    return "https://api.openai.com/v1";
  }
  if (!isHttpsBaseUrl(env.MODEL_BASE_URL)) {
    throw new Error("MODEL_BASE_URL must be an HTTPS URL without query or fragment, credentials, or non-default port.");
  }
  return env.MODEL_BASE_URL.replace(/\/+$/, "");
}

function optionalSecretEnv(name: string) {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : undefined;
}

function requireApiKey(route?: ModelProviderRoute) {
  if (route?.apiKeyEnv) {
    const routeKey = optionalSecretEnv(route.apiKeyEnv);
    if (!routeKey) {
      throw new Error(`${route.apiKeyEnv} is required for routed OpenAI-compatible provider authentication.`);
    }
    return routeKey;
  }

  if (route && route.provider !== env.MODEL_PROVIDER) {
    throw new Error(`MODEL_PROVIDER_ROUTES_JSON route for ${route.model} requires apiKeyEnv when provider differs from MODEL_PROVIDER.`);
  }

  if (route?.baseUrl) {
    throw new Error(`MODEL_PROVIDER_ROUTES_JSON route for ${route.model} requires apiKeyEnv when overriding baseUrl.`);
  }

  const key = env.MODEL_API_KEY;
  if (!key) {
    throw new Error("MODEL_API_KEY is required for the OpenAI-compatible model provider.");
  }

  return key;
}

function requireAzureApiKey(route?: ModelProviderRoute) {
  if (route?.apiKeyEnv) {
    const routeKey = optionalSecretEnv(route.apiKeyEnv);
    if (!routeKey) {
      throw new Error(`${route.apiKeyEnv} is required for routed Azure API key authentication.`);
    }
    return routeKey;
  }

  if (route && (route.provider !== env.MODEL_PROVIDER || route.baseUrl)) {
    throw new Error(`MODEL_PROVIDER_ROUTES_JSON route for ${route.model} requires apiKeyEnv when using Azure API key authentication with a routed endpoint.`);
  }

  const usesGlobalEndpoint = !route || (route.provider === env.MODEL_PROVIDER && !route.baseUrl);
  const key = env.AZURE_OPENAI_API_KEY ?? (usesGlobalEndpoint ? env.MODEL_API_KEY : undefined);
  if (!key) {
    throw new Error(route
      ? "AZURE_OPENAI_API_KEY is required for Azure API key authentication."
      : "AZURE_OPENAI_API_KEY or MODEL_API_KEY is required for Azure OpenAI API key authentication.");
  }

  return key;
}

function usageDetails(input: ModelUsageInput): UsageDetails {
  return {
    provider: input.provider,
    model: input.model,
    inputTokens: input.inputTokens ?? 0,
    outputTokens: input.outputTokens ?? 0,
    latencyMs: input.latencyMs ?? 0,
    estimatedCostUsd: input.estimatedCostUsd ?? "0.000000",
    rawProviderCostUsd: input.rawProviderCostUsd ?? "0.000000",
    billableCostUsd: input.billableCostUsd ?? input.estimatedCostUsd ?? "0.000000",
  };
}

function usageContext(request: {
  catalogItemId?: string | null;
  agentCredentialId?: string | null;
}) {
  return {
    catalogItemId: request.catalogItemId ?? undefined,
    agentCredentialId: request.agentCredentialId ?? undefined,
  };
}

function costFields(provider: string, model: string, inputTokens: number, outputTokens: number) {
  return estimateModelCost({
    provider,
    model,
    inputTokens,
    outputTokens,
  }) ?? {};
}

function estimateTextTokens(value: string) {
  return Math.ceil(value.length / 4);
}

function estimateSerializedTokens(value: unknown) {
  if (value === undefined || value === null) {
    return 0;
  }
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  return serialized ? estimateTextTokens(serialized) : 0;
}

function estimateChatOutputTokens(content: string, toolCalls?: unknown[]) {
  const compactToolCalls = toolCalls?.filter(Boolean);
  return estimateTextTokens(content) +
    estimateSerializedTokens(compactToolCalls && compactToolCalls.length > 0 ? compactToolCalls : undefined);
}

function requiresKnownModelPrice(provider: string) {
  return provider === "azure-openai" || provider === "azure-foundry";
}

function assertKnownModelPrice(provider: string, model: string) {
  if (!requiresKnownModelPrice(provider)) {
    return;
  }

  if (!getModelPrice(provider, model)) {
    throw new Error(`Missing model price for ${provider}/${model}. Configure MODEL_PRICE_OVERRIDES_JSON before enabling this Azure deployment.`);
  }
}

function isOpenRouterProvider(provider = env.MODEL_PROVIDER) {
  return provider === "openrouter";
}

function isAzureOpenAiProvider(provider = env.MODEL_PROVIDER) {
  return provider === "azure-openai";
}

function isAzureProvider(provider = env.MODEL_PROVIDER) {
  return isAzureOpenAiProvider(provider) || provider === "azure-foundry";
}

function isTrustedAzureBaseUrl(provider: string, value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }

  if (url.protocol !== "https:") {
    return false;
  }
  if (url.username || url.password || url.port) {
    return false;
  }

  const host = url.hostname.toLowerCase();
  const path = url.pathname.replace(/\/+$/, "");
  const hasOpenAiV1BasePath = path === "/openai/v1" && !url.search && !url.hash;
  if (provider === "azure-foundry") {
    return host.endsWith(".services.ai.azure.com") && hasOpenAiV1BasePath;
  }

  if (provider === "azure-openai") {
    return host.endsWith(".openai.azure.com") && hasOpenAiV1BasePath;
  }

  return false;
}

function assertTrustedAzureAuthBaseUrl(provider: string, route: ModelProviderRoute | undefined, authLabel: string) {
  const resolvedBaseUrl = baseUrl(route);
  if (!isTrustedAzureBaseUrl(provider, resolvedBaseUrl)) {
    throw new Error(`${provider} ${authLabel} authentication requires a trusted Azure OpenAI-compatible /openai/v1 base URL.`);
  }
}

function assertTrustedAzureManagedIdentityBaseUrl(provider: string, route?: ModelProviderRoute) {
  assertTrustedAzureAuthBaseUrl(provider, route, "managed identity");
}

function assertTrustedAzureApiKeyBaseUrl(provider: string, route?: ModelProviderRoute) {
  assertTrustedAzureAuthBaseUrl(provider, route, "API key");
}

function azureCredentialClient() {
  if (!azureCredential) {
    azureCredential = new DefaultAzureCredential({
      managedIdentityClientId: env.AZURE_CLIENT_ID,
    });
  }
  return azureCredential;
}

function defaultAzureScope(provider: string) {
  return provider === "azure-foundry" ? AZURE_FOUNDRY_SCOPE : AZURE_OPENAI_SCOPE;
}

function azureAccessScope(route?: ModelProviderRoute) {
  if (route?.scope) {
    return route.scope;
  }
  if (!route || route.provider === env.MODEL_PROVIDER) {
    return env.AZURE_OPENAI_SCOPE;
  }
  return defaultAzureScope(route.provider);
}

async function getAzureAccessToken(scope: string) {
  const cached = azureAccessTokenCache.get(scope);
  if (
    cached &&
    cached.expiresOnTimestamp - AZURE_TOKEN_REFRESH_SKEW_MS > Date.now()
  ) {
    return cached.token;
  }

  const token = await azureCredentialClient().getToken(scope);
  if (!token?.token || !token.expiresOnTimestamp) {
    throw new Error("Failed to acquire Azure OpenAI managed identity token.");
  }

  azureAccessTokenCache.set(scope, {
    token: token.token,
    expiresOnTimestamp: token.expiresOnTimestamp,
  });
  return token.token;
}

async function requestHeaders(route?: ModelProviderRoute) {
  return {
    "content-type": "application/json",
    ...await authHeaders(route),
  };
}

async function authHeaders(route?: ModelProviderRoute) {
  const provider = providerForRoute(route);
  const headers: Record<string, string> = {
  };

  if (isAzureProvider(provider)) {
    const authMode = route?.authMode ?? env.AZURE_OPENAI_AUTH_MODE;
    if (authMode === "managed_identity") {
      assertTrustedAzureManagedIdentityBaseUrl(provider, route);
      headers.authorization = `Bearer ${await getAzureAccessToken(azureAccessScope(route))}`;
    } else {
      assertTrustedAzureApiKeyBaseUrl(provider, route);
      headers["api-key"] = requireAzureApiKey(route);
    }
    return headers;
  }

  headers.authorization = `Bearer ${requireApiKey(route)}`;

  if (isOpenRouterProvider(provider)) {
    headers["HTTP-Referer"] = env.APP_URL;
    headers["X-Title"] = OPENROUTER_TITLE;
  }

  return headers;
}

function withProviderOptions(provider: string, body: Record<string, unknown>) {
  if (!isOpenRouterProvider(provider)) {
    return body;
  }

  return {
    ...body,
    provider: {
      allow_fallbacks: true,
      data_collection: "deny",
      require_parameters: true,
    },
  };
}

function supportsCustomTemperature(model: string) {
  if (BUILT_IN_TEMPERATURE_UNSUPPORTED_MODELS.has(model)) {
    return false;
  }

  return !(env.MODEL_OMIT_TEMPERATURE_MODELS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .includes(model);
}

function chatCompletionBody(model: string, body: Record<string, unknown>) {
  if (supportsCustomTemperature(model)) {
    return body;
  }

  const { temperature: _temperature, ...withoutTemperature } = body;
  return withoutTemperature;
}

function retryDelayMs(attempt: number) {
  return 250 * 2 ** attempt;
}

function isRetryableStatus(status: number) {
  return status === 429 || status >= 500;
}

function isRetryableRequestError(error: unknown) {
  if (!(error instanceof Error)) {
    return false;
  }

  if (error instanceof SyntaxError) {
    return false;
  }

  return error.name === "AbortError" || error.name === "TimeoutError" || error instanceof TypeError;
}

function abortedError(signal?: AbortSignal) {
  if (signal?.reason instanceof Error) {
    return signal.reason;
  }
  return new DOMException("The operation was aborted.", "AbortError");
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw abortedError(signal);
  }
}

function timeoutSignal(parentSignal: AbortSignal | undefined, timeoutMs: number) {
  const timerSignal = AbortSignal.timeout(timeoutMs);
  if (!parentSignal) {
    return {
      signal: timerSignal,
      cleanup() {},
    };
  }

  const controller = new AbortController();
  const abortFromParent = () => {
    if (!controller.signal.aborted) controller.abort(parentSignal.reason);
  };
  const abortFromTimer = () => {
    if (!controller.signal.aborted) controller.abort(timerSignal.reason);
  };
  parentSignal.addEventListener("abort", abortFromParent, { once: true });
  timerSignal.addEventListener("abort", abortFromTimer, { once: true });
  if (parentSignal.aborted) {
    abortFromParent();
  } else if (timerSignal.aborted) {
    abortFromTimer();
  }

  return {
    signal: controller.signal,
    cleanup() {
      parentSignal.removeEventListener("abort", abortFromParent);
      timerSignal.removeEventListener("abort", abortFromTimer);
    },
  };
}

async function sleep(ms: number, signal?: AbortSignal) {
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const cleanup = () => {
      signal?.removeEventListener("abort", abort);
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const abort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(abortedError(signal));
    };
    timeout = setTimeout(finish, ms);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      abort();
    }
  });
  throwIfAborted(signal);
}

async function postJson<TResponse>(path: string, body: Record<string, unknown>, route?: ModelProviderRoute, signal?: AbortSignal) {
  const provider = providerForRoute(route);
  const payload = JSON.stringify(withProviderOptions(provider, body));
  let lastError: unknown = null;

  for (let attempt = 0; attempt <= MAX_REQUEST_RETRIES; attempt += 1) {
    try {
      throwIfAborted(signal);
      const fetchSignal = timeoutSignal(signal, REQUEST_TIMEOUT_MS);
      try {
        const response = await fetch(`${baseUrl(route)}${path}`, {
          method: "POST",
          headers: await requestHeaders(route),
          body: payload,
          signal: fetchSignal.signal,
        });

        if (!response.ok) {
          const errorText = await response.text();
          const error = new Error(`OpenAI-compatible request failed (${response.status}): ${errorText}`);
          if (attempt < MAX_REQUEST_RETRIES && isRetryableStatus(response.status)) {
            lastError = error;
            await sleep(retryDelayMs(attempt), signal);
            continue;
          }
          throw error;
        }

        const parsed = await response.json() as TResponse;
        throwIfAborted(fetchSignal.signal);
        return parsed;
      } finally {
        fetchSignal.cleanup();
      }
    } catch (error) {
      if (signal?.aborted || attempt >= MAX_REQUEST_RETRIES || !isRetryableRequestError(error)) {
        throw error;
      }

      lastError = error;
      await sleep(retryDelayMs(attempt), signal);
    }
  }

  throw lastError ?? new Error("OpenAI-compatible request failed after retries.");
}

function normalizeContent(content: string | Array<{ type?: string; text?: string }> | undefined) {
  if (typeof content === "string") {
    return content;
  }

  return (content ?? [])
    .map((part) => part.text ?? "")
    .filter(Boolean)
    .join("\n");
}


function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function tryParseJsonObject(input: string) {
  try {
    const parsed = JSON.parse(input) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function stripCodeFences(input: string) {
  const trimmed = input.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match?.[1]?.trim() ?? trimmed;
}

function extractOuterJsonObject(input: string) {
  const start = input.indexOf("{");
  if (start < 0) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaping = false;

  for (let index = start; index < input.length; index += 1) {
    const char = input[index];

    if (escaping) {
      escaping = false;
      continue;
    }

    if (char === "\\" && inString) {
      escaping = true;
      continue;
    }

    if (char === "\"") {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (char === "{") {
      depth += 1;
      continue;
    }

    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return input.slice(start, index + 1);
      }
    }
  }

  return null;
}

function parseExtractionObject(raw: string) {
  const trimmed = raw.trim();
  const stripped = stripCodeFences(trimmed);
  const candidates = [
    trimmed,
    stripped,
    extractOuterJsonObject(stripped),
    extractOuterJsonObject(trimmed),
  ].filter((candidate, index, values): candidate is string => {
    return typeof candidate === "string" && candidate.length > 0 && values.indexOf(candidate) === index;
  });

  for (const candidate of candidates) {
    const parsed = tryParseJsonObject(candidate);
    if (parsed) {
      return parsed;
    }
  }

  return null;
}

async function recordUsage(input: ModelUsageInput) {
  await recordModelUsage(input);
  return usageDetails(input);
}

async function completeChat(
  request: ChatCompletionRequest,
  taskType: ModelUsageInput["taskType"],
  modelOverride?: string,
  bodyExtras?: Record<string, unknown>,
) {
  const startedAt = Date.now();
  const model = modelOverride ?? request.model ?? env.MODEL_CHAT_DEFAULT;
  const route = providerRouteForModel(model);
  const provider = providerForRoute(route);
  assertKnownModelPrice(provider, model);
  await assertWorkspaceModelBudget(request.workspaceId);
  await assertCatalogModelBudget({
    workspaceId: request.workspaceId,
    ...usageContext(request),
  });
  const body = chatCompletionBody(model, {
    model,
    temperature: 0.2,
    messages: request.messages,
    ...(request.tools && request.tools.length > 0 ? { tools: request.tools } : {}),
    ...(request.tool_choice ? { tool_choice: request.tool_choice } : {}),
    ...(bodyExtras ?? {}),
  });
  const response = await postJson<ChatCompletionApiResponse>("/chat/completions", body, route, request.signal);
  const latencyMs = Date.now() - startedAt;
  const content = normalizeContent(response.choices?.[0]?.message?.content);
  const tool_calls = response.choices?.[0]?.message?.tool_calls;
  const inputTokens = response.usage?.prompt_tokens ?? estimateSerializedTokens(withProviderOptions(provider, body));
  const outputTokens = response.usage?.completion_tokens ?? estimateChatOutputTokens(content, tool_calls);
  const usage = await recordUsage({
    workspaceId: request.workspaceId,
    workflowJobId: request.workflowJobId,
    agentRunId: request.agentRunId,
    ...usageContext(request),
    provider,
    model,
    taskType,
    inputTokens,
    outputTokens,
    latencyMs,
    ...costFields(provider, model, inputTokens, outputTokens),
  });

  return { content, tool_calls, usage };
}

class ChatStreamProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChatStreamProtocolError";
  }
}

type PartialToolCall = {
  id: string;
  name: string;
  arguments: string;
};

function appendToolCallDelta(toolCalls: Map<number, PartialToolCall>, value: unknown): ChatStreamEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ChatStreamProtocolError("Streamed tool call delta must be an object.");
  const tool = value as Record<string, unknown>;
  const index = tool.index;
  if (!Number.isInteger(index) || (index as number) < 0) throw new ChatStreamProtocolError("Streamed tool call index must be a non-negative integer.");
  if (tool.type != null && tool.type !== "function") throw new ChatStreamProtocolError("Streamed tool call type must be function.");
  if (tool.id != null && typeof tool.id !== "string") throw new ChatStreamProtocolError("Streamed tool call id fragment must be a string.");
  if (tool.function != null && (typeof tool.function !== "object" || Array.isArray(tool.function))) throw new ChatStreamProtocolError("Streamed tool call function delta must be an object.");
  const fn = (tool.function ?? {}) as Record<string, unknown>;
  if (fn.name != null && typeof fn.name !== "string") throw new ChatStreamProtocolError("Streamed tool call name fragment must be a string.");
  if (fn.arguments != null && typeof fn.arguments !== "string") throw new ChatStreamProtocolError("Streamed tool call arguments fragment must be a string.");
  const idDelta = (tool.id ?? undefined) as string | undefined;
  const nameDelta = (fn.name ?? undefined) as string | undefined;
  const argumentsDelta = (fn.arguments as string | undefined) ?? "";
  const partial = toolCalls.get(index as number) ?? { id: "", name: "", arguments: "" };
  partial.id += idDelta ?? "";
  partial.name += nameDelta ?? "";
  partial.arguments += argumentsDelta;
  toolCalls.set(index as number, partial);
  return { type: "tool_call_delta", index: index as number, ...(idDelta !== undefined ? { idDelta } : {}), ...(nameDelta !== undefined ? { nameDelta } : {}), argumentsDelta };
}

function completeToolCalls(toolCalls: Map<number, PartialToolCall>) {
  return [...toolCalls.entries()].sort(([left], [right]) => left - right).map(([index, tool], position) => {
    if (index !== position) throw new ChatStreamProtocolError("Streamed tool call indexes must be contiguous from zero.");
    if (!tool.id || !tool.name) throw new ChatStreamProtocolError("Streamed tool call ended without a complete id and function name.");
    return { id: tool.id, type: "function" as const, function: { name: tool.name, arguments: tool.arguments } };
  });
}
type StreamUsage = Record<string, unknown> & { prompt_tokens?: number; completion_tokens?: number };
function validateStreamUsage(value: unknown, requireTokens: boolean) {
  if (value == null) { if (requireTokens) throw new ChatStreamProtocolError("Usage-only frames require token counts."); return undefined; }
  if (typeof value !== "object" || Array.isArray(value)) throw new ChatStreamProtocolError("Streamed usage must be an object when present.");
  const usage = value as StreamUsage;
  for (const key of ["prompt_tokens", "completion_tokens"] as const) { const tokens = usage[key]; if ((requireTokens && tokens === undefined) || (tokens !== undefined && (typeof tokens !== "number" || !Number.isInteger(tokens) || tokens < 0 || tokens > 2_147_483_647))) throw new ChatStreamProtocolError("Streamed token counts must be non-negative 32-bit integers."); }
  return usage;
}
async function* completeChatEventStream(
  request: ChatCompletionRequest,
  taskType: ModelUsageInput["taskType"],
  modelOverride?: string,
  bodyExtras?: Record<string, unknown>,
): AsyncGenerator<ChatStreamEvent, ChatCompletionResponse> {
  const startedAt = Date.now();
  const model = modelOverride ?? request.model ?? env.MODEL_CHAT_DEFAULT;
  const route = providerRouteForModel(model);
  const provider = providerForRoute(route);
  assertKnownModelPrice(provider, model);
  await assertWorkspaceModelBudget(request.workspaceId);
  await assertCatalogModelBudget({
    workspaceId: request.workspaceId,
    ...usageContext(request),
  });
  const payload = JSON.stringify(withProviderOptions(provider, chatCompletionBody(model, {
    model,
    temperature: 0.2,
    messages: request.messages,
    stream: true,
    stream_options: { include_usage: true },
    ...(request.tools && request.tools.length > 0 ? { tools: request.tools } : {}),
    ...(request.tool_choice ? { tool_choice: request.tool_choice } : {}),
    ...(bodyExtras ?? {}),
  })));

  let response: Response | null = null;
  let lastError: unknown = null;
  let streamSignalCleanup = () => {};

  for (let attempt = 0; attempt <= MAX_REQUEST_RETRIES; attempt += 1) {
    let keepSignalForStream = false;
    const fetchSignal = timeoutSignal(request.signal, STREAM_TIMEOUT_MS);
    try {
      throwIfAborted(request.signal);
      response = await fetch(`${baseUrl(route)}/chat/completions`, {
        method: "POST",
        headers: await requestHeaders(route),
        body: payload,
        signal: fetchSignal.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        const error = new Error(`OpenAI-compatible request failed (${response.status}): ${errorText}`);
        if (attempt < MAX_REQUEST_RETRIES && isRetryableStatus(response.status)) {
          lastError = error;
          await sleep(retryDelayMs(attempt), request.signal);
          continue;
        }
        throw error;
      }
      keepSignalForStream = true;
      streamSignalCleanup = fetchSignal.cleanup;
      break;
    } catch (error) {
      if (request.signal?.aborted || attempt >= MAX_REQUEST_RETRIES || !isRetryableRequestError(error)) {
        throw error;
      }
      lastError = error;
      await sleep(retryDelayMs(attempt), request.signal);
    } finally {
      if (!keepSignalForStream) {
        fetchSignal.cleanup();
      }
    }
  }

  if (!response) throw lastError ?? new Error("OpenAI-compatible request failed after retries.");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Response body is not readable.");

  const decoder = new TextDecoder();
  let content = "";
  let toolCallParts = new Map<number, PartialToolCall>();
  let usageDetailsObj: StreamUsage | null = null;
  let buffer = "";
  let streamCompleted = false;
  let usage: UsageDetails | undefined;
  let usageRecorded = false;

  async function finalizeUsage() {
    if (usageRecorded && usage) {
      return usage;
    }

    const latencyMs = Date.now() - startedAt;
    const inputTokens = usageDetailsObj?.prompt_tokens ?? estimateTextTokens(payload);
    const estimatedToolCalls = [...toolCallParts.values()].map((tool) => ({
      id: tool.id,
      type: "function" as const,
      function: { name: tool.name, arguments: tool.arguments },
    }));
    const outputTokens = usageDetailsObj?.completion_tokens ?? estimateChatOutputTokens(content, estimatedToolCalls);
    usage = await recordUsage({
      workspaceId: request.workspaceId,
      workflowJobId: request.workflowJobId,
      agentRunId: request.agentRunId,
      ...usageContext(request),
      provider,
      model,
      taskType,
      inputTokens,
      outputTokens,
      latencyMs,
      ...costFields(provider, model, inputTokens, outputTokens),
    });
    usageRecorded = true;
    return usage;
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);

        const dataValue = line.startsWith("data:") ? line.slice(5).replace(/^ /, "") : null; if (dataValue === "[DONE]") {
          streamCompleted = true;
          await reader.cancel().catch(() => undefined);
          break;
        }
        if (dataValue !== null) {
          let data: unknown;
          try {
            data = JSON.parse(dataValue);
          } catch {
            throw new ChatStreamProtocolError("Streamed provider data must be valid JSON.");
          }
          if (!data || typeof data !== "object" || Array.isArray(data)) throw new ChatStreamProtocolError("Streamed provider data must be an object.");
          const record = data as Record<string, unknown>; const choices = record.choices;
          if (record.error != null) throw new ChatStreamProtocolError("Streamed provider reported an error.");
          if (choices !== undefined && !Array.isArray(choices)) throw new ChatStreamProtocolError("Streamed choices must be an array when present.");
          if (Array.isArray(choices) && choices.length > 1) throw new ChatStreamProtocolError("Streamed choices must contain exactly one choice.");
          const choice = Array.isArray(choices) ? choices[0] : undefined; const candidate = choice as Record<string, unknown> | undefined;
          if (choice !== undefined && (!choice || typeof choice !== "object" || Array.isArray(choice))) throw new ChatStreamProtocolError("Streamed choices must contain objects."); if (candidate?.index !== undefined && candidate.index !== 0) throw new ChatStreamProtocolError("Streamed choice index must be zero when present.");
          if (candidate?.finish_reason != null && typeof candidate.finish_reason !== "string") throw new ChatStreamProtocolError("Streamed finish_reason must be a string or null.");
          if (candidate?.finish_reason === "error") throw new ChatStreamProtocolError("Streamed provider reported an error.");
          const nextUsage = validateStreamUsage(record.usage, Array.isArray(choices) && choices.length === 0);
          if (candidate?.delta !== undefined && (!candidate.delta || typeof candidate.delta !== "object" || Array.isArray(candidate.delta))) throw new ChatStreamProtocolError("Streamed delta must be an object when present.");
          const delta = candidate?.delta as Record<string, unknown> | undefined;
          if (delta?.content != null && typeof delta.content !== "string") throw new ChatStreamProtocolError("Streamed content must be a string or null.");
          const contentDelta = typeof delta?.content === "string" ? delta.content : "";
          const toolCalls = delta?.tool_calls;
          if (toolCalls != null && !Array.isArray(toolCalls)) throw new ChatStreamProtocolError("Streamed tool_calls must be an array or null.");
          const nextToolCallParts = new Map([...toolCallParts].map(([index, tool]) => [index, { ...tool }]));
          const toolEvents = Array.isArray(toolCalls) ? toolCalls.map((tool) => appendToolCallDelta(nextToolCallParts, tool)) : [];
          const events: ChatStreamEvent[] = [...(contentDelta ? [{ type: "content_delta" as const, content: contentDelta }] : []), ...toolEvents];
          content += contentDelta; toolCallParts = nextToolCallParts;
          if (nextUsage) usageDetailsObj = nextUsage;
          for (const event of events) yield event;
        }
      }
    }
  } finally {
    try {
      if (!streamCompleted && !usageRecorded) {
        await reader.cancel().catch(() => undefined);
        await finalizeUsage();
      }
    } finally {
      streamSignalCleanup();
    }
  }

  if (!streamCompleted) {
    throw new ChatStreamProtocolError("Streamed provider response ended before [DONE].");
  }
  
  const finalUsage = await finalizeUsage();
  const finalTools = completeToolCalls(toolCallParts);

  return { content, tool_calls: finalTools.length > 0 ? finalTools : undefined, usage: finalUsage };
}

async function* completeChatStream(
  request: ChatCompletionRequest,
  taskType: ModelUsageInput["taskType"],
): AsyncGenerator<string, ChatCompletionResponse> {
  const events = completeChatEventStream(request, taskType);
  let completed = false;
  try {
    while (true) {
      const next = await events.next();
      if (next.done) {
        completed = true;
        return next.value;
      }
      if (next.value.type === "content_delta") {
        yield next.value.content;
      }
    }
  } finally {
    if (!completed) {
      await events.return(undefined as never);
    }
  }
}

async function repairExtractionObject(request: ExtractionRequest, raw: string) {
  const repaired = await completeChat({
    workspaceId: request.workspaceId,
    workflowJobId: request.workflowJobId,
    agentRunId: request.agentRunId,
    ...usageContext(request),
    taskType: "EXTRACTION",
    model: request.model,
    messages: [
      {
        role: "system",
        content: `Rewrite the invalid extraction output into a valid JSON object only. Follow this schema hint exactly: ${request.schemaHint}`,
      },
      {
        role: "user",
        content: `ORIGINAL_INSTRUCTION:\n${request.instruction}\n\nRAW_OUTPUT:\n${raw}`,
      },
    ],
  }, "EXTRACTION", request.model, {
    temperature: 0,
    response_format: {
      type: "json_object",
    },
  });

  return {
    raw: repaired.content,
    output: parseExtractionObject(repaired.content),
    usage: repaired.usage,
  };
}

async function embedTexts(request: EmbeddingRequest) {
  const startedAt = Date.now();
  const inputs = Array.isArray(request.input) ? request.input : [request.input];
  const model = request.model ?? env.MODEL_EMBEDDING_DEFAULT;
  const route = providerRouteForModel(model);
  const provider = providerForRoute(route);
  assertKnownModelPrice(provider, model);
  await assertWorkspaceModelBudget(request.workspaceId);
  await assertCatalogModelBudget({
    workspaceId: request.workspaceId,
    ...usageContext(request),
  });
  const response = await postJson<EmbeddingApiResponse>("/embeddings", {
    model,
    input: inputs,
  }, route);
  const latencyMs = Date.now() - startedAt;
  const embeddings = (response.data ?? []).map((entry) => entry.embedding ?? []);
  const inputTokens = response.usage?.prompt_tokens ?? inputs.reduce((sum, value) => sum + value.length, 0);

  return {
    provider,
    model,
    embeddings,
    inputTokens,
    latencyMs,
  };
}

async function transcribeAudioFile(request: AudioTranscriptionRequest) {
  const startedAt = Date.now();
  const model = request.model ?? env.MODEL_TRANSCRIPTION_DEFAULT;
  if (!model) {
    throw new Error("MODEL_TRANSCRIPTION_DEFAULT is required for audio transcription.");
  }
  const route = providerRouteForModel(model);
  const provider = providerForRoute(route);
  assertKnownModelPrice(provider, model);
  await assertWorkspaceModelBudget(request.workspaceId);
  await assertCatalogModelBudget({
    workspaceId: request.workspaceId,
    ...usageContext(request),
  });

  const form = new FormData();
  const fileName = request.fileName.trim() || "meeting-audio";
  form.set("model", model);
  form.set("response_format", "json");
  form.set("file", new Blob([new Uint8Array(request.data)], {
    type: request.mimeType?.trim() || "application/octet-stream",
  }), fileName);
  if (request.prompt?.trim()) {
    form.set("prompt", request.prompt.trim());
  }
  if (request.language?.trim()) {
    form.set("language", request.language.trim());
  }

  let lastError: unknown = null;
  for (let attempt = 0; attempt <= MAX_REQUEST_RETRIES; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl(route)}/audio/transcriptions`, {
        method: "POST",
        headers: await authHeaders(route),
        body: form,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (!response.ok) {
        const errorText = await response.text();
        const error = new Error(`OpenAI-compatible audio transcription failed (${response.status}): ${errorText}`);
        if (attempt < MAX_REQUEST_RETRIES && isRetryableStatus(response.status)) {
          lastError = error;
          await sleep(retryDelayMs(attempt));
          continue;
        }
        throw error;
      }

      const output = await response.json() as AudioTranscriptionApiResponse;
      const text = output.text?.trim() ?? "";
      if (!text) {
        throw new Error("Audio transcription returned no text.");
      }
      const latencyMs = Date.now() - startedAt;
      const usage = await recordUsage({
        workspaceId: request.workspaceId,
        workflowJobId: request.workflowJobId,
        agentRunId: request.agentRunId,
        ...usageContext(request),
        provider,
        model,
        taskType: "TRANSCRIPTION",
        inputTokens: 0,
        outputTokens: Math.ceil(text.length / 4),
        latencyMs,
        ...costFields(provider, model, 0, Math.ceil(text.length / 4)),
      });

      return { text, usage };
    } catch (error) {
      if (attempt >= MAX_REQUEST_RETRIES || !isRetryableRequestError(error)) {
        throw error;
      }
      lastError = error;
      await sleep(retryDelayMs(attempt));
    }
  }

  throw lastError ?? new Error("OpenAI-compatible audio transcription failed after retries.");
}

export const openAICompatibleModelGateway: ModelGateway = {
  async chat(request: ChatCompletionRequest) {
    return completeChat(request, request.taskType);
  },

  async *chatEventStream(request: ChatCompletionRequest) {
    return yield* completeChatEventStream(request, request.taskType);
  },

  async *chatStream(request: ChatCompletionRequest) {
    return yield* completeChatStream(request, request.taskType);
  },

  async extract(request: ExtractionRequest) {
    const response = await completeChat({
      workspaceId: request.workspaceId,
      workflowJobId: request.workflowJobId,
      agentRunId: request.agentRunId,
      ...usageContext(request),
      taskType: "EXTRACTION",
      model: request.model,
      messages: [
        {
          role: "system",
          content: `Return a valid JSON object only. Follow this schema hint: ${request.schemaHint}`,
        },
        {
          role: "user",
          content: `${request.instruction}\n\nINPUT:\n${request.input}`,
        },
      ],
    }, "EXTRACTION", request.model, {
      temperature: 0,
      response_format: {
        type: "json_object",
      },
    });

    const parsed = parseExtractionObject(response.content);
    if (parsed) {
      return {
        output: parsed,
        raw: response.content,
        usage: response.usage,
      };
    }

    const repaired = await repairExtractionObject(request, response.content);
    if (repaired.output) {
      return {
        output: repaired.output,
        raw: repaired.raw,
        usage: repaired.usage,
      };
    }

    throw new ExtractionParseError("Failed to parse extraction output after repair attempt.", {
      raw: response.content,
      repairedRaw: repaired.raw,
    });
  },

  async embed(request: EmbeddingRequest) {
    const embedded = await embedTexts(request);
    const usage = await recordUsage({
      workspaceId: request.workspaceId,
      workflowJobId: request.workflowJobId,
      agentRunId: request.agentRunId,
      ...usageContext(request),
      provider: embedded.provider,
      model: embedded.model,
      taskType: "EMBEDDING",
      inputTokens: embedded.inputTokens,
      outputTokens: 0,
      latencyMs: embedded.latencyMs,
      ...costFields(embedded.provider, embedded.model, embedded.inputTokens, 0),
    });

    return {
      embeddings: embedded.embeddings,
      usage,
    };
  },

  async rerank(request: RerankRequest) {
    const embedded = await embedTexts({
      workspaceId: request.workspaceId,
      workflowJobId: request.workflowJobId,
      agentRunId: request.agentRunId,
      ...usageContext(request),
      model: request.model ?? env.MODEL_EMBEDDING_DEFAULT,
      input: [request.query, ...request.documents],
    });
    const [queryEmbedding, ...documentEmbeddings] = embedded.embeddings;
    const results = request.documents
      .map((document, index) => ({
        index,
        document,
        score: Number(cosineSimilarity(queryEmbedding ?? [], documentEmbeddings[index] ?? []).toFixed(6)),
      }))
      .sort((left, right) => right.score - left.score)
      .slice(0, Math.max(1, Math.min(request.topK ?? request.documents.length, request.documents.length)));
    const usage = await recordUsage({
      workspaceId: request.workspaceId,
      workflowJobId: request.workflowJobId,
      agentRunId: request.agentRunId,
      ...usageContext(request),
      provider: embedded.provider,
      model: embedded.model,
      taskType: "RERANK",
      inputTokens: embedded.inputTokens,
      outputTokens: 0,
      latencyMs: embedded.latencyMs,
      ...costFields(embedded.provider, embedded.model, embedded.inputTokens, 0),
    });

    return {
      results,
      usage,
    };
  },

  async transcribeAudio(request: AudioTranscriptionRequest) {
    return transcribeAudioFile(request);
  },
};
