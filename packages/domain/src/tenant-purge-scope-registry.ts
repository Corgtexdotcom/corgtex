import { Prisma } from "@prisma/client";

export const TENANT_PURGE_DISPOSITIONS = [
  "TARGET", "CASCADE", "SET_NULL_EXPLICIT_CLEANUP", "RESTRICT_BLOCKER", "NO_ACTION_BLOCKER", "SET_DEFAULT_BLOCKER",
  "DEFAULT_ACTION_VERIFIED", "EXPLICIT_CLEANUP", "RETAIN", "SHARED_PRESERVE",
] as const;
export type TenantPurgeDisposition = typeof TENANT_PURGE_DISPOSITIONS[number];

export const TENANT_PURGE_MODEL_DISPOSITIONS = {
  TARGET: ["Workspace", "CustomerAccount", "CustomerDeployment", "ProcurementTrial"],
  CASCADE: [
    "Action", "ActionChecklistItem", "AdviceProcess", "AdviceRequest", "AdviceRequestRecipient", "AgentCredential", "AgentIdentity", "AgentMemory", "AgentRun", "AgentStep", "AgentToolCall",
    "AiUsageLedgerEntry", "AiWorkspaceConnection", "AppInstallation", "AppSession", "AppSurfaceAssignment", "ApprovalDecision", "ApprovalFlow", "ApprovalPolicy", "AuditLog",
    "BrainArticle", "BrainArticleVersion", "BrainBacklink", "BrainDiscussionComment", "BrainDiscussionThread", "BrainSource", "BuildArtifact", "BuildArtifactAsset",
    "CatalogFavorite", "CatalogItem", "CatalogRequest", "CatalogSettings", "CheckIn", "Circle", "CircleAgentAssignment", "CommunicationChannel", "CommunicationContextSummary",
    "CommunicationEntityLink", "CommunicationExternalUser", "CommunicationInstallation", "CommunicationMessage", "Constitution", "ConstitutionSourceReference", "ContextGraphEvidenceRef",
    "ContextGraphObject", "ContextGraphProposedDiff", "ContextGraphRelationship", "ContextMapLayoutItem", "ContextMapView", "ConversationPendingOperation", "ConversationSession", "ConversationTurn",
    "CrmAccount", "CrmActivity", "CrmCommunicationSuggestion", "CrmContact", "CrmConversation", "CrmConversationMessage", "CrmDeal", "CrmDealStageTransition", "CrmProspectWorkspace",
    "CrmQualification", "CustomerDeploymentAccess", "CustomerReleaseTarget", "DeliberationEntry", "DemoLead", "Document", "ExecutionRequest", "ExecutionResult", "ExpertiseTag",
    "ExternalContentSource", "ExternalContentSyncLog", "ExternalDataSource", "ExternalDataSyncLog", "ExternalMcpConnection", "FinanceClient", "FinanceConsultant", "FinanceContributionEntry",
    "FinanceExpense", "FinanceImportApplication", "FinanceImportBatch", "FinanceImportProfile", "FinanceProject", "FinanceReport", "FinanceTimeEntry", "Goal", "GoalLink", "GoalUpdate",
    "GovernanceScore", "ImpactFootprint", "InboundWebhook", "KeyResult", "KnowledgeChunk", "McpOAuthAccessToken", "McpOAuthAuthorizationCode", "Meeting", "MeetingAudioAsset",
    "MeetingFollowUpReview", "MeetingInsight", "MeetingRecorderSmokeRun", "MeetingRecording", "MeetingSeries", "MeetingTranscriptImportBatch", "MeetingTranscriptProcessingProgress",
    "MeetingTranscriptSourceConnection", "MeetingTranscriptSourceRecord", "Member", "MemberEmailAlias", "MemberExpertise", "MemberInviteRequest", "ModelUsage", "ModelUsageBudget",
    "NewspaperDelivery", "NewspaperEdition", "NewspaperTrackedLink", "Notification", "NotificationDelivery", "OAuthApp", "OAuthConnection", "Objection", "PolicyCorpus",
    "ProcurementBillingHandoff", "ProcurementSetupSession", "ProductAnalyticsEvent", "Proposal", "Recognition", "Role", "RoleAssignment", "RoleHolderHistory", "RoleOnboardingSession",
    "RoleVersion", "Tension", "TensionUpvote", "UserWorkspaceOnboardingState", "WebhookDelivery", "WebhookEndpoint", "WorkItemEvidence", "WorkItemVersion", "WorkspaceAgentConfig",
    "WorkspaceArchiveRecord", "WorkspaceBillingProfile", "WorkspaceBriefing", "WorkspaceEnterpriseService", "WorkspaceExternalResource", "WorkspaceExternalResourceAttachment",
    "WorkspaceExternalResourceMention", "WorkspaceFeatureFlag", "WorkspaceIntegrationBinding", "WorkspaceMeetingRecorderConfig", "WorkspaceModuleAccessRequest", "WorkspaceModuleGrant",
    "WorkspacePermalink", "WorkspaceRecorderCalendarSource", "WorkspaceSsoConfig", "WorkspaceToolLink", "WorkspaceToolLinkCircleTag",
  ],
  SET_NULL_EXPLICIT_CLEANUP: ["CommunicationInboundEvent", "CustomerDeploymentEvent", "Event", "MeetingRecorderProviderEvent", "SupportOperation", "WorkflowJob"],
  RESTRICT_BLOCKER: ["ClientMigrationIdMap", "ClientMigrationRun", "ProviderCutover"],
  NO_ACTION_BLOCKER: [],
  SET_DEFAULT_BLOCKER: [],
  DEFAULT_ACTION_VERIFIED: [],
  EXPLICIT_CLEANUP: [
    "CustomerDeploymentBootstrapRun", "CustomerEntitlement", "EmailDelivery", "EmailDeliveryEvent", "FinanceImportCandidate", "FinanceReportFact", "FleetHealthSnapshot",
    "OAuthAccessToken", "OAuthAuthorizationCode", "ProcurementIdempotencyKey", "SelfServeEmailCapture", "SelfServeSmokeRun", "SelfServeSupportSession",
  ],
  RETAIN: ["StripeWebhookEvent", "TenantPurgeRun"],
  SHARED_PRESERVE: ["AppDefinition", "AppRelease", "AppRuntime", "McpOAuthClient", "NotificationPreference", "PasswordResetToken", "Session", "User", "UserSsoIdentity"],
} as const satisfies Record<TenantPurgeDisposition, readonly Prisma.ModelName[]>;

export const TENANT_PURGE_TARGET_MODELS = ["Workspace", "CustomerDeployment", "CustomerAccount", "ProcurementTrial"] as const;
export type TenantPurgeTargetModel = typeof TENANT_PURGE_TARGET_MODELS[number];
export const PRISMA_REFERENTIAL_ACTIONS = ["Cascade", "SetNull", "Restrict", "NoAction", "SetDefault"] as const;
export type PrismaReferentialAction = typeof PRISMA_REFERENTIAL_ACTIONS[number];
export type ReferentialActionSource = "EXPLICIT" | "POSTGRESQL_DEFAULT";

export interface TenantPurgeDirectRelation {
  model: Prisma.ModelName;
  relationField: string;
  target: TenantPurgeTargetModel;
  relationName: string | null;
  fields: string[];
  references: string[];
  relationOptional: boolean;
  fieldOptional: boolean[];
  onDelete: PrismaReferentialAction;
  onDeleteSource: ReferentialActionSource;
  onUpdate: PrismaReferentialAction;
  onUpdateSource: ReferentialActionSource;
}

const DIRECT_RELATION_DSL = `
WorkspaceFeatureFlag|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade;FinanceClient|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade;FinanceConsultant|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade;FinanceProject|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade
FinanceTimeEntry|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade;FinanceExpense|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade;FinanceContributionEntry|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade;FinanceReport|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade
FinanceImportBatch|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade;FinanceImportApplication|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade;FinanceImportProfile|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade;WorkspaceModuleGrant|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade
WorkspaceModuleAccessRequest|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade;WorkspaceIntegrationBinding|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade;CommunicationInstallation|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade;CommunicationExternalUser|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade
CommunicationChannel|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade;CommunicationMessage|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade;CommunicationContextSummary|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade;CommunicationInboundEvent|workspace|Workspace||workspaceId|id|1|1|SetNull|Cascade
CommunicationEntityLink|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade;Member|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade;MemberEmailAlias|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade;MemberInviteRequest|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade
CheckIn|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade;Circle|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade;WorkspaceToolLink|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade;CatalogItem|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade
CatalogFavorite|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade;CatalogRequest|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade;CatalogSettings|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade;AppRuntime|customerDeployment|CustomerDeployment||customerDeploymentId|id|1|1|SetNull|Cascade
AppInstallation|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade;AppSurfaceAssignment|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade;AppSession|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade;BuildArtifact|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade
RoleVersion|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade;RoleHolderHistory|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade;RoleOnboardingSession|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade;Action|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade
ActionChecklistItem|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade;Tension|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade;Proposal|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade;DeliberationEntry|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade
ApprovalPolicy|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade;ApprovalFlow|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade;MeetingSeries|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade;Meeting|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade
WorkspaceMeetingRecorderConfig|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade;WorkspaceRecorderCalendarSource|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade;MeetingRecording|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade;MeetingAudioAsset|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade
MeetingRecorderProviderEvent|workspace|Workspace||workspaceId|id|1|1|SetNull|Cascade;MeetingRecorderSmokeRun|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade;MeetingRecorderSmokeRun|deployment|CustomerDeployment||deploymentId|id|1|1|SetNull|Cascade;Document|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade
WorkItemEvidence|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade;WorkspaceExternalResource|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade;WorkspaceExternalResourceAttachment|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade;WorkspaceExternalResourceMention|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade
ExternalContentSource|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade;ExternalContentSyncLog|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade;PolicyCorpus|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade;Constitution|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade
ConstitutionSourceReference|workspace|Workspace|ConstitutionSourceWorkspace|workspaceId|id|0|0|Cascade|Cascade;GovernanceScore|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade;AuditLog|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade;WorkItemVersion|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade
ProductAnalyticsEvent|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade;UserWorkspaceOnboardingState|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade;MeetingTranscriptSourceConnection|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade;MeetingTranscriptImportBatch|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade
MeetingTranscriptSourceRecord|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade;MeetingTranscriptProcessingProgress|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade;WorkspaceArchiveRecord|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade;WorkspacePermalink|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade
Event|workspace|Workspace||workspaceId|id|1|1|SetNull|Cascade;WorkflowJob|workspace|Workspace||workspaceId|id|1|1|SetNull|Cascade;WorkspaceBriefing|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade;NewspaperEdition|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade
NewspaperDelivery|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade;NewspaperTrackedLink|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade;KnowledgeChunk|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade;ContextGraphObject|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade
ContextGraphRelationship|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade;ContextGraphEvidenceRef|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade;ContextMapView|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade;ContextGraphProposedDiff|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade
ModelUsage|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade;AgentCredential|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade;AgentRun|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade;Notification|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade
NotificationDelivery|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade;ConversationSession|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade;ConversationPendingOperation|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade;AgentMemory|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade
BrainArticle|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade;BrainSource|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade;BrainBacklink|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade;WebhookEndpoint|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade
InboundWebhook|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade;OAuthConnection|workspace|Workspace||workspaceId|id|1|1|Cascade|Cascade;ExpertiseTag|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade;AdviceProcess|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade
AdviceRequest|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade;ImpactFootprint|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade;DemoLead|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade;CrmAccount|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade
CrmContact|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade;CrmDeal|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade;CrmDealStageTransition|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade;CrmActivity|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade
CrmCommunicationSuggestion|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade;WorkspaceAgentConfig|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade;WorkspaceSsoConfig|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade;ModelUsageBudget|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade
WorkspaceBillingProfile|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade;AiUsageLedgerEntry|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade;OAuthApp|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade;McpOAuthAuthorizationCode|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade
McpOAuthAccessToken|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade;ExternalMcpConnection|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade;AiWorkspaceConnection|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade;ExecutionRequest|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade
ExecutionResult|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade;WorkspaceEnterpriseService|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade;ExternalDataSource|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade;MeetingFollowUpReview|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade
MeetingInsight|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade;Goal|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade;Recognition|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade;AgentIdentity|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade
CrmQualification|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade;CrmConversation|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade;CrmProspectWorkspace|crmWorkspace|Workspace|CrmWorkspace|crmWorkspaceId|id|0|0|Cascade|Cascade;CrmProspectWorkspace|targetWorkspace|Workspace|TargetWorkspace|targetWorkspaceId|id|0|0|Cascade|Cascade
CustomerAccount|primaryDeployment|CustomerDeployment|CustomerAccountPrimaryDeployment|primaryDeploymentId|id|1|1|SetNull|Cascade;CustomerDeployment|managedWorkspace|Workspace||managedWorkspaceId|id|1|1|SetNull|Cascade;CustomerDeployment|customerAccount|CustomerAccount|CustomerAccountDeployments|customerAccountId|id|1|1|SetNull|Cascade;FleetHealthSnapshot|customerAccount|CustomerAccount||customerAccountId|id|0|0|Cascade|Cascade
FleetHealthSnapshot|deployment|CustomerDeployment||deploymentId|id|1|1|SetNull|Cascade;CustomerEntitlement|customerAccount|CustomerAccount||customerAccountId|id|0|0|Cascade|Cascade;CustomerEntitlement|deployment|CustomerDeployment||deploymentId|id|1|1|SetNull|Cascade;CustomerReleaseTarget|customerAccount|CustomerAccount||customerAccountId|id|0|0|Cascade|Cascade
CustomerReleaseTarget|deployment|CustomerDeployment||deploymentId|id|0|0|Cascade|Cascade;CustomerDeploymentEvent|deployment|CustomerDeployment||deploymentId|id|1|1|SetNull|Cascade;ClientMigrationRun|customerAccount|CustomerAccount||customerAccountId|id|0|0|Cascade|Cascade;ClientMigrationRun|sourceDeployment|CustomerDeployment|ClientMigrationSourceDeployment|sourceDeploymentId|id|0|0|Cascade|Cascade
ClientMigrationRun|destinationDeployment|CustomerDeployment|ClientMigrationDestinationDeployment|destinationDeploymentId|id|1|1|SetNull|Cascade;CustomerDeploymentAccess|deployment|CustomerDeployment||deploymentId|id|0|0|Cascade|Cascade;SupportOperation|deployment|CustomerDeployment||deploymentId|id|1|1|SetNull|Cascade;ProcurementSetupSession|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade
ProcurementBillingHandoff|workspace|Workspace||workspaceId|id|0|0|Cascade|Cascade;ProcurementTrial|workspace|Workspace||workspaceId|id|1|1|Cascade|Cascade;ProviderCutover|account|CustomerAccount||customerAccountId|id|0|0|Restrict|Restrict;ProviderCutover|sourceDeployment|CustomerDeployment|SourceDeployment|sourceDeploymentId,customerAccountId|id,customerAccountId|0|00|Restrict|Restrict
ProviderCutover|destinationDeployment|CustomerDeployment|DestinationDeployment|destinationDeploymentId,customerAccountId|id,customerAccountId|1|10|Restrict|Restrict
`;

function decodeDirectRelations(dsl: string): TenantPurgeDirectRelation[] {
  const explicitUpdates = new Set(["ProviderCutover.account", "ProviderCutover.sourceDeployment", "ProviderCutover.destinationDeployment"]);
  return dsl.trim().split(/[;\n]+/).filter(Boolean).map((row) => {
    const [model, relationField, target, relationName, fieldList, referenceList, relationOptional, optionalBits, onDelete, onUpdate] = row.split("|");
    return {
      model: model as Prisma.ModelName, relationField, target: target as TenantPurgeTargetModel, relationName: relationName || null,
      fields: fieldList.split(","), references: referenceList.split(","), relationOptional: relationOptional === "1",
      fieldOptional: [...optionalBits].map((bit) => bit === "1"), onDelete: onDelete as PrismaReferentialAction, onDeleteSource: "EXPLICIT",
      onUpdate: onUpdate as PrismaReferentialAction, onUpdateSource: explicitUpdates.has(`${model}.${relationField}`) ? "EXPLICIT" : "POSTGRESQL_DEFAULT",
    };
  });
}

export const TENANT_PURGE_DIRECT_RELATIONS = decodeDirectRelations(DIRECT_RELATION_DSL);

function stripPrismaComments(schema: string) {
  let quoted = false;
  return schema.split("\n").map((line) => {
    for (let index = 0; index < line.length - 1; index += 1) {
      if (line[index] === '"' && line[index - 1] !== "\\") quoted = !quoted;
      if (!quoted && line.slice(index, index + 2) === "//") return line.slice(0, index);
    }
    quoted = false;
    return line;
  }).join("\n");
}

function directRelationDeclarations(body: string) {
  const candidate = /^\s*\w+\s+(?:Workspace|CustomerDeployment|CustomerAccount|ProcurementTrial)\??\s+[^\n]*@relation\b/gm;
  const candidates = [...body.matchAll(candidate)];
  const start = /^\s*(\w+)\s+(Workspace|CustomerDeployment|CustomerAccount|ProcurementTrial)(\?)?\s+@relation\s*\(/gm;
  const declarations: Array<{ field: string; target: TenantPurgeTargetModel; optional: boolean; args: string }> = [];
  for (const match of body.matchAll(start)) {
    const open = match.index + match[0].lastIndexOf("(");
    let depth = 1;
    let quoted = false;
    let end = open + 1;
    for (; end < body.length && depth; end += 1) {
      if (body[end] === '"' && body[end - 1] !== "\\") quoted = !quoted;
      else if (!quoted && body[end] === "(") depth += 1;
      else if (!quoted && body[end] === ")") depth -= 1;
    }
    if (depth) throw new Error(`Malformed direct target relation: ${match[1]}`);
    declarations.push({ field: match[1], target: match[2] as TenantPurgeTargetModel, optional: Boolean(match[3]), args: body.slice(open + 1, end - 1) });
  }
  if (declarations.length !== candidates.length) throw new Error("Unparsed direct target relation candidate.");
  return declarations;
}

function parseAction(args: string, key: "onDelete" | "onUpdate", relationOptional: boolean): [PrismaReferentialAction, ReferentialActionSource] {
  const explicit = args.match(new RegExp(`${key}:\\s*(\\w+)`))?.[1];
  if (!explicit && args.includes(`${key}:`)) throw new Error(`Malformed Prisma ${key} action.`);
  if (explicit) {
    if (!PRISMA_REFERENTIAL_ACTIONS.includes(explicit as PrismaReferentialAction)) throw new Error(`Unsupported Prisma ${key} action: ${explicit}`);
    return [explicit as PrismaReferentialAction, "EXPLICIT"];
  }
  return [key === "onUpdate" ? "Cascade" : relationOptional ? "SetNull" : "Restrict", "POSTGRESQL_DEFAULT"];
}

export function parseTenantPurgeDirectRelations(schema: string): TenantPurgeDirectRelation[] {
  schema = stripPrismaComments(schema);
  const provider = schema.match(/datasource\s+db\s*\{[\s\S]*?provider\s*=\s*"([^"]+)"[\s\S]*?\}/)?.[1];
  if (provider !== "postgresql") throw new Error(`Unsupported Prisma connector default policy: ${provider ?? "missing"}`);
  const relations: TenantPurgeDirectRelation[] = [];
  for (const modelMatch of schema.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
    const model = modelMatch[1] as Prisma.ModelName;
    const body = modelMatch[2];
    const fieldOptional = new Map<string, boolean>();
    for (const line of body.split("\n")) {
      const field = line.match(/^\s*(\w+)\s+[\w.]+(\?)?/);
      if (field) fieldOptional.set(field[1], Boolean(field[2]));
    }
    for (const relation of directRelationDeclarations(body)) {
      const args = relation.args;
      const fieldsMatch = args.match(/fields:\s*\[([^\]]+)\]/);
      if (!fieldsMatch) continue;
      const referencesMatch = args.match(/references:\s*\[([^\]]+)\]/);
      if (!referencesMatch) throw new Error(`Malformed direct target relation: ${model}.${relation.field}`);
      const fields = fieldsMatch[1].split(",").map((field) => field.trim());
      if (fields.some((field) => !fieldOptional.has(field))) throw new Error(`Unknown direct target field: ${model}.${relation.field}`);
      const relationOptional = relation.optional;
      const [onDelete, onDeleteSource] = parseAction(args, "onDelete", relationOptional);
      const [onUpdate, onUpdateSource] = parseAction(args, "onUpdate", relationOptional);
      const positionalName = args.match(/^\s*"([^"]+)"/)?.[1];
      const namedName = args.match(/(?:^|,)\s*name:\s*"([^"]+)"/)?.[1];
      if (args.includes("name:") && !namedName) throw new Error(`Malformed direct target relation name: ${model}.${relation.field}`);
      relations.push({
        model, relationField: relation.field, target: relation.target,
        relationName: namedName ?? positionalName ?? null, fields,
        references: referencesMatch[1].split(",").map((field) => field.trim()), relationOptional,
        fieldOptional: fields.map((field) => fieldOptional.get(field)!), onDelete, onDeleteSource, onUpdate, onUpdateSource,
      });
    }
  }
  return relations;
}

function canonicalRelations(relations: readonly TenantPurgeDirectRelation[]) {
  return [...relations].sort((a, b) => `${a.model}.${a.relationField}`.localeCompare(`${b.model}.${b.relationField}`));
}

export function assertTenantPurgeScopeRegistry(schema: string, modelNames: readonly Prisma.ModelName[] = Object.values(Prisma.ModelName)) {
  assertTenantPurgeDispositionCoverage(TENANT_PURGE_MODEL_DISPOSITIONS, modelNames);
  const parsed = canonicalRelations(parseTenantPurgeDirectRelations(schema));
  const registered = canonicalRelations(TENANT_PURGE_DIRECT_RELATIONS);
  if (JSON.stringify(parsed) !== JSON.stringify(registered)) throw new Error("Tenant purge direct relation registry drift.");
}

export function assertTenantPurgeDispositionCoverage(
  registry: Record<TenantPurgeDisposition, readonly Prisma.ModelName[]>,
  modelNames: readonly Prisma.ModelName[] = Object.values(Prisma.ModelName),
) {
  const dispositions = Object.values(registry).flat();
  const duplicates = dispositions.filter((model, index) => dispositions.indexOf(model) !== index);
  const missing = modelNames.filter((model) => !dispositions.includes(model));
  const unknown = dispositions.filter((model) => !modelNames.includes(model));
  if (duplicates.length || missing.length || unknown.length) throw new Error(`Tenant purge disposition drift: duplicate=${duplicates} missing=${missing} unknown=${unknown}`);
}
