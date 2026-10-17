import { isCompanyLegacyRecoveryOutcome } from "./legacy-recovery-context";
import { hasPendingCompanyTranscript } from "./native-transcript-publication-context";
import { getMeetingTranscriptWorkerPurpose } from "./native-meeting-workflow-principal";
import { categoryGovernorIdentities } from "./information-category-policy";
import type { Prisma } from "@prisma/client";
import type { AppActor } from "@corgtex/shared";
import type { LineageInput, LineageKind, LineageRoot } from "./source-lineage";
import { invariant } from "./errors";
import { artifactPermissionEpochIdentities, type PermissionEpochIdentity } from "./source-permission-epochs";
import { getExternalProviderWorkerPurpose } from "./external-provider-principal";
import { getTranscriptSourceImportPurpose, getRecorderTranscriptWorkerPurpose, getAudioTranscriptWorkerPurpose } from "./native-transcript-principal";

export type SourceAuthorityClient = Prisma.TransactionClient;
export type SourceAuthorityRow = { table: string; id: string; mode?: "SHARE" | "UPDATE" };
export type SourceAuthorityBudget = { consume(key: string): void; remaining(): number };
type Descriptor = { table: string | null; delegate: string | null; manifest: "required" | "optional" | "snapshot" | "virtual";
  scope: "workspace" | "global" | "crm" | "relation"; relation?: Record<string, unknown>; projection?: readonly string[]; native?: boolean };
function freezeDescriptor<T>(value:T):T {
  if(value&&typeof value==="object") { for(const child of Object.values(value)) freezeDescriptor(child);Object.freeze(value); }
  return value;
}
const row = (table: string, manifest: Descriptor["manifest"] = "required", extra: Partial<Descriptor> = {}): Descriptor =>
  freezeDescriptor({ table, delegate: table[0].toLowerCase() + table.slice(1), manifest, scope: "workspace", ...extra });
const related = (table: string, relation: Record<string, unknown>, manifest: Descriptor["manifest"] = "required") =>
  row(table, manifest, { scope: "relation", relation });

/** Closed SQL/model registry. A new lineage kind cannot silently acquire a default loader or lock policy. */
export const SOURCE_AUTHORITY_REGISTRY = freezeDescriptor({
  OAuthProviderFetchInput: row("OAuthProviderFetchInput", "optional", { native: true }),
  ExternalDataSource: row("ExternalDataSource", "optional"), SqlNativeRunInput: row("SqlNativeRunInput", "optional"),
  MeetingAudioAsset: row("MeetingAudioAsset"), NativeTranscriptInput: row("NativeTranscriptInput", "optional", { native: true }),
  CommunicationMessageNativeInput: row("CommunicationMessageNativeInput", "optional", { native: true }),
  GenericDerivedArtifactVariant: row("GenericDerivedArtifactVariant"), ExternalProviderFetchInput: row("ExternalProviderFetchInput", "optional", { native: true }),
  ExternalContentSource: row("ExternalContentSource"), ExternalMcpResponseInput: row("ExternalMcpResponseInput", "optional", { native: true }),
  ExternalMcpConnectionSet: { table: null, delegate: null, manifest: "virtual", scope: "workspace" },
  WorkspaceToolLink: row("WorkspaceToolLink"), WorkspaceToolLinkCredential: row("WorkspaceToolLink", "optional"),
  ConversationOperationOutcome: row("ConversationOperationOutcome"), FinanceReportUploadInput: row("FinanceReportUploadInput", "optional", { native: true }),
  CrmQualificationFormInput: row("CrmQualificationFormInput", "optional"), ExecutionRequest: row("ExecutionRequest"), ExecutionResult: row("ExecutionResult"),
  FinanceImportBatch: row("FinanceImportBatch"), FinanceImportCandidate: row("FinanceImportCandidate"), FinanceReport: row("FinanceReport"),
  FinanceReportFact: row("FinanceReportFact"), FinanceReportFactRevision: row("FinanceReportFactRevision"), FinanceImportApplication: row("FinanceImportApplication"),
  McpToolInput: row("McpToolInput", "optional"), ConversationIngressInput: row("ConversationIngressInput", "optional"),
  DemoLeadIntakeInput: row("DemoLead", "optional", { projection: ["id", "workspaceId", "email", "source", "createdAt"] }),
  CrmQualificationEmailInput: row("CrmQualification", "optional", { projection: ["id", "workspaceId", "demoLeadId", "responseChannel", "rawEmailReply", "rawEmailSubject", "createdAt"] }),
  DemoLead: row("DemoLead"), CrmQualification: row("CrmQualification"),
  WorkflowJobInput: row("WorkflowJob", "required", { projection: ["id", "workspaceId", "eventId", "type", "payload", "createdAt"] }),
  AgentRequestInput: row("AgentRequestInput", "optional"), AgentFeedbackInput: row("AgentFeedbackInput", "optional"),
  ConversationPendingOperation: row("ConversationPendingOperation"),
  BrainDiscussionThread: related("BrainDiscussionThread", { article: {} }), BrainDiscussionComment: related("BrainDiscussionComment", { thread: { article: {} } }),
  AgentRun: row("AgentRun"), AgentStep: related("AgentStep", { agentRun: {} }), AgentToolCall: related("AgentToolCall", { agentRun: {} }),
  Workspace: row("Workspace", "optional", { scope: "global" }), User: row("User", "optional", { scope: "global" }),
  Member: row("Member", "optional"), AgentIdentity: row("AgentIdentity"),
  CircleAgentAssignment: related("CircleAgentAssignment", { circle: {}, agentIdentity: {} }, "optional"),
  Role: related("Role", { circle: {} }), Circle: row("Circle"), RoleAssignment: related("RoleAssignment", { member: {}, role: { circle: {} } }, "optional"),
  RoleVersion: row("RoleVersion"), RoleHolderHistory: row("RoleHolderHistory"), BrainSource: row("BrainSource"), BrainArticle: row("BrainArticle"),
  BrainArticleVersion: related("BrainArticleVersion", { article: {} }), Document: row("Document"), Meeting: row("Meeting"),
  MeetingTranscript: row("Meeting", "required", { projection: ["id", "workspaceId", "informationCategory", "title", "source", "externalId", "calendarExternalId", "meetingUrl", "meetingUrlHash", "transcript", "ingestionGuidanceMd", "recordedAt", "scheduledEndAt", "seriesId", "participantIds", "participantEmails", "archivedAt", "createdAt"] }),
  MeetingInsight: row("MeetingInsight"), MeetingSeries: row("MeetingSeries"),
  MeetingAgenda: row("Meeting", "required", { projection: ["id", "workspaceId", "informationCategory", "agendaJson", "archivedAt", "createdAt"] }),
  DeliberationEntry: row("DeliberationEntry"), KnowledgeChunk: row("KnowledgeChunk"), MeetingFollowUpReview: row("MeetingFollowUpReview"),
  Action: row("Action"), ActionChecklistItem: row("ActionChecklistItem"), Tension: row("Tension"), TensionUpvote: related("TensionUpvote", { tension: {} }, "optional"),
  Recognition: row("Recognition"), GoalUpdate: related("GoalUpdate", { goal: {} }), KeyResult: related("KeyResult", { goal: {} }),
  CommunicationExternalUser: row("CommunicationExternalUser", "optional"), CommunicationEntityLink: row("CommunicationEntityLink", "optional"),
  CommunicationChannel: row("CommunicationChannel", "optional"), CommunicationMessage: row("CommunicationMessage"), CommunicationContextSummary: row("CommunicationContextSummary"),
  BuildArtifact: row("BuildArtifact"), BuildArtifactAsset: related("BuildArtifactAsset", { artifact: {} }), AgentMemory: row("AgentMemory"),
  ConversationPromptInput: row("ConversationPromptInput", "optional"), AdviceRequest: row("AdviceRequest"), ConversationSession: row("ConversationSession"),
  ConversationTurn: related("ConversationTurn", { conversation: {} }), RoleOnboardingSession: row("RoleOnboardingSession"), PolicyCorpus: row("PolicyCorpus"),
  Notification: row("Notification"), CrmAccount: row("CrmAccount"), CrmContact: row("CrmContact"), CrmDeal: row("CrmDeal"), CrmActivity: row("CrmActivity"),
  CrmDealStageTransition: row("CrmDealStageTransition", "optional"), CrmConversation: row("CrmConversation"),
  CrmConversationMessage: related("CrmConversationMessage", { conversation: {} }), CrmProspectWorkspace: row("CrmProspectWorkspace", "required", { scope: "crm" }),
  CrmCommunicationSuggestion: row("CrmCommunicationSuggestion"), ModelUsageBudget: row("ModelUsageBudget", "optional"),
  ModelUsageCost: row("ModelUsage", "optional", { projection: ["id", "workspaceId", "estimatedCostUsd", "billableCostUsd", "createdAt"] }),
  ApprovalPolicy: row("ApprovalPolicy", "optional"), ApprovalFlow: row("ApprovalFlow"), ApprovalDecision: related("ApprovalDecision", { flow: {} }),
  Objection: related("Objection", { flow: {} }), Constitution: row("Constitution"), ConstitutionSourceReference: row("ConstitutionSourceReference"),
  Proposal: row("Proposal"), Goal: row("Goal"), GoalLink: related("GoalLink", { goal: {} }), CheckIn: row("CheckIn"),
  ContextGraphObject: row("ContextGraphObject"), ContextGraphRelationship: row("ContextGraphRelationship"), ContextGraphEvidenceRef: row("ContextGraphEvidenceRef"),
  ContextGraphProposedDiff: row("ContextGraphProposedDiff"), ContextMapView: row("ContextMapView"), ContextMapLayoutItem: related("ContextMapLayoutItem", { mapView: {} }),
  WorkspaceBriefing: row("WorkspaceBriefing"), NewspaperEdition: row("NewspaperEdition"), NewspaperTrackedLink: row("NewspaperTrackedLink"), NewspaperDelivery: row("NewspaperDelivery"),
  ArtifactInputSnapshot: row("ArtifactInputSnapshot", "snapshot"),
} satisfies Record<LineageKind, Descriptor>);

// Physical governors which are not themselves model inputs still need explicit allowlisted SQL identifiers.
export const SOURCE_AUTHORITY_GOVERNOR_TABLES = ["OAuthConnection", "TranscriptTransportArchive", "NativeTranscriptPublication", "MeetingTranscriptSourceConnection", "MeetingTranscriptSourceRecord", "CommunicationInstallation", "CommunicationIngressInput", "WorkspaceIntegrationBinding", "ExternalMcpConnection",
  "SqlKnowledgePublication", "SqlKnowledgeStagedChunk", "InformationCategoryPolicy", "WorkspaceSupportGrant", "AgentCredential", "McpOAuthAccessToken", "McpOAuthClient", "WorkspaceFeatureFlag", "WorkspaceModuleGrant",
  "AdviceRequestRecipient", "WorkspaceArchiveRecord", "WorkspaceToolLinkCircleTag", "ArtifactInputLineage", "WorkflowJob", "RecorderTranscriptBinding", "RecorderTranscriptAttempt", "RecorderTranscriptClaim", "RecorderTranscriptPublication", "WorkspaceMeetingRecorderConfig", "MeetingRecording", "MeetingRecorderProviderEvent", "MeetingRecorderSmokeRun", "MeetingTranscriptProcessingProgress", "AuditLog", "Event"] as const;
export const SOURCE_AUTHORITY_TABLES:readonly string[] = Object.freeze([...new Set([...Object.values(SOURCE_AUTHORITY_REGISTRY).flatMap(d => d.table ? [d.table] : []), ...SOURCE_AUTHORITY_GOVERNOR_TABLES])]);
export function sourceAuthorityDescriptor(kind: LineageKind): Descriptor {
  invariant(Object.prototype.hasOwnProperty.call(SOURCE_AUTHORITY_REGISTRY, kind), 409, "SOURCE_LOCK_UNSUPPORTED", "Source kind has no closed authority policy.");
  return SOURCE_AUTHORITY_REGISTRY[kind];
}
export function sourceAuthorityPhysicalRow(input: LineageInput): SourceAuthorityRow | null {
  const table = sourceAuthorityDescriptor(input.kind).table;
  return table ? { table, id: input.id } : null;
}
export const authorityRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
export function authorityIdentity(value: unknown): string {
  invariant(typeof value === "string" && value.length > 0 && value.length <= 1024, 409, "SOURCE_LOCK_INCOMPLETE", "Source authority identity is unavailable.");
  return value;
}
type Delegate = { findFirst(args: Record<string, unknown>): Promise<Record<string, unknown> | null>;
  findMany(args: Record<string, unknown>): Promise<Array<Record<string, unknown>>> };
export function sourceAuthorityDelegate(db: SourceAuthorityClient, table: string): Delegate {
  invariant(SOURCE_AUTHORITY_TABLES.includes(table), 409, "SOURCE_LOCK_UNSUPPORTED", "Source authority table is not registered.");
  const delegate = (db as unknown as Record<string, unknown>)[table[0].toLowerCase() + table.slice(1)] as Delegate | undefined;
  invariant(delegate?.findFirst && delegate.findMany, 409, "SOURCE_LOCK_UNSUPPORTED", "Source authority storage is unavailable.");
  if (table === "TranscriptTransportArchive") {
    const select = { id: true, workspaceId: true, connectionId: true, provider: true, configurationHash: true, wireHash: true, cipherHash: true, byteSize: true, createdAt: true };
    return { findFirst: args => delegate.findFirst({ ...args, select }), findMany: args => delegate.findMany({ ...args, select }) };
  }
  return delegate;
}
function scopeRelations(value: Record<string, unknown>, workspaceId: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key,
    Object.keys(child as object).length ? scopeRelations(child as Record<string, unknown>, workspaceId) : { workspaceId }]));
}
/** Structural authority discovery only. It is not a serving/read/copy capability. */
export async function loadSourceAuthorityRecord(db: SourceAuthorityClient, workspaceId: string, input: LineageInput) {
  const descriptor = sourceAuthorityDescriptor(input.kind);
  if (!descriptor.table) {
    const epochs = await db.$queryRaw<Array<{ epoch: bigint }>>`SELECT epoch FROM "SourcePermissionEpoch" WHERE "workspaceId" = ${workspaceId}
      AND "sourceKind" = 'ExternalMcpConnectionSetPolicy' AND "sourceId" = ${input.id}`;
    return { id: input.id, workspaceId, localUserId: input.id, epoch: String(epochs[0]?.epoch ?? 0n) };
  }
  const where = input.kind === "Workspace" ? { id: input.id === workspaceId ? input.id : "" }
    : input.kind === "User" ? { id: input.id, memberships: { some: { workspaceId, isActive: true } } }
      : { id: input.id, ...(descriptor.scope === "crm" ? { crmWorkspaceId: workspaceId }
        : descriptor.scope === "relation" ? scopeRelations(descriptor.relation!, workspaceId) : { workspaceId }),
      ...(input.kind === "CrmQualificationEmailInput" ? { responseChannel: "email_reply" } : {}) };
  const result = await sourceAuthorityDelegate(db, descriptor.table).findFirst({ where,
    ...(descriptor.projection ? { select: Object.fromEntries(descriptor.projection.map(field => [field, true])) } : {}),
    ...(input.kind === "Member" ? { include: { user: { select: { id: true, email: true, displayName: true } } } } : {}),
    ...(input.kind === "WorkspaceToolLink" ? { include: { circleTags: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] } } } : {}),
  });
  return result;
}

export type SourceAuthorityEdges = { artifacts: LineageInput[]; consumedArtifacts?:LineageRoot[]; rows: SourceAuthorityRow[]; policies: PermissionEpochIdentity[];
  predicates: Array<{ key: string; table: string; where: Record<string, unknown>; ids: string[] }>; };
export type AuthorityDiscoveryContext = { actor: AppActor; workspaceId: string; db: SourceAuthorityClient; budget: SourceAuthorityBudget;
  /** Scoped to ONE discovery pass, never a permission/read cache or retained across phases. */
  queryCache?: Map<string,Promise<Array<Record<string,unknown>>>>; rowCache?: Map<string,Record<string,unknown>> };
function queryKey(value:unknown):string {
  if(Array.isArray(value)) return `[${value.map(queryKey).join(",")}]`;
  if(value&&typeof value==="object") return JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0)));
  return JSON.stringify(value)??"null";
}
async function authorityRows(context:AuthorityDiscoveryContext,table:string,where:Record<string,unknown>) {
  const key=JSON.stringify([table,queryKey(where)]);
  let pending=context.queryCache?.get(key);
  if(!pending) {
    pending=sourceAuthorityDelegate(context.db,table).findMany({where,orderBy:{id:"asc"},take:context.budget.remaining()+1});
    context.queryCache?.set(key,pending);
  }
  const rows=await pending;
  for(const row of rows) if(typeof row.id==="string") context.rowCache?.set(JSON.stringify([table,row.id]),row);
  return rows;
}
const sourceKinds: Record<string, LineageKind> = { BRAIN_ARTICLE: "BrainArticle", DOCUMENT: "Document", MEETING: "Meeting", PROPOSAL: "Proposal", EXTERNAL_CONTENT: "ExternalContentSource" };
const discussionKinds: Record<string, LineageKind> = { ...sourceKinds, TENSION: "Tension", ACTION: "Action" };

/** Enumerates every database edge used by evaluateRoot, including existence and collection predicates. */
export async function discoverSourceAuthorityEdges(context: AuthorityDiscoveryContext, input: LineageInput, content: Record<string, unknown>): Promise<SourceAuthorityEdges> {
  const { actor, workspaceId, db, budget } = context;
  const { kind } = input;
  const result: SourceAuthorityEdges = { artifacts: [], rows: [], policies: kind==="ArtifactInputSnapshot" ? [] : artifactPermissionEpochIdentities(kind, { ...content, id: input.id, workspaceId }), predicates: [] };
  const add = (parentKind: LineageKind, id: unknown, required = false) => {
    if (id == null && !required) return;
    const parent = { kind: parentKind, id: authorityIdentity(id) };
    budget.consume(`artifact:${JSON.stringify(parent)}`); result.artifacts.push(parent);
  };
  const field = (parentKind: LineageKind, name: string, required = true) => add(parentKind, content[name], required);
  const rows = async (table: string, where: Record<string, unknown>, key: string, parentKind?: LineageKind, required = false) => {
    const found = await authorityRows(context,table,where);
    invariant(!required || found.length > 0, 409, "SOURCE_LOCK_INCOMPLETE", "A live source authority edge is unavailable.");
    const ids = found.map(row => authorityIdentity(row.id));
    budget.consume(`predicate:${key}`);
    result.predicates.push({ key, table, where, ids });
    for (const id of ids) {
      budget.consume(`row:${table}:${id}`); result.rows.push({ table, id });
      if (parentKind) add(parentKind, id);
    }
    return found;
  };
  if(kind==="ArtifactInputSnapshot") {
    const sourceKind=authorityIdentity(content.sourceKind);
    invariant(Object.prototype.hasOwnProperty.call(SOURCE_AUTHORITY_REGISTRY,sourceKind)&&sourceKind!=="ArtifactInputSnapshot",
      409,"SOURCE_LOCK_UNSUPPORTED","Snapshot authority source is unsupported.");
    add(sourceKind as LineageKind,content.sourceId,true);
  }
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
  if (kind === "WorkspaceToolLinkCredential") add("WorkspaceToolLink", input.id, true);
  if (kind === "MeetingInsight") field("Meeting", "meetingId");
  if (kind === "MeetingFollowUpReview") field("MeetingTranscript", "meetingId");
  if (kind === "CircleAgentAssignment") { field("AgentIdentity", "agentIdentityId"); field("Circle", "circleId"); }
  if (kind === "RoleAssignment") { field("Member", "memberId"); field("Role", "roleId"); }
  if (kind === "Role") field("Circle", "circleId");
  if (kind === "CheckIn") field("Member", "memberId");
  if (kind === "Member") field("User", "userId", false);
  if (kind === "User") await rows("Member", { workspaceId, userId: input.id, isActive: true }, `user-membership:${input.id}`, "Member", true);
  if (kind === "CommunicationEntityLink") field("CommunicationMessage", "messageId", false);
  if (kind === "CommunicationExternalUser") {
    if (content.memberId != null || content.userId != null) await rows("Member", { workspaceId,
      ...(content.memberId != null ? { id: content.memberId } : {}), ...(content.userId != null ? { userId: content.userId } : {}) }, `communication-mapping:${input.id}`, "Member", true);
  }
  if (kind === "ConversationOperationOutcome" && content.operation === "BRAIN_EXPORT_CONSENT") {
    const { decodeBrainExportConsent } = await import("./conversation-brain-consent");
    const consent = decodeBrainExportConsent(content);
    const { getBrainExportWorkerPurpose } = await import("./brain-export-worker");
    const worker = getBrainExportWorkerPurpose(actor, workspaceId);
    if (worker) await rows("WorkflowJob", {id: worker.jobId, workspaceId}, `brain-export-job:${input.id}`, undefined, true);
    invariant(consent, 409, "SOURCE_LOCK_INCOMPLETE", "Authenticated Brain export receipt is unavailable.");
    result.consumedArtifacts = [...(result.consumedArtifacts ?? []), ...consent.roots];
    const boundSources = await rows("BrainSource", {id: consent.sourceId, workspaceId}, `brain-export-source:${input.id}`, undefined, true);
    result.policies.push(...artifactPermissionEpochIdentities("BrainSource", boundSources[0]));
    await rows("InformationCategoryPolicy", {workspaceId, category: boundSources[0].informationCategory}, `brain-export-category:${input.id}`);
    const governors = await categoryGovernorIdentities("BrainSource", boundSources[0], workspaceId, db);
    result.policies.push(...governors);
    for (const governor of governors) await rows(governor.kind, {id: governor.id}, `brain-export-governor:${governor.kind}:${governor.id}`);
  }
  if (kind === "ConversationPromptInput") field("ConversationSession", "sessionId");
  if (["ConversationPendingOperation", "ConversationTurn"].includes(kind)) field("ConversationSession", "conversationId");
  if (["ApprovalDecision", "Objection"].includes(kind)) field("ApprovalFlow", "flowId");
  if (kind === "ApprovalFlow") {
    const subjects: Record<string, LineageKind> = { PROPOSAL: "Proposal", ACTION: "Action", TENSION: "Tension" };
    const parent = subjects[String(content.subjectType)]; invariant(parent, 409, "SOURCE_LOCK_UNSUPPORTED", "Approval subject authority is unsupported."); field(parent, "subjectId");
  }
  if (kind === "SqlNativeRunInput") field("ExternalDataSource", "sourceId");
  if (["ExternalDataSource", "BrainSource", "Document", "Meeting", "MeetingTranscript", "MeetingAgenda"].includes(kind)) {
    await rows("InformationCategoryPolicy", {workspaceId, category: content.informationCategory}, `source-category:${input.kind}:${input.id}`);
    const governors = await categoryGovernorIdentities(kind, content, workspaceId, db);
    result.policies.push(...governors);
    for (const governor of governors) await rows(governor.kind, {id: governor.id, ...(governor.kind === "Role" ? {circle: {workspaceId}} : {workspaceId})}, `source-category-governor:${governor.kind}:${governor.id}`);
  }
  if (kind === "KnowledgeChunk") {
    if (content.sourceType === "EXTERNAL_DATABASE") {
      const metadata = authorityRecord(content.metadata);
      add("SqlNativeRunInput", metadata?.nativeInputId, true);
      await rows("SqlKnowledgePublication", {id: metadata?.sqlPublicationId, workspaceId}, `sql-publication:${input.id}`, undefined, true);
      await rows("SqlKnowledgeStagedChunk", {id: input.id, publication: {workspaceId}}, `sql-output:${input.id}`, undefined, true);
    } else {
      const parent = sourceKinds[String(content.sourceType)]; invariant(parent, 409, "SOURCE_LOCK_UNSUPPORTED", "Knowledge source authority is unsupported."); field(parent, "sourceId");
    }
  }
  if (kind === "DeliberationEntry") {
    const parent = discussionKinds[String(content.parentType)]; invariant(parent, 409, "SOURCE_LOCK_UNSUPPORTED", "Discussion authority is unsupported."); field(parent, "parentId");
  }
  if (kind === "BrainSource" && ["DOC", "FILE_UPLOAD"].includes(String(content.sourceType))) add("Document", authorityRecord(content.metadata)?.documentId);
  if (["CrmQualification", "CrmQualificationEmailInput", "CrmQualificationFormInput"].includes(kind)) field("DemoLeadIntakeInput", "demoLeadId");
  if (kind === "CrmQualificationFormInput") field("CrmQualification", "qualificationId");
  if (kind.startsWith("Crm")) {
    if (kind === "CrmDealStageTransition") field("CrmDeal", "dealId");
    else if (kind === "CrmConversationMessage") field("CrmConversation", "conversationId");
    else if (kind !== "CrmAccount") for (const [parent, name] of [["CrmAccount", "accountId"], ["CrmContact", "contactId"], ["CrmDeal", "dealId"], ["CrmActivity", "activityId"]] as const) field(parent, name, false);
    if (kind === "CrmProspectWorkspace") {
      const target = authorityIdentity(content.targetWorkspaceId);
      // Cross-workspace membership is authority, never semantic input.
      result.policies.push({ kind: "CrmProspectTargetAccessPolicy", id: target });
      await rows("Workspace",{id:target},`crm-target-workspace:${target}`,undefined,true);
      if (actor.kind === "user") {
        await rows("Member", { workspaceId: target, userId: actor.user.id }, `crm-target-member:${target}:${actor.user.id}`, undefined, true);
        await rows("WorkspaceSupportGrant",{workspaceId:target,userId:actor.user.id},`crm-target-support:${target}:${actor.user.id}`);
      } else if(actor.supportOrigin) await rows("WorkspaceSupportGrant",{workspaceId:target,userId:actor.supportOrigin.userId},`crm-target-agent-support:${target}`);
    }
  }
  if (kind === "FinanceReportUploadInput") { field("FinanceImportBatch", "batchId"); field("Document", "documentId"); field("BrainSource", "brainSourceId"); }
  if (kind === "FinanceImportBatch") await rows("FinanceReportUploadInput", { workspaceId, batchId: input.id }, `finance-upload:${input.id}`, "FinanceReportUploadInput", true);
  if (kind === "FinanceReport") field("FinanceImportBatch", "sourceBatchId");
  if (["FinanceReportFact", "FinanceReportFactRevision"].includes(kind)) { field("FinanceReport", "reportId"); field("FinanceImportBatch", "sourceBatchId"); field("FinanceImportCandidate", "sourceCandidateId"); }
  if (kind === "FinanceImportApplication") { field("FinanceImportBatch", "batchId"); field("FinanceImportCandidate", "candidateId"); field("FinanceReportFactRevision", "beforeRevisionId", false); field("FinanceReportFactRevision", "afterRevisionId", false); }
  if (kind === "FinanceReportFactRevision") await rows("FinanceReportFact", { id: content.factId, workspaceId, kind: content.kind }, `finance-fact-lifecycle:${input.id}`, undefined, true);
  if (kind === "FinanceImportCandidate") field("FinanceImportBatch", "batchId");
  if (kind === "AgentFeedbackInput") { field("AgentRun", "agentRunId"); field("AgentStep", "stepId"); field("ArtifactInputSnapshot", "priorRunSnapshotId"); }
  if (["AgentStep", "AgentToolCall"].includes(kind)) field("AgentRun", "agentRunId");
  if (kind === "MeetingAudioAsset") await rows("NativeTranscriptInput", { workspaceId, mode: "AUDIO_UPLOAD", meetingAudioAssetId: input.id }, `audio-native:${input.id}`, "NativeTranscriptInput", true);
  if (kind === "NativeTranscriptInput") {
    invariant(["AUDIO_UPLOAD", "DIRECT_MEMBER_UPLOAD", "RECORDER", "PROVIDER_IMPORT", "COMPANY_MEMBER_UPLOAD"].includes(String(content.mode)), 409, "SOURCE_LOCK_UNSUPPORTED", "Provider transcript authority is unsupported.");
    if (content.mode === "COMPANY_MEMBER_UPLOAD") {
      if (!hasPendingCompanyTranscript(actor, workspaceId, input.id)) {
        const bindings = await rows("NativeTranscriptPublication", { workspaceId, nativeInputId: input.id }, `company-publication:${input.id}`, undefined, true);
        invariant(bindings.length === 1, 409, "SOURCE_LOCK_UNSUPPORTED", "Company transcript publication is unavailable.");
        add("Meeting", String(bindings[0].meetingId), true);
        await rows("ArtifactInputLineage", { workspaceId, id: bindings[0].transcriptManifestId }, `company-original:${input.id}`, undefined, true);
      }
    } else if (content.mode === "PROVIDER_IMPORT") {
      const { decodeProviderTranscriptInput } = await import("./transcript-source-native-input");
      const payload = decodeProviderTranscriptInput(content);
      invariant(payload && payload.workspaceId === workspaceId, 409, "SOURCE_LOCK_UNSUPPORTED", "Provider native custody is unavailable.");
      await rows("TranscriptTransportArchive", { id: payload.archive.id, workspaceId }, `transcript-archive:${payload.archive.id}`, undefined, true);
      await rows("MeetingTranscriptSourceConnection", { id: payload.connectionId, workspaceId }, `transcript-connection:${payload.connectionId}`, undefined, true);
      const purpose = getTranscriptSourceImportPurpose(actor, workspaceId);
      if (purpose?.inputId !== input.id) {
        await rows("MeetingTranscriptSourceRecord", { id: payload.recordId, workspaceId }, `transcript-record:${payload.recordId}`, undefined, true);
        add("Meeting", payload.meetingId, true);
        await rows("ArtifactInputLineage", { id: payload.manifestId, workspaceId, artifactType: "MeetingTranscript", artifactId: payload.meetingId }, `transcript-original:${input.id}`, undefined, true);
      }
    } else if (content.mode === "RECORDER") {
      invariant(content.ownerMemberId == null && content.submittedByUserId == null && ["RECALL_AI", "MEETING_BAAS"].includes(String(content.recorderProvider)),
        409, "SOURCE_LOCK_UNSUPPORTED", "Recorder custody cannot borrow a human or unsupported provider grant.");
      field("Meeting", "recorderMeetingId");
      await rows("RecorderTranscriptBinding", { id: authorityIdentity(content.recorderBindingId), workspaceId }, `recorder-binding:${content.recorderBindingId}`, undefined, true);
      await rows("RecorderTranscriptAttempt", { id: authorityIdentity(content.recorderAttemptId), workspaceId }, `recorder-attempt:${content.recorderAttemptId}`, undefined, true);
      const recordingRows = await rows("MeetingRecording", { id: authorityIdentity(content.recordingId), workspaceId }, `recorder-recording:${content.recordingId}`, undefined, true);
      await rows("WorkspaceMeetingRecorderConfig", { workspaceId }, `recorder-config:${workspaceId}`, undefined, true);
      const purpose = getRecorderTranscriptWorkerPurpose(actor, workspaceId);
      if (purpose?.attemptId === content.recorderAttemptId) {
        const canonicalRows = await rows("MeetingRecording", {
          workspaceId, meetingId: authorityIdentity(content.recorderMeetingId), provider: content.recorderProvider,
          id: { not: content.recordingId }, transcriptProcessedAt: { not: null }, failureCode: null,
          ...(recordingRows[0]?.joinAt ? { joinAt: recordingRows[0].joinAt } : {}),
        }, `recorder-canonical:${content.recorderAttemptId}`);
        for (const canonical of canonicalRows) {
          const receipts = await rows("RecorderTranscriptPublication", { workspaceId, recordingId: canonical.id, meetingId: content.recorderMeetingId }, `recorder-canonical-publications:${canonical.id}`);
          for (const receipt of receipts) {
            await rows("RecorderTranscriptAttempt", { workspaceId, id: receipt.attemptId }, `recorder-canonical-attempt:${receipt.attemptId}`, undefined, true);
            await rows("NativeTranscriptInput", { workspaceId, id: receipt.nativeInputId }, `recorder-canonical-native:${receipt.nativeInputId}`, undefined, true);
          }
        }
      }
      // Discovery adds proof/locks for already readable committed ancestry; it never changes the read gate.
      if (purpose?.attemptId !== content.recorderAttemptId) {
        const publications = await rows("RecorderTranscriptPublication",
          { attemptId: authorityIdentity(content.recorderAttemptId), nativeInputId: input.id,
            recordingId: authorityIdentity(content.recordingId), meetingId: authorityIdentity(content.recorderMeetingId), workspaceId },
          `recorder-publication:${content.recorderAttemptId}`, undefined, true);
        for (const publication of publications) await rows("ArtifactInputLineage", {
          id: authorityIdentity(publication.transcriptManifestId), workspaceId, artifactType: "MeetingTranscript",
          artifactId: authorityIdentity(content.recorderMeetingId),
        }, `recorder-original-manifest:${publication.id}`, undefined, true);
      }
    } else {
      field("Member", "ownerMemberId");
      if (content.mode === "AUDIO_UPLOAD") field("MeetingAudioAsset", "meetingAudioAssetId");
      const purpose = getAudioTranscriptWorkerPurpose(actor, workspaceId);
      if (actor.kind === "agent") {
        invariant(purpose, 409, "SOURCE_LOCK_UNSUPPORTED", "Native transcript worker authority is unavailable.");
        await rows("WorkflowJob", { id: purpose.workflowJobId, workspaceId }, `audio-job:${purpose.workflowJobId}`, undefined, true);
      }
    }
  }
  if (kind === "GenericDerivedArtifactVariant") {
    const scope = authorityRecord(content.scopeJson);
    invariant(Array.isArray(content.targetsJson) && content.targetsJson.length > 0 && Array.isArray(scope?.sources) && scope.sources.length > 0,
      409, "SOURCE_LOCK_INCOMPLETE", "Variant authority is incomplete.");
    for (const entry of content.targetsJson) {
      const target=authorityRecord(entry);
      invariant(target&&["ContextGraphObject","ContextGraphRelationship","ContextGraphEvidenceRef","ContextGraphProposedDiff"].includes(String(target.kind))
        &&typeof target.manifestId==="string"&&typeof target.fingerprint==="string"&&/^[a-f0-9]{64}$/.test(target.fingerprint),
      409,"SOURCE_LOCK_UNSUPPORTED","Variant authority target is unsupported.");add(target.kind as LineageKind,target.id,true);
    }
    for (const entry of scope.sources) {
      const source=authorityRecord(entry);
      invariant(source&&typeof source.kind==="string"&&Object.prototype.hasOwnProperty.call(SOURCE_AUTHORITY_REGISTRY,source.kind)
        &&typeof source.fingerprint==="string"&&/^[a-f0-9]{64}$/.test(source.fingerprint),
      409,"SOURCE_LOCK_UNSUPPORTED","Variant authority source is unsupported.");add(source.kind as LineageKind,source.id,true);
    }
  }
  if (kind === "BrainArticle" && content.variantOfArticleId != null) {
    field("BrainArticle", "variantOfArticleId");
    const states = authorityRecord(content.variantSourceStateJson); invariant(states, 409, "SOURCE_LOCK_INCOMPLETE", "Article variant archive authority is missing.");
    for (const key of Object.keys(states)) {
      invariant(typeof states[key]==="string"&&/^[a-f0-9]{64}$/.test(states[key] as string),409,"SOURCE_LOCK_INCOMPLETE","Article archive state proof is malformed.");
      let entityType = "BrainSource", entityId = key;
      if (key.startsWith("[")) {
        let parsed: unknown; try { parsed = JSON.parse(key); } catch { invariant(false, 409, "SOURCE_LOCK_INCOMPLETE", "Article archive binding is malformed."); }
        invariant(Array.isArray(parsed) && parsed.length === 2 && typeof parsed[0] === "string" && parsed[0] in SOURCE_AUTHORITY_REGISTRY,
          409, "SOURCE_LOCK_UNSUPPORTED", "Article archive source is unsupported.");
        entityType = parsed[0] === "MeetingTranscript" ? "Meeting" : parsed[0]; entityId = authorityIdentity(parsed[1]);
      }
      await rows("WorkspaceArchiveRecord", { workspaceId, entityType, entityId }, `archive-history:${entityType}:${entityId}`);
      result.policies.push({ kind: entityType, id: entityId });
    }
  }
  if (kind === "WorkspaceToolLink") await rows("WorkspaceToolLinkCircleTag", { toolLinkId: input.id }, `tool-circle-tags:${input.id}`);
  if (kind === "AdviceRequest") {
    await rows("AdviceRequestRecipient", { requestId: input.id }, `advice-recipients:${input.id}`);
    if (content.audienceType === "CIRCLE" && actor.kind === "user") {
      const members = await rows("Member", { workspaceId, userId: actor.user.id }, `advice-member:${actor.user.id}`, "Member", true);
      for (const member of members) await rows("RoleAssignment", { memberId: member.id,
        role: { circleId: content.targetCircleId, circle: { workspaceId } } }, `advice-circle-assignments:${input.id}:${member.id}`, "RoleAssignment");
    }
  }
  if (kind.startsWith("Communication")) {
    await rows("CommunicationInstallation", { id: content.installationId, workspaceId }, `installation:${content.installationId}`, undefined, true);
    await rows("WorkspaceIntegrationBinding", { workspaceId, provider: "SLACK" }, `integration:SLACK`);
    if (content.externalChannelId != null) await rows("CommunicationChannel", { workspaceId, installationId: content.installationId,
      externalChannelId: content.externalChannelId }, `channel:${content.installationId}:${content.externalChannelId}`, "CommunicationChannel", true);
    if (kind === "CommunicationMessageNativeInput") {
      invariant(content.provider === "SLACK" && content.mode === "AUTHENTICATED_FETCH", 409, "SOURCE_LOCK_UNSUPPORTED", "Native communication authority is unsupported.");
      field("CommunicationMessage", "communicationMessageId");
      if (content.ingressInputId != null) await rows("CommunicationIngressInput", { id: content.ingressInputId, workspaceId }, `communication-ingress:${content.ingressInputId}`, undefined, true);
    }
  }
  if (kind === "OAuthProviderFetchInput") {
    await rows("OAuthConnection", {id: content.connectionId}, `oauth-connection:${content.connectionId}`, undefined, true);
    await rows("Member", {workspaceId, userId: authorityIdentity(content.localUserId)}, `oauth-owner:${content.localUserId}`, "Member", true);
    field("User", "localUserId");
  }
  // Box safe scopes lock the selection FOR UPDATE even for consumed-only inputs.
  // Declare that strongest mode before the saved epoch union; no inner upgrade is safe.
  if(kind==="ExternalProviderFetchInput"||kind==="ExternalContentSource") {
    const id=kind==="ExternalContentSource"?input.id:authorityIdentity(content.externalContentSourceId);
    budget.consume(`row:ExternalContentSource:${id}`);result.rows.push({table:"ExternalContentSource",id,mode:"UPDATE"});
  }
  if (["ExternalProviderFetchInput", "ExternalContentSource", "ExternalMcpResponseInput"].includes(kind)) {
    await rows("ExternalMcpConnection", { id: content.connectionId, workspaceId }, `external-connection:${content.connectionId}`, undefined, true);
    const user = kind === "ExternalContentSource" ? content.selectedByUserId : content.localUserId;
    await rows("Member", { workspaceId, userId: authorityIdentity(user) }, `external-member:${user}`, "Member", true);
    if (kind === "ExternalProviderFetchInput") {
      invariant(content.providerKey === "box", 409, "SOURCE_LOCK_UNSUPPORTED", "External provider authority is unsupported."); field("ExternalContentSource", "externalContentSourceId");
    }
    const purpose = getExternalProviderWorkerPurpose(actor);
    if (purpose) { budget.consume(`row:ExternalContentSource:${purpose.sourceId}`);result.rows.push({table:"ExternalContentSource",id:purpose.sourceId,mode:"UPDATE"}); add("ExternalContentSource", purpose.sourceId, true); await rows("WorkflowJob", { id: purpose.workflowJobId, workspaceId }, `external-job:${purpose.workflowJobId}`, undefined, true); }
  }
  if (kind === "ExternalMcpConnectionSet") await rows("ExternalMcpConnection", { workspaceId, userId: input.id }, `external-connection-set:${input.id}`);
  if (kind === "ConversationOperationOutcome") {
    const control = authorityRecord(content.controlJson);
    if(content.operation!=="TOOL_LINK_ARCHIVED") invariant(control?.version === 1, 409, "SOURCE_LOCK_INCOMPLETE", "Native outcome authority is incomplete.");
    if (content.operation === "LEGACY_RECOVERY_PUBLICATION") {
      const { decodeLegacyRecovery } = await import("./legacy-recovery");
      const recovery = decodeLegacyRecovery(content);
      invariant(recovery, 409, "SOURCE_LOCK_INCOMPLETE", "Recovery authority is malformed.");
      const where = recovery.targetKind === "ConversationTurn" ? {id: recovery.targetId, conversation: {workspaceId}}
        : recovery.targetKind === "Role" ? {id: recovery.targetId, circle: {workspaceId}}
          : recovery.targetKind === "GoalUpdate" || recovery.targetKind === "KeyResult"
            ? {id: recovery.targetId, goal: {workspaceId}} : {id: recovery.targetId, workspaceId};
      const targets = await rows(recovery.targetKind, where, `recovery-target:${input.id}`, undefined, true);
      await rows("ArtifactInputLineage",{id:recovery.targetManifestId,workspaceId,artifactType:recovery.targetKind,artifactId:recovery.targetId,
        contentHash:recovery.targetFingerprint,origin:"DERIVED"},`recovery-original:${input.id}`,undefined,true);
      const targetEdges = await discoverSourceAuthorityEdges(context, {kind: recovery.targetKind, id: recovery.targetId}, targets[0]);
      result.rows.push(...targetEdges.rows); result.predicates.push(...targetEdges.predicates); result.policies.push(...targetEdges.policies);
      result.artifacts.push(...targetEdges.artifacts);
      result.policies.push(...recovery.epochs.entries.map(({kind, id}) => ({kind, id})));
      for (const root of recovery.roots) add(root.kind, root.id, true);
    }
    else if (content.operation === "ACTION_COMPLETED") { add("Action", control!.actionId, true); add("McpToolInput", control!.inputId, true); add("Member", control!.assigneeMemberId, true); }
    else if(content.operation==="ACTION_COMPLETION_PUBLIC_NOTE") {
      invariant(content.actorKind==="public"&&content.userId===null&&content.credentialId===null&&content.credentialVersion===null&&content.scopeHash===null
        &&Array.isArray(content.requiredScopes)&&content.requiredScopes.length===0&&control!.publicationPolicyVersion===1
        &&control!.audience==="ACTION_READERS"&&Object.keys(control!).length===16,
        409,"SOURCE_LOCK_INCOMPLETE","Public Action note authority is malformed.");
      const actionId=authorityIdentity(control!.actionId);
      invariant(Number.isSafeInteger(control!.publishedActionRevision)&&Number(control!.publishedActionRevision)>0
        &&typeof control!.completedActionFingerprint==="string"&&/^[a-f0-9]{64}$/.test(control!.completedActionFingerprint),
        409,"SOURCE_LOCK_INCOMPLETE","Public note completion revision is malformed.");
      const snapshotId=authorityIdentity(control!.oldActionSnapshotId),fingerprint=authorityIdentity(control!.oldActionSnapshotFingerprint);
      invariant(/^[a-f0-9]{64}$/.test(fingerprint),409,"SOURCE_LOCK_INCOMPLETE","Public note snapshot fingerprint is malformed.");
      // Current controls are physical validators, NEVER recursive semantic Action/MCP grants.
      await rows("Action",{id:actionId,workspaceId},`public-note-action:${input.id}`,undefined,true);
      await rows("McpToolInput",{id:authorityIdentity(control!.inputId),workspaceId},`public-note-input-bytes:${input.id}`,undefined,true);
      result.policies.push({kind:"Action",id:actionId});
      const manifests=sourceAuthorityDelegate(db,"ArtifactInputLineage");
      const currentHead=await manifests.findFirst({where:{workspaceId,artifactType:"Action",artifactId:actionId},orderBy:{revision:"desc"}});
      if(currentHead){result.rows.push({table:"ArtifactInputLineage",id:authorityIdentity(currentHead.id)});budget.consume(`row:ArtifactInputLineage:${currentHead.id}`);}
      const head=await manifests.findFirst({where:{workspaceId,artifactType:"Action",artifactId:actionId,revision:control!.publishedActionRevision,contentHash:control!.completedActionFingerprint}});
      const {lineageContentFingerprint}=await import("./source-lineage");
      const storedRoots=Array.isArray(head?.rootsJson)?head.rootsJson:[];
      invariant(head?.origin==="DERIVED"&&storedRoots.some(value=>{
        const root=authorityRecord(value);return root?.kind==="ConversationOperationOutcome"&&root.id===input.id&&root.fingerprint===lineageContentFingerprint(input.kind,content);
      })&&storedRoots.some(value=>{
        const root=authorityRecord(value);return root?.kind==="ArtifactInputSnapshot"&&root.id===snapshotId&&root.fingerprint===fingerprint;
      }),409,"SOURCE_LOCK_INCOMPLETE","Public note is not bound to its historical completion receipt.");
      result.rows.push({table:"ArtifactInputLineage",id:authorityIdentity(head.id)});
      budget.consume(`row:ArtifactInputLineage:${head.id}`);
      const snapshot=await sourceAuthorityDelegate(db,"ArtifactInputSnapshot").findFirst({where:{id:snapshotId,workspaceId}});
      invariant(snapshot?.sourceKind==="Action"&&snapshot.sourceId===actionId&&lineageContentFingerprint("ArtifactInputSnapshot",snapshot)===fingerprint,
        409,"SOURCE_LOCK_INCOMPLETE","Public note original Action snapshot is unavailable.");
      budget.consume(`consumed:ArtifactInputSnapshot:${snapshotId}:${fingerprint}`);
      result.consumedArtifacts=[{kind:"ArtifactInputSnapshot",id:snapshotId,fingerprint}];
    }
    else if (content.operation === "BRAIN_SOURCE_REMOVAL_COMPLETED") {
      add("BrainSource", control!.sourceId, true); add("Document", control!.documentId); add("BrainSource", control!.pendingSourceId);
      for (const [entityType, id] of [["BrainSource", control!.sourceId], ["Document", control!.documentId]] as const)
        if (id != null) await rows("WorkspaceArchiveRecord", { workspaceId, entityType, entityId: id }, `outcome-archive:${entityType}:${id}`);
      if (control!.jobId != null) await rows("WorkflowJob", { id: control!.jobId, workspaceId }, `outcome-job:${control!.jobId}`, undefined, true);
    } else invariant(content.operation === "TOOL_LINK_ARCHIVED", 409, "SOURCE_LOCK_UNSUPPORTED", "Native outcome authority is unsupported.");
  }
  // Ownership and author membership are live governors even when they are not consumed semantic inputs.
  for (const name of ["ownerMemberId", "memberId", "authorMemberId", "recipientMemberId"]) add("Member", content[name]);
  const users = new Set(["userId", "authorUserId", "createdByUserId", "submittedByUserId", "requesterUserId", "requestedByUserId", "localUserId", "selectedByUserId", "uploadedByUserId"]
    .flatMap(name => name === "userId" && isCompanyLegacyRecoveryOutcome(kind,content) ? [] : typeof content[name] === "string" ? [content[name] as string] : []));
  for (const userId of users) {
    await rows("Member", { workspaceId, userId }, `governing-member:${userId}`);
    await rows("WorkspaceSupportGrant", { workspaceId, userId }, `governing-support:${userId}`);
  }
  for (const name of ["credentialId", "agentCredentialId"]) if (content[name] != null)
    await rows("AgentCredential", { workspaceId, id: content[name] }, `governing-credential:${content[name]}`, undefined, true);
  return result;
}

/** Ambient auth is part of every evaluation, including WORKSPACE-only bodies. No auth function is invoked here. */
export async function discoverAmbientSourceAuthority(context: AuthorityDiscoveryContext, origin: Record<string, unknown> | null) {
  const { actor, workspaceId, db, budget } = context;
  const result: SourceAuthorityEdges = { artifacts: [], rows: [], policies: [{kind: "Workspace", id: workspaceId}], predicates: [] };
  const collect = async (table: string, where: Record<string, unknown>, key: string) => {
    const found = await authorityRows(context,table,where);
    budget.consume(`predicate:${key}`); result.predicates.push({key, table, where, ids: found.map(row => authorityIdentity(row.id))});
    for (const row of found) { const id = authorityIdentity(row.id); budget.consume(`row:${table}:${id}`); result.rows.push({ table, id }); }
    return found;
  };
  const meetingWorker = getMeetingTranscriptWorkerPurpose(actor, workspaceId);
  if (meetingWorker) await collect("WorkflowJob", { id: meetingWorker.jobId, workspaceId }, `meeting-workflow:${meetingWorker.jobId}`);
  const transcriptCaller = getTranscriptSourceImportPurpose(actor, workspaceId);
  if (transcriptCaller?.callerMemberId && transcriptCaller.callerUserId) {
    result.policies.push({kind: "Member", id: transcriptCaller.callerMemberId}, {kind: "MemberUserPolicy", id: transcriptCaller.callerUserId}, {kind: "WorkspaceSupportPolicy", id: transcriptCaller.callerUserId});
    await collect("Member", {id: transcriptCaller.callerMemberId, workspaceId, userId: transcriptCaller.callerUserId}, `transcript-caller:${transcriptCaller.callerMemberId}`);
  }
  const userId = actor.kind === "user" ? actor.user.id : actor.supportOrigin?.userId;
  if (userId) {
    result.policies.push({kind: "MemberUserPolicy", id: userId}, {kind: "WorkspaceSupportPolicy", id: userId});
    const members = await collect("Member", { workspaceId, userId }, `ambient-member:${userId}`);
    await collect("User", { id: userId }, `ambient-user:${userId}`);
    await collect("WorkspaceSupportGrant", { workspaceId, userId }, `ambient-support:${userId}`);
    if (actor.kind === "user") {
      if(actor.user.email.trim().toLowerCase()==="demo@jnj-demo.corgtex.app") {
        const memberships=await collect("Member",{userId},`ambient-demo-all-memberships:${userId}`);
        await collect("WorkspaceSupportGrant",{userId},`ambient-demo-all-support:${userId}`);
        for(const member of memberships) await collect("Workspace",{id:member.workspaceId},`ambient-demo-workspace:${member.workspaceId}`);
        // Existing FK KEY SHARE insertions are fenced by the exact User tuple.
        for(const row of result.rows) if(row.table==="User"&&row.id===userId) row.mode="UPDATE";
      }
      // resolveKnowledgeAccessDomains evaluates finance even for public workspace roots.
      result.policies.push({ kind: "ModulePolicy", id: "finance" }, {kind: "FeaturePolicy", id: "FINANCE"});
      await collect("WorkspaceFeatureFlag", {workspaceId}, "ambient-feature-flags");
      await collect("WorkspaceModuleGrant", {workspaceId}, "ambient-module-grants");
      for (const member of members) {
        result.policies.push({kind: "MemberRolePolicy", id: authorityIdentity(member.id)});
        const assignments = await collect("RoleAssignment", { memberId: member.id }, `ambient-role-assignments:${member.id}`);
        for (const assignment of assignments) await collect("Role", {id: assignment.roleId, circle: {workspaceId}}, `ambient-role:${assignment.roleId}`);
      }
      await collect("Circle", {workspaceId}, "ambient-circles");
    }
  }
  if (actor.kind === "agent") {
    if (actor.credentialId) { result.policies.push({kind: "AgentCredential", id: actor.credentialId}); await collect("AgentCredential", {id: actor.credentialId, workspaceId}, `ambient-credential:${actor.credentialId}`); }
    if (actor.agentIdentityId) { result.policies.push({kind: "AgentIdentity", id: actor.agentIdentityId}); await collect("AgentIdentity", {id: actor.agentIdentityId, workspaceId}, `ambient-agent:${actor.agentIdentityId}`); }
  }
  if (origin?.kind === "oauth") {
    const id = authorityIdentity(origin.id); result.policies.push({kind: "McpOAuthGrantPolicy", id});
    const tokens = await collect("McpOAuthAccessToken", {id, workspaceId}, `ambient-oauth:${id}`);
    for (const token of tokens) await collect("McpOAuthClient", {id: token.clientId}, `ambient-oauth-client:${token.clientId}`);
  } else if(origin?.kind==="agent") {
    await collect("AgentCredential",{id:authorityIdentity(origin.id),workspaceId},`ambient-origin-credential:${origin.id}`);
  }
  // Operation outcome validators also consult the credential creator's current support grant.
  for(const credentialId of new Set(result.rows.filter(row=>row.table==="AgentCredential").map(row=>row.id))) {
    const credential=await sourceAuthorityDelegate(db,"AgentCredential").findFirst({where:{id:credentialId,workspaceId}});
    if(typeof credential?.createdByUserId==="string") {
      const creator=credential.createdByUserId;
      result.policies.push({kind:"WorkspaceSupportPolicy",id:creator});
      await collect("User",{id:creator},`ambient-credential-creator:${creator}`);
      await collect("WorkspaceSupportGrant",{workspaceId,userId:creator},`ambient-credential-support:${creator}`);
    }
  }
  return result;
}
