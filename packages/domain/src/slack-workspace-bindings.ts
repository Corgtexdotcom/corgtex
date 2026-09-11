import { env } from "@corgtex/shared";
import { AppError, invariant } from "./errors";

/** Contains operator secrets. Never serialize this binding into a DTO or log. */
export type SlackWorkspaceBinding = {
  workspaceId?: string;
  teamId: string | null;
  appId: string | null;
  clientId: string | null;
  clientSecret: string | null;
  signingSecret: string | null;
  scopes: string[] | null;
  source: "workspace" | "legacy";
};

type ScopedSlackBinding = {
  teamId: string;
  appId: string;
  clientId: string;
  clientSecret: string;
  signingSecret: string;
  scopes: string[];
};

const WORKSPACE_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const FIELDS = new Set(["teamId", "appId", "clientId", "clientSecret", "signingSecret", "scopes"]);
const SCOPE = /^[a-z][a-z0-9._-]*(?::[a-z][a-z0-9._-]*)*$/;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonblank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validBinding(value: unknown): value is ScopedSlackBinding {
  return record(value)
    && Object.keys(value).every((key) => FIELDS.has(key))
    && typeof value.teamId === "string" && /^T[A-Z0-9]+$/.test(value.teamId)
    && typeof value.appId === "string" && /^A[A-Z0-9]+$/.test(value.appId)
    && nonblank(value.clientId) && value.clientId === value.clientId.trim()
    && nonblank(value.clientSecret) && nonblank(value.signingSecret)
    && Array.isArray(value.scopes) && value.scopes.length > 0
    && value.scopes.every((scope) => typeof scope === "string" && SCOPE.test(scope))
    && new Set(value.scopes).size === value.scopes.length;
}

function invalidConfiguration(): never {
  throw new AppError(503, "SLACK_WORKSPACE_BINDINGS_INVALID", "Slack workspace configuration is invalid.");
}

export function slackWorkspaceBindingsEnabled(): boolean {
  return env.SLACK_WORKSPACE_BINDINGS_JSON !== undefined;
}

export function getSlackWorkspaceBinding(workspaceId?: string): SlackWorkspaceBinding | null {
  const raw = env.SLACK_WORKSPACE_BINDINGS_JSON;
  if (raw !== undefined) {
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return invalidConfiguration(); }
    if (!record(parsed) || Object.keys(parsed).length === 0) return invalidConfiguration();
    for (const [id, binding] of Object.entries(parsed)) {
      if (!WORKSPACE_ID.test(id) || !validBinding(binding)) return invalidConfiguration();
    }
    if (!workspaceId || !Object.hasOwn(parsed, workspaceId)) return null;
    const binding = parsed[workspaceId] as ScopedSlackBinding;
    return { ...binding, scopes: [...binding.scopes], workspaceId, source: "workspace" };
  }

  const clientId = env.SLACK_CLIENT_ID ?? null;
  const clientSecret = env.SLACK_CLIENT_SECRET ?? null;
  const signingSecret = env.SLACK_SIGNING_SECRET ?? null;
  const appId = env.SLACK_APP_ID ?? null;
  if (!clientId && !clientSecret && !signingSecret && !appId) return null;
  return { clientId, clientSecret, signingSecret, appId, teamId: null, scopes: null, source: "legacy" };
}

export function requireSlackWorkspaceBinding(workspaceId?: string): SlackWorkspaceBinding & {
  clientId: string;
  clientSecret: string;
  signingSecret: string;
} {
  const binding = getSlackWorkspaceBinding(workspaceId);
  invariant(binding?.clientId && binding.clientSecret && binding.signingSecret,
    503, "SLACK_NOT_CONFIGURED", "Slack is not configured for this workspace.");
  return { ...binding, clientId: binding.clientId, clientSecret: binding.clientSecret, signingSecret: binding.signingSecret };
}
