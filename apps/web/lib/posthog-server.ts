import { createHash } from "node:crypto";
import { telemetryRuntimeContext } from "@corgtex/shared/telemetry";

type CaptureStatus = "disabled" | "sampled" | "sent" | "failed";

type CaptureInput = {
  event: string;
  distinctId: string;
  properties?: Record<string, unknown>;
  timestamp?: string;
  processPersonProfile?: boolean;
};

type CaptureResult = {
  status: CaptureStatus;
  statusCode?: number;
};

const DEFAULT_API_HOST = "https://us.i.posthog.com";
const DEFAULT_TIMEOUT_MS = 1500;
const MAX_STRING_LENGTH = 500;
const SENSITIVE_PROPERTY = /(authorization|cookie|password|secret|token|api[_-]?key|session)/i;

function optional(name: string) {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : undefined;
}

function booleanFromEnv(name: string, fallback = false) {
  const value = optional(name);
  if (!value) return fallback;
  return value === "1" || value.toLowerCase() === "true";
}

function numberFromEnv(name: string, fallback: number, min: number, max: number) {
  const value = optional(name);
  if (!value) return fallback;
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    return fallback;
  }
  return parsed;
}

function apiHost() {
  return (optional("POSTHOG_API_HOST") ?? DEFAULT_API_HOST).replace(/\/+$/, "");
}

function captureEnabled() {
  return booleanFromEnv("POSTHOG_ENABLED")
    && !booleanFromEnv("POSTHOG_CAPTURE_KILL_SWITCH")
    && Boolean(optional("POSTHOG_PROJECT_TOKEN"));
}

function shouldSample(event: string, distinctId: string) {
  const sampleRate = numberFromEnv("POSTHOG_EVENT_SAMPLE_RATE", 1, 0, 1);
  if (sampleRate >= 1) return true;
  if (sampleRate <= 0) return false;

  const hash = createHash("sha256").update(`${event}:${distinctId}`).digest("hex").slice(0, 8);
  const bucket = Number.parseInt(hash, 16) / 0xffffffff;
  return bucket <= sampleRate;
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

function sanitizeProperties(properties: Record<string, unknown>, depth = 0) {
  const sanitized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(properties).slice(0, 50)) {
    if (!key || SENSITIVE_PROPERTY.test(key)) continue;
    const sanitizedValue = sanitizeValue(value, depth);
    if (sanitizedValue !== undefined) {
      sanitized[key.slice(0, 80)] = sanitizedValue;
    }
  }

  return sanitized;
}

function warnCaptureFailure(event: string, reason: unknown, statusCode?: number) {
  if (!booleanFromEnv("POSTHOG_CAPTURE_DEBUG")) return;
  console.warn("[posthog] capture failed", {
    event,
    reason: reason instanceof Error ? reason.message : String(reason),
    statusCode,
  });
}

export async function capturePostHogEvent(input: CaptureInput): Promise<CaptureResult> {
  if (!captureEnabled()) {
    return { status: "disabled" };
  }

  const event = normalizeString(input.event);
  const distinctId = normalizeString(input.distinctId);

  if (!event || !distinctId || !shouldSample(event, distinctId)) {
    return { status: "sampled" };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), numberFromEnv("POSTHOG_CAPTURE_TIMEOUT_MS", DEFAULT_TIMEOUT_MS, 250, 10_000));
  const properties = sanitizeProperties(input.properties ?? {});
  const runtime = telemetryRuntimeContext();

  try {
    const response = await fetch(`${apiHost()}/i/v0/e/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: optional("POSTHOG_PROJECT_TOKEN"),
        distinct_id: distinctId,
        event,
        properties: {
          ...properties,
          "$lib": "corgtex-server",
          "$process_person_profile": input.processPersonProfile ?? false,
          corgtex_environment: runtime.environment,
          corgtex_instance_id: runtime.instance_id,
          corgtex_provider: runtime.provider,
          corgtex_release_git_sha: runtime.release_git_sha,
          corgtex_release_git_sha_source: runtime.release_git_sha_source,
          corgtex_release_image_tag: runtime.release_image_tag,
          corgtex_release_version: runtime.release_version,
          corgtex_release_drift_git_sha: runtime.release_drift_git_sha,
          corgtex_release_drift_image_tag: runtime.release_drift_image_tag,
          corgtex_release_drift_version: runtime.release_drift_version,
          corgtex_sample_rate: numberFromEnv("POSTHOG_EVENT_SAMPLE_RATE", 1, 0, 1),
        },
        timestamp: input.timestamp,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      warnCaptureFailure(event, response.statusText, response.status);
      return { status: "failed", statusCode: response.status };
    }

    return { status: "sent", statusCode: response.status };
  } catch (error) {
    warnCaptureFailure(event, error);
    return { status: "failed" };
  } finally {
    clearTimeout(timeout);
  }
}
