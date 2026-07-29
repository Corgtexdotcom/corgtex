#!/usr/bin/env node
import { DefaultAzureCredential } from "@azure/identity";
import { readFile } from "node:fs/promises";
import process from "node:process";
import { pathToFileURL } from "node:url";

const DEFAULT_EVAL_SET_PATH = "scripts/fixtures/azure-foundry-sanitized-eval-set.jsonl";
const DEFAULT_TIMEOUT_MS = intEnv("AZURE_FOUNDRY_EVAL_TIMEOUT_MS", 60_000, { min: 1 });
const DEFAULT_MAX_TOKENS = intEnv("AZURE_FOUNDRY_EVAL_MAX_TOKENS", 600, { min: 1 });
const DEFAULT_RETRIES = intEnv("AZURE_FOUNDRY_EVAL_RETRIES", 1, { min: 0 });
const DEFAULT_CONCURRENCY = intEnv("AZURE_FOUNDRY_EVAL_CONCURRENCY", 2, { min: 1, max: 4 });
const TOKEN_REFRESH_SKEW_MS = 60_000;
const DEFAULT_PRICES = [
  { provider: "openrouter", model: "deepseek/deepseek-v4-flash", inputUsdPerToken: 0.0000000983, outputUsdPerToken: 0.0000001966 },
  { provider: "openrouter", model: "deepseek/deepseek-v4-pro", inputUsdPerToken: 0.000000435, outputUsdPerToken: 0.00000087 },
  { provider: "openrouter", model: "deepseek/deepseek-r1-0528", inputUsdPerToken: 0.0000005, outputUsdPerToken: 0.00000215 },
  { provider: "azure-foundry", model: "corgtex-ds-v4-flash", inputUsdPerToken: 0.00000019, outputUsdPerToken: 0.00000051 },
  { provider: "azure-foundry", model: "corgtex-ds-v4-pro", inputUsdPerToken: 0.00000174, outputUsdPerToken: 0.00000348 },
  { provider: "azure-foundry", model: "corgtex-kimi-k25", inputUsdPerToken: 0.0000006, outputUsdPerToken: 0.000003 },
  { provider: "azure-foundry", model: "corgtex-kimi-k27-code", inputUsdPerToken: 0.00000095, outputUsdPerToken: 0.000004 },
  { provider: "azure-foundry", model: "corgtex-gpt56-luna", inputUsdPerToken: 0.000001, outputUsdPerToken: 0.000006 },
];
const credential = new DefaultAzureCredential();
const accessTokenCache = new Map();

function intEnv(name, fallback, options = {}) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  const min = Number.isFinite(options.min) ? options.min : parsed;
  const max = Number.isFinite(options.max) ? options.max : parsed;
  return Math.min(max, Math.max(min, parsed));
}

function arg(name) {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

function normalize(value) {
  return String(value ?? "").trim().toLowerCase();
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseJsonEnv(name, fallback) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${name} must be valid JSON.`);
  }
}

function parseCandidates() {
  const candidates = parseJsonEnv("AZURE_FOUNDRY_EVAL_CANDIDATES_JSON", []);
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new Error("AZURE_FOUNDRY_EVAL_CANDIDATES_JSON must contain at least one candidate.");
  }
  return candidates.map((candidate, index) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error(`AZURE_FOUNDRY_EVAL_CANDIDATES_JSON[${index}] must be an object.`);
    }
    const record = candidate;
    for (const key of ["label", "provider", "model", "baseUrl"]) {
      if (typeof record[key] !== "string" || !record[key].trim()) {
        throw new Error(`AZURE_FOUNDRY_EVAL_CANDIDATES_JSON[${index}].${key} is required.`);
      }
    }
    if (record.authMode !== undefined && record.authMode !== "api_key" && record.authMode !== "managed_identity") {
      throw new Error(`AZURE_FOUNDRY_EVAL_CANDIDATES_JSON[${index}].authMode must be api_key or managed_identity.`);
    }
    const provider = record.provider.trim().toLowerCase();
    const model = record.model.trim();
    const authMode = record.authMode ?? "api_key";
    const apiKeyEnv = typeof record.apiKeyEnv === "string" && record.apiKeyEnv.trim()
      ? record.apiKeyEnv.trim()
      : provider === "openrouter"
        ? "MODEL_API_KEY"
        : "AZURE_OPENAI_API_KEY";
    return {
      label: record.label.trim(),
      provider,
      model,
      baseUrl: record.baseUrl.trim().replace(/\/+$/, ""),
      authMode,
      apiKeyEnv,
      temperature: Object.hasOwn(record, "temperature") ? record.temperature : defaultTemperature(model),
      maxTokenParameter: typeof record.maxTokenParameter === "string" && record.maxTokenParameter.trim()
        ? record.maxTokenParameter.trim()
        : "max_tokens",
      scope: typeof record.scope === "string" && record.scope.trim()
        ? record.scope.trim()
        : provider === "azure-foundry"
          ? "https://ai.azure.com/.default"
          : "https://cognitiveservices.azure.com/.default",
    };
  });
}

function defaultTemperature(model) {
  return model === "corgtex-gpt56-luna" ? undefined : 0;
}

async function readEvalSet(path) {
  const text = await readFile(path, "utf8");
  const evalSet = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch {
        throw new Error(`${path}:${index + 1} is not valid JSON.`);
      }
    });
  if (evalSet.length === 0) {
    throw new Error(`${path} must contain at least one evaluation case.`);
  }
  return evalSet;
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function parseJsonObject(text) {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      const parsed = JSON.parse(text.slice(start, end + 1));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
}

function priceFor(provider, model) {
  const prices = [...parsePriceOverrides(), ...DEFAULT_PRICES];
  return prices.find((price) => (
    normalize(price.provider) === normalize(provider) &&
    normalize(price.model) === normalize(model) &&
    typeof price.inputUsdPerToken === "number" &&
    typeof price.outputUsdPerToken === "number"
  )) ?? null;
}

function parsePriceOverrides() {
  const overrides = parseJsonEnv("MODEL_PRICE_OVERRIDES_JSON", []);
  if (!Array.isArray(overrides)) {
    throw new Error("MODEL_PRICE_OVERRIDES_JSON must be an array.");
  }

  return overrides.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`MODEL_PRICE_OVERRIDES_JSON[${index}] must be an object.`);
    }
    if (typeof entry.provider !== "string" || !entry.provider.trim() || typeof entry.model !== "string" || !entry.model.trim()) {
      throw new Error(`MODEL_PRICE_OVERRIDES_JSON[${index}] requires provider and model strings.`);
    }
    if (typeof entry.inputUsdPerToken !== "number" || !Number.isFinite(entry.inputUsdPerToken) || entry.inputUsdPerToken < 0) {
      throw new Error(`MODEL_PRICE_OVERRIDES_JSON[${index}].inputUsdPerToken must be a finite non-negative number.`);
    }
    if (typeof entry.outputUsdPerToken !== "number" || !Number.isFinite(entry.outputUsdPerToken) || entry.outputUsdPerToken < 0) {
      throw new Error(`MODEL_PRICE_OVERRIDES_JSON[${index}].outputUsdPerToken must be a finite non-negative number.`);
    }
    return {
      provider: entry.provider.trim(),
      model: entry.model.trim(),
      inputUsdPerToken: entry.inputUsdPerToken,
      outputUsdPerToken: entry.outputUsdPerToken,
    };
  });
}

function estimateMessageTokens(messages) {
  const charCount = messages.reduce((sum, message) => sum + String(message.content ?? "").length, 0);
  return Math.ceil(charCount / 4);
}

function estimateCost(candidate, usage, text, requestBody) {
  const promptTokens = Number.isFinite(usage?.prompt_tokens)
    ? usage.prompt_tokens
    : estimateMessageTokens(requestBody.messages ?? []);
  const completionTokens = Number.isFinite(usage?.completion_tokens) ? usage.completion_tokens : Math.ceil(text.length / 4);
  const metrics = {
    inputTokens: promptTokens,
    outputTokens: completionTokens,
    estimatedInputTokens: !Number.isFinite(usage?.prompt_tokens),
    estimatedOutputTokens: !Number.isFinite(usage?.completion_tokens),
  };
  const price = priceFor(candidate.provider, candidate.model);
  if (!price) {
    return {
      ...metrics,
      rawProviderCostUsd: null,
    };
  }
  return {
    ...metrics,
    rawProviderCostUsd: (promptTokens * price.inputUsdPerToken + completionTokens * price.outputUsdPerToken).toFixed(6),
  };
}

async function authHeaders(candidate) {
  if (candidate.authMode === "managed_identity") {
    const cachedToken = accessTokenCache.get(candidate.scope);
    if (cachedToken && cachedToken.expiresOnTimestamp > Date.now() + TOKEN_REFRESH_SKEW_MS) {
      return { authorization: `Bearer ${cachedToken.token}` };
    }
    const token = await credential.getToken(candidate.scope);
    if (!token?.token) throw new Error(`Failed to acquire managed identity token for ${candidate.label}.`);
    accessTokenCache.set(candidate.scope, token);
    return { authorization: `Bearer ${token.token}` };
  }
  const key = process.env[candidate.apiKeyEnv]?.trim();
  if (!key) throw new Error(`${candidate.apiKeyEnv} is required for ${candidate.label}.`);
  if (candidate.provider === "azure-foundry" || candidate.provider === "azure-openai") {
    return { "api-key": key };
  }
  return { authorization: `Bearer ${key}` };
}

function systemPromptFor(item) {
  const base = "Use only facts present in the prompt. Do not invent approvals, dates, customer commitments, or sent messages.";
  if (item.mode !== "json") {
    return `${base} Follow the requested sections and wording constraints.`;
  }
  const keys = Array.isArray(item.requiredKeys) && item.requiredKeys.length > 0
    ? ` The response must be one valid JSON object with these top-level keys: ${item.requiredKeys.join(", ")}.`
    : " The response must be one valid JSON object.";
  return `${base}${keys} Do not wrap JSON in Markdown.`;
}

function completionRequestBody(candidate, item) {
  const body = {
    model: candidate.model,
    messages: [
      { role: "system", content: systemPromptFor(item) },
      { role: "user", content: item.prompt },
    ],
  };
  if (Number.isFinite(candidate.temperature)) {
    body.temperature = candidate.temperature;
  }
  if (candidate.maxTokenParameter !== "none") {
    body[candidate.maxTokenParameter] = Number.isFinite(item.maxTokens) ? item.maxTokens : DEFAULT_MAX_TOKENS;
  }
  if (item.mode === "json") {
    body.response_format = { type: "json_object" };
  }
  return body;
}

async function callCandidate(candidate, item) {
  const startedAt = Date.now();
  const providerOptions = candidate.provider === "openrouter"
    ? {
      provider: {
        allow_fallbacks: true,
        data_collection: "deny",
        require_parameters: true,
      },
    }
    : {};
  const requestBody = completionRequestBody(candidate, item);
  const response = await fetch(`${candidate.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...await authHeaders(candidate),
    },
    body: JSON.stringify({
      ...providerOptions,
      ...requestBody,
    }),
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  const body = await response.text();
  const latencyMs = Date.now() - startedAt;
  if (!response.ok) {
    const error = new Error(`provider returned HTTP ${response.status}`);
    error.retryable = response.status === 429 || response.status >= 500;
    error.category = response.status === 429 ? "rate_limit" : response.status >= 500 ? "server_error" : "http_error";
    throw error;
  }
  const parsed = JSON.parse(body);
  const text = parsed.choices?.[0]?.message?.content ?? "";
  return {
    text,
    latencyMs,
    usage: parsed.usage,
    cost: estimateCost(candidate, parsed.usage, text, requestBody),
  };
}

async function callCandidateWithRetries(candidate, item) {
  const errors = [];
  for (let attempt = 0; attempt <= DEFAULT_RETRIES; attempt += 1) {
    try {
      const response = await callCandidate(candidate, item);
      return {
        ...response,
        attempts: attempt + 1,
        retryCount: attempt,
      };
    } catch (error) {
      errors.push(error);
      const message = error instanceof Error ? error.message : String(error);
      const retryable = isRetryableRequestError(error);
      if (!retryable || attempt >= DEFAULT_RETRIES) {
        const finalError = new Error(sanitizedErrorMessage(error, errors.length));
        finalError.category = error?.category ?? (retryable ? "timeout_or_retry_exhausted" : "request_error");
        finalError.attempts = errors.length;
        throw finalError;
      }
      await delay(250 * 2 ** attempt);
    }
  }
  throw new Error("provider request failed");
}

function isRetryableRequestError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return Boolean(error?.retryable)
    || error instanceof TypeError
    || error?.name === "TimeoutError"
    || error?.name === "AbortError"
    || /aborted|timeout/i.test(message);
}

function sanitizedErrorMessage(error, attempts) {
  const message = error instanceof Error ? error.message : String(error);
  const suffix = `after ${attempts} attempt${attempts === 1 ? "" : "s"}`;
  if (/HTTP \d+/.test(message)) return `${message} ${suffix}`;
  if (/aborted|timeout/i.test(message)) return `request timed out ${suffix}`;
  if (/required for/.test(message)) return message;
  return `provider request failed ${suffix}`;
}

function conceptLabel(concept) {
  if (typeof concept === "string") return concept;
  if (Array.isArray(concept)) return String(concept[0] ?? "");
  if (concept && typeof concept === "object") return String(concept.label ?? concept.anyOf?.[0] ?? "");
  return "";
}

function conceptTerms(concept) {
  if (typeof concept === "string") return [concept];
  if (Array.isArray(concept)) return concept.map(String);
  if (concept && typeof concept === "object" && Array.isArray(concept.anyOf)) {
    return concept.anyOf.map(String);
  }
  return [];
}

function termGroupTerms(group) {
  if (Array.isArray(group)) return group.map(String);
  return [String(group)];
}

function conceptTermGroups(concept) {
  if (concept && typeof concept === "object" && !Array.isArray(concept) && Array.isArray(concept.allOf)) {
    return concept.allOf.map(termGroupTerms);
  }
  const terms = conceptTerms(concept);
  return terms.length > 0 ? [terms] : [];
}

function termOccurrenceIndexes(normalizedText, normalizedTerm) {
  const indexes = [];
  let start = 0;
  while (start <= normalizedText.length) {
    const index = normalizedText.indexOf(normalizedTerm, start);
    if (index < 0) break;
    indexes.push(index);
    start = index + Math.max(1, normalizedTerm.length);
  }
  return indexes;
}

function isNegatedOccurrence(normalizedText, index) {
  const prefix = normalizedText.slice(Math.max(0, index - 80), index);
  if (/(?:^|[\s([{,;:])(?:requires|needs) (?:approval|review) before\s+$/.test(prefix)) {
    return true;
  }

  const match = prefix.match(/(?:^|[\s([{,;:])(?:not|never|without|cannot|can't|cant|do not|don't|dont|does not|doesn't|doesnt|is not|isn't|isnt|are not|aren't|arent|was not|wasn't|wasnt|were not|weren't|werent|should not|shouldn't|shouldnt|must not|mustn't|mustnt|will not|won't|wont|avoid|blocked from)\s+((?:[\w'-]+\s+){0,4})$/);
  if (!match) return false;

  const bridgeWords = match[1].trim().split(/\s+/).filter(Boolean);
  return !bridgeWords.some((word) => ["and", "but", "or", "then"].includes(word));
}

function textContainsTerm(normalizedText, term, options = {}) {
  const normalizedTerm = normalize(term);
  if (!normalizedTerm) return false;
  const indexes = termOccurrenceIndexes(normalizedText, normalizedTerm);
  if (!options.polarityAware) return indexes.length > 0;
  return indexes.some((index) => !isNegatedOccurrence(normalizedText, index));
}

function conceptMatches(concept, normalizedText, options = {}) {
  const groups = conceptTermGroups(concept);
  return groups.length > 0 && groups.every((group) => (
    group.some((term) => textContainsTerm(normalizedText, term, options))
  ));
}

function requiredConcepts(item) {
  if (Array.isArray(item.requiredConcepts)) return item.requiredConcepts;
  if (Array.isArray(item.mustMention)) return item.mustMention;
  return [];
}

function forbiddenConcepts(item) {
  if (Array.isArray(item.forbiddenConcepts)) return item.forbiddenConcepts;
  if (Array.isArray(item.mustNotMention)) return item.mustNotMention;
  return [];
}

function scoreItem(item, text) {
  const normalizedText = normalize(text);
  const parsedJson = item.mode === "json" ? parseJsonObject(text) : null;
  const jsonParsed = item.mode !== "json" || Boolean(parsedJson);
  const missingKeys = item.requiredKeys?.filter((key) => !(parsedJson && Object.hasOwn(parsedJson, key))) ?? [];
  const missingConcepts = requiredConcepts(item).filter((concept) => {
    return !conceptMatches(concept, normalizedText);
  }).map(conceptLabel);
  const forbiddenMentions = forbiddenConcepts(item).filter((concept) => (
    conceptMatches(concept, normalizedText, { polarityAware: true })
  )).map(conceptLabel);
  const schemaValid = jsonParsed && missingKeys.length === 0;
  return {
    schemaValid,
    jsonParsed,
    outputLength: text.length,
    missingKeys,
    missingConcepts,
    forbiddenMentions,
    passed: schemaValid && missingConcepts.length === 0 && forbiddenMentions.length === 0,
  };
}

async function main() {
  const evalSetPath = arg("eval-set") ?? DEFAULT_EVAL_SET_PATH;
  const evalSet = await readEvalSet(evalSetPath);
  const candidates = parseCandidates();
  parsePriceOverrides();
  const results = [];

  for (const candidate of candidates) {
    const candidateResults = await mapWithConcurrency(evalSet, DEFAULT_CONCURRENCY, async (item) => {
      try {
        const response = await callCandidateWithRetries(candidate, item);
        return {
          id: item.id,
          flow: item.flow,
          ok: true,
          latencyMs: response.latencyMs,
          attempts: response.attempts,
          retryCount: response.retryCount,
          cost: response.cost,
          score: scoreItem(item, response.text),
        };
      } catch (error) {
        return {
          id: item.id,
          flow: item.flow,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          errorCategory: error?.category ?? "request_error",
          attempts: Number.isFinite(error?.attempts) ? error.attempts : undefined,
        };
      }
    });
    results.push({
      label: candidate.label,
      provider: candidate.provider,
      model: candidate.model,
      passed: candidateResults.every((result) => result.ok && result.score?.passed),
      cases: candidateResults,
    });
  }

  console.log(JSON.stringify({
    generatedAt: new Date().toISOString(),
    evalSet: evalSetPath,
    caseCount: evalSet.length,
    settings: {
      timeoutMs: DEFAULT_TIMEOUT_MS,
      maxTokens: DEFAULT_MAX_TOKENS,
      concurrency: DEFAULT_CONCURRENCY,
      retries: DEFAULT_RETRIES,
    },
    results,
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

export {
  conceptMatches,
  estimateCost,
  isRetryableRequestError,
  scoreItem,
};
