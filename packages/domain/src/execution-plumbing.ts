import { prisma } from "@corgtex/shared";
import type { AppActor, MembershipSummary } from "@corgtex/shared";
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
import { createConversationMessage, failCommunicationSuggestion, lockActiveCommunicationSuggestion, markCommunicationSuggestionSent } from "./crm";
import { activeCrmParentWhere, type CrmLinks } from "./crm-archive-guards";
import { recordAudit } from "./audit-trail";
import { actorUserIdForWorkspace, requireWorkspaceMembership } from "./auth";
import { AppError, invariant } from "./errors";
import { isKnownScope, type AgentScope } from "./agent-auth";
import { privacyFilter } from "./privacy";
import { formatWorkItemPriority } from "./work-item-priority";

const SECRET_KEY_PATTERN = /(token|secret|password|credential|api[_-]?key|access[_-]?key|refresh|authorization|bearer)/i;
const SECRET_QUERY_VALUE_PATTERN = /([?&](?:access[_-]?token|refresh[_-]?token|id[_-]?token|token|api[_-]?key|secret|signature|sig|authorization)=)[^&#\s]+/gi;
const BEARER_VALUE_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const JWT_VALUE_PATTERN = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;
const MAX_CONTEXT_ITEMS = 20;

type JsonRecord = Record<string, unknown>;

type WritebackTargetSummary = {
  type: ExecutionWritebackTargetType;
  id: string | null;
  title: string;
  status: string | null;
  webPath: string;
  context?: JsonRecord;
  crmLinks?: CrmLinks;
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
    CRM: "CRM_COMMUNICATION",
    CRM_COMMUNICATION: "CRM_COMMUNICATION",
    CRM_COMMUNICATIONS: "CRM_COMMUNICATION",
    CRM_COMMUNICATION_SUGGESTION: "CRM_COMMUNICATION",
    CRM_COMMUNICATION_SUGGESTIONS: "CRM_COMMUNICATION",
    COMMUNICATION: "CRM_COMMUNICATION",
    COMMUNICATIONS: "CRM_COMMUNICATION",
    COMMUNICATION_SUGGESTION: "CRM_COMMUNICATION",
    COMMUNICATION_SUGGESTIONS: "CRM_COMMUNICATION",
    EMAIL_SUGGESTION: "CRM_COMMUNICATION",
    EMAIL_SUGGESTIONS: "CRM_COMMUNICATION",
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
    case "CRM_COMMUNICATION": return "relationships:read";
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
    case "CRM_COMMUNICATION": return "relationships:write";
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
  if (typeof value === "string") {
    return value
      .replace(SECRET_QUERY_VALUE_PATTERN, "$1[redacted]")
      .replace(BEARER_VALUE_PATTERN, "Bearer [redacted]")
      .replace(JWT_VALUE_PATTERN, "[redacted]");
  }
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

function enumValue<TEnum extends Record<string, string>>(
  enumObject: TEnum,
  value: unknown,
  fallback: TEnum[keyof TEnum],
  label: string,
) {
  const raw = optionalString(value);
  const normalized = raw ? raw.toUpperCase().replace(/[-\s]/g, "_") : fallback;
  invariant(
    Object.values(enumObject).includes(normalized),
    400,
    "INVALID_INPUT",
    `${label} is unsupported.`,
  );
  return normalized as TEnum[keyof TEnum];
}

function titleMatches(query: string | null | undefined) {
  const trimmed = query?.trim();
  return trimmed ? { contains: trimmed, mode: "insensitive" as const } : undefined;
}

function crmCommunicationTargetContext(suggestion: {
  id: string;
  status: string;
  channel: string;
  title: string;
  subject: string | null;
  bodyMd: string;
  recipientEmail: string | null;
  recipientName: string | null;
  source: string;
  account: {
    id: string;
    name: string;
    slug: string;
    domain: string | null;
    relationshipType: string;
    lifecycleStage: string;
  } | null;
  contact: {
    id: string;
    name: string | null;
    email: string;
    company: string | null;
    title: string | null;
  } | null;
  deal: {
    id: string;
    title: string;
    stage: string;
    valueCents: number | null;
    currency: string;
  } | null;
  activity: {
    id: string;
    title: string;
    type: string;
    dueAt: Date | null;
    completedAt: Date | null;
  } | null;
}): JsonRecord {
  return {
    relationshipCommunication: {
      id: suggestion.id,
      status: suggestion.status,
      channel: suggestion.channel,
      title: suggestion.title,
      subject: suggestion.subject,
      bodyMd: suggestion.bodyMd,
      recipientEmail: suggestion.recipientEmail,
      recipientName: suggestion.recipientName,
      source: suggestion.source,
      account: suggestion.account,
      contact: suggestion.contact,
      deal: suggestion.deal,
      activity: suggestion.activity,
    },
    executionMode: {
      emailSentByCorgtex: false,
      instruction: "Send or copy the email in the external client, then submit an execution result back to Corgtex.",
      successOutput: {
        sentAt: "optional ISO timestamp",
        conversationId: "optional same-workspace CRM conversation id",
        conversationBodyMd: "optional conversation note body",
      },
      failureOutput: {
        errorMessage: "required failure reason when external execution fails",
      },
    },
  };
}

function brainArticlePrivacyFilter(actor: AppActor, membership?: MembershipSummary | null) {
  if (actor.kind === "agent" || membership?.role === "ADMIN") {
    return [{ isPrivate: false }, { isPrivate: true, authority: "DRAFT" as const }];
  }
  if (actor.kind === "user" && membership) {
    return [{ isPrivate: false }, { isPrivate: true, ownerMemberId: membership.id }];
  }
  return [{ isPrivate: false }];
}

function memberName(member: { user?: { displayName?: string | null; email?: string | null } | null } | null | undefined) {
  return member?.user?.displayName ?? member?.user?.email ?? null;
}

const executionRequestInclude = {
  results: {
    orderBy: { submittedAt: "desc" as const },
    take: 10,
  },
};

function executionRequestAccessWhere(actor: AppActor, workspaceId: string, requestId?: string): Prisma.ExecutionRequestWhereInput {
  const where: Prisma.ExecutionRequestWhereInput = {
    workspaceId,
    ...(requestId ? { id: requestId } : {}),
  };
  if (actor.kind === "agent" && actor.authProvider === "credential") {
    invariant(actor.credentialId, 403, "FORBIDDEN", "Agent credential is required for execution request access.");
    where.agentCredentialId = actor.credentialId;
  }
  return where;
}

async function findExistingExecutionRequestByIdempotency(actor: AppActor, workspaceId: string, idempotencyKey: string) {
  if (actor.kind === "agent" && actor.authProvider === "credential") {
    return prisma.executionRequest.findFirst({
      where: { ...executionRequestAccessWhere(actor, workspaceId), idempotencyKey },
      include: executionRequestInclude,
    });
  }
  return prisma.executionRequest.findUnique({
    where: { workspaceId_idempotencyKey: { workspaceId, idempotencyKey } },
    include: executionRequestInclude,
  });
}

async function loadExecutionRequest(actor: AppActor, workspaceId: string, requestId: string) {
  const request = await prisma.executionRequest.findFirst({
    where: executionRequestAccessWhere(actor, workspaceId, requestId),
    include: executionRequestInclude,
  });
  invariant(request, 404, "NOT_FOUND", "Execution request not found.");
  return request;
}

function requestOwnerActor(request: { createdByUserId: string | null }, fallback: AppActor): AppActor {
  if (fallback.kind !== "agent") return fallback;
  invariant(request.createdByUserId, 400, "INVALID_STATE", "Execution request owner is required for private write-back.");
  return {
    kind: "user",
    user: {
      id: request.createdByUserId,
      email: "execution-requester@corgtex.local",
      displayName: "Execution requester",
      globalRole: "USER",
    },
  };
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
    allowedScopes: request.allowedScopes,
    policyConstraints: request.policyConstraintsJson,
    expectedOutput: request.expectedOutputJson,
    approvalRule: request.approvalRule,
    writebackTarget: request.writebackTargetType ? {
      type: request.writebackTargetType,
      id: request.writebackTargetId,
      label: request.writebackTargetLabel,
    } : null,
    results: request.results.map(serializeExecutionResult),
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
    completedAt: request.completedAt,
  };
}

async function validateWritebackTarget(
  workspaceId: string,
  type: ExecutionWritebackTargetType | null,
  targetId?: string | null,
  actor?: AppActor,
  membership?: MembershipSummary | null,
) {
  if (!type) return null;
  if (!targetId) {
    invariant(type !== "CRM_COMMUNICATION", 400, "INVALID_INPUT", "CRM communication write-back target id is required.");
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
      const item = await prisma.action.findFirst({
        where: { id: targetId, workspaceId, archivedAt: null, ...(actor ? privacyFilter(actor, membership) : {}) },
        select: { id: true, title: true, status: true },
      });
      invariant(item, 404, "NOT_FOUND", "Action write-back target not found.");
      return { type, id: item.id, title: item.title, status: item.status, webPath: `/actions/${item.id}` };
    }
    case "TENSION": {
      const item = await prisma.tension.findFirst({
        where: { id: targetId, workspaceId, archivedAt: null, ...(actor ? privacyFilter(actor, membership) : {}) },
        select: { id: true, title: true, status: true },
      });
      invariant(item, 404, "NOT_FOUND", "Tension write-back target not found.");
      return { type, id: item.id, title: item.title, status: item.status, webPath: `/tensions/${item.id}` };
    }
    case "PROPOSAL": {
      const item = await prisma.proposal.findFirst({
        where: { id: targetId, workspaceId, archivedAt: null, ...(actor ? privacyFilter(actor, membership) : {}) },
        select: { id: true, title: true, status: true },
      });
      invariant(item, 404, "NOT_FOUND", "Proposal write-back target not found.");
      return { type, id: item.id, title: item.title, status: item.status, webPath: `/proposals/${item.id}` };
    }
    case "MEETING": {
      const item = await prisma.meeting.findFirst({ where: { id: targetId, workspaceId, archivedAt: null }, select: { id: true, title: true, status: true } });
      invariant(item, 404, "NOT_FOUND", "Meeting write-back target not found.");
      return { type, id: item.id, title: item.title ?? "Untitled meeting", status: item.status, webPath: `/meetings/${item.id}` };
    }
    case "BRAIN_ARTICLE": {
      const item = await prisma.brainArticle.findFirst({
        where: {
          AND: [
            { id: targetId, workspaceId, archivedAt: null },
            ...(actor ? [{ OR: brainArticlePrivacyFilter(actor, membership) }] : []),
          ],
        },
        select: { id: true, title: true, authority: true, slug: true },
      });
      invariant(item, 404, "NOT_FOUND", "Brain article write-back target not found.");
      return { type, id: item.id, title: item.title, status: item.authority, webPath: `/brain/${item.slug}` };
    }
    case "BUILD_ARTIFACT": {
      const item = await prisma.buildArtifact.findFirst({ where: { id: targetId, workspaceId }, select: { id: true, title: true, status: true } });
      invariant(item, 404, "NOT_FOUND", "Build artifact write-back target not found.");
      return { type, id: item.id, title: item.title, status: item.status, webPath: `/build-artifacts/${item.id}` };
    }
    case "CRM_COMMUNICATION": {
      const item = await prisma.crmCommunicationSuggestion.findFirst({
        where: { id: targetId, workspaceId, ...activeCrmParentWhere(["account", "contact", "deal", "activity"]) },
        select: {
          id: true,
          status: true,
          channel: true,
          title: true,
          subject: true,
          bodyMd: true,
          recipientEmail: true,
          recipientName: true,
          source: true,
          accountId: true,
          contactId: true,
          dealId: true,
          activityId: true,
          account: {
            select: {
              id: true,
              name: true,
              slug: true,
              domain: true,
              relationshipType: true,
              lifecycleStage: true,
            },
          },
          contact: {
            select: {
              id: true,
              name: true,
              email: true,
              company: true,
              title: true,
            },
          },
          deal: {
            select: {
              id: true,
              title: true,
              stage: true,
              valueCents: true,
              currency: true,
            },
          },
          activity: {
            select: {
              id: true,
              title: true,
              type: true,
              dueAt: true,
              completedAt: true,
            },
          },
        },
      });
      invariant(item, 404, "NOT_FOUND", "CRM communication write-back target not found.");
      invariant(item.status !== "SENT" && item.status !== "DECLINED", 400, "INVALID_STATE", "Finalized communication suggestions cannot be requested for external execution.");
      return {
        type,
        id: item.id,
        title: item.subject ?? item.title,
        status: item.status,
        webPath: item.account ? `/leads/accounts/${item.account.id}?view=review` : "/leads?view=review",
        context: crmCommunicationTargetContext(item),
        crmLinks: { accountId: item.accountId, contactId: item.contactId, dealId: item.dealId, activityId: item.activityId },
      };
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
  const membership = await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  const idempotencyKey = optionalString(params.idempotencyKey);

  if (idempotencyKey) {
    const existing = await findExistingExecutionRequestByIdempotency(actor, params.workspaceId, idempotencyKey);
    if (existing) return serializeExecutionRequest(existing);
  }

  const goal = params.goal.trim();
  invariant(goal.length > 0, 400, "INVALID_INPUT", "Execution goal is required.");
  const provider = normalizeProvider(params.provider);
  const targetType = normalizeExecutionTargetType(params.writebackTargetType);
  const allowedScopes = normalizeKnownScopes(params.allowedScopes ?? defaultScopesForTarget(targetType));
  if (targetType) {
    requireExecutionScope(actor, targetReadScope(targetType));
    requireExecutionScope(actor, targetWriteScope(targetType));
  }
  const target = await validateWritebackTarget(params.workspaceId, targetType, params.writebackTargetId, actor, membership);
  const context = params.context === undefined ? target?.context ?? null : params.context;

  const workspace = await prisma.workspace.findUnique({
    where: { id: params.workspaceId },
    select: { id: true, slug: true, name: true, description: true },
  });
  invariant(workspace, 404, "NOT_FOUND", "Workspace not found.");
  const createdByUserId = actor.kind === "user" ? actor.user.id : await actorUserIdForWorkspace(actor, params.workspaceId);
  let request: NonNullable<ExecutionRequestRecord>;
  try {
    request = await prisma.$transaction(async (tx) => {
      if (targetType === "CRM_COMMUNICATION" && target?.id) {
        await lockActiveCommunicationSuggestion(tx, {
          workspaceId: params.workspaceId,
          suggestionId: target.id,
          expectedLinks: target.crmLinks,
        });
      }
      const created = await tx.executionRequest.create({
        data: {
          workspaceId: params.workspaceId,
          createdByUserId,
          agentCredentialId: actorCredentialId(actor),
          provider,
          goal,
          actorJson: jsonInput(params.actor ?? { actorKind: actor.kind }),
          contextJson: jsonInput(context),
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
      if (targetType === "CRM_COMMUNICATION" && target?.id) {
        await tx.crmCommunicationSuggestion.update({
          where: { id: target.id },
          data: {
            status: "REQUESTED",
            externalRequestId: created.id,
            requestedAt: new Date(),
            sentAt: null,
            declinedAt: null,
            failedAt: null,
            failureReason: null,
          },
        });
        await recordAudit(tx, actor, {
          workspaceId: params.workspaceId,
          action: "crm.communication_suggestion.requested",
          entityType: "CrmCommunicationSuggestion",
          entityId: target.id,
          meta: {
            executionRequestId: created.id,
            note: "External execution request tracked; no email sent by Corgtex.",
          },
        });
      }

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
  } catch (error) {
    if (!idempotencyKey || !isPrismaUniqueError(error)) throw error;
    const existing = await findExistingExecutionRequestByIdempotency(actor, params.workspaceId, idempotencyKey);
    invariant(existing, 409, "CONFLICT", "Execution request idempotency conflict.");
    return serializeExecutionRequest(existing);
  }

  return serializeExecutionRequest(request);
}

export async function getExecutionRequest(actor: AppActor, params: { workspaceId: string; requestId: string }) {
  requireExecutionScope(actor, "execution:read");
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  return serializeExecutionRequest(await loadExecutionRequest(actor, params.workspaceId, params.requestId));
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
      ...executionRequestAccessWhere(actor, params.workspaceId),
      ...(status ? { status: status as ExecutionRequestStatus } : {}),
    },
    include: executionRequestInclude,
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(params.take ?? 20, 1), 100),
  });
  return requests.map(serializeExecutionRequest);
}

export async function getExecutionPacket(actor: AppActor, params: { workspaceId: string; requestId: string }) {
  requireExecutionScope(actor, "execution:read");
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  const request = await loadExecutionRequest(actor, params.workspaceId, params.requestId);
  invariant(!["FAILED", "CANCELLED"].includes(request.status), 400, "INVALID_STATE", "Execution packet is not available for failed or cancelled requests.");

  const workspace = await prisma.workspace.findUnique({
    where: { id: params.workspaceId },
    select: { id: true, slug: true, name: true, description: true },
  });
  invariant(workspace, 404, "NOT_FOUND", "Workspace not found.");

  let packetRequest = request;
  if (request.status === "PENDING") {
    const claim = await prisma.executionRequest.updateMany({
      where: { ...executionRequestAccessWhere(actor, params.workspaceId, request.id), status: "PENDING" },
      data: { status: "IN_PROGRESS", claimedAt: new Date() },
    });
    invariant(claim.count === 1, 409, "INVALID_STATE", "Execution packet is no longer available for claiming.");
    packetRequest = await loadExecutionRequest(actor, params.workspaceId, params.requestId);
  }

  const packet = buildExecutionPacket({ request: packetRequest, workspace });
  return packet;
}

export async function getCompanyContext(actor: AppActor, workspaceId: string) {
  requireExecutionScope(actor, "execution:read");
  requireExecutionScope(actor, "workspace:read");
  requireExecutionScope(actor, "actions:read");
  requireExecutionScope(actor, "tensions:read");
  requireExecutionScope(actor, "proposals:read");
  requireExecutionScope(actor, "meetings:read");
  requireExecutionScope(actor, "brain:read");
  await requireWorkspaceMembership({ actor, workspaceId });

  const [workspace, actions, tensions, proposals, meetings, articles] = await Promise.all([
    prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { id: true, slug: true, name: true, description: true, plan: true },
    }),
    prisma.action.findMany({
      where: { workspaceId, archivedAt: null, isPrivate: false },
      select: {
        id: true,
        title: true,
        status: true,
        priority: true,
        assigneeMemberId: true,
        assigneeMember: { select: { user: { select: { displayName: true, email: true } } } },
        dueAt: true,
        updatedAt: true,
      },
      orderBy: { updatedAt: "desc" },
      take: MAX_CONTEXT_ITEMS,
    }),
    prisma.tension.findMany({
      where: { workspaceId, archivedAt: null, isPrivate: false },
      select: {
        id: true,
        title: true,
        status: true,
        priority: true,
        assigneeMemberId: true,
        assigneeMember: { select: { user: { select: { displayName: true, email: true } } } },
        raisedByMemberId: true,
        raisedByMember: { select: { user: { select: { displayName: true, email: true } } } },
        updatedAt: true,
      },
      orderBy: { updatedAt: "desc" },
      take: MAX_CONTEXT_ITEMS,
    }),
    prisma.proposal.findMany({
      where: { workspaceId, archivedAt: null, isPrivate: false },
      select: {
        id: true,
        title: true,
        summary: true,
        status: true,
        priority: true,
        ownerMemberId: true,
        ownerMember: { select: { user: { select: { displayName: true, email: true } } } },
        updatedAt: true,
      },
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

  const mappedActions = actions.map(({ assigneeMember, ...action }) => {
    const assignee = memberName(assigneeMember);
    return {
      ...action,
      priorityLabel: formatWorkItemPriority(action.priority),
      assigneeMemberName: assignee,
      assignee,
    };
  });
  const mappedTensions = tensions.map(({ assigneeMember, raisedByMember, ...tension }) => {
    const responsiblePerson = memberName(assigneeMember);
    const raisedBy = memberName(raisedByMember);
    return {
      ...tension,
      priorityLabel: formatWorkItemPriority(tension.priority),
      responsibleMemberId: tension.assigneeMemberId,
      responsibleMemberName: responsiblePerson,
      responsiblePerson,
      raisedByMemberName: raisedBy,
      raisedBy,
    };
  });
  const mappedProposals = proposals.map(({ ownerMember, ...proposal }) => {
    const owner = memberName(ownerMember);
    return {
      ...proposal,
      priorityLabel: formatWorkItemPriority(proposal.priority),
      ownerMemberName: owner,
      owner,
    };
  });

  return redactJson({
    workspace,
    recent: { actions: mappedActions, tensions: mappedTensions, proposals: mappedProposals, meetings, articles },
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
  const membership = await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  const selectedTypes = targetTypeSet(params.targetTypes);
  const take = Math.min(Math.max(params.take ?? 10, 1), 50);
  const title = titleMatches(params.query);
  const items: WritebackTargetSummary[] = [];

  const includeType = (type: ExecutionWritebackTargetType) => !selectedTypes || selectedTypes.has(type);
  if (includeType("ACTION")) {
    requireExecutionScope(actor, "actions:read");
    const records = await prisma.action.findMany({
      where: { workspaceId: params.workspaceId, archivedAt: null, ...privacyFilter(actor, membership), ...(title ? { title } : {}) },
      select: { id: true, title: true, status: true },
      orderBy: { updatedAt: "desc" },
      take,
    });
    items.push(...records.map((record) => ({ type: "ACTION" as const, id: record.id, title: record.title, status: record.status, webPath: `/actions/${record.id}` })));
  }
  if (includeType("TENSION")) {
    requireExecutionScope(actor, "tensions:read");
    const records = await prisma.tension.findMany({
      where: { workspaceId: params.workspaceId, archivedAt: null, ...privacyFilter(actor, membership), ...(title ? { title } : {}) },
      select: { id: true, title: true, status: true },
      orderBy: { updatedAt: "desc" },
      take,
    });
    items.push(...records.map((record) => ({ type: "TENSION" as const, id: record.id, title: record.title, status: record.status, webPath: `/tensions/${record.id}` })));
  }
  if (includeType("PROPOSAL")) {
    requireExecutionScope(actor, "proposals:read");
    const records = await prisma.proposal.findMany({
      where: { workspaceId: params.workspaceId, archivedAt: null, ...privacyFilter(actor, membership), ...(title ? { title } : {}) },
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
      where: {
        AND: [
          { workspaceId: params.workspaceId, archivedAt: null, ...(title ? { title } : {}) },
          { OR: brainArticlePrivacyFilter(actor, membership) },
        ],
      },
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
  if (includeType("CRM_COMMUNICATION")) {
    requireExecutionScope(actor, "relationships:read");
    const records = await prisma.crmCommunicationSuggestion.findMany({
      where: {
        workspaceId: params.workspaceId,
        ...activeCrmParentWhere(["account", "contact", "deal", "activity"]),
        ...(title
          ? {
            OR: [
              { title },
              { subject: title },
              { recipientEmail: title },
              { recipientName: title },
            ],
          }
          : {}),
      },
      select: {
        id: true,
        title: true,
        subject: true,
        status: true,
        accountId: true,
      },
      orderBy: { updatedAt: "desc" },
      take,
    });
    items.push(...records.map((record) => ({
      type: "CRM_COMMUNICATION" as const,
      id: record.id,
      title: record.subject ?? record.title,
      status: record.status,
      webPath: record.accountId ? `/leads/accounts/${record.accountId}?view=review` : "/leads?view=review",
    })));
  }
  if (includeType("COMMENT")) {
    items.push({ type: "COMMENT", id: null, title: "Comment on execution request", status: null, webPath: "" });
  }

  return { items: items.slice(0, take * 6) };
}

async function validateCrmCommunicationResultOutput(workspaceId: string, targetId: string | null, output: JsonRecord) {
  invariant(targetId, 400, "INVALID_INPUT", "CRM communication result target id is required.");
  optionalDate(output.sentAt);

  const conversationId = optionalString(output.conversationId);
  if (conversationId) {
    const conversation = await prisma.crmConversation.findFirst({
      where: { id: conversationId, workspaceId, ...activeCrmParentWhere(["account", "contact", "deal"]) },
      select: { id: true },
    });
    invariant(conversation, 404, "NOT_FOUND", "CRM conversation write-back target not found.");
  }
}

async function createCrmCommunicationWriteback(actor: AppActor, params: {
  workspaceId: string;
  targetId: string;
  output: JsonRecord;
  errorMessage: string | null;
  requestCreatedByUserId: string | null;
  transaction?: Prisma.TransactionClient;
}) {
  const writebackActor = requestOwnerActor({ createdByUserId: params.requestCreatedByUserId }, actor);
  const conversationId = optionalString(params.output.conversationId);
  if (!params.errorMessage && params.transaction) {
    const conversation = conversationId ? await params.transaction.crmConversation.findUnique({ where: { id: conversationId } }) : null;
    invariant(!conversationId || conversation?.workspaceId === params.workspaceId, 404, "NOT_FOUND",
      "CRM conversation write-back target not found.");
    await lockActiveCommunicationSuggestion(params.transaction, { workspaceId: params.workspaceId,
      suggestionId: params.targetId, replacements: conversation ?? {} });
    if (conversation) invariant(await params.transaction.crmConversation.findFirst({ where: { id: conversation.id,
      workspaceId: params.workspaceId, ...activeCrmParentWhere(["account", "contact", "deal"]) }, select: { id: true } }),
    404, "NOT_FOUND", "CRM conversation write-back target not found.");
  }
  if (params.errorMessage) {
    const suggestion = await failCommunicationSuggestion(writebackActor, {
      workspaceId: params.workspaceId,
      suggestionId: params.targetId,
      failureReason: params.errorMessage,
    }, params.transaction);
    return { entityType: "CrmCommunicationSuggestion", entityId: suggestion?.id ?? params.targetId };
  }

  const suggestion = await markCommunicationSuggestionSent(writebackActor, {
    workspaceId: params.workspaceId,
    suggestionId: params.targetId,
    sentAt: optionalDate(params.output.sentAt),
  }, params.transaction);

  if (conversationId) {
    await createConversationMessage(writebackActor, {
      workspaceId: params.workspaceId,
      conversationId,
      senderType: "ADMIN",
      senderEmail: optionalString(params.output.senderEmail) ?? undefined,
      bodyMd: optionalString(params.output.conversationBodyMd)
        ?? optionalString(params.output.messageBodyMd)
        ?? optionalString(params.output.bodyMd)
        ?? optionalString(params.output.body)
        ?? "External communication was marked sent.",
    }, params.transaction);
  }

  return { entityType: "CrmCommunicationSuggestion", entityId: suggestion?.id ?? params.targetId };
}

async function createNativeWriteback(actor: AppActor, params: {
  workspaceId: string;
  type: ExecutionWritebackTargetType;
  targetId: string | null;
  output: JsonRecord;
  requestId: string;
  resultId: string;
  requestCreatedByUserId: string | null;
}) {
  if (params.type === "CRM_COMMUNICATION") {
    invariant(params.targetId, 400, "INVALID_INPUT", "CRM communication write-back target id is required.");
    return createCrmCommunicationWriteback(actor, {
      workspaceId: params.workspaceId,
      targetId: params.targetId,
      output: params.output,
      errorMessage: null,
      requestCreatedByUserId: params.requestCreatedByUserId,
    });
  }
  if (params.targetId || params.type === "COMMENT") {
    return { entityType: "ExecutionResult", entityId: params.resultId };
  }
  const writebackActor = requestOwnerActor({ createdByUserId: params.requestCreatedByUserId }, actor);

  switch (params.type) {
    case "ACTION": {
      const action = await createAction(writebackActor, {
        workspaceId: params.workspaceId,
        title: requiredString(params.output.title, "Action title"),
        bodyMd: optionalString(params.output.bodyMd) ?? optionalString(params.output.body) ?? null,
        isPrivate: true,
        duplicateGuard: { onExact: "use_existing" },
      });
      return { entityType: "Action", entityId: action.id };
    }
    case "TENSION": {
      const tension = await createTension(writebackActor, {
        workspaceId: params.workspaceId,
        title: requiredString(params.output.title, "Tension title"),
        bodyMd: optionalString(params.output.bodyMd) ?? optionalString(params.output.body) ?? null,
        isPrivate: true,
        duplicateGuard: { onExact: "use_existing" },
      });
      return { entityType: "Tension", entityId: tension.id };
    }
    case "PROPOSAL": {
      const proposal = await createProposal(writebackActor, {
        workspaceId: params.workspaceId,
        title: requiredString(params.output.title, "Proposal title"),
        summary: optionalString(params.output.summary),
        bodyMd: requiredString(params.output.bodyMd ?? params.output.body, "Proposal body"),
        isPrivate: true,
        duplicateGuard: { onExact: "use_existing" },
      });
      return { entityType: "Proposal", entityId: proposal.id };
    }
    case "MEETING": {
      const meeting = await createMeeting(writebackActor, {
        workspaceId: params.workspaceId,
        title: optionalString(params.output.title),
        source: optionalString(params.output.source) ?? "external-execution",
        externalId: `execution-request:${params.requestId}`,
        recordedAt: optionalDate(params.output.recordedAt) ?? new Date(),
        transcript: optionalString(params.output.transcript),
        summaryMd: optionalString(params.output.summaryMd) ?? optionalString(params.output.summary),
        duplicateGuard: { onExact: "use_existing" },
      });
      return { entityType: "Meeting", entityId: meeting.id };
    }
    case "BRAIN_ARTICLE": {
      const article = await createArticle(writebackActor, {
        workspaceId: params.workspaceId,
        title: requiredString(params.output.title, "Brain article title"),
        slug: optionalString(params.output.slug) ?? undefined,
        type: enumValue(BrainArticleType, params.output.type, "PROCESS", "Brain article type"),
        authority: enumValue(BrainArticleAuthority, params.output.authority, "DRAFT", "Brain article authority"),
        bodyMd: requiredString(params.output.bodyMd ?? params.output.body, "Brain article body"),
        isPrivate: true,
        duplicateGuard: { onExact: "use_existing" },
      });
      return { entityType: "BrainArticle", entityId: article.id };
    }
    case "BUILD_ARTIFACT": {
      const artifact = await upsertBuildArtifact(writebackActor, {
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
        status: enumValue(BuildArtifactStatus, params.output.status, "OPEN", "Build artifact status"),
        classification: enumValue(BuildArtifactClassification, params.output.classification, "INTERNAL", "Build artifact classification"),
        visibility: enumValue(BuildArtifactVisibility, params.output.visibility, "PRIVATE", "Build artifact visibility"),
      });
      return { entityType: "BuildArtifact", entityId: artifact.id };
    }
  }
}

function validateNativeWritebackOutput(type: ExecutionWritebackTargetType, targetId: string | null, output: JsonRecord) {
  if (targetId || type === "COMMENT") return;

  switch (type) {
    case "ACTION":
      requiredString(output.title, "Action title");
      return;
    case "TENSION":
      requiredString(output.title, "Tension title");
      return;
    case "PROPOSAL":
      requiredString(output.title, "Proposal title");
      requiredString(output.bodyMd ?? output.body, "Proposal body");
      return;
    case "MEETING":
      optionalDate(output.recordedAt);
      return;
    case "BRAIN_ARTICLE":
      requiredString(output.title, "Brain article title");
      requiredString(output.bodyMd ?? output.body, "Brain article body");
      enumValue(BrainArticleType, output.type, "PROCESS", "Brain article type");
      enumValue(BrainArticleAuthority, output.authority, "DRAFT", "Brain article authority");
      return;
    case "BUILD_ARTIFACT":
      requiredString(output.repositoryOwner, "Repository owner");
      requiredString(output.repositoryName, "Repository name");
      requiredString(output.title, "Build artifact title");
      enumValue(BuildArtifactStatus, output.status, "OPEN", "Build artifact status");
      enumValue(BuildArtifactClassification, output.classification, "INTERNAL", "Build artifact classification");
      enumValue(BuildArtifactVisibility, output.visibility, "PRIVATE", "Build artifact visibility");
      return;
    case "CRM_COMMUNICATION":
      invariant(targetId, 400, "INVALID_INPUT", "CRM communication result target id is required.");
      return;
  }
}

export async function submitExecutionResult(actor: AppActor, params: SubmitExecutionResultParams) {
  requireExecutionScope(actor, "execution:write");
  const membership = await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });

  const idempotencyKey = params.idempotencyKey.trim();
  invariant(idempotencyKey.length > 0, 400, "INVALID_INPUT", "Result idempotency key is required.");
  const request = await loadExecutionRequest(actor, params.workspaceId, params.requestId);
  const existing = await prisma.executionResult.findUnique({
    where: { executionRequestId_idempotencyKey: { executionRequestId: request.id, idempotencyKey } },
  });
  if (existing) return serializeExecutionResult(existing);

  invariant(["PENDING", "IN_PROGRESS"].includes(request.status), 400, "INVALID_STATE", "Execution request is not accepting new results.");

  const targetType = normalizeExecutionTargetType(params.targetType) ?? request.writebackTargetType;
  const targetId = optionalString(params.targetId) ?? request.writebackTargetId;
  if (request.writebackTargetType) {
    invariant(targetType === request.writebackTargetType, 400, "INVALID_INPUT", "Result target type does not match the execution request.");
  }
  if (request.writebackTargetId) {
    invariant(targetId === request.writebackTargetId, 400, "INVALID_INPUT", "Result target id does not match the execution request.");
  }

  const output = objectInput(params.output);
  const errorMessage = optionalString(params.errorMessage);
  if (targetType === "CRM_COMMUNICATION") {
    invariant(targetId, 400, "INVALID_INPUT", "CRM communication result target id is required.");
    const writeScope = targetWriteScope(targetType);
    requireExecutionScope(actor, writeScope);
    invariant(request.allowedScopes.includes(writeScope), 403, "FORBIDDEN", `Execution request does not allow the required scope: ${writeScope}.`);
    await validateWritebackTarget(params.workspaceId, targetType, targetId, actor, membership);
    await validateCrmCommunicationResultOutput(params.workspaceId, targetId, output);
  } else if (!errorMessage) {
    invariant(targetType, 400, "INVALID_INPUT", "Result target type is required.");
    const writeScope = targetWriteScope(targetType);
    requireExecutionScope(actor, writeScope);
    invariant(request.allowedScopes.includes(writeScope), 403, "FORBIDDEN", `Execution request does not allow the required scope: ${writeScope}.`);
    await validateWritebackTarget(params.workspaceId, targetType, targetId, actor, membership);
    validateNativeWritebackOutput(targetType, targetId ?? null, output);
  }

  let resultShell: Awaited<ReturnType<typeof prisma.executionResult.create>>;
  let crmWriteback: Awaited<ReturnType<typeof createCrmCommunicationWriteback>> | null = null;
  try {
    const shell = await prisma.$transaction(async (tx) => {
      const atomicWriteback = targetType === "CRM_COMMUNICATION" && targetId
        ? await createCrmCommunicationWriteback(actor, { workspaceId: params.workspaceId, targetId, output, errorMessage,
          requestCreatedByUserId: request.createdByUserId, transaction: tx }) : null;
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

      return { created, atomicWriteback };
    });
    resultShell = shell.created;
    crmWriteback = shell.atomicWriteback;
  } catch (error) {
    if (!isPrismaUniqueError(error)) throw error;
    const duplicate = await prisma.executionResult.findUnique({
      where: { executionRequestId_idempotencyKey: { executionRequestId: request.id, idempotencyKey } },
    });
    invariant(duplicate, 409, "CONFLICT", "Execution result idempotency conflict.");
    return serializeExecutionResult(duplicate);
  }

  const writeback = crmWriteback ?? (errorMessage || !targetType || targetType === "CRM_COMMUNICATION"
      ? null
      : await createNativeWriteback(actor, {
      workspaceId: params.workspaceId,
      type: targetType,
      targetId: targetId ?? null,
      output,
      requestId: request.id,
      resultId: resultShell.id,
      requestCreatedByUserId: request.createdByUserId,
    }));

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
