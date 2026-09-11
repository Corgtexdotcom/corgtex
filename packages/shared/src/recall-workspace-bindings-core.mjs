/** Shared pure credential resolver for domain code and plain-Node operator scripts.
 * Returned bindings contain secrets and must never be logged or serialized in a DTO.
 */
export class RecallBindingError extends Error {
  constructor(code, message) {
    super(message);
    this.status = 503;
    this.code = code;
  }
}

const WORKSPACE_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
// A region is a single DNS label within recall.ai, never an arbitrary host or URL.
const REGION = /^[a-z]{2}(?:-[a-z]+)+-[0-9]+$/;
const FIELDS = new Set(["apiKey", "webhookSecret", "region", "providerWorkspaceId"]);

function invalidConfiguration() {
  throw new RecallBindingError("RECALL_WORKSPACE_BINDINGS_INVALID", "Recall workspace configuration is invalid.");
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonblank(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function validRegion(value) {
  return typeof value === "string" && value.length <= 63 && REGION.test(value);
}

export function recallWorkspaceBindingsEnabledInEnv(env) {
  return env.RECALL_WORKSPACE_BINDINGS_JSON !== undefined;
}

export function resolveRecallWorkspaceBinding(env, workspaceId) {
  const raw = env.RECALL_WORKSPACE_BINDINGS_JSON;
  if (raw !== undefined) {
    let parsed;
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
    const value = parsed[workspaceId];
    return {
      apiKey: value.apiKey,
      webhookSecret: value.webhookSecret,
      region: value.region,
      providerWorkspaceId: value.providerWorkspaceId,
      workspaceId,
      source: "workspace",
    };
  }

  const apiKey = env.RECALL_API_KEY?.trim() || null;
  const webhookSecret = env.RECALL_WEBHOOK_SECRET?.trim() || null;
  if (!apiKey && !webhookSecret) return null;
  const region = env.RECALL_REGION?.trim() || "us-east-1";
  if (!validRegion(region)) return invalidConfiguration();
  return { apiKey, webhookSecret, region, providerWorkspaceId: null, source: "legacy" };
}

/** API operations require an API key; webhook verification separately requires its signing secret. */
export function requireRecallWorkspaceBindingFromEnv(env, workspaceId) {
  const binding = resolveRecallWorkspaceBinding(env, workspaceId);
  if (!binding?.apiKey) {
    throw new RecallBindingError("RECORDER_VENDOR_NOT_CONFIGURED", "Recall is not configured for this workspace.");
  }
  return { ...binding, apiKey: binding.apiKey };
}
