import { createHash } from "node:crypto";

export interface TransferSqlClient {
  query(sql: string, parameters?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export type TransferDisposition = "copy" | "transform" | "rebuild" | "discard" | "operator-control";

export interface TransferTablePolicy {
  disposition: TransferDisposition;
  reason: string;
  // Every populated JSON/array, object, secret and opaque reference field needs
  // an explicit disposition. Content is retained byte-for-byte, never UUID-scanned.
  fields?: Record<string, {
    kind: "content" | "reference" | "secret" | "object" | "effect";
    reason: string;
    references?: { table: string; column: string };
    // Reviewed absence of an object plus retained inline content, bound to this
    // exact locator. Only Document/BrainSource support this historical case.
    retainedInlineValues?: { valueSha256: string; evidenceSha256: string; reason: string }[];
  }>;
}

export interface TenantTransferManifest {
  formatVersion: 1;
  transferId: string;
  workspaceId: string;
  workspaceSlug: string;
  // The converted isolated source and target must both match this schema.
  schemaSha256: string;
  // A prepared publication binds its original snapshot and private staging payload.
  preparedFromSha256?: string;
  stagingSha256?: string;
  tables: Record<string, TransferTablePolicy>;
}

export interface TransferColumn {
  name: string;
  type: string;
  nullable: boolean;
}

export interface TransferForeignKey {
  // A reviewed scalar reference absent from the database FK catalog.
  declared?: true;
  columns: string[];
  referencedTable: string;
  referencedColumns: string[];
}

export interface TransferTableData {
  name: string;
  columns: TransferColumn[];
  primaryKey: string[];
  foreignKeys: TransferForeignKey[];
  // Each non-null value is PostgreSQL's text representation, including JSON,
  // decimal, timestamp, vector and arrays. JavaScript never parses their numbers.
  rows: (string | null)[][];
  sha256: string;
}

export interface TenantTransferSnapshot {
  formatVersion: 1;
  manifest: TenantTransferManifest;
  manifestSha256: string;
  sourceSnapshot: string;
  sourceDatabase: string;
  schemaSha256: string;
  tables: TransferTableData[];
  dispositions: { table: string; sourceRows: string; selectedRows: string; disposition: TransferDisposition; reason: string }[];
  sha256: string;
}

// Reviewed scalar inventory from the current schema. These are classification
// requirements, not inferred transfer dispositions or permission to copy values.
// Provider/polymorphic references deliberately do not invent a database FK.
const scalarReferenceFields: Record<string, readonly string[]> = {
  FinanceClient: ["createdByUserId"],
  FinanceConsultant: ["createdByUserId"],
  FinanceProject: ["createdByUserId"],
  FinanceTimeEntry: ["createdByUserId", "approvedByUserId"],
  FinanceExpense: ["createdByUserId", "approvedByUserId"],
  FinanceContributionEntry: ["contributorUserId", "submittedByUserId", "paidByUserId"],
  FinanceReportFact: ["sourceBatchId", "sourceCandidateId", "appliedByUserId"],
  FinanceImportBatch: ["uploadedByUserId", "currencyConfirmedByUserId", "approvedByUserId", "appliedByUserId"],
  FinanceImportCandidate: ["editedByUserId", "approvedByUserId"],
  FinanceImportApplication: ["appliedByUserId"],
  FinanceImportProfile: ["approvedByUserId"],
  WorkspaceModuleGrant: ["principalId", "createdByUserId"],
  WorkspaceModuleAccessRequest: ["requesterUserId", "decidedByUserId"],
  WorkspaceIntegrationBinding: ["externalWorkspaceId", "externalOrgId", "appId", "installedByUserId"],
  CommunicationInstallation: ["externalWorkspaceId", "externalOrgId", "appId", "botUserId", "installedByUserId"],
  CommunicationExternalUser: ["externalUserId", "userId", "memberId"],
  CommunicationChannel: ["externalChannelId"],
  CommunicationMessage: ["externalMessageId", "externalChannelId", "externalUserId", "threadExternalId"],
  CommunicationContextSummary: ["externalChannelId", "threadExternalId", "lastMessageExternalId"],
  CommunicationInboundEvent: ["externalEventId"],
  CommunicationEntityLink: ["externalUserId", "entityId"],
  EmailDelivery: ["providerMessageId", "userId", "workspaceId"],
  EmailDeliveryEvent: ["providerMessageId"],
  CheckIn: ["relatedEntityId"],
  Circle: ["archivedByUserId"],
  WorkspaceToolLink: ["archivedByUserId"],
  CatalogItem: ["sourceId", "archivedByUserId"],
  AppRuntime: ["railwayProjectId", "railwayEnvironmentId", "railwayServiceId", "secretsRef"],
  AppInstallation: ["tenantExternalId", "installedByUserId"],
  AppSurfaceAssignment: ["assignedByUserId"],
  AppSession: ["actorUserId"],
  Role: ["archivedByUserId"],
  RoleVersion: ["circleId"],
  RoleHolderHistory: ["assignmentId"],
  Action: ["archivedByUserId"],
  Tension: ["archivedByUserId"],
  Proposal: ["archivedByUserId"],
  DeliberationEntry: ["parentId"],
  ApprovalFlow: ["subjectId", "createdByUserId"],
  MeetingSeries: ["externalId"],
  Meeting: ["externalId", "calendarExternalId", "agendaChannelId", "archivedByUserId"],
  WorkspaceRecorderCalendarSource: ["providerAccountId", "lastSyncJobId"],
  MeetingRecording: ["externalBotId"],
  MeetingAudioAsset: ["intakeMeetingId"],
  MeetingRecorderProviderEvent: ["externalEventId", "externalBotId"],
  Document: ["archivedByUserId"],
  WorkItemEvidence: ["entityId"],
  WorkspaceExternalResource: ["externalId", "archivedByUserId"],
  WorkspaceExternalResourceAttachment: ["entityId"],
  WorkspaceExternalResourceMention: ["sourceId", "sourceExternalId"],
  ExternalContentSource: ["externalId", "archivedByUserId"],
  ExternalContentSyncLog: ["workflowJobId", "brainSourceId"],
  Constitution: ["triggerRef"],
  ConstitutionSourceReference: ["policyCorpusId", "proposalId", "tensionId"],
  AuditLog: ["actorUserId", "entityId"],
  WorkItemVersion: ["entityId"],
  MeetingTranscriptSourceRecord: ["externalId", "externalRevisionId"],
  MeetingTranscriptProcessingProgress: ["currentWorkflowJobId"],
  WorkspaceArchiveRecord: ["entityId", "archivedByUserId", "restoredByUserId", "purgedByUserId"],
  WorkspacePermalink: ["entityId", "createdByUserId"],
  Event: ["aggregateId"],
  NewspaperDelivery: ["providerMessageId"],
  KnowledgeChunk: ["sourceId"],
  ContextGraphObject: ["createdByUserId", "createdByAgentRunId", "sourceEntityId", "supersededByObjectId"],
  ContextGraphRelationship: ["createdByUserId", "createdByAgentRunId", "sourceEntityId", "supersededByRelationshipId"],
  ContextGraphEvidenceRef: ["sourceId", "knowledgeChunkId"],
  ContextMapView: ["createdByUserId"],
  ContextGraphProposedDiff: ["proposedByUserId", "proposedByAgentRunId", "reviewedByUserId"],
  AgentRun: ["triggerRef"],
  Notification: ["entityId"],
  NotificationDelivery: ["providerMessageId"],
  ConversationPendingOperation: ["conversationId", "userId", "relatedEntityId"],
  BrainArticle: ["archivedByUserId"],
  BrainArticleVersion: ["agentRunId"],
  BrainSource: ["externalId", "archivedByUserId"],
  BrainDiscussionThread: ["targetRef"],
  BrainDiscussionComment: ["agentRunId"],
  WebhookEndpoint: ["archivedByUserId"],
  WebhookDelivery: ["eventId"],
  InboundWebhook: ["externalId"],
  OAuthConnection: ["providerAccountId"],
  ExpertiseTag: ["archivedByUserId"],
  AdviceProcess: ["subjectId"],
  DemoLead: ["convertedContactId"],
  CrmAccount: ["ownerUserId", "archivedByUserId"],
  CrmContact: ["archivedByUserId"],
  CrmDeal: ["ownerUserId", "archivedByUserId"],
  CrmDealStageTransition: ["actorUserId"],
  CrmActivity: ["actorUserId", "ownerUserId", "completedByUserId", "sourceExternalId", "archivedByUserId"],
  CrmCommunicationSuggestion: ["actorUserId", "ownerUserId", "externalRequestId"],
  WorkspaceAgentConfig: ["archivedByUserId"],
  WorkspaceSsoConfig: ["clientId"],
  UserSsoIdentity: ["providerSubjectId"],
  WorkspaceBillingProfile: ["stripeCustomerId", "stripeSubscriptionId", "stripeSubscriptionItemId", "stripePriceId", "stripeCheckoutSessionId"],
  AiUsageLedgerEntry: ["stripeUsageRecordId", "stripeInvoiceId"],
  OAuthApp: ["clientId", "archivedByUserId"],
  OAuthAuthorizationCode: ["userId", "workspaceId"],
  OAuthAccessToken: ["appId", "userId", "workspaceId"],
  McpOAuthClient: ["clientId"],
  ExternalMcpConnection: ["providerAccountId"],
  ExecutionRequest: ["writebackTargetId"],
  ExecutionResult: ["targetId", "writebackEntityId"],
  ExternalDataSource: ["archivedByUserId"],
  MeetingFollowUpReview: ["channelId"],
  MeetingInsight: ["appliedEntityId", "targetEntityId", "supersededByInsightId"],
  Goal: ["archivedByUserId"],
  GoalLink: ["entityId"],
  AgentIdentity: ["archivedByUserId"],
  CrmConversation: ["sourceExternalId"],
  TenantPurgeRun: ["targetAccountId", "targetDeploymentId", "targetWorkspaceId", "targetTrialId", "manifestEvidenceRef", "backupEvidenceRef", "restoreEvidenceRef", "executionEvidenceRef", "terminalEvidenceRef", "requestedByUserId", "approvedByUserId"],
  CustomerDeployment: ["remoteWorkspaceId", "releaseLeaseId", "railwayProjectId", "railwayEnvironmentId", "railwayWebServiceId", "railwayWorkerServiceId", "railwayPostgresServiceId", "railwayRedisServiceId", "providerSubscriptionId", "providerProjectId", "providerEnvironmentId", "providerWebServiceId", "providerWorkerServiceId", "providerPostgresServiceId", "providerRedisServiceId", "providerStorageResourceId"],
  CustomerEntitlement: ["configuredByUserId"],
  CustomerReleaseTarget: ["preparedByUserId"],
  CustomerDeploymentEvent: ["actorUserId"],
  ClientMigrationRun: ["actorUserId"],
  ClientMigrationIdMap: ["sourceId", "destinationId"],
  SupportOperation: ["workspaceId"],
  SelfServeEmailCapture: ["workspaceId", "procurementTrialId", "runId"],
  SelfServeSmokeRun: ["deploymentId", "workspaceId", "procurementTrialId", "runId", "triggeredByUserId"],
  SelfServeSupportSession: ["deploymentId", "workspaceId", "operationId", "supportUserId", "supportMemberId", "targetMemberId"],
  ProcurementIdempotencyKey: ["workspaceId", "setupSessionId"],
  ProviderCutover: ["recordedByUserId"],
};
const scalarSecretFields: Record<string, readonly string[]> = {
  DemoLead: ["qualifyToken"],
  CommunicationInstallation: ["botTokenEnc"],
  User: ["passwordHash"],
  Session: ["tokenHash"],
  PasswordResetToken: ["tokenHash"],
  WorkspaceToolLink: ["credentialSecretEnc"],
  AppSession: ["tokenHash"],
  BuildArtifact: ["publicTokenHash", "publicTokenEnc"],
  WorkspaceRecorderCalendarSource: ["accessTokenEnc", "refreshTokenEnc"],
  MeetingTranscriptSourceConnection: ["accessTokenEnc", "refreshTokenEnc", "apiKeyEnc", "webhookSecretEnc"],
  NewspaperTrackedLink: ["tokenHash"],
  AgentCredential: ["tokenHash"],
  WebhookEndpoint: ["secret"],
  OAuthConnection: ["accessToken", "refreshToken"],
  WorkspaceSsoConfig: ["clientSecretEnc"],
  OAuthApp: ["clientSecret"],
  OAuthAuthorizationCode: ["code"],
  OAuthAccessToken: ["tokenHash", "refreshHash"],
  McpOAuthClient: ["clientSecret"],
  McpOAuthAuthorizationCode: ["code"],
  McpOAuthAccessToken: ["tokenHash", "refreshHash"],
  ExternalMcpConnection: ["accessTokenEnc", "refreshTokenEnc"],
  AiWorkspaceConnection: ["accessTokenEnc", "refreshTokenEnc", "apiKeyEnc"],
  ExternalDataSource: ["connectionStringEnc"],
  CustomerDeployment: ["releaseLeaseTokenHash", "supportCredentialEnc"],
  SelfServeEmailCapture: ["setupUrlEnc"],
  SelfServeSupportSession: ["tokenHash"],
  CustomerDeploymentBootstrapRun: ["bootstrapTokenHash"],
  ProcurementSetupSession: ["tokenHash"],
  ProcurementTrial: ["connectorTokenEnc"],
};
const scalarObjectFields: Record<string, readonly string[]> = {
  BuildArtifactAsset: ["storageKey"],
  MeetingAudioAsset: ["storageKey"],
  Document: ["storageKey"],
  BrainSource: ["fileStorageKey"],
};

export const transferScalarFieldKinds: Readonly<Record<string, Readonly<Record<string, "reference" | "secret" | "object">>>> = Object.fromEntries(
  [...new Set([...Object.keys(scalarReferenceFields), ...Object.keys(scalarSecretFields), ...Object.keys(scalarObjectFields)])].map((table) => [table, Object.fromEntries(
    ([ [scalarReferenceFields, "reference"], [scalarSecretFields, "secret"], [scalarObjectFields, "object"] ] as const)
      .flatMap(([fields, kind]) => (fields[table] ?? []).map((column) => [column, kind])),
  )]),
);

const policyKinds = new Set(["content", "reference", "secret", "object", "effect"]);
const sha256Pattern = /^[a-f0-9]{64}$/;
export function isRetainedInlineValue(table: string, column: string, value: string, policy: TransferTablePolicy | undefined): boolean {
  const field = policy?.fields?.[column];
  if (field?.kind !== "object" || !((table === "Document" && column === "storageKey") || (table === "BrainSource" && column === "fileStorageKey"))) return false;
  const digest = createHash("sha256").update(value, "utf8").digest("hex");
  return field.retainedInlineValues?.some((entry) => entry.valueSha256 === digest) ?? false;
}

/** All checks concern column metadata and explicit policies; values never enter errors. */
export function assertTransferTableFieldPolicies(table: Pick<TransferTableData, "name" | "columns" | "rows">, policy: TransferTablePolicy | undefined) {
  for (const [name, field] of Object.entries(policy?.fields ?? {})) {
    if (!field || !policyKinds.has(field.kind) || typeof field.reason !== "string" || !field.reason.trim()) {
      throw new Error(`TRANSFER_FIELD_POLICY_REQUIRED:${table.name}.${name}`);
    }
    if (field.retainedInlineValues !== undefined) {
      if (field.kind !== "object" || !((table.name === "Document" && name === "storageKey") || (table.name === "BrainSource" && name === "fileStorageKey"))
        || !Array.isArray(field.retainedInlineValues) || !field.retainedInlineValues.length) throw new Error("TRANSFER_INLINE_OBJECT_EXCEPTION_INVALID");
      const seen = new Set<string>();
      for (const entry of field.retainedInlineValues) {
        if (!entry || !sha256Pattern.test(entry.valueSha256) || !sha256Pattern.test(entry.evidenceSha256) || typeof entry.reason !== "string" || !entry.reason.trim() || seen.has(entry.valueSha256)) {
          throw new Error("TRANSFER_INLINE_OBJECT_EXCEPTION_INVALID");
        }
        seen.add(entry.valueSha256);
      }
      const locatorIndex = table.columns.findIndex((column) => column.name === name);
      const contentIndex = table.columns.findIndex((column) => column.name === (table.name === "Document" ? "textContent" : "content"));
      for (const row of table.rows) {
        const value = row[locatorIndex];
        if (typeof value === "string" && isRetainedInlineValue(table.name, name, value, policy)
          && (contentIndex < 0 || !row[contentIndex]?.trim())) throw new Error("TRANSFER_INLINE_CONTENT_REQUIRED");
      }
    }
  }
  for (const [index, column] of table.columns.entries()) {
    if (!table.rows.some((row) => row[index] !== null)) continue;
    const required = transferScalarFieldKinds[table.name]?.[column.name];
    const field = policy?.fields?.[column.name];
    if (required && field?.kind !== required) throw new Error(`TRANSFER_SCALAR_FIELD_POLICY_REQUIRED:${table.name}.${column.name}:${required}`);
    if ((/^jsonb?$/.test(column.type) || column.type.endsWith("[]")) && !field) {
      throw new Error(`TRANSFER_STRUCTURED_FIELD_POLICY_REQUIRED:${table.name}.${column.name}`);
    }
  }
}

export function assertNoSourceImportMarker(tables: readonly TransferTableData[]) {
  const table = tables.find((entry) => entry.name === "WorkspaceFeatureFlag");
  if (!table) return;
  const position = table.columns.findIndex((column) => column.name === "flag");
  if (position >= 0 && table.rows.some((row) => row[position] === "operator_import_inactive")) {
    throw new Error("TRANSFER_SOURCE_IMPORT_MARKER_MUST_BE_STAGED");
  }
}
