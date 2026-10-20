import { WorkItemReadRelease } from "./work-item-readable-page";
import { randomUUID } from "node:crypto";
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
  type Action,
  type Tension,
  type Proposal,
  type Meeting,
  type BrainArticle,
  type CrmCommunicationSuggestion,
  type ExecutionRequest,
  type ExecutionResult,
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
import { OPERATIONAL_ARTIFACT_FILTER } from "./operational-artifacts";
import { privacyFilter } from "./privacy";
import { formatWorkItemPriority } from "./work-item-priority";
import { captureArtifactInputProof, captureArtifactInputSnapshotProof, isArtifactInputProofPubliclyShareable,
  captureImmutableArtifactInputProof, isArtifactInputProofReadable, readableArtifactIds, assertArtifactInputWriteFence,
  sealArtifactInputActor, lineageContentFingerprint, inspectStoredArtifactInputDependencies, type LineageKind, type LineageRoot } from "./source-lineage";
import { finishProducerLineage, prepareProducerLineage, type ProducerLineageParams } from "./producer-lineage";
import { createArtifactSampleBudget, captureReadableDigestInputs } from "./digest-lineage";
import { getMcpToolInputRoots } from "./mcp-tool-input-context";
import { lockArtifactReadAuthorityRows, prepareArtifactCommitPreflight, withArtifactCommitPreflight } from "./artifact-commit-preflight";
import { prepareArtifactSourceCommit, withArtifactSourceCommit } from "./artifact-source-commit";
import { withArtifactInputSnapshotAllocations, type ArtifactInputSnapshotAllocation } from "./artifact-input-snapshot-allocations";
import type { SourceCommitOwnerBinding, SourceCommitWriteTarget } from "./source-commit-lock-plan";

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
  lineageRoots?: LineageRoot[];
};

type ExecutionRequestRecord = Awaited<ReturnType<typeof loadExecutionRequest>>;

export type CreateExecutionRequestParams = ProducerLineageParams & {
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
  copied?: boolean;
};

export type SubmitExecutionResultParams = ProducerLineageParams & {
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

const CRM_RECEIPT_KEY = "__crmInputReceipt";

function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

function crmPacketRoots(request: { writebackTargetType: ExecutionWritebackTargetType | null; contextJson: unknown }): LineageRoot[] | null {
  if (request.writebackTargetType !== "CRM_COMMUNICATION") return null;
  const context = asRecord(request.contextJson);
  const receipt = asRecord(context?.[CRM_RECEIPT_KEY]);
  const roots = receipt?.roots;
  invariant(receipt?.version === 1 && Array.isArray(roots) && roots.length > 0
    && roots.every((root) => { const row = asRecord(root); return row && typeof row.kind === "string"
      && typeof row.id === "string" && row.id.length > 0 && typeof row.fingerprint === "string" && /^[a-f0-9]{64}$/.test(row.fingerprint); }),
  409, "UNKNOWN_LINEAGE", "CRM execution context has no complete input receipt.");
  return roots as LineageRoot[];
}

async function requireCrmPacketProof(actor: AppActor, workspaceId: string,
  request: { writebackTargetType: ExecutionWritebackTargetType | null; contextJson: unknown }) {
  const roots = crmPacketRoots(request);
  if (!roots) return;
  invariant(await isArtifactInputProofReadable(actor, workspaceId, roots), 403, "SOURCE_RESTRICTED", "Execution context is no longer readable.");
  invariant(await isArtifactInputProofPubliclyShareable(actor, workspaceId, roots),
    403, "SOURCE_RESTRICTED", "Execution context is not shareable with this external destination.");
}

function withoutCrmReceipt(context: unknown) {
  const record = asRecord(context);
  if (!record || !(CRM_RECEIPT_KEY in record)) return context;
  const { [CRM_RECEIPT_KEY]: _receipt, ...visible } = record;
  return visible;
}

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

async function loadExecutionRequest(actor: AppActor, workspaceId: string, requestId: string, release?: WorkItemReadRelease) {
  const request = await prisma.executionRequest.findFirst({
    where: executionRequestAccessWhere(actor, workspaceId, requestId),
    include: executionRequestInclude,
  });
  invariant(request, 404, "NOT_FOUND", "Execution request not found.");
  await requireCrmPacketProof(actor, workspaceId, request);
  if (release) {
    release.add(crmPacketRoots(request) ?? []);
    const admitted = await captureReadableDigestInputs({actor,workspaceId,kind:"ExecutionRequest",records:[request]});
    invariant(admitted.records.length,404,"NOT_FOUND","Execution request not found.");
    release.add(admitted.roots);
  } else await requireExecutionRequestProof(actor, workspaceId, request);
  const candidates = await prisma.executionResult.findMany({ where: { workspaceId, executionRequestId: request.id },
    orderBy: { id: "asc" }, take: 5001 });
  invariant(candidates.length <= 5000, 503, "SOURCE_READ_SCAN_LIMIT", "Execution result permission scan exceeds its supported size.");
  const captured = release ? await captureReadableDigestInputs({actor,workspaceId,kind:"ExecutionResult",records:candidates}) : null;
  const allowed = captured ? new Set(captured.records.map(row=>row.id)) : await readableArtifactIds(actor, workspaceId, "ExecutionResult", candidates);
  const results = candidates.filter((result) => allowed.has(result.id))
    .sort((a, b) => b.submittedAt.getTime() - a.submittedAt.getTime() || a.id.localeCompare(b.id)).slice(0, 10);
  if (release && captured) for (const result of results) release.add(captured.proofs.get(result.id)!);
  await requireExecutionRequestProof(actor, workspaceId, request);
  invariant((await readableArtifactIds(actor, workspaceId, "ExecutionResult", results)).size === results.length,
    409, "SOURCE_CHANGED", "Execution result inputs changed during collection.");
  return { ...request, results };
}

async function requireExecutionRequestProof(actor: AppActor, workspaceId: string,
  request: { id: string; writebackTargetType: ExecutionWritebackTargetType | null; [key: string]: unknown },
  tx: Prisma.TransactionClient = prisma) {
  invariant((await readableArtifactIds(actor, workspaceId, "ExecutionRequest", [request], tx)).has(request.id),
    404, "NOT_FOUND", "Execution request not found.");
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

function serializeIdempotentExecutionResult(result: Parameters<typeof serializeExecutionResult>[0]) {
  invariant(["ACCEPTED", "REJECTED"].includes(result.status), 409, "CONFLICT",
    "Execution result is incomplete and requires repair.");
  return serializeExecutionResult(result);
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
  client: Prisma.TransactionClient | typeof prisma = prisma,
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
      const item = await client.action.findFirst({
        where: { id: targetId, workspaceId, archivedAt: null, ...(actor ? privacyFilter(actor, membership) : {}) },
      });
      invariant(item, 404, "NOT_FOUND", "Action write-back target not found.");
      invariant(actor, 403, "FORBIDDEN", "A current actor is required.");
      const lineageRoots = await captureArtifactInputProof(actor, workspaceId, [{ kind: "Action", id: item.id, snapshot: item }], client);
      return { type, id: item.id, title: item.title, status: item.status, webPath: `/actions/${item.id}`, lineageRoots };
    }
    case "TENSION": {
      const item = await client.tension.findFirst({
        where: { id: targetId, workspaceId, archivedAt: null, ...(actor ? privacyFilter(actor, membership) : {}) },
      });
      invariant(item, 404, "NOT_FOUND", "Tension write-back target not found.");
      invariant(actor, 403, "FORBIDDEN", "A current actor is required.");
      const lineageRoots = await captureArtifactInputProof(actor, workspaceId, [{ kind: "Tension", id: item.id, snapshot: item }], client);
      return { type, id: item.id, title: item.title, status: item.status, webPath: `/tensions/${item.id}`, lineageRoots };
    }
    case "PROPOSAL": {
      const item = await client.proposal.findFirst({
        where: { id: targetId, workspaceId, archivedAt: null, ...(actor ? privacyFilter(actor, membership) : {}) },
      });
      invariant(item, 404, "NOT_FOUND", "Proposal write-back target not found.");
      invariant(actor, 403, "FORBIDDEN", "A current actor is required.");
      const lineageRoots = await captureArtifactInputProof(actor, workspaceId, [{ kind: "Proposal", id: item.id, snapshot: item }], client);
      return { type, id: item.id, title: item.title, status: item.status, webPath: `/proposals/${item.id}`, lineageRoots };
    }
    case "MEETING": {
      const item = await client.meeting.findFirst({ where: { id: targetId, workspaceId, archivedAt: null } });
      invariant(item, 404, "NOT_FOUND", "Meeting write-back target not found.");
      invariant(actor, 403, "FORBIDDEN", "A current actor is required.");
      const lineageRoots = await captureArtifactInputProof(actor, workspaceId, [{ kind: "Meeting", id: item.id, snapshot: item }], client);
      return { type, id: item.id, title: item.title ?? "Untitled meeting", status: item.status, webPath: `/meetings/${item.id}`, lineageRoots };
    }
    case "BRAIN_ARTICLE": {
      const item = await client.brainArticle.findFirst({
        where: {
          AND: [
            { id: targetId, workspaceId, archivedAt: null },
            ...(actor ? [{ OR: brainArticlePrivacyFilter(actor, membership) }] : []),
          ],
        },
      });
      invariant(item, 404, "NOT_FOUND", "Brain article write-back target not found.");
      invariant(actor, 403, "FORBIDDEN", "A current actor is required.");
      const lineageRoots = await captureArtifactInputProof(actor, workspaceId, [{ kind: "BrainArticle", id: item.id, snapshot: item }], client);
      return { type, id: item.id, title: item.title, status: item.authority, webPath: `/brain/${item.slug}`, lineageRoots };
    }
    case "BUILD_ARTIFACT": {
      const item = await client.buildArtifact.findFirst({
        where: { id: targetId, workspaceId, NOT: OPERATIONAL_ARTIFACT_FILTER },
      });
      invariant(item, 404, "NOT_FOUND", "Build artifact write-back target not found.");
      invariant(actor, 403, "FORBIDDEN", "Build artifact write-back target requires a current actor.");
      const lineageRoots = await captureArtifactInputProof(actor, workspaceId, [{ kind: "BuildArtifact", id: item.id, snapshot: item }], client);
      return { type, id: item.id, title: item.title, status: item.status, webPath: `/build-artifacts/${item.id}`, lineageRoots };
    }
    case "CRM_COMMUNICATION": {
      const item = await client.crmCommunicationSuggestion.findFirst({
        where: { id: targetId, workspaceId, ...activeCrmParentWhere(["account", "contact", "deal", "activity"]) },
        include: {
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
      invariant(actor, 401, "UNAUTHORIZED", "Actor required for CRM execution context.");
      const lineageRoots = await captureArtifactInputProof(actor, workspaceId, [
        { kind: "CrmCommunicationSuggestion", id: item.id, snapshot: item },
        ...([["account", "CrmAccount"], ["contact", "CrmContact"], ["deal", "CrmDeal"], ["activity", "CrmActivity"]] as const)
          .flatMap(([field, kind]) => item[field] ? [{ kind, id: item[field]!.id, snapshot: item[field]! }] : []),
      ], client);
      invariant(item.status !== "SENT" && item.status !== "DECLINED", 400, "INVALID_STATE", "Finalized communication suggestions cannot be requested for external execution.");
      return {
        type,
        id: item.id,
        title: item.subject ?? item.title,
        status: item.status,
        webPath: item.account ? `/leads/accounts/${item.account.id}?view=review` : "/leads?view=review",
        context: crmCommunicationTargetContext(item),
        crmLinks: { accountId: item.accountId, contactId: item.contactId, dealId: item.dealId, activityId: item.activityId },
        lineageRoots,
      };
    }
    case "COMMENT": {
      invariant(actor, 403, "FORBIDDEN", "A current actor is required.");
      const item = await client.executionRequest.findFirst({ where: executionRequestAccessWhere(actor, workspaceId, targetId) });
      invariant(item, 404, "NOT_FOUND", "Execution comment target not found.");
      const lineageRoots = await captureArtifactInputProof(actor, workspaceId, [{ kind: "ExecutionRequest", id: item.id, snapshot: item }], client);
      return { type, id: targetId, title: "Execution comment", status: null, webPath: "", lineageRoots };
    }
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
    relevantContext: withoutCrmReceipt(request.contextJson),
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
    if (existing) { await requireCrmPacketProof(actor, params.workspaceId, existing);
      await requireExecutionRequestProof(actor, params.workspaceId, existing);
      return serializeExecutionRequest(await loadExecutionRequest(actor, params.workspaceId, existing.id)); }
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
  if (targetType === "CRM_COMMUNICATION" && (params.context !== undefined || actor.kind !== "user")) {
    invariant(params.lineageRoots?.length, 409, "UNKNOWN_LINEAGE", "Custom CRM execution context requires its complete producer receipt.");
  }
  if (params.context !== undefined || actor.kind !== "user" || params.copied) {
    invariant(params.lineageRoots?.length || getMcpToolInputRoots(actor, params.workspaceId).length,
      409, "UNKNOWN_LINEAGE", "Copied execution context requires its complete input receipt.");
  }

  const workspace = await prisma.workspace.findUnique({
    where: { id: params.workspaceId },
    select: { id: true, slug: true, name: true, description: true },
  });
  invariant(workspace, 404, "NOT_FOUND", "Workspace not found.");
  const createdByUserId = actor.kind === "user" ? actor.user.id : await actorUserIdForWorkspace(actor, params.workspaceId);
  let request: NonNullable<ExecutionRequestRecord>;
  try {
    request = await prisma.$transaction(async (tx) => {
      let packetContext = context;
      let requestRoots = [...(params.lineageRoots ?? []), ...(target?.lineageRoots ?? [])];
      let suggestionReceipt: Awaited<ReturnType<typeof prepareProducerLineage>> | undefined;
      if (targetType === "CRM_COMMUNICATION" && target?.id) {
        const suggestion = await lockActiveCommunicationSuggestion(tx, {
          workspaceId: params.workspaceId,
          suggestionId: target.id,
          expectedLinks: target.crmLinks,
        });
        const direct = target.lineageRoots?.find((root) => root.kind === "CrmCommunicationSuggestion" && root.id === suggestion.id);
        invariant(direct, 409, "UNKNOWN_LINEAGE", "CRM execution target has no source receipt.");
        const snapshots = await captureArtifactInputSnapshotProof(actor, params.workspaceId, direct, tx);
        const lockedTarget = await validateWritebackTarget(params.workspaceId, targetType, suggestion.id, actor, membership, tx);
        const roots = [...(lockedTarget?.lineageRoots ?? []), ...(params.lineageRoots ?? [])]
          .filter((root) => root.kind !== "CrmCommunicationSuggestion" || root.id !== suggestion.id);
        roots.push(...snapshots);
        roots.push(...await captureArtifactInputProof(actor, params.workspaceId,
          [{ kind: "Workspace", id: workspace.id, snapshot: workspace }], tx));
        invariant(await isArtifactInputProofReadable(actor, params.workspaceId, roots, tx), 409, "SOURCE_CHANGED", "CRM execution inputs changed before persistence.");
        invariant(await isArtifactInputProofPubliclyShareable(actor, params.workspaceId, roots, tx),
          403, "SOURCE_RESTRICTED", "CRM execution context is not shareable with this external destination.");
        if (params.lineageRoots?.length) invariant(await isArtifactInputProofReadable(actor, params.workspaceId, params.lineageRoots, tx),
          409, "SOURCE_CHANGED", "Custom execution context inputs changed before persistence.");
        const supplied = params.context === undefined ? lockedTarget?.context : params.context;
        requestRoots = roots;
        packetContext = { ...(asRecord(supplied) ?? { providedContext: supplied }),
          [CRM_RECEIPT_KEY]: { version: 1, roots } };
        suggestionReceipt = await prepareProducerLineage({ tx, actor, workspaceId: params.workspaceId,
          artifact: { kind: "CrmCommunicationSuggestion", id: suggestion.id }, before: suggestion, allowSystemTransition: true });
      }
      const requestReceipt = await prepareProducerLineage({ tx, actor, workspaceId: params.workspaceId,
        capture: { lineageInputs: targetType === "CRM_COMMUNICATION" ? params.lineageInputs?.filter((input) => input.kind !== "CrmCommunicationSuggestion" || input.id !== target?.id) : params.lineageInputs, lineageRoots: requestRoots },
        copied: params.copied, dependencies: [{ kind: "Workspace", id: workspace.id, snapshot: workspace }] });
      invariant(requestReceipt.mode !== "UNKNOWN", 409, "UNKNOWN_LINEAGE", "Execution inputs cannot be proven.");
      const created = await tx.executionRequest.create({
        data: {
          workspaceId: params.workspaceId,
          createdByUserId,
          agentCredentialId: actorCredentialId(actor),
          provider,
          goal,
          actorJson: jsonInput(params.actor ?? { actorKind: actor.kind }),
          contextJson: jsonInput(packetContext),
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
      await finishProducerLineage({ tx, actor, workspaceId: params.workspaceId,
        artifact: { kind: "ExecutionRequest", id: updated.id }, content: updated, receipt: requestReceipt });
      if (targetType === "CRM_COMMUNICATION" && target?.id) {
        const suggestion = await tx.crmCommunicationSuggestion.update({
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
        invariant(suggestionReceipt, 409, "UNKNOWN_LINEAGE", "CRM execution transition has no receipt.");
        await finishProducerLineage({ tx, actor, workspaceId: params.workspaceId,
          artifact: { kind: "CrmCommunicationSuggestion", id: suggestion.id }, content: suggestion, receipt: suggestionReceipt });
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

      await requireExecutionRequestProof(actor, params.workspaceId, updated, tx);
      return updated;
    });
  } catch (error) {
    if (!idempotencyKey || !isPrismaUniqueError(error)) throw error;
    const existing = await findExistingExecutionRequestByIdempotency(actor, params.workspaceId, idempotencyKey);
    invariant(existing, 409, "CONFLICT", "Execution request idempotency conflict.");
    await requireCrmPacketProof(actor, params.workspaceId, existing);
    return serializeExecutionRequest(await loadExecutionRequest(actor, params.workspaceId, existing.id));
  }

  return serializeExecutionRequest(await loadExecutionRequest(actor, params.workspaceId, request.id));
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
  sealArtifactInputActor(actor);
  params = {...params};
  requireExecutionScope(actor, "execution:read");
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  const status = params.status ? String(params.status).trim().toUpperCase() : null;
  invariant(!status || status in ExecutionRequestStatus, 400, "INVALID_INPUT", "Unsupported execution request status.");
  invariant(params.take == null || Number.isSafeInteger(params.take), 400, "INVALID_INPUT", "Invalid execution sample size.");
  const take = Math.min(Math.max(params.take ?? 20, 1), 100);
  const release = new WorkItemReadRelease(actor, params.workspaceId);
  const visible: ExecutionRequestRecord[] = [];
  const budget = createArtifactSampleBudget(take);
  let after: { id: string; createdAt: Date } | undefined;
  while (visible.length < take) {
    const pageTake = budget.nextTake();
    const requests = await prisma.executionRequest.findMany({
      where: { ...executionRequestAccessWhere(actor, params.workspaceId),
        ...(status ? { status: status as ExecutionRequestStatus } : {}),
        ...(after ? { OR: [{ createdAt: { lt: after.createdAt } }, { createdAt: after.createdAt, id: { gt: after.id } }] } : {}),
      }, include: executionRequestInclude, orderBy: [{ createdAt: "desc" }, { id: "asc" }], take: pageTake,
    });
    invariant(requests.length <= 100 && (!requests.length || requests.at(-1)!.id !== after?.id),
      503, "SOURCE_READ_SCAN_CHANGED", "Execution page changed; retry.");
    budget.consume(requests.length, pageTake);
    for (const candidate of requests) {
      let request: ExecutionRequestRecord;
      try { request = await release.observeRead(() => loadExecutionRequest(actor, params.workspaceId, candidate.id, release)); }
      catch (error) {
        if (!(error instanceof AppError) || !["UNKNOWN_LINEAGE", "SOURCE_CHANGED", "SOURCE_RESTRICTED", "NOT_FOUND"].includes(error.code)) throw error;
        continue;
      }
      // A concurrently changed status must not enter the requested sample.
      if (status && request.status !== status) continue;
      visible.push(request);
      if (visible.length === take) break;
    }
    if (requests.length < pageTake) break;
    after = requests.at(-1);
  }
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  return release.finish(visible.map(serializeExecutionRequest));
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
    packetRequest = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "ExecutionRequest" WHERE id = ${request.id} AND "workspaceId" = ${params.workspaceId} FOR UPDATE`;
      const before = await tx.executionRequest.findFirst({ where: executionRequestAccessWhere(actor, params.workspaceId, request.id) });
      invariant(before?.status === "PENDING", 409, "INVALID_STATE", "Execution packet is no longer available for claiming.");
      await requireExecutionRequestProof(actor, params.workspaceId, before, tx);
      const receipt = await prepareProducerLineage({ tx, actor, workspaceId: params.workspaceId,
        artifact: { kind: "ExecutionRequest", id: before.id }, before, allowSystemTransition: true });
      const after = await tx.executionRequest.update({ where: { id: before.id }, data: { status: "IN_PROGRESS", claimedAt: new Date() }, include: executionRequestInclude });
      await finishProducerLineage({ tx, actor, workspaceId: params.workspaceId,
        artifact: { kind: "ExecutionRequest", id: after.id }, content: after, receipt });
      return { ...after, results: request.results };
    });
  }

  await captureArtifactInputProof(actor, params.workspaceId, [{ kind: "Workspace", id: workspace.id, snapshot: workspace }]);
  await requireExecutionRequestProof(actor, params.workspaceId, packetRequest);
  const packet = buildExecutionPacket({ request: packetRequest, workspace });
  return packet;
}

function recentRows<T extends { id: string; updatedAt?: Date; recordedAt?: Date | null }>(records: T[], take: number) {
  return [...records].sort((a, b) => ((b.recordedAt ?? b.updatedAt)?.getTime() ?? 0) - ((a.recordedAt ?? a.updatedAt)?.getTime() ?? 0)
    || a.id.localeCompare(b.id)).slice(0, take);
}

async function readableExecutionMember(actor: AppActor, workspaceId: string, memberId: string | null, roots: LineageRoot[]) {
  if (!memberId) return { id: null, name: null };
  const member = await prisma.member.findFirst({ where: { id: memberId, workspaceId, isActive: true },
    include: { user: { select: { id: true, displayName: true, email: true } } } });
  if (!member?.user) return { id: null, name: null };
  try {
    roots.push(...await captureArtifactInputProof(actor, workspaceId, [
      { kind: "Member", id: member.id, snapshot: member },
      { kind: "User", id: member.user.id, snapshot: member.user },
    ]));
    return { id: member.id, name: memberName(member) };
  } catch (error) {
    if (!(error instanceof AppError) || !["UNKNOWN_LINEAGE", "SOURCE_RESTRICTED", "SOURCE_CHANGED"].includes(error.code)) throw error;
    return { id: null, name: null };
  }
}

/** Meeting.recordedAt is required in storage. Order by that same date used by
 * the response ranking so a recent sample never needs a full-history fold. */
function meetingSampleAfter(after?: { id: string; recordedAt?: Date | null }): Prisma.MeetingWhereInput {
  if (!after) return {};
  invariant(after.recordedAt instanceof Date, 409, "SOURCE_CHANGED", "Meeting ordering is unavailable.");
  return { OR: [{ recordedAt: { lt: after.recordedAt } }, { recordedAt: after.recordedAt, id: { gt: after.id } }] };
}

/** Keep only the permitted recent sample and its original receipts. Database
 * pages use the same deterministic ranking as the returned sample. */
async function recentExecutionInputs<T extends { id: string; updatedAt: Date; recordedAt?: Date | null }>(params: {
  actor: AppActor; workspaceId: string; kind: LineageKind; take: number;
  load: (after: NoInfer<T> | undefined) => Promise<T[]>;
  release: WorkItemReadRelease;
  matches?: (row: T) => boolean;
  admit?: (row: T, proof: LineageRoot[]) => Promise<LineageRoot[] | null>;
}) {
  let after: T | undefined;
  let selected: T[] = [];
  const budget = createArtifactSampleBudget(params.take);
  const proofs = new Map<string, LineageRoot[]>();
  for (;;) {
    budget.nextTake();
    const batch = await params.load(after);
    invariant(batch.length <= 100 && (!batch.length || batch.at(-1)!.id !== after?.id),
      503, "SOURCE_READ_SCAN_CHANGED", "Execution context page changed; retry.");
    budget.consume(batch.length, 100);
    const next = batch.length ? structuredClone(batch.at(-1)!) : undefined;
    const read = await params.release.observeRead(() => captureReadableDigestInputs({ ...params, records: batch.filter(row => !params.matches || params.matches(row)) }));
    for (const row of read.records) {
      const proof = params.admit ? await params.release.observeRead(() => params.admit!(row, read.proofs.get(row.id)!)) : read.proofs.get(row.id)!;
      if (!proof) continue;
      selected.push(row);
      proofs.set(row.id, proof);
    }
    selected = recentRows(selected, params.take);
    const ids = new Set(selected.map(row => row.id));
    for (const id of proofs.keys()) if (!ids.has(id)) proofs.delete(id);
    if (batch.length < 100 || selected.length === params.take) break;
    after = next;
  }
  return { records: selected, proofs };
}

export async function getCompanyContext(actor: AppActor, workspaceId: string) {
  for (const scope of ["execution:read", "workspace:read", "actions:read", "tensions:read", "proposals:read", "meetings:read", "brain:read"] as const) requireExecutionScope(actor, scope);
  await requireWorkspaceMembership({ actor, workspaceId });
  sealArtifactInputActor(actor);
  const release = new WorkItemReadRelease(actor, workspaceId);
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } });
  invariant(workspace, 404, "NOT_FOUND", "Workspace not found.");
  const roots = await release.observeRead(() => captureArtifactInputProof(actor, workspaceId, [{ kind: "Workspace", id: workspaceId, snapshot: workspace }]));
  const recentQuery = (after: { id: string; updatedAt: Date } | undefined) => ({
    where: { workspaceId, archivedAt: null, isPrivate: false,
      ...(after ? { OR: [{ updatedAt: { lt: after.updatedAt } }, { updatedAt: after.updatedAt, id: { gt: after.id } }] } : {}),
    }, orderBy: [{ updatedAt: "desc" as const }, { id: "asc" as const }], take: 100,
  });
  const read = { actor, workspaceId, take: MAX_CONTEXT_ITEMS, release };
  const [actions, tensions, proposals, meetings, articles] = await Promise.all([
    recentExecutionInputs<Action>({ ...read, kind: "Action", load: after => prisma.action.findMany(recentQuery(after)) }),
    recentExecutionInputs<Tension>({ ...read, kind: "Tension", load: after => prisma.tension.findMany(recentQuery(after)) }),
    recentExecutionInputs<Proposal>({ ...read, kind: "Proposal", load: after => prisma.proposal.findMany(recentQuery(after)) }),
    recentExecutionInputs<Meeting>({ ...read, kind: "Meeting", take: 10,
      load: after => prisma.meeting.findMany({ where: { workspaceId, archivedAt: null, ...meetingSampleAfter(after) },
        orderBy: [{ recordedAt: "desc" }, { id: "asc" }], take: 100 }) }),
    recentExecutionInputs<BrainArticle>({ ...read, kind: "BrainArticle", load: after => prisma.brainArticle.findMany(recentQuery(after)) }),
  ]);
  const select = <T extends { id: string; updatedAt?: Date; recordedAt?: Date | null }>(read: { records: T[]; proofs: Map<string, LineageRoot[]> }, take = MAX_CONTEXT_ITEMS) => {
    const rows = recentRows(read.records, take);
    for (const row of rows) roots.push(...(read.proofs.get(row.id) ?? []));
    return rows;
  };
  const mapped = await release.observeRead(async () => {
  const mappedActions = await Promise.all(select(actions).map(async (row) => {
    const assignee = await readableExecutionMember(actor, workspaceId, row.assigneeMemberId, roots);
    return { id: row.id, title: row.title, status: row.status, priority: row.priority, priorityLabel: formatWorkItemPriority(row.priority),
      dueAt: row.dueAt, updatedAt: row.updatedAt, assigneeMemberId: assignee.id, assigneeMemberName: assignee.name, assignee: assignee.name };
  }));
  const mappedTensions = await Promise.all(select(tensions).map(async (row) => {
    const [assignee, raisedBy] = await Promise.all([readableExecutionMember(actor, workspaceId, row.assigneeMemberId, roots),
      readableExecutionMember(actor, workspaceId, row.raisedByMemberId, roots)]);
    return { id: row.id, title: row.title, status: row.status, priority: row.priority, priorityLabel: formatWorkItemPriority(row.priority), updatedAt: row.updatedAt,
      assigneeMemberId: assignee.id, responsibleMemberId: assignee.id, responsibleMemberName: assignee.name, responsiblePerson: assignee.name,
      raisedByMemberId: raisedBy.id, raisedByMemberName: raisedBy.name, raisedBy: raisedBy.name };
  }));
  const mappedProposals = await Promise.all(select(proposals).map(async (row) => {
    const owner = await readableExecutionMember(actor, workspaceId, row.ownerMemberId, roots);
    return { id: row.id, title: row.title, summary: row.summary, status: row.status, priority: row.priority,
      priorityLabel: formatWorkItemPriority(row.priority), updatedAt: row.updatedAt, ownerMemberId: owner.id, ownerMemberName: owner.name, owner: owner.name };
  }));
  const mappedMeetings = select(meetings, 10).map((row) => ({ id: row.id, title: row.title, status: row.status, recordedAt: row.recordedAt, summaryMd: row.summaryMd }));
  const mappedArticles = select(articles).map((row) => ({ id: row.id, title: row.title, slug: row.slug, type: row.type, authority: row.authority, updatedAt: row.updatedAt }));
  return { actions: mappedActions, tensions: mappedTensions, proposals: mappedProposals, meetings: mappedMeetings, articles: mappedArticles };
  });
  release.add(roots);
  await requireWorkspaceMembership({ actor, workspaceId });
  return release.finish(redactJson({ workspace: { id: workspace.id, slug: workspace.slug, name: workspace.name, description: workspace.description, plan: workspace.plan },
    recent: mapped,
    policy: { externalExecution: "External AI workspaces execute; Corgtex supplies scoped context, policy constraints, audit, and reviewable write-back.", defaultWritebackMode: "draft_or_comment" } }));
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
  const query = params.query?.trim().toLocaleLowerCase() ?? "";
  const items: WritebackTargetSummary[] = [];
  sealArtifactInputActor(actor);
  const release = new WorkItemReadRelease(actor, params.workspaceId);
  const roots = await release.observeRead(() => captureArtifactInputProof(actor, params.workspaceId, [{ kind: "Workspace", id: params.workspaceId }]));
  const includeType = (type: ExecutionWritebackTargetType) => !selectedTypes || selectedTypes.has(type);
  const native = [
    ["ACTION", "Action", prisma.action, "/actions/"],
    ["TENSION", "Tension", prisma.tension, "/tensions/"],
    ["PROPOSAL", "Proposal", prisma.proposal, "/proposals/"],
    ["MEETING", "Meeting", prisma.meeting, "/meetings/"],
    ["BRAIN_ARTICLE", "BrainArticle", prisma.brainArticle, "/brain/"],
    ["BUILD_ARTIFACT", "BuildArtifact", prisma.buildArtifact, "/build-artifacts/"],
  ] as const;
  for (const [type, kind, delegate, path] of native) {
    if (!includeType(type)) continue;
    requireExecutionScope(actor, targetReadScope(type));
    const where = type === "BUILD_ARTIFACT" ? { workspaceId: params.workspaceId, NOT: OPERATIONAL_ARTIFACT_FILTER }
      : type === "BRAIN_ARTICLE" ? { AND: [{ workspaceId: params.workspaceId, archivedAt: null }, { OR: brainArticlePrivacyFilter(actor, membership) }] }
      : { workspaceId: params.workspaceId, archivedAt: null, ...(["ACTION", "TENSION", "PROPOSAL"].includes(type) ? privacyFilter(actor, membership) : {}) };
    type TargetRow = { id: string; title: string | null; status?: string; authority?: string; slug?: string; updatedAt: Date; recordedAt?: Date | null };
    const readable = await recentExecutionInputs<TargetRow>({ actor, workspaceId: params.workspaceId, kind, take, release,
      matches: row => !query || Boolean(row.title?.toLocaleLowerCase().includes(query)),
      load: after => (delegate.findMany as (args: unknown) => Promise<TargetRow[]>)({
        where: after ? { AND: [where, type === "MEETING" ? meetingSampleAfter(after)
          : { OR: [{ updatedAt: { lt: after.updatedAt } }, { updatedAt: after.updatedAt, id: { gt: after.id } }] }] } : where,
        orderBy: type === "MEETING" ? [{ recordedAt: "desc" }, { id: "asc" }] : [{ updatedAt: "desc" }, { id: "asc" }], take: 100,
      }),
    });
    const records = readable.records;
    for (const row of records) roots.push(...(readable.proofs.get(row.id) ?? []));
    items.push(...records.map((row) => ({ type, id: row.id, title: row.title ?? "Untitled meeting", status: row.status ?? row.authority ?? null, webPath: `${path}${type === "BRAIN_ARTICLE" ? row.slug : row.id}` })));
  }
  if (includeType("CRM_COMMUNICATION")) {
    requireExecutionScope(actor, "relationships:read");
    const readable = await recentExecutionInputs<CrmCommunicationSuggestion>({ actor, workspaceId: params.workspaceId, kind: "CrmCommunicationSuggestion", take, release,
      load: after => prisma.crmCommunicationSuggestion.findMany({
        where: { workspaceId: params.workspaceId, ...activeCrmParentWhere(["account", "contact", "deal", "activity"]),
          ...(after ? { OR: [{ updatedAt: { lt: after.updatedAt } }, { updatedAt: after.updatedAt, id: { gt: after.id } }] } : {}) },
        orderBy: [{ updatedAt: "desc" }, { id: "asc" }], take: 100,
      }),
      matches: row => !query || [row.title, row.subject, row.recipientEmail, row.recipientName].some(value => value?.toLocaleLowerCase().includes(query)),
      admit: async (row, proof) => {
        if (!await isArtifactInputProofPubliclyShareable(actor, params.workspaceId, proof)) return null;
        // Only sampled suggestions retain their independently admitted affiliation.
        if (row.accountId) {
          try { return [...proof, ...await captureArtifactInputProof(actor, params.workspaceId, [{ kind: "CrmAccount", id: row.accountId }])]; }
          catch (error) {
            if (!(error instanceof AppError) || !["UNKNOWN_LINEAGE", "SOURCE_CHANGED", "SOURCE_RESTRICTED"].includes(error.code)) throw error;
            return null;
          }
        }
        return proof;
      },
    });
    const sampled = readable.records;
    for (const row of sampled) roots.push(...(readable.proofs.get(row.id) ?? []));
    items.push(...sampled.map((row) => ({ type: "CRM_COMMUNICATION" as const, id: row.id,
      title: row.subject ?? row.title, status: row.status, webPath: row.accountId ? `/leads/accounts/${row.accountId}?view=review` : "/leads?view=review" })));
  }
  if (includeType("COMMENT")) {
    roots.push(...await captureArtifactInputProof(actor, params.workspaceId, [{ kind: "Workspace", id: params.workspaceId }]));
    items.push({ type: "COMMENT", id: null, title: "Comment on execution request", status: null, webPath: "" });
  }
  release.add(roots);
  return release.finish({ items: items.slice(0, take * 6) });
}

async function validateCrmCommunicationResultOutput(actor: AppActor, workspaceId: string, targetId: string | null, output: JsonRecord,
  client: Prisma.TransactionClient | typeof prisma = prisma) {
  invariant(targetId, 400, "INVALID_INPUT", "CRM communication result target id is required.");
  optionalDate(output.sentAt);

  const conversationId = optionalString(output.conversationId);
  if (conversationId) {
    const conversation = await client.crmConversation.findFirst({
      where: { id: conversationId, workspaceId, ...activeCrmParentWhere(["account", "contact", "deal"]) },
    });
    invariant(conversation, 404, "NOT_FOUND", "CRM conversation write-back target not found.");
    return captureArtifactInputProof(actor, workspaceId, [{ kind: "CrmConversation", id: conversation.id, snapshot: conversation }], client);
  }
  return [];
}

async function createCrmCommunicationWriteback(actor: AppActor, params: {
  workspaceId: string;
  targetId: string;
  output: JsonRecord;
  errorMessage: string | null;
  lineageRoots?: LineageRoot[];
  transaction?: Prisma.TransactionClient;
}) {
  const writebackActor = actor;
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
      lineageRoots: params.lineageRoots,
    }, params.transaction);
    return { entityType: "CrmCommunicationSuggestion", entityId: suggestion?.id ?? params.targetId };
  }

  const suggestion = await markCommunicationSuggestionSent(writebackActor, {
    workspaceId: params.workspaceId,
    suggestionId: params.targetId,
    sentAt: optionalDate(params.output.sentAt),
    lineageRoots: params.lineageRoots,
  }, params.transaction);

  if (conversationId) {
    await createConversationMessage(writebackActor, {
      workspaceId: params.workspaceId,
      conversationId,
      senderType: actor.kind === "user" ? "ADMIN" : "SYSTEM",
      lineageRoots: params.lineageRoots, copied: true,
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
  lineageRoots?: LineageRoot[];
  transaction?: Prisma.TransactionClient;
}) {
  if (params.type === "CRM_COMMUNICATION") {
    invariant(params.targetId, 400, "INVALID_INPUT", "CRM communication write-back target id is required.");
    return createCrmCommunicationWriteback(actor, {
      workspaceId: params.workspaceId,
      targetId: params.targetId,
      output: params.output,
      errorMessage: null,
      lineageRoots: params.lineageRoots, transaction: params.transaction,
    });
  }
  if (params.targetId || params.type === "COMMENT") {
    return { entityType: "ExecutionResult", entityId: params.resultId };
  }
  const writebackActor = actor;

  switch (params.type) {
    case "ACTION": {
      const action = await createAction(writebackActor, {
        workspaceId: params.workspaceId,
        title: requiredString(params.output.title, "Action title"),
        bodyMd: optionalString(params.output.bodyMd) ?? optionalString(params.output.body) ?? null,
        isPrivate: true,
        lineageRoots: params.lineageRoots,
        source: { type: "EXECUTION_RESULT", id: params.resultId },
        _tx: params.transaction,
        _membership: await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId, tx: params.transaction }),
      });
      return { entityType: "Action", entityId: action.id };
    }
    case "TENSION": {
      const tension = await createTension(writebackActor, {
        workspaceId: params.workspaceId,
        title: requiredString(params.output.title, "Tension title"),
        bodyMd: optionalString(params.output.bodyMd) ?? optionalString(params.output.body) ?? null,
        isPrivate: true,
        lineageRoots: params.lineageRoots,
      }, params.transaction);
      return { entityType: "Tension", entityId: tension.id };
    }
    case "PROPOSAL": {
      const proposal = await createProposal(writebackActor, {
        workspaceId: params.workspaceId,
        title: requiredString(params.output.title, "Proposal title"),
        summary: optionalString(params.output.summary),
        bodyMd: requiredString(params.output.bodyMd ?? params.output.body, "Proposal body"),
        isPrivate: true,
        lineageRoots: params.lineageRoots,
        includeAiSummary: false,
      }, params.transaction);
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
        lineageRoots: params.lineageRoots,
        copied: true, tx: params.transaction,
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
        completeInputRoots: params.lineageRoots,
        tx: params.transaction,
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
        copied: true,
        lineageRoots: params.lineageRoots,
        tx: params.transaction,
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

/** The settled target/comment path creates only a private Result and fixed
 * Request lifecycle fields. It consumes no intermediate Result body or native
 * target body for a writeback; every actual input is preserved before mutation. */
async function submitSettledExecutionResult(params: {
  actor: AppActor; workspaceId: string; request: ExecutionRequest; originals: LineageRoot[];
  idempotencyKey: string; targetType: ExecutionWritebackTargetType | null; targetId: string | null;
  output: unknown; artifacts: unknown; errorMessage: string | null;
}): Promise<ExecutionResult> {
  const { actor, workspaceId, request: original, originals, idempotencyKey } = params;
  const resultId = randomUUID();
  const submittedAt = new Date();
  const ownerBinding: SourceCommitOwnerBinding = { kind: "HUMAN_REQUEST", id: original.id,
    generation: original.createdAt.getTime(), resultId, idempotencyKey };
  const closure = await inspectStoredArtifactInputDependencies(prisma, workspaceId, originals);
  invariant(closure.complete, 409, "UNKNOWN_LINEAGE", "Execution input closure cannot be preserved.");
  const allocations: ArtifactInputSnapshotAllocation[] = [];
  const snapshotTargets: SourceCommitWriteTarget[] = [];
  const seen = new Set<string>();
  for (const input of closure.roots) {
    const key = JSON.stringify([input.kind, input.id, input.fingerprint]);
    if (seen.has(key)) continue;
    seen.add(key);
    let sourceKind: string = input.kind;
    let sourceId = input.id;
    let sourceFingerprint = input.fingerprint;
    if (input.kind === "ArtifactInputSnapshot") {
      const saved = await prisma.artifactInputSnapshot.findFirst({ where: { id: input.id, workspaceId },
        select: { sourceKind: true, sourceId: true, sourceFingerprint: true } });
      invariant(saved, 409, "SOURCE_CHANGED", "Execution input history is unavailable.");
      sourceKind = saved.sourceKind; sourceId = saved.sourceId; sourceFingerprint = saved.sourceFingerprint;
    }
    const id = randomUUID();
    allocations.push({ input, id });
    snapshotTargets.push({ kind: "ArtifactInputSnapshot", id, snapshotInput: input,
      projectedAuthority: { sourceKind, sourceId, sourceFingerprint } });
  }
  let published = false;
  // This callback attests native retained request controls, never source grants,
  // membership or semantic input bodies before the source union is held.
  const assertOwner = async (tx: Prisma.TransactionClient, binding: SourceCommitOwnerBinding) => {
    invariant(binding.kind === "HUMAN_REQUEST" && binding.id === original.id && binding.generation === ownerBinding.generation
      && binding.resultId === resultId && binding.idempotencyKey === idempotencyKey,
    409, "SOURCE_OWNER_UNAVAILABLE", "Execution request owner binding changed.");
    const [control] = await tx.$queryRaw<Array<Pick<ExecutionRequest,
      "id" | "workspaceId" | "createdByUserId" | "agentCredentialId" | "status" | "createdAt">>>`
      SELECT "id", "workspaceId", "createdByUserId", "agentCredentialId", "status", "createdAt"
      FROM "ExecutionRequest" WHERE "id" = ${original.id} AND "workspaceId" = ${workspaceId} FOR UPDATE`;
    invariant(control && control.createdAt.getTime() === binding.generation
      && (actor.kind === "user" ? control.createdByUserId === actor.user.id
        : actor.authProvider === "credential" && control.agentCredentialId === actor.credentialId),
    409, "SOURCE_OWNER_UNAVAILABLE", "Execution request ownership changed.");
    const existing = await tx.executionResult.findFirst({ where: { executionRequestId: original.id },
      select: { id: true, idempotencyKey: true, status: true, submittedByUserId: true, agentCredentialId: true } });
    if (!published) invariant(["PENDING", "IN_PROGRESS"].includes(control.status) && control.status === original.status && !existing,
      409, "CONFLICT", "Execution request is no longer available for this result.");
    else invariant(control.status === (params.errorMessage ? "FAILED" : "COMPLETED") && existing?.id === resultId
      && existing.idempotencyKey === idempotencyKey && existing.status === (params.errorMessage ? "REJECTED" : "ACCEPTED")
      && (actor.kind === "user" ? existing.submittedByUserId === actor.user.id : existing.agentCredentialId === actorCredentialId(actor)),
    409, "SOURCE_OWNER_UNAVAILABLE", "Execution result lifecycle ownership changed.");
  };
  const preparationOptions = { ownerBinding, writeTargets: snapshotTargets };
  const preparation = await prepareArtifactSourceCommit(actor, workspaceId, originals, preparationOptions);
  const inputRoots = await prisma.$transaction(tx => withArtifactSourceCommit(actor, workspaceId, tx, originals,
    preparationOptions, preparation, assertOwner, () => withArtifactInputSnapshotAllocations(actor, workspaceId, tx, allocations, async () => {
      await assertArtifactInputWriteFence(tx);
      await requireWorkspaceMembership({ actor, workspaceId, tx });
      const frozen = await captureImmutableArtifactInputProof(actor, workspaceId, originals, tx);
      await assertArtifactInputWriteFence(tx);
      return frozen;
    })), { maxWait: 5_000, timeout: 120_000 });
  const terminalRequestStatus = params.errorMessage ? "FAILED" : "COMPLETED";
  const terminalResultStatus = params.errorMessage ? "REJECTED" : "ACCEPTED";
  const writeTargets: SourceCommitWriteTarget[] = [...snapshotTargets,
    { kind: "ExecutionRequest", id: original.id, projectedAuthority: { status: terminalRequestStatus } },
    { kind: "ExecutionResult", id: resultId, projectedAuthority: { executionRequestId: original.id,
      submittedByUserId: actor.kind === "user" ? actor.user.id : null, agentCredentialId: actorCredentialId(actor),
      status: terminalResultStatus, targetId: params.targetId } }];
  const publicationOptions = { ownerBinding, writeTargets };
  const publication = await prepareArtifactSourceCommit(actor, workspaceId, inputRoots, publicationOptions);
  return prisma.$transaction(tx => withArtifactSourceCommit(actor, workspaceId, tx, inputRoots,
    publicationOptions, publication, assertOwner, () => withArtifactInputSnapshotAllocations(actor, workspaceId, tx, allocations, async () => {
      await assertArtifactInputWriteFence(tx);
      await requireWorkspaceMembership({ actor, workspaceId, tx });
      invariant(await isArtifactInputProofReadable(actor, workspaceId, originals, tx),
        409, "SOURCE_CHANGED", "Execution inputs changed between preservation and publication.");
      const before = await tx.executionRequest.findUnique({ where: { id: original.id } });
      invariant(before && lineageContentFingerprint("ExecutionRequest", before) === lineageContentFingerprint("ExecutionRequest", original),
        409, "SOURCE_CHANGED", "Execution request changed before publication.");
      // A complete deterministic copy carries the unchanged old Request body and
      // the actual submitted inputs through lifecycle changes without self cycles.
      const requestReceipt = await prepareProducerLineage({ tx, actor, workspaceId,
        artifact: { kind: "ExecutionRequest", id: original.id }, copied: true, completeCopy: true,
        capture: { lineageInputs: [], lineageRoots: inputRoots } });
      invariant(requestReceipt.mode === "DERIVED", 409, "UNKNOWN_LINEAGE", "Execution request inputs cannot be proven.");
      const claim = await tx.executionRequest.updateMany({ where: { id: original.id, workspaceId,
        status: original.status }, data: { status: "RESULT_SUBMITTED" } });
      invariant(claim.count === 1, 409, "CONFLICT", "Execution request is no longer available for this result.");
      const submitted = await tx.executionRequest.findUniqueOrThrow({ where: { id: original.id } });
      await finishProducerLineage({ tx, actor, workspaceId, artifact: { kind: "ExecutionRequest", id: original.id },
        content: submitted, receipt: requestReceipt });
      const resultReceipt = await prepareProducerLineage({ tx, actor, workspaceId, copied: true, completeCopy: true,
        capture: { lineageInputs: [], lineageRoots: inputRoots } });
      invariant(resultReceipt.mode === "DERIVED", 409, "UNKNOWN_LINEAGE", "Execution result inputs cannot be proven.");
      const result = await tx.executionResult.create({ data: { id: resultId, workspaceId, executionRequestId: original.id,
        submittedByUserId: actor.kind === "user" ? actor.user.id : null, agentCredentialId: actorCredentialId(actor),
        status: terminalResultStatus, idempotencyKey, targetType: params.targetType, targetId: params.targetId,
        outputJson: jsonInput(params.output ?? null), artifactJson: jsonInput(params.artifacts ?? null), errorMessage: params.errorMessage,
        writebackEntityType: params.errorMessage ? null : "ExecutionResult", writebackEntityId: params.errorMessage ? null : resultId,
        submittedAt, acceptedAt: params.errorMessage ? null : submittedAt, rejectedAt: params.errorMessage ? submittedAt : null } });
      await finishProducerLineage({ tx, actor, workspaceId, artifact: { kind: "ExecutionResult", id: resultId }, content: result, receipt: resultReceipt });
      const completedRequest = await tx.executionRequest.update({ where: { id: original.id }, data: {
        status: terminalRequestStatus, completedAt: params.errorMessage ? null : submittedAt, failedAt: params.errorMessage ? submittedAt : null } });
      await finishProducerLineage({ tx, actor, workspaceId, artifact: { kind: "ExecutionRequest", id: original.id },
        content: completedRequest, receipt: requestReceipt });
      invariant((await readableArtifactIds(actor, workspaceId, "ExecutionResult", [result], tx)).has(result.id),
        409, "SOURCE_CHANGED", "Execution result inputs changed before acceptance.");
      await recordAudit(tx, actor, { workspaceId, action: "execution_result.submitted", entityType: "ExecutionRequest", entityId: original.id,
        meta: { resultId, targetType: params.targetType, targetId: params.targetId, status: result.status,
          writebackEntityType: result.writebackEntityType, writebackEntityId: result.writebackEntityId } });
      await assertArtifactInputWriteFence(tx);
      published = true;
      return result;
    })), { maxWait: 5_000, timeout: 120_000 });
}

export async function submitExecutionResult(actor: AppActor, params: SubmitExecutionResultParams) {
  sealArtifactInputActor(actor);
  params = { ...params, output: structuredClone(params.output), artifacts: structuredClone(params.artifacts),
    lineageRoots: structuredClone(params.lineageRoots ?? []), lineageInputs: structuredClone(params.lineageInputs ?? []) };
  const submissionRoots = getMcpToolInputRoots(actor, params.workspaceId);
  requireExecutionScope(actor, "execution:write");
  const membership = await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  const idempotencyKey = params.idempotencyKey.trim();
  invariant(idempotencyKey.length > 0, 400, "INVALID_INPUT", "Result idempotency key is required.");
  const output = objectInput(params.output);
  const errorMessage = optionalString(params.errorMessage);
  const accessWhere = { ...executionRequestAccessWhere(actor, params.workspaceId, params.requestId),
    ...(actor.kind === "user" ? { createdByUserId: actor.user.id } : {}) };
  const original = await prisma.executionRequest.findFirst({ where: accessWhere });
  invariant(original && (actor.kind === "user" ? original.createdByUserId === actor.user.id
    : actor.authProvider === "credential" && original.agentCredentialId === actor.credentialId),
  404, "NOT_FOUND", "Execution request not found.");
  // Resolve a concurrent same-key winner from locked lifecycle metadata only.
  // The retained payload is redeemed with its current complete proof after this
  // control transaction has released its locks and native SDK calls are safe.
  const reconcileCommittedResult = async () => {
    const resultId = await prisma.$transaction(async tx => {
      await lockArtifactReadAuthorityRows(actor, params.workspaceId, tx);
      const [current] = await tx.$queryRaw<Array<Pick<ExecutionRequest,
        "id" | "workspaceId" | "createdByUserId" | "agentCredentialId" | "status">>>`
        SELECT "id", "workspaceId", "createdByUserId", "agentCredentialId", "status"
        FROM "ExecutionRequest" WHERE "id" = ${original.id} AND "workspaceId" = ${params.workspaceId} FOR UPDATE`;
      await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId, tx });
      if (!current || !(actor.kind === "user" ? current.createdByUserId === actor.user.id
        : actor.authProvider === "credential" && current.agentCredentialId === actor.credentialId)
        || !["COMPLETED", "FAILED"].includes(current.status)) return null;
      const retained = await tx.executionResult.findUnique({ where: { executionRequestId_idempotencyKey: {
        executionRequestId: current.id, idempotencyKey,
      } }, select: { id: true, status: true } });
      return retained && ["ACCEPTED", "REJECTED"].includes(retained.status) ? retained.id : null;
    });
    if (!resultId) return null;
    const currentRequest = await prisma.executionRequest.findFirst({ where: accessWhere });
    invariant(currentRequest, 404, "NOT_FOUND", "Execution request not found.");
    await requireExecutionRequestProof(actor, params.workspaceId, currentRequest);
    const retained = await prisma.executionResult.findUnique({ where: { id: resultId } });
    invariant(retained && retained.executionRequestId === original.id && retained.idempotencyKey === idempotencyKey
      && ["ACCEPTED", "REJECTED"].includes(retained.status), 409, "CONFLICT", "Execution result is no longer complete.");
    invariant((await readableArtifactIds(actor, params.workspaceId, "ExecutionResult", [retained])).has(retained.id),
      404, "NOT_FOUND", "Execution result not found.");
    await requireExecutionRequestProof(actor, params.workspaceId, currentRequest);
    return serializeIdempotentExecutionResult(retained);
  };
  try {
    await requireExecutionRequestProof(actor, params.workspaceId, original);
    if (!["PENDING", "IN_PROGRESS"].includes(original.status)) {
      // A retry consumes the retained result, never the newly supplied body. All
      // provider/source redemption stays outside a database write transaction.
      const existing = await prisma.executionResult.findUnique({ where: { executionRequestId_idempotencyKey: {
        executionRequestId: original.id, idempotencyKey,
      } } });
      invariant(["COMPLETED", "FAILED"].includes(original.status) && existing && ["ACCEPTED", "REJECTED"].includes(existing.status),
        409, "CONFLICT", "Execution request already has a different or incomplete result.");
      invariant((await readableArtifactIds(actor, params.workspaceId, "ExecutionResult", [existing])).has(existing.id),
        404, "NOT_FOUND", "Execution result not found.");
      await requireExecutionRequestProof(actor, params.workspaceId, original);
      return serializeIdempotentExecutionResult(existing);
    }
    const submittedRoots = [...(params.lineageRoots ?? []), ...submissionRoots,
      ...await captureArtifactInputProof(actor, params.workspaceId, params.lineageInputs ?? [])];
    invariant(submittedRoots.length, 409, "UNKNOWN_LINEAGE", "External results require their actual submitted input receipt.");
    const targetType = normalizeExecutionTargetType(params.targetType) ?? original.writebackTargetType;
    const targetId = optionalString(params.targetId) ?? original.writebackTargetId;
    if (original.writebackTargetType) invariant(targetType === original.writebackTargetType, 400, "INVALID_INPUT", "Result target type does not match the execution request.");
    if (original.writebackTargetId) invariant(targetId === original.writebackTargetId, 400, "INVALID_INPUT", "Result target id does not match the execution request.");
    let targetRoots: LineageRoot[] = [];
    let target: WritebackTargetSummary | null = null;
    if (targetType === "CRM_COMMUNICATION" || !errorMessage) {
      invariant(targetType, 400, "INVALID_INPUT", "Result target type is required.");
      const writeScope = targetWriteScope(targetType);
      requireExecutionScope(actor, writeScope);
      invariant(original.allowedScopes.includes(writeScope), 403, "FORBIDDEN", `Execution request does not allow the required scope: ${writeScope}.`);
      target = await validateWritebackTarget(params.workspaceId, targetType, targetId, actor, membership);
      targetRoots = target?.lineageRoots ?? [];
      if (targetType === "CRM_COMMUNICATION") targetRoots.push(...await validateCrmCommunicationResultOutput(actor, params.workspaceId, targetId, output));
      else validateNativeWritebackOutput(targetType, targetId ?? null, output);
    }
    const conversationId = targetType === "CRM_COMMUNICATION" ? optionalString(output.conversationId) : null;
    const conversation = conversationId ? await prisma.crmConversation.findFirst({ where: {
      id: conversationId, workspaceId: params.workspaceId, ...activeCrmParentWhere(["account", "contact", "deal"]),
    } }) : null;
    invariant(!conversationId || conversation, 404, "NOT_FOUND", "CRM conversation write-back target not found.");
    const originals = [...submittedRoots, ...await captureArtifactInputProof(actor, params.workspaceId,
      [{ kind: "ExecutionRequest", id: original.id, snapshot: original }]), ...targetRoots];
    if (targetType !== "CRM_COMMUNICATION" && (Boolean(targetId) || targetType === "COMMENT")) {
      const result = await submitSettledExecutionResult({ actor, workspaceId: params.workspaceId, request: original, originals,
        idempotencyKey, targetType, targetId: targetId ?? null, output: params.output, artifacts: params.artifacts, errorMessage });
      invariant((await readableArtifactIds(actor, params.workspaceId, "ExecutionResult", [result])).has(result.id),
        404, "NOT_FOUND", "Execution result not found.");
      return serializeIdempotentExecutionResult(result);
    }
    const lockAndVerify = async (tx: Prisma.TransactionClient) => {
      await assertArtifactInputWriteFence(tx);
      await lockArtifactReadAuthorityRows(actor, params.workspaceId, tx);
      const [before] = await tx.$queryRaw<ExecutionRequest[]>`SELECT * FROM "ExecutionRequest" WHERE id = ${params.requestId} AND "workspaceId" = ${params.workspaceId} FOR UPDATE`;
      invariant(before && lineageContentFingerprint("ExecutionRequest", before) === lineageContentFingerprint("ExecutionRequest", original),
        409, "SOURCE_CHANGED", "Execution request changed before result publication.");
      await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId, tx });
      return before;
    };
    const lockSemanticTargets = async (tx: Prisma.TransactionClient) => {
      if (targetType === "CRM_COMMUNICATION" && targetId) {
        await lockActiveCommunicationSuggestion(tx, { workspaceId: params.workspaceId, suggestionId: targetId,
          expectedLinks: target?.crmLinks, replacements: conversation ?? {} });
        if (conversationId) await tx.$queryRaw`SELECT id FROM "CrmConversation" WHERE id = ${conversationId} AND "workspaceId" = ${params.workspaceId} FOR UPDATE`;
      }
    };
    const preparation = await prepareArtifactCommitPreflight(actor, params.workspaceId, originals);
    const inputRoots = await prisma.$transaction(async tx => {
      await lockAndVerify(tx);
      return withArtifactCommitPreflight(actor, params.workspaceId, tx, originals, preparation, async () => {
        const frozen = await captureImmutableArtifactInputProof(actor, params.workspaceId, originals, tx);
        await assertArtifactInputWriteFence(tx);
        return frozen;
      }, { beforeSourceEpochs: () => lockSemanticTargets(tx) });
    }, { maxWait: 5_000, timeout: 120_000 });
    const publication = await prepareArtifactCommitPreflight(actor, params.workspaceId, inputRoots);
    const result = await prisma.$transaction(async tx => {
      const before = await lockAndVerify(tx);
      return withArtifactCommitPreflight(actor, params.workspaceId, tx, inputRoots, publication, async () => {
        invariant(await isArtifactInputProofReadable(actor, params.workspaceId, originals, tx),
          409, "SOURCE_CHANGED", "Execution inputs changed between preparation and publication.");
        await requireExecutionRequestProof(actor, params.workspaceId, before, tx);
        const requestReceipt = await prepareProducerLineage({ tx, actor, workspaceId: params.workspaceId,
          artifact: { kind: "ExecutionRequest", id: before.id }, before, allowSystemTransition: true });
        if (requestReceipt.mode === "DERIVED") requestReceipt.roots = await captureImmutableArtifactInputProof(actor, params.workspaceId, requestReceipt.roots, tx);
        const claim = await tx.executionRequest.updateMany({ where: { ...executionRequestAccessWhere(actor, params.workspaceId, before.id),
          status: { in: ["PENDING", "IN_PROGRESS"] } }, data: { status: "RESULT_SUBMITTED" } });
        invariant(claim.count === 1, 409, "CONFLICT", "Execution request is no longer available for a result.");
        const request = await tx.executionRequest.findFirst({ where: executionRequestAccessWhere(actor, params.workspaceId, before.id) });
        invariant(request, 404, "NOT_FOUND", "Execution request not found.");
        await finishProducerLineage({ tx, actor, workspaceId: params.workspaceId,
          artifact: { kind: "ExecutionRequest", id: request.id }, content: request, receipt: requestReceipt });
        const resultReceipt = await prepareProducerLineage({ tx, actor, workspaceId: params.workspaceId, copied: true,
          capture: { lineageInputs: [], lineageRoots: inputRoots } });
        invariant(resultReceipt.mode !== "UNKNOWN", 409, "UNKNOWN_LINEAGE", "External result inputs cannot be proven.");
        const created = await tx.executionResult.create({ data: {
          workspaceId: params.workspaceId, executionRequestId: request.id,
          submittedByUserId: actor.kind === "user" ? actor.user.id : null, agentCredentialId: actorCredentialId(actor),
          status: "SUBMITTED", idempotencyKey, targetType, targetId: targetId ?? null,
          outputJson: jsonInput(params.output ?? null), artifactJson: jsonInput(params.artifacts ?? null), errorMessage,
          writebackEntityType: null, writebackEntityId: null, acceptedAt: null, rejectedAt: null,
        } });
        await finishProducerLineage({ tx, actor, workspaceId: params.workspaceId,
          artifact: { kind: "ExecutionResult", id: created.id }, content: created, receipt: resultReceipt });
        const writebackRoots = await captureImmutableArtifactInputProof(actor, params.workspaceId,
          await captureArtifactInputProof(actor, params.workspaceId, [{ kind: "ExecutionResult", id: created.id, snapshot: created }], tx), tx);
        const writeback = targetType === "CRM_COMMUNICATION" && targetId
          ? await createCrmCommunicationWriteback(actor, { workspaceId: params.workspaceId, targetId, output, errorMessage,
            lineageRoots: writebackRoots, transaction: tx })
          : !errorMessage && targetType ? await createNativeWriteback(actor, { workspaceId: params.workspaceId, type: targetType,
            targetId: targetId ?? null, output, requestId: request.id, resultId: created.id,
            lineageRoots: writebackRoots, transaction: tx }) : null;
        const finalResultReceipt = await prepareProducerLineage({ tx, actor, workspaceId: params.workspaceId,
          artifact: { kind: "ExecutionResult", id: created.id }, before: created, allowSystemTransition: true });
        const finalRequestReceipt = await prepareProducerLineage({ tx, actor, workspaceId: params.workspaceId,
          artifact: { kind: "ExecutionRequest", id: request.id }, before: request, allowSystemTransition: true });
        if (finalResultReceipt.mode === "DERIVED") finalResultReceipt.roots = await captureImmutableArtifactInputProof(actor, params.workspaceId, finalResultReceipt.roots, tx);
        if (finalRequestReceipt.mode === "DERIVED") finalRequestReceipt.roots = await captureImmutableArtifactInputProof(actor, params.workspaceId, finalRequestReceipt.roots, tx);
        const finalizedAt = new Date();
        const completed = await tx.executionResult.update({ where: { id: created.id }, data: {
          status: errorMessage ? "REJECTED" : "ACCEPTED", writebackEntityType: writeback?.entityType ?? null,
          writebackEntityId: writeback?.entityId ?? null, acceptedAt: errorMessage ? null : finalizedAt, rejectedAt: errorMessage ? finalizedAt : null,
        } });
        await finishProducerLineage({ tx, actor, workspaceId: params.workspaceId,
          artifact: { kind: "ExecutionResult", id: completed.id }, content: completed, receipt: finalResultReceipt });
        const completedRequest = await tx.executionRequest.update({ where: { id: request.id }, data: {
          status: errorMessage ? "FAILED" : "COMPLETED", completedAt: errorMessage ? null : finalizedAt, failedAt: errorMessage ? finalizedAt : null,
        } });
        await finishProducerLineage({ tx, actor, workspaceId: params.workspaceId,
          artifact: { kind: "ExecutionRequest", id: completedRequest.id }, content: completedRequest, receipt: finalRequestReceipt });
        invariant((await readableArtifactIds(actor, params.workspaceId, "ExecutionResult", [completed], tx)).has(completed.id),
          409, "SOURCE_CHANGED", "Execution result inputs changed before acceptance.");
        await recordAudit(tx, actor, { workspaceId: params.workspaceId, action: "execution_result.submitted", entityType: "ExecutionRequest", entityId: request.id,
          meta: { resultId: completed.id, targetType, targetId, status: completed.status, writebackEntityType: completed.writebackEntityType, writebackEntityId: completed.writebackEntityId } });
        await assertArtifactInputWriteFence(tx);
        await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId, tx });
        return completed;
      }, { beforeSourceEpochs: () => lockSemanticTargets(tx) });
    }, { maxWait: 5_000, timeout: 120_000 });
    invariant((await readableArtifactIds(actor, params.workspaceId, "ExecutionResult", [result])).has(result.id),
      404, "NOT_FOUND", "Execution result not found.");
    return serializeIdempotentExecutionResult(result);
  } catch (error) {
    if (error instanceof AppError && ["SOURCE_CHANGED", "PERMISSION_CHANGED", "UNKNOWN_LINEAGE", "CONFLICT"].includes(error.code)) {
      const committed = await reconcileCommittedResult();
      if (committed) return committed;
    }
    throw error;
  }
}
