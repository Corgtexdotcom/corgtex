import { hasCompanyLegacyRecoveryCapture, assertCompanyLegacyRecoveryCaptureCurrent } from "./legacy-recovery-context";
import { hasCompanyTranscriptPublicationScope } from "./native-transcript-publication-context";
import { getMeetingTranscriptWorkerPurpose, isMeetingTranscriptWorkerCurrent } from "./native-meeting-workflow-principal";
import type { BoundedSnapshotReads } from "./source-snapshot-read-pass";
import { getBrainExportWorkerPurpose, isBrainExportWorkerCurrent } from "./brain-export-worker";
import { canReadInformationCategory, categoryGovernorIdentities, CATEGORY_BOUND_SOURCE_KINDS } from "./information-category-policy";
import { financeFactValue, financeValueHash, isFinanceFactRevisionIntact } from "./finance-fact-value";
import { getTranscriptSourceImportPurpose, getRecorderTranscriptWorkerPurpose, nativeTranscriptPrincipalUserId } from "./native-transcript-principal";
import { artifactPermissionEpochIdentities, capturePermissionEpochs, isArtifactPermissionEpochProofCurrent, mergePermissionEpochProofs, parsePermissionEpochProof, withSourceCommitPermissionReadPass, withExternalProviderPermissionReadPass, withArtifactPermissionBatchRead, type PermissionEpochProof } from "./source-permission-epochs";
import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { assertArtifactInputWriteFence } from "./artifact-input-write-fence";
export { assertArtifactInputWriteFence, withArtifactInputWriteFence, withAdditionalArtifactInputWriteFence,
  type ArtifactInputWriteFence } from "./artifact-input-write-fence";
import { Prisma } from "@prisma/client";
import { prisma, mcpCredentialVersion, mcpScopesHash, type AppActor } from "@corgtex/shared";
import { requireWorkspaceMembership } from "./auth";
import { resolveKnowledgeAccessDomains } from "./brain-access";
import { brainSourceContentFingerprint } from "./brain-derivation";
import { AppError, invariant } from "./errors";
import { internalSourcePermission } from "./internal-source-principal";
import { getMcpToolInputRoots } from "./mcp-tool-input-context";
import { isMcpToolInputEncryptedPayload } from "./mcp-tool-input-cipher";
import { getExternalProviderPrincipalUserId } from "./external-provider-principal";
import { artifactPermissionParents, loadArtifactPermissionMetadata, withArtifactPermissionMetadataRead } from "./source-permission-parents";
import { loadExternalMcpConnectionSetInput } from "./external-mcp-connection-set";
import { assertMcpOriginActive, getMcpOrigin } from "../../shared/src/mcp-context";
import { assertSourceCommitRowCovered, assertSourceCommitTransactionCompatible,
  assertSourceCommitSemanticRootCovered, registerSourceCommitPublishedOutput,
  hasActiveSourceCommitLockPlan, sourceCommitCanonical } from "./source-commit-lock-plan";
import { sourceAuthorityPhysicalRow } from "./source-authority-edges";
import { assertSourceCommitMcpOriginCovered } from "./source-commit-row-locks";
import { allocateArtifactInputSnapshotId } from "./artifact-input-snapshot-allocations";
import { reserveArtifactWriteHeads } from "./artifact-write-heads";
import { sealArtifactInputActor } from "./artifact-input-actor";
export { sealArtifactInputActor } from "./artifact-input-actor";

type ArtifactReadCapture = { actor: AppActor; workspaceId: string; roots: Map<string, LineageRoot>; preserveConsumedRevisions: boolean };
const artifactReadCapture = new AsyncLocalStorage<ArtifactReadCapture>();

/** Direct presentation authority cannot become source/copy/model authority. Call
 * before fetching or returning its body, including inside a nested capture. */
export function assertDirectArtifactReadOutsideCapture() {
  invariant(!artifactReadCapture.getStore(), 409, "UNKNOWN_LINEAGE",
    "Direct presentation content cannot be consumed as an artifact input.");
}

function observeArtifactRead(actor: AppActor, workspaceId: string, roots: readonly LineageRoot[]) {
  const scope = artifactReadCapture.getStore();
  if (!scope || scope.actor !== actor || scope.workspaceId !== workspaceId) return;
  for (const root of roots) {
    const key = `${root.kind}:${root.id}${scope.preserveConsumedRevisions ? `:${root.fingerprint}` : ""}`;
    const prior = scope.roots.get(key);
    scope.roots.set(key, mergeLineageInputRoot(prior, root));
  }
}

/** For audited server readers: collect proofs at their permission gates, before formatting their output. */
export async function withArtifactInputReadCapture<T>(actor: AppActor, workspaceId: string, read: () => Promise<T>, options?: { preserveConsumedRevisions?: boolean }) {
  const scope: ArtifactReadCapture = { actor, workspaceId, roots: new Map(), preserveConsumedRevisions: options?.preserveConsumedRevisions === true };
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

async function assertPlannedArtifactPublication(tx: Prisma.TransactionClient, workspaceId: string,
  artifact: LineageInput) {
  assertSourceCommitTransactionCompatible(tx);
  if (hasActiveSourceCommitLockPlan(tx)) await reserveArtifactWriteHeads(tx, workspaceId, [artifact]);
}

export type LineageKind =
  | "ExternalDataSource" | "SqlNativeRunInput" | "MeetingAudioAsset" | "NativeTranscriptInput" | "CommunicationMessageNativeInput" | "GenericDerivedArtifactVariant" | "ExternalProviderFetchInput" | "ExternalContentSource"
  | "ExternalMcpResponseInput" | "ExternalMcpConnectionSet"
  | "WorkspaceToolLink" | "WorkspaceToolLinkCredential" | "ConversationOperationOutcome"
  | "FinanceReportUploadInput" | "CrmQualificationFormInput" | "ExecutionRequest" | "ExecutionResult"
  | "FinanceImportBatch" | "FinanceImportCandidate" | "FinanceReport" | "FinanceReportFact" | "FinanceReportFactRevision" | "FinanceImportApplication"
  | "McpToolInput" | "ConversationIngressInput" | "DemoLeadIntakeInput" | "CrmQualificationEmailInput" | "DemoLead" | "CrmQualification" | "WorkflowJobInput"
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
export type LineageRoot = LineageInput & { fingerprint: string; permissionEpochs?: PermissionEpochProof };
export function mergeLineageInputRoot(previous: LineageRoot | undefined, root: LineageRoot): LineageRoot {
  invariant(!previous || (previous.kind === root.kind && previous.id === root.id && previous.fingerprint === root.fingerprint),
    409, "SOURCE_CHANGED", "Input revisions changed during collection.");
  const permissionEpochs = mergePermissionEpochProofs(previous?.permissionEpochs, root.permissionEpochs);
  return permissionEpochs ? { ...root, permissionEpochs } : { ...root };
}
type LineageClient = Prisma.TransactionClient | typeof prisma;

/** Source category cannot prove authorship or the inputs of a copier/model. */
export function brainSourceNeedsLineage(_row: { sourceType?: unknown; channel?: unknown }) {
  return true;
}

const CONTENT_FIELDS: Record<LineageKind, string[]> = {
  ExternalDataSource: ["workspaceId", "label", "driverType", "connectionStringEnc", "selectedTables", "cursorColumn", "accessDomain", "informationCategory", "isRestricted", "allowedRoleIds", "allowedCircleIds", "isActive", "archivedAt"],
  SqlNativeRunInput: ["workspaceId", "sourceId", "attemptId", "generation", "configurationFingerprint", "sourcePermissionEpoch", "permissionEpochsJson", "encryptedPayload", "payloadHash", "rowsProcessed", "nextCursor"],
  MeetingAudioAsset: ["meetingId", "uploadedByUserId", "fileName", "mimeType", "storageKey", "sizeBytes", "durationSeconds", "title", "recordedAt", "participantEmails", "status", "transcriptText", "transcriptProvider", "transcriptModel", "transcriptMetadata", "intakeMeetingId", "workflowJobId", "failureCode", "failureMessage", "transcribedAt", "ingestedAt"],
  NativeTranscriptInput: ["workspaceId", "mode", "ownerMemberId", "submittedByUserId", "meetingAudioAssetId", "sourceRecordId", "connectionId", "recordingId", "storageKey", "fileHash", "fileSizeBytes", "mimeType", "encryptedPayloadJson", "payloadHash", "grantHash"],
  CommunicationMessageNativeInput: ["workspaceId", "installationId", "communicationMessageId", "provider", "externalWorkspaceId", "appId", "providerPrincipalId", "externalChannelId", "externalMessageId", "externalUserId", "threadExternalId", "mode", "ingressInputId", "requestJson", "encryptedPayloadJson", "projectedContentJson", "projectionHash", "installationGrantHash", "channelGrantHash", "permissionEpochsJson", "epochProofVersion", "expiresRawAt", "fetchedAt"],
  GenericDerivedArtifactVariant: ["workspaceId", "targetKind", "targetId", "ownerMemberId", "recipeVersion", "generatorKey", "generatorVersion", "instructionHash", "targetFingerprint", "inputSetHash", "sourceStateJson", "targetsJson", "scopeJson", "payloadJson", "generationJobId"],
  ExternalProviderFetchInput: ["workspaceId", "externalContentSourceId", "connectionId", "localUserId", "providerKey", "serverUrl", "providerAccountId", "sourceKind", "externalId", "toolName", "requestJson", "encryptedResponseJson", "responseHash", "connectionGrantHash", "fetchedAt"],
  ExternalMcpResponseInput: ["workspaceId", "connectionId", "localUserId", "providerKey", "serverUrl", "providerAccountId", "mode", "toolName", "requestJson", "encryptedResponseJson", "responseHash", "connectionGrantHash", "originalLocalEpochsJson", "fetchedAt"],
  ExternalMcpConnectionSet: ["workspaceId", "localUserId", "epoch"],
  ExternalContentSource: ["workspaceId", "connectionId", "selectedByUserId", "providerKey", "sourceKind", "externalId", "title", "externalUrl", "syncMode", "status", "lastRemoteVersion", "lastSyncedAt", "lastSyncError", "metadata", "archivedAt", "archivedByUserId", "archiveReason"],
  FinanceReport: ["workspaceId", "reportType", "basis", "cadence", "currency", "periodStart", "periodEnd", "asOfDate", "title", "status", "sourceBatchId", "version"],
  FinanceReportFactRevision: ["workspaceId", "factId", "factVersion", "reportId", "accountPath", "kind", "periodStart", "periodEnd", "amountCents", "dimensions", "semanticKey", "sourceBatchId", "sourceCandidateId", "appliedByUserId", "approvedByUserId", "approvedAt", "candidateVersion", "valueHash", "recipeJson", "recipeHash"],
  FinanceReportFact: ["workspaceId", "reportId", "accountPath", "kind", "periodStart", "periodEnd", "amountCents", "dimensions", "semanticKey", "sourceBatchId", "sourceCandidateId", "appliedByUserId", "version"],
  FinanceImportApplication: ["workspaceId", "batchId", "candidateId", "idempotencyKey", "targetType", "targetFactId", "beforeRevisionId", "afterRevisionId", "beforeValueJson", "afterValueJson", "beforeValueHash", "afterValueHash", "outcome", "appliedByUserId", "appliedAt"],

  FinanceImportBatch: ["workspaceId", "uploadedByUserId", "documentId", "brainSourceId", "workflowJobId", "agentRunId", "fileHash", "mimeType", "originalFilename", "fileSizeBytes", "stage", "safeErrorCode", "safeErrorMessage", "retryCount", "reportType", "basis", "cadence", "periodStart", "periodEnd", "asOfDate", "title", "currencyState", "resolvedCurrency", "currencyResolutionSource", "currencyConfirmedByUserId", "currencyConfirmedAt", "interpretationJson", "addCount", "updateCount", "unchangedCount", "duplicateCount", "conflictCount", "skippedCount", "warningCount", "blockerCount", "rejectedCount", "appliedCount", "approvedByUserId", "approvedAt", "appliedByUserId", "appliedAt", "version"],
  FinanceImportCandidate: ["workspaceId", "batchId", "sourceKey", "sourceLocation", "sourceLabel", "sourcePath", "proposedAccountPath", "factKind", "periodStart", "periodEnd", "amountCents", "dimensions", "extractionJson", "proposalJson", "action", "reviewState", "semanticKey", "currentFactId", "currentFactRevisionId", "currentAmountCents", "confidenceBps", "evidenceMd", "explanationMd", "editedByUserId", "editedAt", "approvedByUserId", "approvedAt", "version"],
  FinanceReportUploadInput: ["workspaceId", "batchId", "documentId", "brainSourceId", "uploadedByUserId", "fileHash", "storageKey", "mimeType", "fileSizeBytes", "originalFilename"],
  CrmQualificationFormInput: ["workspaceId", "demoLeadId", "qualificationId", "companyName", "website", "roleTitle", "aiExperience", "helpNeeded"],
  ExecutionRequest: ["workspaceId", "createdByUserId", "agentCredentialId", "provider", "status", "goal", "actorJson", "contextJson", "allowedScopes", "policyConstraintsJson", "expectedOutputJson", "approvalRule", "writebackTargetType", "writebackTargetId", "writebackTargetLabel", "packetJson", "idempotencyKey", "claimedAt", "completedAt", "failedAt", "cancelledAt"],
  ExecutionResult: ["workspaceId", "executionRequestId", "submittedByUserId", "agentCredentialId", "status", "idempotencyKey", "targetType", "targetId", "outputJson", "artifactJson", "errorMessage", "writebackEntityType", "writebackEntityId", "submittedAt", "acceptedAt", "rejectedAt"],
  ConversationOperationOutcome: ["workspaceId", "actorKind", "userId", "credentialId", "credentialVersion", "scopeHash", "operation", "requestKey", "requiredScopes", "controlJson"],
  WorkspaceToolLink: ["workspaceId", "createdByUserId", "title", "url", "category", "descriptionMd", "accessNotesMd", "previewTitle", "previewDescription", "previewImageUrl", "previewFaviconUrl", "credentialLabel", "credentialSecretEnc", "archivedAt", "archivedByUserId", "archiveReason", "circleTags"],
  WorkspaceToolLinkCredential: ["workspaceId", "createdByUserId", "credentialLabel", "credentialSecretEnc", "archivedAt", "archivedByUserId", "archiveReason"],
  McpToolInput: ["workspaceId", "actorKind", "userId", "credentialId", "credentialVersion", "scopeHash", "toolName", "argumentsJson", "requiredScopes"],
  ConversationIngressInput: ["workspaceId", "actorKind", "userId", "credentialId", "credentialVersion", "scopeHash", "content"],
  DemoLeadIntakeInput: ["workspaceId", "email", "source"],
  CrmQualificationEmailInput: ["workspaceId", "demoLeadId", "responseChannel", "rawEmailReply", "rawEmailSubject"],
  DemoLead: ["workspaceId", "email", "companyHint", "source", "utmSource", "convertedContactId", "followUpCount", "lastFollowUpAt", "convertedAt"],
  CrmQualification: ["workspaceId", "demoLeadId", "responseChannel", "companyName", "website", "roleTitle", "aiExperience", "helpNeeded", "rawEmailReply", "rawEmailSubject", "status", "reviewNote", "reviewedByUserId", "reviewedAt", "schedulingEmailSentAt"],
  WorkflowJobInput: ["workspaceId", "eventId", "type", "payload"],
  AgentRequestInput: ["workspaceId", "userId", "agentKey", "prompt", "meetingId", "proposalId"],
  AgentFeedbackInput: ["workspaceId", "agentRunId", "stepId", "priorRunSnapshotId", "userId", "content"],
  ConversationPendingOperation: ["conversationId", "userId", "agentKey", "toolName", "argsJson", "argsHash", "idempotencyKey", "relatedEntityType", "relatedEntityId", "riskLabel", "resultJson"],
  BrainDiscussionThread: ["articleId", "authorMemberId", "targetType", "targetRef", "status", "resolvedAt", "absorbedAt"],
  BrainDiscussionComment: ["threadId", "authorMemberId", "agentKey", "bodyMd", "agentRunId"],
  AgentRun: ["goal", "planJson", "contextJson", "resultJson", "triggerRef"],
  AgentStep: ["agentRunId", "name", "inputJson", "outputJson", "error", "humanFeedback"],
  AgentToolCall: ["agentRunId", "name", "inputJson", "outputJson", "error"],
  Workspace: ["name", "slug", "description", "plan"],
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
  BrainArticleVersion: ["articleId", "version", "bodyMd", "changeSummary", "agentRunId", "accessEnvelopeJson"],
  Document: ["metadata", "authorMemberId", "mimeType", "title", "source", "storageKey", "textContent", "accessDomain", "archivedAt"],
  Meeting: ["workspaceId", "seriesId", "status", "title", "source", "externalId", "calendarExternalId", "meetingUrl", "meetingUrlHash", "recordedAt", "scheduledEndAt", "transcript", "summaryMd", "blocksJson", "ingestionGuidanceMd", "participantIds", "participantEmails", "decisionsJson", "agendaJson", "agendaChannelId", "agendaMessageTs", "agendaPostedAt", "summaryPostedAt", "aiProcessedAt", "archivedAt", "archivedByUserId", "archiveReason"],
  MeetingTranscript: ["title", "source", "externalId", "calendarExternalId", "meetingUrl", "meetingUrlHash", "transcript", "ingestionGuidanceMd", "recordedAt", "scheduledEndAt", "seriesId", "participantIds", "participantEmails", "archivedAt"],
  MeetingInsight: ["meetingId", "type", "operation", "status", "title", "bodyMd", "assigneeHint", "dueAt", "sourceQuote", "metadataJson", "supersededAt",
    "targetEntityType", "targetEntityId", "appliedEntityType", "appliedEntityId", "deliberationEntryType", "resolutionOutcome", "confidence",
    "sourceRecordId", "sourceRecordedAt", "supersededByInsightId", "autoApplyError"],
  MeetingSeries: ["title", "description", "source", "externalId", "meetingUrlHash", "recurrenceRule", "meetingUrl", "startsAt", "defaultDurationMinutes", "participantIds", "participantEmails", "archivedAt"],
  MeetingAgenda: ["agendaJson"],
  MeetingFollowUpReview: ["meetingId", "installationId", "provider", "channelId", "threadTs", "messageTs", "status", "expiresAt", "closedAt"],
  DeliberationEntry: ["parentType", "parentId", "parentVersion", "authorUserId", "entryType", "bodyMd", "targetMemberId", "targetCircleId", "adviceRequestId", "resolvedAt", "resolvedNote"],
  KnowledgeChunk: ["sourceType", "sourceId", "accessDomain", "sourceTitle", "chunkIndex", "content", "metadata", "sensitivity", "embedding", "embeddingModel", "tokenCount"],
  Action: ["title", "bodyMd", "completedVia", "status", "circleId", "authorUserId", "assigneeMemberId", "priority", "dueAt", "proposalId", "isPrivate", "archivedAt"],
  ActionChecklistItem: ["actionId", "title", "sortOrder", "completedAt", "completedByUserId"],
  Tension: ["title", "bodyMd", "status", "circleId", "authorUserId", "assigneeMemberId", "priority", "urgency", "importance", "resolvedVia", "resolvedAt", "proposalId", "meetingId", "isPrivate", "archivedAt"],
  TensionUpvote: ["tensionId", "userId"],
  Recognition: ["goalId", "recipientMemberId", "authorMemberId", "title", "storyMd", "valueTags", "visibility"],
  GoalUpdate: ["goalId", "authorMemberId", "source", "bodyMd", "newProgress", "statusChange", "createdAt"],
  KeyResult: ["goalId", "title", "targetValue", "currentValue", "unit", "progressPercent", "sortOrder"],
  CommunicationExternalUser: ["installationId", "provider", "externalUserId", "userId", "memberId", "email", "displayName", "isBot", "isDeleted", "rawProfile"],
  CommunicationEntityLink: ["installationId", "provider", "messageId", "externalUserId", "entityType", "entityId", "action", "claimKey"],
  CommunicationChannel: ["installationId", "provider", "externalChannelId", "name", "kind", "isIngestEnabled", "isArchived"],
  CommunicationMessage: ["isBot", "raw", "permalink", "expiresRawAt", "installationId", "provider", "externalChannelId", "externalUserId", "externalMessageId", "threadExternalId", "text", "textRedactedAt", "isHidden", "isDeleted", "messageTs", "receivedAt"],
  CommunicationContextSummary: ["installationId", "provider", "externalChannelId", "threadExternalId", "summaryDate", "summaryKey", "title", "summaryMd", "messageCount", "sourceMessageIds", "firstMessageTs", "lastMessageTs", "lastMessageExternalId", "metadata"],
  BuildArtifact: ["brainSourceId", "createdByUserId", "repositoryOwner", "repositoryName", "pullRequestNumber", "pullRequestUrl", "branchName", "commitSha", "mergeCommitSha", "title", "summaryMd", "status", "classification", "visibility", "mergedAt", "closedAt", "publicEnabledAt", "publicRevokedAt", "noPrivateDataConfirmedAt", "publicTokenHash"],
  BuildArtifactAsset: ["artifactId", "kind", "label", "captionMd", "storageKey", "sha256", "sortOrder", "mimeType", "sizeBytes", "width", "height"],
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
  Proposal: ["workspaceId", "authorUserId", "ownerMemberId", "circleId", "meetingId", "title", "summary", "bodyMd", "status", "version", "priority", "resolutionOutcome", "decisionMd", "isPrivate", "publishedAt", "decidedAt", "autoApproveAt", "archivedAt", "archivedByUserId", "archiveReason"],
  Goal: ["startDate", "title", "descriptionMd", "level", "cadence", "parentGoalId", "circleId", "ownerMemberId", "status", "progressPercent", "targetDate", "sortOrder", "isPrivate", "authorUserId", "archivedAt", "createdAt", "updatedAt"],
  GoalLink: ["goalId", "entityType", "entityId", "confidence", "linkedBy", "source", "metadata"],
  CheckIn: ["questionText", "questionSource", "metadata", "relatedEntityType", "relatedEntityId", "status", "memberId", "questionType", "relatedConversationId", "priority", "confidence", "responseMd", "sentiment", "respondedAt", "responseUsePolicy"],
  ContextGraphObject: ["workspaceId", "objectType", "title", "summary", "properties", "confidence", "status", "createdByType", "createdByUserId", "createdByAgentRunId", "sourceEntityType", "sourceEntityId", "dedupeKey", "validFrom", "validTo", "recordedAt", "lastVerifiedAt", "supersededByObjectId"],
  ContextGraphRelationship: ["workspaceId", "sourceObjectId", "targetObjectId", "relationshipType", "properties", "confidence", "status", "createdByType", "createdByUserId", "createdByAgentRunId", "sourceEntityType", "sourceEntityId", "dedupeKey", "validFrom", "validTo", "recordedAt", "lastVerifiedAt", "supersededByRelationshipId"],
  ContextGraphEvidenceRef: ["workspaceId", "objectId", "relationshipId", "sourceType", "sourceId", "knowledgeChunkId", "quote", "relevanceScore", "metadata"],
  ContextGraphProposedDiff: ["workspaceId", "proposedByType", "proposedByUserId", "proposedByAgentRunId", "diffJson", "reason", "evidenceJson", "status", "reviewedByUserId", "reviewedAt", "appliedAt"],
  ContextMapView: ["workspaceId", "name", "viewType", "query", "layoutVersion", "createdByUserId"],
  ContextMapLayoutItem: ["mapViewId", "objectId", "x", "y", "width", "height", "visualState"],
  WorkspaceBriefing: ["title", "introMd", "bodyMd", "briefingJson", "sourceRefsJson", "sourceCounts", "status"],
  NewspaperEdition: ["title", "slug", "digestJson", "bodyMd", "sourceCounts"],
  NewspaperTrackedLink: ["runKey", "targetUrl", "targetUrlHash", "tokenHash"],
  NewspaperDelivery: ["runKey", "memberId", "demoLeadId", "kind", "cadence", "recipientEmail", "subject", "status", "providerMessageId", "error"],
  ArtifactInputSnapshot: ["sourceKind", "sourceId", "sourceFingerprint", "origin", "contentJson", "accessEnvelopeJson", "rootsJson", "epochProofVersion", "permissionEpochsJson"],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Hash only fields that can convey information or change visibility. */
function snapshotContentFields(kind: LineageKind, row?: Record<string, unknown>) {
  if (kind === "NativeTranscriptInput" && row?.mode === "PROVIDER_IMPORT") return [...fingerprintFields(kind), "transportArchiveId"];
  if (kind === "NativeTranscriptInput" && row?.mode === "RECORDER") return [...fingerprintFields(kind), "recorderAttemptId", "recorderMeetingId", "recorderBindingId", "recorderProvider"];
  return kind === "BrainSource" ? ["id", "workspaceId", "informationCategory", "accessDomain", "sourceType", "tier", "title", "channel", "content", "ingestionGuidanceMd", "fileStorageKey", "fileMimeType", "metadata", "authorMemberId", "fileName", "fileSizeBytes", "externalId", "createdAt"] : [...fingerprintFields(kind), ...((CATEGORY_BOUND_SOURCE_KINDS as readonly string[]).includes(kind) ? ["informationCategory"] : [])];
}

function fingerprintFields(kind: LineageKind) {
  return [...new Set([...CONTENT_FIELDS[kind], "createdAt",
    ...(["FinanceReportFactRevision", "NativeTranscriptInput", "CommunicationMessageNativeInput", "ExternalProviderFetchInput", "ExternalMcpResponseInput", "ExternalMcpConnectionSet", "FinanceReportUploadInput", "CrmQualificationFormInput", "ConversationOperationOutcome", "DemoLeadIntakeInput", "CrmQualificationEmailInput", "WorkflowJobInput", "McpToolInput", "ConversationIngressInput", "NewspaperTrackedLink", "Meeting", "ModelUsageBudget", "ConversationSession", "ConversationPendingOperation", "AgentRun", "AgentStep", "AgentToolCall"].includes(kind) ? [] : ["updatedAt"])])];
}

export function lineageContentFingerprint(kind: LineageKind, row: unknown): string {
  invariant(isRecord(row), 409, "UNKNOWN_LINEAGE", "Artifact content cannot be verified.");
  if (kind === "BrainSource") {
    return brainSourceContentFingerprint(row as Parameters<typeof brainSourceContentFingerprint>[0]);
  }
  const fields = fingerprintFields(kind);
  if (kind === "NativeTranscriptInput" && row.mode === "PROVIDER_IMPORT") fields.push("transportArchiveId");
  if (kind === "NativeTranscriptInput" && row.mode === "RECORDER") fields.push("recorderAttemptId", "recorderMeetingId", "recorderBindingId", "recorderProvider");
  if (kind === "SqlNativeRunInput") {
    // Preserve the existing JSON fingerprint byte for byte while avoiding
    // several complete copies of a potentially 100MiB encrypted run header.
    const digest = createHash("sha256").update(`[${JSON.stringify(kind)}`);
    for (const field of fields) {
      const value = row[field] ?? null;
      digest.update(",");
      if (typeof value !== "string") {
        digest.update(JSON.stringify(JSON.parse(sourceCommitCanonical(value))));
        continue;
      }
      digest.update('"');
      for (let offset = 0; offset < value.length;) {
        let end = Math.min(value.length, offset + 65_536);
        // JSON encodes isolated surrogates differently from a complete pair.
        // Never split a valid pair at the bounded string boundary.
        if (end < value.length && value.charCodeAt(end - 1) >= 0xd800 && value.charCodeAt(end - 1) <= 0xdbff
          && value.charCodeAt(end) >= 0xdc00 && value.charCodeAt(end) <= 0xdfff) end++;
        digest.update(JSON.stringify(value.slice(offset, end)).slice(1, -1));
        offset = end;
      }
      digest.update('"');
    }
    return digest.update("]").digest("hex");
  }
  return createHash("sha256").update(JSON.stringify([kind, ...fields.map((field) => kind === "Member" && field === "user" && isRecord(row.user)
    ? { id: row.userId ?? row.user.id ?? null, email: row.user.email ?? null, displayName: row.user.displayName ?? null }
    : kind === "WorkspaceToolLink" && field === "circleTags" && Array.isArray(row.circleTags)
      ? row.circleTags.map(tag => isRecord(tag) ? { id: tag.id ?? null, toolLinkId: tag.toolLinkId ?? null, circleId: tag.circleId ?? null, createdAt: tag.createdAt ?? null } : null)
        .sort((left, right) => String(left?.id).localeCompare(String(right?.id)))
      : kind === "KnowledgeChunk" && row.sourceType === "EXTERNAL_DATABASE"
        ? JSON.parse(sourceCommitCanonical(row[field] ?? null)) : row[field] ?? null)])).digest("hex");
}

function parseRoots(value: Prisma.JsonValue): LineageRoot[] | null {
  if (!Array.isArray(value)) return null;
  const roots: LineageRoot[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.kind !== "string" || !(item.kind in CONTENT_FIELDS)
      || typeof item.id !== "string" || !item.id
      || typeof item.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(item.fingerprint)) return null;
    if (item.permissionEpochs !== undefined && !parsePermissionEpochProof(item.permissionEpochs)) return null;
    roots.push(item as LineageRoot);
  }
  return roots;
}

type BatchedWorkItemKind = "Action" | "Proposal" | "Tension" | "CrmAccount" | "CrmContact" | "CrmActivity" | "CrmDeal";
type WorkItemRows = {rows: Map<string, Record<string, unknown>>; heads: Map<string, import("@prisma/client").ArtifactInputLineage>};
type WorkItemReadBatch = WorkItemRows & {db: LineageClient; workspaceId: string; kind: BatchedWorkItemKind; active: boolean};
const workItemReadBatch = new AsyncLocalStorage<WorkItemReadBatch>();
function workItemBatch(db: LineageClient, workspaceId: string, input: LineageInput) {
  const batch = workItemReadBatch.getStore();
  if (!batch || batch.kind !== input.kind || !batch.rows.has(input.id)) return undefined;
  invariant(batch.active && batch.db === db && batch.workspaceId === workspaceId,
    409, "SOURCE_CHANGED", "Work item batch belongs to another or expired read.");
  return batch;
}
function isBatchedWorkItemKind(kind: LineageKind | undefined): kind is BatchedWorkItemKind {
  return kind === "Action" || kind === "Proposal" || kind === "Tension" || kind === "CrmAccount" || kind === "CrmContact" || kind === "CrmActivity" || kind === "CrmDeal";
}
async function loadWorkItemBatch(db: LineageClient, workspaceId: string, kind: BatchedWorkItemKind, ids: string[]): Promise<WorkItemRows> {
  const where = {workspaceId, id: {in: ids}};
  const rows = kind === "Action" ? await db.action.findMany({where})
    : kind === "Proposal" ? await db.proposal.findMany({where})
      : kind === "CrmAccount" ? await db.crmAccount.findMany({where})
      : kind === "CrmContact" ? await db.crmContact.findMany({where})
      : kind === "CrmActivity" ? await db.crmActivity.findMany({where})
      : kind === "CrmDeal" ? await db.crmDeal.findMany({where}) : await db.tension.findMany({where});
  // Latest only, even when a selected source has an arbitrarily long history.
  const heads = await db.$queryRaw<import("@prisma/client").ArtifactInputLineage[]>(Prisma.sql`
    SELECT manifest.* FROM unnest(ARRAY[${Prisma.join(ids)}]::text[]) AS selected(id)
    CROSS JOIN LATERAL (SELECT * FROM "ArtifactInputLineage" WHERE "workspaceId"=${workspaceId}
      AND "artifactType"=${kind} AND "artifactId"=selected.id ORDER BY revision DESC LIMIT 1) AS manifest`);
  return {rows: new Map(rows.map(row => [row.id, row])), heads: new Map(heads.map(head => [head.artifactId, head]))};
}
function simpleWorkItemHead(kind: BatchedWorkItemKind, row: Record<string, unknown>, head: import("@prisma/client").ArtifactInputLineage | undefined) {
  return head?.origin === "HUMAN_ORIGINAL" && Array.isArray(head.rootsJson) && head.rootsJson.length === 0
    && Array.isArray(head.inputsJson) && head.inputsJson.length === 0 && artifactPermissionParents(kind, row).length === 0;
}
function workItemBatchStamp(batch: WorkItemRows) {
  return createHash("sha256").update(sourceCommitCanonical([
    [...batch.rows].sort(([a],[b]) => a.localeCompare(b)), [...batch.heads].sort(([a],[b]) => a.localeCompare(b)),
  ])).digest("hex");
}
/** Raw rows/heads only, within one pure read. Eligibility excludes all upstream
 * and native inputs, so no provider await or writer can occur inside the scope.
 * The existing evaluator still decides every read. A fresh full comparison
 * catches same-body head rewrites and concurrent or own-transaction mutations. */
async function withWorkItemBatchRead(db: LineageClient, workspaceId: string, roots: readonly LineageRoot[],
  read: () => Promise<boolean>, initial?: WorkItemRows): Promise<boolean> {
  const kind = roots[0]?.kind;
  if (!roots.length || roots.length > 100 || !isBatchedWorkItemKind(kind)
    || roots.some(root => root.kind !== kind) || hasActiveSourceCommitLockPlan(db) || workItemReadBatch.getStore()) return read();
  const ids = [...new Set(roots.map(root => root.id))];
  const loaded = initial ?? await loadWorkItemBatch(db, workspaceId, kind, ids);
  if (loaded.rows.size !== ids.length || [...loaded.rows].some(([id,row]) => !simpleWorkItemHead(kind,row,loaded.heads.get(id)))) return read();
  const stamp = workItemBatchStamp(loaded);
  const batch: WorkItemReadBatch = {...loaded,db,workspaceId,kind,active:true};
  const result = await workItemReadBatch.run(batch, async () => {
    try { return await withArtifactPermissionBatchRead(db, workspaceId,
      roots.flatMap(root => root.permissionEpochs ? [root.permissionEpochs] : []), read); }
    finally { batch.active = false; }
  });
  return result && stamp === workItemBatchStamp(await loadWorkItemBatch(db, workspaceId, kind, ids));
}

/** One canonical page admission and exact observation, using the ordinary
 * evaluator. Complex/derived/native inputs retain the complete original path.
 * The observed vector has the same current caller and per-target identities as
 * captureArtifactPermissionEpochs; saved ancestry is never refreshed. */
export async function captureReadableWorkItemInputs(actor: AppActor, workspaceId: string, kind: BatchedWorkItemKind,
  records: Array<{id: string; [key: string]: unknown}>) {
  invariant(records.length <= 100, 400, "INVALID_INPUT", "Capture one bounded work item page.");
  if (!records.length) return {ids: new Set<string>(), roots: [] as LineageRoot[], heads: new Map<string,string>()};
  if (LOCAL_CRM_KINDS.has(kind)) {
    const captured = await captureLocalCrmOriginalInputs(actor,workspaceId,kind,records);
    if (captured) return captured;
  }
  const ids = new Set<string>(), roots: LineageRoot[] = [], heads = new Map<string,string>();
  const fallback: typeof records = [];
  await prisma.$transaction(async tx => {
    const membership = await requireWorkspaceMembership({actor,workspaceId,tx});
    const domains = await resolveKnowledgeAccessDomains(actor,workspaceId,tx);
    const loaded = await loadWorkItemBatch(tx,workspaceId,kind,records.map(row => row.id));
    const originals = records.filter(record => {
      const row = loaded.rows.get(record.id);
      if (!row || lineageContentFingerprint(kind,row) !== lineageContentFingerprint(kind,record)) return false;
      if (!simpleWorkItemHead(kind,row,loaded.heads.get(record.id))) { fallback.push(record); return false; }
      return true;
    });
    if (!originals.length) return;
    const selected: WorkItemRows = {rows:new Map(originals.map(row => [row.id,loaded.rows.get(row.id)!])),
      heads:new Map(originals.map(row => [row.id,loaded.heads.get(row.id)!]))};
    const ambient = await captureArtifactPermissionEpochs(actor,workspaceId,[],tx);
    const identities = new Map(originals.map(row => [row.id,artifactPermissionEpochIdentities(kind,selected.rows.get(row.id)!)]));
    const targetEpochs = await capturePermissionEpochs(tx,workspaceId,[...identities.values()].flat());
    const candidates = originals.map(row => {
      const keys = new Set(identities.get(row.id)!.map(identity => JSON.stringify([identity.kind,identity.id])));
      const own = {...targetEpochs,entries:targetEpochs.entries.filter(entry => keys.has(JSON.stringify([entry.kind,entry.id])))};
      return {kind,id:row.id,fingerprint:lineageContentFingerprint(kind,selected.rows.get(row.id)!),
        permissionEpochs:mergePermissionEpochProofs(ambient,own)!};
    });
    const binding: ReadHeadBinding = {heads:new Map(),sealed:false};
    const memo = new Map<string,boolean>(); readHeadMemos.set(memo,binding);
    const valid = await expectedReadHeads.run(binding, () => withWorkItemBatchRead(tx,workspaceId,candidates,async () => {
      for (const root of candidates) if (await rootIsReadable(tx,actor,workspaceId,membership,domains,root,new Set(),memo)) {
        ids.add(root.id); roots.push(root);
      }
      return true;
    },selected));
    invariant(valid,409,"SOURCE_CHANGED","Work item inputs changed during admission.");
    for (const id of ids) {
      const key = JSON.stringify([kind,id]);
      const stamp = binding.heads.get(key);
      invariant(stamp,409,"SOURCE_CHANGED","Observed work item has no bound head.");
      heads.set(key,stamp);
    }
  });
  if (fallback.length) {
    const observed = await captureArtifactReadHeadObservation(async () => {
      const readable = await readableArtifactIds(actor,workspaceId,kind,fallback);
      const admitted = fallback.filter(row => readable.has(row.id));
      if (admitted.length) {
        roots.push(...await captureArtifactInputProof(actor,workspaceId,admitted.map(row => ({kind,id:row.id,snapshot:row}))));
        for (const row of admitted) ids.add(row.id);
      }
    });
    for (const [key,stamp] of observed.heads) {
      invariant(!heads.has(key) || heads.get(key) === stamp,409,"SOURCE_CHANGED","A work item lineage head changed during admission.");
      heads.set(key,stamp);
    }
  }
  observeArtifactRead(actor,workspaceId,roots);
  return {ids,roots,heads};
}

type LocalDeliveryRows = {rows: Map<string, Record<string, unknown>>;
  heads: Map<string, import("@prisma/client").ArtifactInputLineage>};
type LocalDeliveryBatch = LocalDeliveryRows & {db: LineageClient; workspaceId: string; active: boolean};
const localDeliveryReadBatch = new AsyncLocalStorage<LocalDeliveryBatch>();
const deliveryInputKey = (input: LineageInput) => JSON.stringify([input.kind, input.id]);
const LOCAL_CRM_KINDS = new Set<LineageKind>(["CrmAccount", "CrmContact", "CrmActivity", "CrmDeal"]);
const LOCAL_APPROVAL_KINDS = new Set<LineageKind>(["ApprovalFlow", "ApprovalDecision", "Objection", "Proposal", "Member"]);
const CONVERSATION_READ_KINDS = new Set<LineageKind>(["ConversationTurn", "ConversationPromptInput", "ConversationSession"]);
const LOCAL_CONVERSATION_KINDS = new Set<LineageKind>([...CONVERSATION_READ_KINDS, "BrainSource", "BrainArticle", "Document", "Action", "Proposal", "Tension"]);
const APPROVAL_READ_KINDS = new Set<LineageKind>(["ApprovalFlow", "ApprovalDecision", "Objection"]);
const LOCAL_DELIVERY_KINDS = new Set<LineageKind>(["NewspaperDelivery", "Workspace", "Member", "Action", "Proposal", "Tension"]);
function localDeliveryBatch(db: LineageClient, workspaceId: string, input: LineageInput) {
  const batch = localDeliveryReadBatch.getStore();
  if (!batch?.rows.has(deliveryInputKey(input))) return undefined;
  invariant(batch.active && batch.db === db && batch.workspaceId === workspaceId,
    409, "SOURCE_CHANGED", "Delivery batch belongs to another or expired read.");
  return batch;
}
async function loadLocalDeliveryRows(db: LineageClient, workspaceId: string, inputs: readonly LineageInput[]): Promise<LocalDeliveryRows> {
  const rows: LocalDeliveryRows["rows"] = new Map(), heads: LocalDeliveryRows["heads"] = new Map();
  for (const kind of new Set(inputs.map(input => input.kind))) {
    const ids = [...new Set(inputs.filter(input => input.kind === kind).map(input => input.id))];
    const where = {workspaceId, id: {in: ids}};
    const found = kind === "NewspaperDelivery" ? await db.newspaperDelivery.findMany({where})
      : kind === "Workspace" ? await db.workspace.findMany({where: {id: {in: ids.filter(id => id === workspaceId)}}})
      : kind === "Member" ? await db.member.findMany({where, include: {user: {select: {id: true, email: true, displayName: true}}}})
      : kind === "ConversationTurn" ? await db.conversationTurn.findMany({where: {id: {in: ids}, conversation: {workspaceId}}})
      : kind === "ConversationPromptInput" ? await db.conversationPromptInput.findMany({where})
      : kind === "ConversationSession" ? await db.conversationSession.findMany({where})
      : kind === "BrainSource" ? await db.brainSource.findMany({where})
      : kind === "BrainArticle" ? await db.brainArticle.findMany({where})
      : kind === "Document" ? await db.document.findMany({where})
      : kind === "ApprovalFlow" ? await db.approvalFlow.findMany({where})
      : kind === "ApprovalDecision" ? await db.approvalDecision.findMany({where: {id: {in: ids}, flow: {workspaceId}}})
      : kind === "Objection" ? await db.objection.findMany({where: {id: {in: ids}, flow: {workspaceId}}})
      : kind === "Action" ? await db.action.findMany({where})
      : kind === "Proposal" ? await db.proposal.findMany({where})
      : kind === "CrmAccount" ? await db.crmAccount.findMany({where})
      : kind === "CrmContact" ? await db.crmContact.findMany({where})
      : kind === "CrmActivity" ? await db.crmActivity.findMany({where})
      : kind === "CrmDeal" ? await db.crmDeal.findMany({where}) : await db.tension.findMany({where});
    for (const row of found) rows.set(deliveryInputKey({kind,id:row.id}), row);
    const manifests = await db.$queryRaw<import("@prisma/client").ArtifactInputLineage[]>(Prisma.sql`
      SELECT manifest.* FROM unnest(ARRAY[${Prisma.join(ids)}]::text[]) AS selected(id)
      CROSS JOIN LATERAL (SELECT * FROM "ArtifactInputLineage" WHERE "workspaceId"=${workspaceId}
        AND "artifactType"=${kind} AND "artifactId"=selected.id ORDER BY revision DESC LIMIT 1) AS manifest`);
    for (const head of manifests) heads.set(deliveryInputKey({kind,id:head.artifactId}), head);
  }
  return {rows,heads};
}
/** Eligibility follows the complete stored closure, including same-body heads.
 * Unsupported kinds (especially snapshots/native inputs) keep the ordinary path. */
async function prepareLocalDeliveryBatch(db: LineageClient, workspaceId: string, inputs: readonly LineageInput[]) {
  const crm = inputs.every(input => LOCAL_CRM_KINDS.has(input.kind));
  const approvals = inputs.some(input => APPROVAL_READ_KINDS.has(input.kind));
  const conversations = inputs.some(input => CONVERSATION_READ_KINDS.has(input.kind));
  if (!inputs.length || inputs.length > 100 || !crm && !approvals && !conversations && !inputs.some(input => input.kind === "NewspaperDelivery")
    || hasActiveSourceCommitLockPlan(db) || localDeliveryReadBatch.getStore() || workItemReadBatch.getStore()) return null;
  const loaded: LocalDeliveryRows = {rows:new Map(),heads:new Map()};
  let pending = [...inputs];
  const revisions = new Map<string,string>();
  while (pending.length) {
    for (const input of pending) if ("fingerprint" in input && typeof input.fingerprint === "string") {
      const key = deliveryInputKey(input), previous = revisions.get(key), row = loaded.rows.get(key);
      if (previous && previous !== input.fingerprint || row && lineageContentFingerprint(input.kind,row) !== input.fingerprint) return null;
      revisions.set(key,input.fingerprint);
    }
    pending = [...new Map(pending.filter(input => !loaded.rows.has(deliveryInputKey(input)))
      .map(input => [deliveryInputKey(input),input])).values()];
    if (!pending.length) break;
    if (loaded.rows.size + pending.length > 256 || pending.some(input => !(crm ? LOCAL_CRM_KINDS : approvals ? LOCAL_APPROVAL_KINDS : conversations ? LOCAL_CONVERSATION_KINDS : LOCAL_DELIVERY_KINDS).has(input.kind))) return null;
    const page = await loadLocalDeliveryRows(db,workspaceId,pending);
    if (page.rows.size !== pending.length) return null;
    const next: LineageInput[] = [];
    for (const input of pending) {
      const key = deliveryInputKey(input), row = page.rows.get(key)!, head = page.heads.get(key);
      const fingerprint = lineageContentFingerprint(input.kind,row);
      const parents = artifactPermissionParents(input.kind,row);
      if (!crm && !approvals && !conversations && parents.length || revisions.has(key) && revisions.get(key) !== fingerprint
        || head && head.contentHash !== fingerprint) return null;
      if (crm) {
        if (!head || head.origin !== "HUMAN_ORIGINAL" || !Array.isArray(head.inputsJson) || head.inputsJson.length
          || !Array.isArray(head.rootsJson) || head.rootsJson.length) return null;
        next.push(...parents);
      } else if (needsManifest(input.kind,row) || head) {
        const roots = head && parseRoots(head.rootsJson);
        if (!head || !roots || !["HUMAN_ORIGINAL","DERIVED"].includes(head.origin)
          || roots.some(root => !root.permissionEpochs) && (!(approvals || conversations) || head.epochProofVersion !== 1
            || !parsePermissionEpochProof(head.permissionEpochsJson))) return null;
        next.push(...roots);
      }
      if (approvals || conversations) next.push(...parents);
      loaded.rows.set(key,row);
      if (head) loaded.heads.set(key,head);
    }
    pending = next;
  }
  return loaded;
}
function localDeliveryStamp(loaded: LocalDeliveryRows) {
  return createHash("sha256").update(sourceCommitCanonical([
    [...loaded.rows].sort(([a],[b]) => a.localeCompare(b)), [...loaded.heads].sort(([a],[b]) => a.localeCompare(b)),
  ])).digest("hex");
}
async function readLocalDeliveryBatch(db: LineageClient, workspaceId: string, loaded: LocalDeliveryRows,
  roots: readonly LineageRoot[], read: () => Promise<boolean>) {
  const stamp = localDeliveryStamp(loaded);
  const crm = [...loaded.rows.keys()].every(key => LOCAL_CRM_KINDS.has(JSON.parse(key)[0]));
  const approvals = [...loaded.rows.keys()].some(key => APPROVAL_READ_KINDS.has(JSON.parse(key)[0]));
  const conversations = [...loaded.rows.keys()].some(key => CONVERSATION_READ_KINDS.has(JSON.parse(key)[0]));
  const proofs = [...roots.flatMap(root => root.permissionEpochs ? [root.permissionEpochs] : []),
    ...(crm ? [] : [...loaded.heads.values()].flatMap(head => [(approvals || conversations) && head.origin === "HUMAN_ORIGINAL"
      ? undefined : parsePermissionEpochProof(head.permissionEpochsJson),
      ...(parseRoots(head.rootsJson) ?? []).map(root => root.permissionEpochs)].filter((proof): proof is PermissionEpochProof => Boolean(proof))))];
  // Original human content does not inherit its publisher's historical epochs.
  // A page containing conflicting derived receipts needs ordinary per-row
  // admission; a batch cache must not turn one denied sibling into a page error.
  if (approvals || conversations) try { mergePermissionEpochProofs(...proofs); } catch (error) {
    if (error instanceof AppError && ["SOURCE_CHANGED", "UNKNOWN_LINEAGE", "PERMISSION_PROOF_LIMIT"].includes(error.code)) return false;
    throw error;
  }
  const batch: LocalDeliveryBatch = {...loaded,db,workspaceId,active:true};
  const valid = await localDeliveryReadBatch.run(batch, () => withArtifactPermissionMetadataRead(db,workspaceId,loaded.rows,async () => {
    try { return await withArtifactPermissionBatchRead(db,workspaceId,proofs,read); }
    finally { batch.active = false; }
  }));
  const inputs = [...loaded.rows.keys()].map(key => { const [kind,id] = JSON.parse(key); return {kind,id} as LineageInput; });
  return valid && stamp === localDeliveryStamp(await loadLocalDeliveryRows(db,workspaceId,inputs));
}

/** Local CRM originals retain the ordinary parent-envelope evaluator. The
 * complete current parent closure is loaded and compared before/after the read;
 * any derived/native/historical input uses the ordinary uncached path. */
async function captureLocalCrmOriginalInputs(actor: AppActor, workspaceId: string, kind: BatchedWorkItemKind,
  records: Array<{id: string; [key: string]: unknown}>) {
  return prisma.$transaction(async tx => {
    const loaded = await prepareLocalDeliveryBatch(tx,workspaceId,records.map(record => ({kind,id:record.id})));
    if (!loaded || records.some(record => lineageContentFingerprint(kind,record)
      !== lineageContentFingerprint(kind,loaded.rows.get(deliveryInputKey({kind,id:record.id}))!))) return null;
    const membership = await requireWorkspaceMembership({actor,workspaceId,tx});
    const domains = await resolveKnowledgeAccessDomains(actor,workspaceId,tx);
    const ambient = await captureArtifactPermissionEpochs(actor,workspaceId,[],tx);
    const identities = new Map(records.map(record => {
      const pending: LineageInput[] = [{kind,id:record.id}], seen = new Set<string>();
      const own: Array<{kind: string; id: string}> = [];
      for (const input of pending) {
        const key = deliveryInputKey(input);
        if (seen.has(key)) continue;
        seen.add(key);
        const row = loaded.rows.get(key)!;
        own.push(...artifactPermissionEpochIdentities(input.kind,row));
        pending.push(...artifactPermissionParents(input.kind,row));
      }
      return [record.id,own] as const;
    }));
    const target = await capturePermissionEpochs(tx,workspaceId,[...identities.values()].flat());
    const candidates: LineageRoot[] = records.map(record => {
      const keys = new Set(identities.get(record.id)!.map(identity => JSON.stringify([identity.kind,identity.id])));
      const own = {...target,entries:target.entries.filter(entry => keys.has(JSON.stringify([entry.kind,entry.id])))};
      return {kind,id:record.id,fingerprint:lineageContentFingerprint(kind,record),permissionEpochs:mergePermissionEpochProofs(ambient,own)!};
    });
    const binding: ReadHeadBinding = {heads:new Map(),sealed:false};
    const memo = new Map<string,boolean>(); readHeadMemos.set(memo,binding);
    const roots: LineageRoot[] = [];
    const valid = await expectedReadHeads.run(binding,()=>readLocalDeliveryBatch(tx,workspaceId,loaded,candidates,async()=>{
      for (const root of candidates) if (await rootIsReadable(tx,actor,workspaceId,membership,domains,root,new Set(),memo)) roots.push(root);
      return true;
    }));
    invariant(valid,409,"SOURCE_CHANGED","CRM original inputs changed during admission.");
    observeArtifactRead(actor,workspaceId,roots);
    return {ids:new Set(roots.map(root=>root.id)),roots,heads:binding.heads};
  });
}

/** Bounded delivery capture with ordinary per-root admission and original
 * ancestry. Null requests the per-record fallback, including denied inputs. */
export async function captureReadableNewspaperDeliveryInputs<T extends {id: string}>(actor: AppActor,
  workspaceId: string, records: T[]) {
  const inputs = records.map(record => ({kind:"NewspaperDelivery" as const,id:record.id}));
  const loaded = await prepareLocalDeliveryBatch(prisma,workspaceId,inputs);
  if (!loaded) return null;
  for (const record of records) {
    const row = loaded.rows.get(deliveryInputKey({kind:"NewspaperDelivery",id:record.id}))!;
    if (snapshotContentFields("NewspaperDelivery",row).some(field => field in record
      && !snapshotMatches((record as Record<string,unknown>)[field],row[field]))) return null;
  }
  const epochs = await prisma.$transaction(async tx => {
    await requireWorkspaceMembership({actor,workspaceId,tx});
    const ambient = await captureArtifactPermissionEpochs(actor,workspaceId,[],tx);
    const own = await capturePermissionEpochs(tx,workspaceId,records.flatMap(record =>
      artifactPermissionEpochIdentities("NewspaperDelivery",loaded.rows.get(deliveryInputKey({kind:"NewspaperDelivery",id:record.id}))!)));
    return {ambient,own};
  });
  const proofs = new Map<string,LineageRoot[]>();
  for (const record of records) {
    const key = deliveryInputKey({kind:"NewspaperDelivery",id:record.id}), row = loaded.rows.get(key)!;
    const identities = new Set(artifactPermissionEpochIdentities("NewspaperDelivery",row).map(identity => JSON.stringify([identity.kind,identity.id])));
    const own = {...epochs.own,entries:epochs.own.entries.filter(entry => identities.has(JSON.stringify([entry.kind,entry.id])))};
    proofs.set(record.id,[{kind:"NewspaperDelivery",id:record.id,fingerprint:lineageContentFingerprint("NewspaperDelivery",row),
      permissionEpochs:mergePermissionEpochProofs(epochs.ambient,own)!}, ...parseRoots(loaded.heads.get(key)!.rootsJson)!]);
  }
  const roots = new Map<string,LineageRoot>();
  for (const proof of proofs.values()) for (const root of proof) roots.set(deliveryInputKey(root),mergeLineageInputRoot(roots.get(deliveryInputKey(root)),root));
  const all = [...roots.values()];
  const valid = await readLocalDeliveryBatch(prisma,workspaceId,loaded,all,
    () => isArtifactInputProofReadable(actor,workspaceId,all));
  if (!valid) return null;
  observeArtifactRead(actor,workspaceId,all);
  return {records,proofs,roots:all};
}

/** Small conversation pages cache only supported current local rows/heads.
 * Original ancestor epochs remain unchanged; unsupported or denied pages ask
 * the caller to subdivide and eventually use ordinary individual admission. */
export async function captureReadableConversationInputs<T extends {id: string}>(actor: AppActor,
  workspaceId: string, kind: "ConversationTurn" | "ConversationPromptInput", records: T[]) {
  const loaded = await prepareLocalDeliveryBatch(prisma,workspaceId,records.map(record => ({kind,id:record.id})));
  if (!loaded) return null;
  const ownIdentities = new Map<string, Array<{kind: string; id: string}>>();
  for (const record of records) {
    const key = deliveryInputKey({kind,id:record.id}), row = loaded.rows.get(key)!;
    if (snapshotContentFields(kind,row).some(field => field in record
      && !snapshotMatches((record as Record<string,unknown>)[field],row[field]))) return null;
    const upstream = loaded.heads.has(key) ? parseRoots(loaded.heads.get(key)!.rootsJson) : [];
    if (!upstream || upstream.some(root => !root.permissionEpochs)) return null;
    const pending: LineageInput[] = [{kind,id:record.id}], visited = new Set<string>();
    const identities: Array<{kind: string; id: string}> = [];
    for (const input of pending) {
      const parentKey = deliveryInputKey(input);
      if (visited.has(parentKey)) continue;
      visited.add(parentKey);
      // This newly bound root has only native conversation ownership parents.
      // Source/category/native ancestors keep their original saved proofs.
      if (!CONVERSATION_READ_KINDS.has(input.kind)) return null;
      const parent = loaded.rows.get(parentKey)!;
      identities.push(...artifactPermissionEpochIdentities(input.kind,{...parent,id:input.id,workspaceId}));
      pending.push(...artifactPermissionParents(input.kind,parent));
    }
    ownIdentities.set(record.id,identities);
  }
  const epochs = await prisma.$transaction(async tx => {
    await requireWorkspaceMembership({actor,workspaceId,tx});
    return {ambient:await captureArtifactPermissionEpochs(actor,workspaceId,[],tx),
      own:await capturePermissionEpochs(tx,workspaceId,[...ownIdentities.values()].flat())};
  });
  const proofs = new Map<string,LineageRoot[]>(), all = new Map<string,LineageRoot>();
  for (const record of records) {
    const key = deliveryInputKey({kind,id:record.id}), row = loaded.rows.get(key)!;
    const identities = new Set(ownIdentities.get(record.id)!.map(identity => JSON.stringify([identity.kind,identity.id])));
    const own = {...epochs.own,entries:epochs.own.entries.filter(entry => identities.has(JSON.stringify([entry.kind,entry.id])))};
    const roots: LineageRoot[] = [{kind,id:record.id,fingerprint:lineageContentFingerprint(kind,row),
      permissionEpochs:mergePermissionEpochProofs(epochs.ambient,own)!},
      ...parseRoots(loaded.heads.get(key)?.rootsJson ?? [])!];
    proofs.set(record.id,roots);
    try { for (const root of roots) all.set(deliveryInputKey(root),mergeLineageInputRoot(all.get(deliveryInputKey(root)),root)); }
    catch (error) {
      if (error instanceof AppError && ["SOURCE_CHANGED","UNKNOWN_LINEAGE","PERMISSION_PROOF_LIMIT"].includes(error.code)) return null;
      throw error;
    }
  }
  const roots = [...all.values()];
  if (!await readLocalDeliveryBatch(prisma,workspaceId,loaded,roots,() => isArtifactInputProofReadable(actor,workspaceId,roots))) return null;
  observeArtifactRead(actor,workspaceId,roots);
  return {records,proofs,roots};
}

async function loadArtifact(db: LineageClient, workspaceId: string, input: LineageInput): Promise<Record<string, unknown> | null> {
  assertSourceCommitTransactionCompatible(db);
  if (hasActiveSourceCommitLockPlan(db)) {
    const physical = sourceAuthorityPhysicalRow(input);
    if (physical) assertSourceCommitRowCovered(db, physical.table, physical.id);
  }
  const deliveryBatch = localDeliveryBatch(db,workspaceId,input);
  if (deliveryBatch) return structuredClone(deliveryBatch.rows.get(deliveryInputKey(input))!);
  const batch = workItemBatch(db, workspaceId, input);
  if (batch) return structuredClone(batch.rows.get(input.id)!);
  const where = { id: input.id, workspaceId };
  switch (input.kind) {
    case "ExternalDataSource": return db.externalDataSource.findFirst({where});
    case "SqlNativeRunInput": {
      const {loadSqlNativeRunInput} = await import("./sql-native-input");
      return loadSqlNativeRunInput(workspaceId, input.id, db);
    }
    case "MeetingAudioAsset": return db.meetingAudioAsset.findFirst({ where });
    case "NativeTranscriptInput": return db.nativeTranscriptInput.findFirst({ where });
    case "CommunicationMessageNativeInput": return db.communicationMessageNativeInput.findFirst({ where });
    case "GenericDerivedArtifactVariant": return db.genericDerivedArtifactVariant.findFirst({ where });
    case "ExternalProviderFetchInput": return db.externalProviderFetchInput.findFirst({ where });
    case "ExternalMcpResponseInput": return db.externalMcpResponseInput.findFirst({ where });
    case "ExternalMcpConnectionSet": return loadExternalMcpConnectionSetInput(workspaceId, input.id, db);
    case "ExternalContentSource": return db.externalContentSource.findFirst({ where });
    case "FinanceReport": return db.financeReport.findFirst({ where });
    case "FinanceReportFactRevision": return db.financeReportFactRevision.findFirst({ where });
    case "FinanceReportFact": return db.financeReportFact.findFirst({ where });
    case "FinanceImportApplication": return db.financeImportApplication.findFirst({ where });

    case "FinanceImportBatch": return db.financeImportBatch.findFirst({ where });
    case "FinanceImportCandidate": return db.financeImportCandidate.findFirst({ where });
    case "FinanceReportUploadInput": return db.financeReportUploadInput.findFirst({ where });
    case "CrmQualificationFormInput": return db.crmQualificationFormInput.findFirst({ where });
    case "ExecutionRequest": return db.executionRequest.findFirst({ where });
    case "ExecutionResult": return db.executionResult.findFirst({ where });
    case "ConversationOperationOutcome": return db.conversationOperationOutcome.findFirst({ where });
    case "WorkspaceToolLink": return db.workspaceToolLink.findFirst({ where, include: { circleTags: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] } } });
    case "WorkspaceToolLinkCredential": return db.workspaceToolLink.findFirst({ where });
    case "McpToolInput": return db.mcpToolInput.findFirst({ where });
    case "ConversationIngressInput": return db.conversationIngressInput.findFirst({ where });
    case "DemoLeadIntakeInput": return db.demoLead.findFirst({ where, select: { id: true, workspaceId: true, email: true, source: true, createdAt: true } });
    case "CrmQualificationEmailInput": return db.crmQualification.findFirst({ where: { ...where, responseChannel: "email_reply" }, select: { id: true, workspaceId: true, demoLeadId: true, responseChannel: true, rawEmailReply: true, rawEmailSubject: true, createdAt: true } });
    case "DemoLead": return db.demoLead.findFirst({ where });
    case "CrmQualification": return db.crmQualification.findFirst({ where });
    case "WorkflowJobInput": return db.workflowJob.findFirst({ where, select: { id: true, workspaceId: true, eventId: true, type: true, payload: true, createdAt: true } });
    case "AgentRequestInput": return db.agentRequestInput.findFirst({ where });
    case "AgentFeedbackInput": return db.agentFeedbackInput.findFirst({ where });
    case "ConversationPendingOperation": return db.conversationPendingOperation.findFirst({ where });
    case "BrainDiscussionThread": return db.brainDiscussionThread.findFirst({ where: { id: input.id, article: { workspaceId } } });
    case "BrainDiscussionComment": return db.brainDiscussionComment.findFirst({ where: { id: input.id, thread: { article: { workspaceId } } } });
    case "AgentRun": return db.agentRun.findFirst({ where });
    case "AgentStep": return db.agentStep.findFirst({ where: { id: input.id, agentRun: { workspaceId } } });
    case "AgentToolCall": return db.agentToolCall.findFirst({ where: { id: input.id, agentRun: { workspaceId } } });
    case "Workspace": return db.workspace.findFirst({ where: { id: input.id === workspaceId ? input.id : "" }, select: { id: true, name: true, slug: true, description: true, plan: true, createdAt: true, updatedAt: true } });
    case "User": return db.user.findFirst({ where: { id: input.id, memberships: { some: { workspaceId, isActive: true } } }, select: { id: true, email: true, displayName: true, bio: true, avatarUrl: true, linkedinUrl: true, websiteUrl: true, createdAt: true, updatedAt: true } });
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
      id: true, workspaceId: true, informationCategory: true, title: true, source: true, externalId: true, calendarExternalId: true, meetingUrl: true, meetingUrlHash: true, transcript: true, ingestionGuidanceMd: true,
      recordedAt: true, scheduledEndAt: true, seriesId: true, participantIds: true, participantEmails: true,
      archivedAt: true, createdAt: true,
    } });
    case "MeetingInsight": return db.meetingInsight.findFirst({ where });
    case "MeetingSeries": return db.meetingSeries.findFirst({ where });
    case "MeetingAgenda": return db.meeting.findFirst({ where, select: { id: true, workspaceId: true, informationCategory: true, agendaJson: true, archivedAt: true, createdAt: true } });
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

export function isLineageKind(value: unknown): value is LineageKind {
  return typeof value === "string" && value in CONTENT_FIELDS;
}

function knownSnapshotOrigin(row: Record<string, unknown>) {
  if (["MeetingAudioAsset", "KnowledgeChunk", "CommunicationMessage", "GenericDerivedArtifactVariant", "FinanceReportFactRevision"].includes(String(row.sourceKind)) && row.origin !== "DERIVED") return false;
  return row.origin === "HUMAN_ORIGINAL" || row.origin === "DERIVED"
    || (row.origin === "NATIVE_ORIGINAL" && (["SqlNativeRunInput", "NativeTranscriptInput", "CommunicationMessageNativeInput", "ExternalProviderFetchInput", "ExternalMcpResponseInput", "ExternalMcpConnectionSet", "FinanceReportUploadInput", "CrmQualificationFormInput", "ConversationIngressInput", "McpToolInput"].includes(String(row.sourceKind))
      || (row.sourceKind === "ConversationOperationOutcome" && isRecord(row.contentJson) && isNativeControlOutcome(row.contentJson))));
}

// These sources can be typed human originals without a stored lineage row.
// Every other historical human snapshot must still have a genuine, empty-input
// original receipt for the exact consumed revision.
const IMPLICIT_HUMAN_ORIGINAL_SNAPSHOT_KINDS = new Set<LineageKind>([
  "Workspace", "Member", "User", "RoleAssignment", "CircleAgentAssignment",
  "CommunicationExternalUser", "CommunicationEntityLink", "CommunicationChannel",
  "DemoLeadIntakeInput", "CrmQualificationEmailInput", "ConversationPromptInput",
  "AgentRequestInput", "AgentFeedbackInput", "ModelUsageBudget", "ModelUsageCost",
  "ApprovalPolicy", "CrmDealStageTransition", "TensionUpvote",
]);

function isNativeControlOutcome(row: Record<string, unknown>) {
  return ["BRAIN_SOURCE_REMOVAL_COMPLETED", "ACTION_COMPLETED", "ACTION_COMPLETION_PUBLIC_NOTE", "BRAIN_EXPORT_CONSENT", "LEGACY_RECOVERY_PUBLICATION"].includes(String(row.operation))
    && isRecord(row.controlJson) && row.controlJson.version === 1;
}

function isArchived(row: unknown) {
  return isRecord(row) && (row.archivedAt != null || row.status === "archived");
}

function actorCanReadRecord(actor: AppActor, workspaceId: string, membership: { id: string; role: string } | null, kind: LineageKind, row: Record<string, unknown>, nativeSnapshotFingerprint?: string) {
  if (kind === "ConversationOperationOutcome" && row.operation === "LEGACY_RECOVERY_PUBLICATION") return actor.kind === "user" && Boolean(membership) || actor.kind === "agent" && actor.authProvider === "credential";
  if (kind === "ConversationOperationOutcome" && row.operation === "BRAIN_EXPORT_CONSENT") return Boolean(membership && actor.kind === "user" || getBrainExportWorkerPurpose(actor, workspaceId)?.receiptId === row.id);
  if (kind === "ConversationOperationOutcome" && row.operation === "ACTION_COMPLETION_PUBLIC_NOTE")
    return row.actorKind === "public" && row.userId == null && row.credentialId == null
      && row.credentialVersion == null && row.scopeHash == null
      && Array.isArray(row.requiredScopes) && row.requiredScopes.length === 0;
  if (kind === "MeetingAudioAsset") return nativeTranscriptPrincipalUserId(actor, workspaceId) === row.uploadedByUserId;
  const meetingWorker = kind === "NativeTranscriptInput" && ["COMPANY_MEMBER_UPLOAD", "PROVIDER_IMPORT", "RECORDER"].includes(String(row.mode))
    && getMeetingTranscriptWorkerPurpose(actor, workspaceId)?.nativeInputs.some(input => input.id === row.id
      && input.fingerprint === (nativeSnapshotFingerprint ?? lineageContentFingerprint("NativeTranscriptInput", row)));
  if (kind === "NativeTranscriptInput" && row.mode === "COMPANY_MEMBER_UPLOAD") return Boolean(membership || meetingWorker);
  if (kind === "NativeTranscriptInput" && row.mode === "PROVIDER_IMPORT") return Boolean(membership || meetingWorker || getTranscriptSourceImportPurpose(actor, workspaceId));
  if (kind === "NativeTranscriptInput") return row.mode === "RECORDER"
    ? Boolean(membership || meetingWorker || getRecorderTranscriptWorkerPurpose(actor, workspaceId))
    : nativeTranscriptPrincipalUserId(actor, workspaceId) === row.submittedByUserId;
  if (kind === "GenericDerivedArtifactVariant") return actor.kind === "user" && membership?.id === row.ownerMemberId;
  if (kind === "ExternalMcpResponseInput" || kind === "ExternalMcpConnectionSet") return actor.kind === "user" && actor.user.id === row.localUserId;
  if (internalSourcePermission(actor, workspaceId, kind, row)) return true;
  if (kind === "ExternalProviderFetchInput" || kind === "ExternalContentSource") {
    const principalUserId = getExternalProviderPrincipalUserId(actor, workspaceId);
    return Boolean(principalUserId && principalUserId === row[kind === "ExternalProviderFetchInput" ? "localUserId" : "selectedByUserId"]);
  }
  if (["FinanceReport", "FinanceReportFact", "FinanceReportFactRevision", "FinanceImportApplication", "FinanceImportBatch", "FinanceImportCandidate"].includes(kind)) return actor.kind === "user";
  if (kind === "FinanceReportUploadInput") return actor.kind === "user";
  if (kind === "BuildArtifact" && row.visibility === "PRIVATE") return actor.kind === "user"
    && (membership?.role === "ADMIN" || row.createdByUserId === actor.user.id);
  if (kind === "ExecutionRequest" || kind === "ExecutionResult") return actor.kind === "user"
    ? row[kind === "ExecutionRequest" ? "createdByUserId" : "submittedByUserId"] === actor.user.id
    : actor.authProvider === "credential" && row.agentCredentialId === actor.credentialId
      && Boolean(actor.credentialVersion && actor.scopes?.includes("execution:read"));
  if (kind === "WorkspaceToolLinkCredential") return actor.kind === "user"
    ? membership?.role === "ADMIN" || membership?.role === "FACILITATOR" || row.createdByUserId === actor.user.id
    : actor.authProvider === "credential" && Boolean(actor.credentialId && actor.credentialVersion)
      && Boolean(actor.scopes?.includes("tools:credentials:read"));
  if (kind === "BrainArticle" && row.variantOfArticleId != null) {
    return actor.kind === "user" && membership?.id === row.ownerMemberId;
  }
  if (kind === "BrainArticle" && row.isPrivate === true) {
    return actor.kind === "user" && (membership?.role === "ADMIN" || row.ownerMemberId === membership?.id);
  }
  if (["Proposal", "Goal", "Action", "Tension"].includes(kind) && row.isPrivate === true) {
    return actor.kind === "user" && row.status === "DRAFT" && (membership?.role === "ADMIN"
      || (actor.kind === "user" && row.authorUserId === actor.user.id));
  }
  if (["ModelUsageBudget", "ModelUsageCost"].includes(kind)) return actor.kind === "user" && membership?.role === "ADMIN";
  if (kind === "Recognition") return row.visibility === "WORKSPACE"
    || membership?.id === row.authorMemberId || membership?.id === row.recipientMemberId;
  if (["ConversationOperationOutcome", "ConversationIngressInput", "McpToolInput"].includes(kind)) return row.actorKind === "user"
    ? actor.kind === "user" && row.credentialId == null && row.credentialVersion == null && row.scopeHash == null && row.userId === actor.user.id
    : row.actorKind === "agent" && row.userId == null && actor.kind === "agent" && actor.authProvider === "credential" && row.credentialId === actor.credentialId
      && row.credentialVersion === actor.credentialVersion && row.scopeHash === mcpScopesHash(actor.scopes ?? []);
  if (kind === "Member") return row.isActive === true;
  if (kind === "AgentIdentity") return row.isActive === true || (row.agentKey === "__workspace__" && row.archivedAt == null)
    || (actor.kind === "user" && membership?.role === "ADMIN" && row.archivedAt == null);
  if (kind === "NewspaperDelivery") return membership?.role === "ADMIN"
    || (row.kind === "MEMBER_NEWSPAPER" && row.memberId === membership?.id);
  if (kind === "Notification") return actor.kind === "user" && row.userId === actor.user.id;
  if (["AgentRequestInput", "ConversationPromptInput", "AgentFeedbackInput", "ConversationPendingOperation"].includes(kind)) return actor.kind === "user" && row.userId === actor.user.id;
  if (kind === "ConversationSession") return actor.kind === "user" && row.userId === actor.user.id;
  if (kind === "RoleOnboardingSession") return actor.kind === "user" && row.memberId === membership?.id;
  if (kind === "CheckIn") return actor.kind === "user" && membership?.id === row.memberId;
  if (kind === "ContextMapView" && row.createdByUserId != null) {
    return actor.kind === "user" && actor.user.id === row.createdByUserId;
  }
  return true;
}

function needsManifest(kind: LineageKind, row: Record<string, unknown>) {
  if (kind === "BrainSource") return brainSourceNeedsLineage(row);
  return !["ExternalDataSource", "SqlNativeRunInput", "Workspace", "Member", "User", "RoleAssignment", "CircleAgentAssignment", "CommunicationExternalUser", "CommunicationEntityLink", "CommunicationChannel",
    "WorkspaceToolLinkCredential", "NativeTranscriptInput", "CommunicationMessageNativeInput", "ExternalProviderFetchInput", "ExternalMcpResponseInput", "ExternalMcpConnectionSet", "FinanceReportUploadInput", "CrmQualificationFormInput", "McpToolInput", "ConversationIngressInput", "DemoLeadIntakeInput", "CrmQualificationEmailInput", "AgentRequestInput", "AgentFeedbackInput", "ConversationPromptInput", "ModelUsageBudget", "ModelUsageCost", "ApprovalPolicy", "CrmDealStageTransition", "TensionUpvote", "ArtifactInputSnapshot"].includes(kind);
}

function credentialReadScopes(kind: LineageKind): readonly string[] {
  if (kind === "ExternalMcpResponseInput" || kind === "ExternalMcpConnectionSet") return ["external-tools:read"];
  if (kind === "ArtifactInputSnapshot" || ["McpToolInput", "ConversationIngressInput", "ConversationOperationOutcome"].includes(kind)) return [];
  if (kind === "Workspace") return ["workspace:read"];
  if (["Member", "User"].includes(kind)) return ["members:read"];
  if (["Role", "Circle", "RoleAssignment", "RoleVersion", "RoleHolderHistory", "AgentIdentity", "CircleAgentAssignment"].includes(kind)) return ["circles:read"];
  if (["BrainSource", "BrainArticle", "BrainArticleVersion", "Document", "KnowledgeChunk", "PolicyCorpus", "Constitution", "ConstitutionSourceReference", "BrainDiscussionThread", "BrainDiscussionComment"].includes(kind)) return ["brain:read"];
  if (kind.startsWith("Meeting") || kind === "DeliberationEntry") return ["meetings:read", "brain:read"];
  if (kind.startsWith("ContextGraph") || kind.startsWith("ContextMap")) return ["context-graph:read"];
  if (kind.startsWith("Action")) return ["actions:read", "brain:read"];
  if (kind.startsWith("Tension")) return ["tensions:read", "brain:read"];
  if (kind === "Proposal" || kind.startsWith("Advice") || kind.startsWith("Approval") || kind === "Objection") return ["proposals:read", "brain:read"];
  if (kind.startsWith("Goal") || kind === "KeyResult" || kind === "Recognition") return ["goals:read", "brain:read"];
  if (kind.startsWith("Crm") || kind.startsWith("DemoLead")) return ["relationships:read"];
  if (kind === "WorkspaceToolLink") return ["tools:read"];
  if (kind === "WorkspaceToolLinkCredential") return ["tools:credentials:read"];
  if (kind.startsWith("Execution") || kind.startsWith("BuildArtifact")) return ["execution:read"];
  if (kind.startsWith("External")) return ["external-tools:read"];
  if (kind.startsWith("Finance") || kind.startsWith("ModelUsage")) return ["finance:read"];
  if (kind === "WorkflowJobInput") return ["runtime:read"];
  if (["AgentRun", "AgentStep", "AgentToolCall", "AgentMemory"].includes(kind)) return ["agents:read", "conversations:write"];
  if (kind.startsWith("Conversation") || kind.startsWith("AgentRequest") || kind.startsWith("AgentFeedback") || kind === "RoleOnboardingSession") return ["conversations:write", "agents:read"];
  return ["brain:read"];
}

async function currentCredentialCanRead(db: LineageClient, actor: AppActor, workspaceId: string, kind: LineageKind,
  memo: Map<string, boolean>) {
  const origin = getMcpOrigin();
  if (origin?.kind === "agent" && (actor.kind !== "agent" || actor.authProvider !== "credential"
    || origin.workspaceId !== workspaceId || origin.id !== actor.credentialId
    || origin.credentialVersion !== actor.credentialVersion || origin.scopeHash !== mcpScopesHash(actor.scopes ?? []))) return false;
  if (origin?.kind === "oauth") {
    // The human's workspace membership does not widen an OAuth consent. Every
    // contributing source, including a snapshot's original kind, needs its own
    // data scope under the same authenticated subject and live grant.
    if (actor.kind !== "user" || origin.workspaceId !== workspaceId) return false;
    try {
      await assertSourceCommitMcpOriginCovered(db, workspaceId, origin);
      await assertMcpOriginActive(db, origin, workspaceId);
    } catch { return false; }
    const token = await db.mcpOAuthAccessToken.findUnique({ where: { id: origin.id } });
    if (!token || token.userId !== actor.user.id || token.workspaceId !== workspaceId
      || mcpScopesHash(token.scopes) !== origin.scopeHash) return false;
    const scopes = credentialReadScopes(kind);
    return !scopes.length || scopes.some(scope => token.scopes.includes(scope));
  }
  if (actor.kind !== "agent" || actor.authProvider !== "credential") return true;
  if (!actor.credentialId || !actor.credentialVersion) return false;
  const key = `credential:${actor.credentialId}:${actor.credentialVersion}:${mcpScopesHash(actor.scopes ?? [])}`;
  let live = memo.get(key);
  if (live === undefined) {
    const credential = await db.agentCredential?.findFirst?.({ where: { id: actor.credentialId, workspaceId, isActive: true } });
    live = Boolean(credential && mcpCredentialVersion(credential.tokenHash) === actor.credentialVersion
      && mcpScopesHash(credential.scopes) === mcpScopesHash(actor.scopes ?? []));
    memo.set(key, live);
  }
  const scopes = credentialReadScopes(kind);
  return live && (!scopes.length || scopes.some(scope => actor.scopes?.includes(scope)));
}

type InternalReadPurpose = { kind: "credential-parent"; toolLinkId: string }
  | { kind: "brain-export"; receiptId: string; privateInputs: readonly { kind: string; id: string; fingerprint: string }[] };
function consentAllows(purpose: InternalReadPurpose | undefined, kind: string, id: string, fingerprint: string) {
  return purpose?.kind === "brain-export" && purpose.privateInputs.some(input => input.kind === kind && input.id === id && input.fingerprint === fingerprint);
}
function credentialPurposeSnapshot(row: Record<string, unknown>) {
  return row.sourceKind === "WorkspaceToolLinkCredential" && isRecord(row.accessEnvelopeJson)
    && row.accessEnvelopeJson.credentialParentPurposeVersion === 1;
}

async function rootIsReadable(db: LineageClient, actor: AppActor, workspaceId: string,
  membership: { id: string; role: string } | null, domains: readonly string[], root: LineageRoot,
  visited = new Set<string>(), memo = new Map<string, boolean>(), purpose?: InternalReadPurpose): Promise<boolean> {
  assertSourceCommitTransactionCompatible(db);
  if (hasActiveSourceCommitLockPlan(db)) assertSourceCommitSemanticRootCovered(db, workspaceId, root);
  // Admit the whole stored closure before any remote validator can replay a
  // request containing another contributor's text. Local results never enter
  // the serving memo; the complete remote validation still runs afterwards.
  if (!localCommitAdmission.getStore()) {
    let localMemo = localReadAdmissionMemos.get(memo);
    if (!localMemo) { localMemo = new Map<string, boolean>(); localReadAdmissionMemos.set(memo, localMemo); }
    if (db === prisma) readHeadMemos.set(localMemo, readHeadBinding(memo));
    if (!await localCommitAdmission.run(true, () => rootIsReadable(db, actor, workspaceId,
      membership, domains, root, visited, localMemo, purpose))) return false;
  }
  if (root.permissionEpochs !== undefined && !await isArtifactPermissionEpochProofCurrent(workspaceId, root.permissionEpochs, db)) return false;
  const key = `${root.kind}:${root.id}:${root.fingerprint}:${purpose?.kind === "credential-parent" ? `credential-parent:${purpose.toolLinkId}` : purpose?.kind === "brain-export" ? `brain-export:${purpose.receiptId}` : "ordinary"}`;
  if (visited.has(key)) return false;
  const cached = memo.get(key);
  if (cached !== undefined) return cached;
  const evaluate = () => evaluateRoot(db, actor, workspaceId, membership, domains, root,
    new Set(visited).add(key), memo, false, false, purpose);
  // Typed validators may recursively check an immutable contributor. Those
  // nested checks must join this exact admission ledger, including its sealed
  // final fence, instead of introducing an independent unrecorded head set.
  const result = db === prisma ? await expectedReadHeads.run(readHeadBinding(memo), evaluate) : await evaluate();
  memo.set(key, result);
  return result;
}

// This private mode is confined to a local admission traversal. It can reject a caller
// before a provider request is replayed, but its result is never a read/copy
// proof and it never skips content, envelope, manifest, or parent checks.
const localCommitAdmission = new AsyncLocalStorage<boolean>();
const localReadAdmissionMemos = new WeakMap<Map<string, boolean>, Map<string, boolean>>();
const nativeReplayMemos = new WeakSet<Map<string, boolean>>();
type ReadHeadBinding = { heads: Map<string, string>; sealed: boolean; nativeReplay?: boolean };
const readHeadMemos = new WeakMap<Map<string, boolean>, ReadHeadBinding>();
const expectedReadHeads = new AsyncLocalStorage<ReadHeadBinding>();
/** Retain the exact heads observed by a trusted read, without granting read authority. */
export async function captureArtifactReadHeadObservation<T>(read: () => Promise<T>) {
  const binding = expectedReadHeads.getStore() ?? { heads: new Map<string, string>(), sealed: false };
  const value = await expectedReadHeads.run(binding, read);
  return { value, heads: new Map(binding.heads) };
}

/** Validate original observations inside the caller's actual transaction. This
 * binds only input reads; it neither starts a transaction nor grants authority. */
export async function isArtifactInputProofReadableAtObservedHeads(actor: AppActor, workspaceId: string,
  roots: readonly LineageRoot[], heads: ReadonlyMap<string, string>, db: LineageClient = prisma): Promise<boolean> {
  return expectedReadHeads.run({heads: new Map(heads), sealed: true},
    () => isArtifactInputProofReadable(actor, workspaceId, roots, db));
}

function readHeadBinding(memo: Map<string, boolean>) {
  let binding = readHeadMemos.get(memo);
  if (!binding) { binding = expectedReadHeads.getStore() ?? { heads: new Map(), sealed: false }; readHeadMemos.set(memo, binding); }
  return binding;
}
function observeNativeReplay(memo: Map<string, boolean>) {
  nativeReplayMemos.add(memo);
  // An inner typed validator may await the provider. Every enclosing complete
  // read must then recheck its own whole union, including earlier independent
  // contributors, before returning bytes or registering a collector receipt.
  readHeadBinding(memo).nativeReplay = true;
}
function sealedReadHeadBinding(memo: Map<string, boolean>): ReadHeadBinding {
  const binding = readHeadBinding(memo);
  // An inner validator seals its own final check. The enclosing list/read may
  // still be admitting independent records and must retain its open ledger.
  return { heads: new Map(binding.heads), sealed: true, nativeReplay: binding.nativeReplay };
}
function bindReadHead(memo: Map<string, boolean>, input: LineageInput, manifest: Awaited<ReturnType<typeof latestManifest>>) {
  const binding = readHeadBinding(memo);
  const key = JSON.stringify([input.kind, input.id]);
  const stamp = manifest ? createHash("sha256").update(JSON.stringify([
    manifest.id, manifest.revision, manifest.origin, manifest.contentHash, manifest.inputsJson,
    manifest.rootsJson, manifest.epochProofVersion, manifest.permissionEpochsJson,
  ])).digest("hex") : "ABSENT";
  const prior = binding.heads.get(key);
  if (prior !== undefined) return prior === stamp;
  if (binding.sealed) return false;
  binding.heads.set(key, stamp);
  return true;
}

async function evaluateRoot(db: LineageClient, actor: AppActor, workspaceId: string,
  membership: { id: string; role: string } | null, domains: readonly string[], root: LineageRoot,
  visited: Set<string>, memo: Map<string, boolean>, permissionOnly = false, archivedMetadataOnly = false,
  purpose?: InternalReadPurpose): Promise<boolean> {
  const grantKind = purpose?.kind === "credential-parent" && root.kind === "WorkspaceToolLink" && root.id === purpose.toolLinkId
    ? "WorkspaceToolLinkCredential" : root.kind;
  if (!await currentCredentialCanRead(db, actor, workspaceId, grantKind, memo)) return false;
  const loaded = await loadArtifact(db, workspaceId, root);
  if (!isRecord(loaded) || (isArchived(loaded) && !archivedMetadataOnly)) return false;
  // Bind admission, serving and the final local fence to the same exact heads.
  // Same-body ancestry changes cannot add a locally admitted, unreplayed leaf.
  // Snapshots authenticate their inline ancestry, never an external mutable
  // manifest. Fresh bytes/fingerprint/epochs below remain mandatory.
  const bindHeads = root.kind !== "ArtifactInputSnapshot" && (db === prisma || Boolean(expectedReadHeads.getStore()));
  const readManifest = bindHeads ? await latestManifest(db, workspaceId, root) : undefined;
  if (bindHeads && !bindReadHead(memo, root, readManifest ?? null)) return false;
  const row: Record<string, unknown> = loaded;
  if (root.kind === "ArtifactInputSnapshot") {
    if (row.epochProofVersion !== 1 || !await isArtifactPermissionEpochProofCurrent(workspaceId, row.permissionEpochsJson, db)) return false;
    if (lineageContentFingerprint(root.kind, row) !== root.fingerprint || !isRecord(row.accessEnvelopeJson)
      || typeof row.sourceKind !== "string" || !(row.sourceKind in CONTENT_FIELDS) || row.sourceKind === "ArtifactInputSnapshot") return false;
    const sourceKind = row.sourceKind as LineageKind;
    if (sourceKind === "ConversationOperationOutcome" && row.origin === "NATIVE_ORIGINAL") {
      const live = await loadArtifact(db, workspaceId, { kind: sourceKind, id: String(row.sourceId) });
      if (!live || lineageContentFingerprint(sourceKind, live) !== row.sourceFingerprint) return false;
    }
    if (["KnowledgeChunk", "CommunicationMessage"].includes(sourceKind)) {
      const actualReceipt = await db.artifactInputLineage.findFirst({ where: { workspaceId, artifactType: sourceKind,
        artifactId: String(row.sourceId), contentHash: String(row.sourceFingerprint), origin: "DERIVED" }, orderBy: { revision: "desc" } });
      if (!actualReceipt || !parseRoots(actualReceipt.rootsJson)?.length) return false;
    }
    // A legacy receipt cannot claim fields that its original snapshot never
    // captured. Expanded fingerprints deliberately withhold those histories.
    if (!isRecord(row.contentJson) || lineageContentFingerprint(sourceKind, row.contentJson) !== row.sourceFingerprint) return false;
    if (sourceKind === "ExternalContentSource") {
      const current = await loadArtifact(db, workspaceId, { kind: sourceKind, id: String(row.sourceId) });
      const content = row.contentJson;
      if (!current || !isRecord(content) || ["connectionId", "selectedByUserId", "providerKey", "sourceKind", "externalId"].some(field => content[field] !== current[field])) return false;
    }
    const envelope = row.accessEnvelopeJson;
    const permissionKind = typeof envelope.permissionKind === "string" && envelope.permissionKind in CONTENT_FIELDS
      ? envelope.permissionKind as LineageKind : sourceKind;
    if (permissionKind !== sourceKind && !(sourceKind === "BrainArticleVersion" && permissionKind === "BrainArticle")) return false;
    if (isArchived(envelope) || (!consentAllows(purpose, sourceKind, String(row.sourceId), String(row.sourceFingerprint))
      && !actorCanReadRecord(actor, workspaceId, membership, permissionKind, {...envelope, id: row.sourceId}, sourceKind === "NativeTranscriptInput" ? String(row.sourceFingerprint) : undefined))) return false;
    if (sourceKind === "CheckIn" && !await db.member.findFirst({ where: { id: String(envelope.memberId), workspaceId, isActive: true }, select: { id: true } })) return false;
    if ((sourceKind === "BrainSource" || sourceKind === "Document") && !domains.includes(String(envelope.accessDomain))) return false;
    if (sourceKind === "ConversationTurn" && actor.kind === "user" && envelope.requesterUserId !== actor.user.id
      && !consentAllows(purpose, sourceKind, String(row.sourceId), String(row.sourceFingerprint))) return false;
    const upstream = parseRoots(row.rootsJson as Prisma.JsonValue);
    if (!upstream || !knownSnapshotOrigin(row)
      || (sourceKind === "WorkspaceToolLinkCredential" && (row.origin !== "DERIVED" || !credentialPurposeSnapshot(row)))
      || (row.origin === "DERIVED" && !upstream.length)) return false;
    if (row.origin === "DERIVED") {
      const { isArtifactInputPermissionEpochCoverageComplete } = await import("./source-permission-coverage");
      if (!await isArtifactInputPermissionEpochCoverageComplete({ workspaceId,
        artifact: { kind: sourceKind, id: String(row.sourceId) },
        content: { ...row.contentJson, ...row.accessEnvelopeJson }, roots: upstream,
        permissionEpochs: row.permissionEpochsJson, db })) return false;
    }
    if (row.origin === "HUMAN_ORIGINAL") {
      if (upstream.length !== 0) return false;
      const originalEnvelope = row.accessEnvelopeJson as Record<string, unknown>;
      const manifestId = typeof originalEnvelope.humanOriginalManifestId === "string"
        ? originalEnvelope.humanOriginalManifestId : null;
      const originals = await db.artifactInputLineage.findMany({ where: { workspaceId,
        artifactType: sourceKind, artifactId: String(row.sourceId), contentHash: String(row.sourceFingerprint),
        origin: "HUMAN_ORIGINAL", ...(manifestId ? { id: manifestId } : {}) },
      orderBy: { revision: "desc" }, take: manifestId ? 1 : 5001 });
      if (originals.length > 5000 || originals.some(original => parseRoots(original.rootsJson)?.length !== 0
        || !Array.isArray(original.inputsJson) || original.inputsJson.length !== 0)) return false;
      if (manifestId) {
        if (originals.length !== 1 || originalEnvelope.humanOriginalManifestRevision !== originals[0].revision) return false;
      } else if (!originals.length && !IMPLICIT_HUMAN_ORIGINAL_SNAPSHOT_KINDS.has(sourceKind)) return false;
    }
    if (sourceKind === "WorkspaceToolLinkCredential") {
      const live = await loadArtifact(db, workspaceId, { kind: sourceKind, id: String(row.sourceId) });
      if (!live || lineageContentFingerprint(sourceKind, live) !== row.sourceFingerprint || upstream.length !== 1
        || upstream[0].kind !== "ArtifactInputSnapshot") return false;
      // Authenticate the typed projection before evaluating its embedded full
      // parent. The stored marker never grants a generic metadata read.
      if (!await evaluateRoot(db, actor, workspaceId, membership, domains,
        { kind: sourceKind, id: String(row.sourceId), fingerprint: String(row.sourceFingerprint) }, visited, memo, true)) return false;
      const parent = await loadArtifact(db, workspaceId, upstream[0]);
      if (!parent || parent.sourceKind !== "WorkspaceToolLink" || parent.sourceId !== row.sourceId) return false;
      return rootIsReadable(db, actor, workspaceId, membership, domains, upstream[0], visited, memo,
        { kind: "credential-parent", toolLinkId: String(row.sourceId) });
    }
    if (!await evaluateRoot(db, actor, workspaceId, membership, domains,
      { kind: sourceKind, id: String(row.sourceId), fingerprint: String(row.sourceFingerprint) }, visited, memo, true, false, purpose)) return false;
    for (const input of upstream) if (!await rootIsReadable(db, actor, workspaceId, membership, domains, input, visited, memo, purpose)) return false;
    return true;
  }
  if (root.kind === "GenericDerivedArtifactVariant") {
    if (!isRecord(row.sourceStateJson) || !isRecord(row.scopeJson) || !Array.isArray(row.targetsJson) || !row.targetsJson.length
      || !Array.isArray(row.scopeJson.sources) || !row.scopeJson.sources.length
      || !await isArtifactPermissionEpochProofCurrent(workspaceId, row.sourceStateJson.permissionEpochs, db)
      || !await isArtifactPermissionEpochProofCurrent(workspaceId, row.sourceStateJson.targetEpochs, db)) return false;
    for (const target of row.targetsJson) {
      if (!isRecord(target) || !["ContextGraphObject", "ContextGraphRelationship", "ContextGraphEvidenceRef", "ContextGraphProposedDiff"].includes(String(target.kind))
        || typeof target.id !== "string" || typeof target.manifestId !== "string" || typeof target.fingerprint !== "string") return false;
      const current = await loadArtifact(db, workspaceId, {kind: target.kind as LineageKind, id: target.id});
      const manifest = await latestManifest(db, workspaceId, {kind: target.kind as LineageKind, id: target.id});
      if (!current || isArchived(current) || lineageContentFingerprint(target.kind as LineageKind, current) !== target.fingerprint
        || manifest?.id !== target.manifestId || manifest.contentHash !== target.fingerprint) return false;
    }
    for (const source of row.scopeJson.sources) {
      if (!isRecord(source) || !isLineageKind(source.kind) || typeof source.id !== "string" || typeof source.fingerprint !== "string") return false;
      const current = await loadArtifact(db, workspaceId, {kind: source.kind, id: source.id});
      if (!current || isArchived(current) || lineageContentFingerprint(source.kind, current) !== source.fingerprint) return false;
    }
  }
  if (root.kind === "MeetingAudioAsset") {
    const input = await db.nativeTranscriptInput.findFirst({where: {workspaceId, mode: "AUDIO_UPLOAD", meetingAudioAssetId: root.id}});
    const { isNativeTranscriptInputCurrent } = await import("./native-transcript-input");
    if (!input || !await isNativeTranscriptInputCurrent(actor, workspaceId, input, db)) return false;
  }
  if (root.kind === "NativeTranscriptInput") {
    if (row.mode === "RECORDER") {
      if (getMeetingTranscriptWorkerPurpose(actor, workspaceId) && !await isMeetingTranscriptWorkerCurrent(actor, workspaceId,
        { meetingId: String(row.recorderMeetingId), inputId: root.id }, db === prisma ? undefined : db)) return false;
      const meeting = await db.meeting.findFirst({where: {id: String(row.recorderMeetingId), workspaceId}});
      if (!meeting || !await canReadInformationCategory(actor, workspaceId, meeting.informationCategory, db)
        && !await (await import("./recorder-transcript-input")).isRecorderCategoryCaptureCurrent(actor, workspaceId, meeting.id, db)) return false;
    }
    const { isNativeTranscriptInputCurrent } = await import("./native-transcript-input");
    if (!await isNativeTranscriptInputCurrent(actor, workspaceId, row as unknown as Parameters<typeof isNativeTranscriptInputCurrent>[2], db)) return false;
  }
  if (root.kind === "CommunicationMessageNativeInput") {
    if (db === prisma && !localCommitAdmission.getStore()) observeNativeReplay(memo);
    const authority = await import("./communication-native-authority");
    const current = localCommitAdmission.getStore()
      ? authority.isCommunicationMessageNativeInputLocallyCurrent
      : authority.isCommunicationMessageNativeInputCurrent;
    if (!await current(actor, workspaceId,
      row as unknown as import("./communication-native-authority").CommunicationMessageNativeInputRecord, db)) return false;
  }
  if (root.kind === "ExternalProviderFetchInput") {
    if (db === prisma && !localCommitAdmission.getStore()) observeNativeReplay(memo);
    const authority = await import("./external-provider-authority");
    const current = localCommitAdmission.getStore()
      ? authority.isExternalProviderFetchInputLocallyCurrent
      : authority.isExternalProviderFetchInputCurrent;
    if (!await current(actor, workspaceId, row as unknown as import("@prisma/client").ExternalProviderFetchInput, db)) return false;
  }
  if (root.kind === "ExternalMcpResponseInput") {
    if (db === prisma && !localCommitAdmission.getStore()) observeNativeReplay(memo);
    const authority = await import("./external-mcp-response-input");
    const current = localCommitAdmission.getStore()
      ? authority.isExternalMcpResponseInputLocallyCurrent
      : authority.isExternalMcpResponseInputCurrent;
    if (!await current(actor, workspaceId,
      row as unknown as Parameters<typeof authority.isExternalMcpResponseInputCurrent>[2], db)) return false;
  }
  if ((CATEGORY_BOUND_SOURCE_KINDS as readonly string[]).includes(root.kind)) {
    if (typeof row.informationCategory !== "string") return false;
    if (!await canReadInformationCategory(actor, workspaceId, row.informationCategory, db)
      && !(["Meeting", "MeetingTranscript", "MeetingAgenda"].includes(root.kind)
        && await (await import("./recorder-transcript-input")).isRecorderCategoryCaptureCurrent(actor, workspaceId, root.id, db))) return false;
  }
  if (root.kind === "ExternalDataSource") {
    const {canReadSqlSource} = await import("./sql-source-policy");
    if (!domains.includes(String(row.accessDomain)) || !await canReadSqlSource(actor, workspaceId,
      row as unknown as import("@prisma/client").ExternalDataSource, db)) return false;
  }
  if (root.kind === "SqlNativeRunInput") {
    const authority = await import("./sql-native-input");
    if (db === prisma && !localCommitAdmission.getStore()) observeNativeReplay(memo);
    const current = localCommitAdmission.getStore() ? authority.isSqlNativeRunInputLocallyCurrent : authority.isSqlNativeRunInputCurrent;
    if (!await current(actor, workspaceId,
      row as unknown as import("@prisma/client").SqlNativeRunInput, db)) return false;
  }
  if (root.kind === "ExternalContentSource") {
    const { isExternalProviderSelectionCurrent } = await import("./external-provider-authority");
    if (!await isExternalProviderSelectionCurrent(actor, workspaceId, row as unknown as import("@prisma/client").ExternalContentSource, db)) return false;
  }
  if (root.kind === "McpToolInput" && (!isMcpToolInputEncryptedPayload(row.argumentsJson) || !Array.isArray(row.requiredScopes) || !row.requiredScopes.length
    || row.requiredScopes.some(scope => typeof scope !== "string" || !scope))) return false;
  if (root.kind === "ConversationOperationOutcome") {
    if (row.operation === "LEGACY_RECOVERY_PUBLICATION") {
      const { currentLegacyRecoveryPublication } = await import("./legacy-recovery");
      const recovery = await currentLegacyRecoveryPublication(actor, workspaceId, row, db);
      if (!recovery) return false;
      for (const input of recovery.roots) if (!await rootIsReadable(db, actor, workspaceId, membership, domains, input, visited, memo, purpose)) return false;
    } else if (row.operation === "BRAIN_EXPORT_CONSENT") {
      const { currentBrainExportConsent } = await import("./conversation-brain-consent");
      const consent = await currentBrainExportConsent(actor, row, workspaceId, db);
      if (!consent || !(actor.kind === "user" && membership
        || await isBrainExportWorkerCurrent(actor, workspaceId, root.id, db))) return false;
      const exportPurpose: InternalReadPurpose = { kind: "brain-export", receiptId: root.id, privateInputs: consent.privateInputs };
      for (const input of consent.roots) if (!await rootIsReadable(db, actor, workspaceId, membership, domains, input, visited, memo, exportPurpose)) return false;
    } else if (row.operation === "BRAIN_SOURCE_REMOVAL_COMPLETED") {
      const { isBrainSourceRemovalOutcomeReadable } = await import("./brain-source-removal-outcome");
      if (!await isBrainSourceRemovalOutcomeReadable(actor, workspaceId, row, db)) return false;
    } else if (row.operation === "ACTION_COMPLETED") {
      const { isActionCompletionOutcomeReadable } = await import("./action-completion");
      if (!await isActionCompletionOutcomeReadable(actor, workspaceId,
        row as unknown as Parameters<typeof isActionCompletionOutcomeReadable>[2], db)) return false;
    } else if (row.operation === "ACTION_COMPLETION_PUBLIC_NOTE") {
      const { isActionCompletionPublicNoteReadable } = await import("./action-completion");
      if (!await isActionCompletionPublicNoteReadable(actor, workspaceId,
        row as unknown as Parameters<typeof isActionCompletionPublicNoteReadable>[2], db)) return false;
    } else if (row.operation !== "TOOL_LINK_ARCHIVED"
      || typeof row.requestKey !== "string" || !/^[a-f0-9]{64}$/.test(row.requestKey)
      || !Array.isArray(row.requiredScopes) || row.requiredScopes.length !== 1 || row.requiredScopes[0] !== "tools:write") return false;
  }
  if (root.kind === "WorkspaceToolLinkCredential") {
    if (actor.kind === "agent") {
      if (actor.authProvider !== "credential" || !actor.credentialId || !actor.credentialVersion) return false;
      const credential = await db.agentCredential.findFirst({ where: { id: actor.credentialId, workspaceId, isActive: true } });
      if (!credential || mcpCredentialVersion(credential.tokenHash) !== actor.credentialVersion
        || mcpScopesHash(credential.scopes) !== mcpScopesHash(actor.scopes ?? []) || !credential.scopes.includes("tools:credentials:read")) return false;
    }
    const parent = await loadArtifact(db, workspaceId, { kind: "WorkspaceToolLink", id: root.id });
    if (!parent || !await rootIsReadable(db, actor, workspaceId, membership, domains,
      { kind: "WorkspaceToolLink", id: root.id, fingerprint: lineageContentFingerprint("WorkspaceToolLink", parent) }, visited, memo,
      { kind: "credential-parent", toolLinkId: root.id })) return false;
  }
  if (root.kind === "BrainSource" && ["DOC", "FILE_UPLOAD"].includes(String(row.sourceType))
    && isRecord(row.metadata) && typeof row.metadata.documentId === "string") {
    const parent = await loadArtifact(db, workspaceId, { kind: "Document", id: row.metadata.documentId });
    if (!parent || !await evaluateRoot(db, actor, workspaceId, membership, domains,
      { kind: "Document", id: row.metadata.documentId, fingerprint: lineageContentFingerprint("Document", parent) }, visited, memo, permissionOnly)) return false;
  }
  if (["ConversationOperationOutcome", "ConversationIngressInput", "McpToolInput"].includes(root.kind) && row.actorKind === "agent") {
    const credential = await db.agentCredential.findFirst({ where: { id: String(row.credentialId), workspaceId, isActive: true } });
    if (!credential || mcpCredentialVersion(credential.tokenHash) !== row.credentialVersion
      || mcpScopesHash(credential.scopes) !== row.scopeHash
      || (root.kind === "ConversationIngressInput" ? !credential.scopes.includes("conversations:write")
        : !Array.isArray(row.requiredScopes) || !row.requiredScopes.length || row.requiredScopes.some(scope => typeof scope !== "string" || !credential.scopes.includes(scope)))) return false;
  }
  if (["CrmQualificationEmailInput", "CrmQualification"].includes(root.kind)) {
    const intake = await loadArtifact(db, workspaceId, { kind: "DemoLeadIntakeInput", id: String(row.demoLeadId) });
    if (!intake || isArchived(intake)) return false;
  }
  if (root.kind === "CrmQualificationFormInput") {
    const intake = await loadArtifact(db, workspaceId, { kind: "DemoLeadIntakeInput", id: String(row.demoLeadId) });
    const qualification = await db.crmQualification.findFirst({ where: { id: String(row.qualificationId), workspaceId, demoLeadId: String(row.demoLeadId) }, select: { id: true } });
    if (!intake || !qualification) return false;
  }
  if (root.kind === "FinanceReportUploadInput") {
    if (!domains.includes("FINANCE") || actor.kind !== "user") return false;
    const batch = await db.financeImportBatch.findFirst({ where: { id: String(row.batchId), workspaceId } });
    if (!batch || batch.uploadedByUserId !== row.uploadedByUserId || batch.documentId !== row.documentId
      || batch.brainSourceId !== row.brainSourceId || batch.fileHash !== row.fileHash || batch.fileSizeBytes !== row.fileSizeBytes
      || batch.mimeType !== row.mimeType || batch.originalFilename !== row.originalFilename) return false;
    for (const [kind, id] of [["Document", row.documentId], ["BrainSource", row.brainSourceId]] as const) {
      const parent = await loadArtifact(db, workspaceId, { kind, id: String(id) });
      if (!parent || parent.accessDomain !== "FINANCE"
        || parent[kind === "Document" ? "storageKey" : "fileStorageKey"] !== row.storageKey
        || !await evaluateRoot(db, actor, workspaceId, membership, domains,
          { kind, id: String(id), fingerprint: lineageContentFingerprint(kind, parent) }, visited, memo, true)) return false;
    }
  }
  if (["FinanceReport", "FinanceReportFact", "FinanceReportFactRevision", "FinanceImportApplication"].includes(root.kind)) {
    if (!domains.includes("FINANCE") || actor.kind !== "user") return false;
    if (root.kind === "FinanceReport" && row.status === "ARCHIVED") return false;
    if (root.kind === "FinanceReportFact") {
      if (!(row.periodStart instanceof Date) || !Number.isFinite(row.periodStart.valueOf())
        || !(row.periodEnd instanceof Date) || !Number.isFinite(row.periodEnd.valueOf())) return false;
      const revision = await db.financeReportFactRevision.findFirst({where: {workspaceId, factId: root.id, factVersion: Number(row.version)}});
      const manifest = await latestManifest(db, workspaceId, root);
      if (!revision || !isFinanceFactRevisionIntact(revision)
        || revision.valueHash !== financeValueHash(financeFactValue(row as unknown as import("@prisma/client").FinanceReportFact))
        || !parseRoots(manifest?.rootsJson ?? null)?.some(input => input.kind === "FinanceReportFactRevision" && input.id === revision.id)) return false;
    }
    if (root.kind === "FinanceReportFactRevision") {
      if (!permissionOnly && !isFinanceFactRevisionIntact(row)) return false;
      const fact = await db.financeReportFact.findFirst({ where: { id: String(row.factId), workspaceId }, select: { id: true, kind: true } });
      if (!fact || fact.kind !== row.kind) return false;
    }
    const parents: LineageInput[] = root.kind === "FinanceReport" ? [{ kind: "FinanceImportBatch", id: String(row.sourceBatchId) }]
      : ["FinanceReportFact", "FinanceReportFactRevision"].includes(root.kind) ? [{ kind: "FinanceReport", id: String(row.reportId) }, { kind: "FinanceImportBatch", id: String(row.sourceBatchId) }, { kind: "FinanceImportCandidate", id: String(row.sourceCandidateId) }]
      : [{ kind: "FinanceImportBatch", id: String(row.batchId) }, { kind: "FinanceImportCandidate", id: String(row.candidateId) }, ...[row.beforeRevisionId, row.afterRevisionId].flatMap(id => id ? [{ kind: "FinanceReportFactRevision" as const, id: String(id) }] : [])];
    for (const parentInput of parents) {
      const parent = await loadArtifact(db, workspaceId, parentInput);
      if (!parent || !await evaluateRoot(db, actor, workspaceId, membership, domains,
        { ...parentInput, fingerprint: lineageContentFingerprint(parentInput.kind, parent) }, visited, memo, true)) return false;
    }
  }
  if (root.kind === "FinanceImportBatch") {
    if (!domains.includes("FINANCE") || actor.kind !== "user") return false;
    const upload = await db.financeReportUploadInput.findFirst({ where: { workspaceId, batchId: root.id } });
    if (!upload || !await evaluateRoot(db, actor, workspaceId, membership, domains,
      { kind: "FinanceReportUploadInput", id: upload.id, fingerprint: lineageContentFingerprint("FinanceReportUploadInput", upload) }, visited, memo, true)) return false;
  }
  if (root.kind === "FinanceImportApplication" && row.targetFactId && !row.afterRevisionId) return false;
  if (root.kind === "FinanceImportCandidate") {
    if (!domains.includes("FINANCE") || actor.kind !== "user") return false;
    const batch = await loadArtifact(db, workspaceId, { kind: "FinanceImportBatch", id: String(row.batchId) });
    // The immutable stored ancestry proves the consumed batch revision. Its
    // current parent supplies only live Finance and native-upload authority.
    if (!batch || !await evaluateRoot(db, actor, workspaceId, membership, domains,
      { kind: "FinanceImportBatch", id: String(row.batchId), fingerprint: lineageContentFingerprint("FinanceImportBatch", batch) }, visited, memo, true)) return false;
  }
  if (["ExecutionRequest", "ExecutionResult"].includes(root.kind) && actor.kind === "agent") {
    if (actor.authProvider !== "credential" || !actor.credentialId || !actor.credentialVersion) return false;
    const credential = await db.agentCredential.findFirst({ where: { id: actor.credentialId, workspaceId, isActive: true } });
    if (!credential || mcpCredentialVersion(credential.tokenHash) !== actor.credentialVersion
      || mcpScopesHash(credential.scopes) !== mcpScopesHash(actor.scopes ?? []) || !credential.scopes.includes("execution:read")) return false;
  }
  if (root.kind === "ExecutionResult") {
    const parent = await loadArtifact(db, workspaceId, { kind: "ExecutionRequest", id: String(row.executionRequestId) });
    if (!parent || !await evaluateRoot(db, actor, workspaceId, membership, domains,
      { kind: "ExecutionRequest", id: String(row.executionRequestId), fingerprint: lineageContentFingerprint("ExecutionRequest", parent) }, visited, memo, permissionOnly)) return false;
  }
  if (root.kind === "CheckIn" && (!actorCanReadRecord(actor, workspaceId, membership, root.kind, row)
    || !await db.member.findFirst({ where: { id: String(row.memberId), workspaceId, isActive: true }, select: { id: true } }))) return false;
  if (root.kind === "RoleAssignment") {
    if (row.expiresAt instanceof Date && row.expiresAt <= new Date()) return false;
    const [member, role] = await Promise.all([
      db.member.findFirst({ where: { id: String(row.memberId), workspaceId, isActive: true }, select: { id: true } }),
      db.role.findFirst({ where: { id: String(row.roleId), archivedAt: null,
        circle: { workspaceId, archivedAt: null } }, select: { id: true } }),
    ]);
    if (!member || !role) return false;
  }
  if (root.kind === "Role" && !await db.circle.findFirst({ where: { id: String(row.circleId), workspaceId, archivedAt: null }, select: { id: true } })) return false;
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
    if (!target || target.variantOfArticleId != null || !actorCanReadRecord(actor, workspaceId, membership, "BrainArticle", target)
      || lineageContentFingerprint("BrainArticle", target) !== row.variantTargetFingerprint) return false;
    for (const [stateKey, expected] of Object.entries(row.variantSourceStateJson)) {
      if (typeof expected !== "string" || !/^[a-f0-9]{64}$/.test(expected)) return false;
      let entityType = "BrainSource", entityId = stateKey;
      if (stateKey.startsWith("[")) {
        try {
          const typed = JSON.parse(stateKey);
          if (!Array.isArray(typed) || typed.length !== 2 || typeof typed[0] !== "string" || !(typed[0] in CONTENT_FIELDS)
            || typeof typed[1] !== "string" || !typed[1]) return false;
          entityType = typed[0] === "MeetingTranscript" ? "Meeting" : typed[0]; entityId = typed[1];
        } catch { return false; }
      }
      const history = await db.workspaceArchiveRecord.findMany({ where: { workspaceId, entityType, entityId },
        select: { id: true, archivedAt: true, restoredAt: true, purgedAt: true }, orderBy: { id: "asc" } });
      if (createHash("sha256").update(JSON.stringify(history)).digest("hex") !== expected) return false;
    }
  }
  if (root.kind === "CrmProspectWorkspace") {
    try { await requireWorkspaceMembership({ actor, workspaceId: String(row.targetWorkspaceId), tx: db }); }
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
    const sourceKinds: Record<string, LineageKind> = { BRAIN_ARTICLE: "BrainArticle", DOCUMENT: "Document", MEETING: "Meeting", PROPOSAL: "Proposal", EXTERNAL_CONTENT: "ExternalContentSource", EXTERNAL_DATABASE: "SqlNativeRunInput" };
    const kind = sourceKinds[String(row.sourceType)];
    if (!kind || !isRecord(row.metadata)) return false;
    const sourceId = row.sourceType === "EXTERNAL_DATABASE" ? row.metadata.nativeInputId : row.sourceId;
    if (typeof sourceId !== "string" || !sourceId) return false;
    if (row.sourceType === "EXTERNAL_DATABASE") {
      const {isSqlKnowledgeChunkPublished} = await import("./sql-native-input");
      if (!await isSqlKnowledgeChunkPublished(workspaceId, row, db)) return false;
    }
    if (row.sourceType === "EXTERNAL_DATABASE") {
      const fingerprint = row.metadata.sourceContentHash;
      if (typeof fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(fingerprint)
        || !await rootIsReadable(db, actor, workspaceId, membership, domains,
          {kind, id: sourceId, fingerprint}, visited, memo)) return false;
    } else {
      const source = await loadArtifact(db, workspaceId, { kind, id: sourceId });
      if (!isRecord(source)) return false;
      const fingerprint = lineageContentFingerprint(kind, source);
      if (permissionOnly) {
        // Immutable chunk receipts retain the consumed parent revision. Only its
        // live visibility envelope is read here; the snapshot's ancestry proves bytes.
        if (!await evaluateRoot(db, actor, workspaceId, membership, domains,
          { kind, id: sourceId, fingerprint }, visited, memo, true)) return false;
      } else if (row.metadata.sourceContentHash !== fingerprint || !await rootIsReadable(db, actor, workspaceId, membership, domains,
        { kind, id: sourceId, fingerprint }, visited, memo)) return false;
    }
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
    const session = await loadArtifact(db, workspaceId, { kind: "ConversationSession", id: String(row.sessionId) });
    if (!session || session.userId !== row.userId || (actor.kind === "user" && session.userId !== actor.user.id
      && !consentAllows(purpose, root.kind, root.id, root.fingerprint))) return false;
  }
  if (root.kind === "ConversationTurn") {
    const session = await loadArtifact(db, workspaceId, { kind: "ConversationSession", id: String(row.conversationId) });
    if (!session || (!consentAllows(purpose, root.kind, root.id, root.fingerprint)
      && (actor.kind !== "user" || session.userId !== actor.user.id))) return false;
  }
  if (root.kind === "AdviceRequest" && (actor.kind !== "user" || row.requestedByUserId !== actor.user.id)) {
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
      { ...parent, fingerprint: lineageContentFingerprint(parent.kind, parentRow) }, visited, memo,
      root.kind === "BuildArtifactAsset" ? permissionOnly : true)) return false;
  }
  if (root.kind === "BrainArticleVersion") {
    const parent = await db.brainArticle.findFirst({ where: {
      id: String((row as Record<string, unknown>).articleId), workspaceId,
    } });
    if (!isRecord(parent) || isArchived(parent) || !actorCanReadRecord(actor, workspaceId, membership, "BrainArticle", parent)
      || !isRecord(row.accessEnvelopeJson)
      || typeof row.accessEnvelopeJson.isPrivate !== "boolean"
      || !actorCanReadRecord(actor, workspaceId, membership, "BrainArticle", row.accessEnvelopeJson)) return false;
  }
  if (root.kind === "GoalLink") {
    const parent = await db.goal.findFirst({ where: {
      id: String((row as Record<string, unknown>).goalId), workspaceId,
    } });
    if (!isRecord(parent) || isArchived(parent) || !actorCanReadRecord(actor, workspaceId, membership, "Goal", parent)) return false;
  }
  if (root.kind === "ContextMapLayoutItem") {
    const parent = await db.contextMapView.findFirst({ where: {
      id: String((row as Record<string, unknown>).mapViewId), workspaceId,
    } });
    if (!isRecord(parent) || !actorCanReadRecord(actor, workspaceId, membership, "ContextMapView", parent)) return false;
  }
  if ((root.kind === "BrainSource" || root.kind === "Document")
    && !domains.includes(String((row as Record<string, unknown>).accessDomain))) return false;
  if (!consentAllows(purpose, root.kind, root.id, root.fingerprint) && !actorCanReadRecord(actor, workspaceId, membership, root.kind, row)) return false;
  if (permissionOnly) return true;
  if (lineageContentFingerprint(root.kind, row) !== root.fingerprint) return false;
  const manifest = db === prisma ? readManifest ?? null : await latestManifest(db, workspaceId, root);
  if (needsManifest(root.kind, row) || manifest) {
    if (!manifest || manifest.contentHash !== root.fingerprint) return false;
    const upstream = parseRoots(manifest.rootsJson);
    if (manifest.origin === "NATIVE_ORIGINAL" && root.kind === "ConversationOperationOutcome") {
      return isNativeControlOutcome(row) && upstream?.length === 0 && Array.isArray(manifest.inputsJson)
        && manifest.inputsJson.length === 0 && manifest.epochProofVersion === 1
        && await isArtifactPermissionEpochProofCurrent(workspaceId, manifest.permissionEpochsJson, db);
    }
    // A member's expressly contributed company answer can be an original source.
    // Copied/model-produced sources require a nonempty upstream proof.
    if (manifest.origin === "HUMAN_ORIGINAL") return !["MeetingAudioAsset", "GenericDerivedArtifactVariant", "KnowledgeChunk", "CommunicationMessage", "FinanceReport", "FinanceReportFact", "FinanceReportFactRevision", "FinanceImportApplication", "FinanceImportBatch", "FinanceImportCandidate", "ExecutionResult", "ConversationOperationOutcome", "AgentRun", "AgentStep", "AgentToolCall"].includes(root.kind)
      && !(root.kind === "BrainSource" && ["DOC", "FILE_UPLOAD"].includes(String(row.sourceType)) && isRecord(row.metadata) && typeof row.metadata.documentId === "string")
      && upstream?.length === 0 && Array.isArray(manifest.inputsJson) && manifest.inputsJson.length === 0;
    if (manifest.origin !== "DERIVED" || !upstream?.length || manifest.epochProofVersion !== 1
      || !await isArtifactPermissionEpochProofCurrent(workspaceId, manifest.permissionEpochsJson, db)) return false;
    const { isArtifactInputPermissionEpochCoverageComplete } = await import("./source-permission-coverage");
    if (!await isArtifactInputPermissionEpochCoverageComplete({ workspaceId, artifact: root,
      content: row, roots: upstream, permissionEpochs: manifest.permissionEpochsJson, db })) return false;
    // Earlier direct secret roots did not bind the full parent revision that
    // contributed the value. Persisted derivations now require its typed snapshot.
    if (upstream.some(input => input.kind === "WorkspaceToolLinkCredential")) return false;
    for (const input of upstream) {
      if (!await rootIsReadable(db, actor, workspaceId, membership, domains, input, visited, memo, purpose)) return false;
    }
  }
  return true;
}

async function saveAllocatedInputSnapshot(actor: AppActor, tx: Prisma.TransactionClient, workspaceId: string,
  root: LineageRoot, data: Prisma.ArtifactInputSnapshotUncheckedCreateInput) {
  const id = allocateArtifactInputSnapshotId(actor, workspaceId, tx, root);
  if (id) {
    const retained = await tx.artifactInputSnapshot.findFirst({ where: { id, workspaceId } });
    if (retained) {
      invariant(lineageContentFingerprint("ArtifactInputSnapshot", retained)
        === lineageContentFingerprint("ArtifactInputSnapshot", { ...data,
          createdAt: data.createdAt ?? retained.createdAt,
          updatedAt: (retained as unknown as Record<string, unknown>).updatedAt }),
      409, "SOURCE_CHANGED", "Preallocated snapshot contains a different consumed revision.");
      if (hasActiveSourceCommitLockPlan(tx)) registerSourceCommitPublishedOutput(tx, workspaceId,
        { kind: "ArtifactInputSnapshot", id: retained.id, fingerprint: lineageContentFingerprint("ArtifactInputSnapshot", retained) });
      return retained;
    }
  }
  const snapshot = await tx.artifactInputSnapshot.create({ data: { ...data, ...(id ? { id } : {}) } });
  if (hasActiveSourceCommitLockPlan(tx)) registerSourceCommitPublishedOutput(tx, workspaceId,
    { kind: "ArtifactInputSnapshot", id: snapshot.id, fingerprint: lineageContentFingerprint("ArtifactInputSnapshot", snapshot) });
  return snapshot;
}

async function snapshotInput(actor: AppActor, tx: Prisma.TransactionClient, workspaceId: string, root: LineageRoot,
  convertInputs?: (inputs: LineageRoot[]) => Promise<LineageRoot[]>,
  recordedBefore?: { content: Record<string, unknown>; manifest: NonNullable<Awaited<ReturnType<typeof latestManifest>>> }): Promise<{ root: LineageRoot; roots: LineageRoot[] }> {
  await assertArtifactInputWriteFence(tx);
  const content = recordedBefore?.content ?? await loadArtifact(tx, workspaceId, root);
  invariant(isRecord(content) && lineageContentFingerprint(root.kind, content) === root.fingerprint,
    409, "SOURCE_CHANGED", "A mutable input changed before its snapshot was saved.");
  if (root.kind === "SqlNativeRunInput") {
    // This is already a byte-preserving immutable authenticated receipt. Retain
    // its original vector; a snapshot must not restamp it as a human original.
    invariant(root.permissionEpochs && await isArtifactPermissionEpochProofCurrent(workspaceId, root.permissionEpochs, tx),
      409, "SOURCE_CHANGED", "SQL native input lost its original permission vector.");
    return {root: structuredClone(root), roots: []};
  }
  if (root.kind === "ArtifactInputSnapshot") {
    const inputs = parseRoots(content.rootsJson as Prisma.JsonValue);
    invariant(inputs && typeof content.sourceKind === "string" && content.sourceKind !== "ArtifactInputSnapshot"
      && (knownSnapshotOrigin(content) && (content.origin !== "DERIVED" || inputs.length > 0)),
    409, "UNKNOWN_LINEAGE", "An immutable input has incomplete lineage.");
    let roots = convertInputs ? await convertInputs(inputs) : inputs;
    const credentialSnapshot = credentialPurposeSnapshot(content);
    if (credentialSnapshot) {
      const parents: LineageRoot[] = [];
      for (const candidate of roots) {
        if (candidate.kind !== "ArtifactInputSnapshot") continue;
        const parent = await loadArtifact(tx, workspaceId, candidate);
        if (parent?.sourceKind === "WorkspaceToolLink" && parent.sourceId === content.sourceId) parents.push(candidate);
      }
      invariant(parents.length === 1, 409, "UNKNOWN_LINEAGE", "Credential history requires its exact embedded parent proof.");
      roots = parents;
    }
    const signature = (proof: LineageRoot[]) => JSON.stringify(proof.map((input) => `${input.kind}:${input.id}:${input.fingerprint}`).sort());
    // Already frozen ancestry can retain its capability identity. Mutable
    // ancestors force a new receipt; no existing historical row is rewritten.
    if (signature(roots) === signature(inputs)) return { root, roots: credentialSnapshot ? [] : roots };
    const snapshot = await saveAllocatedInputSnapshot(actor, tx, workspaceId, root, {
      epochProofVersion: content.epochProofVersion as number, permissionEpochsJson: content.permissionEpochsJson as Prisma.InputJsonValue,
      workspaceId, sourceKind: content.sourceKind, sourceId: String(content.sourceId),
      sourceFingerprint: String(content.sourceFingerprint), origin: String(content.origin),
      contentJson: content.contentJson as Prisma.InputJsonValue,
      accessEnvelopeJson: content.accessEnvelopeJson as Prisma.InputJsonValue,
      rootsJson: roots as Prisma.InputJsonArray,
    });
    return { root: { kind: "ArtifactInputSnapshot" as const, id: snapshot.id,
      fingerprint: lineageContentFingerprint("ArtifactInputSnapshot", snapshot) }, roots: credentialSnapshot ? [] : roots };
  }
  if (root.kind === "WorkspaceToolLinkCredential") {
    // Only this typed secret projection may embed the complete parent proof.
    // Its metadata never becomes a separately usable generic source root.
    const parent = await loadArtifact(tx, workspaceId, { kind: "WorkspaceToolLink", id: root.id });
    invariant(parent, 409, "SOURCE_CHANGED", "Credential parent is unavailable.");
    const parentReceipt = await snapshotInput(actor, tx, workspaceId, { kind: "WorkspaceToolLink", id: root.id,
      fingerprint: lineageContentFingerprint("WorkspaceToolLink", parent) }, convertInputs);
    const permissionEpochs = await captureArtifactPermissionEpochs(actor, workspaceId, [root, parentReceipt.root], tx);
    const accessEnvelope = Object.fromEntries(["workspaceId", "createdByUserId", "archivedAt", "archivedByUserId"]
      .map(field => [field, content[field] ?? null]));
    const snapshot = await saveAllocatedInputSnapshot(actor, tx, workspaceId, root, {
      workspaceId, sourceKind: root.kind, sourceId: root.id, sourceFingerprint: root.fingerprint, origin: "DERIVED",
      epochProofVersion: 1, permissionEpochsJson: permissionEpochs as unknown as Prisma.InputJsonValue,
      contentJson: JSON.parse(JSON.stringify(Object.fromEntries(snapshotContentFields(root.kind, content)
        .map(field => [field, content[field] ?? null])))) as Prisma.InputJsonValue,
      accessEnvelopeJson: { ...accessEnvelope, credentialParentPurposeVersion: 1 } as Prisma.InputJsonObject,
      rootsJson: [parentReceipt.root] as Prisma.InputJsonArray,
    });
    return { root: { kind: "ArtifactInputSnapshot" as const, id: snapshot.id,
      fingerprint: lineageContentFingerprint("ArtifactInputSnapshot", snapshot) }, roots: [] as LineageRoot[] };
  }
  const recordedManifest = recordedBefore?.manifest ?? await latestManifest(tx, workspaceId, root);
  const nativeOriginal = ["NativeTranscriptInput", "CommunicationMessageNativeInput", "ExternalProviderFetchInput", "ExternalMcpResponseInput", "ExternalMcpConnectionSet", "Workspace", "Member", "User", "RoleAssignment", "CircleAgentAssignment", "CommunicationExternalUser", "CommunicationEntityLink", "CommunicationChannel", "FinanceReportUploadInput", "CrmQualificationFormInput", "McpToolInput", "ConversationIngressInput", "DemoLeadIntakeInput", "CrmQualificationEmailInput", "ConversationPromptInput", "AgentRequestInput", "AgentFeedbackInput", "ModelUsageBudget", "ModelUsageCost", "ApprovalPolicy", "CrmDealStageTransition", "TensionUpvote"].includes(root.kind);
  const manifest = recordedManifest ?? (nativeOriginal ? { contentHash: root.fingerprint, origin: ["SqlNativeRunInput", "NativeTranscriptInput", "CommunicationMessageNativeInput", "ExternalProviderFetchInput", "ExternalMcpResponseInput", "ExternalMcpConnectionSet", "FinanceReportUploadInput", "CrmQualificationFormInput", "ConversationIngressInput", "McpToolInput"].includes(root.kind) ? "NATIVE_ORIGINAL" : "HUMAN_ORIGINAL", rootsJson: [], inputsJson: [] } : null);
  const inputs = manifest ? parseRoots(manifest.rootsJson) : null;
  invariant(manifest && manifest.contentHash === root.fingerprint && inputs
    && (manifest.origin === "DERIVED" || (manifest.origin === "HUMAN_ORIGINAL"
      && Array.isArray(manifest.inputsJson) && manifest.inputsJson.length === 0)
      || (manifest.origin === "NATIVE_ORIGINAL" && (["SqlNativeRunInput", "NativeTranscriptInput", "CommunicationMessageNativeInput", "ExternalProviderFetchInput", "ExternalMcpResponseInput", "ExternalMcpConnectionSet", "FinanceReportUploadInput", "CrmQualificationFormInput", "ConversationIngressInput", "McpToolInput"].includes(root.kind)
        || (root.kind === "ConversationOperationOutcome" && isNativeControlOutcome(content))))),
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
  const contentJson = Object.fromEntries(snapshotContentFields(root.kind, content)
    .map((field) => [field, record[field] ?? null]));
  const accessEnvelope = Object.fromEntries(["permissionKind", "operation", "kind", "isPrivate", "ownerMemberId", "authorUserId", "status", "createdByUserId",
    "localUserId", "selectedByUserId", "connectionId", "providerKey", "sourceKind", "externalId", "submittedByUserId", "agentCredentialId", "actorKind", "credentialId", "credentialVersion", "scopeHash", "visibility", "classification", "publicEnabledAt", "publicRevokedAt", "isActive", "agentKey", "userId", "sessionId", "conversationId", "memberId", "authorMemberId", "recipientMemberId", "archivedAt", "accessDomain", "requesterUserId", "variantOfArticleId", "variantTargetFingerprint", "variantInputSetHash"]
    .map((field) => [field, envelope[field] ?? null]));
  if (root.kind === "NativeTranscriptInput" && ["PROVIDER_IMPORT", "COMPANY_MEMBER_UPLOAD"].includes(String(record.mode))) accessEnvelope.mode = String(record.mode);
  if (root.kind === "NativeTranscriptInput" && record.mode === "RECORDER") Object.assign(accessEnvelope, {
    mode: record.mode, recordingId: record.recordingId, recorderAttemptId: record.recorderAttemptId,
    recorderMeetingId: record.recorderMeetingId, recorderBindingId: record.recorderBindingId, recorderProvider: record.recorderProvider,
  });
  if (manifest.origin === "HUMAN_ORIGINAL" && "id" in manifest && typeof manifest.id === "string") {
    accessEnvelope.humanOriginalManifestId = manifest.id;
    accessEnvelope.humanOriginalManifestRevision = manifest.revision;
  }
  const permissionEpochs = await captureArtifactPermissionEpochs(actor, workspaceId, [root, ...snapshotRoots], tx);
  const snapshot = await saveAllocatedInputSnapshot(actor, tx, workspaceId, root, {
    epochProofVersion: 1, permissionEpochsJson: permissionEpochs as unknown as Prisma.InputJsonValue,
    workspaceId, sourceKind: root.kind, sourceId: root.id, sourceFingerprint: root.fingerprint,
    origin: manifest.origin, contentJson: JSON.parse(JSON.stringify(contentJson)) as Prisma.InputJsonValue,
    accessEnvelopeJson: JSON.parse(JSON.stringify(accessEnvelope)) as Prisma.InputJsonValue,
    rootsJson: snapshotRoots as Prisma.InputJsonArray,
  });
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
  const snapshot = await snapshotInput(actor, tx, workspaceId, direct);
  return [snapshot.root, ...snapshot.roots];
}

/** Freeze every consumed revision, including ancestors of existing immutable receipts.
 * Live grant checks remain attached to each original source; this never restores access.
 */
export async function captureImmutableArtifactInputProof(actor: AppActor, workspaceId: string,
  roots: readonly LineageRoot[], tx: Prisma.TransactionClient): Promise<LineageRoot[]> {
  invariant(await isArtifactInputProofReadable(actor, workspaceId, roots, tx),
    409, "SOURCE_CHANGED", "Inputs changed before they could be preserved.");
  const memo = new Map<string, Awaited<ReturnType<typeof snapshotInput>>>();
  const freeze = async (root: LineageRoot, visiting = new Set<string>()): Promise<Awaited<ReturnType<typeof snapshotInput>>> => {
    const key = `${root.kind}:${root.id}:${root.fingerprint}`;
    invariant(!visiting.has(key), 409, "UNKNOWN_LINEAGE", "Input lineage is cyclic.");
    const prior = memo.get(key);
    if (prior) return prior;
    const receipt = await snapshotInput(actor, tx, workspaceId, root, async (inputs) => {
      const frozen = new Map<string, LineageRoot>();
      for (const input of inputs) {
        const snapshot = await freeze(input, new Set(visiting).add(key));
        for (const proof of [snapshot.root, ...snapshot.roots]) {
          const key = `${proof.kind}:${proof.id}`;
          frozen.set(key, mergeLineageInputRoot(frozen.get(key), proof));
        }
      }
      return [...frozen.values()];
    });
    memo.set(key, receipt);
    return receipt;
  };
  const frozen = new Map<string, LineageRoot>();
  for (const root of roots) {
    const receipt = await freeze(root);
    for (const proof of [receipt.root, ...receipt.roots]) {
      const key = `${proof.kind}:${proof.id}`;
      frozen.set(key, mergeLineageInputRoot(frozen.get(key), proof));
    }
  }
  const proof = [...frozen.values()];
  invariant(await isArtifactInputProofReadable(actor, workspaceId, proof, tx),
    409, "SOURCE_CHANGED", "Input permissions changed while they were preserved.");
  return proof;
}

/** Preserve unproven legacy content as history without granting it input/read eligibility. */
export async function preserveUnknownArtifactInputSnapshot(tx: Prisma.TransactionClient, workspaceId: string,
  input: LineageInput, content: unknown) {
  await assertArtifactInputWriteFence(tx);
  const current = await loadArtifact(tx, workspaceId, input);
  invariant(current && isRecord(content) && lineageContentFingerprint(input.kind, current) === lineageContentFingerprint(input.kind, content),
    409, "SOURCE_CHANGED", "Legacy content changed before it could be preserved.");
  const contentJson = Object.fromEntries(snapshotContentFields(input.kind, content).map((field) => [field, content[field] ?? null]));
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
  assertSourceCommitTransactionCompatible(db);
  const membership = await requireWorkspaceMembership({ actor, workspaceId, tx: db });
  const domains = await resolveKnowledgeAccessDomains(actor, workspaceId, db);
  if (!inputs.length) return [];
  const roots = new Map<string, LineageRoot>();
  const memo = new Map<string, boolean>();
  const add = (root: LineageRoot) => {
    const key = `${root.kind}:${root.id}`;
    const earlier = roots.get(key);
    roots.set(key, mergeLineageInputRoot(earlier, root));
  };
  const capturedInputs: LineageRoot[] = [];
  for (const input of inputs) {
    const loaded = await loadArtifact(db, workspaceId, input);
    invariant(isRecord(loaded), 409, "SOURCE_CHANGED", "A prompt input is unavailable.");
    const row: Record<string, unknown> = loaded;
    if (input.snapshot) {
      for (const field of snapshotContentFields(input.kind, row)) {
        if (field in input.snapshot) invariant(snapshotMatches(input.snapshot[field], row[field]),
          409, "SOURCE_CHANGED", "A prompt input changed before generation.");
      }
    }
    const manifest = await latestManifest(db, workspaceId, input);
    const originalSqlEpochs = input.kind === "SqlNativeRunInput" ? parsePermissionEpochProof(row.permissionEpochsJson)
      : input.kind === "KnowledgeChunk" && row.sourceType === "EXTERNAL_DATABASE"
        ? manifest?.epochProofVersion === 1 && parsePermissionEpochProof(manifest.permissionEpochsJson) : null;
    if (input.kind === "SqlNativeRunInput" || input.kind === "KnowledgeChunk" && row.sourceType === "EXTERNAL_DATABASE") {
      invariant(originalSqlEpochs, 409, "UNKNOWN_LINEAGE", "SQL input has no original permission vector.");
    }
    const root: LineageRoot = { kind: input.kind, id: input.id, fingerprint: lineageContentFingerprint(input.kind, row),
      ...(originalSqlEpochs ? {permissionEpochs: originalSqlEpochs} : {})};
    capturedInputs.push(root);
    add(root);
    if (db === prisma) invariant(bindReadHead(memo, input, manifest),
      409, "SOURCE_CHANGED", "A prompt input's lineage changed before generation.");
    if (needsManifest(input.kind, row) || manifest) {
      const upstream = manifest ? parseRoots(manifest.rootsJson) : null;
      invariant(upstream, 409, "UNKNOWN_LINEAGE", "A prompt input has incomplete lineage.");
      upstream.forEach(add);
    }
  }
  // Bind the consuming caller once before provider replay/model admission and
  // merge it with sealed SQL originals. This retains loss/restore fencing while
  // avoiding a full native payload traversal per child solely to recapture epochs.
  if (capturedInputs.some(root => root.kind === "SqlNativeRunInput"
    || root.kind === "KnowledgeChunk" && root.permissionEpochs)) {
    const captureCaller = async (tx: Prisma.TransactionClient) => {
      const ambient = await captureArtifactPermissionEpochs(actor, workspaceId, [], tx);
      const roles = membership?.id && actor.kind === "user" ? await capturePermissionEpochs(tx, workspaceId,
        [{kind: "MemberRolePolicy", id: membership.id}]) : null;
      return mergePermissionEpochProofs(ambient, ...(roles ? [roles] : []))!;
    };
    const caller = db === prisma ? await prisma.$transaction(captureCaller) : await captureCaller(db);
    for (const root of capturedInputs) if (root.permissionEpochs) {
      root.permissionEpochs = mergePermissionEpochProofs(root.permissionEpochs, caller)!;
      add(root);
    }
  }
  const localMemo = new Map<string, boolean>();
  localReadAdmissionMemos.set(memo, localMemo);
  if (db === prisma) readHeadMemos.set(localMemo, readHeadBinding(memo));
  await localCommitAdmission.run(true, async () => {
    for (const root of roots.values()) invariant(await rootIsReadable(db, actor, workspaceId,
      membership, domains, root, new Set(), localMemo),
    409, "UNKNOWN_LINEAGE", "A prompt input's permissions cannot be verified.");
  });
  for (const root of capturedInputs) invariant(await rootIsReadable(db, actor, workspaceId,
    membership, domains, root, new Set(), memo),
  409, "UNKNOWN_LINEAGE", "A prompt input's permissions cannot be verified.");
  const bindEpochs = async (tx: Prisma.TransactionClient) => {
    const proof: LineageRoot[] = [];
    for (const root of roots.values()) {
      if (root.permissionEpochs !== undefined) {
        invariant(await isArtifactPermissionEpochProofCurrent(workspaceId, root.permissionEpochs, tx),
          409, "PERMISSION_CHANGED", "A captured input's permission epoch changed.");
        proof.push(root);
      } else if (root.kind === "ArtifactInputSnapshot") proof.push(root);
      else proof.push({...root, permissionEpochs: await captureArtifactPermissionEpochs(actor, workspaceId, [root], tx)});
    }
    return proof;
  };
  const proof = db === prisma ? await prisma.$transaction(bindEpochs) : await bindEpochs(db);
  const readable = db === prisma ? await (() => {
    const binding = sealedReadHeadBinding(memo);
    return expectedReadHeads.run(binding, () => isArtifactInputProofReadable(actor, workspaceId, proof, db));
  })() : await isArtifactInputProofReadable(actor, workspaceId, proof, db);
  invariant(readable,
    409, "SOURCE_CHANGED", "Input permissions changed before generation.");
  observeArtifactRead(actor, workspaceId, proof);
  return proof;
}

/** Revalidate a captured receipt for the current reader, without returning source metadata. */
export async function isArtifactInputProofReadable(actor: AppActor, workspaceId: string,
  roots: readonly LineageRoot[], db: LineageClient = prisma): Promise<boolean> {
  assertSourceCommitTransactionCompatible(db);
  const membership = await requireWorkspaceMembership({ actor, workspaceId, tx: db });
  const domains = await resolveKnowledgeAccessDomains(actor, workspaceId, db);
  const memo = new Map<string, boolean>();
  if (!localCommitAdmission.getStore()) {
    const localMemo = new Map<string, boolean>();
    localReadAdmissionMemos.set(memo, localMemo);
    if (db === prisma) readHeadMemos.set(localMemo, readHeadBinding(memo));
    const locallyAdmitted = await withSourceCommitPermissionReadPass(db, workspaceId,
      () => withExternalProviderPermissionReadPass(actor, db, workspaceId, "local", () => localCommitAdmission.run(true, async () => {
        for (const root of roots) if (!await rootIsReadable(db, actor, workspaceId,
          membership, domains, root, new Set(), localMemo)) return false;
        return roots.length > 0;
      })));
    if (!locallyAdmitted) return false;
  }
  const readable = await withSourceCommitPermissionReadPass(db, workspaceId, () => withExternalProviderPermissionReadPass(
    actor, db, workspaceId, localCommitAdmission.getStore() ? "local" : "full", async () => {
    for (const root of roots) {
      if (!await rootIsReadable(db, actor, workspaceId, membership, domains, root, new Set(), memo)) return false;
    }
    return roots.length > 0;
  }));
  if (!readable) return false;
  // A provider await may outlive another contributor's permission. Discard the
  // earlier memo and recheck the complete local closure before releasing proof.
  // This second pass never contacts a provider or creates a serving capability.
  if (db === prisma && !localCommitAdmission.getStore()
    && (nativeReplayMemos.has(memo) || readHeadBinding(memo).nativeReplay)) {
    const binding = sealedReadHeadBinding(memo);
    return expectedReadHeads.run(binding, () => localCommitAdmission.run(true,
      () => isArtifactInputProofReadable(actor, workspaceId, roots, db)));
  }
  return roots.length > 0;
}

/** DB-only caller admission before any native provider replay. A successful
 * traversal is deliberately not a serving, model-input, or publication proof. */
export async function assertArtifactInputClosureLocallyAdmissible(actor: AppActor, workspaceId: string,
  roots: readonly LineageRoot[]) {
  invariant(roots.length > 0, 409, "UNKNOWN_LINEAGE", "Commit inputs are unavailable.");
  await localCommitAdmission.run(true, async () => {
    invariant(await isArtifactInputProofReadable(actor, workspaceId, roots), 409, "SOURCE_CHANGED",
      "Commit caller cannot access the complete input closure.");
  });
}

/** Fixed count release boundary: ordinary authorization observes all generic
 * heads before remote work; a fresh shared database snapshot then checks those
 * exact heads/bodies and caller permissions together with the SQL count ledger.
 * This creates no reusable read, native, model or publication capability. */
export async function withArtifactCountReleaseSnapshot<T>(actor: AppActor, workspaceId: string,
  roots: readonly LineageRoot[], remote: () => Promise<void>, finish: (tx: Prisma.TransactionClient) => Promise<T>,
  observedHeads?: ReadonlyMap<string,string>): Promise<T> {
  // Keep only compact original receipts across the aggregate. Bound each proof
  // traversal's hydration/memos, not the workspace's total number of inputs.
  const assertPages = async (db: LineageClient, message: string) => {
    const approvals = roots.some(root => APPROVAL_READ_KINDS.has(root.kind));
    for (let offset = 0; offset < roots.length;) {
      // A child page also loads its flow and proposal. Keep that complete
      // closure within the existing 256-row local observation budget.
      const kind = roots[offset].kind;
      const limit = approvals && ["ApprovalDecision", "Objection"].includes(kind) ? 75 : 100;
      let end = Math.min(offset + limit, roots.length);
      if (approvals) for (let index = offset + 1; index < end; index++) if (roots[index].kind !== kind) { end = index; break; }
      const page = roots.slice(offset, end);
      offset = end;
      const loaded = await prepareLocalDeliveryBatch(db,workspaceId,page);
      const read = () => isArtifactInputProofReadable(actor,workspaceId,page,db);
      invariant(await (loaded ? readLocalDeliveryBatch(db,workspaceId,loaded,page,read)
        : withWorkItemBatchRead(db,workspaceId,page,read)),
        409, "SOURCE_CHANGED", message);
    }
  };
  const binding: ReadHeadBinding = {heads: new Map(observedHeads), sealed: false};
  return expectedReadHeads.run(binding, async () => {
    await assertPages(prisma, "Knowledge count inputs changed before native replay.");
    const sealed: ReadHeadBinding = {heads: new Map(binding.heads), sealed: true};
    await remote();
    return prisma.$transaction(tx => expectedReadHeads.run(sealed, () => localCommitAdmission.run(true, async () => {
      await assertPages(tx, "Knowledge count inputs changed before aggregate release.");
      return finish(tx);
    })), {isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 30_000});
  });
}

/** Internal structural-variant constructor observation. This does not admit the
 * target body, ancestry or metadata to a caller, model or read collector. */
export async function inspectArtifactStructuralVariantTarget(actor: AppActor, workspaceId: string,
  target: LineageInput) {
  invariant(actor.kind === "user" && ["BrainArticle", "ContextGraphObject", "ContextGraphRelationship",
    "ContextGraphEvidenceRef", "ContextGraphProposedDiff"].includes(target.kind),
  409, "SOURCE_RESTRICTED", "Structural authority is limited to fresh owner-private variants.");
  const membership = await requireWorkspaceMembership({ actor, workspaceId });
  invariant(membership?.isActive, 403, "NOT_A_MEMBER", "Active membership is required.");
  const domains = await resolveKnowledgeAccessDomains(actor, workspaceId);
  const row = await loadArtifact(prisma, workspaceId, target);
  invariant(row && !isArchived(row) && !(target.kind === "BrainArticle" && row.variantOfArticleId != null),
    409, "SOURCE_RESTRICTED", "Canonical target structure is unavailable.");
  const fingerprint = lineageContentFingerprint(target.kind, row);
  const permitted = await localCommitAdmission.run(true, () => evaluateRoot(prisma, actor, workspaceId,
    membership, domains, { ...target, fingerprint }, new Set(), new Map(), true));
  invariant(permitted, 409, "SOURCE_RESTRICTED", "Canonical target structure is unavailable.");
  const metadata = await loadArtifactPermissionMetadata(prisma, workspaceId, target);
  const head = await latestManifest(prisma, workspaceId, target);
  const stamp = (value: unknown) => createHash("sha256").update(sourceCommitCanonical(value)).digest("hex");
  return { fingerprint, envelopeStamp: stamp(metadata), headStamp: stamp(head), ownerMemberId: membership.id };
}

/** After a trusted writer preserves an input revision, retain the exact bytes through its immutable receipt. */
export async function rebaseArtifactInputProofToSnapshots(actor: AppActor, workspaceId: string, roots: readonly LineageRoot[], db: LineageClient = prisma) {
  const rebased: LineageRoot[] = [];
  for (const root of roots) {
    if (await isArtifactInputProofReadable(actor, workspaceId, [root], db)) { rebased.push(root); continue; }
    let replacement: LineageRoot | undefined;
    let cursor: string | undefined;
    let scanned = 0;
    const scanLimit = 5_000;
    while (!replacement) {
      const pageSize = Math.min(100, scanLimit - scanned + 1);
      const snapshots = await db.artifactInputSnapshot.findMany({ where: { workspaceId,
        sourceKind: root.kind, sourceId: root.id, sourceFingerprint: root.fingerprint,
        origin: { in: ["HUMAN_ORIGINAL", "DERIVED", "NATIVE_ORIGINAL"] }, ...(cursor ? { id: { gt: cursor } } : {}) },
      orderBy: { id: "asc" }, take: pageSize });
      if (!snapshots.length) break;
      for (const row of snapshots) {
        invariant(++scanned <= scanLimit, 409, "SOURCE_PROOF_SCAN_LIMIT", "Preserved input history requires a bounded rebuild.");
        const candidate: LineageRoot = { kind: "ArtifactInputSnapshot", id: row.id, fingerprint: lineageContentFingerprint("ArtifactInputSnapshot", row) };
        if (await isArtifactInputProofReadable(actor, workspaceId, [candidate], db)) { replacement = candidate; break; }
      }
      cursor = snapshots.at(-1)!.id;
      if (snapshots.length < pageSize) break;
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
  return artifactInputProofAudience(actor, workspaceId, roots, db);
}
/** An exact active export worker may publish the selected output within its company. */
export async function isBrainExportProofWorkspaceShareable(actor: AppActor, workspaceId: string,
  roots: readonly LineageRoot[], db: LineageClient = prisma) {
  const purpose = getBrainExportWorkerPurpose(actor, workspaceId);
  return Boolean(purpose && await isBrainExportWorkerCurrent(actor, workspaceId, purpose.receiptId, db)
    && await artifactInputProofAudience(actor, workspaceId, roots, db, purpose.receiptId));
}
/** Company recovery can regenerate company projections, never public internet output.
 * Every original contributor remains in the audience traversal. */
export async function isLegacyRecoveryProofWorkspaceShareable(actor: AppActor, workspaceId: string,
  roots: readonly LineageRoot[], db: LineageClient = prisma) {
  return artifactInputProofAudience(actor, workspaceId, roots, db, undefined, true);
}
async function artifactInputProofAudience(actor: AppActor, workspaceId: string,
  roots: readonly LineageRoot[], db: LineageClient, consentReceiptId?: string, recoveryCompany = false) {
  if (!await isArtifactInputProofReadable(actor, workspaceId, roots, db)) return false;
  const seen = new Set<string>();
  const publicAuthorities = new Set<string>();
  const privateEnvelope = (kind: LineageKind, row: Record<string, unknown>) => row.isPrivate === true || row.isRestricted === true
    || row.accessDomain === "FINANCE" || ["ExternalDataSource", "SqlNativeRunInput", "MeetingAudioAsset", "NativeTranscriptInput", "CommunicationMessageNativeInput", "GenericDerivedArtifactVariant", "ExternalProviderFetchInput", "ExternalMcpResponseInput", "ExternalMcpConnectionSet", "ExternalContentSource", "FinanceReport", "FinanceReportFact", "FinanceReportFactRevision", "FinanceImportApplication", "FinanceImportBatch", "FinanceImportCandidate", "FinanceReportUploadInput", "ExecutionRequest", "ExecutionResult", "ConversationOperationOutcome", "WorkspaceToolLinkCredential", "McpToolInput", "ConversationIngressInput", "AgentRequestInput", "AgentFeedbackInput", "ConversationPendingOperation", "ConversationPromptInput", "ConversationSession", "ConversationTurn", "RoleOnboardingSession", "CheckIn", "Notification", "NewspaperDelivery"].includes(kind)
    || (kind === "Recognition" && row.visibility !== "WORKSPACE")
    || (kind === "AdviceRequest" && row.audienceType !== "WORKSPACE")
    || (kind === "ContextMapView" && row.createdByUserId != null)
    || (kind === "BuildArtifact" && (row.visibility !== "PUBLIC_REVIEW" || row.classification !== "OPEN_CORE" || row.publicRevokedAt != null));
  const authorityIsPublic = async (input: LineageInput): Promise<boolean> => {
    const key = JSON.stringify([input.kind, input.id]);
    if (publicAuthorities.has(key)) return true;
    if (publicAuthorities.size >= 10000) return false;
    publicAuthorities.add(key);
    const row = await loadArtifactPermissionMetadata(db, workspaceId, input);
    if (!row || isArchived(row) || (input.kind === "Member" && row.isActive !== true) || privateEnvelope(input.kind, row)) return false;
    if ((CATEGORY_BOUND_SOURCE_KINDS as readonly string[]).includes(input.kind)) {
      const category = typeof row.informationCategory === "string" ? await db.informationCategoryPolicy.findUnique({
        where: {workspaceId_category: {workspaceId, category: row.informationCategory}}}) : null;
      if (category?.isRestricted) return false;
    }
    for (const parent of artifactPermissionParents(input.kind, row)) if (!await authorityIsPublic(parent)) return false;
    return true;
  };
  const visit = async (root: LineageRoot): Promise<boolean> => {
    const key = `${root.kind}:${root.id}:${root.fingerprint}`;
    if (seen.has(key)) return true;
    seen.add(key);
    const loaded = await loadArtifact(db, workspaceId, root);
    if (!isRecord(loaded)) return false;
    if (recoveryCompany && (root.kind === "ConversationOperationOutcome" && loaded.operation === "LEGACY_RECOVERY_PUBLICATION"
      || root.kind === "ArtifactInputSnapshot" && loaded.sourceKind === "ConversationOperationOutcome")) {
      const original = root.kind === "ConversationOperationOutcome" ? loaded
        : await loadArtifact(db,workspaceId,{kind:"ConversationOperationOutcome",id:String(loaded.sourceId)});
      if (original?.operation === "LEGACY_RECOVERY_PUBLICATION") {
        const {currentLegacyRecoveryPublication} = await import("./legacy-recovery");
        const recovery = await currentLegacyRecoveryPublication(actor,workspaceId,original,db);
        if (!recovery || !["Action","Document","BrainSource"].includes(recovery.targetKind)
          || privateEnvelope(recovery.targetKind,recovery.content)
          || !await authorityIsPublic({kind:recovery.targetKind,id:recovery.targetId})) return false;
        for (const contributor of recovery.roots) if (!await visit(contributor)) return false;
        return true;
      }
    }
    // The complete read above validates every inner input under the exact private
    // consent purpose. Only this authenticated boundary may stop audience descent.
    if (consentReceiptId && (root.kind === "ConversationOperationOutcome" && root.id === consentReceiptId
      && loaded.operation === "BRAIN_EXPORT_CONSENT" || root.kind === "ArtifactInputSnapshot"
      && loaded.sourceKind === "ConversationOperationOutcome" && loaded.sourceId === consentReceiptId)) return true;
    if (privateEnvelope(root.kind, loaded)) return false;
    if ((CATEGORY_BOUND_SOURCE_KINDS as readonly string[]).includes(root.kind) && typeof loaded.informationCategory === "string"
      && (await db.informationCategoryPolicy.findUnique({where: {workspaceId_category: {workspaceId, category: loaded.informationCategory}}}))?.isRestricted) return false;
    for (const parent of artifactPermissionParents(root.kind, loaded)) if (!await authorityIsPublic(parent)) return false;
    let upstream: LineageRoot[] | null = [];
    if (root.kind === "ArtifactInputSnapshot") {
      if (!isRecord(loaded.accessEnvelopeJson) || privateEnvelope(loaded.sourceKind as LineageKind, loaded.accessEnvelopeJson)) return false;
      const original = await loadArtifact(db, workspaceId, { kind: loaded.sourceKind as LineageKind, id: String(loaded.sourceId) });
      if (!isRecord(original) || privateEnvelope(loaded.sourceKind as LineageKind, original)) return false;
      if ((CATEGORY_BOUND_SOURCE_KINDS as readonly string[]).includes(String(loaded.sourceKind)) && typeof original.informationCategory === "string"
        && (await db.informationCategoryPolicy.findUnique({where: {workspaceId_category: {workspaceId, category: original.informationCategory}}}))?.isRestricted) return false;
      for (const parent of artifactPermissionParents(loaded.sourceKind as LineageKind, original)) if (!await authorityIsPublic(parent)) return false;
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
  assertSourceCommitTransactionCompatible(db);
  const deliveryBatch = localDeliveryBatch(db,workspaceId,input);
  if (deliveryBatch) return structuredClone(deliveryBatch.heads.get(deliveryInputKey(input)) ?? null);
  const batch = workItemBatch(db, workspaceId, input);
  if (batch) return structuredClone(batch.heads.get(input.id) ?? null);
  return db.artifactInputLineage.findFirst({ where: {
    workspaceId, artifactType: input.kind, artifactId: input.id,
  }, orderBy: { revision: "desc" } });
}

/** Internal dependency discovery grants no read access and returns no source content. */
export async function inspectStoredArtifactInputDependencies(db: LineageClient, workspaceId: string,
  inputs: readonly LineageRoot[], options?: { maxNodes: number; snapshotReads?: BoundedSnapshotReads }) {
  assertSourceCommitTransactionCompatible(db);
  const dependencies = new Map<string, LineageRoot>();
  const memo = new Map<string, boolean>();
  const publicNoteDependency = (value: unknown): LineageRoot | null | undefined => {
    if (!isRecord(value) || value.operation !== "ACTION_COMPLETION_PUBLIC_NOTE") return undefined;
    const control = value.controlJson;
    if (!isRecord(control) || control.version !== 1 || control.publicationPolicyVersion !== 1
      || control.audience !== "ACTION_READERS" || typeof control.oldActionSnapshotId !== "string"
      || !control.oldActionSnapshotId || typeof control.oldActionSnapshotFingerprint !== "string"
      || !/^[a-f0-9]{64}$/.test(control.oldActionSnapshotFingerprint)) return null;
    return { kind: "ArtifactInputSnapshot", id: control.oldActionSnapshotId,
      fingerprint: control.oldActionSnapshotFingerprint };
  };
  const visit = async (root: LineageRoot, visiting = new Set<string>()): Promise<boolean> => {
    const key = `${root.kind}:${root.id}:${root.fingerprint}`;
    if (visiting.has(key)) return false;
    if (memo.has(key)) return memo.get(key)!;
    if (!dependencies.has(key) && options && dependencies.size >= options.maxNodes) return false;
    dependencies.set(key, root);
    const row = await loadArtifact(db, workspaceId, root);
    if (!row) return false;
    let upstream: LineageRoot[] | null = [];
    if (root.kind === "ArtifactInputSnapshot") {
      if (lineageContentFingerprint(root.kind, row) !== root.fingerprint || typeof row.sourceKind !== "string"
        || !(row.sourceKind in CONTENT_FIELDS) || row.sourceKind === "ArtifactInputSnapshot") return false;
      if (row.epochProofVersion !== 1 || !parsePermissionEpochProof(row.permissionEpochsJson)) return false;
      options?.snapshotReads?.retain(row as unknown as import("@prisma/client").ArtifactInputSnapshot);
      const source = { kind: row.sourceKind as LineageKind, id: String(row.sourceId), fingerprint: String(row.sourceFingerprint) };
      dependencies.set(`${source.kind}:${source.id}:${source.fingerprint}`, source);
      upstream = parseRoots(row.rootsJson as Prisma.JsonValue);
      if (!upstream || !knownSnapshotOrigin(row)
        || (row.origin === "DERIVED" && !upstream.length)) return false;
      if (row.sourceKind === "ConversationOperationOutcome" && isRecord(row.contentJson) && row.contentJson.operation === "BRAIN_EXPORT_CONSENT") {
        const { decodeBrainExportConsent } = await import("./conversation-brain-consent");
        const original = await loadArtifact(db, workspaceId, {kind: "ConversationOperationOutcome", id: String(row.sourceId)});
        const consent = original && decodeBrainExportConsent(original);
        if (!consent) return false;
        upstream.push(...consent.roots);
      }
      if (row.sourceKind === "ConversationOperationOutcome" && isRecord(row.contentJson) && row.contentJson.operation === "LEGACY_RECOVERY_PUBLICATION") {
        const { decodeLegacyRecovery } = await import("./legacy-recovery");
        const original = await loadArtifact(db, workspaceId, {kind: "ConversationOperationOutcome", id: String(row.sourceId)});
        const recovery = original && decodeLegacyRecovery(original);
        if (!recovery) return false;
        upstream.push(...recovery.roots);
      }
      if (row.sourceKind === "ConversationOperationOutcome") {
        const dependency = publicNoteDependency(row.contentJson);
        if (dependency === null) return false;
        if (dependency) upstream.push(dependency);
      }
    } else {
      // Follow the revision that was actually consumed, including preserved
      // historical manifests. A newer revision cannot redefine old ancestry.
      const batch = localDeliveryBatch(db,workspaceId,root);
      const head = batch?.heads.get(deliveryInputKey(root));
      // The exact latest matching revision is also the latest historical match.
      // Absence is reusable only for non-manifest local rows in this batch.
      const manifest = head?.contentHash === root.fingerprint ? structuredClone(head)
        : batch && !head && !needsManifest(root.kind,row) ? null
          : await db.artifactInputLineage.findFirst({ where: { workspaceId,
            artifactType: root.kind, artifactId: root.id, contentHash: root.fingerprint }, orderBy: { revision: "desc" } });
      if (manifest) {
        upstream = parseRoots(manifest.rootsJson);
        if (!upstream || (manifest.origin === "HUMAN_ORIGINAL"
          && (upstream.length !== 0 || !Array.isArray(manifest.inputsJson) || manifest.inputsJson.length !== 0))
          || (!["HUMAN_ORIGINAL", "DERIVED"].includes(manifest.origin)
          && !(manifest.origin === "NATIVE_ORIGINAL" && root.kind === "ConversationOperationOutcome" && isNativeControlOutcome(row)
            && upstream.length === 0 && manifest.epochProofVersion === 1 && parsePermissionEpochProof(manifest.permissionEpochsJson)))
          || (manifest.origin === "DERIVED" && (!upstream.length || manifest.epochProofVersion !== 1
            || !parsePermissionEpochProof(manifest.permissionEpochsJson)))) return false;
      } else if (needsManifest(root.kind, row)) return false;
      if (root.kind === "ConversationOperationOutcome" && row.operation === "LEGACY_RECOVERY_PUBLICATION") {
        const { decodeLegacyRecovery } = await import("./legacy-recovery");
        const recovery = decodeLegacyRecovery(row);
        if (!recovery) return false;
        upstream = [...(upstream ?? []), ...recovery.roots];
      }
      if (root.kind === "ConversationOperationOutcome" && row.operation === "BRAIN_EXPORT_CONSENT") {
        const { decodeBrainExportConsent } = await import("./conversation-brain-consent");
        const consent = decodeBrainExportConsent(row);
        if (!consent) return false;
        upstream = [...(upstream ?? []), ...consent.roots];
      }
      if (root.kind === "ConversationOperationOutcome") {
        const dependency = publicNoteDependency(row);
        if (dependency === null) return false;
        if (dependency) upstream = [...(upstream ?? []), dependency];
      }
      if (root.kind === "KnowledgeChunk") {
        const kinds: Record<string, LineageKind> = { BRAIN_ARTICLE: "BrainArticle", DOCUMENT: "Document", MEETING: "Meeting", PROPOSAL: "Proposal", EXTERNAL_CONTENT: "ExternalContentSource", EXTERNAL_DATABASE: "SqlNativeRunInput" };
        if (!kinds[String(row.sourceType)] || !isRecord(row.metadata) || typeof row.metadata.sourceContentHash !== "string") return false;
        const parentId = row.sourceType === "EXTERNAL_DATABASE" ? row.metadata.nativeInputId : row.sourceId;
        if (typeof parentId !== "string" || !parentId) return false;
        upstream = [...(upstream ?? []), { kind: kinds[String(row.sourceType)], id: parentId, fingerprint: row.metadata.sourceContentHash }];
      }
      if (root.kind === "WorkspaceToolLinkCredential") {
        if (lineageContentFingerprint(root.kind, row) !== root.fingerprint) return false;
        const parent = await loadArtifact(db, workspaceId, { kind: "WorkspaceToolLink", id: root.id });
        if (!parent) return false;
        upstream = [...(upstream ?? []), { kind: "WorkspaceToolLink", id: root.id,
          fingerprint: lineageContentFingerprint("WorkspaceToolLink", parent) }];
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

/** Capture permission-transition history independently of mutable content hashes. */
export async function captureArtifactPermissionEpochs(actor: AppActor, workspaceId: string,
  fullAncestorRoots: readonly LineageRoot[], tx: Prisma.TransactionClient): Promise<PermissionEpochProof> {
  const identities = [{kind: "Workspace", id: workspaceId}];
  await assertCompanyLegacyRecoveryCaptureCurrent(actor,workspaceId,tx);
  const companyPublication = hasCompanyTranscriptPublicationScope(actor, workspaceId) || hasCompanyLegacyRecoveryCapture(actor,workspaceId,tx);
  if (actor.kind === "user" && !companyPublication) {
    identities.push({ kind: "MemberUserPolicy", id: actor.user.id }, { kind: "WorkspaceSupportPolicy", id: actor.user.id });
  } else if (actor.kind === "agent") {
    if (actor.credentialId) identities.push({ kind: "AgentCredential", id: actor.credentialId });
    if (actor.agentIdentityId) identities.push({ kind: "AgentIdentity", id: actor.agentIdentityId });
    if (actor.supportOrigin) identities.push({ kind: "WorkspaceSupportPolicy", id: actor.supportOrigin.userId });
  }
  const pending: LineageInput[] = fullAncestorRoots.map(({ kind, id }) => ({ kind, id }));
  const visited = new Set<string>();
  for (let index = 0; index < pending.length; index++) {
    const root = pending[index];
    const key = JSON.stringify([root.kind, root.id]);
    if (visited.has(key)) continue;
    invariant(visited.size < 10000, 409, "PERMISSION_PROOF_LIMIT", "Permission parent discovery requires a bounded rebuild.");
    visited.add(key);
    const loaded = root.kind === "ArtifactInputSnapshot" ? await loadArtifact(tx, workspaceId, root)
      : await loadArtifactPermissionMetadata(tx, workspaceId, root);
    invariant(isRecord(loaded), 409, "SOURCE_CHANGED", "A permission-bearing input is unavailable.");
    identities.push(...artifactPermissionEpochIdentities(root.kind, { ...loaded, id: root.id, workspaceId })
      .filter(identity => root.kind !== "ArtifactInputSnapshot" || identity.kind !== root.kind || identity.id !== root.id));
    const categoryGovernors = await categoryGovernorIdentities(root.kind, loaded, workspaceId, tx);
    identities.push(...categoryGovernors);
    if (categoryGovernors.length && actor.kind === "user" && !companyPublication) {
      const member = await tx.member.findFirst({where: {workspaceId, userId: actor.user.id, isActive: true}, select: {id: true}});
      if (member) identities.push({kind: "MemberRolePolicy", id: member.id});
    }
    pending.push(...artifactPermissionParents(root.kind, { ...loaded, id: root.id }));
    if (root.kind === "ConversationOperationOutcome" && loaded.operation === "LEGACY_RECOVERY_PUBLICATION") {
      const { decodeLegacyRecovery } = await import("./legacy-recovery");
      const original = await loadArtifact(tx, workspaceId, root);
      const recovery = original && decodeLegacyRecovery(original);
      invariant(recovery && await isArtifactPermissionEpochProofCurrent(workspaceId, recovery.epochs, tx), 409, "PERMISSION_CHANGED", "Recovery authority changed.");
      identities.push(...recovery.epochs.entries.map(({kind, id}) => ({kind, id})));
    }
    if (root.kind === "ConversationOperationOutcome" && loaded.operation === "BRAIN_EXPORT_CONSENT") {
      const { decodeBrainExportConsent } = await import("./conversation-brain-consent");
      const native = await loadArtifact(tx, workspaceId, root);
      const consent = native && decodeBrainExportConsent(native);
      invariant(consent && await isArtifactPermissionEpochProofCurrent(workspaceId, consent.epochs, tx),
        409, "PERMISSION_CHANGED", "The confirmed export's original authority changed.");
      identities.push(...consent.epochs.entries.map(({kind, id}) => ({kind, id})));
    }
    if (root.kind === "FinanceImportBatch") {
      const upload = await tx.financeReportUploadInput.findFirst({ where: { workspaceId, batchId: root.id }, select: { id: true } });
      invariant(upload, 409, "SOURCE_CHANGED", "A native upload permission parent is unavailable.");
      pending.push({ kind: "FinanceReportUploadInput", id: upload.id });
    }
    if (root.kind === "ArtifactInputSnapshot") {
      invariant(loaded.epochProofVersion === 1
        && await isArtifactPermissionEpochProofCurrent(workspaceId, loaded.permissionEpochsJson, tx),
      409, "PERMISSION_CHANGED", "Preserved input permissions changed.");
      invariant(typeof loaded.sourceKind === "string" && loaded.sourceKind in CONTENT_FIELDS && loaded.sourceKind !== "ArtifactInputSnapshot"
        && typeof loaded.sourceId === "string", 409, "SOURCE_CHANGED", "A preserved input authority is unavailable.");
      pending.push({ kind: loaded.sourceKind as LineageKind, id: loaded.sourceId });
      const prior = loaded.permissionEpochsJson as unknown as PermissionEpochProof;
      identities.push(...prior.entries.map(({kind, id}) => ({kind, id})));
    }
  }
  return capturePermissionEpochs(tx, workspaceId, identities);
}

/** A manifest is a proof of complete input capture, not a model's citation list. */
export async function recordArtifactInputLineage(params: {
  tx: Prisma.TransactionClient;
  actor: AppActor;
  workspaceId: string;
  artifact: LineageInput;
  content: unknown;
  manifestId?: string;
  origin: "HUMAN_ORIGINAL" | "DERIVED";
  inputs: LineageInput[];
  inheritedRoots?: LineageRoot[];
  /** Mutable graph inputs retain immutable content receipts with live permission checks. */
  transitiveOnlyKinds?: LineageKind[];
}) {
  await assertArtifactInputWriteFence(params.tx);
  await assertPlannedArtifactPublication(params.tx, params.workspaceId, params.artifact);
  const submissionRoots = getMcpToolInputRoots(params.actor, params.workspaceId);
  if (submissionRoots.length) params = { ...params, origin: "DERIVED", inheritedRoots: [...(params.inheritedRoots ?? []), ...submissionRoots] };
  const { tx, actor, workspaceId, artifact, content } = params;
  const membership = await requireWorkspaceMembership({ actor, workspaceId, tx });
  invariant(params.origin !== "HUMAN_ORIGINAL" || (actor.kind === "user" && params.inputs.length === 0 && !params.inheritedRoots?.length),
    409, "UNKNOWN_LINEAGE", "Only a direct human original can have an empty input manifest.");
  invariant(params.origin !== "HUMAN_ORIGINAL" || !["MeetingAudioAsset", "GenericDerivedArtifactVariant", "KnowledgeChunk", "CommunicationMessage", "FinanceReport", "FinanceReportFact", "FinanceReportFactRevision", "FinanceImportApplication", "FinanceImportBatch", "FinanceImportCandidate", "ExecutionResult", "ConversationOperationOutcome", "ConversationPendingOperation", "WorkflowJobInput", "AgentMemory", "ConversationTurn", "CommunicationContextSummary", "WorkspaceBriefing",
    "NewspaperEdition", "NewspaperDelivery", "NewspaperTrackedLink", "Notification", "AgentRun", "AgentStep", "AgentToolCall"].includes(artifact.kind),
  409, "UNKNOWN_LINEAGE", "Generated or copied content requires its complete input receipt.");
  const domains = await resolveKnowledgeAccessDomains(actor, workspaceId, tx);
  const roots = new Map<string, LineageRoot>();
  const transitiveOnly = new Set(params.transitiveOnlyKinds ?? []);
  const rootMemo = new Map<string, boolean>();
  const snapshotMemo = new Map<string, Promise<Awaited<ReturnType<typeof snapshotInput>>>>();
  const addRoot = (root: LineageRoot) => {
    const key = `${root.kind}:${root.id}`;
    const existing = roots.get(key);
    roots.set(key, mergeLineageInputRoot(existing, root));
  };
  const snapshotForRoot = (root: LineageRoot): Promise<Awaited<ReturnType<typeof snapshotInput>>> => {
    const key = `${root.kind}:${root.id}:${root.fingerprint}`;
    let snapshot = snapshotMemo.get(key);
    if (!snapshot) {
      snapshot = snapshotInput(actor, tx, workspaceId, root, async (inputs) => {
        const converted = new Map<string, LineageRoot>();
        for (const input of inputs) {
          const receipt = transitiveOnly.has(input.kind) ? await snapshotForRoot(input) : { root: input, roots: [] };
          for (const item of [receipt.root, ...receipt.roots]) {
            const key = `${item.kind}:${item.id}`;
            converted.set(key, mergeLineageInputRoot(converted.get(key), item));
          }
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
    if (!transitiveOnly.has(root.kind) && root.kind !== "WorkspaceToolLinkCredential") {
      addRoot(root);
      if (root.kind === "ArtifactInputSnapshot") {
        const snapshot = await tx.artifactInputSnapshot.findFirst({ where: { id: root.id, workspaceId } });
        const upstream = snapshot ? parseRoots(snapshot.rootsJson) : null;
        invariant(upstream, 409, "UNKNOWN_LINEAGE", "An immutable input has incomplete lineage.");
        if (!credentialPurposeSnapshot(snapshot!)) upstream.forEach(addRoot);
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
  const permissionEpochs = await captureArtifactPermissionEpochs(actor, workspaceId,
    [{...artifact, fingerprint: lineageContentFingerprint(artifact.kind, content)}, ...roots.values()], tx);
  const recorded = await tx.artifactInputLineage.create({ data: {
    ...(params.manifestId ? { id: params.manifestId } : {}),
    epochProofVersion: 1, permissionEpochsJson: permissionEpochs as unknown as Prisma.InputJsonValue,
    workspaceId, artifactType: artifact.kind, artifactId: artifact.id,
    revision: (previous?.revision ?? 0) + 1, origin: params.origin,
    contentHash: lineageContentFingerprint(artifact.kind, content),
    inputsJson: params.inputs as Prisma.InputJsonArray,
    rootsJson: [...roots.values()] as Prisma.InputJsonArray,
  } });
  if (hasActiveSourceCommitLockPlan(tx)) registerSourceCommitPublishedOutput(tx, workspaceId,
    { ...artifact, fingerprint: recorded.contentHash });
  return recorded;
}

type HistoryVersionBirth = { tx: Prisma.TransactionClient; workspaceId: string; articleId: string;
  sourceFingerprint: string; versionId: string; versionFingerprint: string };
const historyVersionBirths = new WeakMap<object, HistoryVersionBirth>();

/** Trusted ORM-create boundary. This constructor never promotes an existing
 * Version or accepts a caller's birth flag. Known copies retain all old evidence;
 * an unproved/stale copy is preserved as UNKNOWN without serving authority. */
export async function createBrainArticleHistoryVersion(params: {
  tx: Prisma.TransactionClient; workspaceId: string; article: Record<string, unknown>;
  version: number; preserveKnownHistory: boolean;
  reason: "BODY_EDIT" | "REVIEWED_SOURCE_REGENERATION";
  /** Active source plans require the preallocated, declared output identity. */
  id?: string;
}) {
  // Keep the actual transaction capability while sealing caller-owned content
  // and creation options before the first asynchronous fence or row read.
  params = {...structuredClone({workspaceId: params.workspaceId, article: params.article,
    version: params.version, preserveKnownHistory: params.preserveKnownHistory,
    reason: params.reason, id: params.id}), tx: params.tx};
  const {tx, workspaceId, article} = params;
  assertSourceCommitTransactionCompatible(tx);
  invariant(typeof article.id === "string" && article.workspaceId === workspaceId
    && typeof article.bodyMd === "string" && typeof article.isPrivate === "boolean"
    && ["BODY_EDIT", "REVIEWED_SOURCE_REGENERATION"].includes(params.reason)
    && Number.isSafeInteger(params.version) && params.version > 0,
  409, "SOURCE_CHANGED", "History source or version is unavailable.");
  if (hasActiveSourceCommitLockPlan(tx)) {
    invariant(typeof params.id === "string" && params.id.length > 0, 409, "SOURCE_LOCK_UNCOVERED",
      "History output must be preallocated before the source commit.");
    await assertPlannedArtifactPublication(tx, workspaceId, {kind: "BrainArticleVersion", id: params.id});
  }
  await assertArtifactInputWriteFence(tx);
  const current = await loadArtifact(tx, workspaceId, {kind: "BrainArticle", id: article.id});
  invariant(current && lineageContentFingerprint("BrainArticle", current) === lineageContentFingerprint("BrainArticle", article),
    409, "SOURCE_CHANGED", "History source changed before preservation.");
  const version = await tx.brainArticleVersion.create({data: {
    ...(params.id ? {id: params.id} : {}), articleId: article.id, version: params.version,
    bodyMd: String(article.bodyMd),
    accessEnvelopeJson: {isPrivate: article.isPrivate as boolean, ownerMemberId: article.ownerMemberId as string | null},
    changeSummary: params.reason === "BODY_EDIT" ? null : "Previous body before reviewed source regeneration.",
    agentRunId: null,
  }});
  const birth = Object.freeze({});
  historyVersionBirths.set(birth, {tx, workspaceId, articleId: article.id,
    sourceFingerprint: lineageContentFingerprint("BrainArticle", article), versionId: version.id,
    versionFingerprint: lineageContentFingerprint("BrainArticleVersion", version)});
  try {
    const preserved = params.preserveKnownHistory && await copyArtifactInputLineage({tx, workspaceId,
      from: {kind: "BrainArticle", id: article.id}, fromContent: article,
      to: {kind: "BrainArticleVersion", id: version.id}, toContent: version, birth});
    if (!preserved) await invalidateArtifactInputLineage({tx, workspaceId,
      artifact: {kind: "BrainArticleVersion", id: version.id}, content: version});
    return {version, preserved};
  } finally {historyVersionBirths.delete(birth);}
}

/** Preserve exact old vectors and add only a genuinely newborn Version's own
 * identity. The opaque birth receipt is private to the trusted constructor. */
export async function copyArtifactInputLineage(params: {
  tx: Prisma.TransactionClient;
  workspaceId: string;
  from: LineageInput;
  fromContent: unknown;
  to: LineageInput;
  toContent: unknown;
  birth?: object;
}) {
  await assertArtifactInputWriteFence(params.tx);
  await assertPlannedArtifactPublication(params.tx, params.workspaceId, params.to);
  const born = params.birth ? historyVersionBirths.get(params.birth) : undefined;
  if (!born || born.tx !== params.tx || born.workspaceId !== params.workspaceId
    || params.from.kind !== "BrainArticle" || params.to.kind !== "BrainArticleVersion"
    || born.articleId !== params.from.id || born.versionId !== params.to.id
    || born.sourceFingerprint !== lineageContentFingerprint(params.from.kind, params.fromContent)
    || born.versionFingerprint !== lineageContentFingerprint(params.to.kind, params.toContent)) return false;
  historyVersionBirths.delete(params.birth!);
  if (hasActiveSourceCommitLockPlan(params.tx)) assertSourceCommitSemanticRootCovered(params.tx, params.workspaceId,
    { ...params.from, fingerprint: lineageContentFingerprint(params.from.kind, params.fromContent) });
  const prior = await latestManifest(params.tx, params.workspaceId, params.from);
  if (!prior || prior.contentHash !== lineageContentFingerprint(params.from.kind, params.fromContent)
    || !parseRoots(prior.rootsJson)) return false;
  const saved = prior.epochProofVersion === 1 ? parsePermissionEpochProof(prior.permissionEpochsJson) : null;
  if (!saved || !["HUMAN_ORIGINAL", "DERIVED"].includes(prior.origin)) return false;
  if (prior.origin === "HUMAN_ORIGINAL") {
    if (parseRoots(prior.rootsJson)!.length || !Array.isArray(prior.inputsJson) || prior.inputsJson.length
      || !saved.entries.some(entry => entry.kind === "BrainArticle" && entry.id === params.from.id)
      || !saved.entries.some(entry => entry.kind === "Workspace" && entry.id === params.workspaceId)) return false;
  } else {
    if (!parseRoots(prior.rootsJson)!.length || !await isArtifactPermissionEpochProofCurrent(params.workspaceId, saved, params.tx)) return false;
    const {isArtifactInputPermissionEpochCoverageComplete} = await import("./source-permission-coverage");
    if (!await isArtifactInputPermissionEpochCoverageComplete({workspaceId: params.workspaceId,
      artifact: params.from, content: params.fromContent as Record<string, unknown>, roots: parseRoots(prior.rootsJson)!,
      permissionEpochs: saved, db: params.tx})) return false;
  }
  const actual = await loadArtifact(params.tx, params.workspaceId, params.to);
  if (!actual || lineageContentFingerprint(params.to.kind, actual) !== born.versionFingerprint
    || await latestManifest(params.tx, params.workspaceId, params.to)) return false;
  const own = await capturePermissionEpochs(params.tx, params.workspaceId, [{kind: params.to.kind, id: params.to.id}]);
  const copiedEpochs = mergePermissionEpochProofs(saved, own)!;
  await params.tx.artifactInputLineage.create({ data: {
    workspaceId: params.workspaceId,
    artifactType: params.to.kind,
    artifactId: params.to.id,
    revision: 1,
    origin: prior.origin, epochProofVersion: prior.epochProofVersion,
    permissionEpochsJson: copiedEpochs as unknown as Prisma.InputJsonValue,
    contentHash: lineageContentFingerprint(params.to.kind, params.toContent),
    inputsJson: prior.inputsJson as Prisma.InputJsonValue,
    rootsJson: prior.rootsJson as Prisma.InputJsonValue,
  } });
  if (hasActiveSourceCommitLockPlan(params.tx)) registerSourceCommitPublishedOutput(params.tx, params.workspaceId,
    { ...params.to, fingerprint: lineageContentFingerprint(params.to.kind, params.toContent) });
  return true;
}

type HumanAdvanceAdmission = {
  tx: Prisma.TransactionClient; actor: AppActor; workspaceId: string; artifact: LineageInput;
  fingerprint: string; manifestStamp: string; epochs: PermissionEpochProof;
};
const humanAdvanceAdmissions = new WeakMap<object, HumanAdvanceAdmission>();
const manifestAdvanceStamp = (manifest: NonNullable<Awaited<ReturnType<typeof latestManifest>>>) =>
  createHash("sha256").update(sourceCommitCanonical(manifest)).digest("hex");
const artifactOwnEpochKind = (kind: LineageKind) => ["MeetingTranscript", "MeetingAgenda"].includes(kind) ? "Meeting" : kind;

/** Admit the original derived body BEFORE its governed edit. The opaque, single-use
 * receipt never refreshes upstream permissions or accepts an already stale body. */
export async function captureHumanArtifactInputAdvance(params: {
  tx: Prisma.TransactionClient; actor: AppActor; workspaceId: string; artifact: LineageInput;
  before: unknown; allowSystemTransition?: boolean;
}): Promise<object | undefined> {
  const { tx, actor, workspaceId, artifact, before } = params;
  await assertArtifactInputWriteFence(tx);
  await assertPlannedArtifactPublication(tx, workspaceId, artifact);
  if (actor.kind !== "user" && !params.allowSystemTransition) return undefined;
  const initial = await latestManifest(tx, workspaceId, artifact);
  const saved = initial?.epochProofVersion === 1 ? parsePermissionEpochProof(initial.permissionEpochsJson) : null;
  if (initial?.origin !== "DERIVED" || !saved || !parseRoots(initial.rootsJson)?.length) return undefined;
  const physical = sourceAuthorityPhysicalRow(artifact);
  if (!physical) return undefined;
  if (hasActiveSourceCommitLockPlan(tx)) assertSourceCommitRowCovered(tx, physical.table, physical.id, "UPDATE");
  else await tx.$queryRaw(Prisma.sql`SELECT id FROM ${Prisma.raw(`"${physical.table}"`)} WHERE id = ${physical.id} FOR UPDATE`);
  const actual = await loadArtifact(tx, workspaceId, artifact);
  const fingerprint = lineageContentFingerprint(artifact.kind, before);
  invariant(actual && actual.id === artifact.id && lineageContentFingerprint(artifact.kind, actual) === fingerprint,
    409, "SOURCE_CHANGED", "Artifact changed before the governed edit.");
  const previous = await latestManifest(tx, workspaceId, artifact);
  invariant(previous && manifestAdvanceStamp(previous) === manifestAdvanceStamp(initial)
    && previous.contentHash === fingerprint, 409, "SOURCE_CHANGED", "Artifact lineage changed before the governed edit.");
  if (!(await readableArtifactIds(actor, workspaceId, artifact.kind, [actual as { id: string; [key: string]: unknown }], tx)).has(artifact.id)) return undefined;
  invariant(await isArtifactPermissionEpochProofCurrent(workspaceId, saved, tx),
    409, "SOURCE_CHANGED", "Artifact permissions changed before the governed edit.");
  const own = saved.entries.find(entry => entry.kind === artifactOwnEpochKind(artifact.kind) && entry.id === artifact.id);
  if (!own) return undefined;
  const currentOwn = await capturePermissionEpochs(tx, workspaceId, [{ kind: own.kind, id: own.id }]);
  invariant(currentOwn.entries[0].epoch === own.epoch, 409, "SOURCE_CHANGED", "Artifact permission episode changed.");
  const checkedHead = await latestManifest(tx, workspaceId, artifact);
  invariant(checkedHead && manifestAdvanceStamp(checkedHead) === manifestAdvanceStamp(previous),
    409, "SOURCE_CHANGED", "Artifact lineage changed during admission.");
  const receipt = Object.freeze({});
  humanAdvanceAdmissions.set(receipt, { tx, actor: sealArtifactInputActor(actor), workspaceId,
    artifact: { kind: artifact.kind, id: artifact.id }, fingerprint,
    manifestStamp: manifestAdvanceStamp(previous), epochs: structuredClone(saved) });
  return receipt;
}

/** Carry verified input permissions across a direct human edit of the same artifact. */
export async function advanceHumanArtifactInputLineage(params: {
  tx: Prisma.TransactionClient;
  actor: AppActor;
  workspaceId: string;
  artifact: LineageInput;
  before: unknown;
  after: unknown;
  /** Original pre-edit admission; cannot be forged, reused or moved across transactions. */
  admission?: object;
  /** Only for a deterministic workflow transition with no new permission-bearing input. */
  allowSystemTransition?: boolean;
}) {
  await assertArtifactInputWriteFence(params.tx);
  await assertPlannedArtifactPublication(params.tx, params.workspaceId, params.artifact);
  const { tx, actor, workspaceId, artifact, before, after } = params;
  if (hasActiveSourceCommitLockPlan(tx)) assertSourceCommitSemanticRootCovered(tx, workspaceId,
    { ...artifact, fingerprint: lineageContentFingerprint(artifact.kind, before) });
  const previous = await latestManifest(tx, workspaceId, artifact);
  const admission = params.admission ? humanAdvanceAdmissions.get(params.admission) : undefined;
  if (params.admission) {
    humanAdvanceAdmissions.delete(params.admission);
    invariant(admission && admission.tx === tx && admission.actor === actor && admission.workspaceId === workspaceId
      && admission.artifact.kind === artifact.kind && admission.artifact.id === artifact.id
      && admission.fingerprint === lineageContentFingerprint(artifact.kind, before)
      && previous && admission.manifestStamp === manifestAdvanceStamp(previous),
    409, "SOURCE_CHANGED", "Governed edit admission belongs to another artifact, head or transaction.");
  }
  const roots = await currentArtifactInputRoots(tx, workspaceId, artifact, before);
  if ((actor.kind !== "user" && !params.allowSystemTransition) || !previous || !roots) {
    invariant(!getMcpToolInputRoots(actor, workspaceId).length, 409, "UNKNOWN_LINEAGE", "A partial MCP edit cannot prove the prior body safe.");
    await invalidateArtifactInputLineage({ tx, workspaceId, artifact, content: after });
    return false;
  }
  const membership = await requireWorkspaceMembership({ actor, workspaceId, tx });
  const domains = await resolveKnowledgeAccessDomains(actor, workspaceId, tx);
  for (const root of roots) {
    invariant(await rootIsReadable(tx, actor, workspaceId, membership, domains, root),
      409, "SOURCE_RESTRICTED", "An earlier input is no longer accessible.");
  }
  const submissionRoots = getMcpToolInputRoots(actor, workspaceId);
  if (submissionRoots.length) {
    invariant(isRecord(before) && actorCanReadRecord(actor, workspaceId, membership, artifact.kind, before),
      409, "SOURCE_RESTRICTED", "The prior content is not available to this MCP writer.");
    const current = await loadArtifact(tx, workspaceId, artifact);
    invariant(current && await evaluateRoot(tx, actor, workspaceId, membership, domains,
      { ...artifact, fingerprint: lineageContentFingerprint(artifact.kind, current) }, new Set(), new Map(), true),
    409, "SOURCE_RESTRICTED", "The current content is not available to this MCP writer.");
    const receipt = await snapshotInput(actor, tx, workspaceId,
      { ...artifact, fingerprint: lineageContentFingerprint(artifact.kind, before) },
      async (upstream) => upstream.length ? captureImmutableArtifactInputProof(actor, workspaceId, upstream, tx) : [],
      { content: before, manifest: previous });
    await recordArtifactInputLineage({ tx, actor, workspaceId, artifact, content: after, origin: "DERIVED", inputs: [],
      inheritedRoots: [receipt.root, ...receipt.roots, ...submissionRoots] });
    return true;
  }
  let permissionEpochs = previous.permissionEpochsJson;
  const saved = previous.epochProofVersion === 1 ? parsePermissionEpochProof(previous.permissionEpochsJson) : null;
  if (previous.origin === "DERIVED" && saved) {
    const ownKind = artifactOwnEpochKind(artifact.kind);
    const own = saved.entries.find(entry => entry.kind === ownKind && entry.id === artifact.id);
    if (own) {
      const current = await capturePermissionEpochs(tx, workspaceId, [{ kind: own.kind, id: own.id }]);
      if (current.entries[0].epoch !== own.epoch) {
        invariant(admission, 409, "SOURCE_CHANGED", "A changed artifact permission episode requires pre-edit admission.");
        const nonOwn = { ...saved, entries: saved.entries.filter(entry => entry.kind !== own.kind || entry.id !== own.id) };
        invariant(nonOwn.entries.length > 0 && await isArtifactPermissionEpochProofCurrent(workspaceId, nonOwn, tx),
          409, "SOURCE_RESTRICTED", "An original upstream permission episode changed.");
        const actual = await loadArtifact(tx, workspaceId, artifact);
        invariant(actual && lineageContentFingerprint(artifact.kind, actual) === lineageContentFingerprint(artifact.kind, after),
          409, "SOURCE_CHANGED", "Artifact changed during its governed edit.");
        await requireWorkspaceMembership({ actor, workspaceId, tx });
        const next = mergePermissionEpochProofs(nonOwn, current);
        const { isArtifactInputPermissionEpochCoverageComplete } = await import("./source-permission-coverage");
        invariant(await isArtifactInputPermissionEpochCoverageComplete({ workspaceId, artifact, content: actual,
          roots, permissionEpochs: next, db: tx }),
        409, "SOURCE_RESTRICTED", "The governed edit introduces an uncaptured permission governor.");
        permissionEpochs = next as unknown as Prisma.JsonValue;
      }
    }
  }
  // Exact optimistic head CAS: a concurrent manifest-only writer conflicts on
  // this original revision+1. Never reread/retry against its replacement head.
  await tx.artifactInputLineage.create({ data: {
    workspaceId, artifactType: artifact.kind, artifactId: artifact.id,
    revision: previous.revision + 1, origin: previous.origin,
    epochProofVersion: previous.epochProofVersion, permissionEpochsJson: permissionEpochs ?? Prisma.JsonNull,
    contentHash: lineageContentFingerprint(artifact.kind, after),
    inputsJson: previous.inputsJson as Prisma.InputJsonValue,
    rootsJson: previous.rootsJson as Prisma.InputJsonValue,
  } });
  if (hasActiveSourceCommitLockPlan(tx)) registerSourceCommitPublishedOutput(tx, workspaceId,
    { ...artifact, fingerprint: lineageContentFingerprint(artifact.kind, after) });
  return true;
}

/** Preserve structural ancestry across archive metadata without refreshing any
 * permission revision. Derived content remains withheld after revocation, while
 * retirement recipes can still discover its exact contributing inputs. */
export async function advanceArchivedArtifactEnvelopeLineage(params: {
  tx: Prisma.TransactionClient; workspaceId: string; artifact: LineageInput;
  before: unknown; after: unknown;
}) {
  await assertArtifactInputWriteFence(params.tx);
  await assertPlannedArtifactPublication(params.tx, params.workspaceId, params.artifact);
  const { tx, workspaceId, artifact, before, after } = params;
  if (!isRecord(before) || !isRecord(after)) return false;
  const prior = await latestManifest(tx, workspaceId, artifact);
  const roots = prior ? parseRoots(prior.rootsJson) : null;
  const original = prior?.origin === "HUMAN_ORIGINAL" && roots?.length === 0
    && Array.isArray(prior.inputsJson) && prior.inputsJson.length === 0;
  const derived = prior?.origin === "DERIVED" && Boolean(roots?.length)
    && prior.epochProofVersion === 1 && Boolean(parsePermissionEpochProof(prior.permissionEpochsJson))
    && Array.isArray(prior.inputsJson);
  if (!prior || (!original && !derived)
    || prior.contentHash !== lineageContentFingerprint(artifact.kind, before)) return false;
  const metadata = ["archivedAt", "archivedByUserId", "archiveReason", "updatedAt",
    ...(artifact.kind === "Proposal" ? ["status"] : []), ...(artifact.kind === "AgentIdentity" ? ["isActive"] : [])];
  const normalized = { ...after };
  for (const field of metadata) normalized[field] = before[field];
  if (lineageContentFingerprint(artifact.kind, normalized) !== prior.contentHash) return false;
  await tx.artifactInputLineage.create({ data: {
    workspaceId, artifactType: artifact.kind, artifactId: artifact.id, revision: prior.revision + 1,
    origin: prior.origin, epochProofVersion: prior.epochProofVersion,
    permissionEpochsJson: prior.permissionEpochsJson ?? Prisma.JsonNull,
    contentHash: lineageContentFingerprint(artifact.kind, after),
    inputsJson: prior.inputsJson as Prisma.InputJsonValue, rootsJson: prior.rootsJson as Prisma.InputJsonValue,
  } });
  await assertArtifactInputWriteFence(tx);
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
  await assertPlannedArtifactPublication(params.tx, params.workspaceId, params.artifact);
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

/** Discovery-only batch equivalent of currentArtifactInputRoots. Canonical rows
 * still have to match the actual latest manifest; this does not grant reads. */
export async function currentArtifactInputRootsBatch(db: LineageClient, workspaceId: string,
  kind: LineageKind, records: readonly {id: string}[]) {
  assertSourceCommitTransactionCompatible(db);
  invariant(records.length <= 100, 409, "LINEAGE_DISCOVERY_PAGE_LIMIT", "Lineage discovery requires canonical pages.");
  if (!records.length) return new Map<string, LineageRoot[] | null>();
  const heads = await db.$queryRaw<Array<{artifactId: string; contentHash: string; rootsJson: Prisma.JsonValue}>>(Prisma.sql`
    SELECT DISTINCT ON ("artifactId") "artifactId", "contentHash", "rootsJson"
    FROM "ArtifactInputLineage"
    WHERE "workspaceId" = ${workspaceId} AND "artifactType" = ${kind} AND "artifactId" IN (${Prisma.join(records.map(row => row.id))})
    ORDER BY "artifactId", revision DESC
  `);
  const byId = new Map(heads.map(head => [head.artifactId, head]));
  return new Map(records.map(row => {
    const head = byId.get(row.id);
    return [row.id, head?.contentHash === lineageContentFingerprint(kind, row) ? parseRoots(head.rootsJson) : null] as const;
  }));
}

/** Archive existence and paths are source-derived metadata too. This exception
 * returns no body and never admits an archived input to a model or copy writer. */
export async function isArtifactArchiveMetadataReadable(actor: AppActor, workspaceId: string,
  artifact: LineageInput, db: LineageClient = prisma) {
  return evaluateArchiveMetadataRoot(actor, workspaceId, artifact, db);
}

async function evaluateArchiveMetadataRoot(actor: AppActor, workspaceId: string,
  artifact: LineageInput, db: LineageClient, expected?: LineageRoot) {
  assertSourceCommitTransactionCompatible(db);
  const membership = await requireWorkspaceMembership({ actor, workspaceId, tx: db });
  const domains = await resolveKnowledgeAccessDomains(actor, workspaceId, db);
  const row = await loadArtifact(db, workspaceId, artifact);
  if (!isRecord(row)) return false;
  const fingerprint = lineageContentFingerprint(artifact.kind, row);
  if (expected && fingerprint !== expected.fingerprint) return false;
  if (isArchived(row)) {
    const manifest = await latestManifest(db, workspaceId, artifact);
    if (!manifest || manifest.origin !== "HUMAN_ORIGINAL" || manifest.contentHash !== fingerprint
      || manifest.epochProofVersion !== 1 || !parsePermissionEpochProof(manifest.permissionEpochsJson)
      || parseRoots(manifest.rootsJson)?.length !== 0 || !Array.isArray(manifest.inputsJson)
      || manifest.inputsJson.length !== 0) return false;
  }
  return evaluateRoot(db, actor, workspaceId, membership, domains,
    { ...artifact, fingerprint }, new Set(), new Map(), false, true);
}

/** Current policy only for archive-owned purge audit receipts. This does not
 * authenticate a receipt or admit content: archive.ts binds the stored receipt,
 * original human head, post-delete epochs and final current-reader snapshot. */
export async function isPurgedArchiveMetadataPolicyReadable(actor: AppActor, workspaceId: string,
  kind: string, envelope: Record<string, unknown>, db: LineageClient = prisma): Promise<boolean> {
  // These kinds have no live permission parents or native/provider validators.
  // Never broaden this list merely because another kind has a similar DTO.
  if (!["Action", "Goal", "Proposal", "Tension", "BrainArticle", "Meeting", "Document"].includes(kind)
    || envelope.workspaceId !== workspaceId || typeof envelope.id !== "string"
    || envelope.variantOfArticleId != null) return false;
  const sourceKind = kind as LineageKind;
  if (artifactPermissionParents(sourceKind, envelope).length) return false;
  if (["Action", "Goal", "Proposal", "Tension", "BrainArticle"].includes(kind)
    && typeof envelope.isPrivate !== "boolean") return false;
  if (["Action", "Goal", "Proposal", "Tension"].includes(kind) && typeof envelope.status !== "string") return false;
  const membership = await requireWorkspaceMembership({ actor, workspaceId, tx: db });
  if (!await currentCredentialCanRead(db, actor, workspaceId, sourceKind, new Map())
    || !actorCanReadRecord(actor, workspaceId, membership, sourceKind, envelope)) return false;
  if (["Meeting", "Document"].includes(kind) && (typeof envelope.informationCategory !== "string"
    || !await canReadInformationCategory(actor, workspaceId, envelope.informationCategory, db))) return false;
  if (kind === "Document" && !(await resolveKnowledgeAccessDomains(actor, workspaceId, db)).some(domain => domain === String(envelope.accessDomain))) return false;
  return true;
}

/** A metadata-only receipt. It must never be passed to a content/model reader. */
export type ArchiveMetadataProof = { root: LineageRoot; heads: ReadonlyMap<string, string> };

export async function captureArtifactArchiveMetadataProof(actor: AppActor, workspaceId: string,
  artifact: LineageInput): Promise<ArchiveMetadataProof | null> {
  // Cheap rejection before opening a proof transaction. This observation can
  // only withhold a candidate; admission still rereads everything below.
  const candidate = await loadArtifact(prisma, workspaceId, artifact);
  if (!isRecord(candidate)) return null;
  if (isArchived(candidate)) {
    const manifest = await latestManifest(prisma, workspaceId, artifact);
    if (!manifest || manifest.origin !== "HUMAN_ORIGINAL") return null;
  }
  const binding: ReadHeadBinding = { heads: new Map(), sealed: false };
  const root = await expectedReadHeads.run(binding, () => prisma.$transaction(async tx => {
    const membership = await requireWorkspaceMembership({ actor, workspaceId, tx });
    const row = await loadArtifact(tx, workspaceId, artifact);
    if (!isRecord(row)) return null;
    const original: LineageRoot = { ...artifact, fingerprint: lineageContentFingerprint(artifact.kind, row) };
    if (!await localCommitAdmission.run(true, () => isArtifactArchiveMetadataReadable(actor, workspaceId, artifact, tx))) return null;
    // Capture the admitted closure and caller before provider replay. Archive
    // transitions intentionally preserve older manifests; use the current epoch
    // vector here solely to fence this metadata read's own lifetime.
    const closure = [...binding.heads.keys()].map(key => {
      const [kind, id] = JSON.parse(key) as [LineageKind, string];
      return { kind, id, fingerprint: "metadata-permission-parent" };
    });
    const epochs = await captureArtifactPermissionEpochs(actor, workspaceId, closure, tx);
    const role = membership?.id ? await capturePermissionEpochs(tx, workspaceId,
      [{ kind: "MemberRolePolicy", id: membership.id }]) : undefined;
    original.permissionEpochs = mergePermissionEpochProofs(epochs, role)!;
    return original;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 30_000 }));
  if (!root) return null;
  const proof = { root, heads: new Map(binding.heads) };
  return await isArtifactArchiveMetadataProofReadable(actor, workspaceId, proof) ? proof : null;
}

/** Replay the ORIGINAL fingerprint, permission vector and heads, retaining the
 * archive-only exception. A caller transaction is the final local release fence. */
export async function isArtifactArchiveMetadataProofReadable(actor: AppActor, workspaceId: string,
  proof: ArchiveMetadataProof, db: LineageClient = prisma): Promise<boolean> {
  const read = async () => {
    if (!proof.root.permissionEpochs
      || !await isArtifactPermissionEpochProofCurrent(workspaceId, proof.root.permissionEpochs, db)) return false;
    return evaluateArchiveMetadataRoot(actor, workspaceId, proof.root, db, proof.root);
  };
  return expectedReadHeads.run({ heads: new Map(proof.heads), sealed: true },
    () => db === prisma ? read() : localCommitAdmission.run(true, read));
}

/** Returns only ids whose current content and every permission-bearing input are provably safe. */
export async function readableArtifactIds(actor: AppActor, workspaceId: string,
  kind: LineageKind, records: Array<{ id: string; [key: string]: unknown }>, db: LineageClient = prisma): Promise<Set<string>> {
  assertSourceCommitTransactionCompatible(db);
  if (APPROVAL_READ_KINDS.has(kind) && !artifactReadCapture.getStore() && !localDeliveryReadBatch.getStore()) {
    const roots = records.map(record => ({kind, id: record.id, fingerprint: lineageContentFingerprint(kind, record)}));
    const loaded = await prepareLocalDeliveryBatch(db, workspaceId, roots);
    if (loaded) {
      let ids = new Set<string>();
      const valid = await readLocalDeliveryBatch(db, workspaceId, loaded, roots, async () => {
        ids = await readableArtifactIds(actor, workspaceId, kind, records, db);
        return true;
      });
      if (valid) return ids;
      // A denied saved vector can share a page with readable siblings. The
      // ordinary path decides those independently using the original records.
    }
  }
  const membership = await requireWorkspaceMembership({ actor, workspaceId, tx: db });
  const domains = await resolveKnowledgeAccessDomains(actor, workspaceId, db);
  // Select the actual latest row in PostgreSQL; histories grow independently of
  // the canonical candidate page. Never fall back to an older matching proof.
  const manifests = records.length ? await db.$queryRaw<Prisma.ArtifactInputLineageGetPayload<Record<string, never>>[]>(Prisma.sql`
    SELECT DISTINCT ON ("artifactId") * FROM "ArtifactInputLineage"
    WHERE "workspaceId" = ${workspaceId} AND "artifactType" = ${kind}
      AND "artifactId" IN (${Prisma.join(records.map(record => record.id))})
    ORDER BY "artifactId", revision DESC
  `) : [];
  const latest = new Map<string, typeof manifests[number]>();
  for (const manifest of manifests) if (!latest.has(manifest.artifactId)) latest.set(manifest.artifactId, manifest);
  const rootCache = new Map<string, boolean>();
  const visible = new Set<string>();
  for (const record of records) {
    if ("workspaceId" in record && record.workspaceId !== workspaceId) continue;
    if (db === prisma && !bindReadHead(rootCache, { kind, id: record.id }, latest.get(record.id) ?? null)) continue;
    if (!needsManifest(kind, record)) {
      if (await rootIsReadable(db, actor, workspaceId, membership, domains,
        { kind, id: record.id, fingerprint: lineageContentFingerprint(kind, record) }, new Set(), rootCache)) visible.add(record.id);
      continue;
    }
    const manifest = latest.get(record.id);
    if (!manifest || manifest.contentHash !== lineageContentFingerprint(kind, record)
      || isArchived(record) || !actorCanReadRecord(actor, workspaceId, membership, kind, record)) continue;
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
  if (db === prisma && !localCommitAdmission.getStore() && visible.size
    && (nativeReplayMemos.has(rootCache) || readHeadBinding(rootCache).nativeReplay)) {
    const currentMembership = await requireWorkspaceMembership({ actor, workspaceId, tx: db });
    const currentDomains = await resolveKnowledgeAccessDomains(actor, workspaceId, db);
    const finalMemo = new Map<string, boolean>();
    const binding = sealedReadHeadBinding(rootCache);
    readHeadMemos.set(finalMemo, binding);
    await localCommitAdmission.run(true, async () => {
      for (const record of records) if (visible.has(record.id)
        && !await rootIsReadable(db, actor, workspaceId, currentMembership, currentDomains,
          { kind, id: record.id, fingerprint: lineageContentFingerprint(kind, record) }, new Set(), finalMemo)) visible.delete(record.id);
    });
  }
  if (artifactReadCapture.getStore()) {
    for (const record of records.filter((row) => visible.has(row.id))) {
      const manifest = latest.get(record.id);
      const base = { kind, id: record.id, fingerprint: lineageContentFingerprint(kind, record) };
      const permissionEpochs = kind === "ArtifactInputSnapshot" ? undefined : db === prisma
        ? await prisma.$transaction(tx => captureArtifactPermissionEpochs(actor, workspaceId, [base], tx))
        : await captureArtifactPermissionEpochs(actor, workspaceId, [base], db);
      const root = {...base, ...(permissionEpochs ? {permissionEpochs} : {})};
      observeArtifactRead(actor, workspaceId, [root, ...(manifest ? parseRoots(manifest.rootsJson) ?? [] : [])]);
    }
  }
  return visible;
}

/** Direct source listings must not reveal copied/model-generated content without its upstream proof. */
export async function readableBrainSourceIds(actor: AppActor, workspaceId: string,
  records: Array<{ id: string; workspaceId: string; accessDomain: string; archivedAt: Date | null;
    sourceType: string; channel: string | null; [key: string]: unknown }>, db: LineageClient = prisma) {
  await requireWorkspaceMembership({ actor, workspaceId, tx: db });
  const domains = await resolveKnowledgeAccessDomains(actor, workspaceId, db);
  const candidates = records.filter((row) => row.workspaceId === workspaceId
    && row.archivedAt === null && domains.some((domain) => domain === row.accessDomain));
  return readableArtifactIds(actor, workspaceId, "BrainSource", candidates, db);
}
