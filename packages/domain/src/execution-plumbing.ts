import { prisma } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import {
  AiWorkspaceProvider,
  BrainArticleAuthority,
  BrainArticleType,
  BuildArtifactClassification,
  BuildArtifactStatus,
  BuildArtifactVisibility,
  ExecutionRequestStatus,
  ExecutionResultStatus,
  ExecutionWritebackTargetType,
  Prisma,
} from "@prisma/client";
import { createAction } from "./actions";
import { createArticle } from "./brain";
import { upsertBuildArtifact } from "./build-artifacts";
import { createMeeting } from "./meetings";
import { createProposal } from "./proposals";
import { createTension } from "./tensions";
import { recordAudit } from "./audit-trail";
import { actorUserIdForWorkspace, requireWorkspaceMembership } from "./auth";
import { AppError, invariant } from "./errors";
import { isKnownScope, type AgentScope } from "./agent-auth";

const SECRET_KEY_PATTERN = /(token|secret|password|credential|api[_-]?key|access[_-]?key|refresh|authorization|bearer)/i;
const MAX_CONTEXT_ITEMS = 20;

type JsonRecord = Record<string, unknown>;

type WritebackTargetSummary = {
  type: ExecutionWritebackTargetType;
  id: string | null;
  title: string;
  status: string | null;
  webPath: string;
};

type ExecutionRequestRecord = Awaited<ReturnType<typeof loadExecutionRequest>>;

export type CreateExecutionRequestParams = {
  workspaceId: string;
  goal: string;
  provider?: string | AiWorkspaceProvider | null;
  actor?: unknown;
  context?: unknown;
  allowedScopes?: string[] | null;
  policyConstraints?: unknown;
  expectedOutput?: unknown;
  approvalRule?: string | null;
  writebackTargetType?: string | ExecutionWritebackTargetType | null;
  writebackTargetId?: string | null;
  writebackTargetLabel?: string | null;
  idempotencyKey?: string | null;
};

export type SubmitExecutionResultParams = {
  workspaceId: string;
  requestId: string;
  idempotencyKey: string;
  targetType?: string | ExecutionWritebackTargetType | null;
  targetId?: string | null;
  output?: unknown;
  artifacts?: unknown;
  errorMessage?: string | null;
};

export type ListWritebackTargetsParams = {
  workspaceId: string;
  query?: string | null;
  targetTypes?: Array<string | ExecutionWritebackTargetType> | null;
  take?: number | null;
};

function actorCredentialId(actor: AppActor) {
  return actor.kind === "agent" ? actor.credentialId ?? null : null;
}

function requireExecutionScope(actor: AppActor, scope: AgentScope) {
  if (actor.kind !== "agent" || actor.authProvider === "bootstrap") return;
  if (!actor.scopes?.includes(scope)) {
    throw new AppError(403, "FORBIDDEN", `Agent credential is missing the required scope: ${scope}.`);
  }
}

function normalizeKnownScopes(values?: string[] | null) {
  const scopes = [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
  const unknown = scopes.filter((scope) => !isKnownScope(scope));
  invariant(unknown.length === 0, 400, "INVALID_INPUT", `Unknown execution scope(s): ${unknown.join(", ")}.`);
  return scopes;
}

function normalizeProvider(value?: string | AiWorkspaceProvider | null) {
  if (!value) return null;
  const normalized = String(value).trim().toUpperCase();
  invariant(normalized in AiWorkspaceProvider, 400, "INVALID_INPUT", "Unsupported AI workspace provider.");
  return normalized as AiWorkspaceProvider;
}

export function normalizeExecutionTargetType(value?: string | ExecutionWritebackTargetType | null) {
  if (!value) return null;
  const normalized = String(value).trim().toUpperCase().replace(/[-\s]/g, "_");
  const aliases: Record<string, ExecutionWritebackTargetType> = {
    ACTION: "ACTION",
    ACTIONS: "ACTION",
    TENSION: "TENSION",
    TENSIONS: "TENSION",
    PROPOSAL: "PROPOSAL",
    PROPOSALS: "PROPOSAL",
    MEETING: "MEETING",
    MEETINGS: "MEETING",
    BRAIN: "BRAIN_ARTICLE",
    ARTICLE: "BRAIN_ARTICLE",
    BRAIN_ARTICLE: "BRAIN_ARTICLE",
    BRAIN_ARTICLES: "BRAIN_ARTICLE",
    BUILD: "BUILD_ARTIFACT",
    ARTIFACT: "BUILD_ARTIFACT",
    BUILD_ARTIFACT: "BUILD_ARTIFACT",
    BUILD_ARTIFACTS: "BUILD_ARTIFACT",
    FILE: "BUILD_ARTIFACT",
    FILES: "BUILD_ARTIFACT",
    COMMENT: "COMMENT",
    COMMENTS: "COMMENT",
  };
  const type = aliases[normalized];
  invariant(type, 400, "INVALID_INPUT", "Unsupported write-back target type.");
  return type;
}

function targetReadScope(type: ExecutionWritebackTargetType): AgentScope {
  switch (type) {
    case "ACTION": return "actions:read";
    case "TENSION": return "tensions:read";
    case "PROPOSAL": return "proposals:read";
    case "MEETING": return "meetings:read";
    case "BRAIN_ARTICLE": return "brain:read";
    case "BUILD_ARTIFACT": return "workspace:read";
    case "COMMENT": return "execution:read";
  }
}

function targetWriteScope(type: ExecutionWritebackTargetType): AgentScope {
  switch (type) {
    case "ACTION": return "actions:write";
    case "TENSION": return "tensions:write";
    case "PROPOSAL": return "proposals:write";
    case "MEETING": return "meetings:write";
    case "BRAIN_ARTICLE": return "brain:write";
    case "BUILD_ARTIFACT": return "workspace:write";
    case "COMMENT": return "execution:write";
  }
}

function defaultScopesForTarget(type: ExecutionWritebackTargetType | null) {
  const scopes = new Set<AgentScope>(["execution:read", "execution:write", "workspace:read"]);
  if (type) {
    scopes.add(targetReadScope(type));
    scopes.add(targetWriteScope(type));
  }
  return [...scopes];
}

function redactJson(value: unknown): unknown {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(redactJson);
  if (typeof value === "object") {
    const output: JsonRecord = {};
    for (const [key, child] of Object.entries(value as JsonRecord)) {
      output[key] = SECRET_KEY_PATTERN.test(key) ? "[redacted]" : redactJson(child);
    }
    return output;
  }
  return value;
}

function jsonInput(value: unknown) {
  const redacted = redactJson(value);
  return redacted == null ? Prisma.JsonNull : redacted as Prisma.InputJsonValue;
}

function objectInput(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function isPrismaUniqueError(error: unknown) {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002";
}

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function requiredString(value: unknown, label: string) {
  const result = optionalString(value);
  invariant(result, 400, "INVALID_INPUT", `${label} is required.`);
  return result;
}

function optionalDate(value: unknown) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  invariant(!Number.isNaN(date.valueOf()), 400, "INVALID_INPUT", "Date fields must be valid ISO dates.");
  return date;
}

function titleMatches(query: string | null | undefined) {
  const trimmed = query?.trim();
  return trimmed ? { contains: trimmed, mode: "insensitive" as const } : undefined;
}

async function loadExecutionRequest(workspaceId: string, requestId: string) {
  const request = await prisma.executionRequest.findFirst({
    where: { id: requestId, workspaceId },
    include: {
      results: {
        orderBy: { submittedAt: "desc" },
        take: 10,
      },
    },
  });
  invariant(request, 404, "NOT_FOUND", "Execution request not found.");
  return request;
}

function serializeExecutionResult(result: {
  id: string;
  executionRequestId: string;
  status: ExecutionResultStatus;
  idempotencyKey: string;
  targetType: ExecutionWritebackTargetType | null;
  targetId: string | null;
  outputJson: Prisma.JsonValue | null;
  artifactJson: Prisma.JsonValue | null;
  errorMessage: string | null;
  writebackEntityType: string | null;
  writebackEntityId: string | null;
  submittedAt: Date;
  acceptedAt: Date | null;
  rejectedAt: Date | null;
}) {
  return {
    id: result.id,
    requestId: result.executionRequestId,
    status: result.status,
    idempotencyKey: result.idempotencyKey,
    target: result.targetType ? { type: result.targetType, id: result.targetId } : null,
    output: result.outputJson,
    artifacts: result.artifactJson,
    errorMessage: result.errorMessage,
    writeback: result.writebackEntityType
      ? { entityType: result.writebackEntityType, entityId: result.writebackEntityId }
      : null,
    submittedAt: result.submittedAt,
    acceptedAt: result.acceptedAt,
    rejectedAt: result.rejectedAt,
  };
}

function serializeExecutionRequest(request: NonNullable<ExecutionRequestRecord>) {
  return {
    id: request.id,
    workspaceId: request.workspaceId,
    provider: request.provider,
    status: request.status,
    goal: request.goal,
    actor: request.actorJson,
    context: request.contextJson,
    allowedScopes: request.allowedScopes,
    policyConstraints: request.policyConstraintsJson,
    expectedOutput: request.expectedOutputJson,
    approvalRule: request.approvalRule,
    writebackTarget: request.writebackTargetType ? {
      type: request.writebackTargetType,
      id: request.writebackTargetId,
      label: request.writebackTargetLabel,
    } : null,
    packet: request.packetJson,
    results: request.results.map(serializeExecutionResult),
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
    completedAt: request.completedAt,
  };
}

async function validateWritebackTarget(workspaceId: string, type: ExecutionWritebackTargetType | null, targetId?: string | null) {
  if (!type) return null;
  if (!targetId) {
    return {
      type,
      id: null,
      title: type === "COMMENT" ? "Comment on execution request" : `New ${type.toLowerCase().replace("_", " ")}`,
      status: type === "COMMENT" ? null : "DRAFT",
      webPath: "",
    };
  }

  switch (type) {
    case "ACTION": {
      const item = await prisma.action.findFirst({ where: { id: targetId, workspaceId, archivedAt: null }, select: { id: true, title: true, status: true } });
      invariant(item, 404, "NOT_FOUND", "Action write-back target not found.");
      return { type, id: item.id, title: item.title, status: item.status, webPath: `/actions/${item.id}` };
    }
    case "TENSION": {
      const item = await prisma.tension.findFirst({ where: { id: targetId, workspaceId, archivedAt: null }, select: { id: true, title: true, status: true } });
      invariant(item, 404, "NOT_FOUND", "Tension write-back target not found.");
      return { type, id: item.id, title: item.title, status: item.status, webPath: `/tensions/${item.id}` };
    }
    case "PROPOSAL": {
      const item = await prisma.proposal.findFirst({ where: { id: targetId, workspaceId, archivedAt: null }, select: { id: true, title: true, status: true } });
      invariant(item, 404, "NOT_FOUND", "Proposal write-back target not found.");
      return { type, id: item.id, title: item.title, status: item.status, webPath: `/proposals/${item.id}` };
    }
    case "MEETING": {
      const item = await prisma.meeting.findFirst({ where: { id: targetId, workspaceId, archivedAt: null }, select: { id: true, title: true, status: true } });
      invariant(item, 404, "NOT_FOUND", "Meeting write-back target not found.");
      return { type, id: item.id, title: item.title ?? "Untitled meeting", status: item.status, webPath: `/meetings/${item.id}` };
    }
    case "BRAIN_ARTICLE": {
      const item = await prisma.brainArticle.findFirst({ where: { id: targetId, workspaceId, archivedAt: null }, select: { id: true, title: true, authority: true, slug: true } });
      invariant(item, 404, "NOT_FOUND", "Brain article write-back target not found.");
      return { type, id: item.id, title: item.title, status: item.authority, webPath: `/brain/${item.slug}` };
    }
    case "BUILD_ARTIFACT": {
      const item = await prisma.buildArtifact.findFirst({ where: { id: targetId, workspaceId }, select: { id: true, title: true, status: true } });
      invariant(item, 404, "NOT_FOUND", "Build artifact write-back target not found.");
      return { type, id: item.id, title: item.title, status: item.status, webPath: `/build-artifacts/${item.id}` };
    }
    case "COMMENT":
      return { type, id: targetId, title: "Execution comment", status: null, webPath: "" };
  }
}

function buildExecutionPacket(params: {
  request: {
    id: string;
    workspaceId: string;
    provider: AiWorkspaceProvider | null;
    status: ExecutionRequestStatus;
    goal: string;
    actorJson: Prisma.JsonValue | null;
    contextJson: Prisma.JsonValue | null;
    allowedScopes: string[];
    policyConstraintsJson: Prisma.JsonValue | null;
    expectedOutputJson: Prisma.JsonValue | null;
    approvalRule: string | null;
    writebackTargetType: ExecutionWritebackTargetType | null;
    writebackTargetId: string | null;
    writebackTargetLabel: string | null;
    createdAt: Date;
  };
  workspace: { id: string; slug: string; name: string; description: string | null };
}) {
  const { request, workspace } = params;
  return redactJson({
    id: request.id,
    workspace,
    provider: request.provider,
    status: request.status,
    goal: request.goal,
    actor: request.actorJson,
    relevantContext: request.contextJson,
    allowedScopes: request.allowedScopes,
    policyConstraints: request.policyConstraintsJson,
    expectedOutput: request.expectedOutputJson,
    approvalRule: request.approvalRule ?? "Submit a draft result for review unless the user explicitly requested direct write-back.",
    writebackTarget: request.writebackTargetType ? {
      type: request.writebackTargetType,
      id: request.writebackTargetId,
      label: request.writebackTargetLabel,
    } : null,
    createdAt: request.createdAt,
  });
}

export async function createExecutionRequest(actor: AppActor, params: CreateExecutionRequestParams) {
  requireExecutionScope(actor, "execution:write");
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });

  const goal = params.goal.trim();
  invariant(goal.length > 0, 400, "INVALID_INPUT", "Execution goal is required.");
  const provider = normalizeProvider(params.provider);
  const targetType = normalizeExecutionTargetType(params.writebackTargetType);
  const target = await validateWritebackTarget(params.workspaceId, targetType, params.writebackTargetId);
  const allowedScopes = normalizeKnownScopes(params.allowedScopes ?? defaultScopesForTarget(targetType));
  const idempotencyKey = optionalString(params.idempotencyKey);

  if (idempotencyKey) {
    const existing = await prisma.executionRequest.findUnique({
      where: { workspaceId_idempotencyKey: { workspaceId: params.workspaceId, idempotencyKey } },
      include: { results: { orderBy: { submittedAt: "desc" }, take: 10 } },
    });
    if (existing) return serializeExecutionRequest(existing);
  }

  const workspace = await prisma.workspace.findUnique({
    where: { id: params.workspaceId },
    select: { id: true, slug: true, name: true, description: true },
  });
  invariant(workspace, 404, "NOT_FOUND", "Workspace not found.");
  const createdByUserId = actor.kind === "user" ? actor.user.id : await actorUserIdForWorkspace(actor, params.workspaceId);
  const request = await prisma.$transaction(async (tx) => {
    const created = await tx.executionRequest.create({
      data: {
        workspaceId: params.workspaceId,
        createdByUserId,
        agentCredentialId: actorCredentialId(actor),
        provider,
        goal,
        actorJson: jsonInput(params.actor ?? { actorKind: actor.kind }),
        contextJson: jsonInput(params.context ?? null),
        allowedScopes,
        policyConstraintsJson: jsonInput(params.policyConstraints ?? null),
        expectedOutputJson: jsonInput(params.expectedOutput ?? null),
        approvalRule: optionalString(params.approvalRule),
        writebackTargetType: targetType,
        writebackTargetId: target?.id ?? null,
        writebackTargetLabel: optionalString(params.writebackTargetLabel) ?? target?.title ?? null,
        packetJson: Prisma.JsonNull,
        idempotencyKey,
      },
      include: { results: { orderBy: { submittedAt: "desc" }, take: 10 } },
    });
    const packet = buildExecutionPacket({ request: created, workspace });
    const updated = await tx.executionRequest.update({
      where: { id: created.id },
      data: { packetJson: packet as Prisma.InputJsonValue },
      include: { results: { orderBy: { submittedAt: "desc" }, take: 10 } },
    });

    await recordAudit(tx, actor, {
      workspaceId: params.workspaceId,
      action: "execution_request.created",
      entityType: "ExecutionRequest",
      entityId: created.id,
      meta: {
        provider,
        writebackTargetType: targetType,
        writebackTargetId: target?.id ?? null,
        allowedScopes,
      },
    });

    return updated;
  });

  return serializeExecutionRequest(request);
}

export async function getExecutionRequest(actor: AppActor, params: { workspaceId: string; requestId: string }) {
  requireExecutionScope(actor, "execution:read");
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  return serializeExecutionRequest(await loadExecutionRequest(params.workspaceId, params.requestId));
}

export async function listExecutionRequests(actor: AppActor, params: {
  workspaceId: string;
  status?: string | ExecutionRequestStatus | null;
  take?: number | null;
}) {
  requireExecutionScope(actor, "execution:read");
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  const status = params.status ? String(params.status).trim().toUpperCase() : null;
  invariant(!status || status in ExecutionRequestStatus, 400, "INVALID_INPUT", "Unsupported execution request status.");
  const requests = await prisma.executionRequest.findMany({
    where: {
      workspaceId: params.workspaceId,
      ...(status ? { status: status as ExecutionRequestStatus } : {}),
    },
    include: {
      results: {
        orderBy: { submittedAt: "desc" },
        take: 10,
      },
    },
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(params.take ?? 20, 1), 100),
  });
  return requests.map(serializeExecutionRequest);
}

export async function getExecutionPacket(actor: AppActor, params: { workspaceId: string; requestId: string }) {
  requireExecutionScope(actor, "execution:read");
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  const request = await loadExecutionRequest(params.workspaceId, params.requestId);
  invariant(!["FAILED", "CANCELLED"].includes(request.status), 400, "INVALID_STATE", "Execution packet is not available for failed or cancelled requests.");

  const workspace = await prisma.workspace.findUnique({
    where: { id: params.workspaceId },
    select: { id: true, slug: true, name: true, description: true },
  });
  invariant(workspace, 404, "NOT_FOUND", "Workspace not found.");

  const packetRequest = request.status === "PENDING"
    ? await prisma.executionRequest.update({
      where: { id: request.id },
      data: { status: "IN_PROGRESS", claimedAt: new Date() },
    })
    : request;

  const packet = buildExecutionPacket({ request: packetRequest, workspace });
  return packet;
}

export async function getCompanyContext(actor: AppActor, workspaceId: string) {
  requireExecutionScope(actor, "execution:read");
  requireExecutionScope(actor, "workspace:read");
  await requireWorkspaceMembership({ actor, workspaceId });

  const [workspace, actions, tensions, proposals, meetings, articles] = await Promise.all([
    prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { id: true, slug: true, name: true, description: true, plan: true },
    }),
    prisma.action.findMany({
      where: { workspaceId, archivedAt: null, isPrivate: false },
      select: { id: true, title: true, status: true, dueAt: true, updatedAt: true },
      orderBy: { updatedAt: "desc" },
      take: MAX_CONTEXT_ITEMS,
    }),
    prisma.tension.findMany({
      where: { workspaceId, archivedAt: null, isPrivate: false },
      select: { id: true, title: true, status: true, priority: true, updatedAt: true },
      orderBy: { updatedAt: "desc" },
      take: MAX_CONTEXT_ITEMS,
    }),
    prisma.proposal.findMany({
      where: { workspaceId, archivedAt: null, isPrivate: false },
      select: { id: true, title: true, summary: true, status: true, updatedAt: true },
      orderBy: { updatedAt: "desc" },
      take: MAX_CONTEXT_ITEMS,
    }),
    prisma.meeting.findMany({
      where: { workspaceId, archivedAt: null },
      select: { id: true, title: true, status: true, recordedAt: true, summaryMd: true },
      orderBy: { recordedAt: "desc" },
      take: 10,
    }),
    prisma.brainArticle.findMany({
      where: { workspaceId, archivedAt: null, isPrivate: false },
      select: { id: true, slug: true, title: true, type: true, authority: true, updatedAt: true },
      orderBy: { updatedAt: "desc" },
      take: MAX_CONTEXT_ITEMS,
    }),
  ]);
  invariant(workspace, 404, "NOT_FOUND", "Workspace not found.");

  return redactJson({
    workspace,
    recent: { actions, tensions, proposals, meetings, articles },
    policy: {
      externalExecution: "External AI workspaces execute; Corgtex supplies scoped context, policy constraints, audit, and reviewable write-back.",
      defaultWritebackMode: "draft_or_comment",
    },
  });
}

function targetTypeSet(targetTypes?: Array<string | ExecutionWritebackTargetType> | null) {
  const normalized = (targetTypes ?? []).map(normalizeExecutionTargetType).filter(Boolean) as ExecutionWritebackTargetType[];
  return normalized.length > 0 ? new Set(normalized) : null;
}

export async function listWritebackTargets(actor: AppActor, params: ListWritebackTargetsParams) {
  requireExecutionScope(actor, "execution:read");
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  const selectedTypes = targetTypeSet(params.targetTypes);
  const take = Math.min(Math.max(params.take ?? 10, 1), 50);
  const title = titleMatches(params.query);
  const items: WritebackTargetSummary[] = [];

  const includeType = (type: ExecutionWritebackTargetType) => !selectedTypes || selectedTypes.has(type);
  if (includeType("ACTION")) {
    requireExecutionScope(actor, "actions:read");
    const records = await prisma.action.findMany({
      where: { workspaceId: params.workspaceId, archivedAt: null, ...(title ? { title } : {}) },
      select: { id: true, title: true, status: true },
      orderBy: { updatedAt: "desc" },
      take,
    });
    items.push(...records.map((record) => ({ type: "ACTION" as const, id: record.id, title: record.title, status: record.status, webPath: `/actions/${record.id}` })));
  }
  if (includeType("TENSION")) {
    requireExecutionScope(actor, "tensions:read");
    const records = await prisma.tension.findMany({
      where: { workspaceId: params.workspaceId, archivedAt: null, ...(title ? { title } : {}) },
      select: { id: true, title: true, status: true },
      orderBy: { updatedAt: "desc" },
      take,
    });
    items.push(...records.map((record) => ({ type: "TENSION" as const, id: record.id, title: record.title, status: record.status, webPath: `/tensions/${record.id}` })));
  }
  if (includeType("PROPOSAL")) {
    requireExecutionScope(actor, "proposals:read");
    const records = await prisma.proposal.findMany({
      where: { workspaceId: params.workspaceId, archivedAt: null, ...(title ? { title } : {}) },
      select: { id: true, title: true, status: true },
      orderBy: { updatedAt: "desc" },
      take,
    });
    items.push(...records.map((record) => ({ type: "PROPOSAL" as const, id: record.id, title: record.title, status: record.status, webPath: `/proposals/${record.id}` })));
  }
  if (includeType("MEETING")) {
    requireExecutionScope(actor, "meetings:read");
    const records = await prisma.meeting.findMany({
      where: { workspaceId: params.workspaceId, archivedAt: null, ...(title ? { title } : {}) },
      select: { id: true, title: true, status: true },
      orderBy: { recordedAt: "desc" },
      take,
    });
    items.push(...records.map((record) => ({ type: "MEETING" as const, id: record.id, title: record.title ?? "Untitled meeting", status: record.status, webPath: `/meetings/${record.id}` })));
  }
  if (includeType("BRAIN_ARTICLE")) {
    requireExecutionScope(actor, "brain:read");
    const records = await prisma.brainArticle.findMany({
      where: { workspaceId: params.workspaceId, archivedAt: null, ...(title ? { title } : {}) },
      select: { id: true, slug: true, title: true, authority: true },
      orderBy: { updatedAt: "desc" },
      take,
    });
    items.push(...records.map((record) => ({ type: "BRAIN_ARTICLE" as const, id: record.id, title: record.title, status: record.authority, webPath: `/brain/${record.slug}` })));
  }
  if (includeType("BUILD_ARTIFACT")) {
    requireExecutionScope(actor, "workspace:read");
    const records = await prisma.buildArtifact.findMany({
      where: { workspaceId: params.workspaceId, ...(title ? { title } : {}) },
      select: { id: true, title: true, status: true },
      orderBy: { updatedAt: "desc" },
      take,
    });
    items.push(...records.map((record) => ({ type: "BUILD_ARTIFACT" as const, id: record.id, title: record.title, status: record.status, webPath: `/build-artifacts/${record.id}` })));
  }
  if (includeType("COMMENT")) {
    items.push({ type: "COMMENT", id: null, title: "Comment on execution request", status: null, webPath: "" });
  }

  return { items: items.slice(0, take * 6) };
}

async function createNativeWriteback(actor: AppActor, params: {
  workspaceId: string;
  type: ExecutionWritebackTargetType;
  targetId: string | null;
  output: JsonRecord;
  requestId: string;
}) {
  if (params.targetId || params.type === "COMMENT") {
    return { entityType: "ExecutionComment", entityId: params.requestId };
  }

  switch (params.type) {
    case "ACTION": {
      const action = await createAction(actor, {
        workspaceId: params.workspaceId,
        title: requiredString(params.output.title, "Action title"),
        bodyMd: optionalString(params.output.bodyMd) ?? optionalString(params.output.body) ?? null,
        isPrivate: true,
      });
      return { entityType: "Action", entityId: action.id };
    }
    case "TENSION": {
      const tension = await createTension(actor, {
        workspaceId: params.workspaceId,
        title: requiredString(params.output.title, "Tension title"),
        bodyMd: optionalString(params.output.bodyMd) ?? optionalString(params.output.body) ?? null,
        isPrivate: true,
      });
      return { entityType: "Tension", entityId: tension.id };
    }
    case "PROPOSAL": {
      const proposal = await createProposal(actor, {
        workspaceId: params.workspaceId,
        title: requiredString(params.output.title, "Proposal title"),
        summary: optionalString(params.output.summary),
        bodyMd: requiredString(params.output.bodyMd ?? params.output.body, "Proposal body"),
        isPrivate: true,
      });
      return { entityType: "Proposal", entityId: proposal.id };
    }
    case "MEETING": {
      const meeting = await createMeeting(actor, {
        workspaceId: params.workspaceId,
        title: optionalString(params.output.title),
        source: optionalString(params.output.source) ?? "external-execution",
        externalId: `execution-request:${params.requestId}`,
        recordedAt: optionalDate(params.output.recordedAt) ?? new Date(),
        transcript: optionalString(params.output.transcript),
        summaryMd: optionalString(params.output.summaryMd) ?? optionalString(params.output.summary),
      });
      return { entityType: "Meeting", entityId: meeting.id };
    }
    case "BRAIN_ARTICLE": {
      const article = await createArticle(actor, {
        workspaceId: params.workspaceId,
        title: requiredString(params.output.title, "Brain article title"),
        slug: optionalString(params.output.slug) ?? undefined,
        type: (optionalString(params.output.type) ?? "PROCESS") as BrainArticleType,
        authority: (optionalString(params.output.authority) ?? "DRAFT") as BrainArticleAuthority,
        bodyMd: requiredString(params.output.bodyMd ?? params.output.body, "Brain article body"),
        isPrivate: true,
      });
      return { entityType: "BrainArticle", entityId: article.id };
    }
    case "BUILD_ARTIFACT": {
      const artifact = await upsertBuildArtifact(actor, {
        workspaceId: params.workspaceId,
        repositoryOwner: requiredString(params.output.repositoryOwner, "Repository owner"),
        repositoryName: requiredString(params.output.repositoryName, "Repository name"),
        pullRequestNumber: typeof params.output.pullRequestNumber === "number" ? params.output.pullRequestNumber : null,
        pullRequestUrl: optionalString(params.output.pullRequestUrl),
        branchName: optionalString(params.output.branchName),
        commitSha: optionalString(params.output.commitSha),
        mergeCommitSha: optionalString(params.output.mergeCommitSha),
        title: requiredString(params.output.title, "Build artifact title"),
        summaryMd: optionalString(params.output.summaryMd) ?? optionalString(params.output.summary),
        status: (optionalString(params.output.status) ?? "OPEN") as BuildArtifactStatus,
        classification: (optionalString(params.output.classification) ?? "INTERNAL") as BuildArtifactClassification,
        visibility: (optionalString(params.output.visibility) ?? "PRIVATE") as BuildArtifactVisibility,
      });
      return { entityType: "BuildArtifact", entityId: artifact.id };
    }
  }
}

export async function submitExecutionResult(actor: AppActor, params: SubmitExecutionResultParams) {
  requireExecutionScope(actor, "execution:write");
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });

  const idempotencyKey = params.idempotencyKey.trim();
  invariant(idempotencyKey.length > 0, 400, "INVALID_INPUT", "Result idempotency key is required.");
  const existing = await prisma.executionResult.findUnique({
    where: { executionRequestId_idempotencyKey: { executionRequestId: params.requestId, idempotencyKey } },
  });
  if (existing) return serializeExecutionResult(existing);

  const request = await loadExecutionRequest(params.workspaceId, params.requestId);
  invariant(!["COMPLETED", "FAILED", "CANCELLED"].includes(request.status), 400, "INVALID_STATE", "Execution request is not accepting new results.");

  const targetType = normalizeExecutionTargetType(params.targetType) ?? request.writebackTargetType;
  const targetId = optionalString(params.targetId) ?? request.writebackTargetId;
  invariant(targetType, 400, "INVALID_INPUT", "Result target type is required.");
  if (request.writebackTargetType) {
    invariant(targetType === request.writebackTargetType, 400, "INVALID_INPUT", "Result target type does not match the execution request.");
  }
  if (request.writebackTargetId) {
    invariant(targetId === request.writebackTargetId, 400, "INVALID_INPUT", "Result target id does not match the execution request.");
  }
  requireExecutionScope(actor, targetWriteScope(targetType));
  await validateWritebackTarget(params.workspaceId, targetType, targetId);

  const output = objectInput(params.output);
  const errorMessage = optionalString(params.errorMessage);

  let resultShell: Awaited<ReturnType<typeof prisma.executionResult.create>>;
  try {
    resultShell = await prisma.$transaction(async (tx) => {
      const created = await tx.executionResult.create({
        data: {
          workspaceId: params.workspaceId,
          executionRequestId: request.id,
          submittedByUserId: actor.kind === "user" ? actor.user.id : null,
          agentCredentialId: actorCredentialId(actor),
          status: "SUBMITTED",
          idempotencyKey,
          targetType,
          targetId: targetId ?? null,
          outputJson: jsonInput(params.output ?? null),
          artifactJson: jsonInput(params.artifacts ?? null),
          errorMessage,
        },
      });

      await tx.executionRequest.update({
        where: { id: request.id },
        data: { status: "RESULT_SUBMITTED" },
      });

      await recordAudit(tx, actor, {
        workspaceId: params.workspaceId,
        action: "execution_result.received",
        entityType: "ExecutionRequest",
        entityId: request.id,
        meta: {
          resultId: created.id,
          targetType,
          targetId: targetId ?? null,
          outputSummary: redactJson({
            keys: Object.keys(output).sort(),
            artifactCount: Array.isArray(params.artifacts) ? params.artifacts.length : undefined,
            hasError: Boolean(errorMessage),
          }),
        },
      });

      return created;
    });
  } catch (error) {
    if (!isPrismaUniqueError(error)) throw error;
    const duplicate = await prisma.executionResult.findUnique({
      where: { executionRequestId_idempotencyKey: { executionRequestId: params.requestId, idempotencyKey } },
    });
    invariant(duplicate, 409, "CONFLICT", "Execution result idempotency conflict.");
    return serializeExecutionResult(duplicate);
  }

  const writeback = errorMessage
    ? null
    : await createNativeWriteback(actor, {
      workspaceId: params.workspaceId,
      type: targetType,
      targetId: targetId ?? null,
      output,
      requestId: request.id,
    });

  const result = await prisma.$transaction(async (tx) => {
    const updated = await tx.executionResult.update({
      where: { id: resultShell.id },
      data: {
        status: errorMessage ? "REJECTED" : "ACCEPTED",
        writebackEntityType: writeback?.entityType ?? null,
        writebackEntityId: writeback?.entityId ?? null,
        acceptedAt: errorMessage ? null : new Date(),
        rejectedAt: errorMessage ? new Date() : null,
      },
    });

    await tx.executionRequest.update({
      where: { id: request.id },
      data: {
        status: errorMessage ? "FAILED" : "COMPLETED",
        completedAt: errorMessage ? null : new Date(),
        failedAt: errorMessage ? new Date() : null,
      },
    });

    await recordAudit(tx, actor, {
      workspaceId: params.workspaceId,
      action: "execution_result.submitted",
      entityType: "ExecutionRequest",
      entityId: request.id,
      meta: {
        resultId: updated.id,
        targetType,
        targetId: targetId ?? null,
        status: updated.status,
        writebackEntityType: updated.writebackEntityType,
        writebackEntityId: updated.writebackEntityId,
      },
    });

    return updated;
  });

  return serializeExecutionResult(result);
}
