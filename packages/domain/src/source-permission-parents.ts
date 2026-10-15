import { AsyncLocalStorage } from "node:async_hooks";
import { invariant } from "./errors";
import { Prisma } from "@prisma/client";
import type { LineageInput, LineageKind } from "./source-lineage";
import { loadExternalMcpConnectionSetInput } from "./external-mcp-connection-set";
import { assertSourceCommitRowCovered, assertSourceCommitTransactionCompatible, hasActiveSourceCommitLockPlan } from "./source-commit-lock-plan";
import { sourceAuthorityPhysicalRow } from "./source-authority-edges";

/** These edges supply live permission envelopes, independently of consumed body
 * ancestry. Keep this table aligned with source-lineage's parent authorization. */
export function artifactPermissionParents(kind: LineageKind, row: Record<string, unknown>): LineageInput[] {
  const parents: LineageInput[] = [];
  const add = (parentKind: LineageKind, id: unknown) => {
    if (typeof id === "string" && id) parents.push({ kind: parentKind, id });
  };
  const field = (parentKind: LineageKind, name: string) => add(parentKind, row[name]);
  if (["GoalUpdate", "KeyResult", "GoalLink"].includes(kind)) field("Goal", "goalId");
  if (kind === "ActionChecklistItem") field("Action", "actionId");
  if (kind === "TensionUpvote") field("Tension", "tensionId");
  if (kind === "BrainDiscussionThread") field("BrainArticle", "articleId");
  if (kind === "BrainDiscussionComment") field("BrainDiscussionThread", "threadId");
  if (kind === "BrainArticleVersion") field("BrainArticle", "articleId");
  if (kind === "ContextMapLayoutItem") field("ContextMapView", "mapViewId");
  if (kind === "ConstitutionSourceReference") field("Constitution", "constitutionId");
  if (kind === "PolicyCorpus") field("Proposal", "proposalId");
  if (kind === "BuildArtifactAsset") field("BuildArtifact", "artifactId");
  if (kind === "ExecutionResult") field("ExecutionRequest", "executionRequestId");
  if (kind === "WorkspaceToolLinkCredential") add("WorkspaceToolLink", row.id);
  if (kind === "ConversationOperationOutcome" && row.controlJson && typeof row.controlJson === "object" && !Array.isArray(row.controlJson)) {
    const control = row.controlJson as Record<string, unknown>;
    if (control.version === 1 && row.operation === "LEGACY_RECOVERY_PUBLICATION" && ["Action", "ConversationSession", "ConversationTurn", "Document", "BrainSource", "Role", "Circle"].includes(String(control.targetKind))) {
      add(control.targetKind as LineageKind, control.targetId);
    } else if (control.version === 1 && row.operation === "BRAIN_SOURCE_REMOVAL_COMPLETED") {
      add("BrainSource", control.sourceId); add("Document", control.documentId); add("BrainSource", control.pendingSourceId);
    } else if (control.version === 1 && row.operation === "ACTION_COMPLETED") {
      add("Action", control.actionId); add("McpToolInput", control.inputId); add("Member", control.assigneeMemberId);
    } else if (control.version === 1 && row.operation === "ACTION_COMPLETION_PUBLIC_NOTE") {
      // The public projection inherits the exact old Action body. Its raw
      // command and publishing principal remain private control evidence.
      add("ArtifactInputSnapshot", control.oldActionSnapshotId);
    }
  }
  if (["MeetingInsight", "MeetingFollowUpReview"].includes(kind)) field("Meeting", "meetingId");
  if (kind === "NativeTranscriptInput" && row.mode === "COMPANY_MEMBER_UPLOAD") field("Meeting", "companyMeetingId");
  if (kind === "NativeTranscriptInput" && row.mode === "PROVIDER_IMPORT") field("Meeting", "providerMeetingId");
  if (kind === "NativeTranscriptInput" && row.mode === "RECORDER") field("Meeting", "recorderMeetingId");
  if (kind === "NativeTranscriptInput" && row.mode === "AUDIO_UPLOAD") field("MeetingAudioAsset", "meetingAudioAssetId");
  if (kind === "CircleAgentAssignment") { field("AgentIdentity", "agentIdentityId"); field("Circle", "circleId"); }
  if (kind === "RoleAssignment") { field("Member", "memberId"); field("Role", "roleId"); }
  if (kind === "Role") field("Circle", "circleId");
  if (kind === "CommunicationExternalUser") field("Member", "memberId");
  if (kind === "CommunicationEntityLink") field("CommunicationMessage", "messageId");
  if (kind === "ConversationPromptInput") field("ConversationSession", "sessionId");
  if (["ConversationPendingOperation", "ConversationTurn"].includes(kind)) field("ConversationSession", "conversationId");
  if (["ApprovalDecision", "Objection"].includes(kind)) field("ApprovalFlow", "flowId");
  if (kind === "ApprovalFlow") {
    const subjects: Record<string, LineageKind> = { PROPOSAL: "Proposal", ACTION: "Action", TENSION: "Tension" };
    const parent = subjects[String(row.subjectType)];
    if (parent) field(parent, "subjectId");
  }
  if (kind === "SqlNativeRunInput") field("ExternalDataSource", "sourceId");
  if (kind === "KnowledgeChunk" && row.sourceType === "EXTERNAL_DATABASE") {
    const metadata = row.metadata;
    if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) add("SqlNativeRunInput", (metadata as Record<string, unknown>).nativeInputId);
  }
  if (kind === "KnowledgeChunk") {
    const sources: Record<string, LineageKind> = { BRAIN_ARTICLE: "BrainArticle", DOCUMENT: "Document", MEETING: "Meeting", PROPOSAL: "Proposal", EXTERNAL_CONTENT: "ExternalContentSource" };
    const parent = sources[String(row.sourceType)];
    if (parent) field(parent, "sourceId");
  }
  if (kind === "DeliberationEntry") {
    const sources: Record<string, LineageKind> = { PROPOSAL: "Proposal", TENSION: "Tension", MEETING: "Meeting", BRAIN_ARTICLE: "BrainArticle", ACTION: "Action" };
    const parent = sources[String(row.parentType)];
    if (parent) field(parent, "parentId");
  }
  if (kind === "BrainSource" && ["DOC", "FILE_UPLOAD"].includes(String(row.sourceType))) {
    const metadata = row.metadata;
    if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) add("Document", (metadata as Record<string, unknown>).documentId);
  }
  if (["CrmQualification", "CrmQualificationEmailInput", "CrmQualificationFormInput"].includes(kind)) field("DemoLeadIntakeInput", "demoLeadId");
  if (kind === "CrmQualificationFormInput") field("CrmQualification", "qualificationId");
  if (kind.startsWith("Crm")) {
    if (kind === "CrmDealStageTransition") field("CrmDeal", "dealId");
    else if (kind === "CrmConversationMessage") field("CrmConversation", "conversationId");
    else if (kind !== "CrmAccount") {
      for (const [parent, name] of [["CrmAccount", "accountId"], ["CrmContact", "contactId"], ["CrmDeal", "dealId"], ["CrmActivity", "activityId"]] as const) field(parent, name);
    }
  }
  if (kind === "FinanceReportUploadInput") {
    field("FinanceImportBatch", "batchId"); field("Document", "documentId"); field("BrainSource", "brainSourceId");
  }
  if (kind === "FinanceReport") field("FinanceImportBatch", "sourceBatchId");
  if (["FinanceReportFact", "FinanceReportFactRevision"].includes(kind)) {
    field("FinanceReport", "reportId"); field("FinanceImportBatch", "sourceBatchId"); field("FinanceImportCandidate", "sourceCandidateId");
  }
  if (kind === "FinanceImportApplication") {
    field("FinanceImportBatch", "batchId"); field("FinanceImportCandidate", "candidateId"); field("FinanceReportFactRevision", "beforeRevisionId"); field("FinanceReportFactRevision", "afterRevisionId");
  }
  if (kind === "FinanceImportCandidate") field("FinanceImportBatch", "batchId");
  return parents;
}

const MODEL_ALIASES: Partial<Record<LineageKind, string>> = {
  MeetingTranscript: "Meeting", MeetingAgenda: "Meeting", WorkspaceToolLinkCredential: "WorkspaceToolLink",
  WorkflowJobInput: "WorkflowJob", ModelUsageCost: "ModelUsage", CrmQualificationEmailInput: "CrmQualification", DemoLeadIntakeInput: "DemoLead",
};
const METADATA_FIELDS = new Set([
  "id", "workspaceId", "crmWorkspaceId", "ownerMemberId", "memberId", "authorMemberId", "recipientMemberId",
  "userId", "authorUserId", "createdByUserId", "submittedByUserId", "requesterUserId", "requestedByUserId", "localUserId", "selectedByUserId", "uploadedByUserId",
  "circleId", "parentCircleId", "targetCircleId", "agentIdentityId", "credentialId", "agentCredentialId", "accessDomain",
  "installationId", "externalChannelId", "communicationMessageId", "messageId", "connectionId", "externalContentSourceId",
  "variantOfArticleId", "targetKind", "targetId", "audienceType", "goalId", "actionId", "tensionId", "articleId", "threadId",
  "mapViewId", "constitutionId", "proposalId", "artifactId", "executionRequestId", "meetingId", "mode", "meetingAudioAssetId", "connectionId", "sourceRecordId", "recordingId", "transportArchiveId", "recorderAttemptId", "recorderMeetingId", "recorderBindingId", "recorderProvider",
  "sessionId", "conversationId", "flowId", "subjectType", "subjectId", "sourceType", "sourceId", "parentType", "parentId",
  "demoLeadId", "qualificationId", "accountId", "contactId", "dealId", "activityId", "targetWorkspaceId", "batchId", "documentId",
  "brainSourceId", "sourceBatchId", "reportId", "sourceCandidateId", "candidateId", "targetFactId", "factId", "appliedByUserId", "approvedByUserId", "kind", "beforeRevisionId", "afterRevisionId", "roleId", "status",
  "informationCategory", "isRestricted", "allowedRoleIds", "allowedCircleIds", "isPrivate", "visibility", "classification", "publicRevokedAt", "archivedAt", "isActive",
]);
const RELATION_WORKSPACES: Partial<Record<LineageKind, object>> = {
  Role: { circle: {} }, RoleAssignment: { member: {}, role: { circle: {} } }, CircleAgentAssignment: { circle: {} },
  BrainDiscussionThread: { article: {} }, BrainDiscussionComment: { thread: { article: {} } }, BrainArticleVersion: { article: {} },
  AgentStep: { agentRun: {} }, AgentToolCall: { agentRun: {} }, TensionUpvote: { tension: {} }, GoalUpdate: { goal: {} },
  KeyResult: { goal: {} }, GoalLink: { goal: {} }, BuildArtifactAsset: { artifact: {} }, ConversationTurn: { conversation: {} },
  CrmConversationMessage: { conversation: {} }, ApprovalDecision: { flow: {} }, Objection: { flow: {} }, ContextMapLayoutItem: { mapView: {} },
};
function scopeRelations(value: object, workspaceId: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key,
    Object.keys(child).length ? scopeRelations(child, workspaceId) : { workspaceId }]));
}

type MetadataReadBatch = { db: Prisma.TransactionClient; workspaceId: string; active: boolean;
  rows: ReadonlyMap<string, Record<string, unknown>> };
const metadataReadBatch = new AsyncLocalStorage<MetadataReadBatch>();

/** Raw observations supplied by the bounded local lineage reader. Its owner
 * compares every full row and head again before releasing a successful read. */
export async function withArtifactPermissionMetadataRead<T>(db: Prisma.TransactionClient, workspaceId: string,
  rows: ReadonlyMap<string, Record<string, unknown>>, read: () => Promise<T>): Promise<T> {
  invariant(!metadataReadBatch.getStore() && !hasActiveSourceCommitLockPlan(db),
    409, "SOURCE_CHANGED", "Permission metadata batch cannot nest or cover a writer.");
  const batch = {db, workspaceId, rows, active: true};
  return metadataReadBatch.run(batch, async () => {
    try { return await read(); } finally { batch.active = false; }
  });
}

/** Select only identities and governing bindings; this neither reads parent body
 * lineage nor demands a read scope from the principal writing a new output. */
export async function loadArtifactPermissionMetadata(tx: Prisma.TransactionClient, workspaceId: string,
  input: LineageInput): Promise<Record<string, unknown> | null> {
  assertSourceCommitTransactionCompatible(tx);
  if (hasActiveSourceCommitLockPlan(tx)) {
    const physical = sourceAuthorityPhysicalRow(input);
    if (physical) assertSourceCommitRowCovered(tx, physical.table, physical.id);
  }
  const batch = metadataReadBatch.getStore();
  const observed = batch?.rows.get(JSON.stringify([input.kind, input.id]));
  if (batch && observed) {
    invariant(batch.active && batch.db === tx && batch.workspaceId === workspaceId,
      409, "SOURCE_CHANGED", "Permission metadata batch belongs to another or expired read.");
    return structuredClone(Object.fromEntries(Object.entries(observed).filter(([field]) => METADATA_FIELDS.has(field))));
  }
  if (input.kind === "ExternalMcpConnectionSet") return loadExternalMcpConnectionSetInput(workspaceId, input.id, tx);
  const modelName = MODEL_ALIASES[input.kind] ?? input.kind;
  const model = Prisma.dmmf.datamodel.models.find(candidate => candidate.name === modelName);
  if (!model) return null;
  const fields = new Set(model.fields.filter(field => field.kind !== "object").map(field => field.name));
  const select = Object.fromEntries([...fields].filter(name => METADATA_FIELDS.has(name)).map(name => [name, true]));
  // The documentId in BrainSource's policy metadata is its actual live parent
  // binding; no metadata is forwarded to a model or persisted as semantic input.
  if (["BrainSource", "KnowledgeChunk"].includes(input.kind)) select.metadata = true;
  if (input.kind === "ConversationOperationOutcome") { select.controlJson = true; select.operation = true; }
  const where = input.kind === "Workspace" ? { id: input.id === workspaceId ? input.id : "" }
    : input.kind === "User" ? { id: input.id, memberships: { some: { workspaceId, isActive: true } } }
      : { id: input.id, ...(input.kind === "CrmProspectWorkspace" ? { crmWorkspaceId: workspaceId }
        : RELATION_WORKSPACES[input.kind] ? scopeRelations(RELATION_WORKSPACES[input.kind]!, workspaceId)
          : fields.has("workspaceId") ? { workspaceId } : {}) };
  const delegateName = modelName[0].toLowerCase() + modelName.slice(1);
  const delegate = (tx as unknown as Record<string, unknown>)[delegateName] as {
    findFirst(params: { where: Record<string, unknown>; select: Record<string, boolean> }): Promise<Record<string, unknown> | null>;
  } | undefined;
  if (!delegate) return null;
  const result = await delegate.findFirst({ where, select });
  if (result?.mode === "COMPANY_MEMBER_UPLOAD") {
    const binding = await tx.nativeTranscriptPublication.findFirst({ where: { workspaceId, nativeInputId: input.id }, select: { id: true, meetingId: true } });
    if (binding) {
      if (hasActiveSourceCommitLockPlan(tx)) assertSourceCommitRowCovered(tx, "NativeTranscriptPublication", binding.id);
      result.companyMeetingId = binding.meetingId;
    }
  }
  if (result?.mode === "PROVIDER_IMPORT" && typeof result.sourceRecordId === "string") {
    if (hasActiveSourceCommitLockPlan(tx)) assertSourceCommitRowCovered(tx, "MeetingTranscriptSourceRecord", result.sourceRecordId);
    const record = await tx.meetingTranscriptSourceRecord.findFirst({ where: { id: result.sourceRecordId, workspaceId }, select: { meetingId: true } });
    if (record?.meetingId) result.providerMeetingId = record.meetingId;
  }
  if (result?.metadata && typeof result.metadata === "object" && !Array.isArray(result.metadata)) {
    const metadata = result.metadata as Record<string, unknown>;
    result.metadata = { documentId: metadata.documentId, nativeInputId: metadata.nativeInputId, sqlPublicationId: metadata.sqlPublicationId };
  }
  if (result?.controlJson && typeof result.controlJson === "object" && !Array.isArray(result.controlJson)) {
    const control = result.controlJson as Record<string, unknown>;
    result.controlJson = Object.fromEntries(["version", "sourceId", "documentId", "pendingSourceId", "actionId", "inputId", "assigneeMemberId",
      "publicationPolicyVersion", "audience", "publishedActionRevision", "completedActionFingerprint",
      "oldActionSnapshotId", "oldActionSnapshotFingerprint", "targetKind", "targetId"]
      .map(field => [field, control[field]]));
  }
  return result;
}
