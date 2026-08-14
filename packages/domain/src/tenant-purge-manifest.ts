import { createHash, createHmac } from "node:crypto";
import { Prisma } from "@prisma/client"; import { AppError } from "./errors";

export const TENANT_PURGE_MODEL_CLASSIFICATION = {
  TARGET: ["Workspace", "CustomerAccount", "CustomerDeployment", "ProcurementTrial"],
  WORKSPACE_CASCADE: [
    "Action", "ActionChecklistItem", "AdviceProcess", "AdviceRequest", "AgentCredential", "AgentIdentity", "AgentMemory", "AgentRun",
    "AiUsageLedgerEntry", "AiWorkspaceConnection", "AppInstallation", "AppSession", "AppSurfaceAssignment", "ApprovalFlow", "ApprovalPolicy", "AuditLog",
    "BrainArticle", "BrainBacklink", "BrainSource", "BuildArtifact", "CatalogFavorite", "CatalogItem", "CatalogRequest", "CatalogSettings", "CheckIn",
    "Circle", "CommunicationChannel", "CommunicationContextSummary", "CommunicationEntityLink", "CommunicationExternalUser", "CommunicationInstallation", "ConstitutionSourceReference", "CrmProspectWorkspace",
    "CommunicationMessage", "Constitution", "ContextGraphEvidenceRef", "ContextGraphObject", "ContextGraphProposedDiff", "ContextGraphRelationship",
    "ContextMapView", "ConversationPendingOperation", "ConversationSession", "CrmAccount", "CrmActivity", "CrmCommunicationSuggestion", "CrmContact",
    "CrmConversation", "CrmDeal", "CrmDealStageTransition", "CrmQualification", "DeliberationEntry", "DemoLead", "Document", "ExecutionRequest",
    "ExecutionResult", "ExpertiseTag", "ExternalContentSource", "ExternalContentSyncLog", "ExternalDataSource", "ExternalMcpConnection", "FinanceClient",
    "FinanceConsultant", "FinanceContributionEntry", "FinanceExpense", "FinanceImportApplication", "FinanceImportBatch", "FinanceImportProfile", "FinanceProject",
    "FinanceReport", "FinanceTimeEntry", "Goal", "GovernanceScore", "ImpactFootprint", "InboundWebhook", "KnowledgeChunk", "McpOAuthAccessToken",
    "McpOAuthAuthorizationCode", "Meeting", "MeetingAudioAsset", "MeetingFollowUpReview", "MeetingInsight", "MeetingRecorderSmokeRun", "MeetingRecording",
    "MeetingSeries", "MeetingTranscriptImportBatch", "MeetingTranscriptProcessingProgress", "MeetingTranscriptSourceConnection", "MeetingTranscriptSourceRecord",
    "Member", "MemberEmailAlias", "MemberInviteRequest", "ModelUsage", "ModelUsageBudget", "NewspaperDelivery", "NewspaperEdition", "NewspaperTrackedLink",
    "Notification", "NotificationDelivery", "OAuthApp", "OAuthConnection", "PolicyCorpus", "ProcurementBillingHandoff", "ProcurementSetupSession",
    "ProductAnalyticsEvent", "Proposal", "Recognition", "RoleHolderHistory", "RoleOnboardingSession", "RoleVersion", "Tension", "UserWorkspaceOnboardingState",
    "WebhookEndpoint", "WorkItemEvidence", "WorkItemVersion", "WorkspaceAgentConfig", "WorkspaceArchiveRecord", "WorkspaceBillingProfile", "WorkspaceBriefing",
    "WorkspaceEnterpriseService", "WorkspaceExternalResource", "WorkspaceExternalResourceAttachment", "WorkspaceExternalResourceMention", "WorkspaceFeatureFlag",
    "WorkspaceIntegrationBinding", "WorkspaceMeetingRecorderConfig", "WorkspaceModuleAccessRequest", "WorkspaceModuleGrant", "WorkspacePermalink",
    "WorkspaceRecorderCalendarSource", "WorkspaceSsoConfig", "WorkspaceToolLink",
  ],
  WORKSPACE_SET_NULL: ["CommunicationInboundEvent", "Event", "MeetingRecorderProviderEvent", "WorkflowJob"],
  WORKSPACE_UNCONSTRAINED: [
    "EmailDelivery", "FinanceImportCandidate", "FinanceReportFact", "OAuthAccessToken", "OAuthAuthorizationCode",
    "ProcurementIdempotencyKey", "SelfServeEmailCapture", "SelfServeSmokeRun", "SelfServeSupportSession",
  ],
  INDIRECT_CASCADE: [
    "AdviceRequestRecipient", "AgentStep", "AgentToolCall", "ApprovalDecision", "BrainArticleVersion", "BrainDiscussionComment", "BrainDiscussionThread",
    "BuildArtifactAsset", "CircleAgentAssignment", "ContextMapLayoutItem", "ConversationTurn", "CrmConversationMessage",
    "ExternalDataSyncLog", "GoalLink", "GoalUpdate", "KeyResult", "MemberExpertise", "Objection", "Role", "RoleAssignment", "TensionUpvote",
    "WebhookDelivery", "WorkspaceToolLinkCircleTag",
  ],
  CONTROL_PLANE_LINKED: [
    "AppRuntime", "AppRelease", "ClientMigrationRun", "ClientMigrationIdMap", "CustomerDeploymentAccess", "CustomerDeploymentEvent",
    "CustomerEntitlement", "CustomerReleaseTarget", "FleetHealthSnapshot", "ProviderCutover", "SupportOperation",
  ],
  RETAINED_LEDGER: ["TenantPurgeRun"],
  SHARED_OR_UNSCOPED: [
    "AppDefinition", "CustomerDeploymentBootstrapRun", "EmailDeliveryEvent", "McpOAuthClient", "NotificationPreference", "PasswordResetToken", "Session",
    "StripeWebhookEvent", "User", "UserSsoIdentity",
  ],
} as const satisfies Record<string, readonly Prisma.ModelName[]>;

export const TENANT_PURGE_SPECIAL_SCOPE_SELECTORS = { AppRelease: ["runtime.customerDeploymentId"], AppRuntime: ["customerDeploymentId"], ClientMigrationIdMap: ["migrationRun.customerAccountId", "migrationRun.sourceDeploymentId", "migrationRun.destinationDeploymentId"], ClientMigrationRun: ["customerAccountId", "sourceDeploymentId", "destinationDeploymentId"], CrmProspectWorkspace: ["crmWorkspaceId", "targetWorkspaceId"], CustomerDeploymentAccess: ["deploymentId"], CustomerDeploymentEvent: ["deploymentId"], CustomerEntitlement: ["customerAccountId", "deploymentId"], CustomerReleaseTarget: ["customerAccountId", "deploymentId"], FleetHealthSnapshot: ["customerAccountId", "deploymentId"], MeetingRecorderSmokeRun: ["workspaceId", "deploymentId"], ProcurementIdempotencyKey: ["workspaceId", "setupSessionId->ProcurementSetupSession.workspaceId"], ProviderCutover: ["customerAccountId", "sourceDeploymentId", "destinationDeploymentId"], SelfServeEmailCapture: ["workspaceId", "procurementTrialId"], SelfServeSmokeRun: ["workspaceId", "deploymentId", "procurementTrialId"], SelfServeSupportSession: ["workspaceId", "deploymentId"], SupportOperation: ["workspaceId", "deploymentId"] } as const satisfies Partial<Record<Prisma.ModelName, readonly string[]>>; export type TenantPurgeModelClass = keyof typeof TENANT_PURGE_MODEL_CLASSIFICATION;
export type TenantPurgeTarget =
  | { mode: "ACCOUNT_WORKSPACE"; accountId: string; deploymentId: string; workspaceId: string }
  | { mode: "SELF_SERVE_TRIAL_WORKSPACE"; trialId: string; deploymentId: string; workspaceId: string };

export const TENANT_PURGE_BLOCKER_CODES = [
  "TARGET_TUPLE_MISMATCH", "LINKED_ACCOUNT", "LINKED_DEPLOYMENT", "LINKED_TRIAL", "SIBLING_DEPLOYMENT", "PRIMARY_ROUTING",
  "TRIAL_NOT_EXPIRED",
  "SHARED_RESOURCE_AMBIGUITY", "ACTIVE_WRITE", "ACTIVE_JOB", "ACTIVE_SESSION", "ACTIVE_INTEGRATION", "ACTIVE_CREDENTIAL",
  "STORAGE_REFERENCE_AMBIGUITY", "SEARCH_REFERENCE_AMBIGUITY", "CACHE_TTL_POLICY_MISSING", "CACHE_TTL_EXCEEDS_POLICY",
  "CACHE_TTL_UNBOUNDED", "LEGAL_HOLD", "RETENTION_HOLD", "MANAGED_RELEASE_LEASE", "PROVIDER_CUTOVER", "CLIENT_MIGRATION",
] as const;
export type TenantPurgeBlockerCode = typeof TENANT_PURGE_BLOCKER_CODES[number];
export type TenantPurgeLocatorKind = "ROW" | "STORAGE_KEY" | "AZURE_SEARCH_ID" | "CACHE_KEY" | "RATE_LIMIT_KEY" | "PROVIDER_RESOURCE";

export interface TenantPurgeTopology {
  capturedAt: Date;
  workspace: { id: string; managedDeploymentIds: string[]; trialIds: string[] } | null;
  deployment: {
    id: string; managedWorkspaceId: string | null; accountId: string | null; primaryAccountIds: string[];
    providerResourceLocators: string[]; sharedResourceAmbiguous: boolean; hasManagedReleaseLease: boolean;
  } | null;
  account: { id: string; deploymentIds: string[]; primaryDeploymentId: string | null } | null;
  trial: { id: string; workspaceId: string | null; status: string } | null;
}

export interface TenantPurgeEvidenceItem {
  recordId: string;
  locators?: ReadonlyArray<{ kind: TenantPurgeLocatorKind; value: string; ttlSeconds?: number | null }>;
  blockers?: readonly TenantPurgeBlockerCode[];
}

export interface TenantPurgeEvidencePage {
  model: Prisma.ModelName;
  items: readonly TenantPurgeEvidenceItem[];
  nextCursor: string | null;
}

export interface TenantPurgeReadAdapter {
  isTargetAuthorized(target: TenantPurgeTarget): Promise<boolean>; readConsistencyToken(target: TenantPurgeTarget): Promise<string>;
  readTopology(target: TenantPurgeTarget): Promise<TenantPurgeTopology>;
  readModelPage(input: {
    target: TenantPurgeTarget; model: Prisma.ModelName; classification: TenantPurgeModelClass; cursor: string | null; pageSize: number;
  }): Promise<TenantPurgeEvidencePage>;
}

export interface TenantPurgeManifest {
  schemaVersion: 1;
  capabilitySha: string;
  capturedAt: string;
  target: { mode: TenantPurgeTarget["mode"]; targetKeyDigest: string };
  topology: { providerResourceDigests: string[] };
  models: Array<{ model: Prisma.ModelName; classification: TenantPurgeModelClass; count: number; locatorDigests: string[] }>;
  cache: { keyCount: number; maxObservedTtlSeconds: number | null; policyMaxTtlSeconds: number | null };
  blockers: TenantPurgeBlockerCode[];
  digest: string;
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function pseudonym(redactionKey: Uint8Array, value: string) {
  return createHmac("sha256", redactionKey).update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
function deepFreeze<T>(value: T): T { if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); Object.values(value).forEach(deepFreeze); } return value; }

function classificationMap() {
  const result = new Map<Prisma.ModelName, TenantPurgeModelClass>();
  for (const [classification, models] of Object.entries(TENANT_PURGE_MODEL_CLASSIFICATION) as Array<[TenantPurgeModelClass, readonly Prisma.ModelName[]]>) {
    for (const model of models) {
      if (result.has(model)) throw new Error(`Duplicate tenant purge model classification: ${model}`);
      result.set(model, classification);
    }
  }
  return result;
}

export function assertTenantPurgeModelCoverage(modelNames: readonly Prisma.ModelName[] = Object.values(Prisma.ModelName)) {
  const classified = classificationMap();
  const missing = modelNames.filter((model) => !classified.has(model));
  const removed = [...classified.keys()].filter((model) => !modelNames.includes(model));
  const missingScope = TENANT_PURGE_MODEL_CLASSIFICATION.CONTROL_PLANE_LINKED.filter((model) => !Object.hasOwn(TENANT_PURGE_SPECIAL_SCOPE_SELECTORS, model)); if (missing.length || removed.length || missingScope.length) throw new Error(`Tenant purge model classification drift: missing=${missing.join(",")} removed=${removed.join(",")} scope=${missingScope.join(",")}`);
}

function addTopologyBlockers(target: TenantPurgeTarget, topology: TenantPurgeTopology, blockers: Set<TenantPurgeBlockerCode>) {
  const { workspace, deployment } = topology;
  if (!workspace || !deployment || workspace.id !== target.workspaceId || deployment.id !== target.deploymentId
    || deployment.managedWorkspaceId !== target.workspaceId || !workspace.managedDeploymentIds.includes(target.deploymentId)) {
    blockers.add("TARGET_TUPLE_MISMATCH");
  }
  if (workspace && workspace.managedDeploymentIds.some((id) => id !== target.deploymentId)) {
    blockers.add("LINKED_DEPLOYMENT"); blockers.add("SIBLING_DEPLOYMENT");
  }
  if (deployment?.primaryAccountIds.length || topology.account?.primaryDeploymentId) blockers.add("PRIMARY_ROUTING"); if (topology.account?.primaryDeploymentId && topology.account.primaryDeploymentId !== target.deploymentId) { blockers.add("LINKED_DEPLOYMENT"); blockers.add("SIBLING_DEPLOYMENT"); }
  if (deployment?.sharedResourceAmbiguous || deployment?.providerResourceLocators.some((value) => !value.trim())) blockers.add("SHARED_RESOURCE_AMBIGUITY");
  if (deployment?.hasManagedReleaseLease) blockers.add("MANAGED_RELEASE_LEASE");
  if (target.mode === "ACCOUNT_WORKSPACE") {
    if (!topology.account || topology.account.id !== target.accountId || deployment?.accountId !== target.accountId
      || !topology.account.deploymentIds.includes(target.deploymentId)) blockers.add("TARGET_TUPLE_MISMATCH");
    if (topology.account?.deploymentIds.some((id) => id !== target.deploymentId)) {
      blockers.add("LINKED_DEPLOYMENT"); blockers.add("SIBLING_DEPLOYMENT");
    }
    if (workspace?.trialIds.length || topology.trial) blockers.add("LINKED_TRIAL");
  } else {
    if (!topology.trial || topology.trial.id !== target.trialId || topology.trial.workspaceId !== target.workspaceId
      || !workspace?.trialIds.includes(target.trialId)) blockers.add("TARGET_TUPLE_MISMATCH");
    if (topology.trial?.status !== "EXPIRED") blockers.add("TRIAL_NOT_EXPIRED");
    if (workspace?.trialIds.some((id) => id !== target.trialId)) blockers.add("LINKED_TRIAL");
    if (deployment?.accountId || deployment?.primaryAccountIds.length || topology.account) blockers.add("LINKED_ACCOUNT");
  }
}

export async function buildTenantPurgeManifest(input: {
  target: TenantPurgeTarget; capabilitySha: string; redactionKey: Uint8Array; reader: TenantPurgeReadAdapter; pageSize?: number;
  maxPagesPerModel?: number; cachePolicyMaxTtlSeconds?: number | null;
}): Promise<TenantPurgeManifest> {
  const target = Object.freeze({ ...input.target }) as TenantPurgeTarget; const capabilitySha = input.capabilitySha; const redactionKey = Uint8Array.from(input.redactionKey); const sourceReader = input.reader; const reader = Object.freeze({ isTargetAuthorized: sourceReader.isTargetAuthorized.bind(sourceReader), readConsistencyToken: sourceReader.readConsistencyToken.bind(sourceReader), readTopology: sourceReader.readTopology.bind(sourceReader), readModelPage: sourceReader.readModelPage.bind(sourceReader) });
  const pageSize = input.pageSize ?? 250; const maxPages = input.maxPagesPerModel ?? 1_000; const policyMax = input.cachePolicyMaxTtlSeconds ?? null; const targetIds = Object.entries(target).filter(([key]) => key !== "mode").map(([, value]) => value); const targetKeys = Object.keys(target).sort().join(",");
  if (!["ACCOUNT_WORKSPACE", "SELF_SERVE_TRIAL_WORKSPACE"].includes(target.mode) || typeof capabilitySha !== "string" || !/^[0-9a-f]{40}$/.test(capabilitySha) || targetKeys !== (target.mode === "ACCOUNT_WORKSPACE" ? "accountId,deploymentId,mode,workspaceId" : "deploymentId,mode,trialId,workspaceId") || targetIds.some((value) => typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value))) {
    throw new Error("Tenant purge target and capability SHA must be exact and non-empty.");
  }
  if (redactionKey.byteLength < 32) throw new Error("Tenant purge redaction key must contain at least 32 bytes.");
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1_000 || !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 1_000) {
    throw new Error("Unsafe tenant purge pagination bounds.");
  }
  if (policyMax != null && (!Number.isFinite(policyMax) || policyMax < 0)) throw new Error("Invalid tenant purge cache TTL policy.");
  assertTenantPurgeModelCoverage();
  if (await reader.isTargetAuthorized(target) !== true) throw new AppError(403, "TENANT_PURGE_TARGET_FORBIDDEN", "Tenant purge target is not authorized.");
  const consistencyToken = await reader.readConsistencyToken(target); if (typeof consistencyToken !== "string" || !consistencyToken.trim()) throw new Error("Invalid tenant purge consistency token."); const rawTopology = await reader.readTopology(target); if ((rawTopology.deployment?.providerResourceLocators.length ?? 0) > 100_000) throw new Error("Tenant purge evidence limit exceeded."); const topology = structuredClone(rawTopology);
  if (Number.isNaN(topology.capturedAt.getTime())) throw new Error("Invalid topology capture time.");
  const blockers = new Set<TenantPurgeBlockerCode>();
  addTopologyBlockers(target, topology, blockers);
  const scope = classificationMap();
  const models: TenantPurgeManifest["models"] = [];
  let cacheKeyCount = 0; let totalEvidenceDigests = topology.deployment?.providerResourceLocators.length ?? 0;
  let maxObservedTtlSeconds: number | null = null;
  for (const model of [...scope.keys()].sort()) {
    const locatorDigests: string[] = [];
    const seenRecordIds = new Set<string>();
    let count = 0;
    let cursor: string | null = null;
    const seenCursors = new Set<string>();
    for (let pageNumber = 0; ; pageNumber += 1) {
      if (pageNumber >= maxPages) throw new Error(`Tenant purge pagination limit exceeded for ${model}.`);
      const page = await reader.readModelPage({ target, model, classification: scope.get(model)!, cursor, pageSize });
      if (page.model !== model || page.items.length > pageSize || (page.nextCursor !== null && (!page.nextCursor.trim() || page.items.length === 0))) throw new Error(`Invalid tenant purge page for ${model}.`);
      for (const item of page.items) {
        if (!item.recordId.trim() || seenRecordIds.has(item.recordId)) throw new Error(`Invalid or duplicate tenant purge record for ${model}.`);
        seenRecordIds.add(item.recordId);
        count += 1;
        if (++totalEvidenceDigests > 100_000) throw new Error("Tenant purge evidence limit exceeded."); locatorDigests.push(pseudonym(redactionKey, `ROW\0${model}\0${item.recordId}`));
        item.blockers?.forEach((blocker) => { if (!TENANT_PURGE_BLOCKER_CODES.includes(blocker)) throw new Error(`Invalid tenant purge blocker for ${model}.`); blockers.add(blocker); });
        for (const locator of item.locators ?? []) {
          if (!locator.value.trim() || !["ROW", "STORAGE_KEY", "AZURE_SEARCH_ID", "CACHE_KEY", "RATE_LIMIT_KEY", "PROVIDER_RESOURCE"].includes(locator.kind)) throw new Error(`Invalid tenant purge locator for ${model}.`);
          if (++totalEvidenceDigests > 100_000) throw new Error("Tenant purge evidence limit exceeded."); locatorDigests.push(pseudonym(redactionKey, `${locator.kind}\0${locator.value}`));
          if (locator.kind === "CACHE_KEY" || locator.kind === "RATE_LIMIT_KEY") {
            cacheKeyCount += 1;
            if (locator.ttlSeconds == null || !Number.isFinite(locator.ttlSeconds) || locator.ttlSeconds < 0) blockers.add("CACHE_TTL_UNBOUNDED");
            else maxObservedTtlSeconds = Math.max(maxObservedTtlSeconds ?? 0, locator.ttlSeconds);
          }
        }
      }
      if (!page.nextCursor) break;
      if (seenCursors.has(page.nextCursor)) throw new Error(`Tenant purge cursor cycle for ${model}.`);
      seenCursors.add(page.nextCursor); cursor = page.nextCursor;
    }
    models.push({ model, classification: scope.get(model)!, count, locatorDigests: locatorDigests.sort() });
  }
  if (await reader.readConsistencyToken(target) !== consistencyToken) throw new Error("Tenant purge evidence changed during manifest capture."); if (cacheKeyCount && policyMax == null) blockers.add("CACHE_TTL_POLICY_MISSING");
  if (maxObservedTtlSeconds != null && policyMax != null && maxObservedTtlSeconds > policyMax) blockers.add("CACHE_TTL_EXCEEDS_POLICY");
  const targetTuple = target.mode === "ACCOUNT_WORKSPACE"
    ? `${target.mode}\0${target.accountId}\0${target.deploymentId}\0${target.workspaceId}`
    : `${target.mode}\0${target.trialId}\0${target.deploymentId}\0${target.workspaceId}`;
  const body = {
    schemaVersion: 1 as const,
    capabilitySha,
    capturedAt: topology.capturedAt.toISOString(),
    target: { mode: target.mode, targetKeyDigest: pseudonym(redactionKey, targetTuple) },
    topology: { providerResourceDigests: (topology.deployment?.providerResourceLocators ?? []).map((value) => pseudonym(redactionKey, `PROVIDER_RESOURCE\0${value}`)).sort() },
    models,
    cache: { keyCount: cacheKeyCount, maxObservedTtlSeconds, policyMaxTtlSeconds: policyMax },
    blockers: [...blockers].sort(),
  };
  return deepFreeze({ ...body, digest: sha256(canonicalJson(body)) });
}
