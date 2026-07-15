type TelemetrySurface = "route" | "server_action" | "render" | "worker";
type TelemetryProvider = "azure" | "local" | "railway" | "vercel";
type TelemetrySinkStatus = "disabled" | "sampled" | "sent" | "failed";

export type CaptureTelemetryResult = {
  azure: TelemetrySinkStatus;
  posthog: TelemetrySinkStatus;
};

export type ErrorTelemetryInput = {
  action?: string | null;
  attributes?: Record<string, unknown>;
  code?: string | null;
  digest?: string | null;
  error?: unknown;
  errorClass?: string | null;
  method?: string | null;
  route?: string | null;
  status?: number | null;
  surface: TelemetrySurface;
  workspaceId?: string | null;
};

export type TelemetryEventInput = {
  distinctId?: string | null;
  event: string;
  properties?: Record<string, unknown>;
  timestamp?: string;
};

const DEFAULT_POSTHOG_API_HOST = "https://us.i.posthog.com";
const DEFAULT_TIMEOUT_MS = 1500;
const MAX_STRING_LENGTH = 500;
const SENSITIVE_PROPERTY = /(authorization|body|content|cookie|message|password|secret|session|stack|summary|token|transcript|api[_-]?key)/i;

function optional(env: NodeJS.ProcessEnv, name: string) {
  const value = env[name]?.trim();
  return value && value.length > 0 ? value : undefined;
}

function booleanFromEnv(env: NodeJS.ProcessEnv, name: string, fallback = false) {
  const value = optional(env, name);
  if (!value) return fallback;
  return value === "1" || value.toLowerCase() === "true";
}

function numberFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number) {
  const value = optional(env, name);
  if (!value) return fallback;
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    return fallback;
  }
  return parsed;
}

function postHogApiHost(env: NodeJS.ProcessEnv) {
  return (optional(env, "POSTHOG_API_HOST") ?? DEFAULT_POSTHOG_API_HOST).replace(/\/+$/, "");
}

function postHogEnabled(env: NodeJS.ProcessEnv) {
  return booleanFromEnv(env, "POSTHOG_ENABLED")
    && !booleanFromEnv(env, "POSTHOG_CAPTURE_KILL_SWITCH")
    && Boolean(optional(env, "POSTHOG_PROJECT_TOKEN"));
}

function runtimeProvider(env: NodeJS.ProcessEnv): TelemetryProvider {
  if (optional(env, "RAILWAY_SERVICE_ID") || optional(env, "RAILWAY_GIT_COMMIT_SHA")) return "railway";
  if (optional(env, "WEBSITE_SITE_NAME") || optional(env, "CONTAINER_APP_NAME") || optional(env, "APPLICATIONINSIGHTS_CONNECTION_STRING")) return "azure";
  if (optional(env, "VERCEL")) return "vercel";
  return "local";
}

function environmentName(env: NodeJS.ProcessEnv) {
  return optional(env, "POSTHOG_ENVIRONMENT")
    ?? optional(env, "NEXT_PUBLIC_VERCEL_ENV")
    ?? optional(env, "NODE_ENV")
    ?? "development";
}

function instanceId(env: NodeJS.ProcessEnv) {
  return optional(env, "POSTHOG_INSTANCE_ID")
    ?? optional(env, "MCP_DEFAULT_INSTANCE_SLUG")
    ?? optional(env, "WORKSPACE_SLUG")
    ?? optional(env, "RAILWAY_SERVICE_NAME")
    ?? optional(env, "WEBSITE_INSTANCE_ID")
    ?? optional(env, "HOSTNAME")
    ?? "corgtex";
}

function releaseGitSha(env: NodeJS.ProcessEnv) {
  const imageTag = optional(env, "CORGTEX_RELEASE_IMAGE_TAG");
  const imageTagSha = imageTag?.startsWith("sha-") ? imageTag.slice("sha-".length) : undefined;
  return optional(env, "CORGTEX_RELEASE_GIT_SHA")
    ?? optional(env, "RAILWAY_GIT_COMMIT_SHA")
    ?? optional(env, "VERCEL_GIT_COMMIT_SHA")
    ?? optional(env, "GITHUB_SHA")
    ?? imageTagSha;
}

export function telemetryRuntimeContext(env: NodeJS.ProcessEnv = process.env) {
  return {
    environment: environmentName(env),
    instance_id: instanceId(env),
    provider: runtimeProvider(env),
    release_git_sha: releaseGitSha(env),
    release_image_tag: optional(env, "CORGTEX_RELEASE_IMAGE_TAG"),
    release_version: optional(env, "CORGTEX_RELEASE_VERSION"),
  };
}

function hashBucket(input: string) {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 0xffffffff;
}

function shouldSample(env: NodeJS.ProcessEnv, event: string, distinctId: string) {
  const sampleRate = numberFromEnv(env, "POSTHOG_EVENT_SAMPLE_RATE", 1, 0, 1);
  if (sampleRate >= 1) return true;
  if (sampleRate <= 0) return false;
  return hashBucket(`${event}:${distinctId}`) <= sampleRate;
}

function normalizeString(value: string) {
  return value.trim().slice(0, MAX_STRING_LENGTH);
}

function sanitizeValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") return normalizeString(value);
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "boolean") return value;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : undefined;
  if (Array.isArray(value)) {
    if (depth >= 2) return undefined;
    return value.slice(0, 20).map((entry) => sanitizeValue(entry, depth + 1)).filter((entry) => entry !== undefined);
  }
  if (typeof value === "object") {
    if (depth >= 2) return undefined;
    return sanitizeProperties(value as Record<string, unknown>, depth + 1);
  }
  return undefined;
}

export function sanitizeProperties(properties: Record<string, unknown>, depth = 0) {
  const sanitized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(properties).slice(0, 80)) {
    if (!key || SENSITIVE_PROPERTY.test(key)) continue;
    const sanitizedValue = sanitizeValue(value, depth);
    if (sanitizedValue !== undefined) {
      sanitized[key.slice(0, 80)] = sanitizedValue;
    }
  }

  return sanitized;
}

function errorClass(error: unknown, fallback?: string | null) {
  if (fallback) return fallback.slice(0, 120);
  if (error instanceof Error) return error.name.slice(0, 120);
  return typeof error;
}

function errorStatus(error: unknown, fallback?: number | null) {
  if (typeof fallback === "number" && fallback >= 100 && fallback < 600) return fallback;
  if (error instanceof Error && "status" in error && typeof (error as { status?: unknown }).status === "number") {
    const status = (error as { status: number }).status;
    if (status >= 100 && status < 600) return status;
  }
  return 500;
}

function errorCode(error: unknown, fallback?: string | null) {
  if (fallback) return fallback.slice(0, 120);
  if (error instanceof Error && "code" in error && typeof (error as { code?: unknown }).code === "string") {
    return (error as { code: string }).code.slice(0, 120);
  }
  return "UNHANDLED_ERROR";
}

function distinctIdFor(input: ErrorTelemetryInput) {
  if (input.workspaceId) return `workspace:${input.workspaceId}`;
  return `${input.surface}:${input.action ?? input.route ?? "unknown"}`;
}

export function buildErrorTelemetryEvent(input: ErrorTelemetryInput, env: NodeJS.ProcessEnv = process.env): TelemetryEventInput {
  const status = errorStatus(input.error, input.status);
  const code = errorCode(input.error, input.code);
  const properties = sanitizeProperties({
    ...telemetryRuntimeContext(env),
    ...(input.attributes ?? {}),
    action: input.action,
    code,
    digest: input.digest,
    error_class: errorClass(input.error, input.errorClass),
    method: input.method?.toUpperCase(),
    route: input.route,
    status,
    surface: input.surface,
    workspace_id: input.workspaceId,
  });

  return {
    event: `corgtex_${input.surface}_error`,
    distinctId: distinctIdFor(input),
    properties,
  };
}

function appInsightsConnection(env: NodeJS.ProcessEnv) {
  const raw = optional(env, "APPLICATIONINSIGHTS_CONNECTION_STRING");
  if (!raw) return null;

  const parts = new Map<string, string>();
  for (const entry of raw.split(";")) {
    const index = entry.indexOf("=");
    if (index <= 0) continue;
    parts.set(entry.slice(0, index).trim().toLowerCase(), entry.slice(index + 1).trim());
  }

  const instrumentationKey = parts.get("instrumentationkey");
  if (!instrumentationKey) return null;

  const endpoint = (parts.get("ingestionendpoint") ?? "https://dc.services.visualstudio.com/").replace(/\/+$/, "");
  return {
    endpoint: `${endpoint}/v2/track`,
    instrumentationKey,
  };
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function capturePostHog(input: TelemetryEventInput, env: NodeJS.ProcessEnv) {
  if (!postHogEnabled(env)) return "disabled" as const;

  const event = normalizeString(input.event);
  const distinctId = normalizeString(input.distinctId ?? "corgtex:unknown");
  if (!event || !distinctId || !shouldSample(env, event, distinctId)) return "sampled" as const;

  const response = await fetchWithTimeout(`${postHogApiHost(env)}/i/v0/e/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: optional(env, "POSTHOG_PROJECT_TOKEN"),
      distinct_id: distinctId,
      event,
      properties: {
        ...sanitizeProperties(input.properties ?? {}),
        "$lib": "corgtex-server",
        "$process_person_profile": false,
        corgtex_sample_rate: numberFromEnv(env, "POSTHOG_EVENT_SAMPLE_RATE", 1, 0, 1),
      },
      timestamp: input.timestamp,
    }),
  }, numberFromEnv(env, "POSTHOG_CAPTURE_TIMEOUT_MS", DEFAULT_TIMEOUT_MS, 250, 10_000));

  return response.ok ? "sent" as const : "failed" as const;
}

async function captureAzure(input: TelemetryEventInput, env: NodeJS.ProcessEnv) {
  const connection = appInsightsConnection(env);
  if (!connection) return "disabled" as const;

  const properties = sanitizeProperties(input.properties ?? {});
  const response = await fetchWithTimeout(connection.endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify([{
      data: {
        baseData: {
          measurements: {},
          name: normalizeString(input.event),
          properties,
          ver: 2,
        },
        baseType: "EventData",
      },
      iKey: connection.instrumentationKey,
      name: "Microsoft.ApplicationInsights.Event",
      tags: {
        "ai.cloud.role": String(properties.instance_id ?? "corgtex"),
        "ai.cloud.roleInstance": String(properties.instance_id ?? "corgtex"),
      },
      time: input.timestamp ?? new Date().toISOString(),
    }]),
  }, numberFromEnv(env, "APPLICATIONINSIGHTS_CAPTURE_TIMEOUT_MS", DEFAULT_TIMEOUT_MS, 250, 10_000));

  return response.ok ? "sent" as const : "failed" as const;
}

export async function captureTelemetryEvent(
  input: TelemetryEventInput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CaptureTelemetryResult> {
  const event = {
    ...input,
    properties: sanitizeProperties({
      ...telemetryRuntimeContext(env),
      ...(input.properties ?? {}),
    }),
  };

  const [posthog, azure] = await Promise.all([
    capturePostHog(event, env).catch(() => "failed" as const),
    captureAzure(event, env).catch(() => "failed" as const),
  ]);

  return { azure, posthog };
}

export async function captureErrorTelemetry(
  input: ErrorTelemetryInput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CaptureTelemetryResult> {
  return captureTelemetryEvent(buildErrorTelemetryEvent(input, env), env);
}
