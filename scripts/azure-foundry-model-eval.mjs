#!/usr/bin/env node
import { DefaultAzureCredential } from "@azure/identity";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import process from "node:process";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const PRODUCTION_MODEL_PRICES = require("../packages/models/src/model-prices.json");
const DEFAULT_EVAL_SET_PATH = "scripts/fixtures/azure-foundry-sanitized-eval-set.jsonl";
const DEFAULT_TIMEOUT_MS = intEnv("AZURE_FOUNDRY_EVAL_TIMEOUT_MS", 60_000, { min: 1 });
const DEFAULT_MAX_TOKENS = intEnv("AZURE_FOUNDRY_EVAL_MAX_TOKENS", 600, { min: 1 });
const DEFAULT_RETRIES = intEnv("AZURE_FOUNDRY_EVAL_RETRIES", 1, { min: 0 });
const DEFAULT_CONCURRENCY = intEnv("AZURE_FOUNDRY_EVAL_CONCURRENCY", 2, { min: 1, max: 4 });
const EVAL_PASS_POLICIES = new Set(["all", "any"]);
const TOKEN_REFRESH_SKEW_MS = 60_000;
const SUPPORTED_EVAL_PROVIDERS = new Set(["openrouter", "openai", "azure-openai", "azure-foundry"]);
const AZURE_EVAL_PROVIDERS = new Set(["azure-openai", "azure-foundry"]);
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

function isHttpsBaseUrl(value) {
  try {
    return new URL(value).protocol === "https:";
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
    if (!SUPPORTED_EVAL_PROVIDERS.has(provider)) {
      throw new Error(`AZURE_FOUNDRY_EVAL_CANDIDATES_JSON[${index}].provider must be one of ${[...SUPPORTED_EVAL_PROVIDERS].join(", ")}.`);
    }
    if (!isHttpsBaseUrl(record.baseUrl.trim())) {
      throw new Error(`AZURE_FOUNDRY_EVAL_CANDIDATES_JSON[${index}].baseUrl must be an HTTPS URL.`);
    }
    const model = record.model.trim();
    const authMode = record.authMode ?? "api_key";
    if (authMode === "managed_identity" && !AZURE_EVAL_PROVIDERS.has(provider)) {
      throw new Error(`AZURE_FOUNDRY_EVAL_CANDIDATES_JSON[${index}].authMode managed_identity is only supported for Azure candidates.`);
    }
    if (AZURE_EVAL_PROVIDERS.has(provider) && !isTrustedAzureBaseUrl(provider, record.baseUrl.trim())) {
      throw new Error(`AZURE_FOUNDRY_EVAL_CANDIDATES_JSON[${index}].baseUrl must be a trusted Azure OpenAI-compatible URL for ${authMode === "managed_identity" ? "managed identity" : "API key"}.`);
    }
    const apiKeyEnv = typeof record.apiKeyEnv === "string" && record.apiKeyEnv.trim()
      ? record.apiKeyEnv.trim()
      : defaultApiKeyEnv(provider);
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

function defaultApiKeyEnv(provider) {
  if (provider === "azure-foundry") return "AZURE_FOUNDRY_API_KEY";
  if (provider === "azure-openai") return "AZURE_OPENAI_API_KEY";
  return "MODEL_API_KEY";
}

function defaultTemperature(model) {
  return model === "corgtex-gpt56-luna" ? undefined : 0;
}

function evalPassPolicy() {
  const raw = process.env.AZURE_FOUNDRY_EVAL_PASS_POLICY?.trim().toLowerCase() || "all";
  if (!EVAL_PASS_POLICIES.has(raw)) {
    throw new Error(`AZURE_FOUNDRY_EVAL_PASS_POLICY must be one of ${[...EVAL_PASS_POLICIES].join(", ")}.`);
  }
  return raw;
}

function evaluationPasses(results, policy = "all") {
  if (!Array.isArray(results) || results.length === 0) {
    return false;
  }
  if (policy === "any") {
    return results.some((result) => result?.passed === true);
  }
  return results.every((result) => result?.passed === true);
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
    const parsed = JSON.parse(text.trim());
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeMessageContent(content) {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((part) => typeof part?.text === "string" ? part.text : "")
    .filter(Boolean)
    .join("\n");
}

function jsonValueText(value) {
  if (value === null || value === undefined) {
    return "";
  }

  if (Array.isArray(value)) {
    return value.map(jsonValueText).filter(Boolean).join(" ");
  }

  if (typeof value === "object") {
    return Object.values(value).map(jsonValueText).filter(Boolean).join(" ");
  }

  return String(value);
}

function requiredJsonValues(item) {
  return item.requiredJsonValues && typeof item.requiredJsonValues === "object" && !Array.isArray(item.requiredJsonValues)
    ? item.requiredJsonValues
    : {};
}

function requiredJsonShapes(item) {
  return item.requiredJsonShapes && typeof item.requiredJsonShapes === "object" && !Array.isArray(item.requiredJsonShapes)
    ? item.requiredJsonShapes
    : {};
}

function requiredJsonMatches(item) {
  return Array.isArray(item.requiredJsonMatches) ? item.requiredJsonMatches : [];
}

function requiredTextSections(item) {
  return Array.isArray(item.requiredTextSections) ? item.requiredTextSections : [];
}

function isObjectRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function jsonPathValue(value, path) {
  if (!path) {
    return value;
  }

  return path.split(".").reduce((current, segment) => {
    if (!isObjectRecord(current)) {
      return undefined;
    }
    return Object.hasOwn(current, segment) ? current[segment] : undefined;
  }, value);
}

function jsonMatchLabel(match) {
  return String(match?.label ?? match?.path ?? "json match");
}

function jsonMatchFields(match) {
  const fields = match?.fields;
  return fields && typeof fields === "object" && !Array.isArray(fields) ? fields : {};
}

function jsonMatchSatisfied(parsedJson, match) {
  if (!parsedJson || !isObjectRecord(match)) {
    return false;
  }

  const path = typeof match.path === "string" ? match.path.trim() : "";
  const fields = jsonMatchFields(match);
  if (Object.keys(fields).length === 0) {
    return false;
  }

  const value = path ? jsonPathValue(parsedJson, path) : parsedJson;
  const candidates = Array.isArray(value) ? value : [value];
  return candidates.some((candidate) => (
    isObjectRecord(candidate) && Object.entries(fields).every(([field, concept]) => (
      conceptMatches(concept, normalize(jsonValueText(jsonPathValue(candidate, field))))
    ))
  ));
}

function priceFor(provider, model) {
  const prices = [...parsePriceOverrides(), ...PRODUCTION_MODEL_PRICES];
  return prices.find((price) => (
    normalize(price.provider) === normalize(provider) &&
    normalize(price.model) === normalize(model) &&
    isUsablePriceEntry(price)
  )) ?? null;
}

function isUsablePriceEntry(price) {
  return typeof price.inputUsdPerToken === "number" &&
    Number.isFinite(price.inputUsdPerToken) &&
    price.inputUsdPerToken >= 0 &&
    typeof price.outputUsdPerToken === "number" &&
    Number.isFinite(price.outputUsdPerToken) &&
    price.outputUsdPerToken >= 0;
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
  const hasProviderPromptTokens = Number.isFinite(usage?.prompt_tokens) && usage.prompt_tokens >= 0;
  const hasProviderCompletionTokens = Number.isFinite(usage?.completion_tokens) && usage.completion_tokens >= 0;
  const promptTokens = hasProviderPromptTokens
    ? usage.prompt_tokens
    : estimateMessageTokens(requestBody.messages ?? []);
  const completionTokens = hasProviderCompletionTokens ? usage.completion_tokens : Math.ceil(text.length / 4);
  const metrics = {
    inputTokens: promptTokens,
    outputTokens: completionTokens,
    estimatedInputTokens: !hasProviderPromptTokens,
    estimatedOutputTokens: !hasProviderCompletionTokens,
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
    if (!AZURE_EVAL_PROVIDERS.has(candidate.provider)) {
      throw new Error(`managed_identity authMode is only supported for Azure candidates (${candidate.label}).`);
    }
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
  const text = normalizeMessageContent(parsed.choices?.[0]?.message?.content);
  return {
    text,
    latencyMs,
    usage: parsed.usage,
    cost: estimateCost(candidate, parsed.usage, text, requestBody),
  };
}

async function callCandidateWithRetries(candidate, item) {
  const operationStartedAt = Date.now();
  const errors = [];
  for (let attempt = 0; attempt <= DEFAULT_RETRIES; attempt += 1) {
    try {
      const response = await callCandidate(candidate, item);
      return {
        ...response,
        latencyMs: Date.now() - operationStartedAt,
        finalAttemptLatencyMs: response.latencyMs,
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
        finalError.latencyMs = Date.now() - operationStartedAt;
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
    if (hasTermBoundaries(normalizedText, normalizedTerm, index)) {
      indexes.push(index);
    }
    start = index + Math.max(1, normalizedTerm.length);
  }
  return indexes;
}

function isTokenChar(char) {
  return typeof char === "string" && /[a-z0-9]/.test(char);
}

function hasTermBoundaries(normalizedText, normalizedTerm, index) {
  const first = normalizedTerm[0];
  const last = normalizedTerm[normalizedTerm.length - 1];
  const before = normalizedText[index - 1];
  const after = normalizedText[index + normalizedTerm.length];
  return (!isTokenChar(first) || !isTokenChar(before)) && (!isTokenChar(last) || !isTokenChar(after));
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

function sectionLabel(section) {
  return String(section?.label ?? section?.heading ?? "text section");
}

function sectionHeadingTerms(section) {
  const heading = section?.heading ?? section?.label;
  if (typeof heading === "string") return [heading];
  if (Array.isArray(heading)) return heading.map(String);
  if (heading && typeof heading === "object" && Array.isArray(heading.anyOf)) {
    return heading.anyOf.map(String);
  }
  return [];
}

function stripHeadingMarkup(line) {
  return String(line ?? "")
    .replace(/^\s{0,3}(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)/, "")
    .replace(/\*\*/g, "")
    .trim();
}

function isSectionHeadingLine(line, section) {
  const normalizedLine = normalize(stripHeadingMarkup(line));
  return sectionHeadingTerms(section).some((term) => {
    const normalizedTerm = normalize(term);
    return normalizedTerm && (
      normalizedLine === normalizedTerm ||
      normalizedLine.startsWith(`${normalizedTerm}:`) ||
      normalizedLine.startsWith(`${normalizedTerm} -`)
    );
  });
}

function inlineSectionContent(line) {
  const stripped = stripHeadingMarkup(line);
  const colonIndex = stripped.indexOf(":");
  return colonIndex >= 0 ? stripped.slice(colonIndex + 1).trim() : "";
}

function textSectionContent(text, section, sections) {
  const lines = String(text ?? "").split(/\r?\n/);
  const startIndex = lines.findIndex((line) => isSectionHeadingLine(line, section));
  if (startIndex < 0) {
    return null;
  }

  const content = [];
  const inlineContent = inlineSectionContent(lines[startIndex]);
  if (inlineContent) {
    content.push(inlineContent);
  }

  for (let index = startIndex + 1; index < lines.length; index += 1) {
    if (sections.some((candidateSection) => isSectionHeadingLine(lines[index], candidateSection))) {
      break;
    }
    content.push(lines[index]);
  }
  return content.join("\n").trim();
}

function textSectionConcepts(section) {
  return Array.isArray(section?.concepts) ? section.concepts : [];
}

function textSectionSatisfied(text, section, sections) {
  const content = textSectionContent(text, section, sections);
  if (content === null) {
    return false;
  }
  const normalizedContent = normalize(content);
  return textSectionConcepts(section).every((concept) => conceptMatches(concept, normalizedContent));
}

function jsonShapeFailures(value, shape, path) {
  if (!shape || typeof shape !== "object" || Array.isArray(shape)) {
    return [];
  }

  const failures = [];
  if (typeof shape.type === "string") {
    if (shape.type === "array" && !Array.isArray(value)) {
      return [`${path} must be an array`];
    }
    if (shape.type === "object" && (!value || typeof value !== "object" || Array.isArray(value))) {
      return [`${path} must be an object`];
    }
    if (shape.type === "string" && typeof value !== "string") {
      return [`${path} must be a string`];
    }
    if (shape.type === "number" && (typeof value !== "number" || !Number.isFinite(value))) {
      return [`${path} must be a number`];
    }
    if (shape.type === "boolean" && typeof value !== "boolean") {
      return [`${path} must be a boolean`];
    }
  }

  if (Array.isArray(value)) {
    if (Number.isFinite(shape.minItems) && value.length < shape.minItems) {
      failures.push(`${path} must contain at least ${shape.minItems} item${shape.minItems === 1 ? "" : "s"}`);
    }
    if (shape.items) {
      value.forEach((item, index) => {
        failures.push(...jsonShapeFailures(item, shape.items, `${path}[${index}]`));
      });
    }
  }

  if (value && typeof value === "object" && !Array.isArray(value)) {
    const requiredKeys = Array.isArray(shape.requiredKeys) ? shape.requiredKeys.map(String) : [];
    for (const key of requiredKeys) {
      if (!Object.hasOwn(value, key)) {
        failures.push(`${path}.${key} is required`);
      }
    }
    const properties = shape.properties && typeof shape.properties === "object" && !Array.isArray(shape.properties)
      ? shape.properties
      : {};
    for (const [key, childShape] of Object.entries(properties)) {
      if (Object.hasOwn(value, key)) {
        failures.push(...jsonShapeFailures(value[key], childShape, `${path}.${key}`));
      }
    }
  }

  return failures;
}

function scoreItem(item, text) {
  const normalizedText = normalize(text);
  const parsedJson = item.mode === "json" ? parseJsonObject(text) : null;
  const jsonParsed = item.mode !== "json" || Boolean(parsedJson);
  const conceptSearchText = item.mode === "json" && parsedJson
    ? normalize(jsonValueText(parsedJson))
    : normalizedText;
  const missingKeys = item.requiredKeys?.filter((key) => !(parsedJson && Object.hasOwn(parsedJson, key))) ?? [];
  const incorrectJsonValues = Object.entries(requiredJsonValues(item)).filter(([key, expected]) => {
    return !(parsedJson && Object.is(parsedJson[key], expected));
  }).map(([key]) => key);
  const invalidJsonShapes = Object.entries(requiredJsonShapes(item)).flatMap(([key, shape]) => (
    parsedJson && Object.hasOwn(parsedJson, key)
      ? jsonShapeFailures(parsedJson[key], shape, key)
      : []
  ));
  const missingJsonMatches = requiredJsonMatches(item).filter((match) => (
    !jsonMatchSatisfied(parsedJson, match)
  )).map(jsonMatchLabel);
  const textSections = requiredTextSections(item);
  const missingTextSections = textSections.filter((section) => (
    !textSectionSatisfied(text, section, textSections)
  )).map(sectionLabel);
  const missingConcepts = requiredConcepts(item).filter((concept) => {
    return !conceptMatches(concept, conceptSearchText);
  }).map(conceptLabel);
  const forbiddenMentions = forbiddenConcepts(item).filter((concept) => (
    conceptMatches(concept, conceptSearchText, { polarityAware: true })
  )).map(conceptLabel);
  const schemaValid = jsonParsed && missingKeys.length === 0 && invalidJsonShapes.length === 0;
  return {
    schemaValid,
    jsonParsed,
    outputLength: text.length,
    missingKeys,
    incorrectJsonValues,
    invalidJsonShapes,
    missingJsonMatches,
    missingTextSections,
    missingConcepts,
    forbiddenMentions,
    passed: schemaValid && incorrectJsonValues.length === 0 && missingJsonMatches.length === 0 && missingTextSections.length === 0 && missingConcepts.length === 0 && forbiddenMentions.length === 0,
  };
}

async function main() {
  const evalSetPath = arg("eval-set") ?? DEFAULT_EVAL_SET_PATH;
  const evalSet = await readEvalSet(evalSetPath);
  const candidates = parseCandidates();
  const passPolicy = evalPassPolicy();
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
          latencyMs: Number.isFinite(error?.latencyMs) ? error.latencyMs : undefined,
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

  const report = {
    generatedAt: new Date().toISOString(),
    evalSet: evalSetPath,
    caseCount: evalSet.length,
    settings: {
      timeoutMs: DEFAULT_TIMEOUT_MS,
      maxTokens: DEFAULT_MAX_TOKENS,
      concurrency: DEFAULT_CONCURRENCY,
      retries: DEFAULT_RETRIES,
      passPolicy,
    },
    results,
  };

  console.log(JSON.stringify(report, null, 2));
  if (!evaluationPasses(results, passPolicy)) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

export {
  callCandidateWithRetries,
  conceptMatches,
  estimateCost,
  evaluationPasses,
  isRetryableRequestError,
  parseCandidates,
  scoreItem,
};
