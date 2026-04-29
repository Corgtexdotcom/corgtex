import type { Prisma } from "@prisma/client";
import { decryptSecret, encryptSecret, env, prisma } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import { AppError, invariant } from "./errors";
import { isGlobalOperator } from "./auth";

const SUPPORT_ACTOR_LABEL = "Corgtex Support";

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

function actorUserId(actor: AppActor) {
  return actor.kind === "user" ? actor.user.id : null;
}

function isControlPlaneAgent(actor: AppActor) {
  return actor.kind === "agent" && actor.authProvider === "control-plane";
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
  if (isGlobalOperator(actor) || isControlPlaneAgent(actor)) {
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
    },
  });
  invariant(instance, 404, "NOT_FOUND", "Customer instance not found.");

  return {
    ...instance,
    hasSupportCredential: Boolean(instance.supportCredentialEnc),
    supportCredentialEnc: undefined,
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
  };
}
