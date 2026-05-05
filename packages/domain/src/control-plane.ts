import type { MeetingRecorderProvider, Prisma } from "@prisma/client";
import { decryptSecret, encryptSecret, env, prisma } from "@corgtex/shared";
import type { AgentActor, AppActor } from "@corgtex/shared";
import { AppError, invariant } from "./errors";
import { isGlobalOperator } from "./auth";
import { getMeetingRecorderMonthlyUsage, MEETING_RECORDERS_FEATURE_FLAG } from "./meeting-recorders";

const SUPPORT_ACTOR_LABEL = "Corgtex Support";
const DEFAULT_RECORDER_BOT_NAME = "Corgtex Recorder";
const DEFAULT_RECORDER_ENTRY_MESSAGE = "Corgtex is joining to record, transcribe, and summarize this meeting for the workspace.";
const DEFAULT_RECORDER_MONTHLY_MINUTE_CAP = 6_000;
const MEETING_RECORDER_PROVIDERS = new Set(["RECALL_AI", "MEETING_BAAS"]);
const CONTROL_PLANE_CONTEXT_OPERATIONS = new Set(["sync_all", "sync_source", "disable_source"]);
const CONTROL_PLANE_RELEASE_OPERATIONS = new Set(["prepare_upgrade"]);
const CONTROL_PLANE_READ_SCOPE = "control-plane:read";

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

function decimalToString(value: unknown) {
  if (!value) return null;
  return typeof value === "object" && "toString" in value ? String(value.toString()) : String(value);
}

function actorUserId(actor: AppActor) {
  return actor.kind === "user" ? actor.user.id : null;
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

  const instances = await prisma.instanceRegistry.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      supportOperations: {
        orderBy: { createdAt: "desc" },
        take: 3,
      },
      managedWorkspace: {
        select: managedWorkspaceSelect,
      },
      _count: {
        select: { supportOperations: true, events: true },
      },
    },
  });

  return instances.map((instance) => ({
    ...instance,
    hasSupportCredential: Boolean(instance.supportCredentialEnc),
    supportCredentialEnc: undefined,
  }));
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
  if (!instance.managedWorkspaceId) {
    return {
      instanceId,
      accessMode: "support_connector" as const,
      hasManagedWorkspace: false,
      supportConnectorStatus: instance.supportConnectorStatus,
      supportLastSyncAt: instance.supportLastSyncAt,
      supportLastSyncError: instance.supportLastSyncError,
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
  if (!instance.managedWorkspaceId) {
    return {
      instanceId,
      accessMode: "support_connector" as const,
      hasManagedWorkspace: false,
      supportConnectorStatus: instance.supportConnectorStatus,
      supportLastSyncAt: instance.supportLastSyncAt,
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

  const { featureFlag, config } = await prisma.$transaction(async (tx) => {
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

    return { featureFlag, config };
  });

  return {
    instanceId: params.instanceId,
    managedWorkspaceId,
    entitlementEnabled: featureFlag.enabled,
    config,
  };
}

export async function getControlPlaneAiGovernanceStatus(actor: AppActor, instanceId: string) {
  const instance = await getControlPlaneInstanceWithWorkspace(actor, instanceId);
  if (!instance.managedWorkspaceId) {
    return {
      instanceId,
      accessMode: "support_connector" as const,
      hasManagedWorkspace: false,
      supportConnectorStatus: instance.supportConnectorStatus,
      supportLastSyncAt: instance.supportLastSyncAt,
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
    accessMode: instance.managedWorkspaceId ? "managed_workspace" as const : "support_connector" as const,
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

    await recordHostedEvent(actor, params.instanceId, "control_plane.release.upgrade_prepared", {
      reason,
      operation,
      currentReleaseImageTag: instance.releaseImageTag,
      currentReleaseVersion: instance.releaseVersion,
      targetReleaseImageTag,
      targetReleaseVersion,
      releaseDrift,
      checks,
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

export async function probeControlPlaneCustomerHealth(actor: AppActor, params: {
  instanceId: string;
  reason?: string | null;
}) {
  requireControlPlaneScope(actor, "control-plane:releases:write");
  const reason = requireMutationReason(params.reason);
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
    },
  });
  await recordHostedEvent(actor, params.instanceId, "control_plane.release.health_probed", {
    reason,
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

export async function fetchCustomerSupportSnapshot(actor: AppActor, instanceId: string) {
  requireControlPlaneScope(actor, "control-plane:support:write");
  await requireControlPlaneAccess(actor, { instanceId });
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

  return { workspace, members, integrations, dataSources, agentRuns, failedJobs };
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
