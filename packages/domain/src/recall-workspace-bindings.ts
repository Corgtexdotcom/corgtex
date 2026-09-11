import { env } from "@corgtex/shared";
import { AppError } from "./errors";

/** Internal credential material. Never include this object in an API response or log. */
export type RecallWorkspaceBinding = {
  apiKey: string | null;
  webhookSecret: string | null;
  region: string;
  providerWorkspaceId: string | null;
  workspaceId?: string;
  source: "workspace" | "legacy";
};

const WORKSPACE_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
// A region is a single DNS label within recall.ai, never an arbitrary host or URL.
const REGION = /^[a-z]{2}(?:-[a-z]+)+-[0-9]+$/;
const FIELDS = new Set(["apiKey", "webhookSecret", "region", "providerWorkspaceId"]);

function invalidConfiguration(): never {
  throw new AppError(503, "RECALL_WORKSPACE_BINDINGS_INVALID", "Recall workspace configuration is invalid.");
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonblank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validRegion(value: unknown): value is string {
  return typeof value === "string" && value.length <= 63 && REGION.test(value);
}

export function recallWorkspaceBindingsEnabled(): boolean {
  return env.RECALL_WORKSPACE_BINDINGS_JSON !== undefined;
}

export function getRecallWorkspaceBinding(workspaceId?: string): RecallWorkspaceBinding | null {
  const raw = env.RECALL_WORKSPACE_BINDINGS_JSON;
  if (raw !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return invalidConfiguration();
    }
    if (!record(parsed) || Object.keys(parsed).length === 0) return invalidConfiguration();

    for (const [id, value] of Object.entries(parsed)) {
      if (!WORKSPACE_ID.test(id) || !record(value)
        || Object.keys(value).some((key) => !FIELDS.has(key))
        || !nonblank(value.apiKey) || !nonblank(value.webhookSecret)
        || !nonblank(value.providerWorkspaceId) || !validRegion(value.region)) {
        return invalidConfiguration();
      }
    }

    if (!workspaceId || !Object.hasOwn(parsed, workspaceId)) return null;
    const value = parsed[workspaceId] as Record<string, string>;
    return {
      apiKey: value.apiKey,
      webhookSecret: value.webhookSecret,
      region: value.region,
      providerWorkspaceId: value.providerWorkspaceId,
      workspaceId,
      source: "workspace",
    };
  }

  const apiKey = env.RECALL_API_KEY ?? null;
  const webhookSecret = env.RECALL_WEBHOOK_SECRET ?? null;
  if (!apiKey && !webhookSecret) return null;
  const region = env.RECALL_REGION;
  if (!validRegion(region)) return invalidConfiguration();
  return { apiKey, webhookSecret, region, providerWorkspaceId: null, source: "legacy" };
}

/** API operations require an API key; webhook verification separately requires its signing secret. */
export function requireRecallWorkspaceBinding(workspaceId?: string): RecallWorkspaceBinding & { apiKey: string } {
  const binding = getRecallWorkspaceBinding(workspaceId);
  if (!binding?.apiKey) {
    throw new AppError(503, "RECORDER_VENDOR_NOT_CONFIGURED", "Recall is not configured for this workspace.");
  }
  return { ...binding, apiKey: binding.apiKey };
}
