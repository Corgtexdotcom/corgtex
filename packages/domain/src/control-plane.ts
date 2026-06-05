import type { CustomerDeploymentAccessRole, FleetSnapshotKind, MeetingRecorderProvider, MemberRole, Prisma } from "@prisma/client";
import { decryptSecret, encryptSecret, env, prisma, toInputJson } from "@corgtex/shared";
import type { AgentActor, AppActor } from "@corgtex/shared";
import { AppError, invariant } from "./errors";
import { isGlobalOperator } from "./auth";
import { createMember, deactivateMember, listMembersEnriched, resendMemberAccessLink, sendMemberSetupEmail, updateMember } from "./members";
import {
  enqueueRecorderCalendarSync,
  getMeetingRecorderEnterpriseReadiness,
  getMeetingRecorderMonthlyUsage,
  getRecorderCalendarSource,
  MEETING_RECORDERS_FEATURE_FLAG,
  runMeetingRecorderSmoke,
  scanRecorderCalendarSource,
  upsertRecorderCalendarSource,
} from "./meeting-recorders";
import { createControlPlaneAdapter } from "./control-plane-adapters";
import { createRailwayClientFromEnv, upgradeRailwayCustomerRelease, type RailwayClient } from "./railway-client";
import { AGENT_REGISTRY } from "./agent-registry";
import { isKnownScope } from "./agent-auth";

const SUPPORT_ACTOR_LABEL = "Corgtex Support";
const DEFAULT_RECORDER_BOT_NAME = "Corgtex Recorder";
const DEFAULT_RECORDER_ENTRY_MESSAGE = "Corgtex is joining to record, transcribe, and summarize this meeting for the workspace.";
const DEFAULT_RECORDER_MONTHLY_MINUTE_CAP = 6_000;
const MEETING_RECORDER_PROVIDERS = new Set(["RECALL_AI", "MEETING_BAAS"]);
const CONTROL_PLANE_CONTEXT_OPERATIONS = new Set(["sync_all", "sync_source", "disable_source"]);
const CONTROL_PLANE_RELEASE_OPERATIONS = new Set(["prepare_upgrade"]);
const CONTROL_PLANE_READ_SCOPE = "control-plane:read";
const CONTROL_PLANE_AI_GOVERNANCE_WRITE_SCOPE = "control-plane:ai-governance:write";
const CONTROL_PLANE_DEPLOYMENT_WRITE_ROLES = new Set<CustomerDeploymentAccessRole>(["SUPPORT_ADMIN", "CUSTOMER_IT_ADMIN"]);
export const CONTROL_PLANE_FLEET_SNAPSHOT_JOB_TYPE = "control-plane.fleet-snapshot";
export const CONTROL_PLANE_RELEASE_DEPLOY_JOB_TYPE = "control-plane.release.deploy-latest";
const AGENT_GOVERNANCE_FEATURE_FLAG = "AGENT_GOVERNANCE";
const STALE_CREDENTIAL_DAYS = 90;
const CONTROL_PLANE_SNAPSHOT_KINDS = new Set<FleetSnapshotKind>([
  "HEALTH",
  "RELEASE",
  "CONNECTOR",
  "CONTEXT",
  "INTEGRATION",
  "SUPPORT_READY",
]);

const MUTATING_SUPPORT_ACTIONS = new Set([
  "members.invite",
  "members.update",
  "members.deactivate",
  "members.resend_access_link",
  "feature_flags.set",
  "data_feeds.sync",
  "tool_links.upsert",
  "tool_links.archive",
  "documents.upload_text",
  "context_graph.import_map",
  "proposals.create",
  "proposals.update",
  "proposals.submit",
  "proposals.resolve",
  "proposals.return_to_draft",
  "proposals.reopen_resolved",
  "actions.create",
  "actions.update",
  "actions.complete",
  "actions.return_to_draft",
  "tensions.create",
  "tensions.update",
  "tensions.return_to_draft",
  "meetings.upload",
  "runtime.retry_failed_job",
  "runtime.discard_failed_job",
  "agent_credentials.update_scopes",
  "agent_credentials.revoke",
  "model_budget.update",
  "agent_config.update_policy",
  "support.break_glass_note",
]);

const SUPPORT_ACTION_TO_MCP_TOOL = {
  "members.list": "list_members",
  "members.invite": "create_member",
  "members.update": "update_member",
  "members.deactivate": "deactivate_member",
  "members.resend_access_link": "resend_member_access_link",
  "feature_flags.list": "list_feature_flags",
  "feature_flags.set": "set_feature_flag",
  "integrations.list": "list_integrations",
  "data_feeds.list": "list_data_sources",
  "data_feeds.sync": "sync_data_source",
  "tool_links.list": "list_tool_links",
  "tool_links.upsert": "upsert_tool_link",
  "tool_links.archive": "archive_tool_link",
  "agents.list_runs": "list_agent_runs",
  "runtime.list_jobs": "list_runtime_jobs",
  "runtime.list_failed_jobs": "list_failed_jobs",
  "runtime.retry_failed_job": "retry_failed_job",
  "runtime.discard_failed_job": "discard_failed_job",
  "agent_credentials.list": "list_agent_credentials",
  "agent_credentials.update_scopes": "update_agent_credential_scopes",
  "agent_credentials.revoke": "revoke_agent_credential",
  "model_budget.get": "get_model_budget",
  "model_budget.update": "update_model_budget",
  "agent_config.list": "list_agent_configs",
  "agent_config.update_policy": "update_agent_policy",
  "documents.upload_text": "upload_document_text",
  "context_graph.import_map": "import_context_graph_map",
  "proposals.list": "list_proposals",
  "proposals.get": "get_proposal",
  "proposals.create": "create_proposal",
  "proposals.update": "update_proposal",
  "proposals.submit": "submit_proposal",
  "proposals.resolve": "resolve_proposal",
  "proposals.return_to_draft": "return_proposal_to_draft",
  "proposals.reopen_resolved": "support_reopen_resolved_proposals",
  "actions.list": "list_actions",
  "actions.create": "create_action",
  "actions.update": "update_action",
  "actions.complete": "complete_action",
  "actions.return_to_draft": "return_action_to_draft",
  "tensions.list": "list_tensions",
  "tensions.create": "create_tension",
  "tensions.update": "update_tension",
  "tensions.return_to_draft": "return_tension_to_draft",
  "meetings.list": "list_meetings",
  "meetings.get": "get_meeting",
  "meetings.upload": "upload_meeting",
} as const;

export type SupportAction = keyof typeof SUPPORT_ACTION_TO_MCP_TOOL;

type JsonRecord = Record<string, unknown>;

export const CONTROL_PLANE_WORKSPACE_FEATURE_FLAGS = [
  { flag: "GOALS", label: "Goals", description: "Goal trees, recognition, and progress tracking.", defaultEnabled: true },
  { flag: "TOOL_LINKS", label: "Tools catalog", description: "Shared tool links, catalog approvals, and credentials.", defaultEnabled: false },
  { flag: "FINANCE", label: "Finance", description: "Spend requests, ledgers, and finance workflows.", defaultEnabled: true },
  { flag: "BUILD_ARTIFACTS", label: "Build artifacts", description: "Workspace build artifact publishing and review.", defaultEnabled: false },
  { flag: "RELATIONSHIPS", label: "Relationships", description: "CRM, leads, and relationship workspace views.", defaultEnabled: true },
  { flag: "CONTEXT_MAPS", label: "Context maps", description: "Living company context graph maps, graph evidence, and region-scoped agent context.", defaultEnabled: false },
  { flag: "CYCLES", label: "Cycles", description: "Planning cycles, updates, and allocations.", defaultEnabled: true },
  { flag: "AGENT_GOVERNANCE", label: "Agent governance", description: "Agent registry, access, spend, and observability controls.", defaultEnabled: true },
  { flag: "OS_METRICS", label: "OS metrics", description: "Governance health and operating-system metrics.", defaultEnabled: true },
  { flag: "SETTINGS_GENERAL", label: "General settings", description: "General workspace configuration screens.", defaultEnabled: true },
  { flag: "MULTILINGUAL", label: "Multilingual", description: "Locale switcher and translated workspace UI.", defaultEnabled: false },
  { flag: "MEETING_RECORDERS", label: "Meeting recorders", description: "Managed meeting recorder entitlement and recorder config.", defaultEnabled: false },
  { flag: "MEETING_CONTEXTUAL_INTELLIGENCE", label: "Context-aware meeting intelligence", description: "Use workspace context to summarize meetings and automatically update related governance records.", defaultEnabled: false },
  { flag: "CONTEXT_MAP_AI", label: "Context map AI", description: "Premium chat tools for reading, reasoning about, and applying living context map graph changes.", defaultEnabled: false },
  { flag: "SLACK_MEETING_ACTION_REVIEW", label: "Slack meeting action review", description: "Post meeting summaries and proposed action-item follow-ups to an approved Slack review surface before action creation.", defaultEnabled: false },
  { flag: "AI_WORKSPACES", label: "AI workspaces", description: "Catalog and setup foundation for OpenWork, ChatGPT, Claude, Gemini, Cursor, Claude Code, and generic MCP clients.", defaultEnabled: false },
  { flag: "OPENWORK_DEFAULT", label: "OpenWork default", description: "Recommend OpenWork as the default free self-managed AI workspace.", defaultEnabled: false },
  { flag: "EXECUTION_PACKETS", label: "Execution packets", description: "Durable execution request, context packet, and result write-back plumbing.", defaultEnabled: false },
  { flag: "MANAGED_ENTERPRISE_SERVICES", label: "Managed enterprise services", description: "CORGTEX-managed service ownership, health, usage, and support escalation foundation.", defaultEnabled: false },
] as const;

export type ControlPlaneWorkspaceFeatureFlag = typeof CONTROL_PLANE_WORKSPACE_FEATURE_FLAGS[number]["flag"];

const CONTROL_PLANE_WORKSPACE_FEATURE_FLAG_SET = new Set<string>(
  CONTROL_PLANE_WORKSPACE_FEATURE_FLAGS.map((definition) => definition.flag),
);

const CONTROL_PLANE_MEMBER_ROLES = new Set(["CONTRIBUTOR", "FACILITATOR", "FINANCE_STEWARD", "ADMIN"]);

export type ControlPlaneFleetSort =
  | "customer"
  | "health"
  | "release"
  | "support"
  | "region"
  | "owner"
  | "updated";

export type ControlPlaneClientOption = {
  id: string;
  label: string;
  slug: string | null;
  healthStatus: string;
  releaseLabel: string;
  hasDeployment: boolean;
  managedWorkspaceId: string | null;
  supportConnectorStatus: string | null;
};

export type ControlPlaneMatrixStatus = "ok" | "attention" | "down" | "unknown";

export type ControlPlaneRecorderMatrixStatus =
  | "ready"
  | "needs_setup"
  | "disabled"
  | "requires_connector"
  | "unavailable";

export type ControlPlaneRecorderMatrixRow = {
  deploymentId: string;
  clientLabel: string;
  clientSlug: string | null;
  hasDeployment: boolean;
  hasManagedWorkspace: boolean;
  supportConnectorStatus: string | null;
  entitlementEnabled: boolean | null;
  configured: boolean | null;
  provider: MeetingRecorderProvider | null;
  monthlyUsageMinutes: number | null;
  monthlyMinuteCap: number | null;
  failureCount: number | null;
  status: ControlPlaneRecorderMatrixStatus;
  readiness: {
    ready: boolean | null;
    detail: string;
    failedChecks: Array<{
      key: string;
      label: string;
      detail: string;
    }>;
  };
  calendarSource: {
    label: string;
    status: string | null;
    lastSyncAt: Date | null;
  } | null;
  lastSmokeRun: {
    status: string;
    createdAt: Date | null;
  } | null;
};

export type ControlPlaneMatrixRow = {
  id: string;
  label: string;
  slug: string | null;
  hasDeployment: boolean;
  ownerEmail: string | null;
  health: {
    status: string;
    tone: ControlPlaneMatrixStatus;
    detail: string | null;
  };
  release: {
    label: string;
    status: "aligned" | "drift" | "unknown";
    detail: string | null;
  };
  support: {
    status: string;
    detail: string;
    mode: "managed" | "remote" | "account_only";
  };
  recorder: Pick<ControlPlaneRecorderMatrixRow, "status" | "provider" | "monthlyUsageMinutes" | "failureCount" | "readiness">;
  agents: {
    status: string;
    detail: string;
    runCount: number | null;
  };
  users: {
    status: string;
    detail: string;
    count: number | null;
  };
};

export type ControlPlaneReleasePreflightCheck = {
  key: string;
  label: string;
  ok: boolean;
  detail: string;
};

export type ControlPlaneReleaseTarget = {
  releaseImageTag: string;
  releaseVersion: string | null;
  webImage: string;
  workerImage: string;
};

const managedWorkspaceSelect = {
  id: true,
  slug: true,
  name: true,
  plan: true,
  planActivatedAt: true,
  trialEndsAt: true,
  billingProfile: {
    select: {
      billingStatus: true,
      stripeCustomerId: true,
      stripeSubscriptionId: true,
      paymentMethodReady: true,
      failedPaymentAt: true,
      canceledAt: true,
      updatedAt: true,
    },
  },
  _count: {
    select: {
      members: true,
      externalDataSources: true,
      brainArticles: true,
      brainSources: true,
      agentRuns: true,
      workflowJobs: true,
      communicationInstallations: true,
      meetingRecordings: true,
    },
  },
} satisfies Prisma.WorkspaceSelect;

const controlPlaneDeploymentInclude = {
  supportOperations: {
    orderBy: { createdAt: "desc" },
    take: 3,
  },
  managedWorkspace: {
    select: managedWorkspaceSelect,
  },
  fleetSnapshots: {
    orderBy: { createdAt: "desc" },
    take: 6,
  },
  _count: {
    select: { supportOperations: true, events: true },
  },
} satisfies Prisma.CustomerDeploymentInclude;

function decimalToString(value: unknown) {
  if (!value) return null;
  return typeof value === "object" && "toString" in value ? String(value.toString()) : String(value);
}

function actorUserId(actor: AppActor) {
  return actor.kind === "user" ? actor.user.id : null;
}

function customerAccountSummary(account: {
  id: string;
  slug: string;
  displayName: string;
  status: string;
  managementAuthority: string;
  supportOwnerEmail: string | null;
  notes: string | null;
  primaryDeploymentId: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: account.id,
    slug: account.slug,
    displayName: account.displayName,
    status: account.status,
    managementAuthority: account.managementAuthority,
    supportOwnerEmail: account.supportOwnerEmail,
    notes: account.notes,
    primaryDeploymentId: account.primaryDeploymentId,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
}

function isControlPlaneAgent(actor: AppActor): actor is AgentActor & { authProvider: "control-plane" } {
  return actor.kind === "agent" && actor.authProvider === "control-plane";
}

function parseControlPlaneScopes(value: string | undefined) {
  return (value ?? CONTROL_PLANE_READ_SCOPE)
    .split(/[,\s]+/)
    .map((scope) => scope.trim())
    .filter(Boolean);
}

function hasControlPlaneScope(actor: AppActor, scope: string) {
  if (!isControlPlaneAgent(actor)) return true;
  const scopes = new Set(actor.scopes?.length ? actor.scopes : [CONTROL_PLANE_READ_SCOPE]);
  return scopes.has("control-plane:*") || scopes.has(scope);
}

export function requireControlPlaneScope(actor: AppActor, scope: string) {
  invariant(hasControlPlaneScope(actor, scope), 403, "CONTROL_PLANE_SCOPE_REQUIRED", `Control Plane scope required: ${scope}.`);
}

function redactValue(key: string, value: unknown): unknown {
  const normalizedKey = key.toLowerCase();
  const isSecretLikeKey = /token|secret|password|authorization|bearer|connectionstring/.test(normalizedKey)
    || normalizedKey === "supportcredential"
    || (normalizedKey.includes("credential") && /(enc|hash|secret|token|password|value)$/.test(normalizedKey));
  if (isSecretLikeKey) {
    return "[redacted]";
  }
  if (typeof value === "string" && value.length > 500) {
    return `${value.slice(0, 500)}...`;
  }
  if (Array.isArray(value)) {
    return value.map((item) => (typeof item === "object" && item !== null ? redactObject(item as JsonRecord) : item));
  }
  if (value && typeof value === "object") {
    return redactObject(value as JsonRecord);
  }
  return value;
}

export function redactObject(value: JsonRecord): JsonRecord {
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, redactValue(key, entry)]),
  );
}

function normalizeReason(reason: string | null | undefined, action: string) {
  const trimmed = reason?.trim();
  if (trimmed) return trimmed;
  invariant(!MUTATING_SUPPORT_ACTIONS.has(action), 400, "SUPPORT_REASON_REQUIRED", "A support reason is required for mutating support actions.");
  return "Read-only support inspection.";
}

function requireMutationReason(reason: string | null | undefined) {
  const trimmed = reason?.trim();
  invariant(trimmed, 400, "CONTROL_PLANE_REASON_REQUIRED", "A reason is required for Control Plane mutations.");
  return trimmed;
}

function normalizeMeetingRecorderProvider(value: string | null | undefined, label: string) {
  const normalized = value?.trim();
  invariant(normalized && MEETING_RECORDER_PROVIDERS.has(normalized), 400, "INVALID_INPUT", `Invalid ${label}.`);
  return normalized as MeetingRecorderProvider;
}

function normalizeContextOperation(value: string) {
  invariant(CONTROL_PLANE_CONTEXT_OPERATIONS.has(value), 400, "INVALID_INPUT", "Unsupported context operation.");
  return value as "sync_all" | "sync_source" | "disable_source";
}

function normalizeReleaseOperation(value: string) {
  invariant(CONTROL_PLANE_RELEASE_OPERATIONS.has(value), 400, "INVALID_INPUT", "Unsupported release operation.");
  return value as "prepare_upgrade";
}

function normalizeSnapshotKinds(values?: readonly string[] | null) {
  const requested = values?.length ? values : Array.from(CONTROL_PLANE_SNAPSHOT_KINDS);
  return Array.from(new Set(requested.map((value) => value.trim().toUpperCase()))).map((value) => {
    invariant(CONTROL_PLANE_SNAPSHOT_KINDS.has(value as FleetSnapshotKind), 400, "INVALID_INPUT", `Unsupported fleet snapshot kind: ${value}.`);
    return value as FleetSnapshotKind;
  });
}

function readPositiveInteger(value: string | undefined, fallback: number, max: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

function boundedInteger(value: number | null | undefined, fallback: number, min: number, max: number) {
  const parsed = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.min(Math.max(parsed, min), max);
}

function deploymentHealthStatus(status: string) {
  if (status === "ok") return "ACTIVE" as const;
  if (status === "degraded" || status === "down") return "DEGRADED" as const;
  return undefined;
}

function contextSnapshotStatus(value: { summary?: { failedSyncJobs?: number; failedExternalSources?: number; staleExternalSources?: number } | null; supportConnectorStatus?: string | null }) {
  if (value.summary) {
    return (value.summary.failedSyncJobs || value.summary.failedExternalSources || value.summary.staleExternalSources) ? "degraded" : "ok";
  }
  return value.supportConnectorStatus ?? "not_configured";
}

function integrationSnapshotStatus(value: { integrations?: Array<{ status?: string | null; configured?: boolean | null }> }) {
  const integrations = value.integrations ?? [];
  if (integrations.length === 0) return "not_configured";
  if (integrations.some((integration) => integration.status === "ERROR" || integration.status === "degraded" || integration.status === "failed")) {
    return "degraded";
  }
  if (integrations.some((integration) => integration.configured)) return "ok";
  return "not_configured";
}

function releaseSnapshotStatus(value: {
  health?: { lastHealthStatus?: string | null; lastHealthError?: string | null };
  rollbackReady?: boolean;
}) {
  if (value.health?.lastHealthStatus === "ok" && value.rollbackReady) return "ok";
  if (value.health?.lastHealthStatus === "degraded" || value.health?.lastHealthStatus === "down" || value.health?.lastHealthError) return "degraded";
  return "unknown";
}

function connectorSnapshotStatus(status: string | null | undefined) {
  if (!status || status === "not_configured") return "not_configured";
  if (status === "connected" || status === "configured") return "ok";
  return status;
}

function supportSnapshotStatus(snapshot: JsonRecord) {
  return Object.values(snapshot).some((value) => (
    value && typeof value === "object" && "error" in value
  )) ? "degraded" : "ok";
}

async function recordFleetHealthSnapshot(params: {
  customerAccountId: string | null | undefined;
  deploymentId?: string | null;
  snapshotKind: FleetSnapshotKind;
  status: string;
  summary?: unknown;
  error?: string | null;
}) {
  if (!params.customerAccountId) {
    return null;
  }

  return prisma.fleetHealthSnapshot.create({
    data: {
      customerAccountId: params.customerAccountId,
      deploymentId: params.deploymentId ?? null,
      snapshotKind: params.snapshotKind,
      status: params.status,
      summary: params.summary && typeof params.summary === "object"
        ? redactObject(params.summary as JsonRecord) as Prisma.InputJsonObject
        : params.summary === undefined ? undefined : { value: params.summary } as Prisma.InputJsonObject,
      error: params.error ?? null,
      observedAt: new Date(),
    },
  });
}

const controlPlaneWorkerActor: AppActor = {
  kind: "agent",
  authProvider: "control-plane",
  label: "control-plane-worker",
  workspaceIds: [],
  scopes: ["control-plane:*"],
};

function normalizeSupportMcpUrl(deployment: { url: string; supportMcpUrl?: string | null }) {
  if (deployment.supportMcpUrl?.trim()) {
    return deployment.supportMcpUrl.trim();
  }
  return `${deployment.url.replace(/\/$/, "")}/api/mcp`;
}

function summarizeMcpResponse(value: unknown) {
  if (!value || typeof value !== "object") return value;
  const response = value as { content?: Array<{ text?: unknown }>; structuredContent?: unknown };
  if (response.structuredContent) return response.structuredContent;
  const text = response.content?.find((item) => typeof item.text === "string")?.text;
  if (typeof text !== "string") return value;
  try {
    return JSON.parse(text);
  } catch {
    return { text: text.slice(0, 1000) };
  }
}

function supportMcpErrorMessage(value: unknown) {
  const record = jsonRecord(value);
  const text = typeof value === "string" ? value : stringField(record?.text);
  if (!text) return null;
  return /MCP credential is missing the required scope|Control Plane scope required|Workspace membership required|FORBIDDEN|INVALID_SIGNATURE/i.test(text)
    ? text
    : null;
}

async function callMcpTool(params: {
  mcpUrl: string;
  bearerToken: string;
  toolName: string;
  arguments: JsonRecord;
}) {
  const response = await fetch(params.mcpUrl, {
    method: "POST",
    headers: {
      "authorization": `Bearer ${params.bearerToken}`,
      "content-type": "application/json",
      "accept": "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: `support-${Date.now()}`,
      method: "tools/call",
      params: {
        name: params.toolName,
        arguments: params.arguments,
      },
    }),
  });

  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const message = body?.error?.message ?? `Remote MCP request failed with status ${response.status}.`;
    throw new AppError(response.status, "REMOTE_SUPPORT_ERROR", message);
  }
  if (body?.error) {
    throw new AppError(502, "REMOTE_SUPPORT_ERROR", String(body.error.message ?? "Remote MCP tool failed."));
  }
  return body?.result ?? body;
}

async function loadSupportConnector(deploymentId: string) {
  const deployment = await prisma.customerDeployment.findUnique({
    where: { id: deploymentId },
    select: {
      id: true,
      label: true,
      url: true,
      customerSlug: true,
      customerAccountId: true,
      deploymentKind: true,
      deploymentStatus: true,
      supportMcpUrl: true,
      supportCredentialEnc: true,
      supportConnectorStatus: true,
    },
  });
  invariant(deployment, 404, "NOT_FOUND", "Customer deployment not found.");
  invariant(deployment.supportCredentialEnc, 400, "SUPPORT_CONNECTOR_MISSING", "Support connector credentials are not configured for this deployment.");
  return {
    deployment,
    mcpUrl: normalizeSupportMcpUrl(deployment),
    bearerToken: decryptSecret(deployment.supportCredentialEnc),
  };
}

async function recordCustomerDeploymentEvent(actor: AppActor, deploymentId: string, action: string, meta: JsonRecord = {}) {
  await prisma.customerDeploymentEvent.create({
    data: {
      deploymentId,
      actorUserId: actorUserId(actor),
      action,
      meta: redactObject(meta) as Prisma.InputJsonObject,
    },
  });
}

async function recordRemoteSupportAudit(params: {
  mcpUrl: string;
  bearerToken: string;
  action: string;
  reason: string;
  operationId: string;
  phase: "started" | "completed" | "failed";
  result?: unknown;
  error?: string | null;
}) {
  await callMcpTool({
    mcpUrl: params.mcpUrl,
    bearerToken: params.bearerToken,
    toolName: "record_support_audit",
    arguments: {
      action: `support.${params.action}`,
      reason: params.reason,
      operationId: params.operationId,
      phase: params.phase,
      result: params.result && typeof params.result === "object" ? redactObject(params.result as JsonRecord) : params.result,
      error: params.error ?? null,
    },
  });
}

export async function requireControlPlaneAccess(actor: AppActor, params: { deploymentId?: string } = {}) {
  if (isGlobalOperator(actor)) {
    return { role: "OPERATOR" as const };
  }

  if (isControlPlaneAgent(actor)) {
    requireControlPlaneScope(actor, CONTROL_PLANE_READ_SCOPE);
    return { role: "OPERATOR" as const };
  }

  if (actor.kind === "user" && params.deploymentId) {
    const access = await prisma.customerDeploymentAccess.findUnique({
      where: {
        deploymentId_userId: {
          deploymentId: params.deploymentId,
          userId: actor.user.id,
        },
      },
      select: { role: true, isActive: true },
    });
    if (access?.isActive) {
      return { role: access.role };
    }
  }

  throw new AppError(403, "FORBIDDEN", "Control plane access is required.");
}

async function requireControlPlaneDeploymentWriteAccess(actor: AppActor, deploymentId: string) {
  if (isGlobalOperator(actor)) {
    return { role: "OPERATOR" as const };
  }

  if (isControlPlaneAgent(actor)) {
    requireControlPlaneScope(actor, CONTROL_PLANE_READ_SCOPE);
    return { role: "OPERATOR" as const };
  }

  if (actor.kind === "user") {
    const access = await prisma.customerDeploymentAccess.findUnique({
      where: {
        deploymentId_userId: {
          deploymentId,
          userId: actor.user.id,
        },
      },
      select: { role: true, isActive: true },
    });
    if (access?.isActive && CONTROL_PLANE_DEPLOYMENT_WRITE_ROLES.has(access.role)) {
      return { role: access.role };
    }
  }

  throw new AppError(403, "CONTROL_PLANE_WRITE_ACCESS_REQUIRED", "Control plane write access is required for this deployment.");
}

function requireControlPlaneFleetReleaseWriteAccess(actor: AppActor) {
  if (isGlobalOperator(actor)) return;
  if (isControlPlaneAgent(actor)) {
    requireControlPlaneScope(actor, "control-plane:releases:write");
    return;
  }
  throw new AppError(403, "CONTROL_PLANE_WRITE_ACCESS_REQUIRED", "Global control plane release access is required for fleet-wide rollouts.");
}

export async function listControlPlaneDeployments(actor: AppActor) {
  await requireControlPlaneAccess(actor);

  const accounts = await prisma.customerAccount.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      primaryDeployment: {
        include: controlPlaneDeploymentInclude,
      },
      deployments: {
        orderBy: { createdAt: "desc" },
        take: 5,
        include: controlPlaneDeploymentInclude,
      },
      fleetSnapshots: {
        orderBy: { createdAt: "desc" },
        take: 6,
      },
    },
  });
  const accountRows = accounts.map((account) => {
    const accountSummary = customerAccountSummary(account);
    const deployment = account.primaryDeployment
      ?? account.deployments.find((candidate) => candidate.deploymentStatus === "ACTIVE")
      ?? account.deployments[0]
      ?? null;
    if (!deployment) {
      return {
        id: account.id,
        label: account.displayName,
        url: "",
        environment: "production",
        notes: account.notes,
        customerSlug: account.slug,
        customerAccountId: account.id,
        customerAccount: accountSummary,
        hasDeployment: false,
        deploymentKind: null,
        deploymentStatus: "DRAFT" as const,
        remoteWorkspaceSlug: null,
        remoteWorkspaceId: null,
        region: null,
        dataResidency: null,
        customDomain: null,
        supportOwnerEmail: account.supportOwnerEmail,
        provisioningStatus: "draft",
        bootstrapStatus: "not_started",
        releaseVersion: null,
        releaseImageTag: null,
        railwayProjectId: null,
        railwayEnvironmentId: null,
        railwayWebServiceId: null,
        railwayWorkerServiceId: null,
        railwayPostgresServiceId: null,
        railwayRedisServiceId: null,
        storageBucketName: null,
        bootstrapBundleUri: null,
        bootstrapBundleChecksum: null,
        bootstrapBundleSchemaVersion: null,
        lastProvisioningError: null,
        lastHealthCheck: null,
        lastHealthStatus: null,
        lastHealthError: null,
        lastWorkerHealthCheck: null,
        lastWorkerHealthStatus: null,
        lastReleaseCheck: null,
        supportBaseUrl: null,
        supportMcpUrl: null,
        supportCredentialLabel: null,
        supportConnectorStatus: "not_configured",
        supportAccessMode: "broad",
        supportLastConnectedAt: null,
        supportLastSyncAt: null,
        supportLastSyncError: null,
        supportNotes: null,
        managedWorkspaceId: null,
        managedWorkspace: null,
        supportOperations: [],
        fleetSnapshots: account.fleetSnapshots,
        hasSupportCredential: false,
        supportCredentialEnc: undefined,
        createdAt: account.createdAt,
        updatedAt: account.updatedAt,
        _count: { supportOperations: 0, events: 0 },
      };
    }
    return {
      ...deployment,
      customerAccount: accountSummary,
      customerAccountId: account.id,
      hasDeployment: true,
      hasSupportCredential: Boolean(deployment.supportCredentialEnc),
      supportCredentialEnc: undefined,
    };
  });

  const orphanedDeployments = await prisma.customerDeployment.findMany({
    where: { customerAccountId: null },
    orderBy: { createdAt: "desc" },
    include: controlPlaneDeploymentInclude,
  });

  const orphanedDeploymentRows = orphanedDeployments.map((deployment) => ({
    ...deployment,
    customerAccount: null,
    hasDeployment: true,
    hasSupportCredential: Boolean(deployment.supportCredentialEnc),
    supportCredentialEnc: undefined,
  }));

  return [...accountRows, ...orphanedDeploymentRows];
}

function normalizedStatus(value: unknown) {
  return typeof value === "string" ? value.toLowerCase() : "";
}

function latestSnapshotForKind(deployment: { fleetSnapshots?: Array<{ snapshotKind: FleetSnapshotKind; status: string; observedAt: Date; createdAt?: Date; summary?: unknown; error?: string | null }> }, kind: FleetSnapshotKind) {
  return deployment.fleetSnapshots?.find((snapshot) => snapshot.snapshotKind === kind) ?? null;
}

function fleetRowMatchesQuery(row: Awaited<ReturnType<typeof listControlPlaneDeployments>>[number], query: string) {
  if (!query) return true;
  return [
    row.label,
    row.customerSlug,
    row.url,
    row.environment,
    row.region,
    row.dataResidency,
    row.supportOwnerEmail,
    row.releaseImageTag,
    row.releaseVersion,
    row.customerAccount?.displayName,
    row.customerAccount?.slug,
    row.managedWorkspace?.name,
    row.managedWorkspace?.slug,
  ].some((value) => value?.toLowerCase().includes(query));
}

function fleetSortValue(row: Awaited<ReturnType<typeof listControlPlaneDeployments>>[number], sort: ControlPlaneFleetSort) {
  if (sort === "customer") return row.label?.toLowerCase() ?? "";
  if (sort === "health") return normalizedStatus(row.lastHealthStatus || latestSnapshotForKind(row, "HEALTH")?.status || row.provisioningStatus);
  if (sort === "release") return (row.releaseImageTag || row.releaseVersion || "").toLowerCase();
  if (sort === "support") return normalizedStatus(row.supportConnectorStatus || latestSnapshotForKind(row, "SUPPORT_READY")?.status);
  if (sort === "region") return (row.region || "").toLowerCase();
  if (sort === "owner") return (row.supportOwnerEmail || "").toLowerCase();
  return row.updatedAt?.getTime?.() ?? row.createdAt?.getTime?.() ?? 0;
}

function compareFleetRows(
  a: Awaited<ReturnType<typeof listControlPlaneDeployments>>[number],
  b: Awaited<ReturnType<typeof listControlPlaneDeployments>>[number],
  sort: ControlPlaneFleetSort,
  direction: "asc" | "desc",
) {
  const av = fleetSortValue(a, sort);
  const bv = fleetSortValue(b, sort);
  const result = typeof av === "number" && typeof bv === "number"
    ? av - bv
    : String(av).localeCompare(String(bv));
  return direction === "asc" ? result : -result;
}

export async function listControlPlaneFleetPage(actor: AppActor, params: {
  query?: string | null;
  health?: string | null;
  support?: string | null;
  region?: string | null;
  owner?: string | null;
  sort?: string | null;
  direction?: string | null;
  page?: number | null;
  pageSize?: number | null;
} = {}) {
  const rows = await listControlPlaneDeployments(actor);
  const query = params.query?.trim().toLowerCase() ?? "";
  const health = params.health?.trim().toLowerCase() ?? "";
  const support = params.support?.trim().toLowerCase() ?? "";
  const region = params.region?.trim().toLowerCase() ?? "";
  const owner = params.owner?.trim().toLowerCase() ?? "";
  const sort = (["customer", "health", "release", "support", "region", "owner", "updated"].includes(params.sort ?? "")
    ? params.sort
    : "updated") as ControlPlaneFleetSort;
  const direction = params.direction === "asc" ? "asc" : "desc";
  const pageSize = boundedInteger(params.pageSize, 25, 10, 100);
  const page = boundedInteger(params.page, 1, 1, Number.MAX_SAFE_INTEGER);

  const filtered = rows.filter((row) => {
    const healthValue = normalizedStatus(row.lastHealthStatus || latestSnapshotForKind(row, "HEALTH")?.status || row.provisioningStatus);
    const supportValue = normalizedStatus(row.supportConnectorStatus || latestSnapshotForKind(row, "SUPPORT_READY")?.status);
    return fleetRowMatchesQuery(row, query)
      && (!health || healthValue === health)
      && (!support || supportValue === support)
      && (!region || row.region?.toLowerCase() === region)
      && (!owner || row.supportOwnerEmail?.toLowerCase() === owner);
  }).sort((a, b) => compareFleetRows(a, b, sort, direction));

  const pageCount = Math.max(Math.ceil(filtered.length / pageSize), 1);
  const currentPage = Math.min(page, pageCount);
  const start = (currentPage - 1) * pageSize;
  const items = filtered.slice(start, start + pageSize);
  const regions = Array.from(new Set(rows.map((row) => row.region).filter(Boolean) as string[])).sort();
  const owners = Array.from(new Set(rows.map((row) => row.supportOwnerEmail).filter(Boolean) as string[])).sort();

  return {
    items,
    total: filtered.length,
    page: currentPage,
    pageSize,
    pageCount,
    filters: {
      query,
      health,
      support,
      region,
      owner,
      sort,
      direction,
      regions,
      owners,
    },
    summary: {
      totalCustomers: rows.length,
      active: rows.filter((row) => row.provisioningStatus === "active").length,
      attention: rows.filter((row) => normalizedStatus(row.lastHealthStatus) && normalizedStatus(row.lastHealthStatus) !== "ok").length,
      supportReady: rows.filter((row) => Boolean(row.hasSupportCredential) && row.supportConnectorStatus !== "degraded").length,
      releaseDrift: rows.filter((row) => row.lastHealthError?.includes("Release drift:")).length,
    },
  };
}

type ControlPlaneDeploymentRow = Awaited<ReturnType<typeof listControlPlaneDeployments>>[number];

function controlPlaneRowSlug(row: ControlPlaneDeploymentRow) {
  return row.customerSlug
    ?? row.customerAccount?.slug
    ?? row.managedWorkspace?.slug
    ?? row.remoteWorkspaceSlug
    ?? null;
}

function controlPlaneHealthStatus(row: ControlPlaneDeploymentRow) {
  return row.lastHealthStatus || latestSnapshotForKind(row, "HEALTH")?.status || row.provisioningStatus || "unknown";
}

function controlPlaneReleaseLabel(row: ControlPlaneDeploymentRow) {
  return row.releaseImageTag || row.releaseVersion || "Unknown";
}

function controlPlaneReleaseDrift(row: ControlPlaneDeploymentRow) {
  return row.lastHealthError?.includes("Release drift:")
    ? row.lastHealthError
    : latestSnapshotForKind(row, "RELEASE")?.error ?? null;
}

function controlPlaneMatrixTone(status?: string | null): ControlPlaneMatrixStatus {
  const normalized = normalizedStatus(status);
  if (["ok", "active", "connected", "configured", "ready", "completed", "aligned"].includes(normalized)) return "ok";
  if (["down", "failed", "error", "suspended"].includes(normalized)) return "down";
  if (["attention", "degraded", "provisioning", "pending", "needs_setup", "requires_connector", "unavailable"].includes(normalized)) {
    return "attention";
  }
  return "unknown";
}

function controlPlaneSupportSummary(row: ControlPlaneDeploymentRow): ControlPlaneMatrixRow["support"] {
  if (!row.hasDeployment) {
    return {
      status: "not_configured",
      detail: "Deployment not provisioned.",
      mode: "account_only",
    };
  }
  if (row.managedWorkspaceId) {
    return {
      status: "managed",
      detail: "Managed workspace is available locally.",
      mode: "managed",
    };
  }
  const cachedSnapshot = latestSnapshotForKind(row, "SUPPORT_READY");
  const status = row.hasSupportCredential
    ? row.supportConnectorStatus || cachedSnapshot?.status || "configured"
    : cachedSnapshot?.status || "requires_connector";
  return {
    status,
    detail: row.hasSupportCredential
      ? "Support connector can inspect remote workspace state."
      : "Support connector is required for live remote inspection.",
    mode: "remote",
  };
}

function controlPlaneAgentSummary(row: ControlPlaneDeploymentRow): ControlPlaneMatrixRow["agents"] {
  const runCount = row.managedWorkspace?._count?.agentRuns ?? null;
  if (runCount !== null) {
    return {
      status: runCount > 0 ? "active" : "idle",
      detail: runCount > 0 ? `${runCount} run(s) recorded locally.` : "No local agent runs recorded.",
      runCount,
    };
  }

  const snapshot = latestSnapshotForKind(row, "SUPPORT_READY");
  const cached = summarizeCachedSupportReadySnapshot(snapshot
    ? {
      status: snapshot.status,
      summary: snapshot.summary,
      error: snapshot.error ?? null,
      observedAt: snapshot.observedAt,
      createdAt: snapshot.createdAt ?? snapshot.observedAt,
    }
    : null);
  const cachedRunCount = Object.values(cached.summary?.agentRuns ?? {}).reduce((total, count) => total + count, 0);
  if (cachedRunCount > 0) {
    return {
      status: cached.riskFindings.length > 0 ? "attention" : "cached",
      detail: `${cachedRunCount} run(s) from cached support snapshot.`,
      runCount: cachedRunCount,
    };
  }

  return {
    status: row.hasSupportCredential ? "unavailable" : "requires_connector",
    detail: row.hasSupportCredential ? "No cached agent snapshot is available." : "Support connector is required for remote agent visibility.",
    runCount: null,
  };
}

function controlPlaneUsersSummary(row: ControlPlaneDeploymentRow): ControlPlaneMatrixRow["users"] {
  const count = row.managedWorkspace?._count?.members ?? null;
  if (count !== null) {
    return {
      status: "managed",
      detail: `${count} member(s) in the managed workspace.`,
      count,
    };
  }
  return {
    status: row.hasSupportCredential ? "unavailable" : "requires_connector",
    detail: row.hasSupportCredential ? "Use the client detail members tab for connector-backed users." : "Support connector is required for remote users.",
    count: null,
  };
}

function recorderProviderFromValue(value: unknown): MeetingRecorderProvider | null {
  return typeof value === "string" && MEETING_RECORDER_PROVIDERS.has(value)
    ? value as MeetingRecorderProvider
    : null;
}

function dateField(value: unknown) {
  if (value instanceof Date) return value;
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? null : parsed;
}

function fallbackRecorderRow(row: ControlPlaneDeploymentRow, status: ControlPlaneRecorderMatrixStatus, detail: string): ControlPlaneRecorderMatrixRow {
  return {
    deploymentId: row.id,
    clientLabel: row.label,
    clientSlug: controlPlaneRowSlug(row),
    hasDeployment: row.hasDeployment,
    hasManagedWorkspace: Boolean(row.managedWorkspaceId),
    supportConnectorStatus: row.supportConnectorStatus,
    entitlementEnabled: null,
    configured: null,
    provider: null,
    monthlyUsageMinutes: null,
    monthlyMinuteCap: null,
    failureCount: null,
    status,
    readiness: {
      ready: null,
      detail,
      failedChecks: [],
    },
    calendarSource: null,
    lastSmokeRun: null,
  };
}

function cachedRemoteRecorderRow(row: ControlPlaneDeploymentRow): ControlPlaneRecorderMatrixRow {
  const snapshot = latestSnapshotForKind(row, "INTEGRATION");
  const summary = jsonRecord(snapshot?.summary);
  const integrations = arrayItems(summary?.integrations, ["items", "integrations"]);
  const recorder = integrations.find((integration) => {
    const key = stringField(integration.key)?.toLowerCase();
    const label = stringField(integration.label)?.toLowerCase();
    return key === "meeting_recorders" || key === "recorder" || Boolean(label?.includes("recorder"));
  });
  if (!recorder) {
    return fallbackRecorderRow(
      row,
      row.hasSupportCredential ? "unavailable" : "requires_connector",
      row.hasSupportCredential
        ? "No cached recorder integration snapshot is available."
        : "Support connector is required for remote recorder visibility.",
    );
  }

  const ready = booleanField(recorder.vendorReadiness) ?? booleanField(recorder.ready);
  const entitlementEnabled = booleanField(recorder.entitlementEnabled);
  const configured = booleanField(recorder.configured);
  const rawStatus = normalizedStatus(stringField(recorder.status));
  const status: ControlPlaneRecorderMatrixStatus = ready
    ? "ready"
    : entitlementEnabled === false || rawStatus === "disabled"
      ? "disabled"
      : configured === false || rawStatus === "needs_setup"
        ? "needs_setup"
        : rawStatus === "enabled" || rawStatus === "active"
          ? "needs_setup"
          : "unavailable";
  const usage = jsonRecord(recorder.usage);
  const failures = typeof recorder.failures === "number" ? recorder.failures : null;
  const calendarSource = jsonRecord(recorder.calendarSource);
  const lastSmokeRun = jsonRecord(recorder.lastSmokeRun);

  return {
    deploymentId: row.id,
    clientLabel: row.label,
    clientSlug: controlPlaneRowSlug(row),
    hasDeployment: row.hasDeployment,
    hasManagedWorkspace: false,
    supportConnectorStatus: row.supportConnectorStatus,
    entitlementEnabled,
    configured,
    provider: recorderProviderFromValue(recorder.provider),
    monthlyUsageMinutes: typeof usage?.usedMinutes === "number" ? usage.usedMinutes : null,
    monthlyMinuteCap: typeof recorder.monthlyMinuteCap === "number" ? recorder.monthlyMinuteCap : null,
    failureCount: failures,
    status,
    readiness: {
      ready,
      detail: snapshot?.error ?? (ready ? "Cached recorder snapshot is ready." : "Cached recorder snapshot needs review."),
      failedChecks: [],
    },
    calendarSource: calendarSource
      ? {
        label: stringField(calendarSource.providerAccountEmail) ?? stringField(calendarSource.providerAccountId) ?? "Remote calendar",
        status: stringField(calendarSource.status),
        lastSyncAt: dateField(calendarSource.lastSyncAt),
      }
      : null,
    lastSmokeRun: lastSmokeRun
      ? {
        status: stringField(lastSmokeRun.status) ?? "unknown",
        createdAt: dateField(lastSmokeRun.createdAt),
      }
      : null,
  };
}

async function buildManagedRecorderRow(row: ControlPlaneDeploymentRow): Promise<ControlPlaneRecorderMatrixRow> {
  if (!row.managedWorkspaceId) return cachedRemoteRecorderRow(row);

  const [config, usage, failureCount, readiness] = await Promise.all([
    prisma.workspaceMeetingRecorderConfig.findUnique({ where: { workspaceId: row.managedWorkspaceId } }),
    getMeetingRecorderMonthlyUsage(row.managedWorkspaceId),
    prisma.meetingRecording.count({
      where: {
        workspaceId: row.managedWorkspaceId,
        status: "FAILED",
      },
    }),
    getMeetingRecorderEnterpriseReadiness(row.managedWorkspaceId),
  ]);
  const entitlementEnabled = readiness.checks.find((check) => check.key === "entitlement")?.ok ?? false;
  const failedChecks = readiness.checks
    .filter((check) => !check.ok)
    .map((check) => ({
      key: check.key,
      label: check.label,
      detail: check.detail,
    }));
  const status: ControlPlaneRecorderMatrixStatus = !entitlementEnabled
    ? "disabled"
    : !config
      ? "needs_setup"
      : !config.enabled
        ? "disabled"
        : readiness.ready
          ? "ready"
          : "needs_setup";
  const calendarLabel = readiness.calendarSource?.providerAccountEmail
    ?? readiness.calendarSource?.providerAccountId
    ?? null;

  return {
    deploymentId: row.id,
    clientLabel: row.label,
    clientSlug: controlPlaneRowSlug(row),
    hasDeployment: row.hasDeployment,
    hasManagedWorkspace: true,
    supportConnectorStatus: row.supportConnectorStatus,
    entitlementEnabled,
    configured: Boolean(config),
    provider: config?.defaultProvider ?? readiness.config.defaultProvider,
    monthlyUsageMinutes: usage.usedMinutes,
    monthlyMinuteCap: config?.monthlyMinuteCap ?? readiness.config.monthlyMinuteCap,
    failureCount,
    status,
    readiness: {
      ready: readiness.ready,
      detail: failedChecks[0]?.detail ?? "Recorder readiness checks are passing.",
      failedChecks,
    },
    calendarSource: readiness.calendarSource
      ? {
        label: calendarLabel ?? "Microsoft calendar",
        status: readiness.calendarSource.status,
        lastSyncAt: readiness.calendarSource.lastSyncAt,
      }
      : null,
    lastSmokeRun: readiness.lastSmokeRun
      ? {
        status: readiness.lastSmokeRun.status,
        createdAt: readiness.lastSmokeRun.createdAt,
      }
      : null,
  };
}

async function buildControlPlaneRecorderRows(rows: ControlPlaneDeploymentRow[]) {
  return Promise.all(rows.map(async (row) => {
    if (!row.hasDeployment) {
      return fallbackRecorderRow(row, "unavailable", "Deployment is not provisioned yet.");
    }
    if (!row.managedWorkspaceId) {
      return cachedRemoteRecorderRow(row);
    }
    return buildManagedRecorderRow(row);
  }));
}

function controlPlaneMatrixRow(row: ControlPlaneDeploymentRow, recorder: ControlPlaneRecorderMatrixRow): ControlPlaneMatrixRow {
  const healthStatus = controlPlaneHealthStatus(row);
  const releaseDrift = controlPlaneReleaseDrift(row);
  const support = controlPlaneSupportSummary(row);
  return {
    id: row.id,
    label: row.label,
    slug: controlPlaneRowSlug(row),
    hasDeployment: row.hasDeployment,
    ownerEmail: row.supportOwnerEmail,
    health: {
      status: healthStatus,
      tone: controlPlaneMatrixTone(healthStatus),
      detail: row.lastHealthError ?? latestSnapshotForKind(row, "HEALTH")?.error ?? null,
    },
    release: {
      label: controlPlaneReleaseLabel(row),
      status: releaseDrift ? "drift" : controlPlaneReleaseLabel(row) === "Unknown" ? "unknown" : "aligned",
      detail: releaseDrift,
    },
    support,
    recorder: {
      status: recorder.status,
      provider: recorder.provider,
      monthlyUsageMinutes: recorder.monthlyUsageMinutes,
      failureCount: recorder.failureCount,
      readiness: recorder.readiness,
    },
    agents: controlPlaneAgentSummary(row),
    users: controlPlaneUsersSummary(row),
  };
}

export async function getControlPlaneClientOptions(actor: AppActor): Promise<ControlPlaneClientOption[]> {
  const rows = await listControlPlaneDeployments(actor);
  return rows
    .filter((row) => row.hasDeployment)
    .map((row) => ({
      id: row.id,
      label: row.label,
      slug: controlPlaneRowSlug(row),
      healthStatus: controlPlaneHealthStatus(row),
      releaseLabel: controlPlaneReleaseLabel(row),
      hasDeployment: row.hasDeployment,
      managedWorkspaceId: row.managedWorkspaceId,
      supportConnectorStatus: row.supportConnectorStatus,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

export async function listControlPlaneMatrix(actor: AppActor, params: Parameters<typeof listControlPlaneFleetPage>[1] = {}) {
  const fleet = await listControlPlaneFleetPage(actor, params);
  const recorderRows = await buildControlPlaneRecorderRows(fleet.items);
  const recorderByDeploymentId = new Map(recorderRows.map((row) => [row.deploymentId, row]));
  return {
    ...fleet,
    items: fleet.items.map((row) => controlPlaneMatrixRow(row, recorderByDeploymentId.get(row.id) ?? fallbackRecorderRow(
      row,
      "unavailable",
      "Recorder state is unavailable.",
    ))),
    matrixSummary: {
      recordersReady: recorderRows.filter((row) => row.status === "ready").length,
      recordersNeedSetup: recorderRows.filter((row) => row.status === "needs_setup").length,
      remoteConnectorRequired: recorderRows.filter((row) => row.status === "requires_connector").length,
    },
  };
}

export async function listControlPlaneRecorderMatrix(actor: AppActor, params: {
  query?: string | null;
  client?: string | null;
  status?: string | null;
  page?: number | null;
  pageSize?: number | null;
} = {}) {
  const rows = await listControlPlaneDeployments(actor);
  const query = params.query?.trim().toLowerCase() ?? "";
  const client = params.client?.trim().toLowerCase() ?? "";
  const status = params.status?.trim().toLowerCase() ?? "";
  const pageSize = boundedInteger(params.pageSize, 25, 10, 100);
  const page = boundedInteger(params.page, 1, 1, Number.MAX_SAFE_INTEGER);

  const recorderRows = await buildControlPlaneRecorderRows(rows);
  const filtered = recorderRows.filter((row) => {
    const matchesQuery = !query || [
      row.clientLabel,
      row.clientSlug,
      row.provider,
      row.supportConnectorStatus,
      row.readiness.detail,
      row.calendarSource?.label,
    ].some((value) => value?.toLowerCase().includes(query));
    const matchesClient = !client || row.deploymentId.toLowerCase() === client || row.clientSlug?.toLowerCase() === client;
    const matchesStatus = !status || row.status === status;
    return matchesQuery && matchesClient && matchesStatus;
  });
  const pageCount = Math.max(Math.ceil(filtered.length / pageSize), 1);
  const currentPage = Math.min(page, pageCount);
  const start = (currentPage - 1) * pageSize;

  return {
    items: filtered.slice(start, start + pageSize),
    total: filtered.length,
    page: currentPage,
    pageSize,
    pageCount,
    filters: {
      query,
      client,
      status,
    },
    summary: {
      totalClients: recorderRows.length,
      ready: recorderRows.filter((row) => row.status === "ready").length,
      needsSetup: recorderRows.filter((row) => row.status === "needs_setup").length,
      disabled: recorderRows.filter((row) => row.status === "disabled").length,
      unavailable: recorderRows.filter((row) => row.status === "unavailable").length,
      requiresConnector: recorderRows.filter((row) => row.status === "requires_connector").length,
    },
  };
}

export async function getControlPlaneDeployment(actor: AppActor, deploymentId: string) {
  await requireControlPlaneAccess(actor, { deploymentId });

  const deployment = await prisma.customerDeployment.findUnique({
    where: { id: deploymentId },
    include: {
      events: {
        orderBy: { createdAt: "desc" },
        take: 20,
      },
      supportOperations: {
        orderBy: { createdAt: "desc" },
        take: 30,
      },
      accessGrants: {
        where: { isActive: true },
        include: { user: { select: { id: true, email: true, displayName: true } } },
        orderBy: { createdAt: "desc" },
      },
      customerAccount: true,
      fleetSnapshots: {
        orderBy: { createdAt: "desc" },
        take: 12,
      },
      managedWorkspace: {
        select: managedWorkspaceSelect,
      },
    },
  });
  invariant(deployment, 404, "NOT_FOUND", "Customer deployment not found.");

  return {
    ...deployment,
    hasSupportCredential: Boolean(deployment.supportCredentialEnc),
    supportCredentialEnc: undefined,
  };
}

async function getControlPlaneDeploymentWithWorkspace(actor: AppActor, deploymentId: string) {
  await requireControlPlaneAccess(actor, { deploymentId });
  const deployment = await prisma.customerDeployment.findUnique({
    where: { id: deploymentId },
    include: {
      managedWorkspace: {
        select: managedWorkspaceSelect,
      },
    },
  });
  invariant(deployment, 404, "NOT_FOUND", "Customer deployment not found.");
  return {
    ...deployment,
    hasSupportCredential: Boolean(deployment.supportCredentialEnc),
    supportCredentialEnc: undefined,
  };
}

function requireKnownMemberRole(role: string): MemberRole {
  invariant(CONTROL_PLANE_MEMBER_ROLES.has(role), 400, "INVALID_INPUT", "Unsupported member role.");
  return role as MemberRole;
}

function normalizeMemberRow(member: {
  id: string;
  role: string;
  isActive: boolean;
  joinedAt?: Date | string | null;
  userId?: string | null;
  email?: string | null;
  userEmail?: string | null;
  displayName?: string | null;
  name?: string | null;
  user?: { id?: string; email?: string | null; displayName?: string | null };
  roleAssignments?: Array<{ role?: { name?: string; circle?: { id?: string; name?: string } } }>;
}) {
  const email = member.user?.email ?? member.email ?? member.userEmail ?? null;
  const displayName = member.user?.displayName ?? member.displayName ?? member.name ?? null;

  return {
    id: member.id,
    userId: member.user?.id ?? member.userId ?? null,
    email,
    displayName,
    role: member.role,
    isActive: member.isActive,
    joinedAt: member.joinedAt ?? null,
    roleAssignments: (member.roleAssignments ?? []).map((assignment) => ({
      roleName: assignment.role?.name ?? null,
      circleId: assignment.role?.circle?.id ?? null,
      circleName: assignment.role?.circle?.name ?? null,
    })),
  };
}

function normalizeRemoteMembers(summary: unknown) {
  const value = summary && typeof summary === "object" && "members" in summary
    ? (summary as { members?: unknown }).members
    : summary;
  return Array.isArray(value)
    ? value.map((member) => normalizeMemberRow(member as Parameters<typeof normalizeMemberRow>[0]))
    : [];
}

export async function listControlPlaneCustomerMembers(actor: AppActor, deploymentId: string) {
  const deployment = await getControlPlaneDeploymentWithWorkspace(actor, deploymentId);
  const adapter = createControlPlaneAdapter(deployment);

  if (deployment.managedWorkspaceId) {
    const members = await listMembersEnriched(deployment.managedWorkspaceId, { includeInactive: true });
    return {
      deploymentId,
      accessMode: adapter.kind,
      source: "managed_workspace" as const,
      members: members.map(normalizeMemberRow),
    };
  }

  invariant(adapter.canUseSupportConnector && deployment.hasSupportCredential, 400, "SUPPORT_CONNECTOR_REQUIRED", "Support connector is required to inspect remote members.");
  const operation = await runCustomerSupportOperation(actor, {
    deploymentId,
    action: "members.list",
    reason: "Read customer members from Ops Control Plane.",
    arguments: { includeInactive: true },
    remoteWorkspaceId: deployment.remoteWorkspaceId,
  });

  return {
    deploymentId,
    accessMode: adapter.kind,
    source: "support_connector" as const,
    operationId: operation.id,
    members: normalizeRemoteMembers(operation.resultSummary),
  };
}

export async function createControlPlaneCustomerMember(actor: AppActor, params: {
  deploymentId: string;
  email: string;
  displayName?: string | null;
  role: string;
  reason?: string | null;
}) {
  requireControlPlaneScope(actor, "control-plane:access:write");
  const reason = requireMutationReason(params.reason);
  const role = requireKnownMemberRole(params.role);
  await requireControlPlaneDeploymentWriteAccess(actor, params.deploymentId);
  const deployment = await getControlPlaneDeploymentWithWorkspace(actor, params.deploymentId);
  const adapter = createControlPlaneAdapter(deployment);

  if (deployment.managedWorkspaceId) {
    const result = await createMember(actor, {
      workspaceId: deployment.managedWorkspaceId,
      email: params.email,
      displayName: params.displayName ?? null,
      role,
      skipAdminCheck: true,
    });
    const emailStatus = await sendMemberSetupEmail({
      email: result.user.email,
      displayName: result.user.displayName,
      token: result.token,
      workspaceName: deployment.managedWorkspace?.name ?? deployment.label,
    });
    await recordCustomerDeploymentEvent(actor, params.deploymentId, "control_plane.access.member_created", {
      reason,
      source: "managed_workspace",
      memberId: result.member.id,
      email: result.user.email,
      role,
      emailStatus,
    });
    return {
      deploymentId: params.deploymentId,
      accessMode: adapter.kind,
      source: "managed_workspace" as const,
      member: normalizeMemberRow({ ...result.member, user: result.user }),
      emailStatus,
    };
  }

  invariant(adapter.canUseSupportConnector && deployment.hasSupportCredential, 400, "SUPPORT_CONNECTOR_REQUIRED", "Support connector is required to create remote members.");
	  const operation = await runCustomerSupportOperation(actor, {
	    deploymentId: params.deploymentId,
	    action: "members.invite",
	    scopeOverride: "control-plane:access:write",
	    reason,
    arguments: {
      email: params.email,
      displayName: params.displayName ?? null,
      role,
      sendSetupEmail: true,
    },
    remoteWorkspaceId: deployment.remoteWorkspaceId,
  });
  await recordCustomerDeploymentEvent(actor, params.deploymentId, "control_plane.access.member_created", {
    reason,
    source: "support_connector",
    email: params.email,
    role,
    operationId: operation.id,
  });
  return {
    deploymentId: params.deploymentId,
    accessMode: adapter.kind,
    source: "support_connector" as const,
    operation,
  };
}

export async function resendControlPlaneCustomerMemberAccessLink(actor: AppActor, params: {
  deploymentId: string;
  memberId: string;
  reason?: string | null;
}) {
  requireControlPlaneScope(actor, "control-plane:access:write");
  const reason = requireMutationReason(params.reason);
  await requireControlPlaneDeploymentWriteAccess(actor, params.deploymentId);
  const deployment = await getControlPlaneDeploymentWithWorkspace(actor, params.deploymentId);
  const adapter = createControlPlaneAdapter(deployment);

  if (deployment.managedWorkspaceId) {
    const result = await resendMemberAccessLink(actor, {
      workspaceId: deployment.managedWorkspaceId,
      memberId: params.memberId,
    });
    const emailStatus = await sendMemberSetupEmail({
      email: result.user.email,
      displayName: result.user.displayName,
      token: result.token,
      workspaceName: deployment.managedWorkspace?.name ?? deployment.label,
    });
    await recordCustomerDeploymentEvent(actor, params.deploymentId, "control_plane.access.link_resent", {
      reason,
      source: "managed_workspace",
      memberId: params.memberId,
      email: result.user.email,
      emailStatus,
    });
    return {
      deploymentId: params.deploymentId,
      accessMode: adapter.kind,
      source: "managed_workspace" as const,
      memberId: params.memberId,
      emailStatus,
    };
  }

  invariant(adapter.canUseSupportConnector && deployment.hasSupportCredential, 400, "SUPPORT_CONNECTOR_REQUIRED", "Support connector is required to resend remote member access links.");
	  const operation = await runCustomerSupportOperation(actor, {
	    deploymentId: params.deploymentId,
	    action: "members.resend_access_link",
	    scopeOverride: "control-plane:access:write",
	    reason,
    arguments: { memberId: params.memberId, sendSetupEmail: true },
    remoteWorkspaceId: deployment.remoteWorkspaceId,
  });
  await recordCustomerDeploymentEvent(actor, params.deploymentId, "control_plane.access.link_resent", {
    reason,
    source: "support_connector",
    memberId: params.memberId,
    operationId: operation.id,
  });
  return {
    deploymentId: params.deploymentId,
    accessMode: adapter.kind,
    source: "support_connector" as const,
    operation,
  };
}

export async function updateControlPlaneCustomerMemberStatus(actor: AppActor, params: {
  deploymentId: string;
  memberId: string;
  isActive: boolean;
  reason?: string | null;
}) {
  requireControlPlaneScope(actor, "control-plane:access:write");
  const reason = requireMutationReason(params.reason);
  await requireControlPlaneDeploymentWriteAccess(actor, params.deploymentId);
  const deployment = await getControlPlaneDeploymentWithWorkspace(actor, params.deploymentId);
  const adapter = createControlPlaneAdapter(deployment);

  if (deployment.managedWorkspaceId) {
    const updated = params.isActive
      ? await updateMember(actor, { workspaceId: deployment.managedWorkspaceId, memberId: params.memberId, isActive: true })
      : await deactivateMember(actor, { workspaceId: deployment.managedWorkspaceId, memberId: params.memberId });
    await recordCustomerDeploymentEvent(actor, params.deploymentId, params.isActive ? "control_plane.access.member_reactivated" : "control_plane.access.member_deactivated", {
      reason,
      source: "managed_workspace",
      memberId: params.memberId,
    });
    return {
      deploymentId: params.deploymentId,
      accessMode: adapter.kind,
      source: "managed_workspace" as const,
      member: normalizeMemberRow(updated),
    };
  }

  invariant(adapter.canUseSupportConnector && deployment.hasSupportCredential, 400, "SUPPORT_CONNECTOR_REQUIRED", "Support connector is required to update remote member access.");
	  const operation = await runCustomerSupportOperation(actor, {
	    deploymentId: params.deploymentId,
	    action: params.isActive ? "members.update" : "members.deactivate",
	    scopeOverride: "control-plane:access:write",
	    reason,
    arguments: params.isActive ? { memberId: params.memberId, isActive: true } : { memberId: params.memberId },
    remoteWorkspaceId: deployment.remoteWorkspaceId,
  });
  await recordCustomerDeploymentEvent(actor, params.deploymentId, params.isActive ? "control_plane.access.member_reactivated" : "control_plane.access.member_deactivated", {
    reason,
    source: "support_connector",
    memberId: params.memberId,
    operationId: operation.id,
  });
  return {
    deploymentId: params.deploymentId,
    accessMode: adapter.kind,
    source: "support_connector" as const,
    operation,
  };
}

function requireKnownWorkspaceFeatureFlag(flag: string): ControlPlaneWorkspaceFeatureFlag {
  invariant(CONTROL_PLANE_WORKSPACE_FEATURE_FLAG_SET.has(flag), 400, "INVALID_INPUT", "Unsupported workspace feature flag.");
  return flag as ControlPlaneWorkspaceFeatureFlag;
}

function featureFlagDefinition(flag: string) {
  return CONTROL_PLANE_WORKSPACE_FEATURE_FLAGS.find((definition) => definition.flag === flag);
}

function normalizeRemoteFeatureFlags(summary: unknown) {
  const value = summary && typeof summary === "object" && "flags" in summary
    ? (summary as { flags?: unknown }).flags
    : summary;
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is JsonRecord => Boolean(entry && typeof entry === "object"))
    .map((entry) => {
      const flag = typeof entry.flag === "string" ? entry.flag : "";
      const definition = featureFlagDefinition(flag);
      return {
        flag,
        label: typeof entry.label === "string" ? entry.label : definition?.label ?? flag,
        description: typeof entry.description === "string" ? entry.description : definition?.description ?? "",
        enabled: Boolean(entry.enabled),
        defaultEnabled: Boolean(entry.defaultEnabled ?? definition?.defaultEnabled),
        config: "config" in entry ? entry.config : null,
        source: typeof entry.source === "string" ? entry.source : "support_connector",
        updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : null,
        lastChangedAt: typeof entry.lastChangedAt === "string" ? entry.lastChangedAt : null,
        lastChangedBy: typeof entry.lastChangedBy === "string" ? entry.lastChangedBy : null,
      };
    });
}

export async function listControlPlaneFeatureFlags(actor: AppActor, deploymentId: string) {
  const deployment = await getControlPlaneDeploymentWithWorkspace(actor, deploymentId);
  const adapter = createControlPlaneAdapter(deployment);

  if (deployment.managedWorkspaceId) {
    const [records, events] = await Promise.all([
      prisma.workspaceFeatureFlag.findMany({
        where: {
          workspaceId: deployment.managedWorkspaceId,
          flag: { in: CONTROL_PLANE_WORKSPACE_FEATURE_FLAGS.map((definition) => definition.flag) },
        },
        select: {
          flag: true,
          enabled: true,
          config: true,
          updatedAt: true,
        },
      }),
      prisma.customerDeploymentEvent.findMany({
        where: {
          deploymentId,
          action: "control_plane.feature_flag.updated",
        },
        orderBy: { createdAt: "desc" },
        take: 50,
        select: {
          actorUserId: true,
          meta: true,
          createdAt: true,
        },
      }),
    ]);
    const recordMap = new Map(records.map((record) => [record.flag, record]));
    const eventMap = new Map<string, typeof events[number]>();
    for (const event of events) {
      const flag = event.meta && typeof event.meta === "object" && "flag" in event.meta
        ? String((event.meta as JsonRecord).flag)
        : "";
      if (flag && !eventMap.has(flag)) {
        eventMap.set(flag, event);
      }
    }

    return {
      deploymentId,
      accessMode: adapter.kind,
      source: "managed_workspace" as const,
      flags: CONTROL_PLANE_WORKSPACE_FEATURE_FLAGS.map((definition) => {
        const record = recordMap.get(definition.flag);
        const event = eventMap.get(definition.flag);
        return {
          ...definition,
          enabled: record?.enabled ?? definition.defaultEnabled,
          source: record ? "workspace_override" : "default",
          config: record?.config ?? null,
          updatedAt: record?.updatedAt ?? null,
          lastChangedAt: event?.createdAt ?? null,
          lastChangedBy: event?.actorUserId ?? null,
        };
      }),
    };
  }

  invariant(adapter.canUseSupportConnector && deployment.hasSupportCredential, 400, "SUPPORT_CONNECTOR_REQUIRED", "Support connector is required to inspect remote feature flags.");
  const operation = await runCustomerSupportOperation(actor, {
    deploymentId,
    action: "feature_flags.list",
    reason: "Read customer feature flags from Ops Control Plane.",
    arguments: {},
    remoteWorkspaceId: deployment.remoteWorkspaceId,
  });
  return {
    deploymentId,
    accessMode: adapter.kind,
    source: "support_connector" as const,
    operationId: operation.id,
    flags: normalizeRemoteFeatureFlags(operation.resultSummary),
  };
}

export async function setControlPlaneFeatureFlag(actor: AppActor, params: {
  deploymentId: string;
  flag: string;
  enabled: boolean;
  config?: unknown;
  reason?: string | null;
}) {
  requireControlPlaneScope(actor, "control-plane:features:write");
  const reason = requireMutationReason(params.reason);
  const flag = requireKnownWorkspaceFeatureFlag(params.flag);
  await requireControlPlaneDeploymentWriteAccess(actor, params.deploymentId);
  const deployment = await getControlPlaneDeploymentWithWorkspace(actor, params.deploymentId);
  const adapter = createControlPlaneAdapter(deployment);
  const hasConfig = Object.prototype.hasOwnProperty.call(params, "config");
  const configData = hasConfig ? { config: params.config == null ? null : toInputJson(params.config) } : {};

  if (deployment.managedWorkspaceId) {
    const record = await prisma.workspaceFeatureFlag.upsert({
      where: {
        workspaceId_flag: {
          workspaceId: deployment.managedWorkspaceId,
          flag,
        },
      },
      update: {
        enabled: params.enabled,
        ...configData,
      },
      create: {
        workspaceId: deployment.managedWorkspaceId,
        flag,
        enabled: params.enabled,
        ...configData,
      },
    });
    await recordCustomerDeploymentEvent(actor, params.deploymentId, "control_plane.feature_flag.updated", {
      reason,
      source: "managed_workspace",
      flag,
      enabled: params.enabled,
      configProvided: hasConfig,
    });
    return {
      deploymentId: params.deploymentId,
      accessMode: adapter.kind,
      source: "managed_workspace" as const,
      flag: record.flag,
      enabled: record.enabled,
    };
  }

  invariant(adapter.canUseSupportConnector && deployment.hasSupportCredential, 400, "SUPPORT_CONNECTOR_REQUIRED", "Support connector is required to change remote feature flags.");
	  const operation = await runCustomerSupportOperation(actor, {
	    deploymentId: params.deploymentId,
	    action: "feature_flags.set",
	    scopeOverride: "control-plane:features:write",
	    reason,
    arguments: {
      flag,
      enabled: params.enabled,
      ...(hasConfig ? { config: params.config ?? null } : {}),
    },
    remoteWorkspaceId: deployment.remoteWorkspaceId,
  });
  await recordCustomerDeploymentEvent(actor, params.deploymentId, "control_plane.feature_flag.updated", {
    reason,
    source: "support_connector",
    flag,
    enabled: params.enabled,
    configProvided: hasConfig,
    operationId: operation.id,
  });
  return {
    deploymentId: params.deploymentId,
    accessMode: adapter.kind,
    source: "support_connector" as const,
    flag,
    enabled: params.enabled,
    operation,
  };
}

export async function getControlPlaneContextHealth(actor: AppActor, deploymentId: string) {
  const deployment = await getControlPlaneDeploymentWithWorkspace(actor, deploymentId);
  const adapter = createControlPlaneAdapter(deployment);
  if (!adapter.canReadCentralWorkspace || !deployment.managedWorkspaceId) {
    return {
      deploymentId,
      accessMode: adapter.kind,
      hasManagedWorkspace: false,
      supportConnectorStatus: deployment.supportConnectorStatus,
      supportLastSyncAt: deployment.supportLastSyncAt,
      supportLastSyncError: deployment.supportLastSyncError,
      requiresConnectorSetup: adapter.requiresConnectorSetup,
      summary: null,
      sources: [],
    };
  }

  const staleBefore = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const [
    brainSources,
    brainSourceCount,
    dataSources,
    dataSourceCount,
    chunkCount,
    failedSyncJobs,
    recentFailedSyncJobs,
    failedExternalSourceCount,
    staleExternalSourceCount,
  ] = await Promise.all([
    prisma.brainSource.findMany({
      where: { workspaceId: deployment.managedWorkspaceId, archivedAt: null },
      orderBy: { createdAt: "desc" },
      take: 8,
      select: {
        id: true,
        sourceType: true,
        title: true,
        absorbedAt: true,
        createdAt: true,
      },
    }),
    prisma.brainSource.count({ where: { workspaceId: deployment.managedWorkspaceId, archivedAt: null } }),
    prisma.externalDataSource.findMany({
      where: { workspaceId: deployment.managedWorkspaceId, archivedAt: null },
      orderBy: { updatedAt: "desc" },
      take: 8,
      select: {
        id: true,
        label: true,
        driverType: true,
        isActive: true,
        pullCadenceMinutes: true,
        lastSyncAt: true,
        lastSyncError: true,
        updatedAt: true,
        syncLogs: {
          orderBy: { startedAt: "desc" },
          take: 3,
          select: {
            id: true,
            rowsProcessed: true,
            chunksCreated: true,
            error: true,
            startedAt: true,
            completedAt: true,
          },
        },
      },
    }),
    prisma.externalDataSource.count({ where: { workspaceId: deployment.managedWorkspaceId, archivedAt: null } }),
    prisma.knowledgeChunk.count({ where: { workspaceId: deployment.managedWorkspaceId } }),
    prisma.workflowJob.count({
      where: {
        workspaceId: deployment.managedWorkspaceId,
        status: "FAILED",
        type: { contains: "sync" },
      },
    }),
    prisma.workflowJob.findMany({
      where: {
        workspaceId: deployment.managedWorkspaceId,
        status: "FAILED",
        type: { contains: "sync" },
      },
      orderBy: { updatedAt: "desc" },
      take: 5,
      select: {
        id: true,
        type: true,
        error: true,
        attempts: true,
        updatedAt: true,
      },
    }),
    prisma.externalDataSource.count({
      where: {
        workspaceId: deployment.managedWorkspaceId,
        archivedAt: null,
        lastSyncError: { not: null },
      },
    }),
    prisma.externalDataSource.count({
      where: {
        workspaceId: deployment.managedWorkspaceId,
        archivedAt: null,
        isActive: true,
        OR: [
          { lastSyncAt: null },
          { lastSyncAt: { lt: staleBefore } },
        ],
      },
    }),
  ]);

  return {
    deploymentId,
    accessMode: "managed_workspace" as const,
    hasManagedWorkspace: true,
    managedWorkspace: deployment.managedWorkspace,
    summary: {
      brainSources: brainSourceCount,
      externalSources: dataSourceCount,
      knowledgeChunks: chunkCount,
      failedSyncJobs,
      recentFailedSyncJobs,
      failedExternalSources: failedExternalSourceCount,
      staleExternalSources: staleExternalSourceCount,
    },
    sources: {
      brain: brainSources,
      external: dataSources,
    },
  };
}

async function enqueueContextSourceSync(tx: Prisma.TransactionClient, params: {
  workspaceId: string;
  sourceId: string;
  dedupeSuffix: string;
}) {
  return tx.workflowJob.upsert({
    where: { dedupeKey: `control-plane-sync-${params.sourceId}-${params.dedupeSuffix}` },
    update: {},
    create: {
      workspaceId: params.workspaceId,
      eventId: null,
      type: "data-source.sync",
      payload: {
        sourceId: params.sourceId,
        requestedBy: "control_plane",
      },
      dedupeKey: `control-plane-sync-${params.sourceId}-${params.dedupeSuffix}`,
    },
  });
}

export async function runControlPlaneContextOperation(actor: AppActor, params: {
  deploymentId: string;
  operation: string;
  sourceId?: string | null;
  reason?: string | null;
}) {
  requireControlPlaneScope(actor, "control-plane:context:write");
  const reason = requireMutationReason(params.reason);
  const operation = normalizeContextOperation(params.operation);
  const deployment = await getControlPlaneDeploymentWithWorkspace(actor, params.deploymentId);
  const managedWorkspaceId = deployment.managedWorkspaceId;
  invariant(managedWorkspaceId, 400, "MANAGED_WORKSPACE_REQUIRED", "Context operations require a managed workspace link.");

  return prisma.$transaction(async (tx) => {
    if (operation === "sync_all") {
      const sources = await tx.externalDataSource.findMany({
        where: {
          workspaceId: managedWorkspaceId,
          archivedAt: null,
          isActive: true,
        },
        orderBy: { updatedAt: "desc" },
        select: {
          id: true,
          label: true,
        },
      });
      const dedupeSuffix = String(Date.now());
      for (const source of sources) {
        await enqueueContextSourceSync(tx, {
          workspaceId: managedWorkspaceId,
          sourceId: source.id,
          dedupeSuffix,
        });
      }
      await tx.customerDeploymentEvent.create({
        data: {
          deploymentId: params.deploymentId,
          actorUserId: actorUserId(actor),
          action: "control_plane.context.sync_requested",
          meta: redactObject({
            reason,
            managedWorkspaceId,
            operation,
            queuedJobs: sources.length,
            sourceIds: sources.map((source) => source.id),
          }) as Prisma.InputJsonObject,
        },
      });
      return {
        deploymentId: params.deploymentId,
        managedWorkspaceId,
        operation,
        queuedJobs: sources.length,
        sourceIds: sources.map((source) => source.id),
      };
    }

    const sourceId = params.sourceId?.trim();
    invariant(sourceId, 400, "INVALID_INPUT", "A source ID is required for this context operation.");
    const source = await tx.externalDataSource.findFirst({
      where: {
        id: sourceId,
        workspaceId: managedWorkspaceId,
        archivedAt: null,
      },
      select: {
        id: true,
        label: true,
        isActive: true,
      },
    });
    invariant(source, 404, "NOT_FOUND", "Context source not found for this customer.");

    if (operation === "sync_source") {
      invariant(source.isActive, 400, "CONTEXT_SOURCE_DISABLED", "Disabled context sources cannot be synced.");
      const job = await enqueueContextSourceSync(tx, {
        workspaceId: managedWorkspaceId,
        sourceId: source.id,
        dedupeSuffix: String(Date.now()),
      });
      await tx.customerDeploymentEvent.create({
        data: {
          deploymentId: params.deploymentId,
          actorUserId: actorUserId(actor),
          action: "control_plane.context.sync_requested",
          meta: redactObject({
            reason,
            managedWorkspaceId,
            operation,
            sourceId: source.id,
            sourceLabel: source.label,
            queuedJobs: 1,
            workflowJobId: job.id,
          }) as Prisma.InputJsonObject,
        },
      });
      return {
        deploymentId: params.deploymentId,
        managedWorkspaceId,
        operation,
        queuedJobs: 1,
        sourceIds: [source.id],
      };
    }

    const updated = await tx.externalDataSource.update({
      where: { id: source.id },
      data: { isActive: false },
      select: {
        id: true,
        label: true,
        isActive: true,
      },
    });
    await tx.customerDeploymentEvent.create({
      data: {
        deploymentId: params.deploymentId,
        actorUserId: actorUserId(actor),
        action: "control_plane.context.source_disabled",
        meta: redactObject({
          reason,
          managedWorkspaceId,
          operation,
          sourceId: updated.id,
          sourceLabel: updated.label,
          isActive: updated.isActive,
        }) as Prisma.InputJsonObject,
      },
    });
    return {
      deploymentId: params.deploymentId,
      managedWorkspaceId,
      operation,
      sourceIds: [updated.id],
      disabled: true,
    };
  });
}

export async function getControlPlaneIntegrationStatus(actor: AppActor, deploymentId: string) {
  const deployment = await getControlPlaneDeploymentWithWorkspace(actor, deploymentId);
  const adapter = createControlPlaneAdapter(deployment);
  if (!adapter.canReadCentralWorkspace || !deployment.managedWorkspaceId) {
    return {
      deploymentId,
      accessMode: adapter.kind,
      hasManagedWorkspace: false,
      supportConnectorStatus: deployment.supportConnectorStatus,
      supportLastSyncAt: deployment.supportLastSyncAt,
      requiresConnectorSetup: adapter.requiresConnectorSetup,
      integrations: [],
    };
  }

  const [featureFlag, recorderConfig, recorderUsage, recorderFailures, recorderReadiness, communicationInstallations, dataSources, oauthConnections] = await Promise.all([
    prisma.workspaceFeatureFlag.findUnique({
      where: {
        workspaceId_flag: {
          workspaceId: deployment.managedWorkspaceId,
          flag: MEETING_RECORDERS_FEATURE_FLAG,
        },
      },
    }),
    prisma.workspaceMeetingRecorderConfig.findUnique({ where: { workspaceId: deployment.managedWorkspaceId } }),
    getMeetingRecorderMonthlyUsage(deployment.managedWorkspaceId),
    prisma.meetingRecording.count({
      where: {
        workspaceId: deployment.managedWorkspaceId,
        status: "FAILED",
      },
    }),
    getMeetingRecorderEnterpriseReadiness(deployment.managedWorkspaceId),
    prisma.communicationInstallation.findMany({
      where: { workspaceId: deployment.managedWorkspaceId },
      orderBy: { updatedAt: "desc" },
      select: {
        id: true,
        provider: true,
        status: true,
        externalTeamName: true,
        scopes: true,
        optionalScopes: true,
        lastEventAt: true,
        lastError: true,
        updatedAt: true,
      },
    }),
    prisma.externalDataSource.findMany({
      where: { workspaceId: deployment.managedWorkspaceId, archivedAt: null },
      orderBy: { updatedAt: "desc" },
      select: {
        id: true,
        label: true,
        driverType: true,
        isActive: true,
        lastSyncAt: true,
        lastSyncError: true,
      },
    }),
    prisma.oAuthConnection.findMany({
      where: { workspaceId: deployment.managedWorkspaceId },
      orderBy: { updatedAt: "desc" },
      select: {
        id: true,
        provider: true,
        providerAccountId: true,
        providerEmail: true,
        scopes: true,
        status: true,
        syncSettings: true,
        lastSyncAt: true,
        lastSyncError: true,
        updatedAt: true,
      },
    }),
  ]);

  return {
    deploymentId,
    accessMode: "managed_workspace" as const,
    hasManagedWorkspace: true,
    managedWorkspace: deployment.managedWorkspace,
    selfServe: deployment.managedWorkspace
      ? {
        plan: deployment.managedWorkspace.plan,
        trialEndsAt: deployment.managedWorkspace.trialEndsAt,
        billing: deployment.managedWorkspace.billingProfile,
        memberCount: deployment.managedWorkspace._count.members,
      }
      : null,
    integrations: [
      {
        key: "meeting_recorders",
        label: "Meeting recorders",
        entitlementEnabled: Boolean(featureFlag?.enabled),
        configured: Boolean(recorderConfig),
        status: recorderConfig?.enabled ? "enabled" : "disabled",
        provider: recorderConfig?.defaultProvider ?? null,
        fallbackProvider: recorderConfig?.fallbackProvider ?? null,
        autoRecordEnabled: recorderConfig?.autoRecordEnabled ?? null,
        botName: recorderConfig?.botName ?? null,
        entryMessage: recorderConfig?.entryMessage ?? null,
        monthlyMinuteCap: recorderConfig?.monthlyMinuteCap ?? null,
        usage: recorderUsage,
        failures: recorderFailures,
        vendorReadiness: recorderReadiness.ready,
        readiness: recorderReadiness,
        calendarSource: recorderReadiness.calendarSource,
        lastSmokeRun: recorderReadiness.lastSmokeRun,
      },
      ...communicationInstallations.map((installation) => ({
        key: `communication_${installation.id}`,
        label: installation.provider,
        entitlementEnabled: true,
        configured: true,
        status: installation.status,
        team: installation.externalTeamName,
        scopes: installation.scopes,
        optionalScopes: installation.optionalScopes,
        lastEventAt: installation.lastEventAt,
        lastError: installation.lastError,
      })),
      ...oauthConnections.map((connection) => ({
        key: `oauth_${connection.id}`,
        label: connection.provider,
        entitlementEnabled: true,
        configured: connection.status !== "DISCONNECTED",
        status: connection.status,
        account: connection.providerEmail ?? connection.providerAccountId,
        scopes: connection.scopes,
        syncSettings: connection.syncSettings,
        lastSyncAt: connection.lastSyncAt,
        lastError: connection.lastSyncError,
      })),
      ...dataSources.map((source) => ({
        key: `data_source_${source.id}`,
        label: source.label,
        entitlementEnabled: true,
        configured: source.isActive,
        status: source.lastSyncError ? "degraded" : source.isActive ? "active" : "disabled",
        driverType: source.driverType,
        lastSyncAt: source.lastSyncAt,
        lastError: source.lastSyncError,
      })),
    ],
  };
}

export async function configureControlPlaneMeetingRecorderIntegration(actor: AppActor, params: {
  deploymentId: string;
  entitlementEnabled: boolean;
  enabled: boolean;
  defaultProvider: string;
  fallbackProvider?: string | null;
  autoRecordEnabled: boolean;
  monthlyMinuteCap: number;
  botName?: string | null;
  entryMessage?: string | null;
  reason?: string | null;
}) {
  requireControlPlaneScope(actor, "control-plane:integrations:write");
  const reason = requireMutationReason(params.reason);
  const deployment = await getControlPlaneDeploymentWithWorkspace(actor, params.deploymentId);
  const managedWorkspaceId = deployment.managedWorkspaceId;
  invariant(managedWorkspaceId, 400, "MANAGED_WORKSPACE_REQUIRED", "Meeting recorder configuration requires a managed workspace link.");

  const defaultProvider = normalizeMeetingRecorderProvider(params.defaultProvider, "meeting recorder provider");
  const fallbackProvider = params.fallbackProvider?.trim()
    ? normalizeMeetingRecorderProvider(params.fallbackProvider, "fallback meeting recorder provider")
    : null;
  const monthlyMinuteCap = Math.max(0, Math.round(Number.isFinite(params.monthlyMinuteCap) ? params.monthlyMinuteCap : DEFAULT_RECORDER_MONTHLY_MINUTE_CAP));
  const enabled = params.entitlementEnabled ? params.enabled : false;
  const botName = params.botName?.trim() || DEFAULT_RECORDER_BOT_NAME;
  const entryMessage = params.entryMessage?.trim() || DEFAULT_RECORDER_ENTRY_MESSAGE;
  const latestCompletedSmoke = enabled && params.autoRecordEnabled
    ? await requireCompletedMeetingRecorderSmoke(managedWorkspaceId)
    : null;

  const { featureFlag, config, entitlement } = await prisma.$transaction(async (tx) => {
    const featureFlag = await tx.workspaceFeatureFlag.upsert({
      where: {
        workspaceId_flag: {
          workspaceId: managedWorkspaceId,
          flag: MEETING_RECORDERS_FEATURE_FLAG,
        },
      },
      update: { enabled: params.entitlementEnabled },
      create: {
        workspaceId: managedWorkspaceId,
        flag: MEETING_RECORDERS_FEATURE_FLAG,
        enabled: params.entitlementEnabled,
      },
    });
    const config = await tx.workspaceMeetingRecorderConfig.upsert({
      where: { workspaceId: managedWorkspaceId },
      update: {
        enabled,
        defaultProvider,
        fallbackProvider,
        autoRecordEnabled: params.autoRecordEnabled,
        monthlyMinuteCap,
        botName,
        entryMessage,
      },
      create: {
        workspaceId: managedWorkspaceId,
        enabled,
        defaultProvider,
        fallbackProvider,
        autoRecordEnabled: params.autoRecordEnabled,
        monthlyMinuteCap,
        botName,
        entryMessage,
      },
    });
    const entitlement = deployment.customerAccountId
      ? await tx.customerEntitlement.upsert({
        where: {
          customerAccountId_scopeKey_entitlementKey: {
            customerAccountId: deployment.customerAccountId,
            scopeKey: `deployment:${params.deploymentId}`,
            entitlementKey: MEETING_RECORDERS_FEATURE_FLAG,
          },
        },
        update: {
          deploymentId: params.deploymentId,
          enabled: params.entitlementEnabled,
          status: params.entitlementEnabled ? "ENABLED" : "DISABLED",
          intent: {
            enabled: params.entitlementEnabled,
            productEnforcement: "workspace_feature_flag",
          },
          evidence: {
            reason,
            managedWorkspaceId,
            configEnabled: config.enabled,
            defaultProvider: config.defaultProvider,
            monthlyMinuteCap: config.monthlyMinuteCap,
          },
          configuredByUserId: actorUserId(actor),
        },
        create: {
          customerAccountId: deployment.customerAccountId,
          deploymentId: params.deploymentId,
          scopeKey: `deployment:${params.deploymentId}`,
          entitlementKey: MEETING_RECORDERS_FEATURE_FLAG,
          enabled: params.entitlementEnabled,
          status: params.entitlementEnabled ? "ENABLED" : "DISABLED",
          intent: {
            enabled: params.entitlementEnabled,
            productEnforcement: "workspace_feature_flag",
          },
          evidence: {
            reason,
            managedWorkspaceId,
            configEnabled: config.enabled,
            defaultProvider: config.defaultProvider,
            monthlyMinuteCap: config.monthlyMinuteCap,
          },
          configuredByUserId: actorUserId(actor),
        },
      })
      : null;

    if (featureFlag.enabled && config.enabled) {
      await tx.workflowJob.upsert({
        where: { dedupeKey: `meeting-recorders:reconcile:${managedWorkspaceId}:control-plane` },
        update: {},
        create: {
          workspaceId: managedWorkspaceId,
          type: "meeting-recorders.reconcile",
          payload: {},
          dedupeKey: `meeting-recorders:reconcile:${managedWorkspaceId}:control-plane`,
        },
      });
    }

    await tx.customerDeploymentEvent.create({
      data: {
        deploymentId: params.deploymentId,
        actorUserId: actorUserId(actor),
        action: "control_plane.integration.meeting_recorders_configured",
        meta: redactObject({
          reason,
          managedWorkspaceId,
          entitlementEnabled: featureFlag.enabled,
          enabled: config.enabled,
          defaultProvider: config.defaultProvider,
          fallbackProvider: config.fallbackProvider,
          autoRecordEnabled: config.autoRecordEnabled,
          monthlyMinuteCap: config.monthlyMinuteCap,
          smokeRunId: latestCompletedSmoke?.id,
        }) as Prisma.InputJsonObject,
      },
    });

    return { featureFlag, config, entitlement };
  });

  return {
    deploymentId: params.deploymentId,
    managedWorkspaceId,
    entitlementEnabled: featureFlag.enabled,
    entitlement,
    config,
  };
}

async function requireCompletedMeetingRecorderSmoke(workspaceId: string) {
  const latestSmoke = await prisma.meetingRecorderSmokeRun.findFirst({
    where: {
      workspaceId,
      status: "COMPLETED",
    },
    orderBy: { createdAt: "desc" },
  });
  invariant(latestSmoke, 400, "RECORDER_SMOKE_REQUIRED", "A completed recorder smoke run is required before enabling auto-recording.");
  return latestSmoke;
}

export async function saveControlPlaneRecorderCalendarSource(actor: AppActor, params: {
  deploymentId: string;
  providerAccountId: string;
  providerAccountEmail?: string | null;
  displayName?: string | null;
  accessToken: string;
  refreshToken?: string | null;
  expiresIn?: number | null;
  scopes?: string[];
  reason?: string | null;
}) {
  requireControlPlaneScope(actor, "control-plane:integrations:write");
  const reason = requireMutationReason(params.reason);
  await requireControlPlaneDeploymentWriteAccess(actor, params.deploymentId);
  const deployment = await getControlPlaneDeploymentWithWorkspace(actor, params.deploymentId);
  const managedWorkspaceId = deployment.managedWorkspaceId;
  invariant(managedWorkspaceId, 400, "MANAGED_WORKSPACE_REQUIRED", "Recorder calendar setup requires a managed workspace link.");

  const source = await upsertRecorderCalendarSource({
    workspaceId: managedWorkspaceId,
    providerAccountId: params.providerAccountId,
    providerAccountEmail: params.providerAccountEmail ?? null,
    displayName: params.displayName ?? null,
    accessToken: params.accessToken,
    refreshToken: params.refreshToken ?? null,
    expiresIn: params.expiresIn ?? null,
    scopes: params.scopes ?? [],
  });
  const job = await enqueueRecorderCalendarSync({
    workspaceId: managedWorkspaceId,
    sourceId: source.id,
    reason: "oauth_connected",
  });
  await recordCustomerDeploymentEvent(actor, params.deploymentId, "control_plane.integration.meeting_recorder_calendar_connected", {
    reason,
    managedWorkspaceId,
    sourceId: source.id,
    provider: source.provider,
    providerAccountEmail: source.providerAccountEmail,
    workflowJobId: job.id,
  });
  return {
    deploymentId: params.deploymentId,
    managedWorkspaceId,
    source,
    workflowJobId: job.id,
  };
}

export async function runControlPlaneMeetingRecorderOperation(actor: AppActor, params: {
  deploymentId: string;
  operation: "enqueue_calendar_sync" | "dry_run_scan" | "live_smoke" | "enable_auto_recording_after_smoke";
  meetingUrl?: string | null;
  joinAt?: Date | null;
  provider?: string | null;
  reason?: string | null;
}) {
  requireControlPlaneScope(actor, "control-plane:integrations:write");
  const reason = requireMutationReason(params.reason);
  await requireControlPlaneDeploymentWriteAccess(actor, params.deploymentId);
  const deployment = await getControlPlaneDeploymentWithWorkspace(actor, params.deploymentId);
  const managedWorkspaceId = deployment.managedWorkspaceId;
  invariant(managedWorkspaceId, 400, "MANAGED_WORKSPACE_REQUIRED", "Meeting recorder operations require a managed workspace link.");

  const provider = params.provider?.trim()
    ? normalizeMeetingRecorderProvider(params.provider, "meeting recorder smoke provider")
    : "RECALL_AI";

  if (params.operation === "enqueue_calendar_sync") {
    const source = await getRecorderCalendarSource(managedWorkspaceId);
    invariant(source, 400, "RECORDER_CALENDAR_SOURCE_REQUIRED", "Connect a Microsoft recorder calendar before syncing.");
    const job = await enqueueRecorderCalendarSync({
      workspaceId: managedWorkspaceId,
      sourceId: source.id,
      reason: "control_plane",
    });
    await recordCustomerDeploymentEvent(actor, params.deploymentId, "control_plane.integration.meeting_recorder_calendar_sync_requested", {
      reason,
      managedWorkspaceId,
      sourceId: source.id,
      workflowJobId: job.id,
    });
    return {
      deploymentId: params.deploymentId,
      managedWorkspaceId,
      operation: params.operation,
      sourceId: source.id,
      workflowJobId: job.id,
    };
  }

  if (params.operation === "dry_run_scan") {
    const source = await getRecorderCalendarSource(managedWorkspaceId);
    invariant(source, 400, "RECORDER_CALENDAR_SOURCE_REQUIRED", "Connect a Microsoft recorder calendar before scanning.");
    const scan = await scanRecorderCalendarSource({
      workspaceId: managedWorkspaceId,
      sourceId: source.id,
    });
    await recordCustomerDeploymentEvent(actor, params.deploymentId, "control_plane.integration.meeting_recorder_calendar_dry_run", {
      reason,
      managedWorkspaceId,
      sourceId: source.id,
      upcomingEventCount: scan.upcomingEventCount,
      schedulableEventCount: scan.schedulableEventCount,
    });
    return {
      deploymentId: params.deploymentId,
      managedWorkspaceId,
      operation: params.operation,
      scan,
    };
  }

  if (params.operation === "live_smoke") {
    const meetingUrl = params.meetingUrl?.trim();
    invariant(meetingUrl, 400, "INVALID_INPUT", "A future meeting URL is required for live smoke.");
    invariant(params.joinAt && !Number.isNaN(params.joinAt.valueOf()), 400, "INVALID_INPUT", "A future join time is required for live smoke.");
    const smokeRun = await runMeetingRecorderSmoke({
      workspaceId: managedWorkspaceId,
      deploymentId: params.deploymentId,
      meetingUrl,
      joinAt: params.joinAt,
      provider,
      liveVendorCall: true,
    });
    await recordCustomerDeploymentEvent(actor, params.deploymentId, "control_plane.integration.meeting_recorder_live_smoke", {
      reason,
      managedWorkspaceId,
      smokeRunId: smokeRun.id,
      status: smokeRun.status,
      provider: smokeRun.provider,
      meetingId: smokeRun.meetingId,
      recordingId: smokeRun.recordingId,
    });
    return {
      deploymentId: params.deploymentId,
      managedWorkspaceId,
      operation: params.operation,
      smokeRun,
    };
  }

  if (params.operation !== "enable_auto_recording_after_smoke") {
    throw new AppError(400, "INVALID_INPUT", "Unsupported meeting recorder operation.");
  }

  const latestSmoke = await requireCompletedMeetingRecorderSmoke(managedWorkspaceId);
  const config = await prisma.workspaceMeetingRecorderConfig.upsert({
    where: { workspaceId: managedWorkspaceId },
    update: { enabled: true, autoRecordEnabled: true },
    create: {
      workspaceId: managedWorkspaceId,
      enabled: true,
      autoRecordEnabled: true,
    },
  });
  await recordCustomerDeploymentEvent(actor, params.deploymentId, "control_plane.integration.meeting_recorder_auto_recording_enabled", {
    reason,
    managedWorkspaceId,
    smokeRunId: latestSmoke.id,
  });
  return {
    deploymentId: params.deploymentId,
    managedWorkspaceId,
    operation: params.operation,
    config,
  };
}

const HIGH_RISK_AGENT_SCOPES = new Set([
  "archive:write",
  "finance:write",
  "members:write",
  "runtime:write",
  "support:write",
  "tools:credentials:read",
  "workspace:write",
]);

const RISKY_TOOL_NAME_PATTERN = /archive|create|delete|deactivate|deploy|discard|invite|purge|remove|retry|revoke|rollback|send|sync|update|upsert|write/i;

function daysSince(value: Date | string | null | undefined) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) return null;
  return Math.floor((Date.now() - date.getTime()) / 86_400_000);
}

function summarizeSupportOperationForGovernance(operation: {
  id: string;
  action: string;
  reason: string;
  status: string;
  error: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
}) {
  return {
    id: operation.id,
    action: operation.action,
    reason: operation.reason,
    status: operation.status,
    error: operation.error,
    startedAt: operation.startedAt,
    completedAt: operation.completedAt,
    createdAt: operation.createdAt,
  };
}

function jsonRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

function stringField(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function booleanField(value: unknown) {
  return typeof value === "boolean" ? value : null;
}

function arrayItems(value: unknown, nestedKeys: string[] = []) {
  if (Array.isArray(value)) {
    return value.map(jsonRecord).filter((item): item is JsonRecord => Boolean(item));
  }
  const record = jsonRecord(value);
  if (!record) return [];
  for (const key of nestedKeys) {
    const nested = record[key];
    if (Array.isArray(nested)) {
      return nested.map(jsonRecord).filter((item): item is JsonRecord => Boolean(item));
    }
  }
  return [];
}

function normalizeRemoteAgentRun(run: JsonRecord) {
  return {
    id: stringField(run.id),
    agentKey: stringField(run.agentKey) ?? stringField(run.key) ?? stringField(run.name) ?? "unknown",
    triggerType: stringField(run.triggerType),
    status: stringField(run.status) ?? "UNKNOWN",
    goal: stringField(run.goal),
    approvalRequired: booleanField(run.approvalRequired) ?? false,
    createdAt: stringField(run.createdAt),
    startedAt: stringField(run.startedAt),
    completedAt: stringField(run.completedAt),
    failedAt: stringField(run.failedAt),
  };
}

function normalizeRemoteFailedJob(job: JsonRecord) {
  return {
    id: stringField(job.id),
    type: stringField(job.type) ?? stringField(job.name) ?? "unknown",
    status: stringField(job.status) ?? "FAILED",
    attempts: typeof job.attempts === "number" ? job.attempts : null,
    error: stringField(job.error),
    createdAt: stringField(job.createdAt),
    updatedAt: stringField(job.updatedAt),
    completedAt: stringField(job.completedAt),
  };
}

function summarizeCachedSupportReadySnapshot(snapshot: {
  status: string;
  summary: unknown;
  error: string | null;
  observedAt: Date;
  createdAt: Date;
} | null) {
  const summary = jsonRecord(snapshot?.summary);
  const recentRuns = arrayItems(summary?.agentRuns, ["items", "runs"])
    .map(normalizeRemoteAgentRun)
    .slice(0, 8);
  const recentFailedJobs = arrayItems(summary?.failedJobs, ["items", "jobs"])
    .map(normalizeRemoteFailedJob)
    .slice(0, 8);
  const agentRuns = recentRuns.reduce<Record<string, number>>((counts, run) => {
    counts[run.status] = (counts[run.status] ?? 0) + 1;
    return counts;
  }, {});
  const pendingApprovals = recentRuns.filter((run) => run.approvalRequired || run.status === "WAITING_APPROVAL").length;
  const riskFindings = [
    snapshot?.error
      ? controlPlaneRiskFinding({
        key: "remote-support-snapshot-degraded",
        severity: "medium",
        title: "Cached support snapshot is degraded",
        detail: "The latest cached support-readiness snapshot reported an error.",
        evidence: snapshot.error,
      })
      : null,
    recentRuns.some((run) => run.status === "FAILED")
      ? controlPlaneRiskFinding({
        key: "remote-agent-run-failures",
        severity: "medium",
        title: "Remote agent runs are failing",
        detail: `${recentRuns.filter((run) => run.status === "FAILED").length} failed run(s) appear in the latest cached support snapshot.`,
        evidence: snapshot?.observedAt.toISOString() ?? null,
      })
      : null,
    recentFailedJobs.length > 0
      ? controlPlaneRiskFinding({
        key: "remote-failed-workflow-jobs",
        severity: "medium",
        title: "Remote failed workflow jobs are cached",
        detail: `${recentFailedJobs.length} failed job(s) appear in the latest cached support snapshot.`,
        evidence: snapshot?.observedAt.toISOString() ?? null,
      })
      : null,
  ].filter((finding): finding is NonNullable<typeof finding> => Boolean(finding));

  return {
    hasSnapshot: Boolean(snapshot),
    snapshotStatus: snapshot?.status ?? null,
    snapshotObservedAt: snapshot?.observedAt ?? null,
    summary: snapshot
      ? {
        source: "cached_support_snapshot" as const,
        agentRuns,
        pendingApprovals,
        failedJobs: recentFailedJobs.length,
        modelUsage: {
          inputTokens: 0,
          outputTokens: 0,
          estimatedCostUsd: null,
        },
        recentRuns,
        recentFailedJobs,
        riskyToolCalls: [],
      }
      : null,
    recentRuns,
    recentFailedJobs,
    riskFindings,
  };
}

function normalizeAgentScopes(scopes: string[] | undefined) {
  const normalized = [...new Set((scopes ?? []).map((scope) => scope.trim()).filter(Boolean))];
  const unknown = normalized.filter((scope) => !isKnownScope(scope));
  invariant(unknown.length === 0, 400, "INVALID_INPUT", `Unknown scope(s): ${unknown.join(", ")}.`);
  return normalized;
}

function normalizeBudgetNumber(value: number, label: string) {
  invariant(Number.isFinite(value), 400, "INVALID_INPUT", `${label} must be a finite number.`);
  return value;
}

function normalizeBudgetInteger(value: number | null | undefined, label: string, fallback: number, min: number, max: number) {
  if (value == null) return fallback;
  invariant(Number.isInteger(value) && value >= min && value <= max, 400, "INVALID_INPUT", `${label} must be between ${min} and ${max}.`);
  return value;
}

function controlPlaneRiskFinding(params: {
  key: string;
  severity: "high" | "medium" | "low";
  title: string;
  detail: string;
  evidence?: string | null;
}) {
  return params;
}

function summarizeAgentScopeRisk(scopes: string[]) {
  const highRisk = scopes.filter((scope) => HIGH_RISK_AGENT_SCOPES.has(scope));
  const writeScopes = scopes.filter((scope) => scope.endsWith(":write"));
  return {
    highRisk,
    writeScopes,
    isOverbroad: highRisk.length > 0 || writeScopes.length >= 6,
  };
}

export async function getControlPlaneAiGovernanceStatus(actor: AppActor, deploymentId: string) {
  const deployment = await getControlPlaneDeploymentWithWorkspace(actor, deploymentId);
  const adapter = createControlPlaneAdapter(deployment);
  const recentGovernanceSupportOperations = await prisma.supportOperation.findMany({
    where: {
      deploymentId,
      action: {
        in: [
          "agents.list_runs",
          "runtime.list_failed_jobs",
          "agent_credentials.list",
          "agent_credentials.update_scopes",
          "agent_credentials.revoke",
          "model_budget.get",
          "model_budget.update",
          "agent_config.list",
          "agent_config.update_policy",
        ],
      },
    },
    orderBy: { createdAt: "desc" },
    take: 12,
    select: {
      id: true,
      action: true,
      reason: true,
      status: true,
      error: true,
      startedAt: true,
      completedAt: true,
      createdAt: true,
    },
  });

  if (!adapter.canReadCentralWorkspace || !deployment.managedWorkspaceId) {
    const latestSupportReadySnapshot = await prisma.fleetHealthSnapshot.findFirst({
      where: {
        deploymentId,
        snapshotKind: "SUPPORT_READY",
      },
      orderBy: [
        { observedAt: "desc" },
        { createdAt: "desc" },
      ],
      select: {
        status: true,
        summary: true,
        error: true,
        observedAt: true,
        createdAt: true,
      },
    });
    const cachedSupport = summarizeCachedSupportReadySnapshot(latestSupportReadySnapshot);
    const riskFindings = [
      !deployment.hasSupportCredential
        ? controlPlaneRiskFinding({
          key: "support-connector-missing",
          severity: "high",
          title: "Support connector is not configured",
          detail: "Remote agent governance reads and repairs require an encrypted customer support connector.",
          evidence: deployment.supportConnectorStatus,
        })
        : null,
      ...cachedSupport.riskFindings,
    ].filter((finding): finding is NonNullable<typeof finding> => Boolean(finding));

    return {
      deploymentId,
      accessMode: adapter.kind,
      hasManagedWorkspace: false,
      supportConnectorStatus: deployment.supportConnectorStatus,
      supportLastSyncAt: deployment.supportLastSyncAt,
      requiresConnectorSetup: adapter.requiresConnectorSetup,
      managedWorkspace: null,
      featureFlag: {
        flag: AGENT_GOVERNANCE_FEATURE_FLAG,
        enabled: null,
        source: "remote_unavailable" as const,
      },
      summary: cachedSupport.summary,
      agents: {
        identities: [],
        configs: [],
      },
      access: {
        credentials: [],
      },
      spend: {
        budget: null,
        recentModelUsage: [],
      },
      activity: {
        recentRuns: cachedSupport.recentRuns,
        pendingApprovalRuns: [],
        recentFailedJobs: cachedSupport.recentFailedJobs,
        riskyToolCalls: [],
      },
      audit: {
        recentSupportOperations: recentGovernanceSupportOperations.map(summarizeSupportOperationForGovernance),
      },
      riskFindings,
      cachedSupportSnapshot: {
        available: cachedSupport.hasSnapshot,
        status: cachedSupport.snapshotStatus,
        observedAt: cachedSupport.snapshotObservedAt,
      },
      remoteSupport: {
        available: Boolean(adapter.canUseSupportConnector && deployment.hasSupportCredential),
        message: deployment.hasSupportCredential
          ? "Use audited support operations for remote agent-governance inspection and repair."
          : "Configure the support connector before remote agent-governance inspection.",
        supportedActions: [
          "agent_credentials.list",
          "agent_credentials.update_scopes",
          "agent_credentials.revoke",
          "model_budget.get",
          "model_budget.update",
          "agent_config.list",
          "agent_config.update_policy",
        ],
      },
    };
  }

  const managedWorkspaceId = deployment.managedWorkspaceId;
  const [featureFlag, agentRuns, pendingApprovals, failedJobs, modelUsage, recentRuns, pendingApprovalRuns, recentFailedJobs, recentToolCalls, agentIdentities, agentConfigOverrides, credentials, budget, recentModelUsage] = await Promise.all([
    prisma.workspaceFeatureFlag.findUnique({
      where: {
        workspaceId_flag: {
          workspaceId: managedWorkspaceId,
          flag: AGENT_GOVERNANCE_FEATURE_FLAG,
        },
      },
      select: {
        flag: true,
        enabled: true,
        updatedAt: true,
      },
    }),
    prisma.agentRun.groupBy({
      by: ["status"],
      where: { workspaceId: managedWorkspaceId },
      _count: { _all: true },
    }),
    prisma.agentRun.count({
      where: { workspaceId: managedWorkspaceId, approvalRequired: true, status: "WAITING_APPROVAL" },
    }),
    prisma.workflowJob.count({
      where: { workspaceId: managedWorkspaceId, status: "FAILED" },
    }),
    prisma.modelUsage.aggregate({
      where: { workspaceId: managedWorkspaceId },
      _sum: {
        inputTokens: true,
        outputTokens: true,
        estimatedCostUsd: true,
        billableCostUsd: true,
      },
    }),
    prisma.agentRun.findMany({
      where: { workspaceId: managedWorkspaceId },
      orderBy: { createdAt: "desc" },
      take: 8,
      select: {
        id: true,
        agentKey: true,
        triggerType: true,
        status: true,
        goal: true,
        approvalRequired: true,
        createdAt: true,
        startedAt: true,
        completedAt: true,
        failedAt: true,
      },
    }),
    prisma.agentRun.findMany({
      where: { workspaceId: managedWorkspaceId, status: "WAITING_APPROVAL" },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        agentKey: true,
        triggerType: true,
        status: true,
        goal: true,
        approvalRequired: true,
        createdAt: true,
        startedAt: true,
        completedAt: true,
        failedAt: true,
      },
    }),
    prisma.workflowJob.findMany({
      where: { workspaceId: managedWorkspaceId, status: "FAILED" },
      orderBy: { updatedAt: "desc" },
      take: 8,
      select: {
        id: true,
        type: true,
        attempts: true,
        error: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
    prisma.agentToolCall.findMany({
      where: { agentRun: { workspaceId: managedWorkspaceId } },
      orderBy: { createdAt: "desc" },
      take: 25,
      select: {
        id: true,
        name: true,
        status: true,
        error: true,
        createdAt: true,
        agentRun: {
          select: {
            id: true,
            agentKey: true,
            status: true,
          },
        },
      },
    }),
    prisma.agentIdentity.findMany({
      where: { workspaceId: managedWorkspaceId },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        agentKey: true,
        memberType: true,
        displayName: true,
        isActive: true,
        linkedCredentialId: true,
        maxSpendPerRunCents: true,
        maxRunsPerDay: true,
        maxRunsPerHour: true,
        archivedAt: true,
        createdAt: true,
        updatedAt: true,
        linkedCredential: {
          select: {
            id: true,
            label: true,
            scopes: true,
            isActive: true,
            lastUsedAt: true,
          },
        },
        circleAssignments: {
          select: {
            circle: { select: { id: true, name: true } },
            role: { select: { id: true, name: true } },
          },
        },
      },
    }),
    prisma.workspaceAgentConfig.findMany({
      where: { workspaceId: managedWorkspaceId, archivedAt: null },
      orderBy: { agentKey: "asc" },
      select: {
        id: true,
        agentKey: true,
        enabled: true,
        modelOverride: true,
        governancePolicy: true,
        updatedAt: true,
      },
    }),
    prisma.agentCredential.findMany({
      where: { workspaceId: managedWorkspaceId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        label: true,
        scopes: true,
        catalogItemId: true,
        monthlyBudgetCents: true,
        dailyCallLimit: true,
        isActive: true,
        lastUsedAt: true,
        createdAt: true,
        updatedAt: true,
        catalogItem: {
          select: {
            id: true,
            title: true,
            slug: true,
            type: true,
            status: true,
          },
        },
      },
    }),
    prisma.modelUsageBudget.findUnique({
      where: { workspaceId: managedWorkspaceId },
      select: {
        id: true,
        monthlyCostCapUsd: true,
        alertThresholdPct: true,
        periodStartDay: true,
        alertSentAt: true,
        updatedAt: true,
      },
    }),
    prisma.modelUsage.findMany({
      where: { workspaceId: managedWorkspaceId },
      orderBy: { createdAt: "desc" },
      take: 25,
      select: {
        id: true,
        provider: true,
        model: true,
        taskType: true,
        inputTokens: true,
        outputTokens: true,
        latencyMs: true,
        estimatedCostUsd: true,
        rawProviderCostUsd: true,
        billableCostUsd: true,
        createdAt: true,
        agentRun: { select: { id: true, agentKey: true, status: true } },
        agentCredential: { select: { id: true, label: true, isActive: true } },
        catalogItem: { select: { id: true, title: true } },
      },
    }),
  ]);
  const riskyToolCalls = recentToolCalls
    .filter((call) => call.status === "FAILED" || RISKY_TOOL_NAME_PATTERN.test(call.name))
    .slice(0, 8);
  const configByAgentKey = new Map(agentConfigOverrides.map((config) => [config.agentKey, config]));
  const agentConfigs = Object.entries(AGENT_REGISTRY).map(([agentKey, meta]) => {
    const override = configByAgentKey.get(agentKey);
    return {
      agentKey,
      label: meta.label,
      category: meta.category,
      canDisable: meta.canDisable,
      costTier: meta.costTier,
      defaultModelTier: meta.defaultModelTier,
      enabled: override?.enabled ?? true,
      modelOverride: override?.modelOverride ?? null,
      hasGovernancePolicy: Boolean(override?.governancePolicy?.trim()),
      updatedAt: override?.updatedAt ?? null,
    };
  });
  const credentialRows = credentials.map((credential) => {
    const scopeRisk = summarizeAgentScopeRisk(credential.scopes);
    return {
      id: credential.id,
      label: credential.label,
      scopes: credential.scopes,
      catalogItemId: credential.catalogItemId,
      catalogItem: credential.catalogItem,
      monthlyBudgetCents: credential.monthlyBudgetCents,
      dailyCallLimit: credential.dailyCallLimit,
      isActive: credential.isActive,
      lastUsedAt: credential.lastUsedAt,
      createdAt: credential.createdAt,
      updatedAt: credential.updatedAt,
      risk: {
        ...scopeRisk,
        staleDays: daysSince(credential.lastUsedAt ?? credential.createdAt),
      },
    };
  });
  const activeCredentialRows = credentialRows.filter((credential) => credential.isActive);
  const riskFindings = [
    featureFlag?.enabled === false
      ? controlPlaneRiskFinding({
        key: "agent-governance-disabled",
        severity: "high",
        title: "Agent governance feature is disabled",
        detail: "The workspace feature flag is explicitly off for this customer.",
        evidence: AGENT_GOVERNANCE_FEATURE_FLAG,
      })
      : null,
    !budget
      ? controlPlaneRiskFinding({
        key: "model-budget-missing",
        severity: "medium",
        title: "No workspace model budget is set",
        detail: "Agent model usage is currently not capped at the workspace level.",
      })
      : null,
    pendingApprovals > 0
      ? controlPlaneRiskFinding({
        key: "pending-agent-approvals",
        severity: "low",
        title: "Agent approvals are waiting",
        detail: `${pendingApprovals} agent run(s) are waiting for human approval.`,
      })
      : null,
    failedJobs > 0
      ? controlPlaneRiskFinding({
        key: "failed-agent-jobs",
        severity: "medium",
        title: "Failed workflow jobs need review",
        detail: `${failedJobs} failed workflow job(s) were found in this workspace.`,
      })
      : null,
    riskyToolCalls.length > 0
      ? controlPlaneRiskFinding({
        key: "risky-tool-calls",
        severity: "medium",
        title: "Risky or failed tool calls were detected",
        detail: `${riskyToolCalls.length} recent tool call(s) matched write/destructive/failure patterns.`,
      })
      : null,
    ...activeCredentialRows
      .filter((credential) => credential.risk.staleDays !== null && credential.risk.staleDays >= STALE_CREDENTIAL_DAYS)
      .slice(0, 4)
      .map((credential) => controlPlaneRiskFinding({
        key: `stale-credential-${credential.id}`,
        severity: "medium" as const,
        title: "Stale active credential",
        detail: `${credential.label} has not been used recently but remains active.`,
        evidence: `${credential.risk.staleDays} days`,
      })),
    ...activeCredentialRows
      .filter((credential) => credential.risk.isOverbroad)
      .slice(0, 4)
      .map((credential) => controlPlaneRiskFinding({
        key: `overbroad-credential-${credential.id}`,
        severity: credential.risk.highRisk.length > 0 ? "high" as const : "medium" as const,
        title: "Credential has broad or sensitive scopes",
        detail: `${credential.label} can access ${credential.risk.writeScopes.length} write scope(s).`,
        evidence: credential.risk.highRisk.join(", ") || credential.risk.writeScopes.join(", "),
      })),
  ].filter((finding): finding is NonNullable<typeof finding> => Boolean(finding));

  return {
    deploymentId,
    accessMode: "managed_workspace" as const,
    hasManagedWorkspace: true,
    managedWorkspace: deployment.managedWorkspace,
    supportConnectorStatus: deployment.supportConnectorStatus,
    supportLastSyncAt: deployment.supportLastSyncAt,
    requiresConnectorSetup: adapter.requiresConnectorSetup,
    featureFlag: {
      flag: AGENT_GOVERNANCE_FEATURE_FLAG,
      enabled: featureFlag?.enabled ?? true,
      source: featureFlag ? "workspace_override" as const : "default" as const,
      updatedAt: featureFlag?.updatedAt ?? null,
    },
    summary: {
      agentRuns: Object.fromEntries(agentRuns.map((run) => [run.status, run._count._all])),
      pendingApprovals,
      failedJobs,
      modelUsage: {
        inputTokens: modelUsage._sum.inputTokens ?? 0,
        outputTokens: modelUsage._sum.outputTokens ?? 0,
        estimatedCostUsd: decimalToString(modelUsage._sum.billableCostUsd ?? modelUsage._sum.estimatedCostUsd),
        billableCostUsd: decimalToString(modelUsage._sum.billableCostUsd),
      },
      recentRuns,
      pendingApprovalRuns,
      recentFailedJobs,
      riskyToolCalls,
    },
    agents: {
      identities: agentIdentities,
      configs: agentConfigs,
    },
    access: {
      credentials: credentialRows,
    },
    spend: {
      budget: budget
        ? {
          id: budget.id,
          monthlyCostCapUsd: decimalToString(budget.monthlyCostCapUsd),
          alertThresholdPct: budget.alertThresholdPct,
          periodStartDay: budget.periodStartDay,
          alertSentAt: budget.alertSentAt,
          updatedAt: budget.updatedAt,
        }
        : null,
      recentModelUsage: recentModelUsage.map((usage) => ({
        ...usage,
        estimatedCostUsd: decimalToString(usage.billableCostUsd ?? usage.estimatedCostUsd),
        rawProviderCostUsd: decimalToString(usage.rawProviderCostUsd),
        billableCostUsd: decimalToString(usage.billableCostUsd),
      })),
    },
    activity: {
      recentRuns,
      recentFailedJobs,
      riskyToolCalls,
    },
    audit: {
      recentSupportOperations: recentGovernanceSupportOperations.map(summarizeSupportOperationForGovernance),
    },
    riskFindings,
    remoteSupport: {
      available: Boolean(deployment.hasSupportCredential),
      message: deployment.hasSupportCredential
        ? "Support connector is available for remote fallback operations."
        : "Support connector is not configured for remote fallback operations.",
      supportedActions: [
        "agent_credentials.list",
        "agent_credentials.update_scopes",
        "agent_credentials.revoke",
        "model_budget.get",
        "model_budget.update",
        "agent_config.list",
        "agent_config.update_policy",
      ],
    },
  };
}

async function resolveControlPlaneAgentGovernanceWorkspace(actor: AppActor, deploymentId: string) {
  requireControlPlaneScope(actor, CONTROL_PLANE_AI_GOVERNANCE_WRITE_SCOPE);
  await requireControlPlaneDeploymentWriteAccess(actor, deploymentId);
  const deployment = await getControlPlaneDeploymentWithWorkspace(actor, deploymentId);
  const adapter = createControlPlaneAdapter(deployment);
  return { deployment, adapter };
}

export async function updateControlPlaneAgentCredentialScopes(actor: AppActor, params: {
  deploymentId: string;
  credentialId: string;
  scopes: string[];
  reason?: string | null;
}) {
  const reason = requireMutationReason(params.reason);
  const scopes = normalizeAgentScopes(params.scopes);
  const { deployment, adapter } = await resolveControlPlaneAgentGovernanceWorkspace(actor, params.deploymentId);

  if (!deployment.managedWorkspaceId) {
    invariant(adapter.canUseSupportConnector && deployment.hasSupportCredential, 400, "SUPPORT_CONNECTOR_REQUIRED", "Support connector is required to update remote agent credentials.");
    const operation = await runCustomerSupportOperation(actor, {
      deploymentId: params.deploymentId,
      action: "agent_credentials.update_scopes",
      scopeOverride: CONTROL_PLANE_AI_GOVERNANCE_WRITE_SCOPE,
      reason,
      arguments: { credentialId: params.credentialId, scopes },
      remoteWorkspaceId: deployment.remoteWorkspaceId,
    });
    await recordCustomerDeploymentEvent(actor, params.deploymentId, "control_plane.ai_governance.credential_scopes_updated", {
      reason,
      source: "support_connector",
      credentialId: params.credentialId,
      scopes,
      operationId: operation.id,
    });
    return { deploymentId: params.deploymentId, source: "support_connector" as const, operation };
  }

  const credential = await prisma.agentCredential.findUnique({
    where: { id: params.credentialId },
    select: { id: true, workspaceId: true, isActive: true },
  });
  invariant(credential && credential.workspaceId === deployment.managedWorkspaceId, 404, "NOT_FOUND", "Agent credential not found.");
  invariant(credential.isActive, 400, "INVALID_STATE", "Cannot update scopes on a revoked credential.");
  const updated = await prisma.agentCredential.update({
    where: { id: credential.id },
    data: { scopes },
    select: {
      id: true,
      label: true,
      scopes: true,
      isActive: true,
      lastUsedAt: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  await recordCustomerDeploymentEvent(actor, params.deploymentId, "control_plane.ai_governance.credential_scopes_updated", {
    reason,
    source: "managed_workspace",
    managedWorkspaceId: deployment.managedWorkspaceId,
    credentialId: updated.id,
    scopes: updated.scopes,
  });
  return { deploymentId: params.deploymentId, source: "managed_workspace" as const, credential: updated };
}

export async function revokeControlPlaneAgentCredential(actor: AppActor, params: {
  deploymentId: string;
  credentialId: string;
  reason?: string | null;
}) {
  const reason = requireMutationReason(params.reason);
  const { deployment, adapter } = await resolveControlPlaneAgentGovernanceWorkspace(actor, params.deploymentId);

  if (!deployment.managedWorkspaceId) {
    invariant(adapter.canUseSupportConnector && deployment.hasSupportCredential, 400, "SUPPORT_CONNECTOR_REQUIRED", "Support connector is required to revoke remote agent credentials.");
    const operation = await runCustomerSupportOperation(actor, {
      deploymentId: params.deploymentId,
      action: "agent_credentials.revoke",
      scopeOverride: CONTROL_PLANE_AI_GOVERNANCE_WRITE_SCOPE,
      reason,
      arguments: { credentialId: params.credentialId },
      remoteWorkspaceId: deployment.remoteWorkspaceId,
    });
    await recordCustomerDeploymentEvent(actor, params.deploymentId, "control_plane.ai_governance.credential_revoked", {
      reason,
      source: "support_connector",
      credentialId: params.credentialId,
      operationId: operation.id,
    });
    return { deploymentId: params.deploymentId, source: "support_connector" as const, operation };
  }

  const credential = await prisma.agentCredential.findUnique({
    where: { id: params.credentialId },
    select: { id: true, workspaceId: true, isActive: true },
  });
  invariant(credential && credential.workspaceId === deployment.managedWorkspaceId, 404, "NOT_FOUND", "Agent credential not found.");
  invariant(credential.isActive, 400, "INVALID_STATE", "Agent credential is already revoked.");
  const updated = await prisma.agentCredential.update({
    where: { id: credential.id },
    data: { isActive: false },
    select: {
      id: true,
      label: true,
      scopes: true,
      isActive: true,
      lastUsedAt: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  await recordCustomerDeploymentEvent(actor, params.deploymentId, "control_plane.ai_governance.credential_revoked", {
    reason,
    source: "managed_workspace",
    managedWorkspaceId: deployment.managedWorkspaceId,
    credentialId: updated.id,
  });
  return { deploymentId: params.deploymentId, source: "managed_workspace" as const, credential: updated };
}

export async function updateControlPlaneModelBudget(actor: AppActor, params: {
  deploymentId: string;
  monthlyCostCapUsd: number;
  alertThresholdPct?: number | null;
  periodStartDay?: number | null;
  reason?: string | null;
}) {
  const reason = requireMutationReason(params.reason);
  const monthlyCostCapUsd = normalizeBudgetNumber(params.monthlyCostCapUsd, "monthlyCostCapUsd");
  const alertThresholdPct = normalizeBudgetInteger(params.alertThresholdPct, "alertThresholdPct", 80, 1, 100);
  const periodStartDay = normalizeBudgetInteger(params.periodStartDay, "periodStartDay", 1, 1, 31);
  const { deployment, adapter } = await resolveControlPlaneAgentGovernanceWorkspace(actor, params.deploymentId);

  if (!deployment.managedWorkspaceId) {
    invariant(adapter.canUseSupportConnector && deployment.hasSupportCredential, 400, "SUPPORT_CONNECTOR_REQUIRED", "Support connector is required to update remote model budgets.");
    const operation = await runCustomerSupportOperation(actor, {
      deploymentId: params.deploymentId,
      action: "model_budget.update",
      scopeOverride: CONTROL_PLANE_AI_GOVERNANCE_WRITE_SCOPE,
      reason,
      arguments: { monthlyCostCapUsd, alertThresholdPct, periodStartDay },
      remoteWorkspaceId: deployment.remoteWorkspaceId,
    });
    await recordCustomerDeploymentEvent(actor, params.deploymentId, "control_plane.ai_governance.model_budget_updated", {
      reason,
      source: "support_connector",
      monthlyCostCapUsd,
      alertThresholdPct,
      periodStartDay,
      operationId: operation.id,
    });
    return { deploymentId: params.deploymentId, source: "support_connector" as const, operation };
  }

  const budget = await prisma.modelUsageBudget.upsert({
    where: { workspaceId: deployment.managedWorkspaceId },
    create: {
      workspaceId: deployment.managedWorkspaceId,
      monthlyCostCapUsd,
      alertThresholdPct,
      periodStartDay,
    },
    update: {
      monthlyCostCapUsd,
      alertThresholdPct,
      periodStartDay,
    },
    select: {
      id: true,
      monthlyCostCapUsd: true,
      alertThresholdPct: true,
      periodStartDay: true,
      updatedAt: true,
    },
  });
  await recordCustomerDeploymentEvent(actor, params.deploymentId, "control_plane.ai_governance.model_budget_updated", {
    reason,
    source: "managed_workspace",
    managedWorkspaceId: deployment.managedWorkspaceId,
    monthlyCostCapUsd: decimalToString(budget.monthlyCostCapUsd),
    alertThresholdPct: budget.alertThresholdPct,
    periodStartDay: budget.periodStartDay,
  });
  return {
    deploymentId: params.deploymentId,
    source: "managed_workspace" as const,
    budget: {
      ...budget,
      monthlyCostCapUsd: decimalToString(budget.monthlyCostCapUsd),
    },
  };
}

export async function updateControlPlaneAgentPolicy(actor: AppActor, params: {
  deploymentId: string;
  agentKey: string;
  governancePolicy?: string | null;
  modelOverride?: string | null;
  reason?: string | null;
}) {
  const reason = requireMutationReason(params.reason);
  const agentKey = params.agentKey.trim();
  invariant(Boolean(AGENT_REGISTRY[agentKey as keyof typeof AGENT_REGISTRY]), 400, "INVALID_INPUT", "Unknown agent.");
  invariant(params.governancePolicy !== undefined || params.modelOverride !== undefined, 400, "INVALID_INPUT", "No agent policy changes were provided.");
  const governancePolicy = params.governancePolicy === undefined ? undefined : params.governancePolicy?.trim() || null;
  const modelOverride = params.modelOverride === undefined ? undefined : params.modelOverride?.trim() || null;
  const { deployment, adapter } = await resolveControlPlaneAgentGovernanceWorkspace(actor, params.deploymentId);

  if (!deployment.managedWorkspaceId) {
    invariant(adapter.canUseSupportConnector && deployment.hasSupportCredential, 400, "SUPPORT_CONNECTOR_REQUIRED", "Support connector is required to update remote agent policies.");
    const operation = await runCustomerSupportOperation(actor, {
      deploymentId: params.deploymentId,
      action: "agent_config.update_policy",
      scopeOverride: CONTROL_PLANE_AI_GOVERNANCE_WRITE_SCOPE,
      reason,
      arguments: { agentKey, governancePolicy, modelOverride },
      remoteWorkspaceId: deployment.remoteWorkspaceId,
    });
    await recordCustomerDeploymentEvent(actor, params.deploymentId, "control_plane.ai_governance.agent_policy_updated", {
      reason,
      source: "support_connector",
      agentKey,
      hasGovernancePolicy: Boolean(governancePolicy),
      modelOverride,
      operationId: operation.id,
    });
    return { deploymentId: params.deploymentId, source: "support_connector" as const, operation };
  }

  const config = await prisma.workspaceAgentConfig.upsert({
    where: {
      workspaceId_agentKey: {
        workspaceId: deployment.managedWorkspaceId,
        agentKey,
      },
    },
    create: {
      workspaceId: deployment.managedWorkspaceId,
      agentKey,
      enabled: true,
      modelOverride: modelOverride ?? null,
      governancePolicy: governancePolicy ?? null,
      configJson: {},
    },
    update: {
      ...(governancePolicy !== undefined && { governancePolicy }),
      ...(modelOverride !== undefined && { modelOverride }),
    },
    select: {
      id: true,
      agentKey: true,
      enabled: true,
      modelOverride: true,
      governancePolicy: true,
      updatedAt: true,
    },
  });
  await recordCustomerDeploymentEvent(actor, params.deploymentId, "control_plane.ai_governance.agent_policy_updated", {
    reason,
    source: "managed_workspace",
    managedWorkspaceId: deployment.managedWorkspaceId,
    agentKey,
    hasGovernancePolicy: Boolean(config.governancePolicy?.trim()),
    modelOverride: config.modelOverride,
  });
  return {
    deploymentId: params.deploymentId,
    source: "managed_workspace" as const,
    config: {
      id: config.id,
      agentKey: config.agentKey,
      enabled: config.enabled,
      modelOverride: config.modelOverride,
      hasGovernancePolicy: Boolean(config.governancePolicy?.trim()),
      updatedAt: config.updatedAt,
    },
  };
}

export async function getControlPlaneReleaseStatus(actor: AppActor, deploymentId: string) {
  const deployment = await getControlPlaneDeploymentWithWorkspace(actor, deploymentId);
  const adapter = createControlPlaneAdapter(deployment);
  const releaseDrift = deployment.lastHealthError?.includes("Release drift:") ? deployment.lastHealthError : null;
  const recentPreparations = await prisma.customerDeploymentEvent.findMany({
    where: {
      deploymentId,
      action: "control_plane.release.upgrade_prepared",
    },
    orderBy: { createdAt: "desc" },
    take: 5,
    select: {
      id: true,
      actorUserId: true,
      action: true,
      meta: true,
      createdAt: true,
    },
  });
  return {
    deploymentId,
    accessMode: adapter.kind,
    requiresConnectorSetup: adapter.requiresConnectorSetup,
    managedWorkspace: deployment.managedWorkspace,
    current: {
      releaseVersion: deployment.releaseVersion,
      releaseImageTag: deployment.releaseImageTag,
      lastReleaseCheck: deployment.lastReleaseCheck,
      releaseDrift,
    },
    provisioning: {
      status: deployment.provisioningStatus,
      bootstrapStatus: deployment.bootstrapStatus,
      lastProvisioningError: deployment.lastProvisioningError,
      railwayProjectId: deployment.railwayProjectId,
      railwayEnvironmentId: deployment.railwayEnvironmentId,
      railwayWebServiceId: deployment.railwayWebServiceId,
      railwayWorkerServiceId: deployment.railwayWorkerServiceId,
    },
    health: {
      lastHealthStatus: deployment.lastHealthStatus,
      lastHealthCheck: deployment.lastHealthCheck,
      lastHealthError: deployment.lastHealthError,
      lastWorkerHealthStatus: deployment.lastWorkerHealthStatus,
      lastWorkerHealthCheck: deployment.lastWorkerHealthCheck,
    },
    rollbackReady: Boolean(deployment.releaseImageTag && deployment.lastHealthStatus === "ok"),
    recentPreparations,
  };
}

export async function runControlPlaneReleaseOperation(actor: AppActor, params: {
  deploymentId: string;
  operation: string;
  targetReleaseImageTag?: string | null;
  targetReleaseVersion?: string | null;
  reason?: string | null;
}) {
  requireControlPlaneScope(actor, "control-plane:releases:write");
  const operation = normalizeReleaseOperation(params.operation);
  const reason = requireMutationReason(params.reason);
  const deployment = await getControlPlaneDeploymentWithWorkspace(actor, params.deploymentId);

  if (operation === "prepare_upgrade") {
    const targetReleaseImageTag = params.targetReleaseImageTag?.trim();
    invariant(targetReleaseImageTag, 400, "INVALID_INPUT", "Target release image tag is required.");
    const targetReleaseVersion = params.targetReleaseVersion?.trim() || null;
    const releaseDrift = deployment.lastHealthError?.includes("Release drift:") ? deployment.lastHealthError : null;
    const checks = {
      hasCustomerSlug: Boolean(deployment.customerSlug),
      hasRailwayProject: Boolean(deployment.railwayProjectId),
      hasRailwayEnvironment: Boolean(deployment.railwayEnvironmentId),
      hasRailwayServices: Boolean(deployment.railwayWebServiceId && deployment.railwayWorkerServiceId),
      healthOk: deployment.lastHealthStatus === "ok",
      rollbackReady: Boolean(deployment.releaseImageTag && deployment.lastHealthStatus === "ok"),
      targetDiffers: targetReleaseImageTag !== deployment.releaseImageTag || targetReleaseVersion !== (deployment.releaseVersion ?? null),
    };

    const evidence = {
      reason,
      operation,
      currentReleaseImageTag: deployment.releaseImageTag,
      currentReleaseVersion: deployment.releaseVersion,
      targetReleaseImageTag,
      targetReleaseVersion,
      releaseDrift,
      checks,
    };

    await prisma.$transaction(async (tx) => {
      if (deployment.customerAccountId) {
        await tx.customerReleaseTarget.upsert({
          where: {
            deploymentId_targetReleaseImageTag: {
              deploymentId: params.deploymentId,
              targetReleaseImageTag,
            },
          },
          update: {
            targetReleaseVersion,
            status: "PREPARED",
            evidence: redactObject(evidence) as Prisma.InputJsonObject,
            preparedByUserId: actorUserId(actor),
            preparedAt: new Date(),
          },
          create: {
            customerAccountId: deployment.customerAccountId,
            deploymentId: params.deploymentId,
            targetReleaseImageTag,
            targetReleaseVersion,
            status: "PREPARED",
            evidence: redactObject(evidence) as Prisma.InputJsonObject,
            preparedByUserId: actorUserId(actor),
          },
        });
      }
      await tx.customerDeploymentEvent.create({
        data: {
          deploymentId: params.deploymentId,
          actorUserId: actorUserId(actor),
          action: "control_plane.release.upgrade_prepared",
          meta: redactObject(evidence) as Prisma.InputJsonObject,
        },
      });
    });

    return {
      operation,
      target: {
        releaseImageTag: targetReleaseImageTag,
        releaseVersion: targetReleaseVersion,
      },
      checks,
      release: await getControlPlaneReleaseStatus(actor, params.deploymentId),
    };
  }

  throw new AppError(400, "INVALID_INPUT", "Unsupported release operation.");
}

export function getControlPlaneLatestReleaseTarget(): ControlPlaneReleaseTarget | null {
  const sharedImage = process.env.CONTROL_PLANE_LATEST_IMAGE?.trim()
    || process.env.CONTROL_PLANE_LATEST_RELEASE_IMAGE_TAG?.trim()
    || "";
  const webImage = process.env.CONTROL_PLANE_LATEST_WEB_IMAGE?.trim() || sharedImage;
  const workerImage = process.env.CONTROL_PLANE_LATEST_WORKER_IMAGE?.trim() || sharedImage;
  const releaseImageTag = process.env.CONTROL_PLANE_LATEST_RELEASE_IMAGE_TAG?.trim() || webImage;
  const releaseVersion = process.env.CONTROL_PLANE_LATEST_RELEASE_VERSION?.trim() || null;
  if (!webImage || !workerImage || !releaseImageTag) {
    return null;
  }
  return {
    releaseImageTag,
    releaseVersion,
    webImage,
    workerImage,
  };
}

export function isControlPlaneRailwayDeployConfigured() {
  return Boolean(process.env.RAILWAY_API_TOKEN?.trim());
}

function releasePreflightForDeployment(deployment: {
  customerSlug?: string | null;
  deploymentStatus?: string | null;
  provisioningStatus?: string | null;
  releaseImageTag?: string | null;
  releaseVersion?: string | null;
  lastHealthStatus?: string | null;
  lastHealthCheck?: Date | string | null;
  lastHealthError?: string | null;
  railwayProjectId?: string | null;
  railwayEnvironmentId?: string | null;
  railwayWebServiceId?: string | null;
  railwayWorkerServiceId?: string | null;
}, target: ControlPlaneReleaseTarget | null, options: { railwayDeployConfigured?: boolean } = {}) {
  const railwayDeployConfigured = options.railwayDeployConfigured ?? isControlPlaneRailwayDeployConfigured();
  const checks: ControlPlaneReleasePreflightCheck[] = [
    {
      key: "target_configured",
      label: "Latest release configured",
      ok: Boolean(target),
      detail: target?.releaseImageTag ?? "Set CONTROL_PLANE_LATEST_WEB_IMAGE and CONTROL_PLANE_LATEST_WORKER_IMAGE.",
    },
    {
      key: "not_suspended",
      label: "Client is not suspended",
      ok: deployment.deploymentStatus !== "SUSPENDED" && deployment.provisioningStatus !== "suspended",
      detail: deployment.provisioningStatus || deployment.deploymentStatus || "Unknown deployment status.",
    },
    {
      key: "railway_target",
      label: "Railway target is complete",
      ok: Boolean(deployment.railwayProjectId && deployment.railwayEnvironmentId && deployment.railwayWebServiceId && deployment.railwayWorkerServiceId),
      detail: deployment.railwayProjectId ? "Project, environment, web, and worker services are recorded." : "Railway project and service IDs are required.",
    },
    {
      key: "railway_api_token_configured",
      label: "Railway release executor is configured",
      ok: railwayDeployConfigured,
      detail: railwayDeployConfigured
        ? "Railway API token is configured for release execution."
        : "Railway API token is not configured for control-plane release execution.",
    },
    {
      key: "health_known",
      label: "Health was checked",
      ok: Boolean(deployment.lastHealthStatus && deployment.lastHealthCheck),
      detail: deployment.lastHealthCheck ? `Last health status: ${deployment.lastHealthStatus}.` : "Run a health probe first.",
    },
    {
      key: "rollback_ready",
      label: "Rollback evidence exists",
      ok: Boolean(deployment.releaseImageTag && deployment.lastHealthStatus === "ok"),
      detail: deployment.releaseImageTag && deployment.lastHealthStatus === "ok"
        ? `Current release ${deployment.releaseImageTag} is healthy.`
        : "Current release and healthy runtime must be recorded before deploying.",
    },
    {
      key: "target_differs",
      label: "Target differs from current",
      ok: Boolean(target && (target.releaseImageTag !== deployment.releaseImageTag || target.releaseVersion !== (deployment.releaseVersion ?? null))),
      detail: target ? `Target ${target.releaseImageTag}; current ${deployment.releaseImageTag ?? "unknown"}.` : "No target release configured.",
    },
    {
      key: "no_release_drift",
      label: "No release drift is open",
      ok: !deployment.lastHealthError?.includes("Release drift:"),
      detail: deployment.lastHealthError?.includes("Release drift:") ? deployment.lastHealthError : "No release drift recorded.",
    },
  ];
  return {
    eligible: checks.every((check) => check.ok),
    blockers: checks.filter((check) => !check.ok).map((check) => check.detail),
    checks,
  };
}

const DEPLOY_LATEST_EXPLICIT_SELECTION_BYPASS_KEYS = new Set([
  "health_known",
  "rollback_ready",
  "no_release_drift",
]);

function canBypassDeployLatestPreflight(preflight: { checks: ControlPlaneReleasePreflightCheck[] }) {
  const blockers = preflight.checks.filter((check) => !check.ok);
  return blockers.length > 0 && blockers.every((check) => DEPLOY_LATEST_EXPLICIT_SELECTION_BYPASS_KEYS.has(check.key));
}

export async function getControlPlaneDeployLatestPreflight(actor: AppActor, deploymentId: string) {
  const deployment = await getControlPlaneDeploymentWithWorkspace(actor, deploymentId);
  const target = getControlPlaneLatestReleaseTarget();
  return {
    deploymentId,
    target,
    ...releasePreflightForDeployment(deployment, target),
  };
}

export async function deployLatestControlPlaneRelease(actor: AppActor, params: {
  deploymentId: string;
  reason?: string | null;
  force?: boolean | null;
  target?: ControlPlaneReleaseTarget | null;
}, railwayClient?: RailwayClient) {
  requireControlPlaneScope(actor, "control-plane:releases:write");
  const reason = requireMutationReason(params.reason);
  await requireControlPlaneDeploymentWriteAccess(actor, params.deploymentId);
  const deployment = await getControlPlaneDeploymentWithWorkspace(actor, params.deploymentId);
  const target = params.target ?? getControlPlaneLatestReleaseTarget();
  const preflight = releasePreflightForDeployment(deployment, target, { railwayDeployConfigured: Boolean(railwayClient) || isControlPlaneRailwayDeployConfigured() });
  const canForceDeploy = Boolean(params.force && canBypassDeployLatestPreflight(preflight));
  if (!preflight.eligible && !canForceDeploy) {
    throw new AppError(400, "RELEASE_PREFLIGHT_FAILED", preflight.blockers.join(" "));
  }
  invariant(target, 400, "LATEST_RELEASE_NOT_CONFIGURED", "Latest release target is not configured.");
  invariant(deployment.customerSlug, 400, "INVALID_INPUT", "Customer deployment is missing a customer slug.");
  invariant(deployment.railwayProjectId, 400, "INVALID_INPUT", "Customer deployment is missing a Railway project ID.");
  invariant(deployment.railwayEnvironmentId, 400, "INVALID_INPUT", "Customer deployment is missing a Railway environment ID.");
  invariant(deployment.railwayWebServiceId, 400, "INVALID_INPUT", "Customer deployment is missing a Railway web service ID.");
  invariant(deployment.railwayWorkerServiceId, 400, "INVALID_INPUT", "Customer deployment is missing a Railway worker service ID.");
  const activeRailwayClient = railwayClient ?? createRailwayClientFromEnv();

  await prisma.$transaction(async (tx) => {
    await tx.customerDeployment.update({
      where: { id: params.deploymentId },
      data: {
        provisioningStatus: "provisioning",
        lastProvisioningError: null,
      },
    });
    if (deployment.customerAccountId) {
      await tx.customerReleaseTarget.upsert({
        where: {
          deploymentId_targetReleaseImageTag: {
            deploymentId: params.deploymentId,
            targetReleaseImageTag: target.releaseImageTag,
          },
        },
        update: {
          targetReleaseVersion: target.releaseVersion,
          status: "APPLYING",
          evidence: redactObject({ reason, target, preflight }) as Prisma.InputJsonObject,
          preparedByUserId: actorUserId(actor),
          preparedAt: new Date(),
        },
        create: {
          customerAccountId: deployment.customerAccountId,
          deploymentId: params.deploymentId,
          targetReleaseImageTag: target.releaseImageTag,
          targetReleaseVersion: target.releaseVersion,
          status: "APPLYING",
          evidence: redactObject({ reason, target, preflight }) as Prisma.InputJsonObject,
          preparedByUserId: actorUserId(actor),
        },
      });
    }
    await tx.customerDeploymentEvent.create({
      data: {
        deploymentId: params.deploymentId,
        actorUserId: actorUserId(actor),
        action: "control_plane.release.deploy_latest_started",
        meta: redactObject({ reason, target, preflight, force: Boolean(params.force) }) as Prisma.InputJsonObject,
      },
    });
  });

  try {
    const result = await upgradeRailwayCustomerRelease(activeRailwayClient, {
      projectId: deployment.railwayProjectId,
      environmentId: deployment.railwayEnvironmentId,
      webServiceId: deployment.railwayWebServiceId,
      workerServiceId: deployment.railwayWorkerServiceId,
      webImage: target.webImage,
      workerImage: target.workerImage,
      variables: {
        CORGTEX_RELEASE_IMAGE_TAG: target.releaseImageTag,
        CORGTEX_RELEASE_VERSION: target.releaseVersion ?? "",
      },
    });

    await prisma.$transaction(async (tx) => {
      await tx.customerDeployment.update({
        where: { id: params.deploymentId },
        data: {
          provisioningStatus: "active",
          releaseVersion: target.releaseVersion,
          releaseImageTag: target.releaseImageTag,
          lastReleaseCheck: new Date(),
          lastProvisioningError: null,
        },
      });
      if (deployment.customerAccountId) {
        await tx.customerReleaseTarget.upsert({
          where: {
            deploymentId_targetReleaseImageTag: {
              deploymentId: params.deploymentId,
              targetReleaseImageTag: target.releaseImageTag,
            },
          },
          update: {
            status: "APPLIED",
            appliedAt: new Date(),
            evidence: redactObject({ reason, target, result }) as Prisma.InputJsonObject,
          },
          create: {
            customerAccountId: deployment.customerAccountId,
            deploymentId: params.deploymentId,
            targetReleaseImageTag: target.releaseImageTag,
            targetReleaseVersion: target.releaseVersion,
            status: "APPLIED",
            appliedAt: new Date(),
            evidence: redactObject({ reason, target, result }) as Prisma.InputJsonObject,
            preparedByUserId: actorUserId(actor),
          },
        });
      }
      await tx.customerDeploymentEvent.create({
        data: {
          deploymentId: params.deploymentId,
          actorUserId: actorUserId(actor),
          action: "control_plane.release.deploy_latest_succeeded",
          meta: redactObject({ reason, target, result }) as Prisma.InputJsonObject,
        },
      });
    });

    return {
      deploymentId: params.deploymentId,
      status: "deployed" as const,
      target,
      result,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown Railway upgrade error.";
    await prisma.$transaction(async (tx) => {
      await tx.customerDeployment.update({
        where: { id: params.deploymentId },
        data: {
          provisioningStatus: "degraded",
          lastProvisioningError: message,
        },
      });
      if (deployment.customerAccountId) {
        await tx.customerReleaseTarget.upsert({
          where: {
            deploymentId_targetReleaseImageTag: {
              deploymentId: params.deploymentId,
              targetReleaseImageTag: target.releaseImageTag,
            },
          },
          update: {
            status: "FAILED",
            evidence: redactObject({ reason, target, error: message }) as Prisma.InputJsonObject,
          },
          create: {
            customerAccountId: deployment.customerAccountId,
            deploymentId: params.deploymentId,
            targetReleaseImageTag: target.releaseImageTag,
            targetReleaseVersion: target.releaseVersion,
            status: "FAILED",
            evidence: redactObject({ reason, target, error: message }) as Prisma.InputJsonObject,
            preparedByUserId: actorUserId(actor),
          },
        });
      }
      await tx.customerDeploymentEvent.create({
        data: {
          deploymentId: params.deploymentId,
          actorUserId: actorUserId(actor),
          action: "control_plane.release.deploy_latest_failed",
          meta: redactObject({ reason, target, error: message }) as Prisma.InputJsonObject,
        },
      });
    });
    throw error;
  }
}

export async function enqueueControlPlaneDeployLatestRollout(actor: AppActor, params: {
  deploymentIds?: string[] | null;
  allEligible?: boolean | null;
  includeUnhealthy?: boolean | null;
  reason?: string | null;
  limit?: number | null;
}) {
  requireControlPlaneScope(actor, "control-plane:releases:write");
  const reason = requireMutationReason(params.reason);
  const target = getControlPlaneLatestReleaseTarget();
  invariant(target, 400, "LATEST_RELEASE_NOT_CONFIGURED", "Latest release target is not configured.");

  const requestedIds = Array.from(new Set((params.deploymentIds ?? []).map((id) => id.trim()).filter(Boolean)));
  const allEligible = params.allEligible === true;
  invariant(requestedIds.length > 0 || allEligible, 400, "INVALID_INPUT", "Select at least one customer deployment or set allEligible=true.");
  if (allEligible) {
    requireControlPlaneFleetReleaseWriteAccess(actor);
  }
  const limit = Math.min(Math.max(Math.floor(params.limit ?? 100), 1), 100);
  invariant(requestedIds.length <= limit, 400, "INVALID_INPUT", `Selected deployment count (${requestedIds.length}) exceeds rollout limit (${limit}).`);
  const deployments = requestedIds.length
    ? await prisma.customerDeployment.findMany({
      where: { id: { in: requestedIds } },
      orderBy: { label: "asc" },
    })
    : await prisma.customerDeployment.findMany({
      where: {
        customerAccountId: { not: null },
        deploymentStatus: { notIn: ["RETIRED", "SUSPENDED"] },
      },
      orderBy: [
        { lastHealthStatus: "asc" },
        { label: "asc" },
      ],
      take: limit,
    });
  if (requestedIds.length) {
    const foundIds = new Set(deployments.map((deployment) => deployment.id));
    const missingIds = requestedIds.filter((deploymentId) => !foundIds.has(deploymentId));
    invariant(missingIds.length === 0, 400, "INVALID_INPUT", `Unknown customer deployment IDs: ${missingIds.join(", ")}.`);
  }

  const bucket = Math.floor(Date.now() / (15 * 60 * 1000));
  const results: Array<{ deploymentId: string; label: string; status: "queued" | "skipped" | "preflight_failed"; blockers: string[] }> = [];
  await prisma.$transaction(async (tx) => {
    for (const deployment of deployments) {
      if (requestedIds.length) {
        await requireControlPlaneDeploymentWriteAccess(actor, deployment.id);
      }
      const preflight = releasePreflightForDeployment(deployment, target);
      const bypassPreflight = Boolean(requestedIds.length && params.includeUnhealthy && canBypassDeployLatestPreflight(preflight));
      const allowQueue = preflight.eligible || bypassPreflight;
      if (!allowQueue) {
        results.push({
          deploymentId: deployment.id,
          label: deployment.label,
          status: allEligible ? "skipped" : "preflight_failed",
          blockers: preflight.blockers,
        });
        await tx.customerDeploymentEvent.create({
          data: {
            deploymentId: deployment.id,
            actorUserId: actorUserId(actor),
            action: "control_plane.release.deploy_latest_skipped",
            meta: redactObject({ reason, target, blockers: preflight.blockers }) as Prisma.InputJsonObject,
          },
        });
        continue;
      }

      const dedupeKey = `control-plane:deploy-latest:${deployment.id}:${target.releaseImageTag}:${target.releaseVersion ?? "no-version"}:${bucket}`;
      const createResult = await tx.workflowJob.createMany({
        data: {
          workspaceId: null,
          eventId: null,
          type: CONTROL_PLANE_RELEASE_DEPLOY_JOB_TYPE,
          payload: {
            deploymentId: deployment.id,
            target,
            reason,
            force: bypassPreflight,
            requestedBy: actorUserId(actor) ?? (isControlPlaneAgent(actor) ? actor.label : "control-plane"),
          },
          dedupeKey,
        },
        skipDuplicates: true,
      });
      if (createResult.count === 0) {
        const existingJob = await tx.workflowJob.findUnique({
          where: { dedupeKey },
          select: { id: true, status: true },
        });
        const blockers = [`A rollout job already exists in this dedupe window${existingJob?.status ? ` with status ${existingJob.status}` : ""}.`];
        await tx.customerDeploymentEvent.create({
          data: {
            deploymentId: deployment.id,
            actorUserId: actorUserId(actor),
            action: "control_plane.release.deploy_latest_skipped",
            meta: redactObject({ reason, target, blockers, dedupeKey, existingJobId: existingJob?.id ?? null }) as Prisma.InputJsonObject,
          },
        });
        results.push({
          deploymentId: deployment.id,
          label: deployment.label,
          status: "skipped",
          blockers,
        });
        continue;
      }
      await tx.customerDeploymentEvent.create({
        data: {
          deploymentId: deployment.id,
          actorUserId: actorUserId(actor),
          action: "control_plane.release.deploy_latest_queued",
          meta: redactObject({ reason, target, preflight }) as Prisma.InputJsonObject,
        },
      });
      results.push({
        deploymentId: deployment.id,
        label: deployment.label,
        status: "queued",
        blockers: [],
      });
    }
  });

  return {
    target,
    requested: deployments.length,
    queuedJobs: results.filter((result) => result.status === "queued").length,
    results,
  };
}

export async function listControlPlaneReleaseRolloutJobs(actor: AppActor, params: {
  deploymentId?: string | null;
  take?: number | null;
} = {}) {
  if (params.deploymentId) {
    await requireControlPlaneAccess(actor, { deploymentId: params.deploymentId });
  } else {
    await requireControlPlaneAccess(actor);
  }

  const take = boundedInteger(params.take, 50, 1, 100);
  const jobs = await prisma.workflowJob.findMany({
    where: {
      type: CONTROL_PLANE_RELEASE_DEPLOY_JOB_TYPE,
      ...(params.deploymentId ? { payload: { path: ["deploymentId"], equals: params.deploymentId } } : {}),
    },
    orderBy: { createdAt: "desc" },
    take,
  });

  return jobs.map((job) => ({
    id: job.id,
    status: job.status,
    attempts: job.attempts,
    error: job.error,
    payload: redactObject((job.payload && typeof job.payload === "object" ? job.payload : {}) as JsonRecord),
    createdAt: job.createdAt,
    completedAt: job.completedAt,
  }));
}

export async function runControlPlaneReleaseDeployJob(params: {
  deploymentId: string;
  reason?: string | null;
  force?: boolean | null;
  target?: ControlPlaneReleaseTarget | null;
}) {
  return deployLatestControlPlaneRelease(controlPlaneWorkerActor, {
    deploymentId: params.deploymentId,
    reason: params.reason || "Queued Ops Control Plane deploy latest job.",
    force: params.force,
    target: params.target,
  });
}

type CustomerDeploymentHealthPayload = {
  database?: string;
  schema?: string;
  runtime?: {
    redis?: string;
    storage?: string;
  };
  release?: {
    imageTag?: string | null;
    gitSha?: string | null;
  };
};

async function probeControlPlaneDeploymentHealthCore(actor: AppActor, params: {
  deploymentId: string;
  reason: string;
}) {
  const deployment = await getControlPlaneDeploymentWithWorkspace(actor, params.deploymentId);
  let status = "unknown";
  let error: string | null = null;
  let health: CustomerDeploymentHealthPayload | null = null;

  try {
    const response = await fetch(`${deployment.url.replace(/\/$/, "")}/api/health`, { method: "GET" });
    health = await response.json().catch(() => null) as CustomerDeploymentHealthPayload | null;
    if (response.ok) {
      status = "ok";
      const runtimeErrors = [];
      if (health?.database && health.database !== "up") runtimeErrors.push(`Database ${health.database}`);
      if (health?.schema && health.schema !== "ready") runtimeErrors.push(`Schema ${health.schema}`);
      if (health?.runtime?.redis && health.runtime.redis !== "configured") runtimeErrors.push(`Redis ${health.runtime.redis}`);
      if (health?.runtime?.storage && health.runtime.storage !== "configured") runtimeErrors.push(`Storage ${health.runtime.storage}`);
      const actualRelease = health?.release?.imageTag || health?.release?.gitSha || null;
      if (deployment.releaseImageTag && actualRelease && actualRelease !== deployment.releaseImageTag) {
        runtimeErrors.push(`Release drift: expected ${deployment.releaseImageTag}, got ${actualRelease}`);
      }
      if (runtimeErrors.length > 0) {
        status = "degraded";
        error = runtimeErrors.join("; ");
      }
    } else {
      status = "degraded";
      error = `Status ${response.status}`;
    }
  } catch (probeError) {
    status = "down";
    error = probeError instanceof Error ? probeError.message : "Health probe failed.";
  }

  await prisma.customerDeployment.update({
    where: { id: params.deploymentId },
    data: {
      lastHealthCheck: new Date(),
      lastHealthStatus: status,
      lastHealthError: error,
      lastReleaseCheck: new Date(),
      provisioningStatus: status === "ok" ? "active" : "degraded",
      ...(deploymentHealthStatus(status) ? { deploymentStatus: deploymentHealthStatus(status) } : {}),
    },
  });
  await Promise.all([
    recordFleetHealthSnapshot({
      customerAccountId: deployment.customerAccountId,
      deploymentId: params.deploymentId,
      snapshotKind: "HEALTH",
      status,
      summary: {
        reason: params.reason,
        health,
      },
      error,
    }),
    recordFleetHealthSnapshot({
      customerAccountId: deployment.customerAccountId,
      deploymentId: params.deploymentId,
      snapshotKind: "RELEASE",
      status: error?.includes("Release drift:") ? "degraded" : status === "ok" ? "ok" : "unknown",
      summary: {
        expectedReleaseImageTag: deployment.releaseImageTag,
        expectedReleaseVersion: deployment.releaseVersion,
        observedRelease: health?.release ?? null,
      },
      error: error?.includes("Release drift:") ? error : null,
    }),
  ]);
  await recordCustomerDeploymentEvent(actor, params.deploymentId, "control_plane.release.health_probed", {
    reason: params.reason,
    status,
    error,
    release: health?.release ?? null,
  });
  return {
    status,
    error,
    release: await getControlPlaneReleaseStatus(actor, params.deploymentId),
  };
}

export async function probeControlPlaneDeploymentHealth(actor: AppActor, params: {
  deploymentId: string;
  reason?: string | null;
}) {
  requireControlPlaneScope(actor, "control-plane:releases:write");
  const reason = requireMutationReason(params.reason);
  return probeControlPlaneDeploymentHealthCore(actor, {
    deploymentId: params.deploymentId,
    reason,
  });
}

function runtimeHealthErrors(health: CustomerDeploymentHealthPayload | null) {
  const errors = [];
  if (!health) {
    errors.push("Health payload missing");
    return errors;
  }
  if (health.database && health.database !== "up") errors.push(`Database ${health.database}`);
  if (health.schema && health.schema !== "ready") errors.push(`Schema ${health.schema}`);
  if (health.runtime?.redis && health.runtime.redis !== "configured") errors.push(`Redis ${health.runtime.redis}`);
  if (health.runtime?.storage && health.runtime.storage !== "configured") errors.push(`Storage ${health.runtime.storage}`);
  return errors;
}

function observedReleaseMatches(health: CustomerDeploymentHealthPayload | null, releaseImageTag: string) {
  const release = health?.release;
  return Boolean(release && (release.imageTag === releaseImageTag || release.gitSha === releaseImageTag));
}

export async function recordVerifiedControlPlaneRelease(actor: AppActor, params: {
  deploymentId: string;
  releaseImageTag: string;
  releaseVersion?: string | null;
  reason?: string | null;
}) {
  requireControlPlaneScope(actor, "control-plane:releases:write");
  const reason = requireMutationReason(params.reason);
  const releaseImageTag = params.releaseImageTag.trim();
  invariant(releaseImageTag, 400, "INVALID_INPUT", "Release image tag is required.");
  const releaseVersion = params.releaseVersion?.trim() || null;
  await requireControlPlaneDeploymentWriteAccess(actor, params.deploymentId);
  const deployment = await getControlPlaneDeploymentWithWorkspace(actor, params.deploymentId);

  let health: CustomerDeploymentHealthPayload | null = null;
  let status = "ok";
  let error: string | null = null;
  try {
    const response = await fetch(`${deployment.url.replace(/\/$/, "")}/api/health`, { method: "GET" });
    health = await response.json().catch(() => null) as CustomerDeploymentHealthPayload | null;
    invariant(response.ok, 400, "HEALTH_PROBE_FAILED", `Health probe returned status ${response.status}.`);
    const errors = runtimeHealthErrors(health);
    invariant(errors.length === 0, 409, "HEALTH_NOT_VERIFIED", errors.join("; "));
    invariant(
      observedReleaseMatches(health, releaseImageTag),
      409,
      "RELEASE_MISMATCH",
      `Health reported release ${health?.release?.imageTag ?? health?.release?.gitSha ?? "unknown"}, not ${releaseImageTag}.`,
    );
  } catch (probeError) {
    if (probeError instanceof AppError) {
      throw probeError;
    }
    status = "down";
    error = probeError instanceof Error ? probeError.message : "Health probe failed.";
    throw new AppError(400, "HEALTH_PROBE_FAILED", error);
  }

  const evidence = {
    reason,
    releaseImageTag,
    releaseVersion,
    observedRelease: health?.release ?? null,
  };

  await prisma.$transaction(async (tx) => {
    await tx.customerDeployment.update({
      where: { id: params.deploymentId },
      data: {
        releaseImageTag,
        releaseVersion,
        lastHealthCheck: new Date(),
        lastHealthStatus: status,
        lastHealthError: error,
        lastReleaseCheck: new Date(),
        provisioningStatus: "active",
        deploymentStatus: "ACTIVE",
        lastProvisioningError: null,
      },
    });
    if (deployment.customerAccountId) {
      await tx.customerReleaseTarget.upsert({
        where: {
          deploymentId_targetReleaseImageTag: {
            deploymentId: params.deploymentId,
            targetReleaseImageTag: releaseImageTag,
          },
        },
        update: {
          targetReleaseVersion: releaseVersion,
          status: "APPLIED",
          evidence: redactObject(evidence) as Prisma.InputJsonObject,
          preparedByUserId: actorUserId(actor),
          preparedAt: new Date(),
          appliedAt: new Date(),
        },
        create: {
          customerAccountId: deployment.customerAccountId,
          deploymentId: params.deploymentId,
          targetReleaseImageTag: releaseImageTag,
          targetReleaseVersion: releaseVersion,
          status: "APPLIED",
          evidence: redactObject(evidence) as Prisma.InputJsonObject,
          preparedByUserId: actorUserId(actor),
          appliedAt: new Date(),
        },
      });
    }
    await tx.customerDeploymentEvent.create({
      data: {
        deploymentId: params.deploymentId,
        actorUserId: actorUserId(actor),
        action: "control_plane.release.verified_recorded",
        meta: redactObject(evidence) as Prisma.InputJsonObject,
      },
    });
  });
  await Promise.all([
    recordFleetHealthSnapshot({
      customerAccountId: deployment.customerAccountId,
      deploymentId: params.deploymentId,
      snapshotKind: "HEALTH",
      status,
      summary: {
        reason,
        health,
      },
      error,
    }),
    recordFleetHealthSnapshot({
      customerAccountId: deployment.customerAccountId,
      deploymentId: params.deploymentId,
      snapshotKind: "RELEASE",
      status,
      summary: {
        expectedReleaseImageTag: releaseImageTag,
        expectedReleaseVersion: releaseVersion,
        observedRelease: health?.release ?? null,
      },
      error: null,
    }),
  ]);

  return {
    deploymentId: params.deploymentId,
    recorded: true,
    releaseImageTag,
    releaseVersion,
    observedRelease: health?.release ?? null,
    release: await getControlPlaneReleaseStatus(actor, params.deploymentId),
  };
}

export async function configureSupportConnector(actor: AppActor, params: {
  deploymentId: string;
  supportBaseUrl?: string | null;
  supportMcpUrl?: string | null;
  supportCredential?: string | null;
  supportCredentialLabel?: string | null;
  supportNotes?: string | null;
}) {
  requireControlPlaneScope(actor, "control-plane:support:write");
  await requireControlPlaneAccess(actor, { deploymentId: params.deploymentId });
  const existing = await prisma.customerDeployment.findUnique({
    where: { id: params.deploymentId },
    select: { supportCredentialEnc: true },
  });
  invariant(existing, 404, "NOT_FOUND", "Customer deployment not found.");
  const credential = params.supportCredential?.trim();
  invariant(Boolean(credential) || Boolean(existing.supportCredentialEnc), 400, "INVALID_INPUT", "Support credential is required.");

  const deployment = await prisma.customerDeployment.update({
    where: { id: params.deploymentId },
    data: {
      supportBaseUrl: params.supportBaseUrl?.trim() || null,
      supportMcpUrl: params.supportMcpUrl?.trim() || null,
      ...(credential ? { supportCredentialEnc: encryptSecret(credential) } : {}),
      supportCredentialLabel: params.supportCredentialLabel?.trim() || SUPPORT_ACTOR_LABEL,
      supportConnectorStatus: "configured",
      supportAccessMode: "broad",
      ...(credential ? { supportLastConnectedAt: new Date() } : {}),
      supportLastSyncError: null,
      supportNotes: params.supportNotes?.trim() || null,
    },
  });

  await recordCustomerDeploymentEvent(actor, params.deploymentId, "support_connector.configured", {
    supportBaseUrl: deployment.supportBaseUrl,
    supportMcpUrl: deployment.supportMcpUrl,
    supportCredentialLabel: deployment.supportCredentialLabel,
  });

  return {
    ...deployment,
    hasSupportCredential: true,
    supportCredentialEnc: undefined,
  };
}

async function fetchCustomerSupportSnapshotCore(deploymentId: string) {
  const connector = await loadSupportConnector(deploymentId);

  const calls = await Promise.allSettled([
    callMcpTool({ ...connector, toolName: "get_workspace_info", arguments: {} }),
    callMcpTool({ ...connector, toolName: "list_members", arguments: {} }),
    callMcpTool({ ...connector, toolName: "list_integrations", arguments: {} }),
    callMcpTool({ ...connector, toolName: "list_data_sources", arguments: {} }),
    callMcpTool({ ...connector, toolName: "list_agent_runs", arguments: { take: 10 } }),
    callMcpTool({ ...connector, toolName: "list_failed_jobs", arguments: { take: 10 } }),
  ]);

  const [workspace, members, integrations, dataSources, agentRuns, failedJobs] = calls.map((result) => (
    result.status === "fulfilled"
      ? summarizeMcpResponse(result.value)
      : { error: result.reason instanceof Error ? result.reason.message : "Request failed." }
  ));

  const hasError = calls.some((result) => result.status === "rejected");
  await prisma.customerDeployment.update({
    where: { id: deploymentId },
    data: {
      supportConnectorStatus: hasError ? "degraded" : "connected",
      supportLastSyncAt: new Date(),
      supportLastSyncError: hasError ? "One or more support snapshot calls failed." : null,
    },
  });

  const snapshot = { workspace, members, integrations, dataSources, agentRuns, failedJobs };
  await Promise.all([
    recordFleetHealthSnapshot({
      customerAccountId: connector.deployment.customerAccountId,
      deploymentId: deploymentId,
      snapshotKind: "CONNECTOR",
      status: hasError ? "degraded" : "ok",
      summary: {
        supportConnectorStatus: hasError ? "degraded" : "connected",
        supportMcpUrl: connector.mcpUrl,
      },
      error: hasError ? "One or more support snapshot calls failed." : null,
    }),
    recordFleetHealthSnapshot({
      customerAccountId: connector.deployment.customerAccountId,
      deploymentId: deploymentId,
      snapshotKind: "SUPPORT_READY",
      status: hasError ? "degraded" : "ok",
      summary: snapshot,
      error: hasError ? "One or more support snapshot calls failed." : null,
    }),
  ]);

  return snapshot;
}

export async function fetchCustomerSupportSnapshot(actor: AppActor, deploymentId: string) {
  requireControlPlaneScope(actor, "control-plane:support:write");
  await requireControlPlaneAccess(actor, { deploymentId });
  return fetchCustomerSupportSnapshotCore(deploymentId);
}

export async function refreshControlPlaneFleetSnapshots(actor: AppActor, params: {
  deploymentId: string;
  snapshotKinds?: string[] | null;
  reason?: string | null;
}) {
  requireControlPlaneScope(actor, "control-plane:fleet:write");
  const reason = requireMutationReason(params.reason);
  const kinds = normalizeSnapshotKinds(params.snapshotKinds);
  const deployment = await getControlPlaneDeploymentWithWorkspace(actor, params.deploymentId);
  const adapter = createControlPlaneAdapter(deployment);
  const results: Array<{ snapshotKind: FleetSnapshotKind; status: string; error: string | null }> = [];

  for (const snapshotKind of kinds) {
    try {
      if (snapshotKind === "HEALTH") {
        const result = await probeControlPlaneDeploymentHealthCore(actor, {
          deploymentId: params.deploymentId,
          reason,
        });
        results.push({ snapshotKind, status: result.status, error: result.error });
        continue;
      }

      if (snapshotKind === "RELEASE") {
        const release = await getControlPlaneReleaseStatus(actor, params.deploymentId);
        const status = releaseSnapshotStatus(release);
        await recordFleetHealthSnapshot({
          customerAccountId: deployment.customerAccountId,
          deploymentId: params.deploymentId,
          snapshotKind,
          status,
          summary: release,
          error: release.health.lastHealthError,
        });
        results.push({ snapshotKind, status, error: release.health.lastHealthError });
        continue;
      }

      if (snapshotKind === "CONNECTOR") {
        const status = connectorSnapshotStatus(deployment.supportConnectorStatus);
        await recordFleetHealthSnapshot({
          customerAccountId: deployment.customerAccountId,
          deploymentId: params.deploymentId,
          snapshotKind,
          status,
          summary: {
            adapterKind: adapter.kind,
            supportConnectorStatus: deployment.supportConnectorStatus,
            supportLastConnectedAt: deployment.supportLastConnectedAt,
            supportLastSyncAt: deployment.supportLastSyncAt,
            requiresConnectorSetup: adapter.requiresConnectorSetup,
          },
          error: deployment.supportLastSyncError,
        });
        results.push({ snapshotKind, status, error: deployment.supportLastSyncError });
        continue;
      }

      if (snapshotKind === "SUPPORT_READY") {
        if (adapter.requiresConnectorSetup) {
          await recordFleetHealthSnapshot({
            customerAccountId: deployment.customerAccountId,
            deploymentId: params.deploymentId,
            snapshotKind,
            status: "not_configured",
            summary: {
              adapterKind: adapter.kind,
              requiresConnectorSetup: true,
            },
            error: "Support connector is not configured.",
          });
          results.push({ snapshotKind, status: "not_configured", error: "Support connector is not configured." });
          continue;
        }
        const snapshot = await fetchCustomerSupportSnapshotCore(params.deploymentId);
        const status = supportSnapshotStatus(snapshot);
        results.push({
          snapshotKind,
          status,
          error: status === "degraded" ? "One or more support snapshot calls failed." : null,
        });
        continue;
      }

      if (snapshotKind === "CONTEXT") {
        const context = await getControlPlaneContextHealth(actor, params.deploymentId);
        const status = contextSnapshotStatus(context);
        const error = ("supportLastSyncError" in context ? context.supportLastSyncError : null) ?? null;
        await recordFleetHealthSnapshot({
          customerAccountId: deployment.customerAccountId,
          deploymentId: params.deploymentId,
          snapshotKind,
          status,
          summary: context,
          error,
        });
        results.push({ snapshotKind, status, error });
        continue;
      }

      if (snapshotKind === "INTEGRATION") {
        const integrations = await getControlPlaneIntegrationStatus(actor, params.deploymentId);
        const status = integrationSnapshotStatus(integrations);
        await recordFleetHealthSnapshot({
          customerAccountId: deployment.customerAccountId,
          deploymentId: params.deploymentId,
          snapshotKind,
          status,
          summary: integrations,
          error: null,
        });
        results.push({ snapshotKind, status, error: null });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Fleet snapshot refresh failed.";
      await recordFleetHealthSnapshot({
        customerAccountId: deployment.customerAccountId,
        deploymentId: params.deploymentId,
        snapshotKind,
        status: "failed",
        summary: {
          adapterKind: adapter.kind,
          reason,
        },
        error: message,
      });
      results.push({ snapshotKind, status: "failed", error: message });
    }
  }

  await recordCustomerDeploymentEvent(actor, params.deploymentId, "control_plane.fleet_snapshots_refreshed", {
    reason,
    snapshotKinds: kinds,
    results,
  });

  return {
    deploymentId: params.deploymentId,
    adapterKind: adapter.kind,
    results,
  };
}

export async function enqueueControlPlaneFleetSnapshots(actor: AppActor, params: {
  deploymentId?: string | null;
  snapshotKinds?: string[] | null;
  reason?: string | null;
  limit?: number | null;
}) {
  requireControlPlaneScope(actor, "control-plane:fleet:write");
  const reason = requireMutationReason(params.reason);
  const snapshotKinds = normalizeSnapshotKinds(params.snapshotKinds);
  const limit = Math.min(Math.max(Math.floor(params.limit ?? 100), 1), 500);
  const deployments = params.deploymentId?.trim()
    ? [await getControlPlaneDeploymentWithWorkspace(actor, params.deploymentId.trim())]
    : await prisma.customerDeployment.findMany({
      where: {
        customerAccountId: { not: null },
        deploymentStatus: { notIn: ["RETIRED", "SUSPENDED"] },
      },
      orderBy: [
        { lastHealthCheck: "asc" },
        { createdAt: "asc" },
      ],
      take: limit,
      include: {
        managedWorkspace: {
          select: managedWorkspaceSelect,
        },
      },
    });

  const bucket = Math.floor(Date.now() / (15 * 60 * 1000));
  await prisma.$transaction(async (tx) => {
    for (const deployment of deployments) {
      await tx.workflowJob.upsert({
        where: {
          dedupeKey: `control-plane:fleet-snapshot:${deployment.id}:${snapshotKinds.join(",")}:${bucket}`,
        },
        update: {},
        create: {
          workspaceId: null,
          eventId: null,
          type: CONTROL_PLANE_FLEET_SNAPSHOT_JOB_TYPE,
          payload: {
            deploymentId: deployment.id,
            snapshotKinds,
            reason,
            requestedBy: actorUserId(actor) ?? (isControlPlaneAgent(actor) ? actor.label : "control-plane"),
          },
          dedupeKey: `control-plane:fleet-snapshot:${deployment.id}:${snapshotKinds.join(",")}:${bucket}`,
        },
      });
    }
  });

  return {
    queuedJobs: deployments.length,
    snapshotKinds,
    deploymentIds: deployments.map((deployment) => deployment.id),
  };
}

async function runWithConcurrency<T>(items: T[], concurrency: number, callback: (item: T) => Promise<unknown>) {
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const item = items[nextIndex++];
      await callback(item);
    }
  });
  await Promise.all(workers);
}

export async function runControlPlaneFleetSnapshotJob(params: {
  deploymentId?: string | null;
  snapshotKinds?: string[] | null;
  reason?: string | null;
  limit?: number | null;
  concurrency?: number | null;
}) {
  const reason = params.reason?.trim() || "Scheduled Control Plane fleet snapshot.";
  const snapshotKinds = normalizeSnapshotKinds(params.snapshotKinds);
  if (params.deploymentId?.trim()) {
    return refreshControlPlaneFleetSnapshots(controlPlaneWorkerActor, {
      deploymentId: params.deploymentId.trim(),
      snapshotKinds,
      reason,
    });
  }

  const limit = Math.min(Math.max(Math.floor(params.limit ?? readPositiveInteger(process.env.CONTROL_PLANE_FLEET_SWEEP_BATCH_SIZE, 50, 500)), 1), 500);
  const concurrency = Math.min(Math.max(Math.floor(params.concurrency ?? readPositiveInteger(process.env.CONTROL_PLANE_FLEET_SWEEP_CONCURRENCY, 5, 20)), 1), 20);
  const deployments = await prisma.customerDeployment.findMany({
    where: {
      customerAccountId: { not: null },
      deploymentStatus: { notIn: ["RETIRED", "SUSPENDED"] },
    },
    orderBy: [
      { lastHealthCheck: "asc" },
      { createdAt: "asc" },
    ],
    take: limit,
    select: { id: true },
  });
  const results: Array<unknown> = [];
  await runWithConcurrency(deployments, concurrency, async (deployment) => {
    results.push(await refreshControlPlaneFleetSnapshots(controlPlaneWorkerActor, {
      deploymentId: deployment.id,
      snapshotKinds,
      reason,
    }));
  });

  return {
    queuedDeployments: deployments.length,
    snapshotKinds,
    results,
  };
}

export async function runCustomerSupportOperation(actor: AppActor, params: {
  deploymentId: string;
  action: SupportAction;
  scopeOverride?: string | null;
  reason?: string | null;
  arguments?: JsonRecord;
  remoteWorkspaceId?: string | null;
  idempotencyKey?: string | null;
}) {
  requireControlPlaneScope(actor, params.scopeOverride ?? (MUTATING_SUPPORT_ACTIONS.has(params.action) ? "control-plane:support:write" : CONTROL_PLANE_READ_SCOPE));
  await requireControlPlaneAccess(actor, { deploymentId: params.deploymentId });
  const toolName = SUPPORT_ACTION_TO_MCP_TOOL[params.action];
  invariant(toolName, 400, "INVALID_INPUT", "Unsupported support action.");
  const reason = normalizeReason(params.reason, params.action);
  const providedArgs = params.arguments ?? {};
  const args = params.action === "proposals.reopen_resolved" && typeof providedArgs.reason !== "string"
    ? { ...providedArgs, reason }
    : providedArgs;
  const inputSummary = redactObject(args);

  const operation = await prisma.supportOperation.create({
    data: {
      deploymentId: params.deploymentId,
      workspaceId: params.remoteWorkspaceId?.trim() || null,
      actorUserId: actorUserId(actor),
      actorLabel: SUPPORT_ACTOR_LABEL,
      action: params.action,
      reason,
      status: "RUNNING",
      startedAt: new Date(),
      inputSummary: inputSummary as Prisma.InputJsonObject,
      idempotencyKey: params.idempotencyKey?.trim() || null,
    },
  });

  const connector = await loadSupportConnector(params.deploymentId);

  try {
    if (MUTATING_SUPPORT_ACTIONS.has(params.action)) {
      await recordRemoteSupportAudit({
        mcpUrl: connector.mcpUrl,
        bearerToken: connector.bearerToken,
        action: params.action,
        reason,
        operationId: operation.id,
        phase: "started",
      });
    }

    const result = await callMcpTool({
      mcpUrl: connector.mcpUrl,
      bearerToken: connector.bearerToken,
      toolName,
      arguments: args,
    });
    const summarized = summarizeMcpResponse(result);
    const remoteError = supportMcpErrorMessage(summarized);
    if (remoteError) {
      throw new AppError(502, "REMOTE_SUPPORT_OPERATION_FAILED", remoteError);
    }
    const resultSummary = summarized && typeof summarized === "object"
      ? redactObject(summarized as JsonRecord)
      : { result: summarized };

    if (MUTATING_SUPPORT_ACTIONS.has(params.action)) {
      await recordRemoteSupportAudit({
        mcpUrl: connector.mcpUrl,
        bearerToken: connector.bearerToken,
        action: params.action,
        reason,
        operationId: operation.id,
        phase: "completed",
        result: resultSummary,
      });
    }

    return prisma.supportOperation.update({
      where: { id: operation.id },
      data: {
        status: "COMPLETED",
        completedAt: new Date(),
        resultSummary: resultSummary as Prisma.InputJsonObject,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Support operation failed.";
    if (MUTATING_SUPPORT_ACTIONS.has(params.action)) {
      await recordRemoteSupportAudit({
        mcpUrl: connector.mcpUrl,
        bearerToken: connector.bearerToken,
        action: params.action,
        reason,
        operationId: operation.id,
        phase: "failed",
        error: message,
      }).catch(() => {});
    }

    await prisma.supportOperation.update({
      where: { id: operation.id },
      data: {
        status: "FAILED",
        completedAt: new Date(),
        error: message,
      },
    });
    throw error;
  }
}

export async function recordBreakGlassSupportNote(actor: AppActor, params: {
  deploymentId: string;
  reason: string;
  notes: string;
}) {
  requireControlPlaneScope(actor, "control-plane:support:write");
  await requireControlPlaneAccess(actor, { deploymentId: params.deploymentId });
  const reason = normalizeReason(params.reason, "support.break_glass_note");
  const notes = params.notes.trim();
  invariant(notes.length > 0, 400, "INVALID_INPUT", "Break-glass notes are required.");

  return prisma.supportOperation.create({
    data: {
      deploymentId: params.deploymentId,
      actorUserId: actorUserId(actor),
      actorLabel: SUPPORT_ACTOR_LABEL,
      action: "support.break_glass_note",
      reason,
      status: "COMPLETED",
      startedAt: new Date(),
      completedAt: new Date(),
      inputSummary: { notes: notes.slice(0, 2000) },
      resultSummary: { recorded: true },
    },
  });
}

export async function resolveControlPlaneAgentFromBearer(token: string): Promise<AppActor | null> {
  if (!token.startsWith("cp-")) {
    return null;
  }
  const provided = token.slice("cp-".length).trim();
  if (!env.CONTROL_PLANE_AGENT_API_KEY || provided !== env.CONTROL_PLANE_AGENT_API_KEY) {
    return null;
  }
  return {
    kind: "agent",
    authProvider: "control-plane",
    label: "control-plane-agent",
    workspaceIds: [],
    scopes: parseControlPlaneScopes(env.CONTROL_PLANE_AGENT_SCOPES),
  };
}
