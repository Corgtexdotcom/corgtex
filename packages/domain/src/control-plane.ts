import type { FleetSnapshotKind, MeetingRecorderProvider, Prisma } from "@prisma/client";
import { decryptSecret, encryptSecret, env, prisma } from "@corgtex/shared";
import type { AgentActor, AppActor } from "@corgtex/shared";
import { AppError, invariant } from "./errors";
import { isGlobalOperator } from "./auth";
import { getMeetingRecorderMonthlyUsage, MEETING_RECORDERS_FEATURE_FLAG } from "./meeting-recorders";
import { createControlPlaneAdapter } from "./control-plane-adapters";

const SUPPORT_ACTOR_LABEL = "Corgtex Support";
const DEFAULT_RECORDER_BOT_NAME = "Corgtex Recorder";
const DEFAULT_RECORDER_ENTRY_MESSAGE = "Corgtex is joining to record, transcribe, and summarize this meeting for the workspace.";
const DEFAULT_RECORDER_MONTHLY_MINUTE_CAP = 6_000;
const MEETING_RECORDER_PROVIDERS = new Set(["RECALL_AI", "MEETING_BAAS"]);
const CONTROL_PLANE_CONTEXT_OPERATIONS = new Set(["sync_all", "sync_source", "disable_source"]);
const CONTROL_PLANE_RELEASE_OPERATIONS = new Set(["prepare_upgrade"]);
const CONTROL_PLANE_READ_SCOPE = "control-plane:read";
export const CONTROL_PLANE_FLEET_SNAPSHOT_JOB_TYPE = "control-plane.fleet-snapshot";
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
  "members.deactivate",
  "data_feeds.sync",
  "tool_links.upsert",
  "tool_links.archive",
  "documents.upload_text",
  "runtime.retry_failed_job",
  "runtime.discard_failed_job",
  "support.break_glass_note",
]);

const SUPPORT_ACTION_TO_MCP_TOOL = {
  "members.list": "list_members",
  "members.invite": "create_member",
  "members.deactivate": "deactivate_member",
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
  "documents.upload_text": "upload_document_text",
} as const;

export type SupportAction = keyof typeof SUPPORT_ACTION_TO_MCP_TOOL;

type JsonRecord = Record<string, unknown>;

const managedWorkspaceSelect = {
  id: true,
  slug: true,
  name: true,
  _count: {
    select: {
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
} satisfies Prisma.InstanceRegistryInclude;

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
  if (/token|secret|password|credential|connection|string|authorization|bearer/i.test(key)) {
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

function normalizeSupportMcpUrl(instance: { url: string; supportMcpUrl?: string | null }) {
  if (instance.supportMcpUrl?.trim()) {
    return instance.supportMcpUrl.trim();
  }
  return `${instance.url.replace(/\/$/, "")}/api/mcp`;
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

async function loadSupportConnector(instanceId: string) {
  const instance = await prisma.instanceRegistry.findUnique({
    where: { id: instanceId },
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
  invariant(instance, 404, "NOT_FOUND", "Customer instance not found.");
  invariant(instance.supportCredentialEnc, 400, "SUPPORT_CONNECTOR_MISSING", "Support connector credentials are not configured for this instance.");
  return {
    instance,
    mcpUrl: normalizeSupportMcpUrl(instance),
    bearerToken: decryptSecret(instance.supportCredentialEnc),
  };
}

async function recordHostedEvent(actor: AppActor, instanceId: string, action: string, meta: JsonRecord = {}) {
  await prisma.hostedInstanceEvent.create({
    data: {
      instanceId,
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

export async function requireControlPlaneAccess(actor: AppActor, params: { instanceId?: string } = {}) {
  if (isGlobalOperator(actor)) {
    return { role: "OPERATOR" as const };
  }

  if (isControlPlaneAgent(actor)) {
    requireControlPlaneScope(actor, CONTROL_PLANE_READ_SCOPE);
    return { role: "OPERATOR" as const };
  }

  if (actor.kind === "user" && params.instanceId) {
    const access = await prisma.controlPlaneInstanceAccess.findUnique({
      where: {
        instanceId_userId: {
          instanceId: params.instanceId,
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

export async function listControlPlaneCustomers(actor: AppActor) {
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

  const orphanedDeployments = await prisma.instanceRegistry.findMany({
    where: { customerAccountId: null },
    orderBy: { createdAt: "desc" },
    include: controlPlaneDeploymentInclude,
  });

  const orphanedRows = orphanedDeployments.map((instance) => ({
    ...instance,
    hasDeployment: true,
    hasSupportCredential: Boolean(instance.supportCredentialEnc),
    supportCredentialEnc: undefined,
  }));

  return [...accountRows, ...orphanedRows];
}

export async function getControlPlaneCustomer(actor: AppActor, instanceId: string) {
  await requireControlPlaneAccess(actor, { instanceId });

  const instance = await prisma.instanceRegistry.findUnique({
    where: { id: instanceId },
    include: {
      events: {
        orderBy: { createdAt: "desc" },
        take: 20,
      },
      supportOperations: {
        orderBy: { createdAt: "desc" },
        take: 30,
      },
      controlPlaneAccess: {
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
  invariant(instance, 404, "NOT_FOUND", "Customer instance not found.");

  return {
    ...instance,
    hasSupportCredential: Boolean(instance.supportCredentialEnc),
    supportCredentialEnc: undefined,
  };
}

async function getControlPlaneInstanceWithWorkspace(actor: AppActor, instanceId: string) {
  await requireControlPlaneAccess(actor, { instanceId });
  const instance = await prisma.instanceRegistry.findUnique({
    where: { id: instanceId },
    include: {
      managedWorkspace: {
        select: managedWorkspaceSelect,
      },
    },
  });
  invariant(instance, 404, "NOT_FOUND", "Customer instance not found.");
  return {
    ...instance,
    hasSupportCredential: Boolean(instance.supportCredentialEnc),
    supportCredentialEnc: undefined,
  };
}

export async function getControlPlaneContextHealth(actor: AppActor, instanceId: string) {
  const instance = await getControlPlaneInstanceWithWorkspace(actor, instanceId);
  const adapter = createControlPlaneAdapter(instance);
  if (!adapter.canReadCentralWorkspace || !instance.managedWorkspaceId) {
    return {
      instanceId,
      accessMode: adapter.kind,
      hasManagedWorkspace: false,
      supportConnectorStatus: instance.supportConnectorStatus,
      supportLastSyncAt: instance.supportLastSyncAt,
      supportLastSyncError: instance.supportLastSyncError,
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
      where: { workspaceId: instance.managedWorkspaceId, archivedAt: null },
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
    prisma.brainSource.count({ where: { workspaceId: instance.managedWorkspaceId, archivedAt: null } }),
    prisma.externalDataSource.findMany({
      where: { workspaceId: instance.managedWorkspaceId, archivedAt: null },
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
    prisma.externalDataSource.count({ where: { workspaceId: instance.managedWorkspaceId, archivedAt: null } }),
    prisma.knowledgeChunk.count({ where: { workspaceId: instance.managedWorkspaceId } }),
    prisma.workflowJob.count({
      where: {
        workspaceId: instance.managedWorkspaceId,
        status: "FAILED",
        type: { contains: "sync" },
      },
    }),
    prisma.workflowJob.findMany({
      where: {
        workspaceId: instance.managedWorkspaceId,
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
        workspaceId: instance.managedWorkspaceId,
        archivedAt: null,
        lastSyncError: { not: null },
      },
    }),
    prisma.externalDataSource.count({
      where: {
        workspaceId: instance.managedWorkspaceId,
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
    instanceId,
    accessMode: "managed_workspace" as const,
    hasManagedWorkspace: true,
    managedWorkspace: instance.managedWorkspace,
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
  instanceId: string;
  operation: string;
  sourceId?: string | null;
  reason?: string | null;
}) {
  requireControlPlaneScope(actor, "control-plane:context:write");
  const reason = requireMutationReason(params.reason);
  const operation = normalizeContextOperation(params.operation);
  const instance = await getControlPlaneInstanceWithWorkspace(actor, params.instanceId);
  const managedWorkspaceId = instance.managedWorkspaceId;
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
      await tx.hostedInstanceEvent.create({
        data: {
          instanceId: params.instanceId,
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
        instanceId: params.instanceId,
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
      await tx.hostedInstanceEvent.create({
        data: {
          instanceId: params.instanceId,
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
        instanceId: params.instanceId,
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
    await tx.hostedInstanceEvent.create({
      data: {
        instanceId: params.instanceId,
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
      instanceId: params.instanceId,
      managedWorkspaceId,
      operation,
      sourceIds: [updated.id],
      disabled: true,
    };
  });
}

export async function getControlPlaneIntegrationStatus(actor: AppActor, instanceId: string) {
  const instance = await getControlPlaneInstanceWithWorkspace(actor, instanceId);
  const adapter = createControlPlaneAdapter(instance);
  if (!adapter.canReadCentralWorkspace || !instance.managedWorkspaceId) {
    return {
      instanceId,
      accessMode: adapter.kind,
      hasManagedWorkspace: false,
      supportConnectorStatus: instance.supportConnectorStatus,
      supportLastSyncAt: instance.supportLastSyncAt,
      requiresConnectorSetup: adapter.requiresConnectorSetup,
      integrations: [],
    };
  }

  const [featureFlag, recorderConfig, recorderUsage, recorderFailures, communicationInstallations, dataSources] = await Promise.all([
    prisma.workspaceFeatureFlag.findUnique({
      where: {
        workspaceId_flag: {
          workspaceId: instance.managedWorkspaceId,
          flag: MEETING_RECORDERS_FEATURE_FLAG,
        },
      },
    }),
    prisma.workspaceMeetingRecorderConfig.findUnique({ where: { workspaceId: instance.managedWorkspaceId } }),
    getMeetingRecorderMonthlyUsage(instance.managedWorkspaceId),
    prisma.meetingRecording.count({
      where: {
        workspaceId: instance.managedWorkspaceId,
        status: "FAILED",
      },
    }),
    prisma.communicationInstallation.findMany({
      where: { workspaceId: instance.managedWorkspaceId },
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
      where: { workspaceId: instance.managedWorkspaceId, archivedAt: null },
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
  ]);

  return {
    instanceId,
    accessMode: "managed_workspace" as const,
    hasManagedWorkspace: true,
    managedWorkspace: instance.managedWorkspace,
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
        vendorReadiness: Boolean(featureFlag?.enabled && recorderConfig?.defaultProvider && recorderConfig.monthlyMinuteCap >= 0),
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
  instanceId: string;
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
  const instance = await getControlPlaneInstanceWithWorkspace(actor, params.instanceId);
  const managedWorkspaceId = instance.managedWorkspaceId;
  invariant(managedWorkspaceId, 400, "MANAGED_WORKSPACE_REQUIRED", "Meeting recorder configuration requires a managed workspace link.");

  const defaultProvider = normalizeMeetingRecorderProvider(params.defaultProvider, "meeting recorder provider");
  const fallbackProvider = params.fallbackProvider?.trim()
    ? normalizeMeetingRecorderProvider(params.fallbackProvider, "fallback meeting recorder provider")
    : null;
  const monthlyMinuteCap = Math.max(0, Math.round(Number.isFinite(params.monthlyMinuteCap) ? params.monthlyMinuteCap : DEFAULT_RECORDER_MONTHLY_MINUTE_CAP));
  const enabled = params.entitlementEnabled ? params.enabled : false;
  const botName = params.botName?.trim() || DEFAULT_RECORDER_BOT_NAME;
  const entryMessage = params.entryMessage?.trim() || DEFAULT_RECORDER_ENTRY_MESSAGE;

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
    const entitlement = instance.customerAccountId
      ? await tx.customerEntitlement.upsert({
        where: {
          customerAccountId_scopeKey_entitlementKey: {
            customerAccountId: instance.customerAccountId,
            scopeKey: `deployment:${params.instanceId}`,
            entitlementKey: MEETING_RECORDERS_FEATURE_FLAG,
          },
        },
        update: {
          deploymentId: params.instanceId,
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
          customerAccountId: instance.customerAccountId,
          deploymentId: params.instanceId,
          scopeKey: `deployment:${params.instanceId}`,
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

    await tx.hostedInstanceEvent.create({
      data: {
        instanceId: params.instanceId,
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
        }) as Prisma.InputJsonObject,
      },
    });

    return { featureFlag, config, entitlement };
  });

  return {
    instanceId: params.instanceId,
    managedWorkspaceId,
    entitlementEnabled: featureFlag.enabled,
    entitlement,
    config,
  };
}

export async function getControlPlaneAiGovernanceStatus(actor: AppActor, instanceId: string) {
  const instance = await getControlPlaneInstanceWithWorkspace(actor, instanceId);
  const adapter = createControlPlaneAdapter(instance);
  if (!adapter.canReadCentralWorkspace || !instance.managedWorkspaceId) {
    return {
      instanceId,
      accessMode: adapter.kind,
      hasManagedWorkspace: false,
      supportConnectorStatus: instance.supportConnectorStatus,
      supportLastSyncAt: instance.supportLastSyncAt,
      requiresConnectorSetup: adapter.requiresConnectorSetup,
      summary: null,
    };
  }

  const [agentRuns, pendingApprovals, failedJobs, modelUsage, recentRuns, recentFailedJobs, recentToolCalls] = await Promise.all([
    prisma.agentRun.groupBy({
      by: ["status"],
      where: { workspaceId: instance.managedWorkspaceId },
      _count: { _all: true },
    }),
    prisma.agentRun.count({
      where: { workspaceId: instance.managedWorkspaceId, approvalRequired: true, status: "WAITING_APPROVAL" },
    }),
    prisma.workflowJob.count({
      where: { workspaceId: instance.managedWorkspaceId, status: "FAILED" },
    }),
    prisma.modelUsage.aggregate({
      where: { workspaceId: instance.managedWorkspaceId },
      _sum: {
        inputTokens: true,
        outputTokens: true,
        estimatedCostUsd: true,
      },
    }),
    prisma.agentRun.findMany({
      where: { workspaceId: instance.managedWorkspaceId },
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
    prisma.workflowJob.findMany({
      where: { workspaceId: instance.managedWorkspaceId, status: "FAILED" },
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
      where: { agentRun: { workspaceId: instance.managedWorkspaceId } },
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
  ]);
  const riskyToolCalls = recentToolCalls
    .filter((call) => call.status === "FAILED" || /archive|create|delete|deactivate|deploy|discard|invite|remove|retry|rollback|send|sync|update|upsert|write/i.test(call.name))
    .slice(0, 8);

  return {
    instanceId,
    accessMode: "managed_workspace" as const,
    hasManagedWorkspace: true,
    managedWorkspace: instance.managedWorkspace,
    summary: {
      agentRuns: Object.fromEntries(agentRuns.map((run) => [run.status, run._count._all])),
      pendingApprovals,
      failedJobs,
      modelUsage: {
        inputTokens: modelUsage._sum.inputTokens ?? 0,
        outputTokens: modelUsage._sum.outputTokens ?? 0,
        estimatedCostUsd: decimalToString(modelUsage._sum.estimatedCostUsd),
      },
      recentRuns,
      recentFailedJobs,
      riskyToolCalls,
    },
  };
}

export async function getControlPlaneReleaseStatus(actor: AppActor, instanceId: string) {
  const instance = await getControlPlaneInstanceWithWorkspace(actor, instanceId);
  const adapter = createControlPlaneAdapter(instance);
  const releaseDrift = instance.lastHealthError?.includes("Release drift:") ? instance.lastHealthError : null;
  const recentPreparations = await prisma.hostedInstanceEvent.findMany({
    where: {
      instanceId,
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
    instanceId,
    accessMode: adapter.kind,
    requiresConnectorSetup: adapter.requiresConnectorSetup,
    managedWorkspace: instance.managedWorkspace,
    current: {
      releaseVersion: instance.releaseVersion,
      releaseImageTag: instance.releaseImageTag,
      lastReleaseCheck: instance.lastReleaseCheck,
      releaseDrift,
    },
    provisioning: {
      status: instance.provisioningStatus,
      bootstrapStatus: instance.bootstrapStatus,
      lastProvisioningError: instance.lastProvisioningError,
      railwayProjectId: instance.railwayProjectId,
      railwayEnvironmentId: instance.railwayEnvironmentId,
      railwayWebServiceId: instance.railwayWebServiceId,
      railwayWorkerServiceId: instance.railwayWorkerServiceId,
    },
    health: {
      lastHealthStatus: instance.lastHealthStatus,
      lastHealthCheck: instance.lastHealthCheck,
      lastHealthError: instance.lastHealthError,
      lastWorkerHealthStatus: instance.lastWorkerHealthStatus,
      lastWorkerHealthCheck: instance.lastWorkerHealthCheck,
    },
    rollbackReady: Boolean(instance.releaseImageTag && instance.lastHealthStatus === "ok"),
    recentPreparations,
  };
}

export async function runControlPlaneReleaseOperation(actor: AppActor, params: {
  instanceId: string;
  operation: string;
  targetReleaseImageTag?: string | null;
  targetReleaseVersion?: string | null;
  reason?: string | null;
}) {
  requireControlPlaneScope(actor, "control-plane:releases:write");
  const operation = normalizeReleaseOperation(params.operation);
  const reason = requireMutationReason(params.reason);
  const instance = await getControlPlaneInstanceWithWorkspace(actor, params.instanceId);

  if (operation === "prepare_upgrade") {
    const targetReleaseImageTag = params.targetReleaseImageTag?.trim();
    invariant(targetReleaseImageTag, 400, "INVALID_INPUT", "Target release image tag is required.");
    const targetReleaseVersion = params.targetReleaseVersion?.trim() || null;
    const releaseDrift = instance.lastHealthError?.includes("Release drift:") ? instance.lastHealthError : null;
    const checks = {
      hasCustomerSlug: Boolean(instance.customerSlug),
      hasRailwayProject: Boolean(instance.railwayProjectId),
      hasRailwayEnvironment: Boolean(instance.railwayEnvironmentId),
      hasRailwayServices: Boolean(instance.railwayWebServiceId && instance.railwayWorkerServiceId),
      healthOk: instance.lastHealthStatus === "ok",
      rollbackReady: Boolean(instance.releaseImageTag && instance.lastHealthStatus === "ok"),
      targetDiffers: targetReleaseImageTag !== instance.releaseImageTag || targetReleaseVersion !== (instance.releaseVersion ?? null),
    };

    const evidence = {
      reason,
      operation,
      currentReleaseImageTag: instance.releaseImageTag,
      currentReleaseVersion: instance.releaseVersion,
      targetReleaseImageTag,
      targetReleaseVersion,
      releaseDrift,
      checks,
    };

    await prisma.$transaction(async (tx) => {
      if (instance.customerAccountId) {
        await tx.customerReleaseTarget.upsert({
          where: {
            deploymentId_targetReleaseImageTag: {
              deploymentId: params.instanceId,
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
            customerAccountId: instance.customerAccountId,
            deploymentId: params.instanceId,
            targetReleaseImageTag,
            targetReleaseVersion,
            status: "PREPARED",
            evidence: redactObject(evidence) as Prisma.InputJsonObject,
            preparedByUserId: actorUserId(actor),
          },
        });
      }
      await tx.hostedInstanceEvent.create({
        data: {
          instanceId: params.instanceId,
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
      release: await getControlPlaneReleaseStatus(actor, params.instanceId),
    };
  }

  throw new AppError(400, "INVALID_INPUT", "Unsupported release operation.");
}

type InstanceHealthPayload = {
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

async function probeControlPlaneCustomerHealthCore(actor: AppActor, params: {
  instanceId: string;
  reason: string;
}) {
  const instance = await getControlPlaneInstanceWithWorkspace(actor, params.instanceId);
  let status = "unknown";
  let error: string | null = null;
  let health: InstanceHealthPayload | null = null;

  try {
    const response = await fetch(`${instance.url.replace(/\/$/, "")}/api/health`, { method: "GET" });
    health = await response.json().catch(() => null) as InstanceHealthPayload | null;
    if (response.ok) {
      status = "ok";
      const runtimeErrors = [];
      if (health?.database && health.database !== "up") runtimeErrors.push(`Database ${health.database}`);
      if (health?.schema && health.schema !== "ready") runtimeErrors.push(`Schema ${health.schema}`);
      if (health?.runtime?.redis && health.runtime.redis !== "configured") runtimeErrors.push(`Redis ${health.runtime.redis}`);
      if (health?.runtime?.storage && health.runtime.storage !== "configured") runtimeErrors.push(`Storage ${health.runtime.storage}`);
      const actualRelease = health?.release?.imageTag || health?.release?.gitSha || null;
      if (instance.releaseImageTag && actualRelease && actualRelease !== instance.releaseImageTag) {
        runtimeErrors.push(`Release drift: expected ${instance.releaseImageTag}, got ${actualRelease}`);
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

  await prisma.instanceRegistry.update({
    where: { id: params.instanceId },
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
      customerAccountId: instance.customerAccountId,
      deploymentId: params.instanceId,
      snapshotKind: "HEALTH",
      status,
      summary: {
        reason: params.reason,
        health,
      },
      error,
    }),
    recordFleetHealthSnapshot({
      customerAccountId: instance.customerAccountId,
      deploymentId: params.instanceId,
      snapshotKind: "RELEASE",
      status: error?.includes("Release drift:") ? "degraded" : status === "ok" ? "ok" : "unknown",
      summary: {
        expectedReleaseImageTag: instance.releaseImageTag,
        expectedReleaseVersion: instance.releaseVersion,
        observedRelease: health?.release ?? null,
      },
      error: error?.includes("Release drift:") ? error : null,
    }),
  ]);
  await recordHostedEvent(actor, params.instanceId, "control_plane.release.health_probed", {
    reason: params.reason,
    status,
    error,
    release: health?.release ?? null,
  });
  return {
    status,
    error,
    release: await getControlPlaneReleaseStatus(actor, params.instanceId),
  };
}

export async function probeControlPlaneCustomerHealth(actor: AppActor, params: {
  instanceId: string;
  reason?: string | null;
}) {
  requireControlPlaneScope(actor, "control-plane:releases:write");
  const reason = requireMutationReason(params.reason);
  return probeControlPlaneCustomerHealthCore(actor, {
    instanceId: params.instanceId,
    reason,
  });
}

export async function configureSupportConnector(actor: AppActor, params: {
  instanceId: string;
  supportBaseUrl?: string | null;
  supportMcpUrl?: string | null;
  supportCredential?: string | null;
  supportCredentialLabel?: string | null;
  supportNotes?: string | null;
}) {
  requireControlPlaneScope(actor, "control-plane:support:write");
  await requireControlPlaneAccess(actor, { instanceId: params.instanceId });
  const existing = await prisma.instanceRegistry.findUnique({
    where: { id: params.instanceId },
    select: { supportCredentialEnc: true },
  });
  invariant(existing, 404, "NOT_FOUND", "Customer instance not found.");
  const credential = params.supportCredential?.trim();
  invariant(Boolean(credential) || Boolean(existing.supportCredentialEnc), 400, "INVALID_INPUT", "Support credential is required.");

  const instance = await prisma.instanceRegistry.update({
    where: { id: params.instanceId },
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

  await recordHostedEvent(actor, params.instanceId, "support_connector.configured", {
    supportBaseUrl: instance.supportBaseUrl,
    supportMcpUrl: instance.supportMcpUrl,
    supportCredentialLabel: instance.supportCredentialLabel,
  });

  return {
    ...instance,
    hasSupportCredential: true,
    supportCredentialEnc: undefined,
  };
}

async function fetchCustomerSupportSnapshotCore(instanceId: string) {
  const connector = await loadSupportConnector(instanceId);

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
  await prisma.instanceRegistry.update({
    where: { id: instanceId },
    data: {
      supportConnectorStatus: hasError ? "degraded" : "connected",
      supportLastSyncAt: new Date(),
      supportLastSyncError: hasError ? "One or more support snapshot calls failed." : null,
    },
  });

  const snapshot = { workspace, members, integrations, dataSources, agentRuns, failedJobs };
  await Promise.all([
    recordFleetHealthSnapshot({
      customerAccountId: connector.instance.customerAccountId,
      deploymentId: instanceId,
      snapshotKind: "CONNECTOR",
      status: hasError ? "degraded" : "ok",
      summary: {
        supportConnectorStatus: hasError ? "degraded" : "connected",
        supportMcpUrl: connector.mcpUrl,
      },
      error: hasError ? "One or more support snapshot calls failed." : null,
    }),
    recordFleetHealthSnapshot({
      customerAccountId: connector.instance.customerAccountId,
      deploymentId: instanceId,
      snapshotKind: "SUPPORT_READY",
      status: hasError ? "degraded" : "ok",
      summary: snapshot,
      error: hasError ? "One or more support snapshot calls failed." : null,
    }),
  ]);

  return snapshot;
}

export async function fetchCustomerSupportSnapshot(actor: AppActor, instanceId: string) {
  requireControlPlaneScope(actor, "control-plane:support:write");
  await requireControlPlaneAccess(actor, { instanceId });
  return fetchCustomerSupportSnapshotCore(instanceId);
}

export async function refreshControlPlaneFleetSnapshots(actor: AppActor, params: {
  instanceId: string;
  snapshotKinds?: string[] | null;
  reason?: string | null;
}) {
  requireControlPlaneScope(actor, "control-plane:fleet:write");
  const reason = requireMutationReason(params.reason);
  const kinds = normalizeSnapshotKinds(params.snapshotKinds);
  const instance = await getControlPlaneInstanceWithWorkspace(actor, params.instanceId);
  const adapter = createControlPlaneAdapter(instance);
  const results: Array<{ snapshotKind: FleetSnapshotKind; status: string; error: string | null }> = [];

  for (const snapshotKind of kinds) {
    try {
      if (snapshotKind === "HEALTH") {
        const result = await probeControlPlaneCustomerHealthCore(actor, {
          instanceId: params.instanceId,
          reason,
        });
        results.push({ snapshotKind, status: result.status, error: result.error });
        continue;
      }

      if (snapshotKind === "RELEASE") {
        const release = await getControlPlaneReleaseStatus(actor, params.instanceId);
        const status = releaseSnapshotStatus(release);
        await recordFleetHealthSnapshot({
          customerAccountId: instance.customerAccountId,
          deploymentId: params.instanceId,
          snapshotKind,
          status,
          summary: release,
          error: release.health.lastHealthError,
        });
        results.push({ snapshotKind, status, error: release.health.lastHealthError });
        continue;
      }

      if (snapshotKind === "CONNECTOR") {
        const status = connectorSnapshotStatus(instance.supportConnectorStatus);
        await recordFleetHealthSnapshot({
          customerAccountId: instance.customerAccountId,
          deploymentId: params.instanceId,
          snapshotKind,
          status,
          summary: {
            adapterKind: adapter.kind,
            supportConnectorStatus: instance.supportConnectorStatus,
            supportLastConnectedAt: instance.supportLastConnectedAt,
            supportLastSyncAt: instance.supportLastSyncAt,
            requiresConnectorSetup: adapter.requiresConnectorSetup,
          },
          error: instance.supportLastSyncError,
        });
        results.push({ snapshotKind, status, error: instance.supportLastSyncError });
        continue;
      }

      if (snapshotKind === "SUPPORT_READY") {
        if (adapter.requiresConnectorSetup) {
          await recordFleetHealthSnapshot({
            customerAccountId: instance.customerAccountId,
            deploymentId: params.instanceId,
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
        const snapshot = await fetchCustomerSupportSnapshotCore(params.instanceId);
        const status = supportSnapshotStatus(snapshot);
        results.push({
          snapshotKind,
          status,
          error: status === "degraded" ? "One or more support snapshot calls failed." : null,
        });
        continue;
      }

      if (snapshotKind === "CONTEXT") {
        const context = await getControlPlaneContextHealth(actor, params.instanceId);
        const status = contextSnapshotStatus(context);
        const error = ("supportLastSyncError" in context ? context.supportLastSyncError : null) ?? null;
        await recordFleetHealthSnapshot({
          customerAccountId: instance.customerAccountId,
          deploymentId: params.instanceId,
          snapshotKind,
          status,
          summary: context,
          error,
        });
        results.push({ snapshotKind, status, error });
        continue;
      }

      if (snapshotKind === "INTEGRATION") {
        const integrations = await getControlPlaneIntegrationStatus(actor, params.instanceId);
        const status = integrationSnapshotStatus(integrations);
        await recordFleetHealthSnapshot({
          customerAccountId: instance.customerAccountId,
          deploymentId: params.instanceId,
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
        customerAccountId: instance.customerAccountId,
        deploymentId: params.instanceId,
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

  await recordHostedEvent(actor, params.instanceId, "control_plane.fleet_snapshots_refreshed", {
    reason,
    snapshotKinds: kinds,
    results,
  });

  return {
    instanceId: params.instanceId,
    adapterKind: adapter.kind,
    results,
  };
}

export async function enqueueControlPlaneFleetSnapshots(actor: AppActor, params: {
  instanceId?: string | null;
  snapshotKinds?: string[] | null;
  reason?: string | null;
  limit?: number | null;
}) {
  requireControlPlaneScope(actor, "control-plane:fleet:write");
  const reason = requireMutationReason(params.reason);
  const snapshotKinds = normalizeSnapshotKinds(params.snapshotKinds);
  const limit = Math.min(Math.max(Math.floor(params.limit ?? 100), 1), 500);
  const deployments = params.instanceId?.trim()
    ? [await getControlPlaneInstanceWithWorkspace(actor, params.instanceId.trim())]
    : await prisma.instanceRegistry.findMany({
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
            instanceId: deployment.id,
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
  instanceId?: string | null;
  snapshotKinds?: string[] | null;
  reason?: string | null;
  limit?: number | null;
  concurrency?: number | null;
}) {
  const reason = params.reason?.trim() || "Scheduled Control Plane fleet snapshot.";
  const snapshotKinds = normalizeSnapshotKinds(params.snapshotKinds);
  if (params.instanceId?.trim()) {
    return refreshControlPlaneFleetSnapshots(controlPlaneWorkerActor, {
      instanceId: params.instanceId.trim(),
      snapshotKinds,
      reason,
    });
  }

  const limit = Math.min(Math.max(Math.floor(params.limit ?? readPositiveInteger(process.env.CONTROL_PLANE_FLEET_SWEEP_BATCH_SIZE, 50, 500)), 1), 500);
  const concurrency = Math.min(Math.max(Math.floor(params.concurrency ?? readPositiveInteger(process.env.CONTROL_PLANE_FLEET_SWEEP_CONCURRENCY, 5, 20)), 1), 20);
  const deployments = await prisma.instanceRegistry.findMany({
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
      instanceId: deployment.id,
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
  instanceId: string;
  action: SupportAction;
  reason?: string | null;
  arguments?: JsonRecord;
  remoteWorkspaceId?: string | null;
  idempotencyKey?: string | null;
}) {
  requireControlPlaneScope(actor, "control-plane:support:write");
  await requireControlPlaneAccess(actor, { instanceId: params.instanceId });
  const toolName = SUPPORT_ACTION_TO_MCP_TOOL[params.action];
  invariant(toolName, 400, "INVALID_INPUT", "Unsupported support action.");
  const reason = normalizeReason(params.reason, params.action);
  const args = params.arguments ?? {};
  const inputSummary = redactObject(args);

  const operation = await prisma.supportOperation.create({
    data: {
      instanceId: params.instanceId,
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

  const connector = await loadSupportConnector(params.instanceId);

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
  instanceId: string;
  reason: string;
  notes: string;
}) {
  requireControlPlaneScope(actor, "control-plane:support:write");
  await requireControlPlaneAccess(actor, { instanceId: params.instanceId });
  const reason = normalizeReason(params.reason, "support.break_glass_note");
  const notes = params.notes.trim();
  invariant(notes.length > 0, 400, "INVALID_INPUT", "Break-glass notes are required.");

  return prisma.supportOperation.create({
    data: {
      instanceId: params.instanceId,
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
