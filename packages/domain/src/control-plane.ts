import type { CustomerDeploymentAccessRole, CustomerDeploymentCloudProvider, CustomerDeploymentKind, CustomerDeploymentStatus, FleetSnapshotKind, MeetingRecorderProvider, MemberRole, ModuleAccessLevel as PrismaModuleAccessLevel, ModuleGrantPrincipalType as PrismaModuleGrantPrincipalType, Prisma } from "@prisma/client";
import { decryptSecret, encryptSecret, env, prisma, toInputJson } from "@corgtex/shared";
import type { AgentActor, AppActor } from "@corgtex/shared";
import { AppError, invariant } from "./errors";
import { isGlobalOperator } from "./auth";
import { createMember, deactivateMember, listMembersEnriched, resendMemberAccessLink, sendMemberSetupEmail, updateMember } from "./members";
import {
  enqueueRecorderCalendarSync,
  getMeetingRecorderCoverageReadiness,
  getMeetingRecorderEnterpriseReadiness,
  getMeetingRecorderMonthlyUsage,
  getRecorderCalendarSource,
  MEETING_RECORDERS_FEATURE_FLAG,
  runMeetingRecorderSmoke,
  scanRecorderCalendarSource,
  upsertRecorderCalendarSource,
} from "./meeting-recorders";
import {
  enqueueWorkspaceMeetingAgendaPreparation,
  getMeetingAgendaReadiness,
} from "./meeting-facilitation";
import { normalizeMeetingUrl, normalizeRecorderMeetingUrl } from "./meeting-urls";
import {
  getSlackExpectedTeamIdForWorkspace,
  saveSlackInstallationForWorkspace,
  validateSlackPostTarget,
  type SlackOAuthResponse,
} from "./communication";
import { createControlPlaneAdapter } from "./control-plane-adapters";
import {
  createRailwayClientFromEnv,
  upgradeRailwayCustomerRelease,
  validateRailwayReleaseExecutorAccess,
  type RailwayClient,
} from "./railway-client";
import { buildCustomerDeploymentProviderReadModel, buildCustomerDeploymentReadiness, provisionCustomerDeployment } from "./admin";
import { registerCustomerDeployment } from "./customer-lifecycle";
import { AGENT_REGISTRY } from "./agent-registry";
import { isKnownScope, type AgentScope } from "./agent-auth";
import { getModuleManifests, listModuleFlagKeys, listWorkspaceFeatureFlagDefinitions } from "./modules";
import type { FeatureFlagDefinition, WorkspaceFeatureFlagKey } from "./modules";
import {
  getMissingPostDeployReadProbeScopes,
  getRequiredScopesForPostDeployReadProbe,
  getRequiredScopesForPostDeployReadProbes,
  POST_DEPLOY_CUSTOMER_READ_PROBES,
} from "./post-deploy-probe-contract";

const SUPPORT_ACTOR_LABEL = "Corgtex Support";
const DEFAULT_RECORDER_BOT_NAME = "Corgtex Recorder";
const DEFAULT_RECORDER_ENTRY_MESSAGE = "Corgtex is joining to record, transcribe, and summarize this meeting for the workspace.";
const DEFAULT_RECORDER_MONTHLY_MINUTE_CAP = 6_000;
const MEETING_RECORDER_PROVIDERS = new Set(["RECALL_AI", "MEETING_BAAS"]);
const CONTROL_PLANE_CONTEXT_OPERATIONS = new Set(["sync_all", "sync_source", "disable_source"]);
const CONTROL_PLANE_RELEASE_OPERATIONS = new Set(["prepare_upgrade"]);
const CONTROL_PLANE_MEETING_RECORDER_OPERATIONS = new Set([
  "enqueue_calendar_sync",
  "dry_run_scan",
  "live_smoke",
  "enable_auto_recording_after_smoke",
]);
const CONTROL_PLANE_READ_SCOPE = "control-plane:read";
const CONTROL_PLANE_CLIENTS_WRITE_SCOPE = "control-plane:clients:write";
const CONTROL_PLANE_MIGRATIONS_WRITE_SCOPE = "control-plane:migrations:write";
const CONTROL_PLANE_AI_GOVERNANCE_WRITE_SCOPE = "control-plane:ai-governance:write";
const CONTROL_PLANE_CLIENT_CREATE_ENABLED_ENV = "CONTROL_PLANE_CLIENT_CREATE_ENABLED";
const CONTROL_PLANE_HOSTED_CREATE_ENABLED_ENV = "CONTROL_PLANE_HOSTED_CREATE_ENABLED";
const CONTROL_PLANE_MIGRATION_DRY_RUN_ENABLED_ENV = "CONTROL_PLANE_MIGRATION_DRY_RUN_ENABLED";
const CONTROL_PLANE_MIGRATION_EXECUTE_ENABLED_ENV = "CONTROL_PLANE_MIGRATION_EXECUTE_ENABLED";
const CONTROL_PLANE_MIGRATION_READ_ONLY_ENFORCED_ENV = "CONTROL_PLANE_MIGRATION_READ_ONLY_ENFORCED";
const CONTROL_PLANE_DEPLOYMENT_WRITE_ROLES = new Set<CustomerDeploymentAccessRole>(["SUPPORT_ADMIN", "CUSTOMER_IT_ADMIN"]);
export const CONTROL_PLANE_FLEET_SNAPSHOT_JOB_TYPE = "control-plane.fleet-snapshot";
export const CONTROL_PLANE_RELEASE_DEPLOY_JOB_TYPE = "control-plane.release.deploy-latest";
export const CONTROL_PLANE_CLIENT_MIGRATION_VERIFY_JOB_TYPE = "control-plane.client-migration.verify";
const AGENT_GOVERNANCE_FEATURE_FLAG = "AGENT_GOVERNANCE";
const STALE_CREDENTIAL_DAYS = 90;
const CONTROL_PLANE_DETAIL_SNAPSHOT_LIMIT = 6;
const CONTROL_PLANE_DETAIL_SNAPSHOT_SUMMARY_PREVIEW_BYTES = 4096;
const CONTROL_PLANE_OPERATION_SUMMARY_PREVIEW_BYTES = 2048;
const CONTROL_PLANE_OPERATION_LIST_LIMIT = 30;
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
  "meetings.schedule",
  "meetings.upload",
  "meetings.archive",
  "meeting_series.set_recorder_url",
  "meeting_recorders.connect_calendar",
  "meeting_recorders.enqueue_calendar_sync",
  "meeting_recorders.dry_run_scan",
  "meeting_recorders.live_smoke",
  "meeting_recorders.schedule_meeting",
  "meeting_recorders.cancel",
  "meeting_recorders.set_auto_recording",
  "meeting_recorders.ensure_coverage",
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
  "finance.readiness": "get_finance_readiness",
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
  "newspaper.diagnostics": "get_newspaper_diagnostics",
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
  "meetings.schedule": "create_scheduled_meeting",
  "meetings.upload": "upload_meeting",
  "meetings.archive": "delete_meeting",
  "meeting_recorders.readiness": "get_meeting_recorder_operations_readiness",
  "meeting_series.set_recorder_url": "set_meeting_series_recorder_url",
  "meeting_recorders.connect_calendar": "connect_meeting_recorder_calendar",
  "meeting_recorders.enqueue_calendar_sync": "enqueue_meeting_recorder_calendar_sync",
  "meeting_recorders.dry_run_scan": "dry_run_meeting_recorder_calendar_scan",
  "meeting_recorders.live_smoke": "run_meeting_recorder_live_smoke",
  "meeting_recorders.schedule_meeting": "schedule_meeting_recording",
  "meeting_recorders.cancel": "cancel_meeting_recording",
  "meeting_recorders.set_auto_recording": "set_meeting_recorder_auto_recording",
  "meeting_recorders.ensure_coverage": "ensure_meeting_recorder_coverage",
} as const;

export type SupportAction = keyof typeof SUPPORT_ACTION_TO_MCP_TOOL;

type JsonRecord = Record<string, unknown>;

const RECORDER_CREDIT_FAILURE_PATTERN = /insufficient[_ -]?credit[_ -]?balance|credit[_ -]?balance|insufficient[_ -]?balance/i;
const SUPPORT_AUDIT_ACTION_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,119}$/;
const SUPPORT_AUDIT_OUTCOME_PATTERN = /^[a-z][a-z0-9_-]{0,79}$/;
const SUPPORT_AUDIT_MAX_OBJECT_KEYS = 20;
const SUPPORT_AUDIT_MAX_ARRAY_LENGTH = 20;
const SUPPORT_AUDIT_MAX_DEPTH = 4;
const SUPPORT_AUDIT_MAX_STRING_LENGTH = 500;
const SUPPORT_AUDIT_MAX_REASON_LENGTH = 1000;
const SUPPORT_AUDIT_MAX_TOTAL_VALUES = 500;
const SUPPORT_AUDIT_MAX_IDEMPOTENCY_KEY_LENGTH = 200;
const SUPPORT_AUDIT_SECRET_VALUE_PATTERN = /\b(authorization:\s*bearer|bearer\s+[A-Za-z0-9._~+/=-]{8,}|api[_ -]?key\s*[:=]|secret\s*[:=]|password\s*[:=]|token\s*[:=])/i;
const SUPPORT_AUDIT_RESERVED_ACTIONS = new Set(["record_support_audit", "run_customer_support_operation"]);

/**
 * Derived from the Module Manifest registry (`@corgtex/domain/modules`) - the
 * single source of truth for the workspace feature flag vocabulary. The
 * literal union type is preserved via `WorkspaceFeatureFlagKey`, and a parity
 * test asserts this derived list matches the registry order/labels/defaults.
 */
export const CONTROL_PLANE_WORKSPACE_FEATURE_FLAGS: readonly FeatureFlagDefinition[] =
  listWorkspaceFeatureFlagDefinitions();

export type ControlPlaneWorkspaceFeatureFlag = WorkspaceFeatureFlagKey;

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

export type ControlPlaneRecorderAvailabilityStatus =
  | "available"
  | "not_configured"
  | "disabled"
  | "requires_connector"
  | "unavailable";

export type ControlPlaneRecorderReadinessGateStatus =
  | "pass"
  | "warning"
  | "blocked"
  | "unknown";

export type ControlPlaneRecorderReadinessGateCheck = {
  key: string;
  label: string;
  status: Exclude<ControlPlaneRecorderReadinessGateStatus, "warning" | "unknown">;
  detail: string;
};

export type ControlPlaneRecorderReadinessGate = {
  key:
    | "control_plane"
    | "tenant_config"
    | "vendor"
    | "calendar"
    | "meeting_state"
    | "live_vendor_proof";
  label: string;
  status: ControlPlaneRecorderReadinessGateStatus;
  detail: string;
  checks: ControlPlaneRecorderReadinessGateCheck[];
};

export type ControlPlaneRecorderReadinessGates = {
  controlPlane: ControlPlaneRecorderReadinessGate;
  tenantConfig: ControlPlaneRecorderReadinessGate;
  vendor: ControlPlaneRecorderReadinessGate;
  calendar: ControlPlaneRecorderReadinessGate;
  meetingState: ControlPlaneRecorderReadinessGate;
  liveVendorProof: ControlPlaneRecorderReadinessGate;
};

export type ControlPlaneIssueSource = "health" | "release" | "recorder" | "agents" | "users" | "support";
export type ControlPlaneIssueSeverity = "warning" | "critical";

export type ControlPlaneIssue = {
  id: string;
  source: ControlPlaneIssueSource;
  severity: ControlPlaneIssueSeverity;
  title: string;
  status: string;
  detail: string;
  observedAt: Date | null;
  suggestedAction: string;
  agentPrompt: string;
};

export type ControlPlaneToolSummary = {
  status: "active" | "available" | "empty" | "unavailable";
  detail: string;
  total: number | null;
  toolLinks: number | null;
  agentCredentials: number | null;
  enterpriseApps: number | null;
  communicationIntegrations: number | null;
  enabledToolFlags: number | null;
};

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
  availability: {
    status: ControlPlaneRecorderAvailabilityStatus;
    detail: string;
  };
  observedAt: Date | null;
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
  recorder: Pick<ControlPlaneRecorderMatrixRow, "status" | "availability" | "provider" | "monthlyUsageMinutes" | "failureCount" | "readiness" | "observedAt">;
  agents: {
    status: string;
    detail: string;
    runCount: number | null;
  };
  tools: ControlPlaneToolSummary;
  users: {
    status: string;
    detail: string;
    count: number | null;
  };
  lastCheckedAt: Date | null;
  issues: ControlPlaneIssue[];
};

export type ControlPlaneReleasePreflightCheck = {
  key: string;
  label: string;
  ok: boolean;
  detail: string;
};

export type ControlPlaneReleaseTarget = {
  cloudProvider: CustomerDeploymentCloudProvider;
  releaseImageTag: string;
  releaseVersion: string | null;
  releaseGitSha: string | null;
  webImage: string;
  workerImage: string;
  webRevision: string | null;
  workerRevision: string | null;
  migrationJobStatus: string | null;
  healthStatus: string | null;
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

const CONTROL_PLANE_TOOL_FEATURE_FLAGS = new Set<string>([
  "TOOL_LINKS",
  "BUILD_ARTIFACTS",
  "AGENT_GOVERNANCE",
  "AI_WORKSPACES",
  "OPENWORK_DEFAULT",
  "EXECUTION_PACKETS",
  "MANAGED_ENTERPRISE_SERVICES",
  "CONTEXT_MAP_AI",
  "SLACK_MEETING_ACTION_REVIEW",
]);

const CONTROL_PLANE_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

const controlPlaneDeploymentInclude = {
  managedWorkspace: {
    select: managedWorkspaceSelect,
  },
  fleetSnapshots: {
    orderBy: { createdAt: "desc" },
    take: 6,
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

function compactPolicyKey(key: string) {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isSecretLikeKey(key: string) {
  const normalizedKey = key.toLowerCase();
  const compactKey = compactPolicyKey(key);
  return /token|secret|password|authorization|bearer|connectionstring/.test(normalizedKey)
    || compactKey === "connectionstring"
    || compactKey.includes("apikey")
    || compactKey.includes("privatekey")
    || compactKey.includes("accesskey")
    || compactKey.includes("clientkey")
    || compactKey.includes("signingkey")
    || compactKey.includes("webhookkey")
    || compactKey === "credential"
    || compactKey === "credentials"
    || normalizedKey === "supportcredential"
    || normalizedKey.includes("meetingurl")
    || normalizedKey === "meeting_url"
    || normalizedKey.includes("externalbot")
    || normalizedKey.includes("providerbot")
    || normalizedKey === "botid"
    || normalizedKey === "bot_id"
    || (normalizedKey.includes("credential") && /(enc|hash|secret|token|password|value)$/.test(normalizedKey));
}

function redactValue(key: string, value: unknown): unknown {
  if (isSecretLikeKey(key)) {
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

function isPrismaUniqueConstraintError(error: unknown) {
  return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === "P2002");
}

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (value && typeof value === "object") {
    const record = value as JsonRecord;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, stableJsonValue(record[key])]),
    );
  }
  return value;
}

function stableJson(value: unknown) {
  return JSON.stringify(stableJsonValue(value ?? null));
}

function normalizeSupportAuditIdempotencyKey(value: string | null | undefined) {
  const normalized = value?.trim() || null;
  invariant(!normalized || normalized.length <= SUPPORT_AUDIT_MAX_IDEMPOTENCY_KEY_LENGTH, 400, "INVALID_INPUT", `Support audit idempotency key must be ${SUPPORT_AUDIT_MAX_IDEMPOTENCY_KEY_LENGTH} characters or fewer.`);
  invariant(!normalized || !SUPPORT_AUDIT_SECRET_VALUE_PATTERN.test(normalized), 400, "INVALID_INPUT", "Support audit idempotency key must not contain credentials, secrets, tokens, passwords, or bearer authorization values.");
  return normalized;
}

function normalizeSupportAuditAction(action: string | null | undefined) {
  const normalized = action?.trim();
  invariant(normalized, 400, "INVALID_INPUT", "Support audit action is required.");
  invariant(SUPPORT_AUDIT_ACTION_PATTERN.test(normalized), 400, "INVALID_INPUT", "Support audit action must be lowercase and use only letters, numbers, dots, underscores, hyphens, or colons.");
  invariant(!SUPPORT_AUDIT_RESERVED_ACTIONS.has(normalized), 400, "INVALID_INPUT", "Support audit action must describe the customer support event, not an MCP tool name.");
  return normalized;
}

function normalizeSupportAuditOutcome(outcome: string | null | undefined) {
  const normalized = outcome?.trim() || "completed";
  invariant(SUPPORT_AUDIT_OUTCOME_PATTERN.test(normalized), 400, "INVALID_INPUT", "Support audit outcome must be lowercase and use only letters, numbers, underscores, or hyphens.");
  return normalized;
}

function normalizeSupportAuditSummary(summary: string | null | undefined) {
  const normalized = summary?.trim();
  invariant(normalized, 400, "INVALID_INPUT", "Support audit summary is required.");
  invariant(normalized.length <= 1000, 400, "INVALID_INPUT", "Support audit summary must be 1000 characters or fewer.");
  invariant(!SUPPORT_AUDIT_SECRET_VALUE_PATTERN.test(normalized), 400, "INVALID_INPUT", "Support audit summary must not contain credentials, secrets, tokens, passwords, or bearer authorization values.");
  return normalized;
}

function assertSupportAuditEvidenceKey(key: string) {
  invariant(/^[A-Za-z0-9_.:-]{1,80}$/.test(key), 400, "INVALID_INPUT", "Support audit evidence keys must be 1-80 characters and use letters, numbers, dots, underscores, hyphens, or colons.");
  const compactKey = compactPolicyKey(key);
  invariant(!compactKey.includes("transcript") && !compactKey.includes("customerdata") && !/raw(logs?|payloads?|body|content)/.test(compactKey), 400, "INVALID_INPUT", "Support audit evidence must be summarized, not raw logs, raw payloads, transcripts, or customer data.");
}

function sanitizeSupportAuditEvidenceValue(value: unknown, path: string, depth: number, budget: { values: number }): unknown {
  budget.values += 1;
  invariant(budget.values <= SUPPORT_AUDIT_MAX_TOTAL_VALUES, 400, "INVALID_INPUT", "Support audit evidence is too large.");
  invariant(depth <= SUPPORT_AUDIT_MAX_DEPTH, 400, "INVALID_INPUT", "Support audit evidence is too deeply nested.");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    invariant(Number.isFinite(value), 400, "INVALID_INPUT", `Support audit evidence ${path} must be a finite number.`);
    return value;
  }
  if (typeof value === "string") {
    invariant(value.length <= SUPPORT_AUDIT_MAX_STRING_LENGTH, 400, "INVALID_INPUT", `Support audit evidence ${path} must be ${SUPPORT_AUDIT_MAX_STRING_LENGTH} characters or fewer.`);
    invariant(!SUPPORT_AUDIT_SECRET_VALUE_PATTERN.test(value), 400, "INVALID_INPUT", "Support audit evidence strings must not contain credentials, secrets, tokens, passwords, or bearer authorization values.");
    return value;
  }
  if (Array.isArray(value)) {
    invariant(value.length <= SUPPORT_AUDIT_MAX_ARRAY_LENGTH, 400, "INVALID_INPUT", "Support audit evidence arrays must contain 20 items or fewer.");
    return value.map((item, index) => sanitizeSupportAuditEvidenceValue(item, `${path}[${index}]`, depth + 1, budget));
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as JsonRecord);
    invariant(entries.length <= SUPPORT_AUDIT_MAX_OBJECT_KEYS, 400, "INVALID_INPUT", "Support audit evidence objects must contain 20 keys or fewer.");
    return Object.fromEntries(entries.map(([key, entry]) => {
      assertSupportAuditEvidenceKey(key);
      if (isSecretLikeKey(key) || compactPolicyKey(key).includes("credential")) {
        return [key, "[redacted]"];
      }
      return [key, sanitizeSupportAuditEvidenceValue(entry, `${path}.${key}`, depth + 1, budget)];
    }));
  }
  throw new AppError(400, "INVALID_INPUT", `Unsupported support audit evidence value at ${path}.`);
}

function sanitizeSupportAuditEvidence(value: unknown) {
  if (value === undefined || value === null) return {};
  invariant(value && typeof value === "object" && !Array.isArray(value), 400, "INVALID_INPUT", "Support audit evidence must be an object.");
  return sanitizeSupportAuditEvidenceValue(value, "evidence", 0, { values: 0 }) as JsonRecord;
}

function normalizeSupportAuditInput(params: {
  action?: string | null;
  outcome?: string | null;
  summary?: string | null;
  evidence?: unknown;
}) {
  return {
    schemaVersion: 1,
    action: normalizeSupportAuditAction(params.action),
    outcome: normalizeSupportAuditOutcome(params.outcome),
    summary: normalizeSupportAuditSummary(params.summary),
    evidence: sanitizeSupportAuditEvidence(params.evidence),
  };
}

function normalizeReason(reason: string | null | undefined, action: string) {
  const trimmed = reason?.trim();
  if (trimmed) return trimmed;
  invariant(!MUTATING_SUPPORT_ACTIONS.has(action), 400, "SUPPORT_REASON_REQUIRED", "A support reason is required for mutating support actions.");
  return "Read-only support inspection.";
}

function sanitizeSupportReadinessDetail(value: string) {
  return value.replace(/https?:\/\/\S+/g, "[url]").slice(0, 500);
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

function booleanFilter(value: string | boolean | null | undefined) {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
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

const CONTROL_PLANE_REMOTE_MCP_TIMEOUT_MS = 10_000;
const CONTROL_PLANE_HEALTH_PROBE_TIMEOUT_MS = 8_000;

function isFetchAbortError(error: unknown) {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

async function fetchWithControlPlaneTimeout(
  input: string,
  init: RequestInit,
  timeoutMs: number,
  timeoutCode: string,
  timeoutMessage: string,
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (isFetchAbortError(error)) {
      throw new AppError(504, timeoutCode, timeoutMessage);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

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
  return /MCP credential is missing the required scope|Missing required permission|Control Plane scope required|Workspace membership required|FORBIDDEN|INVALID_SIGNATURE/i.test(text)
    ? text
    : null;
}

function mcpToolMarkedErrorMessage(value: unknown) {
  const record = jsonRecord(value);
  if (record?.isError !== true) return null;
  const content = Array.isArray(record.content) ? record.content : [];
  const text = content
    .map((item) => jsonRecord(item)?.text)
    .find((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
  return sanitizeSupportAuditFailureMessage(text ?? "Remote MCP tool returned an error.");
}

function sanitizeSupportAuditFailureMessage(value: string | null | undefined) {
  const diagnostic = sanitizeDiagnosticText(value).slice(0, 1000);
  const compact = compactPolicyKey(diagnostic);
  if (SUPPORT_AUDIT_SECRET_VALUE_PATTERN.test(diagnostic) || compact.includes("transcript") || compact.includes("customerdata") || /raw(logs?|payloads?|body|content)/.test(compact)) {
    return "Remote support audit failed with redacted detail.";
  }
  return diagnostic;
}

function requireRemoteSupportAuditAcknowledgement(params: {
  raw: unknown;
  summarized: unknown;
  operationId: string;
}): { id: string; operationId: string } {
  const markedError = mcpToolMarkedErrorMessage(params.raw);
  if (markedError) {
    throw new AppError(502, "REMOTE_SUPPORT_OPERATION_FAILED", markedError);
  }
  const remoteError = supportMcpErrorMessage(params.summarized);
  if (remoteError) {
    throw new AppError(502, "REMOTE_SUPPORT_OPERATION_FAILED", remoteError);
  }
  const acknowledgement = jsonRecord(params.summarized);
  invariant(
    acknowledgement
      && typeof acknowledgement.id === "string"
      && acknowledgement.id.trim().length > 0
      && acknowledgement.operationId === params.operationId,
    502,
    "REMOTE_SUPPORT_OPERATION_FAILED",
    "Remote support audit did not return a valid audit acknowledgement.",
  );
  return {
    id: acknowledgement.id.trim(),
    operationId: params.operationId,
  };
}

async function callMcpTool(params: {
  mcpUrl: string;
  bearerToken: string;
  toolName: string;
  arguments: JsonRecord;
}) {
  const response = await fetchWithControlPlaneTimeout(
    params.mcpUrl,
    {
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
    },
    CONTROL_PLANE_REMOTE_MCP_TIMEOUT_MS,
    "REMOTE_SUPPORT_TIMEOUT",
    "Remote support connector timed out. Retry after the connector is healthy.",
  );

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
      remoteWorkspaceId: true,
      managedWorkspaceId: true,
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

type ControlPlaneClientMode = "shared_workspace" | "hosted_dedicated";
type ClientMigrationDirection = "shared_to_hosted" | "hosted_to_shared";

type ClientInitialAdmin = {
  email: string;
  displayName?: string | null;
};

function controlPlaneCapabilityEnabled(envName: string, options: { defaultEnabledOutsideProduction?: boolean } = {}) {
  const raw = process.env[envName]?.trim().toLowerCase();
  if (raw) {
    return ["1", "true", "yes", "on"].includes(raw);
  }
  return options.defaultEnabledOutsideProduction === true && process.env.NODE_ENV !== "production";
}

function assertControlPlaneCapabilityEnabled(envName: string, code: string, message: string, options: { defaultEnabledOutsideProduction?: boolean } = {}) {
  invariant(controlPlaneCapabilityEnabled(envName, options), 403, code, message);
}

/**
 * A client feature posture, expressed as **module-key bundles** rather than raw
 * flag overrides. Each entry targets a module by key:
 *   - a `boolean` toggles every flag the module owns (primary + sub-flags),
 *     resolved from the Module Manifest registry (`listModuleFlagKeys`);
 *   - an object sets only specific flags the module owns (escape hatch for
 *     postures that want a subset of a module's sub-flags).
 * Flags not mentioned fall back to the manifest default. This keeps postures
 * expressed in product terms (modules) while staying byte-for-byte equivalent
 * to the previous flag-level overrides (proven by the posture parity test).
 */
type ModulePostureBundle = Record<
  string,
  boolean | Partial<Record<ControlPlaneWorkspaceFeatureFlag, boolean>>
>;

const CLIENT_FEATURE_POSTURES = {
  standard: {},
  minimal: {
    tools: false,
    built: false,
    "context-maps": false,
    meetings: false,
    "ai-workspaces": false,
    "execution-packets": false,
  },
  enterprise: {
    "agent-governance": true,
    settings: true,
    meetings: { MEETING_TRANSCRIPT_SOURCES: true, MEETING_RECORDERS: true, MEETING_CONTEXTUAL_INTELLIGENCE: true },
    "ai-workspaces": { AI_WORKSPACES: true, MANAGED_ENTERPRISE_SERVICES: true },
    "execution-packets": true,
  },
  consulting: {},
} satisfies Record<string, ModulePostureBundle>;

const migrationRunModel = () => (prisma as typeof prisma & {
  clientMigrationRun: {
    create(args: unknown): Promise<unknown>;
    findUnique(args: unknown): Promise<unknown>;
    update(args: unknown): Promise<unknown>;
  };
}).clientMigrationRun;

const migrationIdMapModel = () => (prisma as typeof prisma & {
  clientMigrationIdMap: {
    upsert(args: unknown): Promise<unknown>;
  };
}).clientMigrationIdMap;

function normalizeClientMode(value: string | null | undefined): ControlPlaneClientMode {
  const normalized = value?.trim().toLowerCase();
  invariant(normalized === "shared_workspace" || normalized === "hosted_dedicated", 400, "INVALID_INPUT", "Client mode must be shared_workspace or hosted_dedicated.");
  return normalized;
}

function normalizeClientSlug(value: string | null | undefined) {
  const slug = value?.trim().toLowerCase() ?? "";
  invariant(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(slug), 400, "INVALID_INPUT", "Customer slug must be a DNS-safe slug.");
  return slug;
}

function normalizeRequiredText(value: string | null | undefined, label: string) {
  const trimmed = value?.trim();
  invariant(trimmed, 400, "INVALID_INPUT", `${label} is required.`);
  return trimmed;
}

function normalizeOptionalControlPlaneText(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function actorLabel(actor: AppActor) {
  if (actor.kind === "user") return actor.user.email;
  return actor.label;
}

function customerWorkspaceUrl(workspaceId: string) {
  const baseUrl = env.APP_URL?.replace(/\/$/, "") || "https://selfserve.corgtex.com";
  return `${baseUrl}/workspaces/${workspaceId}`;
}

function normalizeInitialAdmins(value: unknown): ClientInitialAdmin[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    invariant(item && typeof item === "object", 400, "INVALID_INPUT", "initialAdmins must contain objects.");
    const record = item as Record<string, unknown>;
    const email = normalizeRequiredText(typeof record.email === "string" ? record.email : null, "Admin email").toLowerCase();
    return {
      email,
      displayName: typeof record.displayName === "string" ? normalizeOptionalControlPlaneText(record.displayName) : null,
    };
  });
}

function assertNoRuntimeVariables(variables: Record<string, string> | null | undefined) {
  invariant(
    Object.keys(variables ?? {}).length === 0,
    400,
    "RAW_RUNTIME_VARIABLES_REJECTED",
    "Runtime variables must come from approved secret sources, not the control-plane create_client tool.",
  );
}

function featurePostureName(value: string | null | undefined) {
  const normalized = value?.trim().toLowerCase() || "standard";
  invariant(normalized in CLIENT_FEATURE_POSTURES, 400, "INVALID_INPUT", "Unsupported feature posture.");
  return normalized as keyof typeof CLIENT_FEATURE_POSTURES;
}

/** Expand a module-key posture bundle into concrete flag overrides. */
function expandPostureBundle(bundle: ModulePostureBundle): Partial<Record<ControlPlaneWorkspaceFeatureFlag, boolean>> {
  const overrides: Partial<Record<ControlPlaneWorkspaceFeatureFlag, boolean>> = {};
  for (const [moduleKey, value] of Object.entries(bundle)) {
    if (typeof value === "boolean") {
      const flagKeys = listModuleFlagKeys(moduleKey);
      invariant(flagKeys.length > 0, 500, "INVALID_POSTURE", `Posture references module "${moduleKey}" which owns no feature flags.`);
      for (const flagKey of flagKeys) {
        overrides[flagKey as ControlPlaneWorkspaceFeatureFlag] = value;
      }
    } else {
      for (const [flagKey, enabled] of Object.entries(value)) {
        overrides[flagKey as ControlPlaneWorkspaceFeatureFlag] = enabled as boolean;
      }
    }
  }
  return overrides;
}

export function featurePostureFlags(posture: keyof typeof CLIENT_FEATURE_POSTURES) {
  const overrides = expandPostureBundle(CLIENT_FEATURE_POSTURES[posture]);
  return CONTROL_PLANE_WORKSPACE_FEATURE_FLAGS.map((definition) => ({
    flag: definition.flag,
    enabled: overrides[definition.flag as ControlPlaneWorkspaceFeatureFlag] ?? definition.defaultEnabled,
  }));
}

/** Posture names supported by `featurePostureFlags`, for validation and tests. */
export const CLIENT_FEATURE_POSTURE_NAMES = Object.keys(CLIENT_FEATURE_POSTURES) as Array<keyof typeof CLIENT_FEATURE_POSTURES>;

function hasCompleteBootstrapBundle(params: {
  bootstrapBundleUri?: string | null;
  bootstrapBundleChecksum?: string | null;
  bootstrapBundleSchemaVersion?: string | null;
}) {
  return Boolean(params.bootstrapBundleUri && params.bootstrapBundleChecksum && params.bootstrapBundleSchemaVersion);
}

async function applyFeaturePosture(params: {
  actor: AppActor;
  deploymentId: string;
  workspaceId: string;
  posture: keyof typeof CLIENT_FEATURE_POSTURES;
  reason: string;
}) {
  const flags = featurePostureFlags(params.posture);
  await Promise.all(flags.map((entry) => prisma.workspaceFeatureFlag.upsert({
    where: {
      workspaceId_flag: {
        workspaceId: params.workspaceId,
        flag: entry.flag,
      },
    },
    update: {
      enabled: entry.enabled,
    },
    create: {
      workspaceId: params.workspaceId,
      flag: entry.flag,
      enabled: entry.enabled,
    },
  })));
  await recordCustomerDeploymentEvent(params.actor, params.deploymentId, "control_plane.client.feature_posture_applied", {
    reason: params.reason,
    featurePosture: params.posture,
    flags: flags.map((entry) => ({ flag: entry.flag, enabled: entry.enabled })),
  });
  return flags;
}

async function createSharedClientWorkspace(params: {
  label: string;
  slug: string;
  description?: string | null;
}) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.workspace.findUnique({ where: { slug: params.slug } });
    invariant(!existing, 409, "CONFLICT", "A workspace with this slug already exists.");

    const workspace = await tx.workspace.create({
      data: {
        name: params.label,
        slug: params.slug,
        description: params.description ?? null,
      },
    });

    await tx.approvalPolicy.createMany({
      data: [
        {
          workspaceId: workspace.id,
          subjectType: "PROPOSAL",
          mode: "CONSENT",
          quorumPercent: 0,
          minApproverCount: 1,
          decisionWindowHours: 72,
        },
      ],
    });

    return workspace;
  });
}

function sharedClientReadiness(params: { initialAdmins: number; supportOwnerEmail?: string | null }) {
  const checks = [
    {
      key: "workspace",
      label: "Shared workspace",
      status: "ok" as const,
      detail: "Workspace registered in the main Corgtex app.",
    },
    {
      key: "initial_admins",
      label: "Initial admins",
      status: params.initialAdmins > 0 ? "ok" as const : "warning" as const,
      detail: params.initialAdmins > 0 ? `${params.initialAdmins} admin member(s) created.` : "No initial admins were provided.",
    },
    {
      key: "support_owner",
      label: "Support owner",
      status: params.supportOwnerEmail ? "ok" as const : "warning" as const,
      detail: params.supportOwnerEmail ? "Support owner recorded." : "No support owner recorded.",
    },
  ];
  return {
    status: checks.some((check) => check.status !== "ok") ? "attention" as const : "ready" as const,
    checks,
  };
}

function sanitizeDeploymentForControlPlane(deployment: Record<string, unknown>) {
  return {
    ...deployment,
    supportCredentialEnc: undefined,
    hasSupportCredential: Boolean(deployment.supportCredentialEnc),
  };
}

function truncateUtf8Preview(value: string, maxBytes: number) {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) {
    return value;
  }
  return Buffer.from(value, "utf8").subarray(0, maxBytes).toString("utf8").replace(/\uFFFD$/, "");
}

function compactControlPlaneJsonPreview(value: unknown, maxBytes: number) {
  if (value == null) {
    return null;
  }
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  const originalBytes = Buffer.byteLength(serialized, "utf8");
  if (originalBytes <= maxBytes) {
    return value;
  }
  return {
    truncated: true,
    originalBytes,
    preview: truncateUtf8Preview(serialized, maxBytes),
  };
}

function compactControlPlaneFleetSnapshots(snapshots: Array<Record<string, unknown>> | undefined) {
  const byKind = new Map<string, Record<string, unknown>>();
  for (const snapshot of snapshots ?? []) {
    const kind = typeof snapshot.snapshotKind === "string" ? snapshot.snapshotKind : String(snapshot.snapshotKind ?? "");
    if (!kind || byKind.has(kind)) {
      continue;
    }
    byKind.set(kind, {
      ...snapshot,
      summary: compactControlPlaneJsonPreview(snapshot.summary, CONTROL_PLANE_DETAIL_SNAPSHOT_SUMMARY_PREVIEW_BYTES),
    });
    if (byKind.size >= CONTROL_PLANE_DETAIL_SNAPSHOT_LIMIT) {
      break;
    }
  }
  return Array.from(byKind.values());
}

function compactControlPlaneSupportOperation<T extends Record<string, unknown>>(operation: T) {
  return {
    ...operation,
    inputSummary: compactControlPlaneJsonPreview(operation.inputSummary, CONTROL_PLANE_OPERATION_SUMMARY_PREVIEW_BYTES),
    resultSummary: compactControlPlaneJsonPreview(operation.resultSummary, CONTROL_PLANE_OPERATION_SUMMARY_PREVIEW_BYTES),
  };
}

export async function createControlPlaneClient(actor: AppActor, params: {
  mode?: string | null;
  clientMode?: string | null;
  label: string;
  customerSlug: string;
  reason?: string | null;
  supportOwnerEmail?: string | null;
  description?: string | null;
  featurePosture?: string | null;
  initialAdmins?: unknown;
  region?: string | null;
  dataResidency?: string | null;
  customDomain?: string | null;
  releaseVersion?: string | null;
  releaseImageTag?: string | null;
  webImage?: string | null;
  workerImage?: string | null;
  webSource?: Parameters<typeof provisionCustomerDeployment>[1]["webSource"];
  workerSource?: Parameters<typeof provisionCustomerDeployment>[1]["workerSource"];
  storageBucketName?: string | null;
  bootstrapBundleUri?: string | null;
  bootstrapBundleChecksum?: string | null;
  bootstrapBundleSchemaVersion?: string | null;
  primary?: boolean | null;
  variables?: Record<string, string>;
}, railwayClient?: RailwayClient) {
  await requireControlPlaneAccess(actor);
  requireControlPlaneScope(actor, CONTROL_PLANE_CLIENTS_WRITE_SCOPE);
  const reason = requireMutationReason(params.reason);
  const mode = normalizeClientMode(params.mode ?? params.clientMode);
  assertControlPlaneCapabilityEnabled(
    CONTROL_PLANE_CLIENT_CREATE_ENABLED_ENV,
    "CONTROL_PLANE_CLIENT_CREATE_DISABLED",
    "Control-plane client creation is disabled for this environment.",
    { defaultEnabledOutsideProduction: true },
  );
  if (mode === "hosted_dedicated") {
    assertControlPlaneCapabilityEnabled(
      CONTROL_PLANE_HOSTED_CREATE_ENABLED_ENV,
      "CONTROL_PLANE_HOSTED_CREATE_DISABLED",
      "Hosted dedicated client creation is disabled for this environment.",
      { defaultEnabledOutsideProduction: true },
    );
  }
  const label = normalizeRequiredText(params.label, "Client label");
  const customerSlug = normalizeClientSlug(params.customerSlug);
  const supportOwnerEmail = normalizeOptionalControlPlaneText(params.supportOwnerEmail);
  const featurePosture = featurePostureName(params.featurePosture);

  if (mode === "shared_workspace") {
    const initialAdmins = normalizeInitialAdmins(params.initialAdmins);
    const workspace = await createSharedClientWorkspace({
      label,
      slug: customerSlug,
      description: normalizeOptionalControlPlaneText(params.description),
    });
    const { account, deployment } = await registerCustomerDeployment({
      accountSlug: customerSlug,
      accountDisplayName: label,
      accountStatus: "ACTIVE",
      managementAuthority: "CORGTEX",
      label,
      url: customerWorkspaceUrl(workspace.id),
      environment: "production",
      notes: normalizeOptionalControlPlaneText(params.description),
      deploymentKind: "SHARED_WORKSPACE",
      deploymentStatus: "ACTIVE",
      customerSlug,
      supportOwnerEmail,
      managedWorkspaceId: workspace.id,
      provisioningStatus: "active",
      bootstrapStatus: "not_started",
      primary: params.primary === true,
    });
    const admins = [];
    for (const admin of initialAdmins) {
      admins.push(await createMember(actor, {
        workspaceId: workspace.id,
        email: admin.email,
        displayName: admin.displayName,
        role: "ADMIN",
        skipAdminCheck: true,
      }));
    }
    const appliedFeatureFlags = await applyFeaturePosture({
      actor,
      deploymentId: deployment.id,
      workspaceId: workspace.id,
      posture: featurePosture,
      reason,
    });
    await recordCustomerDeploymentEvent(actor, deployment.id, "control_plane.client.created", {
      reason,
      mode,
      featurePosture,
      initialAdminCount: admins.length,
      supportOwnerEmail,
    });
    return {
      clientMode: "shared_workspace" as const,
      customerAccount: customerAccountSummary(account),
      deployment: sanitizeDeploymentForControlPlane(deployment as unknown as Record<string, unknown>),
      workspace,
      readiness: sharedClientReadiness({ initialAdmins: admins.length, supportOwnerEmail }),
      featurePosture,
      appliedFeatureFlags,
      initialAdmins: admins.map((admin) => ({
        memberId: admin.member.id,
        userId: admin.user.id,
        email: admin.user.email,
        displayName: admin.user.displayName,
      })),
    };
  }

  assertNoRuntimeVariables(params.variables);
  invariant(
    params.primary !== true,
    400,
    "HOSTED_PRIMARY_UNSUPPORTED",
    "Hosted dedicated client creation starts non-primary; promote it only through verified readiness or migration cutover.",
  );
  const hostedInitialAdmins = normalizeInitialAdmins(params.initialAdmins);
  const bootstrapBundleUri = normalizeOptionalControlPlaneText(params.bootstrapBundleUri);
  const bootstrapBundleChecksum = normalizeOptionalControlPlaneText(params.bootstrapBundleChecksum);
  const bootstrapBundleSchemaVersion = normalizeOptionalControlPlaneText(params.bootstrapBundleSchemaVersion);
  const completeBootstrapBundle = hasCompleteBootstrapBundle({
    bootstrapBundleUri,
    bootstrapBundleChecksum,
    bootstrapBundleSchemaVersion,
  });
  invariant(
    hostedInitialAdmins.length === 0,
    400,
    "HOSTED_INITIAL_ADMINS_UNSUPPORTED",
    "Hosted dedicated initial admins must be encoded in an approved bootstrap bundle; create_client cannot apply them directly yet.",
  );
  invariant(
    featurePosture === "standard",
    400,
    "HOSTED_FEATURE_POSTURE_UNSUPPORTED",
    "Hosted dedicated non-standard feature posture must be encoded in an approved bootstrap bundle; create_client cannot apply it directly yet.",
  );
  const latestTarget = getControlPlaneLatestReleaseTarget();
  const releaseImageTag = normalizeOptionalControlPlaneText(params.releaseImageTag) ?? latestTarget?.releaseImageTag;
  const webImage = normalizeOptionalControlPlaneText(params.webImage) ?? latestTarget?.webImage;
  const workerImage = normalizeOptionalControlPlaneText(params.workerImage) ?? latestTarget?.workerImage;
  invariant(releaseImageTag, 400, "LATEST_RELEASE_NOT_CONFIGURED", "Hosted dedicated creation requires releaseImageTag or a configured latest release target.");
  const deployment = await provisionCustomerDeployment(actor, {
    label,
    customerSlug,
    region: normalizeRequiredText(params.region, "Railway region"),
    dataResidency: normalizeRequiredText(params.dataResidency, "Data residency"),
    customDomain: normalizeOptionalControlPlaneText(params.customDomain),
    supportOwnerEmail,
    releaseVersion: normalizeOptionalControlPlaneText(params.releaseVersion) ?? latestTarget?.releaseVersion ?? null,
    releaseGitSha: latestTarget?.releaseGitSha ?? null,
    releaseImageTag,
    webImage,
    workerImage,
    webSource: params.webSource ?? null,
    workerSource: params.workerSource ?? null,
    storageBucketName: normalizeOptionalControlPlaneText(params.storageBucketName),
    bootstrapBundleUri,
    bootstrapBundleChecksum,
    bootstrapBundleSchemaVersion,
    primary: false,
    variables: {},
  }, railwayClient);
  await recordCustomerDeploymentEvent(actor, deployment.id, "control_plane.client.created", {
    reason,
    mode,
    featurePosture,
    initialAdminCount: hostedInitialAdmins.length,
    supportOwnerEmail,
    hasBootstrapBundle: completeBootstrapBundle,
  });
  return {
    clientMode: "hosted_dedicated" as const,
    deployment: sanitizeDeploymentForControlPlane(deployment as unknown as Record<string, unknown>),
    readiness: buildCustomerDeploymentReadiness(deployment),
    featurePosture,
  };
}

function targetKindFromMode(mode: ControlPlaneClientMode) {
  return mode === "shared_workspace" ? "SHARED_WORKSPACE" : "HOSTED_DEDICATED";
}

function normalizeMigrationDirection(sourceKind: string, targetMode: ControlPlaneClientMode): ClientMigrationDirection {
  const targetKind = targetKindFromMode(targetMode);
  invariant(sourceKind === "SHARED_WORKSPACE" || sourceKind === "HOSTED_DEDICATED", 400, "UNSUPPORTED_MIGRATION_SOURCE", "V1 migrations support only shared workspace and hosted dedicated deployments.");
  invariant(sourceKind !== targetKind, 400, "INVALID_INPUT", "Migration target must be different from the source deployment lane.");
  return sourceKind === "SHARED_WORKSPACE" ? "shared_to_hosted" : "hosted_to_shared";
}

async function loadMigrationSourceDeployment(actor: AppActor, deploymentId: string) {
  await requireControlPlaneAccess(actor, { deploymentId });
  const deployment = await prisma.customerDeployment.findUnique({
    where: { id: deploymentId },
    include: { customerAccount: true },
  });
  invariant(deployment, 404, "NOT_FOUND", "Source deployment not found.");
  invariant(deployment.customerAccountId && deployment.customerAccount, 400, "CUSTOMER_ACCOUNT_REQUIRED", "Source deployment must be linked to a customer account.");
  return deployment;
}

async function assertMigrationDestination(params: {
  destinationDeploymentId?: string | null;
  targetMode: ControlPlaneClientMode;
  sourceDeploymentId: string;
  customerAccountId: string;
}) {
  if (!params.destinationDeploymentId) return null;
  const destination = await prisma.customerDeployment.findUnique({
    where: { id: params.destinationDeploymentId },
    include: { customerAccount: true },
  });
  invariant(destination, 404, "NOT_FOUND", "Destination deployment not found.");
  invariant(destination.id !== params.sourceDeploymentId, 400, "INVALID_INPUT", "Destination deployment must be different from source deployment.");
  invariant(destination.customerAccountId === params.customerAccountId, 400, "MIGRATION_DESTINATION_ACCOUNT_MISMATCH", "Destination deployment must belong to the same customer account as the source.");
  invariant(destination.deploymentKind === targetKindFromMode(params.targetMode), 400, "MIGRATION_DESTINATION_KIND_MISMATCH", "Destination deployment kind does not match migration target.");
  return destination;
}

function migrationPlanSummary(params: {
  source: { id: string; label: string; deploymentKind: string; deploymentStatus: string; managedWorkspaceId?: string | null };
  destinationDeploymentId?: string | null;
  direction: ClientMigrationDirection;
  targetMode: ControlPlaneClientMode;
}) {
  return {
    direction: params.direction,
    targetMode: params.targetMode,
    source: {
      deploymentId: params.source.id,
      label: params.source.label,
      kind: params.source.deploymentKind,
      status: params.source.deploymentStatus,
      managedWorkspaceId: params.source.managedWorkspaceId ?? null,
    },
    destination: {
      deploymentId: params.destinationDeploymentId ?? null,
      requiredKind: targetKindFromMode(params.targetMode),
    },
    phases: [
      "dry_run_inventory",
      "prepare_destination",
      "export_source",
      "import_destination",
      "rebuild_derived_indexes",
      "verify_counts_permissions_audit",
      "cutover_primary_deployment",
      "retain_source_until_finalize",
    ],
  };
}

function migrationExecutionAvailable() {
  return controlPlaneCapabilityEnabled(CONTROL_PLANE_MIGRATION_EXECUTE_ENABLED_ENV);
}

function assertMigrationExecutionAvailable(operation: "execute" | "finalize" | "rollback") {
  invariant(
    migrationExecutionAvailable(),
    501,
    "MIGRATION_EXECUTION_NOT_IMPLEMENTED",
    `Client migration ${operation} requires the dedicated migration worker, import/export verification, and runtime read-only enforcement.`,
  );
}

function assertMigrationRuntimeReadOnlyEnforced() {
  invariant(
    controlPlaneCapabilityEnabled(CONTROL_PLANE_MIGRATION_READ_ONLY_ENFORCED_ENV),
    501,
    "MIGRATION_READ_ONLY_ENFORCEMENT_REQUIRED",
    "Client migration execution requires runtime read-only enforcement for the retained source deployment.",
  );
}

function assertMigrationDestinationReadyForCutover(destination: {
  deploymentKind?: string | null;
  deploymentStatus?: string | null;
  lastHealthStatus?: string | null;
}) {
  invariant(destination.deploymentStatus === "ACTIVE", 400, "MIGRATION_DESTINATION_NOT_READY", "Destination deployment must be ACTIVE before migration cutover.");
  if (destination.deploymentKind === "HOSTED_DEDICATED") {
    invariant(destination.lastHealthStatus === "ok", 400, "MIGRATION_DESTINATION_HEALTH_REQUIRED", "Hosted destination health must be ok before migration cutover.");
  }
}

async function createClientMigrationRun(actor: AppActor, params: {
  sourceDeploymentId: string;
  targetMode: ControlPlaneClientMode;
  destinationDeploymentId?: string | null;
  reason: string;
}) {
  const source = await loadMigrationSourceDeployment(actor, params.sourceDeploymentId);
  await assertMigrationDestination({
    destinationDeploymentId: params.destinationDeploymentId,
    targetMode: params.targetMode,
    sourceDeploymentId: params.sourceDeploymentId,
    customerAccountId: source.customerAccountId!,
  });
  const direction = normalizeMigrationDirection(source.deploymentKind, params.targetMode);
  const planSummary = migrationPlanSummary({
    source,
    destinationDeploymentId: params.destinationDeploymentId,
    direction,
    targetMode: params.targetMode,
  });
  const run = await migrationRunModel().create({
    data: {
      customerAccountId: source.customerAccountId,
      sourceDeploymentId: source.id,
      destinationDeploymentId: params.destinationDeploymentId ?? null,
      direction,
      status: "planned",
      actorUserId: actorUserId(actor),
      actorLabel: actorLabel(actor),
      reason: params.reason,
      planSummary: toInputJson(planSummary),
    },
  });
  await recordCustomerDeploymentEvent(actor, source.id, "control_plane.client_migration.planned", {
    reason: params.reason,
    migrationRunId: (run as { id: string }).id,
    direction,
    destinationDeploymentId: params.destinationDeploymentId ?? null,
  });
  return run;
}

function migrationRunSummary(run: unknown) {
  const record = run as Record<string, unknown> & {
    _count?: { idMaps?: number };
    sourceDeployment?: unknown;
    destinationDeployment?: unknown;
    customerAccount?: unknown;
  };
  return {
    id: record.id,
    customerAccountId: record.customerAccountId,
    sourceDeploymentId: record.sourceDeploymentId,
    destinationDeploymentId: record.destinationDeploymentId ?? null,
    direction: record.direction,
    status: record.status,
    actorUserId: record.actorUserId ?? null,
    actorLabel: record.actorLabel ?? null,
    reason: record.reason,
    planSummary: record.planSummary ?? null,
    verificationSummary: record.verificationSummary ?? null,
    error: record.error ?? null,
    dryRunAt: record.dryRunAt ?? null,
    executedAt: record.executedAt ?? null,
    finalizedAt: record.finalizedAt ?? null,
    rolledBackAt: record.rolledBackAt ?? null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    idMapCount: record._count?.idMaps ?? null,
    sourceDeployment: record.sourceDeployment ? sanitizeDeploymentForControlPlane(record.sourceDeployment as Record<string, unknown>) : undefined,
    destinationDeployment: record.destinationDeployment ? sanitizeDeploymentForControlPlane(record.destinationDeployment as Record<string, unknown>) : undefined,
    customerAccount: record.customerAccount ? customerAccountSummary(record.customerAccount as Parameters<typeof customerAccountSummary>[0]) : undefined,
  };
}

function runCustomerAccount(run: unknown) {
  return (run as { customerAccount?: { primaryDeploymentId?: string | null } }).customerAccount ?? null;
}

function runDestinationDeployment(run: unknown) {
  return (run as { destinationDeployment?: { id: string; customerAccountId?: string | null; deploymentKind?: string; deploymentStatus?: string; lastHealthStatus?: string | null } | null }).destinationDeployment ?? null;
}

function assertRunDestinationBelongsToAccount(run: unknown) {
  const runRecord = run as { customerAccountId: string; destinationDeploymentId?: string | null };
  const destination = runDestinationDeployment(run);
  if (!runRecord.destinationDeploymentId) return;
  invariant(destination, 404, "NOT_FOUND", "Destination deployment not found.");
  invariant(destination.customerAccountId === runRecord.customerAccountId, 400, "MIGRATION_DESTINATION_ACCOUNT_MISMATCH", "Destination deployment must belong to the same customer account as the source.");
}

async function loadClientMigrationRun(actor: AppActor, migrationRunId: string) {
  const run = await migrationRunModel().findUnique({
    where: { id: migrationRunId },
    include: {
      customerAccount: true,
      sourceDeployment: true,
      destinationDeployment: true,
      _count: { select: { idMaps: true } },
    },
  });
  invariant(run, 404, "NOT_FOUND", "Client migration run not found.");
  const sourceDeploymentId = (run as { sourceDeploymentId: string }).sourceDeploymentId;
  await requireControlPlaneAccess(actor, { deploymentId: sourceDeploymentId });
  return run;
}

export async function planControlPlaneClientMigration(actor: AppActor, params: {
  sourceDeploymentId: string;
  targetMode: string;
  destinationDeploymentId?: string | null;
  reason?: string | null;
}) {
  await requireControlPlaneAccess(actor);
  requireControlPlaneScope(actor, CONTROL_PLANE_MIGRATIONS_WRITE_SCOPE);
  assertControlPlaneCapabilityEnabled(
    CONTROL_PLANE_MIGRATION_DRY_RUN_ENABLED_ENV,
    "CONTROL_PLANE_MIGRATION_DRY_RUN_DISABLED",
    "Control-plane client migration planning is disabled for this environment.",
    { defaultEnabledOutsideProduction: true },
  );
  const reason = requireMutationReason(params.reason);
  const targetMode = normalizeClientMode(params.targetMode);
  const run = await createClientMigrationRun(actor, {
    sourceDeploymentId: normalizeRequiredText(params.sourceDeploymentId, "Source deployment ID"),
    targetMode,
    destinationDeploymentId: normalizeOptionalControlPlaneText(params.destinationDeploymentId),
    reason,
  });
  return migrationRunSummary(run);
}

type EntityInventorySpec = {
  entityType: string;
  modelName: string;
  where: JsonRecord;
  createIdMap?: boolean;
};

async function safeEntityCount(spec: EntityInventorySpec) {
  const model = (prisma as unknown as Record<string, { count?: (args: unknown) => Promise<number> }>)[spec.modelName];
  if (!model?.count) return null;
  return model.count({ where: spec.where });
}

async function safeEntityIds(spec: EntityInventorySpec) {
  if (!spec.createIdMap) return [];
  const model = (prisma as unknown as Record<string, { findMany?: (args: unknown) => Promise<Array<{ id: string }>> }>)[spec.modelName];
  if (!model?.findMany) return [];
  const rows: Array<{ id: string }> = [];
  let cursor: string | null = null;
  for (;;) {
    const page = await model.findMany({
      where: spec.where,
      select: { id: true },
      orderBy: { id: "asc" },
      take: 1_000,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    rows.push(...page);
    if (page.length < 1_000) break;
    cursor = page[page.length - 1]?.id ?? null;
    if (!cursor) break;
  }
  return rows;
}

async function buildMigrationInventory(deployment: {
  id: string;
  managedWorkspaceId?: string | null;
  customerAccountId?: string | null;
}) {
  const specs: EntityInventorySpec[] = [
    { entityType: "SupportOperation", modelName: "supportOperation", where: { deploymentId: deployment.id }, createIdMap: true },
    { entityType: "CustomerDeploymentEvent", modelName: "customerDeploymentEvent", where: { deploymentId: deployment.id }, createIdMap: true },
    { entityType: "FleetHealthSnapshot", modelName: "fleetHealthSnapshot", where: { deploymentId: deployment.id }, createIdMap: true },
    { entityType: "CustomerEntitlement", modelName: "customerEntitlement", where: { deploymentId: deployment.id }, createIdMap: true },
    { entityType: "CustomerReleaseTarget", modelName: "customerReleaseTarget", where: { deploymentId: deployment.id }, createIdMap: true },
  ];

  if (deployment.managedWorkspaceId) {
    const workspaceId = deployment.managedWorkspaceId;
    specs[0] = { entityType: "SupportOperation", modelName: "supportOperation", where: { OR: [{ deploymentId: deployment.id }, { workspaceId }] }, createIdMap: true };
    specs.push(
      { entityType: "Workspace", modelName: "workspace", where: { id: workspaceId }, createIdMap: true },
      { entityType: "Member", modelName: "member", where: { workspaceId }, createIdMap: true },
      { entityType: "Circle", modelName: "circle", where: { workspaceId }, createIdMap: true },
      { entityType: "Role", modelName: "role", where: { circle: { workspaceId } }, createIdMap: true },
      { entityType: "RoleVersion", modelName: "roleVersion", where: { workspaceId }, createIdMap: true },
      { entityType: "RoleHolderHistory", modelName: "roleHolderHistory", where: { workspaceId }, createIdMap: true },
      { entityType: "RoleAssignment", modelName: "roleAssignment", where: { role: { circle: { workspaceId } } }, createIdMap: true },
      { entityType: "RoleOnboardingSession", modelName: "roleOnboardingSession", where: { workspaceId }, createIdMap: true },
      { entityType: "ApprovalPolicy", modelName: "approvalPolicy", where: { workspaceId }, createIdMap: true },
      { entityType: "ApprovalFlow", modelName: "approvalFlow", where: { workspaceId }, createIdMap: true },
      { entityType: "ApprovalDecision", modelName: "approvalDecision", where: { flow: { workspaceId } }, createIdMap: true },
      { entityType: "Objection", modelName: "objection", where: { flow: { workspaceId } }, createIdMap: true },
      { entityType: "WorkspaceFeatureFlag", modelName: "workspaceFeatureFlag", where: { workspaceId }, createIdMap: true },
      { entityType: "WorkspaceToolLink", modelName: "workspaceToolLink", where: { workspaceId }, createIdMap: true },
      { entityType: "WorkspaceToolLinkCircleTag", modelName: "workspaceToolLinkCircleTag", where: { toolLink: { workspaceId } }, createIdMap: true },
      { entityType: "CatalogItem", modelName: "catalogItem", where: { workspaceId }, createIdMap: true },
      { entityType: "CatalogFavorite", modelName: "catalogFavorite", where: { workspaceId }, createIdMap: true },
      { entityType: "CatalogRequest", modelName: "catalogRequest", where: { workspaceId }, createIdMap: true },
      { entityType: "CatalogSettings", modelName: "catalogSettings", where: { workspaceId }, createIdMap: true },
      { entityType: "BrainSource", modelName: "brainSource", where: { workspaceId }, createIdMap: true },
      { entityType: "BrainArticle", modelName: "brainArticle", where: { workspaceId }, createIdMap: true },
      { entityType: "KnowledgeChunk", modelName: "knowledgeChunk", where: { workspaceId }, createIdMap: true },
      { entityType: "ExternalDataSource", modelName: "externalDataSource", where: { workspaceId }, createIdMap: true },
      { entityType: "Document", modelName: "document", where: { workspaceId }, createIdMap: true },
      { entityType: "FinanceClient", modelName: "financeClient", where: { workspaceId }, createIdMap: true },
      { entityType: "FinanceConsultant", modelName: "financeConsultant", where: { workspaceId }, createIdMap: true },
      { entityType: "FinanceProject", modelName: "financeProject", where: { workspaceId }, createIdMap: true },
      { entityType: "FinanceTimeEntry", modelName: "financeTimeEntry", where: { workspaceId }, createIdMap: true },
      { entityType: "FinanceExpense", modelName: "financeExpense", where: { workspaceId }, createIdMap: true },
      { entityType: "FinanceContributionEntry", modelName: "financeContributionEntry", where: { workspaceId }, createIdMap: true },
      { entityType: "Meeting", modelName: "meeting", where: { workspaceId }, createIdMap: true },
      { entityType: "MeetingRecording", modelName: "meetingRecording", where: { workspaceId }, createIdMap: true },
      { entityType: "Action", modelName: "action", where: { workspaceId }, createIdMap: true },
      { entityType: "Proposal", modelName: "proposal", where: { workspaceId }, createIdMap: true },
      { entityType: "Tension", modelName: "tension", where: { workspaceId }, createIdMap: true },
      { entityType: "AuditLog", modelName: "auditLog", where: { workspaceId }, createIdMap: true },
      { entityType: "Event", modelName: "event", where: { workspaceId }, createIdMap: true },
      { entityType: "WorkflowJob", modelName: "workflowJob", where: { workspaceId }, createIdMap: true },
      { entityType: "AgentRun", modelName: "agentRun", where: { workspaceId }, createIdMap: true },
      { entityType: "AgentCredential", modelName: "agentCredential", where: { workspaceId }, createIdMap: true },
      { entityType: "OAuthConnection", modelName: "oauthConnection", where: { workspaceId }, createIdMap: true },
      { entityType: "ExecutionRequest", modelName: "executionRequest", where: { workspaceId }, createIdMap: true },
      { entityType: "ExecutionResult", modelName: "executionResult", where: { workspaceId }, createIdMap: true },
      { entityType: "ContextGraphObject", modelName: "contextGraphObject", where: { workspaceId }, createIdMap: true },
      { entityType: "ContextGraphRelationship", modelName: "contextGraphRelationship", where: { workspaceId }, createIdMap: true },
      { entityType: "Goal", modelName: "goal", where: { workspaceId }, createIdMap: true },
      { entityType: "GoalUpdate", modelName: "goalUpdate", where: { goal: { workspaceId } }, createIdMap: true },
      { entityType: "GoalLink", modelName: "goalLink", where: { goal: { workspaceId } }, createIdMap: true },
      { entityType: "Recognition", modelName: "recognition", where: { workspaceId }, createIdMap: true },
      { entityType: "CheckIn", modelName: "checkIn", where: { workspaceId }, createIdMap: true },
      { entityType: "ModelUsageBudget", modelName: "modelUsageBudget", where: { workspaceId }, createIdMap: true },
      { entityType: "WorkspaceBillingProfile", modelName: "workspaceBillingProfile", where: { workspaceId }, createIdMap: true },
      { entityType: "WorkspaceEnterpriseService", modelName: "workspaceEnterpriseService", where: { workspaceId }, createIdMap: true },
    );
  }

  const entries = [];
  const idMapSeeds: Array<{ entityType: string; sourceId: string }> = [];
  for (const spec of specs) {
    const [count, ids] = await Promise.all([
      safeEntityCount(spec),
      safeEntityIds(spec),
    ]);
    entries.push({
      entityType: spec.entityType,
      count,
      idMapSampled: spec.createIdMap ? ids.length : 0,
    });
    for (const id of ids) {
      idMapSeeds.push({ entityType: spec.entityType, sourceId: id.id });
    }
  }

  return {
    entries,
    idMapSeeds,
  };
}

async function buildMigrationActiveWriteEvidence(deployment: { managedWorkspaceId?: string | null }) {
  if (!deployment.managedWorkspaceId) {
    return { pendingWorkflowJobs: null };
  }
  const model = (prisma as unknown as Record<string, { count?: (args: unknown) => Promise<number> }>).workflowJob;
  if (!model?.count) {
    return { pendingWorkflowJobs: null };
  }
  return {
    pendingWorkflowJobs: await model.count({
      where: {
        workspaceId: deployment.managedWorkspaceId,
        status: { in: ["PENDING", "RUNNING"] },
      },
    }),
  };
}

async function writeMigrationIdMapSeeds(migrationRunId: string, seeds: Array<{ entityType: string; sourceId: string }>) {
  const model = migrationIdMapModel();
  await Promise.all(seeds.map((seed) => model.upsert({
    where: {
      migrationRunId_entityType_sourceId: {
        migrationRunId,
        entityType: seed.entityType,
        sourceId: seed.sourceId,
      },
    },
    update: {},
    create: {
      migrationRunId,
      entityType: seed.entityType,
      sourceId: seed.sourceId,
      destinationId: null,
    },
  })));
}

function dryRunChecks(params: {
  sourceDeployment: {
    id: string;
    deploymentStatus: string;
    deploymentKind: string;
    managedWorkspaceId?: string | null;
    supportCredentialEnc?: string | null;
    customerAccount?: { primaryDeploymentId?: string | null } | null;
  };
  destinationDeployment?: { deploymentStatus: string; deploymentKind: string } | null;
  targetMode: ControlPlaneClientMode;
  writesQuiesced?: boolean | null;
  acceptRequiresReauth?: boolean | null;
  inventory: { entries: Array<{ entityType: string; count: number | null }> };
  activeWriteEvidence: { pendingWorkflowJobs: number | null };
}) {
  const checks = [
    {
      key: "supported_direction",
      ok: true,
      detail: `V1 supports ${params.sourceDeployment.deploymentKind} to ${targetKindFromMode(params.targetMode)}.`,
    },
    {
      key: "source_primary_routing",
      ok: !params.sourceDeployment.customerAccount?.primaryDeploymentId
        || params.sourceDeployment.customerAccount.primaryDeploymentId === params.sourceDeployment.id,
      detail: !params.sourceDeployment.customerAccount?.primaryDeploymentId
        || params.sourceDeployment.customerAccount.primaryDeploymentId === params.sourceDeployment.id
        ? "Source is the account primary deployment or no primary is set."
        : "Source is not the account primary deployment; re-plan against the current primary deployment.",
    },
    {
      key: "source_writes_quiesced",
      ok: params.sourceDeployment.deploymentStatus !== "ACTIVE" || Boolean(params.writesQuiesced),
      detail: params.sourceDeployment.deploymentStatus !== "ACTIVE" || params.writesQuiesced
        ? "Source write risk accepted for migration window."
        : "Source is active; confirm writes are quiesced before migration.",
    },
    {
      key: "pending_workflow_jobs",
      ok: params.activeWriteEvidence.pendingWorkflowJobs === 0,
      detail: params.activeWriteEvidence.pendingWorkflowJobs === 0
        ? "No pending or running workspace jobs were found."
        : params.activeWriteEvidence.pendingWorkflowJobs == null
          ? "Pending/running workspace jobs could not be verified."
          : `${params.activeWriteEvidence.pendingWorkflowJobs} pending or running workspace job(s) must finish before migration.`,
    },
    {
      key: "destination_kind",
      ok: !params.destinationDeployment || params.destinationDeployment.deploymentKind === targetKindFromMode(params.targetMode),
      detail: params.destinationDeployment
        ? "Destination kind matches target lane."
        : "Destination is not attached yet; create it before execute.",
    },
    {
      key: "destination_health",
      ok: !params.destinationDeployment || ["ACTIVE", "BOOTSTRAPPING", "PROVISIONING"].includes(params.destinationDeployment.deploymentStatus),
      detail: params.destinationDeployment
        ? `Destination status is ${params.destinationDeployment.deploymentStatus}.`
        : "Destination health will be verified after provisioning.",
    },
  ];
  const missingCounts = params.inventory.entries.filter((entry) => entry.count == null);
  checks.push({
    key: "inventory_counts_complete",
    ok: missingCounts.length === 0,
    detail: missingCounts.length === 0
      ? "All migration inventory counts were collected."
      : `Missing inventory counts for: ${missingCounts.map((entry) => entry.entityType).join(", ")}.`,
  });
  const featureFlagInventory = params.inventory.entries.find((entry) => entry.entityType === "WorkspaceFeatureFlag");
  checks.push({
    key: "feature_flag_inventory",
    ok: featureFlagInventory?.count != null,
    detail: featureFlagInventory?.count != null
      ? "Feature flag inventory was collected for parity verification."
      : "Feature flag inventory is missing; feature parity cannot be verified.",
  });
  const secretEntities = params.inventory.entries.filter((entry) => (
    (entry.entityType === "AgentCredential" || entry.entityType === "OAuthConnection") && (entry.count ?? 0) > 0
  ));
  checks.push({
    key: "secret_prerequisites",
    ok: secretEntities.length === 0 || Boolean(params.acceptRequiresReauth),
    detail: secretEntities.length === 0
      ? "No encrypted connector credentials require reissue."
      : "Encrypted connector credentials require encrypted migration or customer reauthentication acceptance.",
  });
  return checks;
}

export async function runControlPlaneClientMigrationDryRun(actor: AppActor, params: {
  migrationRunId?: string | null;
  sourceDeploymentId?: string | null;
  targetMode?: string | null;
  destinationDeploymentId?: string | null;
  writesQuiesced?: boolean | null;
  acceptRequiresReauth?: boolean | null;
  reason?: string | null;
}) {
  await requireControlPlaneAccess(actor);
  requireControlPlaneScope(actor, CONTROL_PLANE_MIGRATIONS_WRITE_SCOPE);
  assertControlPlaneCapabilityEnabled(
    CONTROL_PLANE_MIGRATION_DRY_RUN_ENABLED_ENV,
    "CONTROL_PLANE_MIGRATION_DRY_RUN_DISABLED",
    "Control-plane client migration dry-run is disabled for this environment.",
    { defaultEnabledOutsideProduction: true },
  );
  const reason = requireMutationReason(params.reason);
  let run: unknown = params.migrationRunId
    ? await loadClientMigrationRun(actor, params.migrationRunId)
    : null;
  if (!run) {
    run = await createClientMigrationRun(actor, {
      sourceDeploymentId: normalizeRequiredText(params.sourceDeploymentId, "Source deployment ID"),
      targetMode: normalizeClientMode(params.targetMode),
      destinationDeploymentId: normalizeOptionalControlPlaneText(params.destinationDeploymentId),
      reason,
    });
  }
  const runRecord = run as {
    id: string;
    sourceDeploymentId: string;
    destinationDeploymentId?: string | null;
    direction: ClientMigrationDirection;
    sourceDeployment?: { id: string; deploymentKind: string; deploymentStatus: string; managedWorkspaceId?: string | null; supportCredentialEnc?: string | null; customerAccount?: { primaryDeploymentId?: string | null } | null };
    destinationDeployment?: { deploymentKind: string; deploymentStatus: string } | null;
  };
  const sourceDeployment = runRecord.sourceDeployment ?? await prisma.customerDeployment.findUnique({
    where: { id: runRecord.sourceDeploymentId },
    include: { customerAccount: true },
  });
  invariant(sourceDeployment, 404, "NOT_FOUND", "Source deployment not found.");
  invariant(
    sourceDeployment.managedWorkspaceId,
    400,
    "MIGRATION_SOURCE_INVENTORY_UNAVAILABLE",
    "Hosted dedicated source inventory requires the dedicated migration worker or support export endpoint before dry-run can proceed.",
  );
  const targetMode = runRecord.direction === "shared_to_hosted" ? "hosted_dedicated" : "shared_workspace";
  const destinationDeploymentId = normalizeOptionalControlPlaneText(params.destinationDeploymentId) ?? runRecord.destinationDeploymentId ?? null;
  const destinationDeployment = destinationDeploymentId
    ? await assertMigrationDestination({
      destinationDeploymentId,
      targetMode,
      sourceDeploymentId: runRecord.sourceDeploymentId,
      customerAccountId: (run as { customerAccountId: string }).customerAccountId,
    })
    : null;
  const inventory = await buildMigrationInventory({
    id: runRecord.sourceDeploymentId,
    managedWorkspaceId: sourceDeployment.managedWorkspaceId,
  });
  const activeWriteEvidence = await buildMigrationActiveWriteEvidence(sourceDeployment);
  await writeMigrationIdMapSeeds(runRecord.id, inventory.idMapSeeds);
  const checks = dryRunChecks({
    sourceDeployment,
    destinationDeployment,
    targetMode,
    writesQuiesced: params.writesQuiesced,
    acceptRequiresReauth: params.acceptRequiresReauth,
    inventory,
    activeWriteEvidence,
  });
  const passed = checks.every((check) => check.ok);
  const verificationSummary = {
    dryRun: {
      passed,
      reason,
      checks,
      inventory: inventory.entries,
      idMapSeedCount: inventory.idMapSeeds.length,
      activeWriteEvidence,
      writesQuiesced: Boolean(params.writesQuiesced),
      acceptRequiresReauth: Boolean(params.acceptRequiresReauth),
    },
  };
  const updated = await migrationRunModel().update({
    where: { id: runRecord.id },
    data: {
      destinationDeploymentId,
      status: passed ? "dry_run_passed" : "dry_run_failed",
      verificationSummary: toInputJson(verificationSummary),
      error: passed ? null : "Dry-run checks failed.",
      dryRunAt: new Date(),
    },
    include: {
      customerAccount: true,
      sourceDeployment: true,
      destinationDeployment: true,
      _count: { select: { idMaps: true } },
    },
  });
  await recordCustomerDeploymentEvent(actor, runRecord.sourceDeploymentId, "control_plane.client_migration.dry_run", {
    reason,
    migrationRunId: runRecord.id,
    status: passed ? "dry_run_passed" : "dry_run_failed",
    failedChecks: checks.filter((check) => !check.ok).map((check) => check.key),
  });
  return migrationRunSummary(updated);
}

function boundedVerificationString(value: unknown, label: string, maxLength = 160) {
  if (value == null) return null;
  invariant(typeof value === "string", 400, "INVALID_MIGRATION_VERIFICATION", `${label} must be a string.`);
  const trimmed = value.trim();
  invariant(trimmed.length <= maxLength, 400, "INVALID_MIGRATION_VERIFICATION", `${label} is too long.`);
  return trimmed || null;
}

function sanitizeMigrationCountEvidence(value: unknown) {
  if (value == null) return {};
  invariant(value && typeof value === "object" && !Array.isArray(value), 400, "INVALID_MIGRATION_VERIFICATION", "counts must be an object.");
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([entityType, entry]) => {
    invariant(/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(entityType), 400, "INVALID_MIGRATION_VERIFICATION", "Invalid count entity type.");
    invariant(entry && typeof entry === "object" && !Array.isArray(entry), 400, "INVALID_MIGRATION_VERIFICATION", "Each count entry must be an object.");
    const record = entry as Record<string, unknown>;
    const source = record.source;
    const destination = record.destination;
    invariant(typeof source === "number" && Number.isSafeInteger(source) && source >= 0, 400, "INVALID_MIGRATION_VERIFICATION", "source count must be a non-negative integer.");
    invariant(typeof destination === "number" && Number.isSafeInteger(destination) && destination >= 0, 400, "INVALID_MIGRATION_VERIFICATION", "destination count must be a non-negative integer.");
    invariant(source === destination, 400, "MIGRATION_COUNT_MISMATCH", `Migration count mismatch for ${entityType}.`);
    return [entityType, { source, destination }];
  }));
}

function dryRunInventoryFromSummary(summary: unknown) {
  const summaryRecord = summary && typeof summary === "object" ? summary as JsonRecord : null;
  const dryRun = summaryRecord?.dryRun && typeof summaryRecord.dryRun === "object" ? summaryRecord.dryRun as JsonRecord : null;
  const inventory = Array.isArray(dryRun?.inventory) ? dryRun.inventory : [];
  return inventory.map((entry) => {
    invariant(entry && typeof entry === "object", 400, "MIGRATION_DRY_RUN_REQUIRED", "Dry-run inventory is malformed.");
    const record = entry as JsonRecord;
    invariant(typeof record.entityType === "string", 400, "MIGRATION_DRY_RUN_REQUIRED", "Dry-run inventory entity type is missing.");
    invariant(typeof record.count === "number" && Number.isSafeInteger(record.count) && record.count >= 0, 400, "MIGRATION_DRY_RUN_REQUIRED", "Dry-run inventory count is missing.");
    return {
      entityType: record.entityType,
      count: record.count,
    };
  });
}

function requireMigrationVerification(value: unknown, expectedInventory: Array<{ entityType: string; count: number }>) {
  invariant(expectedInventory.length > 0, 400, "MIGRATION_DRY_RUN_REQUIRED", "Migration execution requires complete dry-run inventory.");
  const record = value && typeof value === "object" ? value as JsonRecord : null;
  invariant(record?.verified === true, 400, "MIGRATION_VERIFICATION_REQUIRED", "Migration worker verification requires verified evidence from the destination import/check process.");
  const verificationSource = boundedVerificationString(record.verificationSource, "verificationSource");
  invariant(verificationSource === "control_plane_migration_worker", 400, "MIGRATION_VERIFICATION_REQUIRED", "Migration verification must come from the control-plane migration worker.");
  const importJobId = boundedVerificationString(record.importJobId, "importJobId");
  const sourceChecksum = boundedVerificationString(record.sourceChecksum, "sourceChecksum", 128);
  const destinationChecksum = boundedVerificationString(record.destinationChecksum, "destinationChecksum", 128);
  const healthStatus = boundedVerificationString(record.healthStatus, "healthStatus", 40);
  invariant(importJobId, 400, "MIGRATION_VERIFICATION_REQUIRED", "Migration importJobId is required.");
  invariant(sourceChecksum && destinationChecksum && sourceChecksum === destinationChecksum, 400, "MIGRATION_CHECKSUM_MISMATCH", "Migration source and destination checksums must match.");
  invariant(healthStatus === "ok", 400, "MIGRATION_DESTINATION_HEALTH_REQUIRED", "Destination health must be ok.");
  const counts = sanitizeMigrationCountEvidence(record.counts);
  for (const expected of expectedInventory) {
    const observed = counts[expected.entityType] as { source?: number; destination?: number } | undefined;
    invariant(observed, 400, "MIGRATION_VERIFICATION_INCOMPLETE", `Migration verification is missing ${expected.entityType} counts.`);
    invariant(
      observed.source === expected.count && observed.destination === expected.count,
      400,
      "MIGRATION_COUNT_MISMATCH",
      `Migration verification count mismatch for ${expected.entityType}.`,
    );
  }
  return {
    verified: true,
    verificationSource,
    importJobId,
    sourceChecksum,
    destinationChecksum,
    healthStatus,
    releaseImageTag: boundedVerificationString(record.releaseImageTag, "releaseImageTag", 160),
    counts,
  };
}

function sanitizeMigrationWorkerIdMaps(value: unknown) {
  if (value == null) return [];
  invariant(Array.isArray(value), 400, "INVALID_MIGRATION_ID_MAP", "idMaps must be an array.");
  invariant(value.length <= 25_000, 400, "INVALID_MIGRATION_ID_MAP", "idMaps exceeds the per-run evidence limit.");
  return value.map((entry) => {
    invariant(entry && typeof entry === "object" && !Array.isArray(entry), 400, "INVALID_MIGRATION_ID_MAP", "Each idMap entry must be an object.");
    const record = entry as JsonRecord;
    const entityType = boundedVerificationString(record.entityType, "entityType", 64);
    const sourceId = boundedVerificationString(record.sourceId, "sourceId", 160);
    const destinationId = boundedVerificationString(record.destinationId, "destinationId", 160);
    const checksum = boundedVerificationString(record.checksum, "checksum", 128);
    invariant(entityType && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(entityType), 400, "INVALID_MIGRATION_ID_MAP", "Invalid idMap entity type.");
    invariant(sourceId, 400, "INVALID_MIGRATION_ID_MAP", "idMap sourceId is required.");
    invariant(destinationId, 400, "INVALID_MIGRATION_ID_MAP", "idMap destinationId is required.");
    invariant(record.metadata == null || (typeof record.metadata === "object" && !Array.isArray(record.metadata)), 400, "INVALID_MIGRATION_ID_MAP", "idMap metadata must be an object.");
    return {
      entityType,
      sourceId,
      destinationId,
      checksum,
      metadata: record.metadata == null ? null : record.metadata,
    };
  });
}

async function writeMigrationWorkerIdMaps(migrationRunId: string, maps: ReturnType<typeof sanitizeMigrationWorkerIdMaps>) {
  const model = migrationIdMapModel();
  await Promise.all(maps.map((entry) => model.upsert({
    where: {
      migrationRunId_entityType_sourceId: {
        migrationRunId,
        entityType: entry.entityType,
        sourceId: entry.sourceId,
      },
    },
    update: {
      destinationId: entry.destinationId,
      checksum: entry.checksum,
      metadata: entry.metadata == null ? undefined : toInputJson(entry.metadata),
    },
    create: {
      migrationRunId,
      entityType: entry.entityType,
      sourceId: entry.sourceId,
      destinationId: entry.destinationId,
      checksum: entry.checksum,
      metadata: entry.metadata == null ? undefined : toInputJson(entry.metadata),
    },
  })));
}

function requireStoredWorkerVerification(summary: unknown) {
  const summaryRecord = summary && typeof summary === "object" ? summary as JsonRecord : null;
  const worker = summaryRecord?.worker && typeof summaryRecord.worker === "object" ? summaryRecord.worker as JsonRecord : null;
  invariant(worker?.verified === true, 400, "MIGRATION_WORKER_VERIFICATION_REQUIRED", "Migration execution requires stored verification from the control-plane migration worker.");
  return worker;
}

export async function recordControlPlaneClientMigrationWorkerVerification(actor: AppActor, params: {
  migrationRunId: string;
  destinationDeploymentId?: string | null;
  verificationSummary?: unknown;
  idMaps?: unknown;
  reason?: string | null;
}) {
  await requireControlPlaneAccess(actor);
  requireControlPlaneScope(actor, CONTROL_PLANE_MIGRATIONS_WRITE_SCOPE);
  const reason = requireMutationReason(params.reason);
  const run = await loadClientMigrationRun(actor, params.migrationRunId);
  const runRecord = run as {
    id: string;
    status: string;
    customerAccountId: string;
    sourceDeploymentId: string;
    destinationDeploymentId?: string | null;
    direction: ClientMigrationDirection;
    verificationSummary?: unknown;
  };
  assertRunDestinationBelongsToAccount(run);
  invariant(
    runRecord.status === "dry_run_passed" || runRecord.status === "import_verification_queued",
    400,
    "MIGRATION_DRY_RUN_REQUIRED",
    "Worker verification requires a passed dry-run.",
  );
  const targetMode = runRecord.direction === "shared_to_hosted" ? "hosted_dedicated" : "shared_workspace";
  const destinationDeploymentId = normalizeOptionalControlPlaneText(params.destinationDeploymentId) ?? runRecord.destinationDeploymentId;
  invariant(destinationDeploymentId, 400, "MIGRATION_DESTINATION_REQUIRED", "A destination deployment is required before worker verification.");
  await assertMigrationDestination({
    destinationDeploymentId,
    targetMode,
    sourceDeploymentId: runRecord.sourceDeploymentId,
    customerAccountId: runRecord.customerAccountId,
  });
  const expectedInventory = dryRunInventoryFromSummary(runRecord.verificationSummary);
  const evidence = requireMigrationVerification(params.verificationSummary, expectedInventory);
  const idMaps = sanitizeMigrationWorkerIdMaps(params.idMaps);
  await writeMigrationWorkerIdMaps(runRecord.id, idMaps);
  const verificationSummary = {
    previous: runRecord.verificationSummary ?? null,
    worker: {
      verified: true,
      reason,
      evidence,
      idMapEvidenceCount: idMaps.length,
      verifiedAt: new Date().toISOString(),
    },
  };
  const updated = await migrationRunModel().update({
    where: { id: runRecord.id },
    data: {
      destinationDeploymentId,
      status: "import_verified",
      verificationSummary: toInputJson(verificationSummary),
      error: null,
    },
    include: {
      customerAccount: true,
      sourceDeployment: true,
      destinationDeployment: true,
      _count: { select: { idMaps: true } },
    },
  });
  await recordCustomerDeploymentEvent(actor, runRecord.sourceDeploymentId, "control_plane.client_migration.worker_verified", {
    reason,
    migrationRunId: runRecord.id,
    destinationDeploymentId,
    idMapEvidenceCount: idMaps.length,
  });
  return migrationRunSummary(updated);
}

export async function enqueueControlPlaneClientMigrationWorkerVerification(actor: AppActor, params: {
  migrationRunId: string;
  destinationDeploymentId?: string | null;
  verificationSummary?: unknown;
  idMaps?: unknown;
  reason?: string | null;
}) {
  await requireControlPlaneAccess(actor);
  requireControlPlaneScope(actor, CONTROL_PLANE_MIGRATIONS_WRITE_SCOPE);
  const reason = requireMutationReason(params.reason);
  const run = await loadClientMigrationRun(actor, params.migrationRunId);
  const runRecord = run as {
    id: string;
    status: string;
    customerAccountId: string;
    sourceDeploymentId: string;
    destinationDeploymentId?: string | null;
    direction: ClientMigrationDirection;
    verificationSummary?: unknown;
  };
  assertRunDestinationBelongsToAccount(run);
  invariant(runRecord.status === "dry_run_passed", 400, "MIGRATION_DRY_RUN_REQUIRED", "Migration worker verification requires a passed dry-run.");
  const targetMode = runRecord.direction === "shared_to_hosted" ? "hosted_dedicated" : "shared_workspace";
  const destinationDeploymentId = normalizeOptionalControlPlaneText(params.destinationDeploymentId) ?? runRecord.destinationDeploymentId;
  invariant(destinationDeploymentId, 400, "MIGRATION_DESTINATION_REQUIRED", "A destination deployment is required before migration worker verification.");
  await assertMigrationDestination({
    destinationDeploymentId,
    targetMode,
    sourceDeploymentId: runRecord.sourceDeploymentId,
    customerAccountId: runRecord.customerAccountId,
  });
  const expectedInventory = dryRunInventoryFromSummary(runRecord.verificationSummary);
  requireMigrationVerification(params.verificationSummary, expectedInventory);
  sanitizeMigrationWorkerIdMaps(params.idMaps);

  const dedupeKey = `control-plane:client-migration-verify:${runRecord.id}:${destinationDeploymentId}`;
  const job = await prisma.workflowJob.upsert({
    where: { dedupeKey },
    update: {},
    create: {
      workspaceId: null,
      eventId: null,
      type: CONTROL_PLANE_CLIENT_MIGRATION_VERIFY_JOB_TYPE,
      payload: toInputJson({
        migrationRunId: runRecord.id,
        destinationDeploymentId,
        verificationSummary: params.verificationSummary ?? null,
        idMaps: params.idMaps ?? [],
        reason,
        requestedBy: actorUserId(actor) ?? (isControlPlaneAgent(actor) ? actor.label : "control-plane"),
      }),
      dedupeKey,
    },
  });
  const updated = await migrationRunModel().update({
    where: { id: runRecord.id },
    data: {
      destinationDeploymentId,
      status: "import_verification_queued",
      error: null,
    },
    include: {
      customerAccount: true,
      sourceDeployment: true,
      destinationDeployment: true,
      _count: { select: { idMaps: true } },
    },
  });
  await recordCustomerDeploymentEvent(actor, runRecord.sourceDeploymentId, "control_plane.client_migration.worker_verification_queued", {
    reason,
    migrationRunId: runRecord.id,
    destinationDeploymentId,
    jobId: (job as { id?: string }).id ?? null,
  });
  return {
    migration: migrationRunSummary(updated),
    job: {
      id: (job as { id?: string }).id ?? null,
      dedupeKey,
      type: CONTROL_PLANE_CLIENT_MIGRATION_VERIFY_JOB_TYPE,
    },
  };
}

export async function runControlPlaneClientMigrationWorkerVerificationJob(params: {
  migrationRunId?: string | null;
  destinationDeploymentId?: string | null;
  verificationSummary?: unknown;
  idMaps?: unknown;
  reason?: string | null;
}) {
  return recordControlPlaneClientMigrationWorkerVerification(controlPlaneWorkerActor, {
    migrationRunId: normalizeRequiredText(params.migrationRunId, "Migration run ID"),
    destinationDeploymentId: normalizeOptionalControlPlaneText(params.destinationDeploymentId),
    verificationSummary: params.verificationSummary,
    idMaps: params.idMaps,
    reason: params.reason || "Queued control-plane migration worker verification.",
  });
}

export async function executeControlPlaneClientMigration(actor: AppActor, params: {
  migrationRunId: string;
  destinationDeploymentId?: string | null;
  reason?: string | null;
}) {
  await requireControlPlaneAccess(actor);
  requireControlPlaneScope(actor, CONTROL_PLANE_MIGRATIONS_WRITE_SCOPE);
  assertMigrationExecutionAvailable("execute");
  assertMigrationRuntimeReadOnlyEnforced();
  const reason = requireMutationReason(params.reason);
  const run = await loadClientMigrationRun(actor, params.migrationRunId);
  const runRecord = run as {
    id: string;
    status: string;
    customerAccountId: string;
    sourceDeploymentId: string;
    destinationDeploymentId?: string | null;
    direction: ClientMigrationDirection;
    verificationSummary?: unknown;
  };
  assertRunDestinationBelongsToAccount(run);
  invariant(runRecord.status === "import_verified", 400, "MIGRATION_WORKER_VERIFICATION_REQUIRED", "Migration execution requires stored verification from the control-plane migration worker.");
  const targetMode = runRecord.direction === "shared_to_hosted" ? "hosted_dedicated" : "shared_workspace";
  const destinationDeploymentId = normalizeOptionalControlPlaneText(params.destinationDeploymentId) ?? runRecord.destinationDeploymentId;
  invariant(destinationDeploymentId, 400, "MIGRATION_DESTINATION_REQUIRED", "A destination deployment is required before migration execution.");
  const destination = await assertMigrationDestination({
    destinationDeploymentId,
    targetMode,
    sourceDeploymentId: runRecord.sourceDeploymentId,
    customerAccountId: (run as { customerAccountId: string }).customerAccountId,
  });
  invariant(destination, 404, "NOT_FOUND", "Destination deployment not found.");
  assertMigrationDestinationReadyForCutover(destination);
  const account = runCustomerAccount(run);
  invariant(!account?.primaryDeploymentId || account.primaryDeploymentId === runRecord.sourceDeploymentId, 409, "MIGRATION_ROUTING_CHANGED", "Customer primary deployment changed after migration planning; re-plan before executing.");
  const workerVerification = requireStoredWorkerVerification(runRecord.verificationSummary);
  const verificationSummary = {
    previous: runRecord.verificationSummary ?? null,
    execution: {
      verified: true,
      reason,
      workerVerification,
      executedAt: new Date().toISOString(),
    },
  };
  const updated = await prisma.$transaction(async (tx) => {
    await tx.customerAccount.update({
      where: { id: runRecord.customerAccountId },
      data: { primaryDeploymentId: destinationDeploymentId },
    });
    await tx.customerDeployment.update({
      where: { id: runRecord.sourceDeploymentId },
      data: {
        provisioningStatus: "read_only_pending_finalize",
      },
    });
    return (tx as unknown as { clientMigrationRun: { update(args: unknown): Promise<unknown> } }).clientMigrationRun.update({
      where: { id: runRecord.id },
      data: {
        destinationDeploymentId,
        status: "executed",
        verificationSummary: toInputJson(verificationSummary),
        error: null,
        executedAt: new Date(),
      },
      include: {
        customerAccount: true,
        sourceDeployment: true,
        destinationDeployment: true,
        _count: { select: { idMaps: true } },
      },
    });
  });
  await recordCustomerDeploymentEvent(actor, runRecord.sourceDeploymentId, "control_plane.client_migration.executed", {
    reason,
    migrationRunId: runRecord.id,
    destinationDeploymentId,
  });
  return migrationRunSummary(updated);
}

export async function getControlPlaneClientMigrationStatus(actor: AppActor, migrationRunId: string) {
  const run = await loadClientMigrationRun(actor, migrationRunId);
  return migrationRunSummary(run);
}

export async function finalizeControlPlaneClientMigration(actor: AppActor, params: {
  migrationRunId: string;
  reason?: string | null;
}) {
  await requireControlPlaneAccess(actor);
  requireControlPlaneScope(actor, CONTROL_PLANE_MIGRATIONS_WRITE_SCOPE);
  assertMigrationExecutionAvailable("finalize");
  const reason = requireMutationReason(params.reason);
  const run = await loadClientMigrationRun(actor, params.migrationRunId);
  const runRecord = run as {
    id: string;
    status: string;
    customerAccountId: string;
    sourceDeploymentId: string;
    destinationDeploymentId?: string | null;
  };
  assertRunDestinationBelongsToAccount(run);
  invariant(runRecord.status === "executed", 400, "MIGRATION_EXECUTION_REQUIRED", "Only an executed migration can be finalized.");
  invariant(runRecord.destinationDeploymentId, 400, "MIGRATION_DESTINATION_REQUIRED", "Destination deployment is required before finalization.");
  const account = runCustomerAccount(run);
  invariant(!account?.primaryDeploymentId || account.primaryDeploymentId === runRecord.destinationDeploymentId, 409, "MIGRATION_ROUTING_CHANGED", "Customer primary deployment is not the migration destination; inspect manually before finalizing.");
  const destination = runDestinationDeployment(run);
  invariant(destination?.deploymentStatus === "ACTIVE", 400, "MIGRATION_DESTINATION_NOT_READY", "Destination deployment must be ACTIVE before finalization.");
  if (destination.deploymentKind === "HOSTED_DEDICATED") {
    invariant(destination.lastHealthStatus === "ok", 400, "MIGRATION_DESTINATION_HEALTH_REQUIRED", "Hosted destination health must be ok before finalization.");
  }
  const updated = await prisma.$transaction(async (tx) => {
    await tx.customerAccount.update({
      where: { id: runRecord.customerAccountId },
      data: { primaryDeploymentId: runRecord.destinationDeploymentId },
    });
    await tx.customerDeployment.update({
      where: { id: runRecord.destinationDeploymentId! },
      data: {
        deploymentStatus: "ACTIVE",
        provisioningStatus: "active",
      },
    });
    await tx.customerDeployment.update({
      where: { id: runRecord.sourceDeploymentId },
      data: {
        deploymentStatus: "SUSPENDED",
        provisioningStatus: "archived",
      },
    });
    return (tx as unknown as { clientMigrationRun: { update(args: unknown): Promise<unknown> } }).clientMigrationRun.update({
      where: { id: runRecord.id },
      data: {
        status: "finalized",
        finalizedAt: new Date(),
      },
      include: {
        customerAccount: true,
        sourceDeployment: true,
        destinationDeployment: true,
        _count: { select: { idMaps: true } },
      },
    });
  });
  await recordCustomerDeploymentEvent(actor, runRecord.destinationDeploymentId, "control_plane.client_migration.finalized", {
    reason,
    migrationRunId: runRecord.id,
    sourceDeploymentId: runRecord.sourceDeploymentId,
  });
  return migrationRunSummary(updated);
}

export async function rollbackControlPlaneClientMigration(actor: AppActor, params: {
  migrationRunId: string;
  reason?: string | null;
}) {
  await requireControlPlaneAccess(actor);
  requireControlPlaneScope(actor, CONTROL_PLANE_MIGRATIONS_WRITE_SCOPE);
  assertMigrationExecutionAvailable("rollback");
  const reason = requireMutationReason(params.reason);
  const run = await loadClientMigrationRun(actor, params.migrationRunId);
  const runRecord = run as {
    id: string;
    status: string;
    customerAccountId: string;
    sourceDeploymentId: string;
    destinationDeploymentId?: string | null;
  };
  assertRunDestinationBelongsToAccount(run);
  invariant(runRecord.status === "executed", 400, "MIGRATION_ROLLBACK_NOT_AVAILABLE", "Rollback is available only after execution and before finalization.");
  const account = runCustomerAccount(run);
  invariant(
    !account?.primaryDeploymentId
      || account.primaryDeploymentId === runRecord.sourceDeploymentId
      || account.primaryDeploymentId === runRecord.destinationDeploymentId,
    409,
    "MIGRATION_ROUTING_CHANGED",
    "Customer primary deployment changed after migration execution; inspect manually before rollback.",
  );
  const updated = await prisma.$transaction(async (tx) => {
    await tx.customerAccount.update({
      where: { id: runRecord.customerAccountId },
      data: { primaryDeploymentId: runRecord.sourceDeploymentId },
    });
    await tx.customerDeployment.update({
      where: { id: runRecord.sourceDeploymentId },
      data: {
        deploymentStatus: "ACTIVE",
        provisioningStatus: "active",
      },
    });
    if (runRecord.destinationDeploymentId) {
      await tx.customerDeployment.update({
        where: { id: runRecord.destinationDeploymentId },
        data: {
          deploymentStatus: "SUSPENDED",
          provisioningStatus: "rollback_retained",
        },
      });
    }
    return (tx as unknown as { clientMigrationRun: { update(args: unknown): Promise<unknown> } }).clientMigrationRun.update({
      where: { id: runRecord.id },
      data: {
        status: "rolled_back",
        rolledBackAt: new Date(),
      },
      include: {
        customerAccount: true,
        sourceDeployment: true,
        destinationDeployment: true,
        _count: { select: { idMaps: true } },
      },
    });
  });
  await recordCustomerDeploymentEvent(actor, runRecord.sourceDeploymentId, "control_plane.client_migration.rolled_back", {
    reason,
    migrationRunId: runRecord.id,
    destinationDeploymentId: runRecord.destinationDeploymentId ?? null,
  });
  return migrationRunSummary(updated);
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
        cloudProvider: null,
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
        providerSubscriptionId: null,
        providerResourceGroup: null,
        providerProjectId: null,
        providerEnvironmentId: null,
        providerWebServiceId: null,
        providerWorkerServiceId: null,
        providerPostgresServiceId: null,
        providerRedisServiceId: null,
        providerStorageResourceId: null,
        providerLogsUrl: null,
        providerCostUrl: null,
        providerMetadata: null,
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
      supportOperations: [],
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
    supportOperations: [],
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

function controlPlaneFilterValues(value?: string | string[] | null) {
  const rawValues = Array.isArray(value) ? value : value ? [value] : [];
  return [...new Set(rawValues.map((entry) => entry.trim().toLowerCase()).filter(Boolean))];
}

export async function listControlPlaneFleetPage(actor: AppActor, params: {
  query?: string | null;
  health?: string | string[] | null;
  support?: string | string[] | null;
  region?: string | string[] | null;
  owner?: string | string[] | null;
  unhealthy?: string | boolean | null;
  issues?: string | boolean | null;
  missingTools?: string | boolean | null;
  stale?: string | boolean | null;
  sort?: string | null;
  direction?: string | null;
  page?: number | null;
  pageSize?: number | null;
} = {}) {
  const rows = await listControlPlaneDeployments(actor);
  const query = params.query?.trim().toLowerCase() ?? "";
  const health = controlPlaneFilterValues(params.health);
  const support = controlPlaneFilterValues(params.support);
  const region = controlPlaneFilterValues(params.region);
  const owner = controlPlaneFilterValues(params.owner);
  const sort = (["customer", "health", "release", "support", "region", "owner", "updated"].includes(params.sort ?? "")
    ? params.sort
    : "updated") as ControlPlaneFleetSort;
  const direction = params.direction === "asc" ? "asc" : "desc";
  const pageSize = boundedInteger(params.pageSize, 25, 10, 500);
  const page = boundedInteger(params.page, 1, 1, Number.MAX_SAFE_INTEGER);

  const filtered = rows.filter((row) => {
    const healthValue = normalizedStatus(row.lastHealthStatus || latestSnapshotForKind(row, "HEALTH")?.status || row.provisioningStatus);
    const supportValue = normalizedStatus(controlPlaneSupportSummary(row).status);
    return fleetRowMatchesQuery(row, query)
      && (health.length === 0 || health.includes(healthValue))
      && (support.length === 0 || support.includes(supportValue))
      && (region.length === 0 || region.includes(row.region?.toLowerCase() ?? ""))
      && (owner.length === 0 || owner.includes(row.supportOwnerEmail?.toLowerCase() ?? ""));
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
      unhealthy: booleanFilter(params.unhealthy),
      issues: booleanFilter(params.issues),
      missingTools: booleanFilter(params.missingTools),
      stale: booleanFilter(params.stale),
      sort,
      direction,
      regions,
      owners,
    },
    summary: {
      totalCustomers: rows.length,
      active: rows.filter((row) => row.provisioningStatus === "active").length,
      attention: rows.filter((row) => normalizedStatus(row.lastHealthStatus) && normalizedStatus(row.lastHealthStatus) !== "ok").length,
      supportReady: rows.filter((row) => controlPlaneMatrixTone(controlPlaneSupportSummary(row).status) === "ok").length,
      releaseDrift: rows.filter((row) => Boolean(controlPlaneReleaseDrift(row))).length,
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

function controlPlaneDeploymentCloudProvider(deployment: {
  cloudProvider?: CustomerDeploymentCloudProvider | null;
}) {
  return deployment.cloudProvider ?? "RAILWAY";
}

function isControlPlaneAzureDeployment(deployment: {
  cloudProvider?: CustomerDeploymentCloudProvider | null;
}) {
  return controlPlaneDeploymentCloudProvider(deployment) === "AZURE";
}

function isControlPlaneBackupDeployment(deployment: {
  label?: string | null;
  url?: string | null;
  customerSlug?: string | null;
}) {
  const url = deployment.url?.trim().toLowerCase() ?? "";
  const slug = deployment.customerSlug?.trim().toLowerCase() ?? "";
  const label = deployment.label?.trim().toLowerCase() ?? "";
  return url === "https://app.corgtex.com"
    || url === "http://app.corgtex.com"
    || url.startsWith("https://app.corgtex.com/")
    || url.startsWith("http://app.corgtex.com/")
    || slug === "corgtex-internal"
    || (label.includes("corgtex internal") && url.includes("app.corgtex.com"));
}

function isControlPlaneSharedWorkspaceDeployment(deployment: {
  deploymentKind?: CustomerDeploymentKind | string | null;
}) {
  return deployment.deploymentKind === "SHARED_WORKSPACE";
}

function controlPlaneCustomerSupportSummary(deployment: {
  cloudProvider?: CustomerDeploymentCloudProvider | null;
  managedWorkspaceId?: string | null;
  supportCredentialEnc?: string | null;
  supportConnectorStatus?: string | null;
  supportLastSyncError?: string | null;
}) {
  if (isControlPlaneAzureDeployment(deployment)) {
    const degraded = deployment.supportConnectorStatus === "degraded";
    return {
      supportConnectorStatus: degraded ? "degraded" : "ready",
      supportConnectorLabel: "Self-serve support sessions",
      supportConnectorDetail: degraded
        ? deployment.supportLastSyncError || "Azure self-serve support sessions need attention."
        : "Audited self-serve support sessions and provider read-model inspection are available.",
      supportAccessMode: "self_serve_sessions" as const,
    };
  }
  if (deployment.managedWorkspaceId) {
    return {
      supportConnectorStatus: deployment.supportConnectorStatus ?? "managed",
      supportConnectorLabel: "Managed workspace",
      supportConnectorDetail: "Managed workspace state is available locally.",
      supportAccessMode: "managed_workspace" as const,
    };
  }
  return {
    supportConnectorStatus: deployment.supportConnectorStatus ?? "not_configured",
    supportConnectorLabel: "Support connector",
    supportConnectorDetail: deployment.supportCredentialEnc
      ? "Enterprise support connector can inspect the remote workspace."
      : "Enterprise support connector is required for remote Railway diagnostics.",
    supportAccessMode: "enterprise_connector" as const,
  };
}

function controlPlaneHealthStatus(row: ControlPlaneDeploymentRow) {
  return row.lastHealthStatus || latestSnapshotForKind(row, "HEALTH")?.status || row.provisioningStatus || "unknown";
}

function controlPlaneReleaseLabel(row: ControlPlaneDeploymentRow) {
  return row.releaseImageTag || row.releaseVersion || "Unknown";
}

function controlPlaneReleaseDrift(row: ControlPlaneDeploymentRow) {
  if (isControlPlaneBackupDeployment(row)) return null;
  return row.lastHealthError?.includes("Release drift:")
    ? row.lastHealthError
    : latestSnapshotForKind(row, "RELEASE")?.error ?? null;
}

function jsonRecordOrNull(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

function firstJsonRecord(...values: unknown[]) {
  for (const value of values) {
    const record = jsonRecordOrNull(value);
    if (record) return record;
  }
  return null;
}

function compactSnapshot(snapshot: {
  id?: string;
  snapshotKind?: FleetSnapshotKind;
  status: string;
  summary?: unknown;
  error?: string | null;
  observedAt: Date;
  createdAt?: Date;
} | null) {
  if (!snapshot) return null;
  return {
    id: snapshot.id ?? null,
    snapshotKind: snapshot.snapshotKind ?? null,
    status: snapshot.status,
    summary: jsonRecordOrNull(snapshot.summary) ? redactObject(snapshot.summary as JsonRecord) : null,
    error: snapshot.error ?? null,
    observedAt: snapshot.observedAt,
    createdAt: snapshot.createdAt ?? null,
  };
}

function compactSelfServeSmokeSummary(value: unknown) {
  const summary = jsonRecordOrNull(value);
  if (!summary) return null;
  const steps = Array.isArray(summary.steps)
    ? summary.steps.map((step) => {
      const record = jsonRecordOrNull(step) ?? {};
      return {
        name: typeof record.name === "string" ? record.name : null,
        status: typeof record.status === "string" ? record.status : null,
      };
    })
    : [];
  const warnings = Array.isArray(summary.warnings)
    ? summary.warnings.map((warning) => {
      const record = jsonRecordOrNull(warning) ?? {};
      return {
        name: typeof record.name === "string" ? record.name : null,
        status: typeof record.status === "string" ? record.status : null,
      };
    })
    : [];
  return { steps, warnings };
}

function providerMetadataCostSummary(metadata: unknown) {
  const record = jsonRecordOrNull(metadata);
  const azure = jsonRecordOrNull(record?.azure);
  const summary = firstJsonRecord(
    record?.costSummary,
    record?.cost,
    record?.monthlyCost,
    azure?.costSummary,
    azure?.cost,
    azure?.monthlyCost,
  );
  if (summary) return redactObject(summary);
  const estimatedMonthlyUsd = record?.estimatedMonthlyUsd ?? azure?.estimatedMonthlyUsd;
  const currentMonthUsd = record?.currentMonthUsd ?? azure?.currentMonthUsd;
  if (estimatedMonthlyUsd !== undefined || currentMonthUsd !== undefined) {
    return redactObject({
      estimatedMonthlyUsd,
      currentMonthUsd,
    });
  }
  return null;
}

function registrySyncSummary(event: {
  id: string;
  meta: unknown;
  createdAt: Date;
} | null) {
  if (!event) return null;
  const meta = jsonRecordOrNull(event.meta) ?? {};
  const items = Array.isArray(meta.items) ? meta.items : [];
  return {
    eventId: event.id,
    sourceId: typeof meta.sourceId === "string" ? meta.sourceId : null,
    sourceUrl: typeof meta.sourceUrl === "string" ? meta.sourceUrl : null,
    sourceDeploymentId: typeof meta.sourceDeploymentId === "string" ? meta.sourceDeploymentId : null,
    itemCount: typeof meta.itemCount === "number" ? meta.itemCount : items.length,
    summary: jsonRecordOrNull(meta.summary) ? redactObject(meta.summary as JsonRecord) : null,
    receivedAt: typeof meta.receivedAt === "string" ? meta.receivedAt : null,
    createdAt: event.createdAt,
  };
}

export type ControlPlaneCustomerSummary = {
  id: string;
  label: string;
  customerSlug: string | null;
  customerAccountId: string | null;
  primaryDeploymentId: string | null;
  url: string;
  customDomain: string | null;
  hasDeployment: boolean;
  deploymentKind: CustomerDeploymentKind | null;
  deploymentStatus: CustomerDeploymentStatus | null;
  environment: string | null;
  cloudProvider: CustomerDeploymentCloudProvider | null;
  providerLabel: string | null;
  providerProjectId: string | null;
  providerEnvironmentId: string | null;
  providerResourceGroup: string | null;
  providerWebServiceId: string | null;
  providerWorkerServiceId: string | null;
  providerLogsUrl: string | null;
  providerCostUrl: string | null;
  hasSupportCredential: boolean;
  supportConnectorStatus: string | null;
  supportConnectorLabel: string;
  supportConnectorDetail: string;
  supportAccessMode: "enterprise_connector" | "managed_workspace" | "self_serve_sessions" | "account_only";
  lastHealthStatus: string | null;
  lastHealthError: string | null;
  lastHealthCheck: Date | null;
  lastReleaseCheck: Date | null;
  releaseImageTag: string | null;
  releaseVersion: string | null;
  managedWorkspaceId: string | null;
  managedWorkspaceSlug: string | null;
  managedWorkspaceName: string | null;
  remoteWorkspaceSlug: string | null;
  remoteWorkspaceId: string | null;
  provisioningStatus: string | null;
  supportOperations: [];
};

const controlPlaneCustomerSummaryDeploymentSelect = {
  id: true,
  label: true,
  url: true,
  customDomain: true,
  customerSlug: true,
  customerAccountId: true,
  deploymentKind: true,
  deploymentStatus: true,
  environment: true,
  cloudProvider: true,
  remoteWorkspaceSlug: true,
  remoteWorkspaceId: true,
  provisioningStatus: true,
  releaseImageTag: true,
  releaseVersion: true,
  lastHealthStatus: true,
  lastHealthError: true,
  lastHealthCheck: true,
  lastReleaseCheck: true,
  supportCredentialEnc: true,
  supportConnectorStatus: true,
  supportLastSyncError: true,
  managedWorkspaceId: true,
  railwayProjectId: true,
  railwayEnvironmentId: true,
  railwayWebServiceId: true,
  railwayWorkerServiceId: true,
  railwayPostgresServiceId: true,
  railwayRedisServiceId: true,
  providerSubscriptionId: true,
  providerResourceGroup: true,
  providerProjectId: true,
  providerEnvironmentId: true,
  providerWebServiceId: true,
  providerWorkerServiceId: true,
  providerPostgresServiceId: true,
  providerRedisServiceId: true,
  providerStorageResourceId: true,
  providerLogsUrl: true,
  providerCostUrl: true,
  providerMetadata: true,
  storageBucketName: true,
  createdAt: true,
  updatedAt: true,
  managedWorkspace: {
    select: {
      id: true,
      slug: true,
      name: true,
    },
  },
} satisfies Prisma.CustomerDeploymentSelect;

type ControlPlaneCustomerSummaryDeployment = Prisma.CustomerDeploymentGetPayload<{
  select: typeof controlPlaneCustomerSummaryDeploymentSelect;
}>;

type ControlPlaneCustomerSummaryRow = ControlPlaneCustomerSummary & {
  sortDate: Date;
  queryValues: string[];
  healthValue: string;
  supportValue: string;
};

function controlPlaneCustomerSummaryFromDeployment(params: {
  deployment: ControlPlaneCustomerSummaryDeployment;
  account?: {
    id: string;
    slug: string;
    displayName: string;
    primaryDeploymentId: string | null;
    updatedAt: Date;
  } | null;
}): ControlPlaneCustomerSummaryRow {
  const deployment = params.deployment;
  const customerSlug = deployment.customerSlug
    ?? params.account?.slug
    ?? deployment.remoteWorkspaceSlug
    ?? null;
  const provider = buildCustomerDeploymentProviderReadModel(deployment);
  const support = controlPlaneCustomerSupportSummary(deployment);
  const summary: ControlPlaneCustomerSummary = {
    id: deployment.id,
    label: deployment.label || params.account?.displayName || customerSlug || deployment.id,
    customerSlug,
    customerAccountId: deployment.customerAccountId,
    primaryDeploymentId: params.account?.primaryDeploymentId ?? null,
    url: deployment.url,
    customDomain: deployment.customDomain,
    hasDeployment: true,
    deploymentKind: deployment.deploymentKind,
    deploymentStatus: deployment.deploymentStatus ?? null,
    environment: deployment.environment ?? null,
    cloudProvider: provider.cloudProvider,
    providerLabel: provider.providerLabel,
    providerProjectId: provider.providerProjectId,
    providerEnvironmentId: provider.providerEnvironmentId,
    providerResourceGroup: provider.providerResourceGroup,
    providerWebServiceId: provider.providerWebServiceId,
    providerWorkerServiceId: provider.providerWorkerServiceId,
    providerLogsUrl: provider.providerLogsUrl,
    providerCostUrl: provider.providerCostUrl,
    hasSupportCredential: Boolean(deployment.supportCredentialEnc),
    supportConnectorStatus: support.supportConnectorStatus,
    supportConnectorLabel: support.supportConnectorLabel,
    supportConnectorDetail: support.supportConnectorDetail,
    supportAccessMode: support.supportAccessMode,
    lastHealthStatus: deployment.lastHealthStatus,
    lastHealthError: deployment.lastHealthError,
    lastHealthCheck: deployment.lastHealthCheck,
    lastReleaseCheck: deployment.lastReleaseCheck,
    releaseImageTag: deployment.releaseImageTag,
    releaseVersion: deployment.releaseVersion,
    managedWorkspaceId: deployment.managedWorkspaceId,
    managedWorkspaceSlug: deployment.managedWorkspace?.slug ?? null,
    managedWorkspaceName: deployment.managedWorkspace?.name ?? null,
    remoteWorkspaceSlug: deployment.remoteWorkspaceSlug,
    remoteWorkspaceId: deployment.remoteWorkspaceId,
    provisioningStatus: deployment.provisioningStatus,
    supportOperations: [],
  };

  return {
    ...summary,
    sortDate: deployment.updatedAt ?? deployment.createdAt ?? params.account?.updatedAt ?? new Date(0),
    healthValue: normalizedStatus(summary.lastHealthStatus || summary.provisioningStatus),
    supportValue: normalizedStatus(summary.supportConnectorStatus),
    queryValues: [
      summary.label,
      summary.customerSlug,
      summary.customerAccountId,
      summary.primaryDeploymentId,
      summary.url,
      summary.customDomain,
      summary.deploymentStatus,
      summary.environment,
      summary.managedWorkspaceId,
      summary.managedWorkspaceSlug,
      summary.managedWorkspaceName,
      summary.remoteWorkspaceSlug,
      summary.remoteWorkspaceId,
      summary.lastHealthStatus,
      summary.lastHealthError,
      summary.releaseImageTag,
      summary.releaseVersion,
      summary.provisioningStatus,
      summary.providerLabel,
      summary.providerProjectId,
      summary.providerEnvironmentId,
      summary.providerResourceGroup,
      params.account?.displayName,
      params.account?.slug,
    ].filter((value): value is string => Boolean(value)),
  };
}

function controlPlaneCustomerSummaryFromAccount(account: {
  id: string;
  slug: string;
  displayName: string;
  createdAt: Date;
  updatedAt: Date;
}): ControlPlaneCustomerSummaryRow {
  const summary: ControlPlaneCustomerSummary = {
    id: account.id,
    label: account.displayName,
    customerSlug: account.slug,
    customerAccountId: account.id,
    primaryDeploymentId: null,
    url: "",
    customDomain: null,
    hasDeployment: false,
    deploymentKind: null,
    deploymentStatus: null,
    environment: null,
    cloudProvider: null,
    providerLabel: null,
    providerProjectId: null,
    providerEnvironmentId: null,
    providerResourceGroup: null,
    providerWebServiceId: null,
    providerWorkerServiceId: null,
    providerLogsUrl: null,
    providerCostUrl: null,
    hasSupportCredential: false,
    supportConnectorStatus: "not_configured",
    supportConnectorLabel: "Deployment required",
    supportConnectorDetail: "Deployment must be provisioned before support access can be configured.",
    supportAccessMode: "account_only",
    lastHealthStatus: null,
    lastHealthError: null,
    lastHealthCheck: null,
    lastReleaseCheck: null,
    releaseImageTag: null,
    releaseVersion: null,
    managedWorkspaceId: null,
    managedWorkspaceSlug: null,
    managedWorkspaceName: null,
    remoteWorkspaceSlug: null,
    remoteWorkspaceId: null,
    provisioningStatus: "draft",
    supportOperations: [],
  };

  return {
    ...summary,
    sortDate: account.updatedAt ?? account.createdAt,
    healthValue: normalizedStatus(summary.provisioningStatus),
    supportValue: normalizedStatus(summary.supportConnectorStatus),
    queryValues: [summary.label, summary.customerSlug, summary.provisioningStatus].filter((value): value is string => Boolean(value)),
  };
}

function controlPlaneCustomerSummaryMatches(row: ControlPlaneCustomerSummaryRow, filters: {
  query: string;
  health: string;
  support: string;
}) {
  return (!filters.query || row.queryValues.some((value) => value.toLowerCase().includes(filters.query)))
    && (!filters.health || row.healthValue === filters.health)
    && (!filters.support || row.supportValue === filters.support);
}

export async function listControlPlaneCustomerSummaries(actor: AppActor, params: {
  query?: string | null;
  health?: string | null;
  support?: string | null;
  limit?: number | null;
  includeAllDeployments?: boolean | null;
  uncapped?: boolean | null;
} = {}): Promise<ControlPlaneCustomerSummary[]> {
  await requireControlPlaneAccess(actor);
  const limit = params.uncapped === true ? Number.MAX_SAFE_INTEGER : boundedInteger(params.limit, 500, 1, 500);
  const filters = {
    query: params.query?.trim().toLowerCase() ?? "",
    health: params.health?.trim().toLowerCase() ?? "",
    support: params.support?.trim().toLowerCase() ?? "",
  };

  const accounts = await prisma.customerAccount.findMany({
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      slug: true,
      displayName: true,
      primaryDeploymentId: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  const accountIds = accounts.map((account) => account.id);
  const deployments = await prisma.customerDeployment.findMany({
    where: accountIds.length
      ? {
          OR: [
            { customerAccountId: { in: accountIds } },
            { customerAccountId: null },
          ],
        }
      : { customerAccountId: null },
    orderBy: { createdAt: "desc" },
    select: controlPlaneCustomerSummaryDeploymentSelect,
  });

  const deploymentsByAccount = new Map<string, ControlPlaneCustomerSummaryDeployment[]>();
  const orphanedDeployments: ControlPlaneCustomerSummaryDeployment[] = [];
  for (const deployment of deployments) {
    if (!deployment.customerAccountId) {
      orphanedDeployments.push(deployment);
      continue;
    }
    const accountDeployments = deploymentsByAccount.get(deployment.customerAccountId) ?? [];
    accountDeployments.push(deployment);
    deploymentsByAccount.set(deployment.customerAccountId, accountDeployments);
  }

  const accountRows = accounts.flatMap((account) => {
    const accountDeployments = deploymentsByAccount.get(account.id) ?? [];
    const deployment = accountDeployments.find((candidate) => candidate.id === account.primaryDeploymentId)
      ?? accountDeployments.find((candidate) => candidate.deploymentStatus === "ACTIVE")
      ?? accountDeployments[0]
      ?? null;
    const selectedDeployments = params.includeAllDeployments
      ? accountDeployments
      : deployment ? [deployment] : [];
    return selectedDeployments.length > 0
      ? selectedDeployments.map((candidate) => controlPlaneCustomerSummaryFromDeployment({ deployment: candidate, account }))
      : [controlPlaneCustomerSummaryFromAccount(account)];
  });
  const orphanedRows = orphanedDeployments.map((deployment) => controlPlaneCustomerSummaryFromDeployment({
    deployment,
    account: null,
  }));

  return [...accountRows, ...orphanedRows]
    .filter((row) => controlPlaneCustomerSummaryMatches(row, filters))
    .sort((a, b) => b.sortDate.getTime() - a.sortDate.getTime())
    .slice(0, limit)
    .map(({ sortDate: _sortDate, queryValues: _queryValues, healthValue: _healthValue, supportValue: _supportValue, ...summary }) => summary);
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
  if (isControlPlaneAzureDeployment(row)) {
    return {
      status: row.supportConnectorStatus === "degraded" ? "degraded" : "ready",
      detail: row.supportConnectorStatus === "degraded"
        ? row.supportLastSyncError || "Azure self-serve support sessions need attention."
        : "Azure self-serve uses audited support sessions and provider read-model inspection.",
      mode: "remote",
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

type BatchedToolSummaryState = Awaited<ReturnType<typeof loadBatchedToolSummaryState>>;

function incrementCount(map: Map<string, number>, workspaceId: string | null | undefined) {
  if (!workspaceId) return;
  map.set(workspaceId, (map.get(workspaceId) ?? 0) + 1);
}

async function loadBatchedToolSummaryState(workspaceIds: string[]) {
  const uniqueWorkspaceIds = [...new Set(workspaceIds.filter(Boolean))];
  const empty = {
    toolLinksByWorkspaceId: new Map<string, number>(),
    credentialsByWorkspaceId: new Map<string, number>(),
    appsByWorkspaceId: new Map<string, number>(),
    communicationByWorkspaceId: new Map<string, number>(),
    featureFlagsByWorkspaceId: new Map<string, number>(),
  };
  if (uniqueWorkspaceIds.length === 0) return empty;

  const [
    toolLinks,
    credentials,
    apps,
    communicationInstallations,
    featureFlags,
  ] = await Promise.all([
    prisma.workspaceToolLink.findMany({
      where: {
        workspaceId: { in: uniqueWorkspaceIds },
        archivedAt: null,
      },
      select: { workspaceId: true },
    }),
    prisma.agentCredential.findMany({
      where: {
        workspaceId: { in: uniqueWorkspaceIds },
        isActive: true,
      },
      select: { workspaceId: true },
    }),
    prisma.appInstallation.findMany({
      where: {
        workspaceId: { in: uniqueWorkspaceIds },
        status: { not: "DISABLED" },
      },
      select: { workspaceId: true },
    }),
    prisma.communicationInstallation.findMany({
      where: {
        workspaceId: { in: uniqueWorkspaceIds },
        status: "ACTIVE",
      },
      select: { workspaceId: true },
    }),
    prisma.workspaceFeatureFlag.findMany({
      where: {
        workspaceId: { in: uniqueWorkspaceIds },
        enabled: true,
        flag: { in: Array.from(CONTROL_PLANE_TOOL_FEATURE_FLAGS) },
      },
      select: { workspaceId: true },
    }),
  ]);

  const toolLinksByWorkspaceId = new Map<string, number>();
  const credentialsByWorkspaceId = new Map<string, number>();
  const appsByWorkspaceId = new Map<string, number>();
  const communicationByWorkspaceId = new Map<string, number>();
  const featureFlagsByWorkspaceId = new Map<string, number>();
  for (const row of toolLinks) incrementCount(toolLinksByWorkspaceId, row.workspaceId);
  for (const row of credentials) incrementCount(credentialsByWorkspaceId, row.workspaceId);
  for (const row of apps) incrementCount(appsByWorkspaceId, row.workspaceId);
  for (const row of communicationInstallations) incrementCount(communicationByWorkspaceId, row.workspaceId);
  for (const row of featureFlags) incrementCount(featureFlagsByWorkspaceId, row.workspaceId);

  return {
    toolLinksByWorkspaceId,
    credentialsByWorkspaceId,
    appsByWorkspaceId,
    communicationByWorkspaceId,
    featureFlagsByWorkspaceId,
  };
}

function controlPlaneToolSummary(row: ControlPlaneDeploymentRow, state: BatchedToolSummaryState): ControlPlaneToolSummary {
  if (!row.hasDeployment) {
    return {
      status: "unavailable",
      detail: "Deployment not provisioned.",
      total: null,
      toolLinks: null,
      agentCredentials: null,
      enterpriseApps: null,
      communicationIntegrations: null,
      enabledToolFlags: null,
    };
  }
  if (!row.managedWorkspaceId) {
    return {
      status: "available",
      detail: "Remote enterprise tool inventory is not mirrored locally.",
      total: null,
      toolLinks: null,
      agentCredentials: null,
      enterpriseApps: null,
      communicationIntegrations: null,
      enabledToolFlags: null,
    };
  }

  const toolLinks = state.toolLinksByWorkspaceId.get(row.managedWorkspaceId) ?? 0;
  const agentCredentials = state.credentialsByWorkspaceId.get(row.managedWorkspaceId) ?? 0;
  const enterpriseApps = state.appsByWorkspaceId.get(row.managedWorkspaceId) ?? 0;
  const communicationIntegrations = state.communicationByWorkspaceId.get(row.managedWorkspaceId) ?? 0;
  const enabledToolFlags = state.featureFlagsByWorkspaceId.get(row.managedWorkspaceId) ?? 0;
  const total = toolLinks + agentCredentials + enterpriseApps + communicationIntegrations + enabledToolFlags;

  return {
    status: total > 0 ? "active" : "empty",
    detail: total > 0
      ? `${total} local tool/app signal(s).`
      : "No local tool or app signals recorded.",
    total,
    toolLinks,
    agentCredentials,
    enterpriseApps,
    communicationIntegrations,
    enabledToolFlags,
  };
}

function controlPlaneLastCheckedAt(row: ControlPlaneDeploymentRow, recorder: ControlPlaneRecorderMatrixRow) {
  const candidates = [
    row.lastHealthCheck,
    row.lastReleaseCheck,
    row.supportLastSyncAt,
    recorder.observedAt,
    latestSnapshotForKind(row, "HEALTH")?.observedAt,
    latestSnapshotForKind(row, "RELEASE")?.observedAt,
    latestSnapshotForKind(row, "SUPPORT_READY")?.observedAt,
    latestSnapshotForKind(row, "INTEGRATION")?.observedAt,
    row.updatedAt,
  ].filter((value): value is Date => value instanceof Date);
  if (candidates.length === 0) return null;
  return candidates.sort((left, right) => right.getTime() - left.getTime())[0] ?? null;
}

function controlPlaneMatrixFilterFlags(params: Parameters<typeof listControlPlaneFleetPage>[1] = {}) {
  return {
    unhealthy: booleanFilter(params.unhealthy),
    issues: booleanFilter(params.issues),
    missingTools: booleanFilter(params.missingTools),
    stale: booleanFilter(params.stale),
  };
}

function hasControlPlaneMatrixFilters(params: Parameters<typeof listControlPlaneFleetPage>[1] = {}) {
  const filters = controlPlaneMatrixFilterFlags(params);
  return filters.unhealthy || filters.issues || filters.missingTools || filters.stale;
}

function controlPlaneMatrixRowIsStale(row: ControlPlaneMatrixRow, now = new Date()) {
  return !row.lastCheckedAt || now.getTime() - row.lastCheckedAt.getTime() > CONTROL_PLANE_STALE_AFTER_MS;
}

function controlPlaneMatrixRowMatchesFilters(
  row: ControlPlaneMatrixRow,
  filters: ReturnType<typeof controlPlaneMatrixFilterFlags>,
  now: Date,
) {
  if (filters.unhealthy && row.health.tone === "ok") return false;
  if (filters.issues && row.issues.length === 0) return false;
  if (filters.missingTools && !["empty", "unavailable"].includes(row.tools.status)) return false;
  if (filters.stale && !controlPlaneMatrixRowIsStale(row, now)) return false;
  return true;
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

function recorderMonthBounds(now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start, end };
}

function controlPlaneRecorderRuntimeChecks(config: {
  defaultProvider: MeetingRecorderProvider;
  fallbackProvider?: MeetingRecorderProvider | null;
}) {
  const providers = new Set<MeetingRecorderProvider>([config.defaultProvider]);
  if (config.fallbackProvider) providers.add(config.fallbackProvider);
  const checks = [
    {
      key: "public_base_url",
      label: "Public recorder URL",
      ok: Boolean(env.MEETING_RECORDER_PUBLIC_BASE_URL),
      detail: env.MEETING_RECORDER_PUBLIC_BASE_URL ? "Configured." : "MEETING_RECORDER_PUBLIC_BASE_URL is missing.",
    },
  ];
  if (providers.has("RECALL_AI")) {
    checks.push(
      {
        key: "recall_api_key",
        label: "Recall API key",
        ok: Boolean(env.RECALL_API_KEY),
        detail: env.RECALL_API_KEY ? "Configured." : "RECALL_API_KEY is missing.",
      },
      {
        key: "recall_webhook_secret",
        label: "Recall webhook secret",
        ok: Boolean(env.RECALL_WEBHOOK_SECRET),
        detail: env.RECALL_WEBHOOK_SECRET ? "Configured." : "RECALL_WEBHOOK_SECRET is missing.",
      },
    );
  }
  if (providers.has("MEETING_BAAS")) {
    checks.push(
      {
        key: "meeting_baas_api_key",
        label: "Meeting BaaS API key",
        ok: Boolean(env.MEETING_BAAS_API_KEY),
        detail: env.MEETING_BAAS_API_KEY ? "Configured." : "MEETING_BAAS_API_KEY is missing.",
      },
      {
        key: "meeting_baas_webhook_secret",
        label: "Meeting BaaS webhook secret",
        ok: Boolean(env.MEETING_BAAS_WEBHOOK_SECRET),
        detail: env.MEETING_BAAS_WEBHOOK_SECRET ? "Configured." : "MEETING_BAAS_WEBHOOK_SECRET is missing.",
      },
    );
  }
  return checks;
}

function sanitizeDiagnosticText(value: string | null | undefined) {
  const input = value?.trim() || "No detail recorded.";
  return input
    .replace(/\b(?:Bearer\s+)?(?:ghp|gho|ghu|ghs|ghr|github_pat|sk|xox[baprs])_[A-Za-z0-9_=-]{16,}\b/g, "[redacted-token]")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[redacted-token]")
    .slice(0, 1_200);
}

function recorderAvailability(params: {
  hasDeployment: boolean;
  hasSupportCredential?: boolean;
  entitlementEnabled: boolean | null;
  configured: boolean | null;
  configEnabled?: boolean | null;
  rawStatus?: string | null;
  detail: string;
}): ControlPlaneRecorderMatrixRow["availability"] {
  const rawStatus = normalizedStatus(params.rawStatus);
  if (!params.hasDeployment) {
    return { status: "unavailable", detail: "Deployment is not provisioned yet." };
  }
  if (params.entitlementEnabled === true && params.configured === true) {
    return {
      status: "available",
      detail: params.configEnabled === false
        ? "Recorder entitlement and config exist, but recording is disabled."
        : "Recorder entitlement and configuration are available.",
    };
  }
  if (rawStatus === "enabled" || rawStatus === "active" || rawStatus === "ready") {
    return { status: "available", detail: "Recorder is available in the cached integration snapshot." };
  }
  if (params.entitlementEnabled === false || rawStatus === "disabled") {
    return { status: "disabled", detail: "Recorder entitlement or configuration is disabled." };
  }
  if (params.configured === false || rawStatus === "needs_setup") {
    return { status: "not_configured", detail: "Recorder setup is incomplete." };
  }
  if (params.hasSupportCredential === false) {
    return { status: "requires_connector", detail: "Support connector is required for remote recorder visibility." };
  }
  return { status: "unavailable", detail: params.detail };
}

function fallbackRecorderRow(row: ControlPlaneDeploymentRow, status: ControlPlaneRecorderMatrixStatus, detail: string): ControlPlaneRecorderMatrixRow {
  const availability = recorderAvailability({
    hasDeployment: row.hasDeployment,
    hasSupportCredential: row.hasSupportCredential,
    entitlementEnabled: null,
    configured: null,
    detail,
  });
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
    availability,
    observedAt: null,
    readiness: {
      ready: null,
      detail,
      failedChecks: [],
    },
    calendarSource: null,
    lastSmokeRun: null,
  };
}

type RemoteRecorderEntitlement = {
  customerAccountId: string;
  deploymentId: string | null;
  scopeKey: string;
  enabled: boolean;
  status: string;
  evidence: Prisma.JsonValue | null;
  createdAt: Date;
  updatedAt: Date;
};

type BatchedRemoteRecorderState = {
  entitlementByDeploymentId: Map<string, RemoteRecorderEntitlement>;
  entitlementByAccountScope: Map<string, RemoteRecorderEntitlement>;
  entitlementByAccountId: Map<string, RemoteRecorderEntitlement>;
};

function newerRemoteEntitlement(
  current: RemoteRecorderEntitlement | undefined,
  candidate: RemoteRecorderEntitlement,
) {
  return !current || candidate.updatedAt > current.updatedAt ? candidate : current;
}

async function loadBatchedRemoteRecorderState(rows: ControlPlaneDeploymentRow[]): Promise<BatchedRemoteRecorderState> {
  const remoteRows = rows.filter((row) => row.hasDeployment && !row.managedWorkspaceId);
  const deploymentIds = [...new Set(remoteRows.map((row) => row.id))];
  const customerAccountIds = [...new Set(remoteRows.map((row) => row.customerAccountId).filter((id): id is string => Boolean(id)))];
  const whereClauses: Prisma.CustomerEntitlementWhereInput[] = [];
  if (deploymentIds.length > 0) {
    whereClauses.push({ deploymentId: { in: deploymentIds } });
  }
  if (customerAccountIds.length > 0) {
    whereClauses.push({ customerAccountId: { in: customerAccountIds } });
  }
  if (whereClauses.length === 0) {
    return {
      entitlementByDeploymentId: new Map(),
      entitlementByAccountScope: new Map(),
      entitlementByAccountId: new Map(),
    };
  }

  const entitlements = await prisma.customerEntitlement.findMany({
    where: {
      entitlementKey: MEETING_RECORDERS_FEATURE_FLAG,
      OR: whereClauses,
    },
    orderBy: { updatedAt: "desc" },
    select: {
      customerAccountId: true,
      deploymentId: true,
      scopeKey: true,
      enabled: true,
      status: true,
      evidence: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  const entitlementByDeploymentId = new Map<string, RemoteRecorderEntitlement>();
  const entitlementByAccountScope = new Map<string, RemoteRecorderEntitlement>();
  const entitlementByAccountId = new Map<string, RemoteRecorderEntitlement>();
  for (const entitlement of entitlements) {
    if (entitlement.deploymentId) {
      entitlementByDeploymentId.set(
        entitlement.deploymentId,
        newerRemoteEntitlement(entitlementByDeploymentId.get(entitlement.deploymentId), entitlement),
      );
    }
    const accountScopeKey = `${entitlement.customerAccountId}:${entitlement.scopeKey}`;
    entitlementByAccountScope.set(
      accountScopeKey,
      newerRemoteEntitlement(entitlementByAccountScope.get(accountScopeKey), entitlement),
    );
    entitlementByAccountId.set(
      entitlement.customerAccountId,
      newerRemoteEntitlement(entitlementByAccountId.get(entitlement.customerAccountId), entitlement),
    );
  }

  return { entitlementByDeploymentId, entitlementByAccountScope, entitlementByAccountId };
}

function remoteRecorderEntitlementForRow(row: ControlPlaneDeploymentRow, state: BatchedRemoteRecorderState) {
  const deploymentEntitlement = state.entitlementByDeploymentId.get(row.id);
  if (deploymentEntitlement) return deploymentEntitlement;
  if (!row.customerAccountId) return null;
  return state.entitlementByAccountScope.get(`${row.customerAccountId}:deployment:${row.id}`)
    ?? state.entitlementByAccountId.get(row.customerAccountId)
    ?? null;
}

function remoteRecorderEntitlementEnabled(entitlement: RemoteRecorderEntitlement | null | undefined) {
  if (!entitlement) return null;
  const status = normalizedStatus(entitlement.status);
  if (status === "disabled" || status === "suspended") return false;
  if (status === "enabled") return true;
  return entitlement.enabled;
}

function remoteRecorderEvidence(entitlement: RemoteRecorderEntitlement | null | undefined) {
  const evidence = jsonRecord(entitlement?.evidence);
  const configEnabled = booleanField(evidence?.configEnabled);
  const provider = recorderProviderFromValue(evidence?.defaultProvider);
  const monthlyMinuteCap = typeof evidence?.monthlyMinuteCap === "number" && Number.isFinite(evidence.monthlyMinuteCap)
    ? Math.trunc(evidence.monthlyMinuteCap)
    : null;
  const configured = configEnabled !== null || provider !== null || monthlyMinuteCap !== null ? true : null;
  return { configEnabled, configured, provider, monthlyMinuteCap };
}

function remoteRecorderEntitlementRow(
  row: ControlPlaneDeploymentRow,
  entitlement: RemoteRecorderEntitlement,
  detail = "No cached recorder integration snapshot is available.",
): ControlPlaneRecorderMatrixRow {
  const evidence = remoteRecorderEvidence(entitlement);
  const entitlementEnabled = remoteRecorderEntitlementEnabled(entitlement);
  const failedChecks = entitlementEnabled
    ? evidence.configured
      ? [{
          key: "remote_snapshot",
          label: "Remote recorder snapshot",
          detail,
        }]
      : [{
          key: "recorder_config",
          label: "Recorder config",
          detail: "Recorder entitlement exists, but cached configuration evidence is missing.",
        }]
    : [];
  const readinessDetail = failedChecks[0]?.detail ?? "Recorder entitlement is disabled.";
  const availability = recorderAvailability({
    hasDeployment: row.hasDeployment,
    hasSupportCredential: row.hasSupportCredential,
    entitlementEnabled,
    configured: evidence.configured,
    configEnabled: evidence.configEnabled,
    detail: readinessDetail,
  });
  const status: ControlPlaneRecorderMatrixStatus = !entitlementEnabled
    ? "disabled"
    : evidence.configured
      ? evidence.configEnabled === false ? "disabled" : "needs_setup"
      : "needs_setup";

  return {
    deploymentId: row.id,
    clientLabel: row.label,
    clientSlug: controlPlaneRowSlug(row),
    hasDeployment: row.hasDeployment,
    hasManagedWorkspace: false,
    supportConnectorStatus: row.supportConnectorStatus,
    entitlementEnabled,
    configured: evidence.configured,
    provider: evidence.provider,
    monthlyUsageMinutes: null,
    monthlyMinuteCap: evidence.monthlyMinuteCap,
    failureCount: null,
    status,
    availability,
    observedAt: entitlement.updatedAt ?? entitlement.createdAt ?? null,
    readiness: {
      ready: entitlementEnabled ? false : null,
      detail: sanitizeDiagnosticText(readinessDetail),
      failedChecks,
    },
    calendarSource: null,
    lastSmokeRun: null,
  };
}

function cachedRemoteRecorderRow(row: ControlPlaneDeploymentRow, entitlement?: RemoteRecorderEntitlement | null): ControlPlaneRecorderMatrixRow {
  const snapshot = latestSnapshotForKind(row, "INTEGRATION");
  const summary = jsonRecord(snapshot?.summary);
  const integrations = arrayItems(summary?.integrations, ["items", "integrations"]);
  const recorder = integrations.find((integration) => {
    const key = stringField(integration.key)?.toLowerCase();
    const label = stringField(integration.label)?.toLowerCase();
    return key === "meeting_recorders" || key === "recorder" || Boolean(label?.includes("recorder"));
  });
  if (!recorder) {
    if (entitlement) {
      return remoteRecorderEntitlementRow(row, entitlement);
    }
    return fallbackRecorderRow(
      row,
      row.hasSupportCredential ? "unavailable" : "requires_connector",
      row.hasSupportCredential
        ? "No cached recorder integration snapshot is available."
        : "Support connector is required for remote recorder visibility.",
    );
  }

  const ready = booleanField(recorder.vendorReadiness) ?? booleanField(recorder.ready);
  const entitlementEvidence = remoteRecorderEvidence(entitlement);
  const entitlementEnabled = booleanField(recorder.entitlementEnabled) ?? remoteRecorderEntitlementEnabled(entitlement);
  const configured = booleanField(recorder.configured) ?? entitlementEvidence.configured;
  const rawStatus = normalizedStatus(stringField(recorder.status));
  const readinessRecord = jsonRecord(recorder.readiness);
  const readinessChecks = arrayItems(readinessRecord?.checks, ["checks"])
    .filter((check) => booleanField(check.ok) === false)
    .map((check) => ({
      key: stringField(check.key) ?? "remote_check",
      label: stringField(check.label) ?? "Remote recorder check",
      detail: sanitizeDiagnosticText(stringField(check.detail)),
    }));
  const readinessFailedChecks = arrayItems(readinessRecord?.failedChecks, ["failedChecks"])
    .map((check) => ({
      key: stringField(check.key) ?? "remote_check",
      label: stringField(check.label) ?? "Remote recorder check",
      detail: sanitizeDiagnosticText(stringField(check.detail)),
    }));
  const failedChecks = readinessFailedChecks.length > 0 ? readinessFailedChecks : readinessChecks;
  const availability = recorderAvailability({
    hasDeployment: row.hasDeployment,
    hasSupportCredential: row.hasSupportCredential,
    entitlementEnabled,
    configured,
    configEnabled: entitlementEvidence.configEnabled,
    rawStatus,
    detail: snapshot?.error ?? "Cached recorder state is unavailable.",
  });
  const status: ControlPlaneRecorderMatrixStatus = ready
    ? "ready"
    : entitlementEnabled === false || rawStatus === "disabled"
      ? "disabled"
      : configured === false || rawStatus === "needs_setup"
        ? "needs_setup"
        : rawStatus === "enabled" || rawStatus === "active"
          ? "needs_setup"
          : entitlementEnabled === true && configured === true
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
    provider: recorderProviderFromValue(recorder.provider) ?? entitlementEvidence.provider,
    monthlyUsageMinutes: typeof usage?.usedMinutes === "number" ? usage.usedMinutes : null,
    monthlyMinuteCap: typeof recorder.monthlyMinuteCap === "number" ? recorder.monthlyMinuteCap : entitlementEvidence.monthlyMinuteCap,
    failureCount: failures,
    status,
    availability,
    observedAt: snapshot?.observedAt ?? snapshot?.createdAt ?? entitlement?.updatedAt ?? null,
    readiness: {
      ready,
      detail: sanitizeDiagnosticText(snapshot?.error ?? failedChecks[0]?.detail ?? (ready ? "Cached recorder snapshot is ready." : "Cached recorder snapshot needs review.")),
      failedChecks,
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

type BatchedManagedRecorderState = Awaited<ReturnType<typeof loadBatchedManagedRecorderState>>;

async function loadBatchedManagedRecorderState(workspaceIds: string[]) {
  const uniqueWorkspaceIds = [...new Set(workspaceIds.filter(Boolean))];
  const { start, end } = recorderMonthBounds();
  if (uniqueWorkspaceIds.length === 0) {
    return {
      entitlementByWorkspaceId: new Map<string, boolean>(),
      configByWorkspaceId: new Map<string, { enabled: boolean; autoRecordEnabled: boolean; defaultProvider: MeetingRecorderProvider; fallbackProvider: MeetingRecorderProvider | null; monthlyMinuteCap: number; updatedAt?: Date }>(),
      calendarSourceByWorkspaceId: new Map<string, { providerAccountId: string; providerAccountEmail: string | null; status: string; lastSyncAt: Date | null; lastSyncError: string | null; updatedAt?: Date }>(),
      lastSmokeRunByWorkspaceId: new Map<string, { status: string; createdAt: Date; completedAt?: Date | null; failureMessage?: string | null }>(),
      providerProofObservedAtByWorkspaceId: new Map<string, Date>(),
      providerAuthFailureByWorkspaceId: new Map<string, { failureCode: string | null; failureMessage: string | null; updatedAt: Date }>(),
      usageMinutesByWorkspaceId: new Map<string, number>(),
      failureCountByWorkspaceId: new Map<string, number>(),
      failedSyncCountByWorkspaceId: new Map<string, number>(),
      internalScheduleCountByWorkspaceId: new Map<string, { eligible: number; alreadyCovered: number }>(),
    };
  }

  const now = new Date();
  const scheduleWindowEnd = new Date(now.getTime() + CONTROL_PLANE_RECORDER_SCHEDULE_LOOKAHEAD_MS);
  const providerProofSince = new Date(now.getTime() - CONTROL_PLANE_RECORDER_PROVIDER_PROOF_MAX_AGE_MS);
  const [
    entitlements,
    configs,
    calendarSources,
    smokeRuns,
    usageRows,
    failureRows,
    failedSyncJobs,
    providerProofRecordings,
    authFailureRecordings,
    upcomingMeetings,
  ] = await Promise.all([
    prisma.workspaceFeatureFlag.findMany({
      where: {
        workspaceId: { in: uniqueWorkspaceIds },
        flag: MEETING_RECORDERS_FEATURE_FLAG,
      },
      select: { workspaceId: true, enabled: true },
    }),
    prisma.workspaceMeetingRecorderConfig.findMany({
      where: { workspaceId: { in: uniqueWorkspaceIds } },
      select: {
        workspaceId: true,
        enabled: true,
        defaultProvider: true,
        fallbackProvider: true,
        autoRecordEnabled: true,
        monthlyMinuteCap: true,
        updatedAt: true,
      },
    }),
    prisma.workspaceRecorderCalendarSource.findMany({
      where: { workspaceId: { in: uniqueWorkspaceIds } },
      select: {
        workspaceId: true,
        providerAccountId: true,
        providerAccountEmail: true,
        status: true,
        lastSyncAt: true,
        lastSyncError: true,
        updatedAt: true,
      },
    }),
    prisma.meetingRecorderSmokeRun.findMany({
      where: { workspaceId: { in: uniqueWorkspaceIds } },
      orderBy: { createdAt: "desc" },
      select: {
        workspaceId: true,
        status: true,
        createdAt: true,
        completedAt: true,
        failureMessage: true,
      },
    }),
    prisma.meetingRecording.groupBy({
      by: ["workspaceId"],
      where: {
        workspaceId: { in: uniqueWorkspaceIds },
        createdAt: { gte: start, lt: end },
        status: { in: ["COMPLETED", "RECORDING"] },
      },
      _sum: { durationSeconds: true },
    }),
    prisma.meetingRecording.groupBy({
      by: ["workspaceId"],
      where: {
        workspaceId: { in: uniqueWorkspaceIds },
        status: "FAILED",
      },
      _count: { _all: true },
    }),
    prisma.workflowJob.findMany({
      where: {
        workspaceId: { in: uniqueWorkspaceIds },
        type: "meeting-recorders.calendar.sync",
        status: "FAILED",
      },
      select: {
        workspaceId: true,
        updatedAt: true,
      },
    }),
    prisma.meetingRecording.findMany({
      where: {
        workspaceId: { in: uniqueWorkspaceIds },
        OR: [
          {
            status: { in: ["COMPLETED", "RECORDING"] },
            OR: [
              { endedAt: { gte: providerProofSince } },
              { startedAt: { gte: providerProofSince } },
              { scheduledAt: { gte: providerProofSince } },
              { createdAt: { gte: providerProofSince } },
            ],
          },
          {
            status: "SCHEDULED",
            externalBotId: { not: null },
            OR: [
              { scheduledAt: { gte: now } },
              { joinAt: { gte: now } },
            ],
          },
          {
            status: "JOINING",
            externalBotId: { not: null },
            OR: [
              { scheduledAt: { gte: now } },
              { joinAt: { gte: now } },
              { startedAt: { gte: providerProofSince } },
              { updatedAt: { gte: providerProofSince } },
            ],
          },
        ],
      },
      orderBy: { updatedAt: "desc" },
      select: {
        workspaceId: true,
        status: true,
        scheduledAt: true,
        joinAt: true,
        startedAt: true,
        endedAt: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
	    prisma.meetingRecording.findMany({
	      where: {
	        workspaceId: { in: uniqueWorkspaceIds },
	        status: "FAILED",
	        updatedAt: { gte: providerProofSince },
	      },
	      orderBy: { updatedAt: "desc" },
      select: {
        workspaceId: true,
        failureCode: true,
        failureMessage: true,
        updatedAt: true,
      },
    }),
    prisma.meeting.findMany({
      where: {
        workspaceId: { in: uniqueWorkspaceIds },
        status: "SCHEDULED",
        archivedAt: null,
        recordedAt: { gte: now, lte: scheduleWindowEnd },
      },
      orderBy: { recordedAt: "asc" },
      select: {
        workspaceId: true,
        recordedAt: true,
        meetingUrl: true,
        series: {
          select: {
            meetingUrl: true,
          },
        },
        recordings: {
          where: {
            status: { in: [...CONTROL_PLANE_RECORDER_COVERAGE_RECORDING_STATUSES] },
          },
          select: {
            status: true,
            meetingUrl: true,
            failureCode: true,
          },
        },
      },
    }),
  ]);

  const entitlementByWorkspaceId = new Map(entitlements.map((flag) => [flag.workspaceId, flag.enabled]));
  const configByWorkspaceId = new Map(configs.map((config) => [config.workspaceId, config]));
  const calendarSourceByWorkspaceId = new Map(calendarSources.map((source) => [source.workspaceId, source]));
  const lastSmokeRunByWorkspaceId = new Map<string, { status: string; createdAt: Date; completedAt?: Date | null; failureMessage?: string | null }>();
  for (const smokeRun of smokeRuns) {
    if (!lastSmokeRunByWorkspaceId.has(smokeRun.workspaceId)) {
      lastSmokeRunByWorkspaceId.set(smokeRun.workspaceId, smokeRun);
    }
  }
  const providerProofObservedAtByWorkspaceId = buildControlPlaneProviderProofObservedAt({
    smokeRuns,
    recordings: providerProofRecordings,
    proofSince: providerProofSince,
  });
  const providerAuthFailureByWorkspaceId = buildControlPlaneProviderAuthFailures(authFailureRecordings);
  const usageMinutesByWorkspaceId = new Map(
    usageRows.map((row) => [row.workspaceId, Math.ceil((row._sum.durationSeconds ?? 0) / 60)]),
  );
  const failureCountByWorkspaceId = new Map(failureRows.map((row) => [row.workspaceId, row._count._all]));
  const internalScheduleCountByWorkspaceId = buildControlPlaneInternalScheduleCounts({
    meetings: upcomingMeetings,
    entitlementByWorkspaceId,
    configByWorkspaceId,
    now,
  });
  const failedSyncCountByWorkspaceId = new Map<string, number>();
  for (const job of failedSyncJobs) {
    if (!job.workspaceId) continue;
    const calendarSource = calendarSourceByWorkspaceId.get(job.workspaceId);
    if (calendarSource?.lastSyncAt && job.updatedAt <= calendarSource.lastSyncAt) continue;
    failedSyncCountByWorkspaceId.set(job.workspaceId, (failedSyncCountByWorkspaceId.get(job.workspaceId) ?? 0) + 1);
  }

  return {
    entitlementByWorkspaceId,
    configByWorkspaceId,
    calendarSourceByWorkspaceId,
    lastSmokeRunByWorkspaceId,
    providerProofObservedAtByWorkspaceId,
    providerAuthFailureByWorkspaceId,
    usageMinutesByWorkspaceId,
    failureCountByWorkspaceId,
    failedSyncCountByWorkspaceId,
    internalScheduleCountByWorkspaceId,
  };
}

function buildManagedRecorderRow(row: ControlPlaneDeploymentRow, state: BatchedManagedRecorderState): ControlPlaneRecorderMatrixRow {
  if (!row.managedWorkspaceId) return cachedRemoteRecorderRow(row);

  const config = state.configByWorkspaceId.get(row.managedWorkspaceId) ?? null;
  const effectiveConfig = {
    enabled: config?.enabled ?? false,
    defaultProvider: config?.defaultProvider ?? "RECALL_AI" as MeetingRecorderProvider,
    fallbackProvider: config?.fallbackProvider ?? null,
    monthlyMinuteCap: config?.monthlyMinuteCap ?? DEFAULT_RECORDER_MONTHLY_MINUTE_CAP,
  };
  const calendarSource = state.calendarSourceByWorkspaceId.get(row.managedWorkspaceId) ?? null;
  const lastSmokeRun = state.lastSmokeRunByWorkspaceId.get(row.managedWorkspaceId) ?? null;
  const providerProofObservedAt = state.providerProofObservedAtByWorkspaceId.get(row.managedWorkspaceId) ?? null;
  const providerAuthFailure = state.providerAuthFailureByWorkspaceId.get(row.managedWorkspaceId) ?? null;
  const providerProofBlocked = Boolean(providerAuthFailure && (!providerProofObservedAt || providerAuthFailure.updatedAt > providerProofObservedAt));
  const failedSyncJobs = state.failedSyncCountByWorkspaceId.get(row.managedWorkspaceId) ?? 0;
  const internalScheduleCount = state.internalScheduleCountByWorkspaceId.get(row.managedWorkspaceId) ?? { eligible: 0, alreadyCovered: 0 };
  const internalScheduleReadyCount = internalScheduleCount.eligible + internalScheduleCount.alreadyCovered;
  const calendarImportReady = Boolean(calendarSource?.status === "ACTIVE" && calendarSource.lastSyncAt && !calendarSource.lastSyncError && failedSyncJobs === 0);
  const entitlementEnabled = state.entitlementByWorkspaceId.get(row.managedWorkspaceId) ?? false;
  const checks = [
    {
      key: "entitlement",
      label: "Recorder entitlement",
      ok: entitlementEnabled,
      detail: entitlementEnabled ? "MEETING_RECORDERS is enabled." : "MEETING_RECORDERS feature flag is disabled.",
    },
    {
      key: "recorder_config",
      label: "Recorder config",
      ok: Boolean(config?.enabled),
      detail: config?.enabled ? `${effectiveConfig.defaultProvider} enabled.` : "Workspace recorder config is disabled.",
    },
    ...controlPlaneRecorderRuntimeChecks(effectiveConfig),
    {
      key: "recording_schedule",
      label: "Corgtex recorder schedule",
      ok: internalScheduleReadyCount > 0 || calendarImportReady,
      detail: internalScheduleCount.alreadyCovered > 0
        ? `${internalScheduleCount.alreadyCovered} upcoming Corgtex scheduled meeting(s) already have recorder coverage.`
        : internalScheduleCount.eligible > 0
          ? `${internalScheduleCount.eligible} upcoming Corgtex scheduled meeting(s) are eligible for recorder scheduling.`
        : calendarImportReady
          ? "Optional calendar sync is connected and can import recorder meetings into Corgtex."
          : "No upcoming Corgtex scheduled meetings are ready for recording. Add the meeting to Corgtex before recording; optional calendar sync is not required.",
    },
    {
      key: "provider_proof",
      label: "Recorder provider proof",
      ok: Boolean(providerProofObservedAt && !providerProofBlocked),
      detail: providerProofBlocked && providerAuthFailure
        ? controlPlaneRecorderAuthFailureDetail(providerAuthFailure)
        : providerProofObservedAt
        ? `Recent recorder provider proof at ${providerProofObservedAt.toISOString()}.`
        : "No recent successful recorder smoke, scheduled provider bot, or real recording in the last 30 days.",
    },
  ];
  const failedChecks = checks
    .filter((check) => !check.ok)
    .map((check) => ({
      key: check.key,
      label: check.label,
      detail: sanitizeDiagnosticText(check.detail),
    }));
  const ready = checks.every((check) => check.ok);
  const availability = recorderAvailability({
    hasDeployment: row.hasDeployment,
    hasSupportCredential: row.hasSupportCredential,
    entitlementEnabled,
    configured: Boolean(config),
    configEnabled: config?.enabled ?? null,
    detail: failedChecks[0]?.detail ?? "Recorder state is available.",
  });
  const status: ControlPlaneRecorderMatrixStatus = !entitlementEnabled
    ? "disabled"
    : !config
      ? "needs_setup"
      : !config.enabled
        ? "disabled"
        : ready
          ? "ready"
          : "needs_setup";
  const calendarLabel = calendarSource?.providerAccountEmail
    ?? calendarSource?.providerAccountId
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
    provider: config?.defaultProvider ?? effectiveConfig.defaultProvider,
    monthlyUsageMinutes: state.usageMinutesByWorkspaceId.get(row.managedWorkspaceId) ?? 0,
    monthlyMinuteCap: config?.monthlyMinuteCap ?? effectiveConfig.monthlyMinuteCap,
    failureCount: state.failureCountByWorkspaceId.get(row.managedWorkspaceId) ?? 0,
    status,
    availability,
    observedAt: config?.updatedAt ?? calendarSource?.updatedAt ?? providerProofObservedAt ?? lastSmokeRun?.createdAt ?? null,
    readiness: {
      ready,
      detail: failedChecks[0]?.detail ?? "Recorder readiness checks are passing.",
      failedChecks,
    },
    calendarSource: calendarSource
      ? {
        label: calendarLabel ?? "Microsoft calendar",
        status: calendarSource.status,
        lastSyncAt: calendarSource.lastSyncAt,
      }
      : null,
    lastSmokeRun: lastSmokeRun
      ? {
        status: lastSmokeRun.status,
        createdAt: lastSmokeRun.createdAt,
      }
      : null,
  };
}

async function buildControlPlaneRecorderRows(rows: ControlPlaneDeploymentRow[]) {
  const [managedState, remoteState] = await Promise.all([
    loadBatchedManagedRecorderState(
      rows.map((row) => row.managedWorkspaceId).filter((workspaceId): workspaceId is string => Boolean(workspaceId)),
    ),
    loadBatchedRemoteRecorderState(rows),
  ]);
  return rows.map((row) => {
    if (!row.hasDeployment) {
      return fallbackRecorderRow(row, "unavailable", "Deployment is not provisioned yet.");
    }
    if (!row.managedWorkspaceId) {
      return cachedRemoteRecorderRow(row, remoteRecorderEntitlementForRow(row, remoteState));
    }
    return buildManagedRecorderRow(row, managedState);
  });
}

function controlPlaneIssueSuggestedAction(source: ControlPlaneIssueSource) {
  if (source === "recorder") return "Open the recorder detail, review readiness checks, and run the appropriate recorder operation or credential setup.";
  if (source === "release") return "Open the release tab, inspect drift/preflight details, and queue or repair the rollout when approved.";
  if (source === "agents") return "Open Agent Observatory for this customer and inspect recent failed runs, credentials, and policy state.";
  if (source === "users") return "Open Users & Access and verify membership visibility or connector-backed member inspection.";
  if (source === "support") return "Refresh the support snapshot or repair the encrypted support connector configuration.";
  return "Open the deployment detail view and inspect the latest health, logs, and support operations.";
}

function controlPlaneIssuePrompt(params: {
  customer: string;
  deploymentId: string;
  source: ControlPlaneIssueSource;
  status: string;
  detail: string;
  suggestedAction: string;
}) {
  return [
    `Customer: ${params.customer}`,
    `Deployment: ${params.deploymentId}`,
    `Issue source: ${params.source}`,
    `Status: ${params.status}`,
    `Detail: ${params.detail}`,
    `Suggested action: ${params.suggestedAction}`,
    "Please diagnose the root cause in the Corgtex control-plane code or operational data and propose the smallest safe fix.",
  ].join("\n");
}

function controlPlaneIssue(params: {
  row: ControlPlaneDeploymentRow;
  source: ControlPlaneIssueSource;
  severity?: ControlPlaneIssueSeverity;
  title: string;
  status: string;
  detail: string | null | undefined;
  observedAt?: Date | null;
  suggestedAction?: string;
}): ControlPlaneIssue {
  const detail = sanitizeDiagnosticText(params.detail);
  const suggestedAction = params.suggestedAction ?? controlPlaneIssueSuggestedAction(params.source);
  return {
    id: `${params.row.id}:${params.source}:${params.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`,
    source: params.source,
    severity: params.severity ?? "warning",
    title: params.title,
    status: params.status,
    detail,
    observedAt: params.observedAt ?? null,
    suggestedAction,
    agentPrompt: controlPlaneIssuePrompt({
      customer: params.row.label,
      deploymentId: params.row.id,
      source: params.source,
      status: params.status,
      detail,
      suggestedAction,
    }),
  };
}

function controlPlaneMatrixIssues(params: {
  row: ControlPlaneDeploymentRow;
  health: ControlPlaneMatrixRow["health"];
  release: ControlPlaneMatrixRow["release"];
  support: ControlPlaneMatrixRow["support"];
  recorder: ControlPlaneRecorderMatrixRow;
  agents: ControlPlaneMatrixRow["agents"];
  users: ControlPlaneMatrixRow["users"];
}) {
  const issues: ControlPlaneIssue[] = [];
  const { row, health, release, support, recorder, agents, users } = params;
  const healthObservedAt = row.lastHealthCheck ?? latestSnapshotForKind(row, "HEALTH")?.observedAt ?? null;
  if (health.tone !== "ok") {
    issues.push(controlPlaneIssue({
      row,
      source: "health",
      severity: health.tone === "down" ? "critical" : "warning",
      title: "Deployment health needs attention",
      status: health.status,
      detail: health.detail ?? "Deployment health is not currently ok.",
      observedAt: healthObservedAt,
    }));
  }
  if (release.status === "drift") {
    issues.push(controlPlaneIssue({
      row,
      source: "release",
      title: "Release drift recorded",
      status: release.status,
      detail: release.detail,
      observedAt: row.lastReleaseCheck ?? latestSnapshotForKind(row, "RELEASE")?.observedAt ?? null,
    }));
  }
  if (recorder.availability.status !== "available" || recorder.readiness.ready === false || (recorder.failureCount ?? 0) > 0) {
    issues.push(controlPlaneIssue({
      row,
      source: "recorder",
      severity: recorder.availability.status === "unavailable" ? "critical" : "warning",
      title: recorder.availability.status === "available" ? "Recorder readiness gap" : "Recorder availability gap",
      status: recorder.availability.status === "available" ? recorder.status : recorder.availability.status,
      detail: [
        recorder.availability.detail,
        recorder.readiness.failedChecks.map((check) => `${check.label}: ${check.detail}`).join("\n"),
        (recorder.failureCount ?? 0) > 0 ? `${recorder.failureCount} failed recording(s) recorded.` : null,
      ].filter(Boolean).join("\n"),
      observedAt: recorder.observedAt,
    }));
  }
  if (["attention", "unavailable", "requires_connector"].includes(normalizedStatus(agents.status))) {
    issues.push(controlPlaneIssue({
      row,
      source: "agents",
      title: "Agent visibility needs attention",
      status: agents.status,
      detail: agents.detail,
      observedAt: latestSnapshotForKind(row, "SUPPORT_READY")?.observedAt ?? null,
    }));
  }
  if (["unavailable", "requires_connector"].includes(normalizedStatus(users.status))) {
    issues.push(controlPlaneIssue({
      row,
      source: "users",
      title: "User visibility needs attention",
      status: users.status,
      detail: users.detail,
      observedAt: latestSnapshotForKind(row, "SUPPORT_READY")?.observedAt ?? null,
    }));
  }
  if (["degraded", "not_configured", "requires_connector", "unavailable"].includes(normalizedStatus(support.status))) {
    issues.push(controlPlaneIssue({
      row,
      source: "support",
      severity: support.status === "degraded" ? "critical" : "warning",
      title: "Support connector needs attention",
      status: support.status,
      detail: support.detail,
      observedAt: row.supportLastSyncAt ?? latestSnapshotForKind(row, "SUPPORT_READY")?.observedAt ?? null,
    }));
  }
  return issues;
}

function controlPlaneMatrixRow(
  row: ControlPlaneDeploymentRow,
  recorder: ControlPlaneRecorderMatrixRow,
  toolState: BatchedToolSummaryState,
): ControlPlaneMatrixRow {
  const healthStatus = controlPlaneHealthStatus(row);
  const releaseDrift = controlPlaneReleaseDrift(row);
  const support = controlPlaneSupportSummary(row);
  const health = {
    status: healthStatus,
    tone: controlPlaneMatrixTone(healthStatus),
    detail: row.lastHealthError ?? latestSnapshotForKind(row, "HEALTH")?.error ?? null,
  };
  const release = {
    label: controlPlaneReleaseLabel(row),
    status: releaseDrift ? "drift" as const : controlPlaneReleaseLabel(row) === "Unknown" ? "unknown" as const : "aligned" as const,
    detail: releaseDrift,
  };
  const agents = controlPlaneAgentSummary(row);
  const tools = controlPlaneToolSummary(row, toolState);
  const users = controlPlaneUsersSummary(row);
  const recorderSummary = {
    status: recorder.status,
    availability: recorder.availability,
    provider: recorder.provider,
    monthlyUsageMinutes: recorder.monthlyUsageMinutes,
    failureCount: recorder.failureCount,
    readiness: recorder.readiness,
    observedAt: recorder.observedAt,
  };
  return {
    id: row.id,
    label: row.label,
    slug: controlPlaneRowSlug(row),
    hasDeployment: row.hasDeployment,
    ownerEmail: row.supportOwnerEmail,
    health,
    release,
    support,
    recorder: recorderSummary,
    agents,
    tools,
    users,
    lastCheckedAt: controlPlaneLastCheckedAt(row, recorder),
    issues: controlPlaneMatrixIssues({
      row,
      health,
      release,
      support,
      recorder,
      agents,
      users,
    }),
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
  const matrixFiltersEnabled = hasControlPlaneMatrixFilters(params);
  const requestedPageSize = boundedInteger(params.pageSize, 25, 10, 500);
  const requestedPage = boundedInteger(params.page, 1, 1, Number.MAX_SAFE_INTEGER);
  const fleet = await listControlPlaneFleetPage(actor, matrixFiltersEnabled
    ? { ...params, page: 1, pageSize: 500 }
    : params);
  const [recorderRows, toolState] = await Promise.all([
    buildControlPlaneRecorderRows(fleet.items),
    loadBatchedToolSummaryState(
      fleet.items.map((row) => row.managedWorkspaceId).filter((workspaceId): workspaceId is string => Boolean(workspaceId)),
    ),
  ]);
  const recorderByDeploymentId = new Map(recorderRows.map((row) => [row.deploymentId, row]));
  const items = fleet.items.map((row) => controlPlaneMatrixRow(row, recorderByDeploymentId.get(row.id) ?? fallbackRecorderRow(
    row,
    "unavailable",
    "Recorder state is unavailable.",
  ), toolState));
  const matrixFilters = controlPlaneMatrixFilterFlags(params);
  const filteredItems = matrixFiltersEnabled
    ? items.filter((row) => controlPlaneMatrixRowMatchesFilters(row, matrixFilters, new Date()))
    : items;
  const pageCount = Math.max(Math.ceil(filteredItems.length / requestedPageSize), 1);
  const currentPage = matrixFiltersEnabled ? Math.min(requestedPage, pageCount) : fleet.page;
  const start = (currentPage - 1) * requestedPageSize;
  const pagedItems = matrixFiltersEnabled
    ? filteredItems.slice(start, start + requestedPageSize)
    : filteredItems;
  return {
    ...fleet,
    items: pagedItems,
    total: matrixFiltersEnabled ? filteredItems.length : fleet.total,
    page: currentPage,
    pageSize: matrixFiltersEnabled ? requestedPageSize : fleet.pageSize,
    pageCount: matrixFiltersEnabled ? pageCount : fleet.pageCount,
    summary: {
      ...fleet.summary,
      attention: filteredItems.filter((row) => row.hasDeployment && row.issues.length > 0).length,
    },
    matrixSummary: {
      recordersReady: recorderRows.filter((row) => row.status === "ready").length,
      recordersAvailable: recorderRows.filter((row) => row.availability.status === "available").length,
      recordersNeedSetup: recorderRows.filter((row) => row.status === "needs_setup").length,
      remoteConnectorRequired: recorderRows.filter((row) => row.status === "requires_connector").length,
    },
  };
}

export async function getControlPlaneFleetOverview(actor: AppActor, params: Parameters<typeof listControlPlaneFleetPage>[1] = {}) {
  const overview = await listControlPlaneMatrix(actor, params);
  return {
    ...overview,
    cacheMeta: {
      source: "local" as const,
      generatedAt: new Date(),
      liveRefreshRequired: true,
    },
  };
}

export async function listControlPlaneRecorderMatrix(actor: AppActor, params: {
  query?: string | null;
  client?: string | string[] | null;
  status?: string | string[] | null;
  page?: number | null;
  pageSize?: number | null;
} = {}) {
  const rows = await listControlPlaneDeployments(actor);
  const query = params.query?.trim().toLowerCase() ?? "";
  const client = controlPlaneFilterValues(params.client);
  const status = controlPlaneFilterValues(params.status);
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
    const matchesClient = client.length === 0 || client.includes(row.deploymentId.toLowerCase()) || client.includes(row.clientSlug?.toLowerCase() ?? "");
    const matchesStatus = status.length === 0 || status.includes(row.status) || status.includes(row.availability.status);
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
      available: recorderRows.filter((row) => row.availability.status === "available").length,
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
    events: [],
    supportOperations: [],
    fleetSnapshots: compactControlPlaneFleetSnapshots(deployment.fleetSnapshots as Array<Record<string, unknown>>),
    hasSupportCredential: Boolean(deployment.supportCredentialEnc),
    supportCredentialEnc: undefined,
  };
}

export async function listControlPlaneSupportOperations(actor: AppActor, deploymentId: string, params: {
  take?: number | null;
} = {}) {
  await requireControlPlaneAccess(actor, { deploymentId });
  const take = boundedInteger(params.take, CONTROL_PLANE_OPERATION_LIST_LIMIT, 1, 100);
  const operations = await prisma.supportOperation.findMany({
    where: { deploymentId },
    orderBy: { createdAt: "desc" },
    take,
    select: {
      id: true,
      deploymentId: true,
      workspaceId: true,
      actorUserId: true,
      actorLabel: true,
      action: true,
      reason: true,
      status: true,
      inputSummary: true,
      resultSummary: true,
      error: true,
      idempotencyKey: true,
      startedAt: true,
      completedAt: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  return operations.map((operation) => compactControlPlaneSupportOperation(operation as unknown as Record<string, unknown>));
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

function controlPlaneInstallableConnectors(params: {
  hasManagedWorkspace: boolean;
  communicationInstallations?: Array<{ provider: string; status: string }>;
  oauthConnections?: Array<{ provider: string; status: string }>;
  dataSourceCount?: number;
}) {
  const slackInstalled = params.communicationInstallations?.some((installation) => (
    installation.provider === "SLACK" && installation.status !== "DISCONNECTED"
  )) ?? false;
  const googleConnected = params.oauthConnections?.some((connection) => (
    connection.provider === "GOOGLE" && connection.status !== "DISCONNECTED"
  )) ?? false;
  const microsoftConnected = params.oauthConnections?.some((connection) => (
    connection.provider === "MICROSOFT" && connection.status !== "DISCONNECTED"
  )) ?? false;

  return [
    {
      key: "slack",
      label: "Slack",
      provider: "SLACK",
      kind: "communication",
      configured: slackInstalled,
      canManageFromControlPlane: params.hasManagedWorkspace && Boolean(env.SLACK_CLIENT_ID && env.SLACK_CLIENT_SECRET),
      requiresHumanConsent: true,
    },
    {
      key: "google",
      label: "Google",
      provider: "GOOGLE",
      kind: "oauth",
      configured: googleConnected,
      canManageFromControlPlane: false,
      requiresHumanConsent: true,
    },
    {
      key: "microsoft",
      label: "Microsoft",
      provider: "MICROSOFT",
      kind: "oauth",
      configured: microsoftConnected,
      canManageFromControlPlane: false,
      requiresHumanConsent: true,
    },
    {
      key: "external_data_sources",
      label: "External data sources",
      provider: null,
      kind: "data_source",
      configured: (params.dataSourceCount ?? 0) > 0,
      canManageFromControlPlane: false,
      requiresHumanConsent: false,
    },
  ];
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

const MODULE_GRANT_PRINCIPAL_TYPES: readonly PrismaModuleGrantPrincipalType[] = ["MEMBER", "MEMBER_ROLE", "GOVERNANCE_ROLE", "CIRCLE"];

function normalizeModuleGrantPrincipalType(value: string): PrismaModuleGrantPrincipalType {
  const normalized = value?.trim().toUpperCase();
  invariant(
    MODULE_GRANT_PRINCIPAL_TYPES.includes(normalized as PrismaModuleGrantPrincipalType),
    400,
    "INVALID_INPUT",
    "Invalid module grant principal type.",
  );
  return normalized as PrismaModuleGrantPrincipalType;
}

function normalizeModuleAccessLevel(value: string): PrismaModuleAccessLevel {
  const normalized = value?.trim().toLowerCase();
  invariant(
    normalized === "none" || normalized === "read" || normalized === "write",
    400,
    "INVALID_INPUT",
    "Invalid module access level.",
  );
  return normalized === "write" ? "WRITE" : normalized === "read" ? "READ" : "NONE";
}

function requireKnownModuleKey(moduleKey: string | null | undefined): string {
  const trimmed = moduleKey?.trim();
  invariant(trimmed, 400, "INVALID_INPUT", "Module key is required.");
  invariant(getModuleManifests().some((mod) => mod.key === trimmed), 404, "NOT_FOUND", "Unknown module.");
  return trimmed;
}

export async function listControlPlaneModuleGrants(actor: AppActor, deploymentId: string) {
  const deployment = await getControlPlaneDeploymentWithWorkspace(actor, deploymentId);
  const adapter = createControlPlaneAdapter(deployment);
  invariant(deployment.managedWorkspaceId, 400, "MANAGED_WORKSPACE_REQUIRED", "A managed workspace is required to manage module access grants.");

  const grants = await prisma.workspaceModuleGrant.findMany({
    where: { workspaceId: deployment.managedWorkspaceId },
    orderBy: [{ moduleKey: "asc" }, { principalType: "asc" }, { principalId: "asc" }],
  });

  return {
    deploymentId,
    accessMode: adapter.kind,
    source: "managed_workspace" as const,
    modules: getModuleManifests().map((mod) => ({ key: mod.key, title: mod.title, tier: mod.tier })),
    principalTypes: [...MODULE_GRANT_PRINCIPAL_TYPES],
    accessLevels: ["none", "read", "write"] as const,
    grants: grants.map((grant) => ({
      id: grant.id,
      moduleKey: grant.moduleKey,
      principalType: grant.principalType,
      principalId: grant.principalId,
      accessLevel: grant.accessLevel,
      createdAt: grant.createdAt,
    })),
  };
}

export async function setControlPlaneModuleGrant(actor: AppActor, params: {
  deploymentId: string;
  moduleKey: string;
  principalType: string;
  principalId: string;
  accessLevel: string;
  reason?: string | null;
}) {
  requireControlPlaneScope(actor, "control-plane:modules:write");
  const reason = requireMutationReason(params.reason);
  await requireControlPlaneDeploymentWriteAccess(actor, params.deploymentId);
  const deployment = await getControlPlaneDeploymentWithWorkspace(actor, params.deploymentId);
  invariant(deployment.managedWorkspaceId, 400, "MANAGED_WORKSPACE_REQUIRED", "A managed workspace is required to manage module access grants.");

  const moduleKey = requireKnownModuleKey(params.moduleKey);
  const principalType = normalizeModuleGrantPrincipalType(params.principalType);
  const principalId = params.principalId?.trim();
  invariant(principalId, 400, "INVALID_INPUT", "Principal id is required.");
  const accessLevel = normalizeModuleAccessLevel(params.accessLevel);
  const createdByUserId = actor.kind === "user" ? actor.user.id : null;

  const record = await prisma.workspaceModuleGrant.upsert({
    where: {
      workspaceId_moduleKey_principalType_principalId: {
        workspaceId: deployment.managedWorkspaceId,
        moduleKey,
        principalType,
        principalId,
      },
    },
    update: { accessLevel },
    create: {
      workspaceId: deployment.managedWorkspaceId,
      moduleKey,
      principalType,
      principalId,
      accessLevel,
      createdByUserId,
    },
  });

  await recordCustomerDeploymentEvent(actor, params.deploymentId, "control_plane.module_grant.updated", {
    reason,
    source: "managed_workspace",
    moduleKey,
    principalType,
    principalId,
    accessLevel,
  });

  return {
    deploymentId: params.deploymentId,
    source: "managed_workspace" as const,
    grant: {
      id: record.id,
      moduleKey: record.moduleKey,
      principalType: record.principalType,
      principalId: record.principalId,
      accessLevel: record.accessLevel,
    },
  };
}

export async function deleteControlPlaneModuleGrant(actor: AppActor, params: {
  deploymentId: string;
  grantId: string;
  reason?: string | null;
}) {
  requireControlPlaneScope(actor, "control-plane:modules:write");
  const reason = requireMutationReason(params.reason);
  await requireControlPlaneDeploymentWriteAccess(actor, params.deploymentId);
  const deployment = await getControlPlaneDeploymentWithWorkspace(actor, params.deploymentId);
  invariant(deployment.managedWorkspaceId, 400, "MANAGED_WORKSPACE_REQUIRED", "A managed workspace is required to manage module access grants.");

  const existing = await prisma.workspaceModuleGrant.findFirst({
    where: { id: params.grantId, workspaceId: deployment.managedWorkspaceId },
    select: { id: true, moduleKey: true, principalType: true, principalId: true },
  });
  invariant(existing, 404, "NOT_FOUND", "Module access grant not found.");

  await prisma.workspaceModuleGrant.delete({ where: { id: existing.id } });
  await recordCustomerDeploymentEvent(actor, params.deploymentId, "control_plane.module_grant.deleted", {
    reason,
    source: "managed_workspace",
    moduleKey: existing.moduleKey,
    principalType: existing.principalType,
    principalId: existing.principalId,
  });

  return { deploymentId: params.deploymentId, grantId: existing.id };
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
      availableConnectors: controlPlaneInstallableConnectors({ hasManagedWorkspace: false }),
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
        externalWorkspaceId: true,
        externalTeamName: true,
        scopes: true,
        optionalScopes: true,
        settings: true,
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
    availableConnectors: controlPlaneInstallableConnectors({
      hasManagedWorkspace: true,
      communicationInstallations,
      oauthConnections,
      dataSourceCount: dataSources.length,
    }),
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
        installationId: installation.id,
        label: installation.provider,
        entitlementEnabled: true,
        configured: true,
        status: installation.status,
        externalWorkspaceId: installation.externalWorkspaceId,
        team: installation.externalTeamName,
        scopes: installation.scopes,
        optionalScopes: installation.optionalScopes,
        settings: installation.settings,
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

async function requireManagedSlackInstallation(actor: AppActor, params: {
  deploymentId: string;
  installationId?: string | null;
}) {
  await requireControlPlaneDeploymentWriteAccess(actor, params.deploymentId);
  const deployment = await getControlPlaneDeploymentWithWorkspace(actor, params.deploymentId);
  const managedWorkspaceId = deployment.managedWorkspaceId;
  invariant(managedWorkspaceId, 400, "MANAGED_WORKSPACE_REQUIRED", "Slack management requires a managed workspace link.");
  const installation = params.installationId
    ? await prisma.communicationInstallation.findFirst({
      where: {
        id: params.installationId,
        workspaceId: managedWorkspaceId,
        provider: "SLACK",
      },
    })
    : await prisma.communicationInstallation.findFirst({
      where: {
        workspaceId: managedWorkspaceId,
        provider: "SLACK",
        status: "ACTIVE",
      },
      orderBy: { updatedAt: "desc" },
    });
  invariant(installation, 404, "NOT_FOUND", "Slack installation not found for this managed workspace.");
  return { deployment, managedWorkspaceId, installation };
}

export async function getControlPlaneSlackSetupTarget(actor: AppActor, deploymentId: string) {
  requireControlPlaneScope(actor, "control-plane:integrations:write");
  await requireControlPlaneDeploymentWriteAccess(actor, deploymentId);
  const deployment = await getControlPlaneDeploymentWithWorkspace(actor, deploymentId);
  const managedWorkspaceId = deployment.managedWorkspaceId;
  invariant(managedWorkspaceId, 400, "MANAGED_WORKSPACE_REQUIRED", "Slack installation requires a managed workspace link.");
  return {
    deploymentId,
    managedWorkspaceId,
    deploymentLabel: deployment.label,
    workspaceName: deployment.managedWorkspace?.name ?? null,
    expectedTeamId: await getSlackExpectedTeamIdForWorkspace(managedWorkspaceId),
  };
}

export async function saveControlPlaneSlackInstallation(actor: AppActor, params: {
  deploymentId: string;
  oauthResponse: SlackOAuthResponse;
  expectedTeamId?: string | null;
  reason?: string | null;
}) {
  requireControlPlaneScope(actor, "control-plane:integrations:write");
  const reason = requireMutationReason(params.reason);
  await requireControlPlaneDeploymentWriteAccess(actor, params.deploymentId);
  const deployment = await getControlPlaneDeploymentWithWorkspace(actor, params.deploymentId);
  const managedWorkspaceId = deployment.managedWorkspaceId;
  invariant(managedWorkspaceId, 400, "MANAGED_WORKSPACE_REQUIRED", "Slack installation requires a managed workspace link.");

  const installation = await saveSlackInstallationForWorkspace({
    workspaceId: managedWorkspaceId,
    oauthResponse: params.oauthResponse,
    installedByUserId: actorUserId(actor),
    expectedTeamId: params.expectedTeamId,
  });
  await recordCustomerDeploymentEvent(actor, params.deploymentId, "control_plane.integration.slack_connected", {
    reason,
    managedWorkspaceId,
    installationId: installation.id,
    externalWorkspaceId: installation.externalWorkspaceId,
    team: installation.externalTeamName,
    scopes: installation.scopes,
  });

  return {
    deploymentId: params.deploymentId,
    managedWorkspaceId,
    installation,
  };
}

export async function updateControlPlaneSlackAgendaSettings(actor: AppActor, params: {
  deploymentId: string;
  installationId: string;
  defaultAgendaChannelId?: string | null;
  agendaTimezone?: string | null;
  reason?: string | null;
}) {
  requireControlPlaneScope(actor, "control-plane:integrations:write");
  const reason = requireMutationReason(params.reason);
  const { managedWorkspaceId, installation } = await requireManagedSlackInstallation(actor, {
    deploymentId: params.deploymentId,
    installationId: params.installationId,
  });
  invariant(installation.status === "ACTIVE", 400, "SLACK_NOT_ACTIVE", "Slack installation must be active before settings can be updated.");

  const rawChannelId = params.defaultAgendaChannelId?.trim() ?? "";
  let defaultAgendaChannelId: string | null = null;
  let defaultAgendaChannelName: string | null = null;
  if (rawChannelId) {
    const validation = await validateSlackPostTarget(installation.id, rawChannelId);
    if (!validation.ok) {
      invariant(false, 400, validation.code, validation.message);
    }
    defaultAgendaChannelId = validation.channelId;
    defaultAgendaChannelName = validation.channelName;
  }

  const current = installation.settings && typeof installation.settings === "object" && !Array.isArray(installation.settings)
    ? installation.settings as JsonRecord
    : {};
  const settings = {
    ...current,
    defaultAgendaChannelId,
    defaultAgendaChannelName,
    agendaTimezone: params.agendaTimezone?.trim() || "UTC",
  };
  const updated = await prisma.communicationInstallation.update({
    where: { id: installation.id },
    data: { settings: toInputJson(settings) },
  });
  await recordCustomerDeploymentEvent(actor, params.deploymentId, "control_plane.integration.slack_settings_updated", {
    reason,
    managedWorkspaceId,
    installationId: installation.id,
    defaultAgendaChannelId,
    defaultAgendaChannelName,
    agendaTimezone: settings.agendaTimezone,
  });
  return {
    deploymentId: params.deploymentId,
    managedWorkspaceId,
    installation: updated,
  };
}

export async function disconnectControlPlaneSlackInstallation(actor: AppActor, params: {
  deploymentId: string;
  installationId: string;
  reason?: string | null;
}) {
  requireControlPlaneScope(actor, "control-plane:integrations:write");
  const reason = requireMutationReason(params.reason);
  const { managedWorkspaceId, installation } = await requireManagedSlackInstallation(actor, {
    deploymentId: params.deploymentId,
    installationId: params.installationId,
  });
  const updated = await prisma.communicationInstallation.update({
    where: { id: installation.id },
    data: {
      status: "DISCONNECTED",
      botTokenEnc: null,
      disconnectedAt: new Date(),
    },
  });
  await recordCustomerDeploymentEvent(actor, params.deploymentId, "control_plane.integration.slack_disconnected", {
    reason,
    managedWorkspaceId,
    installationId: installation.id,
    externalWorkspaceId: installation.externalWorkspaceId,
    team: installation.externalTeamName,
  });
  return {
    deploymentId: params.deploymentId,
    managedWorkspaceId,
    installation: updated,
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
  if (!managedWorkspaceId) {
    const recorderCalendarArgs: JsonRecord = {
      providerAccountId: params.providerAccountId,
      accessToken: params.accessToken,
      scopes: params.scopes ?? [],
    };
    if (typeof params.providerAccountEmail === "string") recorderCalendarArgs.providerAccountEmail = params.providerAccountEmail;
    if (typeof params.displayName === "string") recorderCalendarArgs.displayName = params.displayName;
    if (typeof params.refreshToken === "string") recorderCalendarArgs.refreshToken = params.refreshToken;
    if (typeof params.expiresIn === "number") recorderCalendarArgs.expiresIn = params.expiresIn;
    const oauthClientId = process.env.MICROSOFT_CLIENT_ID?.trim();
    if (oauthClientId) recorderCalendarArgs.oauthClientId = oauthClientId;

    const operation = await runCustomerSupportOperation(actor, {
      deploymentId: params.deploymentId,
      action: "meeting_recorders.connect_calendar",
      scopeOverride: "control-plane:integrations:write",
      reason,
      arguments: recorderCalendarArgs,
    });
    await recordCustomerDeploymentEvent(actor, params.deploymentId, "control_plane.integration.meeting_recorder_calendar_connected", {
      reason,
      accessMode: "support_connector",
      supportOperationId: operation.id,
      provider: "MICROSOFT",
      providerAccountEmail: params.providerAccountEmail ?? null,
    });
    return {
      deploymentId: params.deploymentId,
      managedWorkspaceId: null,
      accessMode: "support_connector" as const,
      supportOperation: {
        id: operation.id,
        action: operation.action,
        status: operation.status,
        resultSummary: operation.resultSummary ?? null,
      },
    };
  }

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

function recorderMeetingOpsStatus(readiness: Awaited<ReturnType<typeof getMeetingRecorderEnterpriseReadiness>>) {
  if (readiness.ready) return "ready" as const;
  const failedChecks = readiness.checks.filter((check) => !check.ok);
  if (!readiness.config.enabled) return "configured" as const;
  if (failedChecks.some((check) => (
    check.key === "recall_api_key"
    || check.key === "recall_webhook_secret"
    || check.key === "meeting_baas_api_key"
    || check.key === "meeting_baas_webhook_secret"
    || check.key === "provider_proof"
  ))) {
    return "blocked" as const;
  }
  return "degraded" as const;
}

type RecorderEnterpriseReadiness = Awaited<ReturnType<typeof getMeetingRecorderEnterpriseReadiness>>;
type RecorderCoverageReadiness = Awaited<ReturnType<typeof getMeetingRecorderCoverageReadiness>>;
type RecorderReadinessCheck = RecorderEnterpriseReadiness["checks"][number];

const RECORDER_TENANT_CONFIG_CHECK_KEYS = new Set(["entitlement", "recorder_config"]);
const RECORDER_VENDOR_CHECK_KEYS = new Set([
  "public_base_url",
  "recall_api_key",
  "recall_webhook_secret",
  "meeting_baas_api_key",
  "meeting_baas_webhook_secret",
]);
const RECORDER_SCHEDULE_CHECK_KEYS = new Set(["recording_schedule"]);
const RECORDER_OPTIONAL_CALENDAR_CHECK_KEYS = new Set(["calendar_source", "worker_sync"]);
const RECORDER_LIVE_VENDOR_CHECK_KEYS = new Set(["provider_proof"]);
const CONTROL_PLANE_RECORDER_COVERED_STATUSES = new Set(["PENDING", "SCHEDULED", "JOINING", "RECORDING", "COMPLETED"]);
const CONTROL_PLANE_RECORDER_COVERAGE_RECORDING_STATUSES = ["PENDING", "SCHEDULED", "JOINING", "RECORDING", "COMPLETED", "FAILED"] as const;
const CONTROL_PLANE_RECORDER_AUTO_SCHEDULE_MIN_LEAD_MS = 10 * 60 * 1000;
const CONTROL_PLANE_RECORDER_SCHEDULE_LOOKAHEAD_MS = 30 * 24 * 60 * 60 * 1000;
const CONTROL_PLANE_RECORDER_PROVIDER_PROOF_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const CONTROL_PLANE_RECORDER_COVERAGE_MEETING_LIMIT = 100;
const CONTROL_PLANE_STALE_RECORDER_FAILURE_CODE = "STALE_RECORDER";
const CONTROL_PLANE_MEETING_URL_CHANGED_FAILURE_CODE = "MEETING_URL_CHANGED";
const CONTROL_PLANE_DUPLICATE_RECORDER_FAILURE_CODE = "DUPLICATE_RECORDER";

function effectiveControlPlaneRecorderUrl(meeting: {
  meetingUrl?: string | null;
  series?: { meetingUrl?: string | null } | null;
}) {
  return meeting.meetingUrl ?? meeting.series?.meetingUrl ?? null;
}

function controlPlaneRecordingCoversMeeting(recording: {
  status: string;
  meetingUrl?: string | null;
}, meetingUrl: string | null) {
  return Boolean(
    recording.meetingUrl
    && meetingUrl
    && normalizeMeetingUrl(recording.meetingUrl) === normalizeMeetingUrl(meetingUrl)
    && CONTROL_PLANE_RECORDER_COVERED_STATUSES.has(recording.status),
  );
}

function controlPlaneRecordingShowsSchedulingFailure(recording: { status: string; failureCode?: string | null }) {
  return recording.status === "FAILED"
    && recording.failureCode !== CONTROL_PLANE_STALE_RECORDER_FAILURE_CODE
    && recording.failureCode !== CONTROL_PLANE_MEETING_URL_CHANGED_FAILURE_CODE
    && recording.failureCode !== CONTROL_PLANE_DUPLICATE_RECORDER_FAILURE_CODE;
}

function controlPlaneRecorderProofObservedAt(recording: {
  status?: string | null;
  endedAt?: Date | null;
  startedAt?: Date | null;
  scheduledAt?: Date | null;
  updatedAt?: Date | null;
  createdAt: Date;
}) {
  if (recording.status === "JOINING") {
    return recording.endedAt ?? recording.startedAt ?? recording.updatedAt ?? recording.scheduledAt ?? recording.createdAt;
  }
  return recording.endedAt ?? recording.startedAt ?? recording.scheduledAt ?? recording.createdAt;
}

function setLatestControlPlaneProofAt(map: Map<string, Date>, workspaceId: string, observedAt: Date | null | undefined, proofSince: Date) {
  if (!observedAt || observedAt < proofSince) return;
  const existing = map.get(workspaceId);
  if (!existing || observedAt > existing) {
    map.set(workspaceId, observedAt);
  }
}

function buildControlPlaneProviderProofObservedAt(params: {
  smokeRuns: Array<{
    workspaceId: string;
    status: string;
    completedAt?: Date | null;
    createdAt: Date;
  }>;
  recordings: Array<{
    workspaceId: string;
    status?: string | null;
    endedAt?: Date | null;
    startedAt?: Date | null;
    scheduledAt?: Date | null;
    updatedAt?: Date | null;
    createdAt: Date;
  }>;
  proofSince: Date;
}) {
  const proofByWorkspaceId = new Map<string, Date>();
	  for (const smokeRun of params.smokeRuns) {
	    if (smokeRun.status !== "COMPLETED") continue;
	    setLatestControlPlaneProofAt(proofByWorkspaceId, smokeRun.workspaceId, smokeRun.completedAt, params.proofSince);
	  }
  for (const recording of params.recordings) {
    setLatestControlPlaneProofAt(proofByWorkspaceId, recording.workspaceId, controlPlaneRecorderProofObservedAt(recording), params.proofSince);
  }
  return proofByWorkspaceId;
}

function controlPlaneRecorderIsAuthFailure(recording: { failureCode: string | null; failureMessage: string | null }) {
  const text = `${recording.failureCode ?? ""}\n${recording.failureMessage ?? ""}`.toLowerCase();
  return text.includes("authentication_failed")
    || text.includes("invalid api token")
    || text.includes("invalid_auth")
    || text.includes("unauthorized")
    || text.includes("401")
    || text.includes("region")
    || recording.failureCode === "configuration_error";
}

function controlPlaneRecorderAuthFailureDetail(recording: { failureCode: string | null; failureMessage: string | null }) {
  if (recording.failureCode === "configuration_error") return "Recorder provider credential is not configured.";
  const message = recording.failureMessage ?? recording.failureCode ?? "Recorder provider authentication failed.";
  if (/recall/i.test(message) && /401|authentication_failed|invalid api token|region/i.test(message)) {
    return "Recall authentication failed; verify the configured API token and region.";
  }
  return sanitizeDiagnosticText(message.replace(/https?:\/\/\S+/g, "[url]").slice(0, 500));
}

function buildControlPlaneProviderAuthFailures(recordings: Array<{
  workspaceId: string;
  failureCode: string | null;
  failureMessage: string | null;
  updatedAt: Date;
}>) {
  const failuresByWorkspaceId = new Map<string, { failureCode: string | null; failureMessage: string | null; updatedAt: Date }>();
  for (const recording of recordings) {
    if (!controlPlaneRecorderIsAuthFailure(recording)) continue;
    const existing = failuresByWorkspaceId.get(recording.workspaceId);
    if (!existing || recording.updatedAt > existing.updatedAt) {
      failuresByWorkspaceId.set(recording.workspaceId, recording);
    }
  }
  return failuresByWorkspaceId;
}

function buildControlPlaneInternalScheduleCounts(params: {
  meetings: Array<{
    workspaceId: string;
    recordedAt: Date;
    meetingUrl: string | null;
    series: { meetingUrl: string | null } | null;
    recordings: Array<{
      status: string;
      meetingUrl: string;
      failureCode: string | null;
    }>;
  }>;
  entitlementByWorkspaceId: Map<string, boolean>;
  configByWorkspaceId: Map<string, { enabled: boolean; autoRecordEnabled: boolean; defaultProvider: MeetingRecorderProvider; fallbackProvider: MeetingRecorderProvider | null }>;
  now: Date;
}) {
  const counts = new Map<string, { eligible: number; alreadyCovered: number }>();
  const evaluatedByWorkspaceId = new Map<string, number>();
  for (const meeting of params.meetings) {
    const evaluated = evaluatedByWorkspaceId.get(meeting.workspaceId) ?? 0;
    if (evaluated >= CONTROL_PLANE_RECORDER_COVERAGE_MEETING_LIMIT) continue;
    evaluatedByWorkspaceId.set(meeting.workspaceId, evaluated + 1);
    const config = params.configByWorkspaceId.get(meeting.workspaceId);
    const effectiveUrl = effectiveControlPlaneRecorderUrl(meeting);
    const recorderUrl = normalizeRecorderMeetingUrl(effectiveUrl);
    if (!effectiveUrl || !recorderUrl?.providerSchedulable) continue;
    const workspaceCounts = counts.get(meeting.workspaceId) ?? { eligible: 0, alreadyCovered: 0 };
    if (meeting.recordings.some((recording) => controlPlaneRecordingCoversMeeting(recording, recorderUrl.url))) {
      workspaceCounts.alreadyCovered += 1;
      counts.set(meeting.workspaceId, workspaceCounts);
      continue;
    }
    if (!params.entitlementByWorkspaceId.get(meeting.workspaceId) || !config?.enabled) continue;
    if (!config.autoRecordEnabled) continue;
    if (!controlPlaneRecorderRuntimeChecks({ defaultProvider: config.defaultProvider, fallbackProvider: null }).every((check) => check.ok)) continue;
    if (meeting.recordedAt.getTime() - params.now.getTime() <= CONTROL_PLANE_RECORDER_AUTO_SCHEDULE_MIN_LEAD_MS) continue;
    if (meeting.recordings.some(controlPlaneRecordingShowsSchedulingFailure)) continue;

    workspaceCounts.eligible += 1;
    counts.set(meeting.workspaceId, workspaceCounts);
  }
  return counts;
}

function normalizeRecorderGateCheck(check: RecorderReadinessCheck): ControlPlaneRecorderReadinessGateCheck {
  return {
    key: check.key,
    label: check.label,
    status: check.ok ? "pass" : "blocked",
    detail: sanitizeDiagnosticText(check.detail),
  };
}

function recorderGateFromChecks(params: {
  key: ControlPlaneRecorderReadinessGate["key"];
  label: string;
  checks: RecorderReadinessCheck[];
  passDetail: string;
  emptyDetail: string;
  emptyStatus?: ControlPlaneRecorderReadinessGateStatus;
}): ControlPlaneRecorderReadinessGate {
  const normalizedChecks = params.checks.map(normalizeRecorderGateCheck);
  if (normalizedChecks.length === 0) {
    return {
      key: params.key,
      label: params.label,
      status: params.emptyStatus ?? "unknown",
      detail: params.emptyDetail,
      checks: [],
    };
  }
  const failed = normalizedChecks.find((check) => check.status === "blocked");
  return {
    key: params.key,
    label: params.label,
    status: failed ? "blocked" : "pass",
    detail: failed?.detail ?? params.passDetail,
    checks: normalizedChecks,
  };
}

function recorderCoverageBlockerLabel(key: string) {
  return key
    .split("_")
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function recorderCoverageActiveBlockerEntries(coverage: RecorderCoverageReadiness) {
  const blockerCounts = new Map<string, number>();
  for (const meeting of coverage.meetings) {
    if (meeting.blockerReasons.includes("already_covered")) continue;
    for (const reason of meeting.blockerReasons) {
      if (reason === "already_covered") continue;
      blockerCounts.set(reason, (blockerCounts.get(reason) ?? 0) + 1);
    }
  }
  return [...blockerCounts.entries()];
}

function recorderMeetingStateGate(coverage: RecorderCoverageReadiness): ControlPlaneRecorderReadinessGate {
  const alreadyCoveredCount = coverage.counts.blockers.already_covered ?? 0;
  const blockers = recorderCoverageActiveBlockerEntries(coverage)
    .map(([key, count]) => ({
      key,
      label: recorderCoverageBlockerLabel(key),
      status: "blocked" as const,
      detail: `${count} upcoming scheduled meeting(s) are blocked by ${key}.`,
    }));
  const coveredCheck = alreadyCoveredCount > 0
    ? [{
      key: "already_covered",
      label: "Already Covered",
      status: "pass" as const,
      detail: `${alreadyCoveredCount} upcoming scheduled meeting(s) already have recorder coverage.`,
    }]
    : [];
  const checks = [...coveredCheck, ...blockers];

  if (coverage.counts.total === 0) {
    return {
      key: "meeting_state",
      label: "Scheduled meetings",
      status: "warning",
      detail: "No upcoming scheduled meetings were found in the recorder coverage window.",
      checks: [],
    };
  }

  if (coverage.counts.eligible === 0 && alreadyCoveredCount === 0 && blockers.length > 0) {
    return {
      key: "meeting_state",
      label: "Scheduled meetings",
      status: "blocked",
      detail: blockers[0]?.detail ?? "No upcoming scheduled meetings are eligible for recorder coverage.",
      checks,
    };
  }

  return {
    key: "meeting_state",
    label: "Scheduled meetings",
    status: blockers.length > 0 ? "warning" : "pass",
    detail: blockers.length > 0
      ? alreadyCoveredCount > 0
        ? `${alreadyCoveredCount} upcoming scheduled meeting(s) already have recorder coverage; ${blockers.length} blocker type(s) remain.`
        : `${coverage.counts.eligible} of ${coverage.counts.total} upcoming scheduled meeting(s) are eligible; ${blockers.length} blocker type(s) remain.`
      : alreadyCoveredCount > 0 && coverage.counts.eligible === 0
        ? `${alreadyCoveredCount} of ${coverage.counts.total} upcoming scheduled meeting(s) already have recorder coverage.`
        : `${coverage.counts.eligible} of ${coverage.counts.total} upcoming scheduled meeting(s) are eligible for recorder coverage.`,
    checks,
  };
}

function recorderInternalScheduleCount(coverage: RecorderCoverageReadiness) {
  return coverage.counts.eligible + (coverage.counts.blockers.already_covered ?? 0);
}

function recorderScheduleGateFromReadiness(params: {
  checks: RecorderReadinessCheck[];
  coverage?: RecorderCoverageReadiness | null;
  supportConnector?: boolean;
}): ControlPlaneRecorderReadinessGate {
  const scheduleChecks = params.checks.filter((check) => RECORDER_SCHEDULE_CHECK_KEYS.has(check.key));
  if (scheduleChecks.length > 0) {
    return recorderGateFromChecks({
      key: "calendar",
      label: "Recording schedule",
      checks: scheduleChecks,
      passDetail: "Corgtex has an internal recorder schedule or optional calendar sync source.",
      emptyDetail: "Recorder schedule source check was not returned.",
    });
  }

  if (params.coverage && recorderInternalScheduleCount(params.coverage) > 0) {
    const alreadyCovered = params.coverage.counts.blockers.already_covered ?? 0;
    return {
      key: "calendar",
      label: "Recording schedule",
      status: "pass",
      detail: alreadyCovered > 0
        ? `${alreadyCovered} upcoming Corgtex scheduled meeting(s) already have recorder coverage.`
        : `${params.coverage.counts.eligible} upcoming Corgtex scheduled meeting(s) are eligible for recorder scheduling.`,
      checks: [{
        key: "internal_schedule",
        label: "Corgtex recorder schedule",
        status: "pass",
        detail: "Corgtex internal scheduled meetings are available for recorder operations.",
      }],
    };
  }

  const optionalCalendarGate = recorderGateFromChecks({
    key: "calendar",
    label: "Recording schedule",
    checks: params.checks.filter((check) => RECORDER_OPTIONAL_CALENDAR_CHECK_KEYS.has(check.key)),
    passDetail: "Optional calendar sync is connected and can import recorder meetings into Corgtex.",
    emptyDetail: params.supportConnector
      ? "Support connector readiness did not include Corgtex schedule or optional calendar sync checks."
      : "Recorder schedule source check was not returned.",
    emptyStatus: "blocked",
  });
  if (optionalCalendarGate.status === "pass") return optionalCalendarGate;
  return {
    ...optionalCalendarGate,
    status: "blocked",
    detail: optionalCalendarGate.detail.includes("calendar")
      ? optionalCalendarGate.detail
      : "No upcoming Corgtex scheduled meetings are ready for recording. Add the meeting to Corgtex, or optionally connect calendar sync.",
  };
}

function buildManagedRecorderReadinessGates(
  readiness: RecorderEnterpriseReadiness,
  coverage: RecorderCoverageReadiness,
): ControlPlaneRecorderReadinessGates {
  return {
    controlPlane: {
      key: "control_plane",
      label: "Control Plane access",
      status: "pass",
      detail: "Managed workspace recorder readiness was inspected directly.",
      checks: [],
    },
    tenantConfig: recorderGateFromChecks({
      key: "tenant_config",
      label: "Tenant configuration",
      checks: readiness.checks.filter((check) => RECORDER_TENANT_CONFIG_CHECK_KEYS.has(check.key)),
      passDetail: "Recorder entitlement and workspace configuration are enabled.",
      emptyDetail: "Tenant recorder configuration checks were not returned.",
    }),
    vendor: recorderGateFromChecks({
      key: "vendor",
      label: "Vendor credentials",
      checks: readiness.checks.filter((check) => RECORDER_VENDOR_CHECK_KEYS.has(check.key)),
      passDetail: "Recorder vendor runtime credentials are configured.",
      emptyDetail: "Recorder vendor credential checks were not returned.",
    }),
    calendar: recorderScheduleGateFromReadiness({ checks: readiness.checks, coverage }),
    meetingState: recorderMeetingStateGate(coverage),
    liveVendorProof: recorderGateFromChecks({
      key: "live_vendor_proof",
      label: "Live vendor proof",
      checks: readiness.checks.filter((check) => RECORDER_LIVE_VENDOR_CHECK_KEYS.has(check.key)),
      passDetail: "A recent vendor-backed recorder smoke or real recording exists.",
      emptyDetail: "Live recorder vendor proof check was not returned.",
    }),
  };
}

function normalizeSupportRecorderReadinessCheck(value: unknown): RecorderReadinessCheck | null {
  const record = jsonRecordOrNull(value);
  if (!record || typeof record.ok !== "boolean") return null;
  const key = typeof record.key === "string" ? record.key.trim() : "";
  const label = typeof record.label === "string" ? record.label.trim() : key;
  if (!key || !label) return null;
  return {
    key,
    label,
    ok: record.ok,
    detail: typeof record.detail === "string" ? record.detail : "",
  };
}

function normalizeSupportRecorderReadinessChecks(value: unknown): RecorderReadinessCheck[] {
  return Array.isArray(value)
    ? value.flatMap((item) => {
      const check = normalizeSupportRecorderReadinessCheck(item);
      return check ? [check] : [];
    })
    : [];
}

function supportConnectorRecorderCoverageSummary(summary: JsonRecord) {
  return jsonRecordOrNull(summary.coverage) ?? summary;
}

function supportConnectorRecorderReadinessChecks(summary: JsonRecord) {
  const checks = normalizeSupportRecorderReadinessChecks(summary.checks);
  if (checks.length > 0) return checks;
  const coverageSummary = supportConnectorRecorderCoverageSummary(summary);
  return normalizeSupportRecorderReadinessChecks(coverageSummary.providerChecks);
}

function supportConnectorCoverageBlockerEntries(summary: JsonRecord) {
  const meetings = Array.isArray(summary.meetings) ? summary.meetings : null;
  if (meetings) {
    const blockerCounts = new Map<string, number>();
    for (const item of meetings) {
      const meeting = jsonRecordOrNull(item);
      const reasons = Array.isArray(meeting?.blockerReasons)
        ? meeting.blockerReasons.filter((reason): reason is string => typeof reason === "string")
        : [];
      if (reasons.includes("already_covered")) continue;
      for (const reason of reasons) {
        if (reason === "already_covered") continue;
        blockerCounts.set(reason, (blockerCounts.get(reason) ?? 0) + 1);
      }
    }
    return [...blockerCounts.entries()];
  }

  const counts = summary.counts && typeof summary.counts === "object"
    ? summary.counts as { blockers?: unknown }
    : null;
  return counts?.blockers && typeof counts.blockers === "object"
    ? Object.entries(counts.blockers as Record<string, unknown>)
      .filter(([key, count]) => key !== "already_covered" && typeof count === "number" && count > 0)
      .map(([key, count]) => [key, count] as const)
    : [];
}

function supportConnectorRecorderReadinessGates(params: {
  resultSummary?: unknown;
  errorDetail?: string | null;
}): ControlPlaneRecorderReadinessGates {
  const hasError = Boolean(params.errorDetail);
  const maybeSummary = params.resultSummary && typeof params.resultSummary === "object"
    ? params.resultSummary as JsonRecord
    : {};
  const readinessChecks = supportConnectorRecorderReadinessChecks(maybeSummary);
  const coverageSummary = supportConnectorRecorderCoverageSummary(maybeSummary);
  const counts = coverageSummary.counts && typeof coverageSummary.counts === "object"
    ? coverageSummary.counts as { total?: unknown; eligible?: unknown; blockers?: unknown }
    : null;
  const total = typeof counts?.total === "number" ? counts.total : null;
  const eligible = typeof counts?.eligible === "number" ? counts.eligible : null;
  const alreadyCoveredCount = counts?.blockers
    && typeof counts.blockers === "object"
    && typeof (counts.blockers as Record<string, unknown>).already_covered === "number"
    ? (counts.blockers as Record<string, number>).already_covered
    : 0;
  const blockerEntries = supportConnectorCoverageBlockerEntries(coverageSummary)
    .map(([key, count]) => ({
      key,
      label: recorderCoverageBlockerLabel(key),
      status: "blocked" as const,
      detail: `${count} upcoming scheduled meeting(s) are blocked by ${key}.`,
    }));
  const coveredEntries = alreadyCoveredCount > 0
    ? [{
      key: "already_covered",
      label: "Already Covered",
      status: "pass" as const,
      detail: `${alreadyCoveredCount} upcoming scheduled meeting(s) already have recorder coverage.`,
    }]
    : [];
  const scheduleChecks = readinessChecks.filter((check) => RECORDER_SCHEDULE_CHECK_KEYS.has(check.key));
  const scheduleGate = scheduleChecks.length > 0
    ? recorderScheduleGateFromReadiness({ checks: readinessChecks, supportConnector: true })
    : total !== null && (eligible ?? 0) + alreadyCoveredCount > 0
      ? {
        key: "calendar" as const,
        label: "Recording schedule",
        status: "pass" as const,
        detail: alreadyCoveredCount > 0
          ? `${alreadyCoveredCount} upcoming Corgtex scheduled meeting(s) already have recorder coverage.`
          : `${eligible ?? 0} upcoming Corgtex scheduled meeting(s) are eligible for recorder scheduling.`,
        checks: [{
          key: "internal_schedule",
          label: "Corgtex recorder schedule",
          status: "pass" as const,
          detail: "Corgtex internal scheduled meetings are available for recorder operations.",
        }],
      }
      : recorderScheduleGateFromReadiness({ checks: readinessChecks, supportConnector: true });
  const meetingStatus: ControlPlaneRecorderReadinessGateStatus = total === null
    ? "unknown"
    : total === 0
      ? "warning"
      : eligible === 0 && alreadyCoveredCount === 0 && blockerEntries.length > 0
        ? "blocked"
        : blockerEntries.length > 0
          ? "warning"
          : "pass";
  const sanitizedError = sanitizeDiagnosticText(params.errorDetail);

  return {
    controlPlane: {
      key: "control_plane",
      label: "Control Plane access",
      status: hasError ? "blocked" : "pass",
      detail: hasError
        ? sanitizedError
        : "Support connector returned recorder readiness.",
      checks: hasError
        ? [{
          key: "support_connector",
          label: "Support connector",
          status: "blocked",
          detail: sanitizedError,
        }]
        : [],
    },
    tenantConfig: recorderGateFromChecks({
      key: "tenant_config",
      label: "Tenant configuration",
      checks: readinessChecks.filter((check) => RECORDER_TENANT_CONFIG_CHECK_KEYS.has(check.key)),
      passDetail: "Recorder entitlement and workspace configuration are enabled.",
      emptyDetail: "Support connector readiness did not include tenant recorder configuration checks.",
    }),
    vendor: recorderGateFromChecks({
      key: "vendor",
      label: "Vendor credentials",
      checks: readinessChecks.filter((check) => RECORDER_VENDOR_CHECK_KEYS.has(check.key)),
      passDetail: "Recorder vendor runtime credentials are configured.",
      emptyDetail: "Support connector readiness did not include vendor credential checks.",
    }),
    calendar: scheduleGate,
    meetingState: {
      key: "meeting_state",
      label: "Scheduled meetings",
      status: meetingStatus,
      detail: total === null
        ? "Support connector readiness did not include scheduled meeting coverage counts."
        : total === 0
          ? "No upcoming scheduled meetings were found by the support connector."
          : alreadyCoveredCount > 0 && blockerEntries.length > 0
            ? `${alreadyCoveredCount} upcoming scheduled meeting(s) already have recorder coverage; ${blockerEntries.length} blocker type(s) remain.`
            : alreadyCoveredCount > 0 && (eligible ?? 0) === 0
              ? `${alreadyCoveredCount} of ${total} upcoming scheduled meeting(s) already have recorder coverage.`
              : `${eligible ?? 0} of ${total} upcoming scheduled meeting(s) are eligible for recorder coverage.`,
      checks: [...coveredEntries, ...blockerEntries],
    },
    liveVendorProof: recorderGateFromChecks({
      key: "live_vendor_proof",
      label: "Live vendor proof",
      checks: readinessChecks.filter((check) => RECORDER_LIVE_VENDOR_CHECK_KEYS.has(check.key)),
      passDetail: "A recent vendor-backed recorder smoke or real recording exists.",
      emptyDetail: "Support connector readiness did not include live vendor-backed recorder proof.",
    }),
  };
}

function compactSupportConnectorRecorderReadiness(resultSummary: unknown, errorDetail?: string | null) {
  const summary = resultSummary && typeof resultSummary === "object" ? resultSummary as JsonRecord : {};
  const checks = supportConnectorRecorderReadinessChecks(summary);
  const failedChecks = checks
    .filter((check) => !check.ok)
    .map((check) => ({
      key: check.key,
      label: check.label,
      detail: sanitizeDiagnosticText(check.detail),
    }));
  const coverageSummary = supportConnectorRecorderCoverageSummary(summary);
  const configured = typeof summary.configured === "boolean" ? summary.configured : null;
  const provider = typeof summary.provider === "string" ? summary.provider : null;
  const fallbackProvider = typeof summary.fallbackProvider === "string" ? summary.fallbackProvider : null;
  const status = typeof summary.status === "string" ? summary.status : null;
  const detail = typeof summary.detail === "string" ? sanitizeDiagnosticText(summary.detail) : null;
  const lastSmokeRun = jsonRecordOrNull(summary.lastSmokeRun);
  const lastSuccessfulRecording = jsonRecordOrNull(summary.lastSuccessfulRecording);
  const lastProviderAuthFailure = jsonRecordOrNull(summary.lastProviderAuthFailure);
  return {
    workspaceId: typeof summary.workspaceId === "string" ? summary.workspaceId : null,
    ready: Boolean(summary.ready) && !errorDetail,
    status: errorDetail ? "blocked" : (status ?? (summary.ready ? "ready" : "unknown")),
    configured,
    provider,
    fallbackProvider,
    detail: errorDetail ? sanitizeDiagnosticText(errorDetail) : (failedChecks[0]?.detail ?? detail),
    checks,
    failedChecks,
    gates: supportConnectorRecorderReadinessGates({ resultSummary, errorDetail }),
    upcomingCoverage: {
      window: coverageSummary.window ?? null,
      counts: coverageSummary.counts ?? null,
    },
    lastSmokeRun: lastSmokeRun
      ? {
        status: typeof lastSmokeRun.status === "string" ? lastSmokeRun.status : null,
        createdAt: lastSmokeRun.createdAt ?? null,
        completedAt: lastSmokeRun.completedAt ?? null,
      }
      : null,
    lastSuccessfulRecording: lastSuccessfulRecording
      ? {
        provider: typeof lastSuccessfulRecording.provider === "string" ? lastSuccessfulRecording.provider : null,
        status: typeof lastSuccessfulRecording.status === "string" ? lastSuccessfulRecording.status : null,
        observedAt: lastSuccessfulRecording.observedAt ?? null,
      }
      : null,
    lastProviderAuthFailure: lastProviderAuthFailure
      ? {
        provider: typeof lastProviderAuthFailure.provider === "string" ? lastProviderAuthFailure.provider : null,
        status: typeof lastProviderAuthFailure.status === "string" ? lastProviderAuthFailure.status : null,
        failureCode: typeof lastProviderAuthFailure.failureCode === "string" ? lastProviderAuthFailure.failureCode : null,
        detail: typeof lastProviderAuthFailure.detail === "string" ? sanitizeDiagnosticText(lastProviderAuthFailure.detail) : null,
        updatedAt: lastProviderAuthFailure.updatedAt ?? null,
      }
      : null,
  };
}

function compactRecorderMeetingOpsReadiness(readiness: Awaited<ReturnType<typeof getMeetingRecorderEnterpriseReadiness>>) {
  const failedChecks = readiness.checks
    .filter((check) => !check.ok)
    .map((check) => ({
      key: check.key,
      label: check.label,
      detail: sanitizeDiagnosticText(check.detail),
    }));
  return {
    workspaceId: readiness.workspaceId,
    status: recorderMeetingOpsStatus(readiness),
    ready: readiness.ready,
    configured: Boolean(readiness.config.enabled),
    provider: readiness.config.defaultProvider,
    fallbackProvider: readiness.config.fallbackProvider,
    detail: failedChecks[0]?.detail ?? "Recorder readiness checks are passing.",
    failedChecks,
    lastSmokeRun: readiness.lastSmokeRun
      ? {
        id: readiness.lastSmokeRun.id,
        status: readiness.lastSmokeRun.status,
        createdAt: readiness.lastSmokeRun.createdAt,
        completedAt: readiness.lastSmokeRun.completedAt,
      }
      : null,
    lastSuccessfulRecording: readiness.lastSuccessfulRecording,
    lastProviderAuthFailure: readiness.lastProviderAuthFailure,
  };
}

export async function getControlPlaneMeetingOperationsReadiness(actor: AppActor, deploymentId: string) {
  requireControlPlaneScope(actor, "control-plane:read");
  const deployment = await getControlPlaneDeploymentWithWorkspace(actor, deploymentId);
  const managedWorkspaceId = deployment.managedWorkspaceId;
  if (!managedWorkspaceId) {
    try {
      const operation = await runCustomerSupportOperation(actor, {
        deploymentId,
        action: "meeting_recorders.readiness",
      });
      return {
        deploymentId,
        managedWorkspaceId: null,
        accessMode: "support_connector" as const,
        agenda: null,
        recorder: compactSupportConnectorRecorderReadiness(
          operation.resultSummary,
          operation.resultSummary ? null : "Recorder readiness result was not returned by the customer support connector.",
        ),
      };
    } catch (error) {
      const detail = error instanceof Error
        ? sanitizeSupportReadinessDetail(error.message)
        : "Support connector readiness check failed.";
      return {
        deploymentId,
        managedWorkspaceId: null,
        accessMode: "support_connector" as const,
        agenda: null,
        recorder: compactSupportConnectorRecorderReadiness(null, detail),
      };
    }
  }
  const [agenda, recorder] = await Promise.all([
    getMeetingAgendaReadiness(managedWorkspaceId),
    getMeetingRecorderEnterpriseReadiness(managedWorkspaceId),
  ]);
  const coverage = recorder.coverage;
  return {
    deploymentId,
    managedWorkspaceId,
    accessMode: "managed_workspace" as const,
    agenda,
    recorder: {
      ...compactRecorderMeetingOpsReadiness(recorder),
      gates: buildManagedRecorderReadinessGates(recorder, coverage),
      upcomingCoverage: {
        window: coverage.window,
        counts: coverage.counts,
        meetings: coverage.meetings,
      },
    },
  };
}

export async function enqueueControlPlaneAgendaPreparation(actor: AppActor, params: {
  deploymentId: string;
  targetDateISO?: string | null;
  reason?: string | null;
}) {
  requireControlPlaneScope(actor, "control-plane:integrations:write");
  const reason = requireMutationReason(params.reason);
  await requireControlPlaneDeploymentWriteAccess(actor, params.deploymentId);
  const deployment = await getControlPlaneDeploymentWithWorkspace(actor, params.deploymentId);
  const managedWorkspaceId = deployment.managedWorkspaceId;
  invariant(managedWorkspaceId, 400, "MANAGED_WORKSPACE_REQUIRED", "Agenda preparation requires a managed workspace link.");
  const job = await enqueueWorkspaceMeetingAgendaPreparation({
    workspaceId: managedWorkspaceId,
    runAfter: new Date(),
    targetDateISO: params.targetDateISO,
  });
  await recordCustomerDeploymentEvent(actor, params.deploymentId, "control_plane.integration.meeting_agenda_prepare_requested", {
    reason,
    managedWorkspaceId,
    workflowJobId: job.id,
    targetDateISO: params.targetDateISO ?? null,
  });
  return {
    deploymentId: params.deploymentId,
    managedWorkspaceId,
    workflowJobId: job.id,
    targetDateISO: params.targetDateISO ?? null,
  };
}

async function runRemoteControlPlaneMeetingRecorderOperation(actor: AppActor, params: {
  deploymentId: string;
  operation: "enqueue_calendar_sync" | "dry_run_scan" | "live_smoke" | "enable_auto_recording_after_smoke";
  meetingUrl?: string | null;
  joinAt?: Date | null;
  provider: MeetingRecorderProvider;
}, reason: string) {
  let action: SupportAction;
  let args: JsonRecord = {};
  let eventAction: string;

  if (params.operation === "enqueue_calendar_sync") {
    action = "meeting_recorders.enqueue_calendar_sync";
    eventAction = "control_plane.integration.meeting_recorder_calendar_sync_requested";
  } else if (params.operation === "dry_run_scan") {
    action = "meeting_recorders.dry_run_scan";
    eventAction = "control_plane.integration.meeting_recorder_calendar_dry_run";
  } else if (params.operation === "live_smoke") {
    const meetingUrl = params.meetingUrl?.trim();
    invariant(meetingUrl, 400, "INVALID_INPUT", "A future meeting URL is required for live smoke.");
    invariant(params.joinAt && !Number.isNaN(params.joinAt.valueOf()), 400, "INVALID_INPUT", "A future join time is required for live smoke.");
    action = "meeting_recorders.live_smoke";
    args = {
      meetingUrl,
      joinAt: params.joinAt.toISOString(),
      provider: params.provider,
    };
    eventAction = "control_plane.integration.meeting_recorder_live_smoke";
  } else {
    action = "meeting_recorders.set_auto_recording";
    args = { enabled: true };
    eventAction = "control_plane.integration.meeting_recorder_auto_recording_enabled";
  }

  const operation = await runCustomerSupportOperation(actor, {
    deploymentId: params.deploymentId,
    action,
    scopeOverride: "control-plane:integrations:write",
    reason,
    arguments: args,
  });
  await recordCustomerDeploymentEvent(actor, params.deploymentId, eventAction, {
    reason,
    accessMode: "support_connector",
    requestedOperation: params.operation,
    supportOperationId: operation.id,
    resultSummary: operation.resultSummary ?? null,
  });
  return {
    deploymentId: params.deploymentId,
    managedWorkspaceId: null,
    accessMode: "support_connector" as const,
    operation: params.operation,
    supportOperation: {
      id: operation.id,
      action: operation.action,
      status: operation.status,
      error: operation.error ?? null,
      resultSummary: operation.resultSummary ?? null,
    },
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
  invariant(CONTROL_PLANE_MEETING_RECORDER_OPERATIONS.has(params.operation), 400, "INVALID_INPUT", "Unsupported meeting recorder operation.");
  await requireControlPlaneDeploymentWriteAccess(actor, params.deploymentId);
  const deployment = await getControlPlaneDeploymentWithWorkspace(actor, params.deploymentId);
  const provider = params.provider?.trim()
    ? normalizeMeetingRecorderProvider(params.provider, "meeting recorder smoke provider")
    : "RECALL_AI";
  const managedWorkspaceId = deployment.managedWorkspaceId;
  if (!managedWorkspaceId) {
    return runRemoteControlPlaneMeetingRecorderOperation(actor, {
      deploymentId: params.deploymentId,
      operation: params.operation,
      meetingUrl: params.meetingUrl,
      joinAt: params.joinAt,
      provider,
    }, reason);
  }

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
      enabled: override?.enabled ?? ("defaultEnabled" in meta ? meta.defaultEnabled : true),
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
  const meta = AGENT_REGISTRY[agentKey as keyof typeof AGENT_REGISTRY];
  invariant(Boolean(meta), 400, "INVALID_INPUT", "Unknown agent.");
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
      enabled: "defaultEnabled" in meta ? meta.defaultEnabled : true,
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

export async function getControlPlaneProviderStatus(actor: AppActor, deploymentId: string) {
  const deployment = await getControlPlaneDeploymentWithWorkspace(actor, deploymentId);
  const adapter = createControlPlaneAdapter(deployment);
  const provider = buildCustomerDeploymentProviderReadModel(deployment);
  invariant(provider.cloudProvider === "AZURE", 400, "AZURE_PROVIDER_REQUIRED", "Azure provider status is only available for Azure deployments.");
  invariant(adapter.canReadProviderStatus, 400, "PROVIDER_STATUS_UNAVAILABLE", "Provider status is not available for this deployment.");

  const [fleetSnapshots, latestSmoke, latestRegistrySync] = await Promise.all([
    prisma.fleetHealthSnapshot.findMany({
      where: { deploymentId },
      orderBy: { createdAt: "desc" },
      take: 12,
      select: {
        id: true,
        snapshotKind: true,
        status: true,
        summary: true,
        error: true,
        observedAt: true,
        createdAt: true,
      },
    }),
    prisma.selfServeSmokeRun.findFirst({
      where: { deploymentId },
      orderBy: { createdAt: "desc" },
      select: {
        runId: true,
        runKind: true,
        status: true,
        baseUrl: true,
        siteUrl: true,
        summary: true,
        error: true,
        startedAt: true,
        completedAt: true,
        createdAt: true,
      },
    }),
    prisma.customerDeploymentEvent.findFirst({
      where: {
        deploymentId,
        action: "self_serve.registry_synced",
      },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        meta: true,
        createdAt: true,
      },
    }),
  ]);

  const healthSnapshot = latestSnapshotForKind({ fleetSnapshots }, "HEALTH");
  const releaseSnapshot = latestSnapshotForKind({ fleetSnapshots }, "RELEASE");
  const costSummary = providerMetadataCostSummary(provider.providerMetadata);
  const costSource = costSummary
    ? "provider_metadata"
    : provider.providerCostUrl ? "portal_link" : "not_configured";

  return {
    deploymentId,
    adapter: {
      kind: adapter.kind,
      readOnly: true,
      canReadProviderStatus: adapter.canReadProviderStatus,
      canUseSupportConnector: adapter.canUseSupportConnector,
      requiresConnectorSetup: adapter.requiresConnectorSetup,
    },
    provider: {
      cloudProvider: provider.cloudProvider,
      providerLabel: provider.providerLabel,
      subscriptionId: provider.providerSubscriptionId,
      resourceGroup: provider.providerResourceGroup,
      environmentId: provider.providerEnvironmentId,
      webServiceId: provider.providerWebServiceId,
      workerServiceId: provider.providerWorkerServiceId,
      postgresServiceId: provider.providerPostgresServiceId,
      redisServiceId: provider.providerRedisServiceId,
      storageResourceId: provider.providerStorageResourceId,
    },
    health: {
      status: deployment.lastHealthStatus ?? healthSnapshot?.status ?? deployment.provisioningStatus ?? "unknown",
      lastHealthCheck: deployment.lastHealthCheck,
      lastHealthError: deployment.lastHealthError ?? healthSnapshot?.error ?? null,
      workerStatus: deployment.lastWorkerHealthStatus,
      workerCheckedAt: deployment.lastWorkerHealthCheck,
      latestSnapshot: compactSnapshot(healthSnapshot),
    },
    release: {
      releaseImageTag: deployment.releaseImageTag,
      releaseVersion: deployment.releaseVersion,
      lastReleaseCheck: deployment.lastReleaseCheck,
      releaseDrift: deployment.lastHealthError?.includes("Release drift:") ? deployment.lastHealthError : releaseSnapshot?.error ?? null,
      latestSnapshot: compactSnapshot(releaseSnapshot),
    },
    logs: {
      url: provider.providerLogsUrl,
      available: Boolean(provider.providerLogsUrl),
    },
    smoke: latestSmoke
      ? {
        status: latestSmoke.status,
        runId: latestSmoke.runId,
        runKind: latestSmoke.runKind,
        baseUrl: latestSmoke.baseUrl,
        siteUrl: latestSmoke.siteUrl,
        error: latestSmoke.error,
        summary: compactSelfServeSmokeSummary(latestSmoke.summary),
        startedAt: latestSmoke.startedAt,
        completedAt: latestSmoke.completedAt,
        createdAt: latestSmoke.createdAt,
      }
      : {
        status: "unknown",
        runId: null,
        runKind: null,
        baseUrl: null,
        siteUrl: null,
        error: null,
        summary: null,
        startedAt: null,
        completedAt: null,
        createdAt: null,
      },
    cost: {
      url: provider.providerCostUrl,
      available: Boolean(provider.providerCostUrl || costSummary),
      source: costSource,
      summary: costSummary,
    },
    registrySync: registrySyncSummary(latestRegistrySync),
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

function controlPlaneEnv(...names: string[]) {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return "";
}

export function getControlPlaneLatestReleaseTarget(options: {
  cloudProvider?: CustomerDeploymentCloudProvider | null;
} = {}): ControlPlaneReleaseTarget | null {
  const cloudProvider = options.cloudProvider ?? "RAILWAY";
  if (cloudProvider !== "RAILWAY" && cloudProvider !== "AZURE") {
    return null;
  }
  const prefix = cloudProvider === "AZURE" ? "CONTROL_PLANE_AZURE_LATEST" : "CONTROL_PLANE_RAILWAY_LATEST";
  const legacyPrefix = cloudProvider === "RAILWAY" ? "CONTROL_PLANE_LATEST" : null;
  const envNames = (suffix: string) => (
    legacyPrefix ? [`${prefix}_${suffix}`, `${legacyPrefix}_${suffix}`] : [`${prefix}_${suffix}`]
  );
  const sharedImage = controlPlaneEnv(...envNames("IMAGE"), ...envNames("ACR_IMAGE"), ...envNames("RELEASE_IMAGE_TAG"));
  const webImage = controlPlaneEnv(...envNames("WEB_IMAGE"), ...envNames("ACR_WEB_IMAGE")) || sharedImage;
  const workerImage = controlPlaneEnv(...envNames("WORKER_IMAGE"), ...envNames("ACR_WORKER_IMAGE")) || sharedImage;
  const releaseGitSha = controlPlaneEnv(...envNames("RELEASE_GIT_SHA")) || null;
  const releaseImageTag = controlPlaneEnv(...envNames("RELEASE_IMAGE_TAG")) || releaseGitSha || webImage;
  const releaseVersion = controlPlaneEnv(...envNames("RELEASE_VERSION")) || null;
  if (!webImage || !workerImage || !releaseImageTag) {
    return null;
  }
  return {
    cloudProvider,
    releaseImageTag,
    releaseVersion,
    releaseGitSha,
    webImage,
    workerImage,
    webRevision: controlPlaneEnv(...envNames("WEB_REVISION")) || null,
    workerRevision: controlPlaneEnv(...envNames("WORKER_REVISION")) || null,
    migrationJobStatus: controlPlaneEnv(...envNames("MIGRATION_JOB_STATUS")) || null,
    healthStatus: controlPlaneEnv(...envNames("HEALTH_STATUS")) || null,
  };
}

export function isControlPlaneRailwayDeployConfigured() {
  return Boolean(process.env.RAILWAY_API_TOKEN?.trim());
}

function releasePreflightForDeployment(deployment: {
  label?: string | null;
  url?: string | null;
  customerSlug?: string | null;
  cloudProvider?: CustomerDeploymentCloudProvider | null;
  deploymentKind?: CustomerDeploymentKind | string | null;
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
  providerResourceGroup?: string | null;
  providerEnvironmentId?: string | null;
  providerWebServiceId?: string | null;
  providerWorkerServiceId?: string | null;
}, target: ControlPlaneReleaseTarget | null, options: { railwayDeployConfigured?: boolean } = {}) {
  const cloudProvider = controlPlaneDeploymentCloudProvider(deployment);
  const railwayDeployConfigured = options.railwayDeployConfigured ?? isControlPlaneRailwayDeployConfigured();
  const sharedWorkspace = isControlPlaneSharedWorkspaceDeployment(deployment);
  const targetReleaseVersion = target?.releaseVersion ?? null;
  const currentReleaseVersion = deployment.releaseVersion ?? null;
  const targetDiffersFromCurrent = Boolean(target && (
    target.releaseImageTag !== deployment.releaseImageTag
    || targetReleaseVersion !== currentReleaseVersion
  ));
  const targetConfigDetail = cloudProvider === "AZURE"
    ? "Set CONTROL_PLANE_AZURE_LATEST_WEB_IMAGE, CONTROL_PLANE_AZURE_LATEST_WORKER_IMAGE, and CONTROL_PLANE_AZURE_LATEST_RELEASE_GIT_SHA."
    : "Set CONTROL_PLANE_RAILWAY_LATEST_WEB_IMAGE and CONTROL_PLANE_RAILWAY_LATEST_WORKER_IMAGE, or the legacy CONTROL_PLANE_LATEST_* Railway target.";
  const baseChecks: ControlPlaneReleasePreflightCheck[] = [
    {
      key: "target_configured",
      label: "Latest release configured",
      ok: Boolean(target),
      detail: target?.releaseImageTag ?? targetConfigDetail,
    },
    {
      key: "not_suspended",
      label: "Client is not suspended",
      ok: deployment.deploymentStatus !== "SUSPENDED" && deployment.provisioningStatus !== "suspended",
      detail: deployment.provisioningStatus || deployment.deploymentStatus || "Unknown deployment status.",
    },
    {
      key: "not_backup",
      label: "Deployment is primary production",
      ok: !isControlPlaneBackupDeployment(deployment),
      detail: isControlPlaneBackupDeployment(deployment)
        ? "Backup app is health-checked only and is not a deploy-latest target."
        : "Deployment participates in production release management.",
    },
    {
      key: "not_shared_workspace",
      label: "Deployment is not a shared workspace row",
      ok: !sharedWorkspace,
      detail: sharedWorkspace
        ? "Shared managed workspace rows are managed through the shared-cloud release workflow and are not deploy-latest targets."
        : "Deployment is a standalone release target.",
    },
  ];
  const providerChecks: ControlPlaneReleasePreflightCheck[] = cloudProvider === "AZURE"
    ? [
      {
        key: "azure_target",
        label: "Azure target is complete",
        ok: Boolean(deployment.providerResourceGroup && deployment.providerEnvironmentId && deployment.providerWebServiceId && deployment.providerWorkerServiceId),
        detail: deployment.providerResourceGroup
          ? "Resource group, Container Apps environment, web app, and worker app are recorded."
          : "Azure resource group and Container App identifiers are required.",
      },
      {
        key: "azure_release_metadata",
        label: "Azure release metadata is complete",
        ok: Boolean(target?.releaseGitSha && target.healthStatus),
        detail: target?.releaseGitSha && target.healthStatus
          ? `Release ${target.releaseGitSha} reported ${target.healthStatus}.`
          : "Azure release target must include release git SHA and health metadata from the approved Azure workflow.",
      },
      {
        key: "azure_workflow_reconciliation",
        label: "Azure workflow reconciliation required",
        ok: false,
        detail: "Azure self-serve releases are reconciled from Azure workflow/provider evidence; deploy-latest is disabled for this provider.",
      },
    ]
    : cloudProvider === "RAILWAY" ? [
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
    ] : [
      {
        key: "provider_supported",
        label: "Release provider is supported",
        ok: false,
        detail: `Deploy latest is not available for ${cloudProvider} deployments.`,
      },
    ];
  const healthChecks: ControlPlaneReleasePreflightCheck[] = [
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
      ok: targetDiffersFromCurrent,
      detail: target
        ? targetDiffersFromCurrent
          ? `Target ${target.releaseImageTag}; current ${deployment.releaseImageTag ?? "unknown"}.`
          : "Target already matches current release."
        : "No target release configured.",
    },
    {
      key: "no_release_drift",
      label: "No release drift is open",
      ok: isControlPlaneBackupDeployment(deployment) || !deployment.lastHealthError?.includes("Release drift:"),
      detail: deployment.lastHealthError?.includes("Release drift:") && !isControlPlaneBackupDeployment(deployment) ? deployment.lastHealthError : "No release drift recorded.",
    },
  ];
  const checks = [...baseChecks, ...providerChecks, ...healthChecks];
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
  const target = getControlPlaneLatestReleaseTarget({
    cloudProvider: controlPlaneDeploymentCloudProvider(deployment),
  });
  return {
    deploymentId,
    target,
    ...releasePreflightForDeployment(deployment, target),
  };
}

export async function validateControlPlaneRailwayReleaseExecutor(actor: AppActor, deploymentId: string, railwayClient?: RailwayClient) {
  requireControlPlaneScope(actor, CONTROL_PLANE_READ_SCOPE);
  const deployment = await getControlPlaneDeploymentWithWorkspace(actor, deploymentId);
  const cloudProvider = controlPlaneDeploymentCloudProvider(deployment);
  const target = getControlPlaneLatestReleaseTarget({ cloudProvider });
  const railwayConfigured = Boolean(railwayClient) || isControlPlaneRailwayDeployConfigured();
  const preflight = releasePreflightForDeployment(deployment, target, { railwayDeployConfigured: railwayConfigured });
  const accessCheckBase = {
    key: "railway_executor_access",
    label: "Railway executor can read target services",
  };

  if (cloudProvider !== "RAILWAY") {
    const detail = `Railway executor validation is only available for Railway deployments; this deployment uses ${cloudProvider}.`;
    return {
      deploymentId,
      provider: cloudProvider,
      target,
      status: "blocked" as const,
      checks: [...preflight.checks, { ...accessCheckBase, ok: false, detail }],
      blockers: [detail],
    };
  }

  if (!deployment.railwayProjectId || !deployment.railwayEnvironmentId || !deployment.railwayWebServiceId || !deployment.railwayWorkerServiceId) {
    const detail = "Railway project, environment, web service, and worker service IDs must be recorded before executor validation.";
    return {
      deploymentId,
      provider: cloudProvider,
      target,
      status: "blocked" as const,
      checks: [...preflight.checks, { ...accessCheckBase, ok: false, detail }],
      blockers: [detail],
    };
  }

  if (!railwayConfigured) {
    const detail = "Railway API token is not configured for control-plane release execution.";
    return {
      deploymentId,
      provider: cloudProvider,
      target,
      status: "blocked" as const,
      checks: [...preflight.checks, { ...accessCheckBase, ok: false, detail }],
      blockers: [detail],
    };
  }

  const activeRailwayClient = railwayClient ?? createRailwayClientFromEnv();
  try {
    const access = await validateRailwayReleaseExecutorAccess(activeRailwayClient, {
      projectId: deployment.railwayProjectId,
      environmentId: deployment.railwayEnvironmentId,
      webServiceId: deployment.railwayWebServiceId,
      workerServiceId: deployment.railwayWorkerServiceId,
    });
    const detail = "Railway token can read the recorded project, environment, web service, and worker service.";
    return {
      deploymentId,
      provider: cloudProvider,
      target,
      status: "ok" as const,
      access,
      checks: [...preflight.checks, { ...accessCheckBase, ok: true, detail }],
      blockers: preflight.blockers,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Railway executor access validation failed.";
    const detail = `Railway executor access validation failed: ${message}`;
    return {
      deploymentId,
      provider: cloudProvider,
      target,
      status: "blocked" as const,
      checks: [...preflight.checks, { ...accessCheckBase, ok: false, detail }],
      blockers: [detail],
    };
  }
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
  const cloudProvider = controlPlaneDeploymentCloudProvider(deployment);
  const target = params.target ?? getControlPlaneLatestReleaseTarget({ cloudProvider });
  const preflight = releasePreflightForDeployment(deployment, target, { railwayDeployConfigured: Boolean(railwayClient) || isControlPlaneRailwayDeployConfigured() });
  const canForceDeploy = Boolean(params.force && canBypassDeployLatestPreflight(preflight));
  if (!preflight.eligible && !canForceDeploy) {
    throw new AppError(400, "RELEASE_PREFLIGHT_FAILED", preflight.blockers.join(" "));
  }
  invariant(target, 400, "LATEST_RELEASE_NOT_CONFIGURED", "Latest release target is not configured.");
  invariant(
    cloudProvider === "RAILWAY",
    400,
    "PROVIDER_DEPLOY_UNSUPPORTED",
    "Deploy latest is currently available only for Railway enterprise deployments. Use the Azure self-serve workflow and record verified release evidence for Azure deployments.",
  );
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
        CORGTEX_RELEASE_GIT_SHA: target.releaseGitSha ?? "",
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
  const railwayTarget = getControlPlaneLatestReleaseTarget({ cloudProvider: "RAILWAY" });

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
      const target = getControlPlaneLatestReleaseTarget({
        cloudProvider: controlPlaneDeploymentCloudProvider(deployment),
      });
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
      invariant(target, 400, "LATEST_RELEASE_NOT_CONFIGURED", "Latest release target is not configured.");

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
    target: railwayTarget,
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
  const skipUrlHealthProbe = Boolean(deployment.managedWorkspaceId) || isControlPlaneSharedWorkspaceDeployment(deployment);
  const skipReleaseDriftCheck = skipUrlHealthProbe || isControlPlaneBackupDeployment(deployment);
  const probeSkippedReason = skipUrlHealthProbe
    ? "Managed workspace rows use local control-plane state and are not probed as standalone deployment URLs."
    : null;

  if (skipUrlHealthProbe) {
    status = "ok";
  } else {
    try {
      const response = await fetchWithControlPlaneTimeout(
        `${deployment.url.replace(/\/$/, "")}/api/health`,
        { method: "GET" },
        CONTROL_PLANE_HEALTH_PROBE_TIMEOUT_MS,
        "HEALTH_PROBE_TIMEOUT",
        "Health probe timed out. Retry after the customer deployment is reachable.",
      );
      health = await response.json().catch(() => null) as CustomerDeploymentHealthPayload | null;
      if (response.ok) {
        status = "ok";
        const runtimeErrors = [];
        if (health?.database && health.database !== "up") runtimeErrors.push(`Database ${health.database}`);
        if (health?.schema && health.schema !== "ready") runtimeErrors.push(`Schema ${health.schema}`);
        if (health?.runtime?.redis && health.runtime.redis !== "configured") runtimeErrors.push(`Redis ${health.runtime.redis}`);
        if (health?.runtime?.storage && health.runtime.storage !== "configured") runtimeErrors.push(`Storage ${health.runtime.storage}`);
        if (!skipReleaseDriftCheck && deployment.releaseImageTag && health?.release && !observedReleaseMatches(health, deployment.releaseImageTag)) {
          runtimeErrors.push(`Release drift: expected ${deployment.releaseImageTag}, got ${observedReleaseLabel(health)}`);
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
        probeSkippedReason,
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
        probeSkippedReason,
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

function observedReleaseLabel(health: CustomerDeploymentHealthPayload | null) {
  const values = [
    health?.release?.imageTag,
    health?.release?.gitSha,
  ].filter((value): value is string => Boolean(value));
  return values.length ? values.join(" / ") : "unknown";
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
    const response = await fetchWithControlPlaneTimeout(
      `${deployment.url.replace(/\/$/, "")}/api/health`,
      { method: "GET" },
      CONTROL_PLANE_HEALTH_PROBE_TIMEOUT_MS,
      "HEALTH_PROBE_TIMEOUT",
      "Health probe timed out. Retry after the customer deployment is reachable.",
    );
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

function boundedCount(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

function countItems(value: unknown) {
  if (Array.isArray(value)) return value.length;
  const record = jsonRecord(value);
  if (!record) return null;
  if (Array.isArray(record.items)) return record.items.length;
  if (record.counts && typeof record.counts === "object" && !Array.isArray(record.counts)) {
    return Object.values(record.counts as JsonRecord)
      .map(boundedCount)
      .filter((count): count is number => count !== null)
      .reduce((total, count) => total + count, 0);
  }
  return boundedCount(record.total);
}

function statusCounts(value: unknown): Record<string, number> {
  const record = jsonRecord(value);
  const items: unknown[] = Array.isArray(value)
    ? value
    : Array.isArray(record?.items)
      ? record.items
      : [];
  const counts: Record<string, number> = {};
  for (const item of items) {
    const status = stringField(jsonRecord(item)?.status)?.toLowerCase();
    if (!status) continue;
    counts[status] = (counts[status] ?? 0) + 1;
  }
  return counts;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error ?? "");
}

function missingKnownRequiredScopeFromMessage(message: string, requiredScopes: readonly AgentScope[]) {
  const match = message.match(/(?:required scope|required permission):\s*([a-z0-9:-]+)/i);
  const scope = match?.[1]?.trim();
  return scope && isKnownScope(scope) && requiredScopes.includes(scope) ? scope : null;
}

function postDeployProbeErrorClass(error: unknown, requiredScopes: readonly AgentScope[] = []) {
  const message = errorMessage(error);
  if (missingKnownRequiredScopeFromMessage(message, requiredScopes)) return "MISSING_SUPPORT_SCOPE";
  if (/scope|required scope|required permission|forbidden|unauthorized|missing session|invalid signature/i.test(message)) return "REMOTE_AUTH_OR_SCOPE";
  if (/timeout|timed out/i.test(message)) return "REMOTE_TIMEOUT";
  if (/fetch|network|ECONN|ENOTFOUND|ECONNRESET/i.test(message)) return "REMOTE_NETWORK";
  if (error instanceof AppError) return error.code;
  return "REMOTE_ERROR";
}

function supportConnectorReadinessResult(params: {
  status: "ready" | "missing_scope" | "unavailable" | "unknown";
  requiredScopes: readonly AgentScope[];
  missingScopes?: readonly AgentScope[];
  checkedAt?: string;
}) {
  return {
    status: params.status,
    requiredScopes: [...params.requiredScopes],
    missingScopes: [...(params.missingScopes ?? [])],
    checkedAt: params.checkedAt ?? new Date().toISOString(),
  };
}

function summarizeSupportConnectorReadiness(value: unknown, requiredScopes: readonly AgentScope[]) {
  const record = jsonRecord(value);
  if (!record) {
    return supportConnectorReadinessResult({ status: "unknown", requiredScopes });
  }

  if (Array.isArray(record.scopes)) {
    const scopes = record.scopes.filter((scope): scope is string => typeof scope === "string");
    const missingScopes = getMissingPostDeployReadProbeScopes(scopes, requiredScopes);
    return supportConnectorReadinessResult({
      status: missingScopes.length > 0 ? "missing_scope" : "ready",
      requiredScopes,
      missingScopes,
    });
  }

  if (record.authKind === "agent" && record.scopes == null) {
    return supportConnectorReadinessResult({ status: "ready", requiredScopes });
  }

  return supportConnectorReadinessResult({ status: "unknown", requiredScopes });
}

async function getSupportConnectorReadiness(
  connector: Awaited<ReturnType<typeof loadSupportConnector>>,
  requiredScopes: readonly AgentScope[],
) {
  try {
    const result = await callMcpTool({
      mcpUrl: connector.mcpUrl,
      bearerToken: connector.bearerToken,
      toolName: "get_current_connection",
      arguments: {},
    });
    const summarized = summarizeMcpResponse(result);
    const remoteError = supportMcpErrorMessage(summarized);
    if (remoteError) {
      throw new AppError(502, "REMOTE_SUPPORT_OPERATION_FAILED", remoteError);
    }
    return summarizeSupportConnectorReadiness(summarized, requiredScopes);
  } catch (error) {
    const missingScope = missingKnownRequiredScopeFromMessage(errorMessage(error), requiredScopes);
    if (missingScope) {
      return supportConnectorReadinessResult({
        status: "missing_scope",
        requiredScopes,
        missingScopes: [missingScope],
      });
    }
    return supportConnectorReadinessResult({ status: "unavailable", requiredScopes });
  }
}

function scanFailureCode(value: unknown): string | null {
  if (typeof value === "string") {
    return RECORDER_CREDIT_FAILURE_PATTERN.test(value) ? "insufficient_credit_balance" : null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const code = scanFailureCode(item);
      if (code) return code;
    }
    return null;
  }
  const record = jsonRecord(value);
  if (!record) return null;
  for (const [key, entry] of Object.entries(record)) {
    if (/url|token|secret|credential|transcript|summary|title|body|description/i.test(key)) continue;
    const code = scanFailureCode(entry);
    if (code) return code;
  }
  return null;
}

function summarizePostDeployReadProbe(key: string, label: string, value: unknown) {
  const record = jsonRecord(value);
  const counts = record?.counts && typeof record.counts === "object" && !Array.isArray(record.counts)
    ? Object.fromEntries(
      Object.entries(record.counts as JsonRecord)
        .map(([countKey, countValue]) => [countKey, boundedCount(countValue)])
        .filter((entry): entry is [string, number] => entry[1] !== null),
    )
    : null;
  return {
    key,
    label,
    status: "ok",
    count: countItems(value),
    counts,
    statuses: statusCounts(value),
  };
}

function summarizePostDeployRecorder(integrations: Awaited<ReturnType<typeof getControlPlaneIntegrationStatus>>) {
  const recorder = integrations.integrations.find((integration) => {
    const key = stringField((integration as JsonRecord).key)?.toLowerCase();
    const label = stringField((integration as JsonRecord).label)?.toLowerCase();
    return key === "meeting_recorders" || Boolean(label?.includes("recorder"));
  }) as JsonRecord | undefined;

  if (!recorder) {
    return {
      key: "recorder_readiness",
      label: "Recorder readiness",
      status: integrations.requiresConnectorSetup ? "requires_connector" : "not_configured",
      configured: false,
      entitlementEnabled: false,
      vendorReadiness: false,
      provider: null,
      failureCount: null,
      lastSmokeStatus: null,
      failureCode: null,
    };
  }

  const readiness = jsonRecord(recorder.readiness);
  const lastSmokeRun = jsonRecord(recorder.lastSmokeRun) ?? jsonRecord(readiness?.lastSmokeRun);
  const failureCode = scanFailureCode(recorder);
  const vendorReady = booleanField(recorder.vendorReadiness);
  const failures = boundedCount(recorder.failures);
  const status = failureCode
    ? "failed"
    : vendorReady === false || (failures ?? 0) > 0
      ? "degraded"
      : vendorReady === true
        ? "ok"
        : "unknown";

  return {
    key: "recorder_readiness",
    label: "Recorder readiness",
    status,
    configured: booleanField(recorder.configured),
    entitlementEnabled: booleanField(recorder.entitlementEnabled),
    vendorReadiness: vendorReady,
    provider: stringField(recorder.provider),
    failureCount: failures,
    lastSmokeStatus: stringField(lastSmokeRun?.status),
    failureCode,
  };
}

function postDeployProbeStatus(
  reads: Array<{ status: string }>,
  recorder: { status: string },
  supportAudit: { status: string },
  requireRemoteSupportAudit: boolean,
  supportConnectorReadiness: { status: string },
) {
  if (supportConnectorReadiness.status !== "ready") return "failed";
  if (reads.some((probe) => probe.status === "failed")) return "failed";
  if (recorder.status === "failed") return "failed";
  if (requireRemoteSupportAudit && supportAudit.status !== "completed") return "failed";
  if (["degraded", "requires_connector", "not_configured", "unknown"].includes(recorder.status)) return "degraded";
  return "ok";
}

function postDeployProbeError(result: { status: string; supportConnectorReadiness?: { status: string; missingScopes?: string[] | null }; reads: Array<{ key: string; status: string; errorClass?: string | null }>; recorder: { status: string; failureCode?: string | null }; supportAudit: { status: string; errorClass?: string | null } }) {
  if (result.status === "ok") return null;
  if (result.supportConnectorReadiness?.status && result.supportConnectorReadiness.status !== "ready") {
    const code = result.supportConnectorReadiness.status === "missing_scope" ? "MISSING_SUPPORT_SCOPE" : result.supportConnectorReadiness.status;
    return `support_connector:${code}`;
  }
  const failedRead = result.reads.find((probe) => probe.status === "failed");
  if (failedRead) return `${failedRead.key}:${failedRead.errorClass ?? "failed"}`;
  if (result.recorder.status === "failed") return `recorder:${result.recorder.failureCode ?? "failed"}`;
  if (result.supportAudit.status !== "completed") return `support_audit:${result.supportAudit.errorClass ?? result.supportAudit.status}`;
  return result.recorder.status === "degraded" ? "recorder:degraded" : "post_deploy_probe:degraded";
}

export async function runControlPlanePostDeployProbe(actor: AppActor, params: {
  deploymentId: string;
  reason?: string | null;
  releaseImageTag?: string | null;
  releaseVersion?: string | null;
  requireRemoteSupportAudit?: boolean | null;
}) {
  requireControlPlaneScope(actor, "control-plane:fleet:write");
  const reason = requireMutationReason(params.reason);
  await requireControlPlaneAccess(actor, { deploymentId: params.deploymentId });
  const connector = await loadSupportConnector(params.deploymentId);
  const requiredReadScopes = getRequiredScopesForPostDeployReadProbes();
  const operationId = `post-deploy-probe:${params.deploymentId}:${Date.now()}`;
  const requireRemoteSupportAudit = Boolean(params.requireRemoteSupportAudit);
  const supportAudit: { status: string; errorClass: string | null } = { status: "skipped", errorClass: null };

  try {
    await recordRemoteSupportAudit({
      mcpUrl: connector.mcpUrl,
      bearerToken: connector.bearerToken,
      action: "post_deploy_probe",
      reason,
      operationId,
      phase: "started",
    });
    supportAudit.status = "started";
  } catch (error) {
    supportAudit.status = "failed";
    supportAudit.errorClass = postDeployProbeErrorClass(error);
  }

  const supportConnectorReadiness = await getSupportConnectorReadiness(connector, requiredReadScopes);

  const reads: Array<{
    key: string;
    label: string;
    status: string;
    count?: number | null;
    counts?: Record<string, number> | null;
    statuses?: Record<string, number>;
    errorClass?: string | null;
  }> = [];

  for (const probe of POST_DEPLOY_CUSTOMER_READ_PROBES) {
    const probeRequiredScopes = getRequiredScopesForPostDeployReadProbe(probe);
    try {
      const result = await callMcpTool({
        mcpUrl: connector.mcpUrl,
        bearerToken: connector.bearerToken,
        toolName: probe.toolName,
        arguments: probe.arguments,
      });
      const summarized = summarizeMcpResponse(result);
      const remoteError = supportMcpErrorMessage(summarized);
      if (remoteError) {
        throw new AppError(502, "REMOTE_SUPPORT_OPERATION_FAILED", remoteError);
      }
      reads.push(summarizePostDeployReadProbe(probe.key, probe.label, summarized));
    } catch (error) {
      reads.push({
        key: probe.key,
        label: probe.label,
        status: "failed",
        errorClass: postDeployProbeErrorClass(error, probeRequiredScopes),
      });
    }
  }

  let recorder: ReturnType<typeof summarizePostDeployRecorder>;
  try {
    recorder = summarizePostDeployRecorder(await getControlPlaneIntegrationStatus(actor, params.deploymentId));
  } catch (error) {
    recorder = {
      key: "recorder_readiness",
      label: "Recorder readiness",
      status: "failed",
      configured: null,
      entitlementEnabled: null,
      vendorReadiness: null,
      provider: null,
      failureCount: null,
      lastSmokeStatus: null,
      failureCode: postDeployProbeErrorClass(error),
    };
  }

  const result = {
    deploymentId: params.deploymentId,
    releaseImageTag: params.releaseImageTag?.trim() || null,
    releaseVersion: params.releaseVersion?.trim() || null,
    observedAt: new Date().toISOString(),
    status: "unknown",
    sanitized: true,
    reads,
    recorder,
    supportConnectorReadiness,
    supportAudit,
  };
  result.status = postDeployProbeStatus(reads, recorder, supportAudit, requireRemoteSupportAudit, supportConnectorReadiness);

  if (supportAudit.status === "started") {
    try {
      const probeFailed = supportConnectorReadiness.status !== "ready" || reads.some((probe) => probe.status === "failed") || recorder.status === "failed";
      await recordRemoteSupportAudit({
        mcpUrl: connector.mcpUrl,
        bearerToken: connector.bearerToken,
        action: "post_deploy_probe",
        reason,
        operationId,
        phase: probeFailed ? "failed" : "completed",
        result: {
          status: probeFailed ? "failed" : "ok",
          reads: reads.map((probe) => ({ key: probe.key, status: probe.status, count: probe.count ?? null, errorClass: probe.errorClass ?? null })),
          recorder,
          supportConnectorReadiness,
        },
        error: probeFailed ? postDeployProbeError({ ...result, status: "failed" }) : null,
      });
      supportAudit.status = "completed";
      result.status = postDeployProbeStatus(reads, recorder, supportAudit, requireRemoteSupportAudit, supportConnectorReadiness);
    } catch (auditError) {
      supportAudit.status = "failed";
      supportAudit.errorClass = postDeployProbeErrorClass(auditError);
      result.status = postDeployProbeStatus(reads, recorder, supportAudit, requireRemoteSupportAudit, supportConnectorReadiness);
    }
  }

  await Promise.all([
    recordFleetHealthSnapshot({
      customerAccountId: connector.deployment.customerAccountId,
      deploymentId: params.deploymentId,
      snapshotKind: "SUPPORT_READY",
      status: result.status,
      summary: result,
      error: postDeployProbeError(result),
    }),
    recordCustomerDeploymentEvent(actor, params.deploymentId, "control_plane.post_deploy_probe_completed", {
      reason,
      result,
    }),
  ]);

  return result;
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
    callMcpTool({ ...connector, toolName: "get_newspaper_diagnostics", arguments: { take: 10 } }),
  ]);

  const [workspace, members, integrations, dataSources, agentRuns, failedJobs, newspaperDiagnostics] = calls.map((result) => (
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

  const snapshot = { workspace, members, integrations, dataSources, agentRuns, failedJobs, newspaperDiagnostics };
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
  const connector = await loadSupportConnector(params.deploymentId);

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

async function findSupportAuditByIdempotencyKey(params: {
  idempotencyKey: string;
  deploymentId: string;
  operationAction: string;
  reason: string;
  inputSummary: JsonRecord;
}) {
  const existing = await prisma.supportOperation.findUnique({
    where: { idempotencyKey: params.idempotencyKey },
  });
  if (!existing) return null;
  invariant(
    existing.deploymentId === params.deploymentId && existing.action === params.operationAction,
    409,
    "IDEMPOTENCY_KEY_CONFLICT",
    "Idempotency key was already used for a different support operation.",
  );
  invariant(
    existing.reason === params.reason && stableJson(existing.inputSummary ?? null) === stableJson(params.inputSummary),
    409,
    "IDEMPOTENCY_KEY_CONFLICT",
    "Idempotency key was already used for different support audit evidence.",
  );
  if (existing.status === "COMPLETED") {
    return {
      ...existing,
      idempotentReplay: true,
    };
  }
  invariant(
    false,
    409,
    existing.status === "FAILED" ? "IDEMPOTENCY_KEY_NOT_REPLAYABLE" : "IDEMPOTENCY_KEY_IN_PROGRESS",
    existing.status === "FAILED"
      ? "Idempotency key belongs to a failed support audit; reconcile the existing operation before retrying with a new key."
      : "Idempotency key is already in use by an in-progress support audit.",
  );
}

function supportAuditRemoteWorkspaceId(
  deployment: { remoteWorkspaceId?: string | null },
  requestedRemoteWorkspaceId: string | null | undefined,
) {
  const expected = deployment.remoteWorkspaceId?.trim() || null;
  const requested = requestedRemoteWorkspaceId?.trim() || null;
  invariant(!requested || requested === expected, 400, "INVALID_INPUT", "Remote workspace id must match the selected deployment.");
  return expected;
}

export async function recordCustomerSupportAudit(actor: AppActor, params: {
  deploymentId: string;
  action: string;
  reason?: string | null;
  summary?: string | null;
  outcome?: string | null;
  evidence?: unknown;
  remoteWorkspaceId?: string | null;
  idempotencyKey?: string | null;
}) {
  requireControlPlaneScope(actor, "control-plane:support:write");
  if (!isControlPlaneAgent(actor)) {
    await requireControlPlaneDeploymentWriteAccess(actor, params.deploymentId);
  }
  const reason = requireMutationReason(params.reason);
  invariant(reason.length <= SUPPORT_AUDIT_MAX_REASON_LENGTH, 400, "INVALID_INPUT", "Support audit reason must be 1000 characters or fewer.");
  invariant(!SUPPORT_AUDIT_SECRET_VALUE_PATTERN.test(reason), 400, "INVALID_INPUT", "Support audit reason must not contain credentials, secrets, tokens, passwords, or bearer authorization values.");
  const audit = normalizeSupportAuditInput(params);
  const operationAction = `support.audit.${audit.action}`;
  const idempotencyKey = normalizeSupportAuditIdempotencyKey(params.idempotencyKey);
  const deployment = await prisma.customerDeployment.findUnique({ where: { id: params.deploymentId } });
  invariant(deployment, 404, "NOT_FOUND", "Customer deployment not found.");
  const remoteWorkspaceId = supportAuditRemoteWorkspaceId(deployment, params.remoteWorkspaceId);
  const workspaceId = deployment.managedWorkspaceId ?? null;
  const inputSummary = {
    ...audit,
    remoteWorkspaceId,
  };

  let operation: Awaited<ReturnType<typeof prisma.supportOperation.create>> | null = null;
  if (idempotencyKey) {
    const existing = await findSupportAuditByIdempotencyKey({
      idempotencyKey,
      deploymentId: params.deploymentId,
      operationAction,
      reason,
      inputSummary,
    });
    if (existing) return existing;
  }

  const connector = await loadSupportConnector(params.deploymentId);

  try {
    operation = await prisma.supportOperation.create({
      data: {
        deploymentId: params.deploymentId,
        workspaceId,
        actorUserId: actorUserId(actor),
        actorLabel: SUPPORT_ACTOR_LABEL,
        action: operationAction,
        reason,
        status: "RUNNING",
        startedAt: new Date(),
        inputSummary: inputSummary as Prisma.InputJsonObject,
        idempotencyKey,
      },
    });
  } catch (error) {
    if (!idempotencyKey || !isPrismaUniqueConstraintError(error)) throw error;
    const existing = await findSupportAuditByIdempotencyKey({
      idempotencyKey,
      deploymentId: params.deploymentId,
      operationAction,
      reason,
      inputSummary,
    });
    if (existing) return existing;
    throw error;
  }
  invariant(operation, 500, "SUPPORT_OPERATION_NOT_CREATED", "Support audit operation was not created.");

  let remoteAudit: unknown;
  let summarized: unknown;
  let remoteAcknowledgement: { id: string; operationId: string };
  try {
    remoteAudit = await callMcpTool({
      mcpUrl: connector.mcpUrl,
      bearerToken: connector.bearerToken,
      toolName: "record_support_audit",
      arguments: {
        action: operationAction,
        reason,
        operationId: operation.id,
        phase: "completed",
        result: audit,
      },
    });
    summarized = summarizeMcpResponse(remoteAudit);
    remoteAcknowledgement = requireRemoteSupportAuditAcknowledgement({ raw: remoteAudit, summarized, operationId: operation.id });
  } catch (error) {
    const message = sanitizeSupportAuditFailureMessage(error instanceof Error ? error.message : "Support audit recording failed.");
    await prisma.supportOperation.update({
      where: { id: operation.id },
      data: {
        status: "FAILED",
        completedAt: new Date(),
        error: message,
      },
    });
    if (error instanceof AppError) throw new AppError(error.status, error.code, message);
    throw new AppError(502, "REMOTE_SUPPORT_OPERATION_FAILED", message);
  }
  const resultSummary = {
    ...audit,
    remoteAudit: remoteAcknowledgement,
    recorded: true,
  };

  return prisma.supportOperation.update({
    where: { id: operation.id },
    data: {
      status: "COMPLETED",
      completedAt: new Date(),
      resultSummary: resultSummary as Prisma.InputJsonObject,
    },
  });
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
