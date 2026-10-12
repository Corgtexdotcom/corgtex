import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { Prisma } from "@prisma/client";
import { prisma, type AppActor } from "@corgtex/shared";
import { requireWorkspaceMembership } from "./auth";
import { resolveKnowledgeAccessDomains } from "./brain-access";
import { brainSourceContentFingerprint } from "./brain-derivation";
import { invariant } from "./errors";

type ArtifactReadCapture = { actor: AppActor; workspaceId: string; roots: Map<string, LineageRoot> };
const artifactReadCapture = new AsyncLocalStorage<ArtifactReadCapture>();

function observeArtifactRead(actor: AppActor, workspaceId: string, roots: readonly LineageRoot[]) {
  const scope = artifactReadCapture.getStore();
  if (!scope || scope.actor !== actor || scope.workspaceId !== workspaceId) return;
  for (const root of roots) {
    const key = `${root.kind}:${root.id}`;
    const prior = scope.roots.get(key);
    invariant(!prior || prior.fingerprint === root.fingerprint, 409, "SOURCE_CHANGED", "Read inputs changed during collection.");
    scope.roots.set(key, root);
  }
}

/** For audited server readers: collect proofs at their permission gates, before formatting their output. */
export async function withArtifactInputReadCapture<T>(actor: AppActor, workspaceId: string, read: () => Promise<T>, options?: { preserveConsumedRevisions?: boolean }) {
  const scope: ArtifactReadCapture = { actor, workspaceId, roots: new Map() };
  const result = await artifactReadCapture.run(scope, async () => {
    const value = await read();
    const captured = [...scope.roots.values()];
    const roots = options?.preserveConsumedRevisions ? await rebaseArtifactInputProofToSnapshots(actor, workspaceId, captured) : captured;
    invariant(roots.length > 0 && await isArtifactInputProofReadable(actor, workspaceId, roots),
      409, "UNKNOWN_LINEAGE", "Read output has no complete current input proof.");
    return { value, roots };
  });
  observeArtifactRead(actor, workspaceId, result.roots);
  return result;
}

export type ArtifactInputWriteFence = (tx: Prisma.TransactionClient) => Promise<void>;
const artifactInputWriteFence = new AsyncLocalStorage<ArtifactInputWriteFence>();
/** Worker-owned execution supplies its atomic lease/checkpoint guard here; never serialized or model supplied. */
export function withArtifactInputWriteFence<T>(fence: ArtifactInputWriteFence | undefined, work: () => Promise<T>) {
  return fence ? artifactInputWriteFence.run(fence, work) : work();
}
export async function assertArtifactInputWriteFence(tx: Prisma.TransactionClient) {
  await artifactInputWriteFence.getStore()?.(tx);
}

export type LineageKind =
  | "AgentRequestInput" | "AgentFeedbackInput" | "ConversationPendingOperation" | "BrainDiscussionThread" | "BrainDiscussionComment"
  | "AgentRun" | "AgentStep" | "AgentToolCall"
  | "Workspace" | "Member" | "User" | "AgentIdentity" | "CircleAgentAssignment" | "Role" | "Circle" | "RoleAssignment" | "RoleVersion" | "RoleHolderHistory"
  | "BrainSource" | "BrainArticle" | "BrainArticleVersion" | "Document" | "Meeting" | "MeetingTranscript"
  | "MeetingInsight" | "MeetingSeries" | "MeetingAgenda" | "DeliberationEntry" | "KnowledgeChunk"
  | "MeetingFollowUpReview"
  | "Action" | "ActionChecklistItem" | "Tension" | "TensionUpvote" | "Recognition" | "GoalUpdate" | "KeyResult"
  | "CommunicationExternalUser" | "CommunicationEntityLink" | "CommunicationChannel" | "CommunicationMessage" | "CommunicationContextSummary" | "BuildArtifact" | "BuildArtifactAsset"
  | "AgentMemory" | "ConversationPromptInput" | "AdviceRequest" | "ConversationSession" | "ConversationTurn" | "RoleOnboardingSession" | "PolicyCorpus" | "Notification"
  | "CrmAccount" | "CrmContact" | "CrmDeal" | "CrmActivity" | "CrmDealStageTransition"
  | "CrmConversation" | "CrmConversationMessage" | "CrmProspectWorkspace" | "CrmCommunicationSuggestion"
  | "ModelUsageBudget" | "ModelUsageCost"
  | "ApprovalPolicy" | "ApprovalFlow" | "ApprovalDecision" | "Objection" | "Constitution" | "ConstitutionSourceReference"
  | "Proposal" | "Goal" | "GoalLink" | "CheckIn" | "ContextGraphObject"
  | "ContextGraphRelationship" | "ContextGraphEvidenceRef" | "ContextGraphProposedDiff"
  | "ContextMapView" | "ContextMapLayoutItem"
  | "WorkspaceBriefing" | "NewspaperEdition" | "NewspaperTrackedLink" | "NewspaperDelivery" | "ArtifactInputSnapshot";

export type LineageInput = { kind: LineageKind; id: string };
export type LineageRoot = LineageInput & { fingerprint: string };
type LineageClient = Prisma.TransactionClient | typeof prisma;

/** These sources contain model output or copied conversation context, rather than direct source material. */
export function brainSourceNeedsLineage(row: { sourceType?: unknown; channel?: unknown }) {
  return row.sourceType === "CONVERSATION" || row.sourceType === "CONVERSATION_INSIGHT"
    || ["chat-demand", "daily-batch", "daily-digest", "daily-question"].includes(String(row.channel));
}

const CONTENT_FIELDS: Record<LineageKind, string[]> = {
  AgentRequestInput: ["workspaceId", "userId", "agentKey", "prompt", "meetingId", "proposalId"],
  AgentFeedbackInput: ["workspaceId", "agentRunId", "stepId", "priorRunSnapshotId", "userId", "content"],
  ConversationPendingOperation: ["conversationId", "userId", "agentKey", "toolName", "argsJson", "argsHash", "idempotencyKey", "relatedEntityType", "relatedEntityId", "riskLabel", "resultJson"],
  BrainDiscussionThread: ["articleId", "authorMemberId", "targetType", "targetRef", "status", "resolvedAt", "absorbedAt"],
  BrainDiscussionComment: ["threadId", "authorMemberId", "agentKey", "bodyMd", "agentRunId"],
  AgentRun: ["goal", "planJson", "contextJson", "resultJson", "triggerRef"],
  AgentStep: ["agentRunId", "name", "inputJson", "outputJson", "error", "humanFeedback"],
  AgentToolCall: ["agentRunId", "name", "inputJson", "outputJson", "error"],
  Workspace: ["name"],
  User: ["email", "displayName", "bio", "avatarUrl", "linkedinUrl", "websiteUrl"],
  Member: ["userId", "role", "kind", "memberType", "isActive", "joinedAt", "user"],
  AgentIdentity: ["agentKey", "memberType", "displayName", "purposeMd", "behaviorMd", "isActive", "archivedAt"],
  CircleAgentAssignment: ["circleId", "agentIdentityId", "roleId", "assignedAt"],
  Role: ["name", "purposeMd", "accountabilities", "artifacts", "metricsMd", "coreRoleType", "circleId", "archivedAt"],
  Circle: ["name", "purposeMd", "domainMd", "maturityStage", "parentCircleId", "archivedAt"],
  RoleAssignment: ["roleId", "memberId", "assignedAt", "expiresAt"],
  RoleVersion: ["roleId", "circleId", "version", "name", "purposeMd", "accountabilities", "artifacts", "metricsMd", "coreRoleType", "changeType", "createdAt"],
  RoleHolderHistory: ["roleId", "holderKind", "memberId", "agentIdentityId", "startedAt", "endedAt"],
  BrainSource: [],
  BrainArticle: ["variantOfArticleId", "variantTargetFingerprint", "variantInputSetHash", "variantSourceStateJson", "variantGenerationJobId", "slug", "title", "type", "authority", "bodyMd", "frontmatterJson", "sourceIds", "isPrivate", "ownerMemberId", "publishedAt", "archivedAt", "createdAt", "updatedAt", "lastVerifiedAt"],
  BrainArticleVersion: ["articleId", "version", "bodyMd", "accessEnvelopeJson"],
  Document: ["mimeType", "title", "source", "storageKey", "textContent", "accessDomain", "archivedAt"],
  Meeting: ["title", "source", "transcript", "summaryMd", "blocksJson", "decisionsJson", "agendaJson", "ingestionGuidanceMd", "recordedAt", "status", "archivedAt"],
  MeetingTranscript: ["title", "source", "transcript", "ingestionGuidanceMd", "recordedAt", "scheduledEndAt", "seriesId", "participantIds", "participantEmails", "archivedAt"],
  MeetingInsight: ["meetingId", "type", "operation", "status", "title", "bodyMd", "assigneeHint", "dueAt", "sourceQuote", "metadataJson", "supersededAt",
    "targetEntityType", "targetEntityId", "appliedEntityType", "appliedEntityId", "deliberationEntryType", "resolutionOutcome", "confidence",
    "sourceRecordId", "sourceRecordedAt", "supersededByInsightId", "autoApplyError"],
  MeetingSeries: ["title", "description", "source", "recurrenceRule", "meetingUrl", "startsAt", "defaultDurationMinutes", "participantIds", "participantEmails", "archivedAt"],
  MeetingAgenda: ["agendaJson"],
  MeetingFollowUpReview: ["meetingId", "installationId", "provider", "channelId", "threadTs", "messageTs", "status", "expiresAt", "closedAt"],
  DeliberationEntry: ["parentType", "parentId", "parentVersion", "authorUserId", "entryType", "bodyMd", "targetMemberId", "targetCircleId", "adviceRequestId", "resolvedAt", "resolvedNote"],
  KnowledgeChunk: ["sourceType", "sourceId", "accessDomain", "sourceTitle", "chunkIndex", "content", "metadata", "sensitivity"],
  Action: ["title", "bodyMd", "status", "circleId", "authorUserId", "assigneeMemberId", "priority", "dueAt", "proposalId", "isPrivate", "archivedAt"],
  ActionChecklistItem: ["actionId", "title", "sortOrder", "completedAt", "completedByUserId"],
  Tension: ["title", "bodyMd", "status", "circleId", "authorUserId", "assigneeMemberId", "priority", "urgency", "importance", "resolvedVia", "resolvedAt", "proposalId", "meetingId", "isPrivate", "archivedAt"],
  TensionUpvote: ["tensionId", "userId"],
  Recognition: ["goalId", "recipientMemberId", "authorMemberId", "title", "storyMd", "valueTags", "visibility"],
  GoalUpdate: ["goalId", "authorMemberId", "source", "bodyMd", "newProgress", "statusChange", "createdAt"],
  KeyResult: ["goalId", "title", "targetValue", "currentValue", "unit", "progressPercent", "sortOrder"],
  CommunicationExternalUser: ["installationId", "provider", "externalUserId", "userId", "memberId", "email", "displayName", "isBot", "isDeleted", "rawProfile"],
  CommunicationEntityLink: ["installationId", "provider", "messageId", "externalUserId", "entityType", "entityId", "action", "claimKey"],
  CommunicationChannel: ["installationId", "provider", "externalChannelId", "name", "kind", "isIngestEnabled", "isArchived"],
  CommunicationMessage: ["installationId", "provider", "externalChannelId", "externalUserId", "externalMessageId", "threadExternalId", "text", "textRedactedAt", "isHidden", "isDeleted", "messageTs", "receivedAt"],
  CommunicationContextSummary: ["installationId", "provider", "externalChannelId", "threadExternalId", "summaryDate", "summaryKey", "title", "summaryMd", "messageCount", "sourceMessageIds", "firstMessageTs", "lastMessageTs", "lastMessageExternalId", "metadata"],
  BuildArtifact: ["brainSourceId", "repositoryOwner", "repositoryName", "pullRequestNumber", "pullRequestUrl", "branchName", "title", "summaryMd", "status", "classification", "visibility", "mergedAt", "closedAt"],
  BuildArtifactAsset: ["artifactId", "kind", "label", "captionMd", "storageKey", "sha256", "sortOrder"],
  AdviceRequest: ["processId", "requestedByUserId", "audienceType", "targetCircleId", "messageMd", "deadlineAt", "reminderAt", "preferredChannel", "status", "completedAt", "canceledAt"],
  AgentMemory: ["agentKey", "memoryType", "content", "metadata"],
  ConversationPromptInput: ["sessionId", "userId", "content"],
  ConversationSession: ["userId", "agentKey", "topic", "status", "systemPrompt"],
  ConversationTurn: ["promptInputId", "conversationId", "sequenceNumber", "userMessage", "assistantMessage", "contextJson"],
  RoleOnboardingSession: ["roleId", "memberId", "conversationId", "status", "startedAt", "completedAt", "dismissedAt"],
  PolicyCorpus: ["proposalId", "title", "bodyMd", "acceptedAt", "circleId"],
  Notification: ["userId", "type", "dedupeKey", "priority", "entityType", "entityId", "title", "bodyMd"],
  CrmAccount: ["name", "slug", "domain", "relationshipType", "lifecycleStage", "descriptionMd", "source", "tags", "ownerUserId", "archivedAt", "archivedByUserId", "archiveReason"],
  CrmContact: ["accountId", "email", "name", "company", "title", "phone", "source", "tags", "avatarUrl", "lastSeenAt", "archivedAt", "archivedByUserId", "archiveReason"],
  CrmDeal: ["accountId", "contactId", "title", "stage", "valueCents", "currency", "closedAt", "ownerUserId", "notes", "archivedAt", "archivedByUserId", "archiveReason"],
  CrmActivity: ["accountId", "contactId", "dealId", "actorUserId", "ownerUserId", "completedByUserId", "type", "title", "bodyMd", "source", "sourceExternalId", "sourceUrl", "sourceOccurredAt", "dueAt", "completedAt", "archivedAt", "archivedByUserId", "archiveReason"],
  CrmDealStageTransition: ["dealId", "fromStage", "toStage", "actorUserId"],
  CrmConversation: ["accountId", "demoLeadId", "contactId", "dealId", "subject", "status", "source", "sourceExternalId", "sourceUrl", "sourceOccurredAt"],
  CrmConversationMessage: ["conversationId", "senderType", "senderUserId", "senderEmail", "bodyMd", "isRead"],
  CrmProspectWorkspace: ["crmWorkspaceId", "accountId", "demoLeadId", "targetWorkspaceId", "adminEmail", "status", "provisionedAt"],
  CrmCommunicationSuggestion: ["accountId", "contactId", "dealId", "activityId", "actorUserId", "ownerUserId", "status", "channel", "title", "subject", "bodyMd", "recipientEmail", "recipientName", "source", "requestedAt", "sentAt", "declinedAt", "failedAt", "failureReason", "externalRequestId"],
  ModelUsageBudget: ["monthlyCostCapUsd", "alertThresholdPct", "periodStartDay"],
  ModelUsageCost: ["estimatedCostUsd", "billableCostUsd"],
  ApprovalPolicy: ["subjectType", "mode", "quorumPercent", "minApproverCount", "decisionWindowHours", "requireProposalLink"],
  ApprovalFlow: ["subjectType", "subjectId", "mode", "status", "openedAt", "closesAt", "quorumPercent", "minApproverCount", "closedAt", "resultJson", "createdByUserId"],
  ApprovalDecision: ["flowId", "memberId", "choice", "rationale"],
  Objection: ["flowId", "userId", "bodyMd", "resolvedAt"],
  ConstitutionSourceReference: ["constitutionId", "pointKey", "pointOrder", "sourceOrder", "policyCorpusId", "sourceKind", "proposalId", "tensionId", "labelSnapshot", "acceptedAtSnapshot"],
  Constitution: ["version", "bodyMd", "diffSummary", "triggerType", "triggerRef", "modelUsed", "promptTokens", "completionTokens"],
  Proposal: ["circleId", "title", "summary", "bodyMd", "decisionMd", "status", "priority", "resolutionOutcome", "isPrivate", "authorUserId", "ownerMemberId", "createdAt", "updatedAt", "publishedAt", "decidedAt"],
  Goal: ["startDate", "title", "descriptionMd", "level", "cadence", "parentGoalId", "circleId", "ownerMemberId", "status", "progressPercent", "targetDate", "sortOrder", "isPrivate", "authorUserId", "archivedAt", "createdAt", "updatedAt"],
  GoalLink: ["goalId", "entityType", "entityId", "confidence", "linkedBy", "source", "metadata"],
  CheckIn: ["questionText", "questionSource", "metadata", "relatedEntityType", "relatedEntityId"],
  ContextGraphObject: ["objectType", "title", "summary", "properties", "sourceEntityType", "sourceEntityId"],
  ContextGraphRelationship: ["sourceObjectId", "targetObjectId", "relationshipType", "properties", "sourceEntityType", "sourceEntityId"],
  ContextGraphEvidenceRef: ["objectId", "relationshipId", "sourceType", "sourceId", "knowledgeChunkId", "quote", "metadata"],
  ContextGraphProposedDiff: ["diffJson", "reason", "evidenceJson"],
  ContextMapView: ["name", "viewType", "query"],
  ContextMapLayoutItem: ["mapViewId", "objectId", "visualState"],
  WorkspaceBriefing: ["title", "introMd", "bodyMd", "briefingJson", "sourceRefsJson", "sourceCounts", "status"],
  NewspaperEdition: ["title", "slug", "digestJson", "bodyMd", "sourceCounts"],
  NewspaperTrackedLink: ["runKey", "targetUrl", "targetUrlHash", "tokenHash"],
  NewspaperDelivery: ["runKey", "memberId", "demoLeadId", "kind", "cadence", "recipientEmail", "subject", "status", "providerMessageId", "error"],
  ArtifactInputSnapshot: ["sourceKind", "sourceId", "sourceFingerprint", "origin", "contentJson", "accessEnvelopeJson", "rootsJson"],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Hash only fields that can convey information or change visibility. */
function snapshotContentFields(kind: LineageKind) {
  return kind === "BrainSource" ? ["id", "workspaceId", "accessDomain", "sourceType", "tier", "title", "channel", "content", "ingestionGuidanceMd", "fileStorageKey", "fileMimeType"] : fingerprintFields(kind);
}

function fingerprintFields(kind: LineageKind) {
  return [...new Set([...CONTENT_FIELDS[kind], "createdAt",
    ...(["NewspaperTrackedLink", "Meeting", "ModelUsageBudget", "ConversationSession", "ConversationPendingOperation", "AgentRun", "AgentStep", "AgentToolCall"].includes(kind) ? [] : ["updatedAt"])])];
}

export function lineageContentFingerprint(kind: LineageKind, row: unknown): string {
  invariant(isRecord(row), 409, "UNKNOWN_LINEAGE", "Artifact content cannot be verified.");
  if (kind === "BrainSource") {
    return brainSourceContentFingerprint(row as Parameters<typeof brainSourceContentFingerprint>[0]);
  }
  const fields = fingerprintFields(kind);
  return createHash("sha256").update(JSON.stringify([kind, ...fields.map((field) => kind === "Member" && field === "user" && isRecord(row.user)
    ? { id: row.userId ?? row.user.id ?? null, email: row.user.email ?? null, displayName: row.user.displayName ?? null }
    : row[field] ?? null)])).digest("hex");
}

function parseRoots(value: Prisma.JsonValue): LineageRoot[] | null {
  if (!Array.isArray(value)) return null;
  const roots: LineageRoot[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.kind !== "string" || !(item.kind in CONTENT_FIELDS)
      || typeof item.id !== "string" || !item.id
      || typeof item.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(item.fingerprint)) return null;
    roots.push(item as LineageRoot);
  }
  return roots;
}

async function loadArtifact(db: LineageClient, workspaceId: string, input: LineageInput): Promise<Record<string, unknown> | null> {
  const where = { id: input.id, workspaceId };
  switch (input.kind) {
    case "AgentRequestInput": return db.agentRequestInput.findFirst({ where });
    case "AgentFeedbackInput": return db.agentFeedbackInput.findFirst({ where });
    case "ConversationPendingOperation": return db.conversationPendingOperation.findFirst({ where });
    case "BrainDiscussionThread": return db.brainDiscussionThread.findFirst({ where: { id: input.id, article: { workspaceId } } });
    case "BrainDiscussionComment": return db.brainDiscussionComment.findFirst({ where: { id: input.id, thread: { article: { workspaceId } } } });
    case "AgentRun": return db.agentRun.findFirst({ where });
    case "AgentStep": return db.agentStep.findFirst({ where: { id: input.id, agentRun: { workspaceId } } });
    case "AgentToolCall": return db.agentToolCall.findFirst({ where: { id: input.id, agentRun: { workspaceId } } });
    case "Workspace": return db.workspace.findFirst({ where: { id: input.id === workspaceId ? input.id : "" }, select: { id: true, name: true } });
    case "User": return db.user.findFirst({ where: { id: input.id, memberships: { some: { workspaceId, isActive: true } } }, select: { id: true, email: true, displayName: true, bio: true, avatarUrl: true, linkedinUrl: true, websiteUrl: true } });
    case "Member": return db.member.findFirst({ where, include: { user: { select: { id: true, email: true, displayName: true } } } });
    case "AgentIdentity": return db.agentIdentity.findFirst({ where, select: { id: true, workspaceId: true, agentKey: true,
      memberType: true, displayName: true, purposeMd: true, behaviorMd: true, isActive: true, archivedAt: true, createdAt: true, updatedAt: true } });
    case "CircleAgentAssignment": return db.circleAgentAssignment.findFirst({ where: { id: input.id,
      circle: { workspaceId }, agentIdentity: { workspaceId } } });
    case "Role": return db.role.findFirst({ where: { id: input.id, circle: { workspaceId } } });
    case "Circle": return db.circle.findFirst({ where });
    case "RoleAssignment": return db.roleAssignment.findFirst({ where: { id: input.id, member: { workspaceId }, role: { circle: { workspaceId } } } });
    case "RoleVersion": return db.roleVersion.findFirst({ where });
    case "RoleHolderHistory": return db.roleHolderHistory.findFirst({ where });
    case "BrainSource": return db.brainSource.findFirst({ where });
    case "BrainArticle": return db.brainArticle.findFirst({ where });
    case "BrainArticleVersion": return db.brainArticleVersion.findFirst({ where: { id: input.id, article: { workspaceId } } });
    case "Document": return db.document.findFirst({ where });
    case "Meeting": return db.meeting.findFirst({ where });
    case "MeetingTranscript": return db.meeting.findFirst({ where, select: {
      id: true, workspaceId: true, title: true, source: true, transcript: true, ingestionGuidanceMd: true,
      recordedAt: true, scheduledEndAt: true, seriesId: true, participantIds: true, participantEmails: true,
      archivedAt: true, createdAt: true,
    } });
    case "MeetingInsight": return db.meetingInsight.findFirst({ where });
    case "MeetingSeries": return db.meetingSeries.findFirst({ where });
    case "MeetingAgenda": return db.meeting.findFirst({ where, select: { id: true, workspaceId: true, agendaJson: true, archivedAt: true, createdAt: true } });
    case "MeetingFollowUpReview": return db.meetingFollowUpReview.findFirst({ where });
    case "DeliberationEntry": return db.deliberationEntry.findFirst({ where });
    case "KnowledgeChunk": return db.knowledgeChunk.findFirst({ where });
    case "Action": return db.action.findFirst({ where });
    case "ActionChecklistItem": return db.actionChecklistItem.findFirst({ where });
    case "Tension": return db.tension.findFirst({ where });
    case "TensionUpvote": return db.tensionUpvote.findFirst({ where: { id: input.id, tension: { workspaceId } } });
    case "Recognition": return db.recognition.findFirst({ where });
    case "GoalUpdate": return db.goalUpdate.findFirst({ where: { id: input.id, goal: { workspaceId } } });
    case "KeyResult": return db.keyResult.findFirst({ where: { id: input.id, goal: { workspaceId } } });
    case "CommunicationExternalUser": return db.communicationExternalUser.findFirst({ where });
    case "CommunicationEntityLink": return db.communicationEntityLink.findFirst({ where });
    case "CommunicationChannel": return db.communicationChannel.findFirst({ where });
    case "CommunicationMessage": return db.communicationMessage.findFirst({ where });
    case "CommunicationContextSummary": return db.communicationContextSummary.findFirst({ where });
    case "BuildArtifact": return db.buildArtifact.findFirst({ where });
    case "BuildArtifactAsset": return db.buildArtifactAsset.findFirst({ where: { id: input.id, artifact: { workspaceId } } });
    case "AdviceRequest": return db.adviceRequest.findFirst({ where });
    case "AgentMemory": return db.agentMemory.findFirst({ where });
    case "ConversationPromptInput": return db.conversationPromptInput.findFirst({ where });
    case "ConversationSession": return db.conversationSession.findFirst({ where });
    case "ConversationTurn": return db.conversationTurn.findFirst({ where: { id: input.id, conversation: { workspaceId } } });
    case "RoleOnboardingSession": return db.roleOnboardingSession.findFirst({ where });
    case "PolicyCorpus": return db.policyCorpus.findFirst({ where });
    case "Notification": return db.notification.findFirst({ where });
    case "CrmAccount": return db.crmAccount.findFirst({ where: where });
    case "CrmContact": return db.crmContact.findFirst({ where: where });
    case "CrmDeal": return db.crmDeal.findFirst({ where: where });
    case "CrmActivity": return db.crmActivity.findFirst({ where: where });
    case "CrmDealStageTransition": return db.crmDealStageTransition.findFirst({ where: where });
    case "CrmConversation": return db.crmConversation.findFirst({ where: where });
    case "CrmConversationMessage": return db.crmConversationMessage.findFirst({ where: { id: input.id, conversation: { workspaceId } } });
    case "CrmProspectWorkspace": return db.crmProspectWorkspace.findFirst({ where: { id: input.id, crmWorkspaceId: workspaceId } });
    case "CrmCommunicationSuggestion": return db.crmCommunicationSuggestion.findFirst({ where: where });
    case "ModelUsageBudget": return db.modelUsageBudget.findFirst({ where });
    case "ModelUsageCost": return db.modelUsage.findFirst({ where, select: { id: true, workspaceId: true, estimatedCostUsd: true, billableCostUsd: true, createdAt: true } });
    case "ApprovalPolicy": return db.approvalPolicy.findFirst({ where: where });
    case "ApprovalFlow": return db.approvalFlow.findFirst({ where: where });
    case "ApprovalDecision": return db.approvalDecision.findFirst({ where: { id: input.id, flow: { workspaceId } } });
    case "Objection": return db.objection.findFirst({ where: { id: input.id, flow: { workspaceId } } });
    case "ConstitutionSourceReference": return db.constitutionSourceReference.findFirst({ where });
    case "Constitution": return db.constitution.findFirst({ where: where });
    case "Proposal": return db.proposal.findFirst({ where });
    case "Goal": return db.goal.findFirst({ where });
    case "GoalLink": return db.goalLink.findFirst({ where: { id: input.id, goal: { workspaceId } } });
    case "CheckIn": return db.checkIn.findFirst({ where });
    case "ContextGraphObject": return db.contextGraphObject.findFirst({ where });
    case "ContextGraphRelationship": return db.contextGraphRelationship.findFirst({ where });
    case "ContextGraphEvidenceRef": return db.contextGraphEvidenceRef.findFirst({ where });
    case "ContextGraphProposedDiff": return db.contextGraphProposedDiff.findFirst({ where });
    case "ContextMapView": return db.contextMapView.findFirst({ where });
    case "ContextMapLayoutItem": return db.contextMapLayoutItem.findFirst({ where: { id: input.id, mapView: { workspaceId } } });
    case "WorkspaceBriefing": return db.workspaceBriefing.findFirst({ where });
    case "NewspaperEdition": return db.newspaperEdition.findFirst({ where });
    case "NewspaperTrackedLink": return db.newspaperTrackedLink.findFirst({ where });
    case "NewspaperDelivery": return db.newspaperDelivery.findFirst({ where });
    case "ArtifactInputSnapshot": return db.artifactInputSnapshot.findFirst({ where });
  }
  return null;
}

function isArchived(row: unknown) {
  return isRecord(row) && (row.archivedAt != null || row.status === "archived");
}

function actorCanReadRecord(actor: AppActor, membership: { id: string; role: string } | null, kind: LineageKind, row: Record<string, unknown>) {
  if (kind === "BrainArticle" && row.variantOfArticleId != null) {
    return actor.kind === "agent" || (actor.kind === "user" && membership?.id === row.ownerMemberId);
  }
  if (kind === "BrainArticle" && row.isPrivate === true) {
    return actor.kind === "agent" || membership?.role === "ADMIN" || row.ownerMemberId === membership?.id;
  }
  if (["Proposal", "Goal", "Action", "Tension"].includes(kind) && row.isPrivate === true) {
    return row.status === "DRAFT" && (actor.kind === "agent" || membership?.role === "ADMIN"
      || (actor.kind === "user" && row.authorUserId === actor.user.id));
  }
  if (["ModelUsageBudget", "ModelUsageCost"].includes(kind)) return actor.kind === "agent" || membership?.role === "ADMIN";
  if (kind === "Recognition") return row.visibility === "WORKSPACE" || actor.kind === "agent"
    || membership?.id === row.authorMemberId || membership?.id === row.recipientMemberId;
  if (kind === "Member") return row.isActive === true;
  if (kind === "AgentIdentity") return row.isActive === true || (row.agentKey === "__workspace__" && row.archivedAt == null);
  if (kind === "NewspaperDelivery") return actor.kind === "agent" || membership?.role === "ADMIN"
    || (row.kind === "MEMBER_NEWSPAPER" && row.memberId === membership?.id);
  if (kind === "Notification") return actor.kind === "agent" || (actor.kind === "user" && row.userId === actor.user.id);
  if (["AgentRequestInput", "ConversationPromptInput", "AgentFeedbackInput", "ConversationPendingOperation"].includes(kind)) return actor.kind === "agent" || (actor.kind === "user" && row.userId === actor.user.id);
  if (kind === "ConversationSession") return actor.kind === "agent" || (actor.kind === "user" && row.userId === actor.user.id);
  if (kind === "RoleOnboardingSession") return actor.kind === "agent" || row.memberId === membership?.id;
  if (kind === "CheckIn") return actor.kind === "agent" || membership?.id === row.memberId;
  if (kind === "ContextMapView" && row.createdByUserId != null) {
    return actor.kind === "user" && actor.user.id === row.createdByUserId;
  }
  return true;
}

function needsManifest(kind: LineageKind, row: Record<string, unknown>) {
  if (kind === "BrainSource") return brainSourceNeedsLineage(row);
  return !["Workspace", "Member", "User", "RoleAssignment", "CircleAgentAssignment", "Document", "MeetingTranscript", "CommunicationExternalUser", "CommunicationEntityLink", "CommunicationChannel",
    "CommunicationMessage", "AgentRequestInput", "AgentFeedbackInput", "ConversationPromptInput", "ModelUsageBudget", "ModelUsageCost", "ApprovalPolicy", "CrmDealStageTransition", "KnowledgeChunk", "TensionUpvote", "BuildArtifact", "BuildArtifactAsset", "ArtifactInputSnapshot"].includes(kind);
}

async function rootIsReadable(db: LineageClient, actor: AppActor, workspaceId: string,
  membership: { id: string; role: string } | null, domains: readonly string[], root: LineageRoot,
  visited = new Set<string>(), memo = new Map<string, boolean>()): Promise<boolean> {
  const key = `${root.kind}:${root.id}:${root.fingerprint}`;
  if (visited.has(key)) return false;
  const cached = memo.get(key);
  if (cached !== undefined) return cached;
  const result = await evaluateRoot(db, actor, workspaceId, membership, domains, root, new Set(visited).add(key), memo);
  memo.set(key, result);
  return result;
}

async function evaluateRoot(db: LineageClient, actor: AppActor, workspaceId: string,
  membership: { id: string; role: string } | null, domains: readonly string[], root: LineageRoot,
  visited: Set<string>, memo: Map<string, boolean>, permissionOnly = false): Promise<boolean> {
  const loaded = await loadArtifact(db, workspaceId, root);
  if (!isRecord(loaded) || isArchived(loaded)) return false;
  const row: Record<string, unknown> = loaded;
  if (root.kind === "ArtifactInputSnapshot") {
    if (lineageContentFingerprint(root.kind, row) !== root.fingerprint || !isRecord(row.accessEnvelopeJson)
      || typeof row.sourceKind !== "string" || !(row.sourceKind in CONTENT_FIELDS) || row.sourceKind === "ArtifactInputSnapshot") return false;
    const sourceKind = row.sourceKind as LineageKind;
    const envelope = row.accessEnvelopeJson;
    const permissionKind = typeof envelope.permissionKind === "string" && envelope.permissionKind in CONTENT_FIELDS
      ? envelope.permissionKind as LineageKind : sourceKind;
    if (isArchived(envelope) || !actorCanReadRecord(actor, membership, permissionKind, envelope)) return false;
    if ((sourceKind === "BrainSource" || sourceKind === "Document") && !domains.includes(String(envelope.accessDomain))) return false;
    if (sourceKind === "ConversationTurn" && actor.kind === "user" && envelope.requesterUserId !== actor.user.id) return false;
    const upstream = parseRoots(row.rootsJson as Prisma.JsonValue);
    if (!upstream || (row.origin !== "DERIVED" && row.origin !== "HUMAN_ORIGINAL")) return false;
    if (!await evaluateRoot(db, actor, workspaceId, membership, domains,
      { kind: sourceKind, id: String(row.sourceId), fingerprint: String(row.sourceFingerprint) }, visited, memo, true)) return false;
    for (const input of upstream) if (!await rootIsReadable(db, actor, workspaceId, membership, domains, input, visited, memo)) return false;
    return true;
  }
  if (root.kind === "RoleAssignment" && row.expiresAt instanceof Date && row.expiresAt <= new Date()) return false;
  if (["CommunicationExternalUser", "CommunicationEntityLink"].includes(root.kind)) {
    const installation = await db.communicationInstallation.findFirst({ where: { id: String(row.installationId), workspaceId, status: "ACTIVE", disconnectedAt: null } });
    if (!installation || row.isDeleted === true) return false;
    if (root.kind === "CommunicationExternalUser" && (row.memberId != null || row.userId != null)) {
      const mapped = await db.member.findFirst({ where: { workspaceId, isActive: true,
        ...(row.memberId != null ? { id: String(row.memberId) } : {}), ...(row.userId != null ? { userId: String(row.userId) } : {}) } });
      if (!mapped) return false;
    }
    if (root.kind === "CommunicationEntityLink" && row.messageId != null) {
      const message = await loadArtifact(db, workspaceId, { kind: "CommunicationMessage", id: String(row.messageId) });
      if (!message || !await rootIsReadable(db, actor, workspaceId, membership, domains,
        { kind: "CommunicationMessage", id: String(row.messageId), fingerprint: lineageContentFingerprint("CommunicationMessage", message) }, visited, memo)) return false;
    }
  }
  if (["CommunicationChannel", "CommunicationMessage", "CommunicationContextSummary"].includes(root.kind)) {
    if (root.kind === "CommunicationChannel" && (row.kind !== "PUBLIC" || row.isIngestEnabled !== true || row.isArchived === true)) return false;
    if (row.isHidden === true || row.isDeleted === true || row.textRedactedAt != null) return false;
    const installation = await db.communicationInstallation.findFirst({ where: {
      id: String(row.installationId), workspaceId, status: "ACTIVE", disconnectedAt: null,
    }, select: { id: true } });
    const channel = await db.communicationChannel.findFirst({ where: {
      installationId: String(row.installationId), workspaceId, externalChannelId: String(row.externalChannelId),
      kind: "PUBLIC", isIngestEnabled: true, isArchived: false,
    }, select: { id: true } });
    if (!installation || !channel) return false;
  }
  if (root.kind === "BrainArticle" && row.variantOfArticleId != null) {
    if (row.isPrivate !== true || typeof row.variantTargetFingerprint !== "string" || !isRecord(row.variantSourceStateJson)) return false;
    const target = await db.brainArticle.findFirst({ where: { id: String(row.variantOfArticleId), workspaceId, archivedAt: null } });
    if (!target || target.variantOfArticleId != null || !actorCanReadRecord(actor, membership, "BrainArticle", target)
      || lineageContentFingerprint("BrainArticle", target) !== row.variantTargetFingerprint) return false;
    for (const [sourceId, expected] of Object.entries(row.variantSourceStateJson)) {
      if (typeof expected !== "string" || !/^[a-f0-9]{64}$/.test(expected)) return false;
      const history = await db.workspaceArchiveRecord.findMany({ where: { workspaceId, entityType: "BrainSource", entityId: sourceId },
        select: { id: true, archivedAt: true, restoredAt: true, purgedAt: true }, orderBy: { id: "asc" } });
      if (createHash("sha256").update(JSON.stringify(history)).digest("hex") !== expected) return false;
    }
  }
  if (root.kind === "CrmProspectWorkspace") {
    try { await requireWorkspaceMembership({ actor, workspaceId: String(row.targetWorkspaceId) }); }
    catch { return false; }
  }
  if (root.kind.startsWith("Crm")) {
    const parentFields: Array<[string, LineageKind, boolean]> = root.kind === "CrmDealStageTransition"
      ? [["dealId", "CrmDeal", true]]
      : root.kind === "CrmConversationMessage" ? [["conversationId", "CrmConversation", true]]
        : root.kind === "CrmAccount" ? [] : [
          ["accountId", "CrmAccount", false], ["contactId", "CrmContact", root.kind === "CrmDeal"],
          ["dealId", "CrmDeal", false], ["activityId", "CrmActivity", false],
        ];
    for (const [field, kind, required] of parentFields) {
      if (row[field] == null) { if (required) return false; continue; }
      const parent = await loadArtifact(db, workspaceId, { kind, id: String(row[field]) });
      if (!isRecord(parent)) return false;
      const parentRoot = { kind, id: String(row[field]), fingerprint: lineageContentFingerprint(kind, parent) };
      if (root.kind === "CrmDealStageTransition") {
        if (!await rootIsReadable(db, actor, workspaceId, membership, domains, parentRoot, visited, memo)) return false;
      } else if (!await evaluateRoot(db, actor, workspaceId, membership, domains, parentRoot, visited, memo, true)) return false;
    }
  }
  if (["ApprovalFlow", "ApprovalDecision", "Objection"].includes(root.kind)) {
    const flow = root.kind === "ApprovalFlow" ? row
      : await loadArtifact(db, workspaceId, { kind: "ApprovalFlow", id: String(row.flowId) });
    if (!isRecord(flow)) return false;
    const subjectKinds: Record<string, LineageKind> = { PROPOSAL: "Proposal", ACTION: "Action", TENSION: "Tension" };
    const kind = subjectKinds[String(flow.subjectType)];
    if (!kind) return false;
    const subject = await loadArtifact(db, workspaceId, { kind, id: String(flow.subjectId) });
    if (!isRecord(subject) || !await evaluateRoot(db, actor, workspaceId, membership, domains,
      { kind, id: String(flow.subjectId), fingerprint: lineageContentFingerprint(kind, subject) }, visited, memo, true)) return false;
  }
  if (root.kind === "ConstitutionSourceReference") {
    const parent = await loadArtifact(db, workspaceId, { kind: "Constitution", id: String(row.constitutionId) });
    if (!isRecord(parent) || !await evaluateRoot(db, actor, workspaceId, membership, domains,
      { kind: "Constitution", id: String(row.constitutionId), fingerprint: lineageContentFingerprint("Constitution", parent) }, visited, memo, true)) return false;
  }
  if (root.kind === "KnowledgeChunk") {
    if (!domains.includes(String(row.accessDomain))) return false;
    const sourceKinds: Record<string, LineageKind> = { BRAIN_ARTICLE: "BrainArticle", DOCUMENT: "Document", MEETING: "Meeting", PROPOSAL: "Proposal" };
    const kind = sourceKinds[String(row.sourceType)];
    if (!kind || !isRecord(row.metadata)) return false;
    const source = await loadArtifact(db, workspaceId, { kind, id: String(row.sourceId) });
    if (!isRecord(source)) return false;
    const fingerprint = lineageContentFingerprint(kind, source);
    if (row.metadata.sourceContentHash !== fingerprint || !await rootIsReadable(db, actor, workspaceId, membership, domains,
      { kind, id: String(row.sourceId), fingerprint }, visited, memo)) return false;
  }
  if (root.kind === "DeliberationEntry") {
    const kinds: Record<string, LineageKind> = { PROPOSAL: "Proposal", TENSION: "Tension", MEETING: "Meeting", BRAIN_ARTICLE: "BrainArticle", ACTION: "Action" };
    const kind = kinds[String(row.parentType)];
    if (!kind) return false;
    const parent = await loadArtifact(db, workspaceId, { kind, id: String(row.parentId) });
    // Discussion is independently authored. The parent supplies its current
    // visibility envelope, not its body (which may itself use the discussion).
    if (!isRecord(parent) || !await evaluateRoot(db, actor, workspaceId, membership, domains,
      { kind, id: String(row.parentId), fingerprint: lineageContentFingerprint(kind, parent) }, visited, memo, true)) return false;
  }
  if (root.kind === "AgentFeedbackInput") {
    const parent = await db.agentRun.findFirst({ where: { id: String(row.agentRunId), workspaceId } });
    const step = await db.agentStep.findFirst({ where: { id: String(row.stepId), agentRunId: String(row.agentRunId) } });
    const snapshot = typeof row.priorRunSnapshotId === "string" ? await db.artifactInputSnapshot.findFirst({ where: {
      id: row.priorRunSnapshotId, workspaceId, sourceKind: "AgentRun", sourceId: String(row.agentRunId) } }) : null;
    if (!parent || !step || !snapshot) return false;
  }
  if (["BrainDiscussionThread", "BrainDiscussionComment"].includes(root.kind)) {
    const thread = root.kind === "BrainDiscussionThread" ? row
      : await loadArtifact(db, workspaceId, { kind: "BrainDiscussionThread", id: String(row.threadId) });
    if (!isRecord(thread)) return false;
    const article = await loadArtifact(db, workspaceId, { kind: "BrainArticle", id: String(thread.articleId) });
    if (!isRecord(article) || !await evaluateRoot(db, actor, workspaceId, membership, domains,
      { kind: "BrainArticle", id: String(thread.articleId), fingerprint: lineageContentFingerprint("BrainArticle", article) }, visited, memo, true)) return false;
    if (root.kind === "BrainDiscussionComment" && !await rootIsReadable(db, actor, workspaceId, membership, domains,
      { kind: "BrainDiscussionThread", id: String(row.threadId), fingerprint: lineageContentFingerprint("BrainDiscussionThread", thread) }, visited, memo)) return false;
  }
  if (root.kind === "ConversationPendingOperation") {
    const session = await db.conversationSession.findFirst({ where: { id: String(row.conversationId), workspaceId } });
    if (!session || session.userId !== row.userId || (actor.kind === "user" && session.userId !== actor.user.id)) return false;
  }
  if (root.kind === "ConversationPromptInput") {
    const session = await db.conversationSession.findFirst({ where: { id: String(row.sessionId), workspaceId } });
    if (!session || session.userId !== row.userId || (actor.kind === "user" && session.userId !== actor.user.id)) return false;
  }
  if (root.kind === "ConversationTurn") {
    const session = await db.conversationSession.findFirst({ where: { id: String(row.conversationId), workspaceId } });
    if (!session || (actor.kind === "user" && session.userId !== actor.user.id)) return false;
  }
  if (root.kind === "AdviceRequest" && actor.kind !== "agent" && row.requestedByUserId !== actor.user.id) {
    if (row.audienceType === "MEMBERS") {
      if (!membership || !await db.adviceRequestRecipient.findFirst({ where: { requestId: root.id, memberId: membership.id }, select: { id: true } })) return false;
    } else if (row.audienceType === "CIRCLE") {
      if (!membership || !await db.roleAssignment.findFirst({ where: {
        memberId: membership.id, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        role: { circleId: String(row.targetCircleId), archivedAt: null, circle: { workspaceId, archivedAt: null } },
      }, select: { id: true } })) return false;
    } else if (row.audienceType !== "WORKSPACE") return false;
  }
  if (root.kind === "KeyResult") {
    const parent = await loadArtifact(db, workspaceId, { kind: "Goal", id: String(row.goalId) });
    if (!isRecord(parent) || !await evaluateRoot(db, actor, workspaceId, membership, domains,
      { kind: "Goal", id: String(row.goalId), fingerprint: lineageContentFingerprint("Goal", parent) }, visited, memo, true)) return false;
  }
  if (root.kind === "ActionChecklistItem" || root.kind === "TensionUpvote") {
    const kind = root.kind === "ActionChecklistItem" ? "Action" as const : "Tension" as const;
    const id = String(root.kind === "ActionChecklistItem" ? row.actionId : row.tensionId);
    const parent = await loadArtifact(db, workspaceId, { kind, id });
    if (!isRecord(parent) || !await evaluateRoot(db, actor, workspaceId, membership, domains,
      { kind, id, fingerprint: lineageContentFingerprint(kind, parent) }, visited, memo, true)) return false;
  }
  if (root.kind === "PolicyCorpus") {
    const parent = await loadArtifact(db, workspaceId, { kind: "Proposal", id: String(row.proposalId) });
    if (!isRecord(parent) || !await evaluateRoot(db, actor, workspaceId, membership, domains,
      { kind: "Proposal", id: String(row.proposalId), fingerprint: lineageContentFingerprint("Proposal", parent) }, visited, memo, true)) return false;
  }
  if (root.kind === "CircleAgentAssignment") {
    const identity = await loadArtifact(db, workspaceId, { kind: "AgentIdentity", id: String(row.agentIdentityId) });
    const circle = await loadArtifact(db, workspaceId, { kind: "Circle", id: String(row.circleId) });
    if (!identity || !circle || isArchived(identity) || identity.isActive !== true || isArchived(circle)) return false;
  }
  if (root.kind === "MeetingFollowUpReview") {
    const parent = await loadArtifact(db, workspaceId, { kind: "MeetingTranscript", id: String(row.meetingId) });
    if (!isRecord(parent) || !await evaluateRoot(db, actor, workspaceId, membership, domains,
      { kind: "MeetingTranscript", id: String(row.meetingId), fingerprint: lineageContentFingerprint("MeetingTranscript", parent) }, visited, memo, true)) return false;
  }
  const parent = root.kind === "GoalUpdate" ? { kind: "Goal" as const, id: String(row.goalId) }
    : root.kind === "MeetingInsight" ? { kind: "Meeting" as const, id: String(row.meetingId) }
      : root.kind === "BuildArtifactAsset" ? { kind: "BuildArtifact" as const, id: String(row.artifactId) } : null;
  if (parent) {
    const parentRow = await loadArtifact(db, workspaceId, parent);
    if (!isRecord(parentRow) || !await evaluateRoot(db, actor, workspaceId, membership, domains,
      { ...parent, fingerprint: lineageContentFingerprint(parent.kind, parentRow) }, visited, memo, true)) return false;
  }
  if (root.kind === "BrainArticleVersion") {
    const parent = await db.brainArticle.findFirst({ where: {
      id: String((row as Record<string, unknown>).articleId), workspaceId,
    } });
    if (!isRecord(parent) || isArchived(parent) || !actorCanReadRecord(actor, membership, "BrainArticle", parent)
      || !isRecord(row.accessEnvelopeJson)
      || typeof row.accessEnvelopeJson.isPrivate !== "boolean"
      || !actorCanReadRecord(actor, membership, "BrainArticle", row.accessEnvelopeJson)) return false;
  }
  if (root.kind === "GoalLink") {
    const parent = await db.goal.findFirst({ where: {
      id: String((row as Record<string, unknown>).goalId), workspaceId,
    } });
    if (!isRecord(parent) || isArchived(parent) || !actorCanReadRecord(actor, membership, "Goal", parent)) return false;
  }
  if (root.kind === "ContextMapLayoutItem") {
    const parent = await db.contextMapView.findFirst({ where: {
      id: String((row as Record<string, unknown>).mapViewId), workspaceId,
    } });
    if (!isRecord(parent) || !actorCanReadRecord(actor, membership, "ContextMapView", parent)) return false;
  }
  if ((root.kind === "BrainSource" || root.kind === "Document")
    && !domains.includes(String((row as Record<string, unknown>).accessDomain))) return false;
  if (!actorCanReadRecord(actor, membership, root.kind, row)) return false;
  if (permissionOnly) return true;
  if (lineageContentFingerprint(root.kind, row) !== root.fingerprint) return false;
  const manifest = await latestManifest(db, workspaceId, root);
  if (needsManifest(root.kind, row) || manifest) {
    if (!manifest || manifest.contentHash !== root.fingerprint) return false;
    const upstream = parseRoots(manifest.rootsJson);
    // A member's expressly contributed company answer can be an original source.
    // Copied/model-produced sources require a nonempty upstream proof.
    if (manifest.origin === "HUMAN_ORIGINAL") return !["AgentRun", "AgentStep", "AgentToolCall"].includes(root.kind) && upstream?.length === 0;
    if (manifest.origin !== "DERIVED" || !upstream?.length) return false;
    for (const input of upstream) {
      if (!await rootIsReadable(db, actor, workspaceId, membership, domains, input, visited, memo)) return false;
    }
  }
  return true;
}

async function snapshotInput(tx: Prisma.TransactionClient, workspaceId: string, root: LineageRoot,
  convertInputs?: (inputs: LineageRoot[]) => Promise<LineageRoot[]>) {
  const content = await loadArtifact(tx, workspaceId, root);
  invariant(isRecord(content) && lineageContentFingerprint(root.kind, content) === root.fingerprint,
    409, "SOURCE_CHANGED", "A mutable input changed before its snapshot was saved.");
  const recordedManifest = await latestManifest(tx, workspaceId, root);
  const nativeOriginal = ["Workspace", "Member", "User", "RoleAssignment", "CircleAgentAssignment", "Document", "MeetingTranscript", "CommunicationChannel", "CommunicationMessage", "ConversationPromptInput", "AgentRequestInput", "AgentFeedbackInput", "ModelUsageBudget", "ModelUsageCost", "ApprovalPolicy", "CrmDealStageTransition", "TensionUpvote", "BuildArtifact", "BuildArtifactAsset"].includes(root.kind)
    || (root.kind === "BrainSource" && !brainSourceNeedsLineage(content));
  const manifest = recordedManifest ?? (nativeOriginal ? { contentHash: root.fingerprint, origin: "HUMAN_ORIGINAL", rootsJson: [] } : null);
  const inputs = manifest ? parseRoots(manifest.rootsJson) : null;
  invariant(manifest && manifest.contentHash === root.fingerprint && inputs
    && (manifest.origin === "DERIVED" || manifest.origin === "HUMAN_ORIGINAL"),
  409, "UNKNOWN_LINEAGE", "A mutable input has incomplete lineage.");
  const snapshotRoots = convertInputs ? await convertInputs(inputs) : inputs;
  const record: Record<string, unknown> = content;
  let envelope: Record<string, unknown> = record;
  if (root.kind === "BrainArticleVersion") {
    invariant(isRecord(record.accessEnvelopeJson), 409, "UNKNOWN_LINEAGE", "The version's original permissions are unknown.");
    envelope = { ...record.accessEnvelopeJson, permissionKind: "BrainArticle" };
  } else if (root.kind === "ConversationTurn") {
    const session = await tx.conversationSession.findFirst({ where: { id: String(record.conversationId), workspaceId } });
    invariant(session, 409, "SOURCE_CHANGED", "The conversation is unavailable.");
    envelope = { ...record, requesterUserId: session.userId };
  }
  const contentJson = Object.fromEntries(snapshotContentFields(root.kind)
    .map((field) => [field, record[field] ?? null]));
  const accessEnvelope = Object.fromEntries(["permissionKind", "kind", "isPrivate", "ownerMemberId", "authorUserId", "status", "createdByUserId",
    "visibility", "isActive", "agentKey", "userId", "sessionId", "conversationId", "memberId", "authorMemberId", "recipientMemberId", "archivedAt", "accessDomain", "requesterUserId", "variantOfArticleId", "variantTargetFingerprint", "variantInputSetHash"]
    .map((field) => [field, envelope[field] ?? null]));
  const snapshot = await tx.artifactInputSnapshot.create({ data: {
    workspaceId, sourceKind: root.kind, sourceId: root.id, sourceFingerprint: root.fingerprint,
    origin: manifest.origin, contentJson: JSON.parse(JSON.stringify(contentJson)) as Prisma.InputJsonValue,
    accessEnvelopeJson: JSON.parse(JSON.stringify(accessEnvelope)) as Prisma.InputJsonValue,
    rootsJson: snapshotRoots as Prisma.InputJsonArray,
  } });
  return { root: { kind: "ArtifactInputSnapshot" as const, id: snapshot.id,
    fingerprint: lineageContentFingerprint("ArtifactInputSnapshot", snapshot) }, roots: snapshotRoots };
}

/** Preserve a verified mutable input before its content is changed in this transaction. */
export async function captureArtifactInputSnapshotProof(actor: AppActor, workspaceId: string,
  input: LineageInput & { fingerprint?: string }, tx: Prisma.TransactionClient): Promise<LineageRoot[]> {
  const proof = await captureArtifactInputProof(actor, workspaceId, [input], tx);
  const direct = proof.find((root) => root.kind === input.kind && root.id === input.id);
  invariant(direct, 409, "UNKNOWN_LINEAGE", "A mutable input has no complete receipt.");
  invariant(!input.fingerprint || input.fingerprint === direct.fingerprint,
    409, "SOURCE_CHANGED", "A mutable input changed before its snapshot was captured.");
  const snapshot = await snapshotInput(tx, workspaceId, direct);
  return [snapshot.root, ...snapshot.roots];
}

/** Preserve unproven legacy content as history without granting it input/read eligibility. */
export async function preserveUnknownArtifactInputSnapshot(tx: Prisma.TransactionClient, workspaceId: string,
  input: LineageInput, content: unknown) {
  const current = await loadArtifact(tx, workspaceId, input);
  invariant(current && isRecord(content) && lineageContentFingerprint(input.kind, current) === lineageContentFingerprint(input.kind, content),
    409, "SOURCE_CHANGED", "Legacy content changed before it could be preserved.");
  const contentJson = Object.fromEntries(snapshotContentFields(input.kind).map((field) => [field, content[field] ?? null]));
  return tx.artifactInputSnapshot.create({ data: {
    workspaceId, sourceKind: input.kind, sourceId: input.id, sourceFingerprint: lineageContentFingerprint(input.kind, content),
    origin: "UNKNOWN", contentJson: JSON.parse(JSON.stringify(contentJson)) as Prisma.InputJsonValue,
    accessEnvelopeJson: { isPrivate: content.isPrivate ?? null, ownerMemberId: content.ownerMemberId ?? null } as Prisma.InputJsonObject,
    rootsJson: [],
  } });
}

function snapshotMatches(snapshot: unknown, current: unknown): boolean {
  if (snapshot instanceof Date || current instanceof Date) return JSON.stringify(snapshot) === JSON.stringify(current);
  if (Array.isArray(snapshot)) return Array.isArray(current) && snapshot.length === current.length
    && snapshot.every((entry, index) => snapshotMatches(entry, current[index]));
  if (isRecord(snapshot)) return isRecord(current) && Object.entries(snapshot)
    .every(([field, value]) => snapshotMatches(value, current[field]));
  return snapshot === current;
}

/** Capture the complete verified prompt inputs before generation, including their exact revisions. */
export async function captureArtifactInputProof(actor: AppActor, workspaceId: string,
  inputs: Array<LineageInput & { snapshot?: Record<string, unknown> }>, db: LineageClient = prisma) {
  const membership = await requireWorkspaceMembership({ actor, workspaceId });
  const domains = await resolveKnowledgeAccessDomains(actor, workspaceId);
  const roots = new Map<string, LineageRoot>();
  const memo = new Map<string, boolean>();
  const add = (root: LineageRoot) => {
    const key = `${root.kind}:${root.id}`;
    const earlier = roots.get(key);
    invariant(!earlier || earlier.fingerprint === root.fingerprint, 409, "SOURCE_CHANGED", "Input revisions conflict.");
    roots.set(key, root);
  };
  for (const input of inputs) {
    const loaded = await loadArtifact(db, workspaceId, input);
    invariant(isRecord(loaded), 409, "SOURCE_CHANGED", "A prompt input is unavailable.");
    const row: Record<string, unknown> = loaded;
    if (input.snapshot) {
      for (const field of fingerprintFields(input.kind)) {
        if (field in input.snapshot) invariant(snapshotMatches(input.snapshot[field], row[field]),
          409, "SOURCE_CHANGED", "A prompt input changed before generation.");
      }
    }
    const root = { kind: input.kind, id: input.id, fingerprint: lineageContentFingerprint(input.kind, row) };
    invariant(await rootIsReadable(db, actor, workspaceId, membership, domains, root, new Set(), memo),
      409, "UNKNOWN_LINEAGE", "A prompt input's permissions cannot be verified.");
    add(root);
    const manifest = await latestManifest(db, workspaceId, input);
    if (needsManifest(input.kind, row) || manifest) {
      const upstream = manifest ? parseRoots(manifest.rootsJson) : null;
      invariant(upstream, 409, "UNKNOWN_LINEAGE", "A prompt input has incomplete lineage.");
      upstream.forEach(add);
    }
  }
  const proof = [...roots.values()];
  observeArtifactRead(actor, workspaceId, proof);
  return proof;
}

/** Revalidate a captured receipt for the current reader, without returning source metadata. */
export async function isArtifactInputProofReadable(actor: AppActor, workspaceId: string,
  roots: readonly LineageRoot[], db: LineageClient = prisma) {
  const membership = await requireWorkspaceMembership({ actor, workspaceId });
  const domains = await resolveKnowledgeAccessDomains(actor, workspaceId);
  const memo = new Map<string, boolean>();
  for (const root of roots) {
    if (!await rootIsReadable(db, actor, workspaceId, membership, domains, root, new Set(), memo)) return false;
  }
  return roots.length > 0;
}

/** After a trusted writer preserves an input revision, retain the exact bytes through its immutable receipt. */
export async function rebaseArtifactInputProofToSnapshots(actor: AppActor, workspaceId: string, roots: readonly LineageRoot[], db: LineageClient = prisma) {
  const rebased: LineageRoot[] = [];
  for (const root of roots) {
    if (await isArtifactInputProofReadable(actor, workspaceId, [root], db)) { rebased.push(root); continue; }
    const snapshots = await db.artifactInputSnapshot.findMany({ where: { workspaceId,
      sourceKind: root.kind, sourceId: root.id, sourceFingerprint: root.fingerprint,
      origin: { in: ["HUMAN_ORIGINAL", "DERIVED"] } }, orderBy: { id: "asc" }, take: 100 });
    let replacement: LineageRoot | undefined;
    for (const row of snapshots) {
      const candidate: LineageRoot = { kind: "ArtifactInputSnapshot", id: row.id, fingerprint: lineageContentFingerprint("ArtifactInputSnapshot", row) };
      if (await isArtifactInputProofReadable(actor, workspaceId, [candidate], db)) { replacement = candidate; break; }
    }
    invariant(replacement, 409, "SOURCE_CHANGED", "A consumed input was not preserved by this mutation.");
    rebased.push(replacement);
  }
  invariant(await isArtifactInputProofReadable(actor, workspaceId, rebased, db), 409, "SOURCE_CHANGED", "Preserved input permissions changed.");
  return rebased;
}

/** Public destinations have no reliable per-user membership/finance entitlement. */
export async function isArtifactInputProofPubliclyShareable(actor: AppActor, workspaceId: string,
  roots: readonly LineageRoot[], db: LineageClient = prisma) {
  if (!await isArtifactInputProofReadable(actor, workspaceId, roots, db)) return false;
  const seen = new Set<string>();
  const visit = async (root: LineageRoot): Promise<boolean> => {
    const key = `${root.kind}:${root.id}:${root.fingerprint}`;
    if (seen.has(key)) return true;
    seen.add(key);
    const loaded = await loadArtifact(db, workspaceId, root);
    if (!isRecord(loaded)) return false;
    const privateEnvelope = (kind: LineageKind, row: Record<string, unknown>) => row.isPrivate === true
      || row.accessDomain === "FINANCE" || ["AgentRequestInput", "AgentFeedbackInput", "ConversationPendingOperation", "ConversationPromptInput", "ConversationSession", "ConversationTurn", "RoleOnboardingSession", "CheckIn", "Notification", "NewspaperDelivery"].includes(kind)
      || (kind === "Recognition" && row.visibility !== "WORKSPACE")
      || (kind === "AdviceRequest" && row.audienceType !== "WORKSPACE")
      || (kind === "ContextMapView" && row.createdByUserId != null)
      || (kind === "BuildArtifact" && (row.visibility !== "PUBLIC_REVIEW" || row.classification !== "OPEN_CORE"));
    if (privateEnvelope(root.kind, loaded)) return false;
    const parentKinds: Record<string, LineageKind> = { BRAIN_ARTICLE: "BrainArticle", DOCUMENT: "Document", MEETING: "Meeting",
      PROPOSAL: "Proposal", ACTION: "Action", TENSION: "Tension" };
    const parent = root.kind === "KnowledgeChunk" ? { kind: parentKinds[String(loaded.sourceType)], id: String(loaded.sourceId) }
      : root.kind === "DeliberationEntry" ? { kind: parentKinds[String(loaded.parentType)], id: String(loaded.parentId) }
        : ["KeyResult", "GoalUpdate"].includes(root.kind) ? { kind: "Goal" as const, id: String(loaded.goalId) }
          : root.kind === "MeetingInsight" ? { kind: "Meeting" as const, id: String(loaded.meetingId) }
            : root.kind === "BuildArtifactAsset" ? { kind: "BuildArtifact" as const, id: String(loaded.artifactId) }
              : root.kind === "ActionChecklistItem" ? { kind: "Action" as const, id: String(loaded.actionId) }
                : root.kind === "TensionUpvote" ? { kind: "Tension" as const, id: String(loaded.tensionId) }
                  : root.kind === "PolicyCorpus" ? { kind: "Proposal" as const, id: String(loaded.proposalId) } : null;
    if (parent) {
      if (!parent.kind) return false;
      const parentRow = await loadArtifact(db, workspaceId, parent);
      if (!isRecord(parentRow) || privateEnvelope(parent.kind, parentRow)) return false;
    }
    let upstream: LineageRoot[] | null = [];
    if (root.kind === "ArtifactInputSnapshot") {
      if (!isRecord(loaded.accessEnvelopeJson) || privateEnvelope(loaded.sourceKind as LineageKind, loaded.accessEnvelopeJson)) return false;
      const original = await loadArtifact(db, workspaceId, { kind: loaded.sourceKind as LineageKind, id: String(loaded.sourceId) });
      if (!isRecord(original) || privateEnvelope(loaded.sourceKind as LineageKind, original)) return false;
      upstream = parseRoots(loaded.rootsJson as Prisma.JsonValue);
    } else if (root.kind === "BrainArticleVersion") {
      if (!isRecord(loaded.accessEnvelopeJson) || loaded.accessEnvelopeJson.isPrivate === true) return false;
      const parent = await loadArtifact(db, workspaceId, { kind: "BrainArticle", id: String(loaded.articleId) });
      if (!isRecord(parent) || parent.isPrivate === true) return false;
    }
    const manifest = await latestManifest(db, workspaceId, root);
    if (needsManifest(root.kind, loaded) || manifest) {
      upstream = manifest ? parseRoots(manifest.rootsJson) : null;
    }
    if (!upstream) return false;
    for (const input of upstream) if (!await visit(input)) return false;
    return true;
  };
  for (const root of roots) if (!await visit(root)) return false;
  return true;
}

async function latestManifest(db: LineageClient, workspaceId: string, input: LineageInput) {
  return db.artifactInputLineage.findFirst({ where: {
    workspaceId, artifactType: input.kind, artifactId: input.id,
  }, orderBy: { revision: "desc" } });
}

/** Internal dependency discovery grants no read access and returns no source content. */
export async function inspectStoredArtifactInputDependencies(db: LineageClient, workspaceId: string,
  inputs: readonly LineageRoot[]) {
  const dependencies = new Map<string, LineageRoot>();
  const memo = new Map<string, boolean>();
  const visit = async (root: LineageRoot, visiting = new Set<string>()): Promise<boolean> => {
    const key = `${root.kind}:${root.id}:${root.fingerprint}`;
    if (visiting.has(key)) return false;
    if (memo.has(key)) return memo.get(key)!;
    dependencies.set(key, root);
    const row = await loadArtifact(db, workspaceId, root);
    if (!row) return false;
    let upstream: LineageRoot[] | null = [];
    if (root.kind === "ArtifactInputSnapshot") {
      if (lineageContentFingerprint(root.kind, row) !== root.fingerprint || typeof row.sourceKind !== "string"
        || !(row.sourceKind in CONTENT_FIELDS) || row.sourceKind === "ArtifactInputSnapshot") return false;
      const source = { kind: row.sourceKind as LineageKind, id: String(row.sourceId), fingerprint: String(row.sourceFingerprint) };
      dependencies.set(`${source.kind}:${source.id}:${source.fingerprint}`, source);
      upstream = parseRoots(row.rootsJson as Prisma.JsonValue);
      if (!upstream || !["HUMAN_ORIGINAL", "DERIVED"].includes(String(row.origin))
        || (row.origin === "DERIVED" && !upstream.length)) return false;
    } else {
      // Follow the revision that was actually consumed, including preserved
      // historical manifests. A newer revision cannot redefine old ancestry.
      const manifest = await db.artifactInputLineage.findFirst({ where: { workspaceId,
        artifactType: root.kind, artifactId: root.id, contentHash: root.fingerprint }, orderBy: { revision: "desc" } });
      if (manifest) {
        upstream = parseRoots(manifest.rootsJson);
        if (!upstream || !["HUMAN_ORIGINAL", "DERIVED"].includes(manifest.origin)
          || (manifest.origin === "DERIVED" && !upstream.length)) return false;
      } else if (needsManifest(root.kind, row)) return false;
      if (root.kind === "KnowledgeChunk") {
        const kinds: Record<string, LineageKind> = { BRAIN_ARTICLE: "BrainArticle", DOCUMENT: "Document", MEETING: "Meeting", PROPOSAL: "Proposal" };
        if (!kinds[String(row.sourceType)] || !isRecord(row.metadata) || typeof row.metadata.sourceContentHash !== "string") return false;
        upstream = [...(upstream ?? []), { kind: kinds[String(row.sourceType)], id: String(row.sourceId), fingerprint: row.metadata.sourceContentHash }];
      }
    }
    for (const input of upstream ?? []) if (!await visit(input, new Set(visiting).add(key))) {
      memo.set(key, false);
      return false;
    }
    memo.set(key, true);
    return true;
  };
  let complete = true;
  for (const input of inputs) if (!await visit(input)) complete = false;
  return { complete, roots: [...dependencies.values()] };
}

/** A manifest is a proof of complete input capture, not a model's citation list. */
export async function recordArtifactInputLineage(params: {
  tx: Prisma.TransactionClient;
  actor: AppActor;
  workspaceId: string;
  artifact: LineageInput;
  content: unknown;
  origin: "HUMAN_ORIGINAL" | "DERIVED";
  inputs: LineageInput[];
  inheritedRoots?: LineageRoot[];
  /** Mutable graph inputs retain immutable content receipts with live permission checks. */
  transitiveOnlyKinds?: LineageKind[];
}) {
  await assertArtifactInputWriteFence(params.tx);
  const { tx, actor, workspaceId, artifact, content } = params;
  const membership = await requireWorkspaceMembership({ actor, workspaceId, tx });
  invariant(params.origin !== "HUMAN_ORIGINAL" || (actor.kind === "user" && params.inputs.length === 0 && !params.inheritedRoots?.length),
    409, "UNKNOWN_LINEAGE", "Only a direct human original can have an empty input manifest.");
  invariant(params.origin !== "HUMAN_ORIGINAL" || !["AgentMemory", "ConversationTurn", "CommunicationContextSummary", "WorkspaceBriefing",
    "NewspaperEdition", "NewspaperDelivery", "NewspaperTrackedLink", "Notification", "AgentRun", "AgentStep", "AgentToolCall"].includes(artifact.kind),
  409, "UNKNOWN_LINEAGE", "Generated or copied content requires its complete input receipt.");
  const domains = await resolveKnowledgeAccessDomains(actor, workspaceId);
  const roots = new Map<string, LineageRoot>();
  const transitiveOnly = new Set(params.transitiveOnlyKinds ?? []);
  const rootMemo = new Map<string, boolean>();
  const snapshotMemo = new Map<string, Promise<Awaited<ReturnType<typeof snapshotInput>>>>();
  const addRoot = (root: LineageRoot) => {
    const key = `${root.kind}:${root.id}`;
    const existing = roots.get(key);
    invariant(!existing || existing.fingerprint === root.fingerprint, 409, "SOURCE_CHANGED", "Input revisions conflict.");
    roots.set(key, root);
  };
  const snapshotForRoot = (root: LineageRoot): Promise<Awaited<ReturnType<typeof snapshotInput>>> => {
    const key = `${root.kind}:${root.id}:${root.fingerprint}`;
    let snapshot = snapshotMemo.get(key);
    if (!snapshot) {
      snapshot = snapshotInput(tx, workspaceId, root, async (inputs) => {
        const converted = new Map<string, LineageRoot>();
        for (const input of inputs) {
          const receipt = transitiveOnly.has(input.kind) ? await snapshotForRoot(input) : { root: input, roots: [] };
          for (const item of [receipt.root, ...receipt.roots]) converted.set(`${item.kind}:${item.id}`, item);
        }
        return [...converted.values()];
      });
      snapshotMemo.set(key, snapshot);
    }
    return snapshot;
  };
  const expandRoot = async (root: LineageRoot, visited = new Set<string>()): Promise<void> => {
    invariant(await rootIsReadable(tx, actor, workspaceId, membership, domains, root, new Set(), rootMemo),
      409, "SOURCE_CHANGED", "An earlier input is no longer available.");
    if (!transitiveOnly.has(root.kind)) {
      addRoot(root);
      if (root.kind === "ArtifactInputSnapshot") {
        const snapshot = await tx.artifactInputSnapshot.findFirst({ where: { id: root.id, workspaceId } });
        const upstream = snapshot ? parseRoots(snapshot.rootsJson) : null;
        invariant(upstream, 409, "UNKNOWN_LINEAGE", "An immutable input has incomplete lineage.");
        upstream.forEach(addRoot);
      }
      return;
    }
    const key = `${root.kind}:${root.id}`;
    invariant(!visited.has(key), 409, "UNKNOWN_LINEAGE", "Input lineage is cyclic.");
    const snapshot = await snapshotForRoot(root);
    addRoot(snapshot.root);
    snapshot.roots.forEach(addRoot);
  };
  for (const root of params.inheritedRoots ?? []) await expandRoot(root);
  for (const input of params.inputs) {
    const row = await loadArtifact(tx, workspaceId, input);
    invariant(isRecord(row) && !isArchived(row), 409, "SOURCE_CHANGED", "An input is unavailable.");
    const fingerprint = input.kind === "BrainSource"
      ? brainSourceContentFingerprint(row as Parameters<typeof brainSourceContentFingerprint>[0])
      : lineageContentFingerprint(input.kind, row);
    const directRoot = { ...input, fingerprint };
    invariant(await rootIsReadable(tx, actor, workspaceId, membership, domains, directRoot, new Set(), rootMemo),
      409, "SOURCE_RESTRICTED", "An input is not accessible.");
    await expandRoot(directRoot);
    const parent = await latestManifest(tx, workspaceId, input);
    if (needsManifest(input.kind, row) || parent) {
      invariant(parent && parent.contentHash === fingerprint, 409, "UNKNOWN_LINEAGE", "An input has incomplete lineage.");
      const parentRoots = parseRoots(parent.rootsJson);
      invariant(parentRoots, 409, "UNKNOWN_LINEAGE", "An input has invalid lineage.");
      for (const root of parentRoots) await expandRoot(root);
    }
  }
  invariant(params.origin !== "DERIVED" || params.inputs.length > 0 || roots.size > 0,
    409, "UNKNOWN_LINEAGE", "Derived content requires complete input lineage.");
  const previous = await latestManifest(tx, workspaceId, artifact);
  return tx.artifactInputLineage.create({ data: {
    workspaceId, artifactType: artifact.kind, artifactId: artifact.id,
    revision: (previous?.revision ?? 0) + 1, origin: params.origin,
    contentHash: lineageContentFingerprint(artifact.kind, content),
    inputsJson: params.inputs as Prisma.InputJsonArray,
    rootsJson: [...roots.values()] as Prisma.InputJsonArray,
  } });
}

/** Preserve the prior body's exact permissions when saving article history. */
export async function copyArtifactInputLineage(params: {
  tx: Prisma.TransactionClient;
  workspaceId: string;
  from: LineageInput;
  fromContent: unknown;
  to: LineageInput;
  toContent: unknown;
}) {
  await assertArtifactInputWriteFence(params.tx);
  const prior = await latestManifest(params.tx, params.workspaceId, params.from);
  if (!prior || prior.contentHash !== lineageContentFingerprint(params.from.kind, params.fromContent)
    || !parseRoots(prior.rootsJson)) return false;
  await params.tx.artifactInputLineage.create({ data: {
    workspaceId: params.workspaceId,
    artifactType: params.to.kind,
    artifactId: params.to.id,
    revision: 1,
    origin: prior.origin,
    contentHash: lineageContentFingerprint(params.to.kind, params.toContent),
    inputsJson: prior.inputsJson as Prisma.InputJsonValue,
    rootsJson: prior.rootsJson as Prisma.InputJsonValue,
  } });
  return true;
}

/** Carry verified input permissions across a direct human edit of the same artifact. */
export async function advanceHumanArtifactInputLineage(params: {
  tx: Prisma.TransactionClient;
  actor: AppActor;
  workspaceId: string;
  artifact: LineageInput;
  before: unknown;
  after: unknown;
  /** Only for a deterministic workflow transition with no new permission-bearing input. */
  allowSystemTransition?: boolean;
}) {
  await assertArtifactInputWriteFence(params.tx);
  const { tx, actor, workspaceId, artifact, before, after } = params;
  const previous = await latestManifest(tx, workspaceId, artifact);
  const roots = await currentArtifactInputRoots(tx, workspaceId, artifact, before);
  if ((actor.kind !== "user" && !params.allowSystemTransition) || !previous || !roots) {
    await invalidateArtifactInputLineage({ tx, workspaceId, artifact, content: after });
    return false;
  }
  const membership = await requireWorkspaceMembership({ actor, workspaceId, tx });
  const domains = await resolveKnowledgeAccessDomains(actor, workspaceId);
  for (const root of roots) {
    invariant(await rootIsReadable(tx, actor, workspaceId, membership, domains, root),
      409, "SOURCE_RESTRICTED", "An earlier input is no longer accessible.");
  }
  await tx.artifactInputLineage.create({ data: {
    workspaceId, artifactType: artifact.kind, artifactId: artifact.id,
    revision: previous.revision + 1, origin: previous.origin,
    contentHash: lineageContentFingerprint(artifact.kind, after),
    inputsJson: previous.inputsJson as Prisma.InputJsonValue,
    rootsJson: previous.rootsJson as Prisma.InputJsonValue,
  } });
  return true;
}

/** Explicitly remove any old proof after a writer cannot attest its complete inputs. */
export async function invalidateArtifactInputLineage(params: {
  tx: Prisma.TransactionClient;
  workspaceId: string;
  artifact: LineageInput;
  content: unknown;
}) {
  await assertArtifactInputWriteFence(params.tx);
  const previous = await latestManifest(params.tx, params.workspaceId, params.artifact);
  return params.tx.artifactInputLineage.create({ data: {
    workspaceId: params.workspaceId,
    artifactType: params.artifact.kind,
    artifactId: params.artifact.id,
    revision: (previous?.revision ?? 0) + 1,
    origin: "UNKNOWN",
    contentHash: lineageContentFingerprint(params.artifact.kind, params.content),
    inputsJson: Prisma.JsonNull,
    rootsJson: Prisma.JsonNull,
  } });
}

export async function hasCurrentArtifactInputLineage(db: LineageClient, workspaceId: string,
  artifact: LineageInput, content: unknown) {
  const manifest = await latestManifest(db, workspaceId, artifact);
  return Boolean(manifest && manifest.contentHash === lineageContentFingerprint(artifact.kind, content)
    && parseRoots(manifest.rootsJson));
}

export async function currentArtifactInputRoots(db: LineageClient, workspaceId: string,
  artifact: LineageInput, content: unknown) {
  const manifest = await latestManifest(db, workspaceId, artifact);
  if (!manifest || manifest.contentHash !== lineageContentFingerprint(artifact.kind, content)) return null;
  return parseRoots(manifest.rootsJson);
}

/** Returns only ids whose current content and every permission-bearing input are provably safe. */
export async function readableArtifactIds(actor: AppActor, workspaceId: string,
  kind: LineageKind, records: Array<{ id: string; [key: string]: unknown }>, db: LineageClient = prisma) {
  const membership = await requireWorkspaceMembership({ actor, workspaceId });
  const domains = await resolveKnowledgeAccessDomains(actor, workspaceId);
  const manifests = await db.artifactInputLineage.findMany({ where: {
    workspaceId, artifactType: kind, artifactId: { in: records.map((record) => record.id) },
  }, orderBy: { revision: "desc" } });
  const latest = new Map<string, typeof manifests[number]>();
  for (const manifest of manifests) if (!latest.has(manifest.artifactId)) latest.set(manifest.artifactId, manifest);
  const rootCache = new Map<string, boolean>();
  const visible = new Set<string>();
  for (const record of records) {
    if ("workspaceId" in record && record.workspaceId !== workspaceId) continue;
    if (!needsManifest(kind, record)) {
      if (await rootIsReadable(db, actor, workspaceId, membership, domains,
        { kind, id: record.id, fingerprint: lineageContentFingerprint(kind, record) }, new Set(), rootCache)) visible.add(record.id);
      continue;
    }
    const manifest = latest.get(record.id);
    if (!manifest || manifest.contentHash !== lineageContentFingerprint(kind, record)
      || isArchived(record) || !actorCanReadRecord(actor, membership, kind, record)) continue;
    if (!await rootIsReadable(db, actor, workspaceId, membership, domains,
      { kind, id: record.id, fingerprint: manifest.contentHash }, new Set(), rootCache)) continue;
    const roots = parseRoots(manifest.rootsJson);
    if (!roots || (manifest.origin !== "HUMAN_ORIGINAL" && manifest.origin !== "DERIVED")
      || (manifest.origin === "DERIVED" && roots.length === 0)) continue;
    let allowed = true;
    for (const root of roots) {
      const key = `${root.kind}:${root.id}:${root.fingerprint}`;
      if (!rootCache.has(key)) rootCache.set(key, await rootIsReadable(db, actor, workspaceId, membership, domains, root, new Set(), rootCache));
      if (!rootCache.get(key)) { allowed = false; break; }
    }
    if (allowed) visible.add(record.id);
  }
  if (artifactReadCapture.getStore()) {
    for (const record of records.filter((row) => visible.has(row.id))) {
      const manifest = latest.get(record.id);
      const root = { kind, id: record.id, fingerprint: lineageContentFingerprint(kind, record) };
      observeArtifactRead(actor, workspaceId, [root, ...(manifest ? parseRoots(manifest.rootsJson) ?? [] : [])]);
    }
  }
  return visible;
}

/** Direct source listings must not reveal copied/model-generated content without its upstream proof. */
export async function readableBrainSourceIds(actor: AppActor, workspaceId: string,
  records: Array<{ id: string; workspaceId: string; accessDomain: string; archivedAt: Date | null;
    sourceType: string; channel: string | null; [key: string]: unknown }>, db: LineageClient = prisma) {
  await requireWorkspaceMembership({ actor, workspaceId });
  const domains = await resolveKnowledgeAccessDomains(actor, workspaceId);
  const candidates = records.filter((row) => row.workspaceId === workspaceId
    && row.archivedAt === null && domains.some((domain) => domain === row.accessDomain));
  return readableArtifactIds(actor, workspaceId, "BrainSource", candidates, db);
}
