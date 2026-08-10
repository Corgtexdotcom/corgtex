import { beforeEach, describe, expect, it, vi } from "vitest";

const createActionMock = vi.fn();
const createArticleMock = vi.fn();
const createGoalMock = vi.fn();
const createMeetingMock = vi.fn();
const createProposalMock = vi.fn();
const createTensionMock = vi.fn();
const intakeMeetingTranscriptMock = vi.fn();
const listActionsMock = vi.fn();
const listGoalsMock = vi.fn();
const listProposalsMock = vi.fn();
const listTensionsMock = vi.fn();
const getGoalMock = vi.fn();
const updateActionMock = vi.fn();
const updateGoalMock = vi.fn();
const updateProposalMock = vi.fn();
const updateTensionMock = vi.fn();
const deleteGoalMock = vi.fn();
const listWorkspaceToolLinksMock = vi.fn();
const upsertWorkspaceToolLinkMock = vi.fn();
const archiveWorkspaceToolLinkMock = vi.fn();
const revealWorkspaceToolLinkCredentialMock = vi.fn();
const listInstalledAppsMock = vi.fn();
const getAppRoutingGuidanceMock = vi.fn();
const getAppConnectionInstructionsMock = vi.fn();
const invokeInstalledAppToolMock = vi.fn();
const requestAppInstallMock = vi.fn();
const supportReopenResolvedProposalsMock = vi.fn();
const listAgentCredentialsMock = vi.fn();
const updateAgentCredentialScopesMock = vi.fn();
const revokeAgentCredentialMock = vi.fn();
const listAgentConfigsMock = vi.fn();
const getNewspaperDiagnosticsMock = vi.fn();
const updateAgentConfigMock = vi.fn();
const getModelUsageBudgetMock = vi.fn();
const updateModelUsageBudgetMock = vi.fn();
const executeExternalMcpToolMock = vi.fn();
const fetchConnectedExternalMcpContextMock = vi.fn();
const listExternalMcpConnectionsMock = vi.fn();
const searchConnectedExternalMcpContextMock = vi.fn();
const recordAuditMock = vi.fn();
const searchIndexedKnowledgeMock = vi.fn();
const buildSelectedRegionContextMock = vi.fn();
const createContextGraphProposedDiffMock = vi.fn();
const getContextGraphMapSchemaMock = vi.fn();
const importContextGraphMapMock = vi.fn();
const getContextMapDataMock = vi.fn();
const createExecutionRequestMock = vi.fn();
const getExecutionPacketMock = vi.fn();
const getCompanyContextMock = vi.fn();
const listWritebackTargetsMock = vi.fn();
const submitExecutionResultMock = vi.fn();
const getCrmAccountMock = vi.fn();
const listCrmAccountsMock = vi.fn();
const listContactsMock = vi.fn();
const listDealsMock = vi.fn();
const listCrmActivitiesMock = vi.fn();
const listCommunicationSuggestionsMock = vi.fn();
const createActivityMock = vi.fn();
const completeActivityMock = vi.fn();
const createCommunicationSuggestionMock = vi.fn();
const markCommunicationSuggestionSentMock = vi.fn();
const failCommunicationSuggestionMock = vi.fn();
const createConversationMessageMock = vi.fn();
const getFinanceReadinessMock = vi.fn();
const compareAndSetFinanceConfigMock = vi.fn();
const financeConfigIdentityMock = vi.fn();
const listWorkItemVersionsMock = vi.fn();
const getWorkItemVersionMock = vi.fn();
const upsertRecorderCalendarSourceMock = vi.fn();
const getRecorderCalendarSourceMock = vi.fn();
const enqueueRecorderCalendarSyncMock = vi.fn();
const scanRecorderCalendarSourceMock = vi.fn();
const runMeetingRecorderSmokeMock = vi.fn();
const createMeetingSeriesMock = vi.fn();
const scheduleMeetingRecordingMock = vi.fn();
const cancelMeetingRecordingMock = vi.fn();
const getMeetingRecorderCoverageReadinessMock = vi.fn();
const getMeetingRecorderEnterpriseReadinessMock = vi.fn();
const requireWorkspaceMembershipMock = vi.fn();
const loadAdviceRequestCountSummariesMock = vi.fn();
const listDeliberationEntriesMock = vi.fn();
const postDeliberationEntryMock = vi.fn();
const resolveDeliberationEntryMock = vi.fn();
const getWorkspacePermanentPathForEntityMock = vi.fn();

vi.mock("@corgtex/domain", async () => {
  const { MCP_TOOL_CAPABILITIES } = await import("../../domain/src/mcp-tool-capabilities");
  const { coerceWorkItemPriorityInput, formatWorkItemPriority } = await import("../../domain/src/work-item-priority");
  const {
    normalizeActionWorkItem,
    normalizeProposalWorkItem,
    normalizeTensionWorkItem,
    workItemMemberDisplayName,
  } = await import("../../domain/src/work-item-normalization");

  return {
  AppError: class AppError extends Error {
    status: number;
    code: string;

    constructor(status: number, code: string, message: string) {
      super(message);
      this.status = status;
      this.code = code;
    }
  },
  duplicateGuardErrorPayload: (error: any) => ({
    status: "duplicate_confirmation_required",
    candidate: error.candidate,
    recommendedResolution: error.recommendedResolution,
    allowedResolutions: error.allowedResolutions,
  }),
  isDuplicateGuardMatchError: (error: any) => error?.code === "DUPLICATE_GUARD_MATCH",
  CONTROL_PLANE_WORKSPACE_FEATURE_FLAGS: [
    { flag: "GOALS", label: "Goals", description: "Goals", defaultEnabled: true },
    { flag: "FINANCE", label: "Finance", description: "Finance", defaultEnabled: false },
  ],
  FINANCE_PARENT_FLAG: "FINANCE",
  compareAndSetFinanceConfig: compareAndSetFinanceConfigMock,
  financeConfigIdentity: financeConfigIdentityMock,
  classifyMemberIdentity: vi.fn((member: { kind?: string | null; user?: { email?: string | null; displayName?: string | null } | null }) => {
    if (member.kind === "SYSTEM") return "SYSTEM";
    const email = member.user?.email?.toLowerCase() ?? "";
    const displayName = member.user?.displayName?.toLowerCase() ?? "";
    return email.startsWith("system+") || email.startsWith("support+") || displayName === "corgtex support" ? "SYSTEM" : "HUMAN";
  }),
  coerceWorkItemPriorityInput,
  formatWorkItemPriority,
  normalizeActionWorkItem,
  normalizeProposalWorkItem,
  normalizeTensionWorkItem,
  workItemMemberDisplayName,
  requireWorkspaceMembership: requireWorkspaceMembershipMock,
  loadAdviceRequestCountSummaries: loadAdviceRequestCountSummariesMock,
  listProposals: listProposalsMock,
  createProposal: createProposalMock,
  updateProposal: updateProposalMock,
  supportReopenResolvedProposals: supportReopenResolvedProposalsMock,
  evaluateDelegatedActionPolicy: vi.fn((input: { toolName?: string | null; operation?: "read" | "write" | null; confidence?: number | null; explicitUserIntent?: boolean }) => {
    if ([
	      "reveal_tool_link_credential",
	      "record_support_audit",
	      "set_feature_flag",
	      "support_reopen_resolved_proposals",
      "update_agent_credential_scopes",
      "revoke_agent_credential",
      "update_agent_policy",
      "update_model_budget",
    ].includes(input.toolName ?? "")) {
      return { policyClass: "sensitive", autoRunAllowed: false, requiresSensitiveHandling: true, reason: "test sensitive" };
    }
    if (input.operation === "read") {
      return { policyClass: "read", autoRunAllowed: true, requiresSensitiveHandling: false, reason: "test read" };
    }
    if (input.explicitUserIntent || input.confidence == null || input.confidence >= 0.8) {
      return { policyClass: "normal_write", autoRunAllowed: true, requiresSensitiveHandling: false, reason: "test normal write" };
    }
    return { policyClass: "draft_or_clarify", autoRunAllowed: false, requiresSensitiveHandling: false, reason: "test draft" };
  }),
  executeExternalMcpTool: executeExternalMcpToolMock,
  fetchConnectedExternalMcpContext: fetchConnectedExternalMcpContextMock,
  listActions: listActionsMock,
  createAction: createActionMock,
  createArticle: createArticleMock,
  createMeeting: createMeetingMock,
  updateAction: updateActionMock,
  listTensions: listTensionsMock,
  createTension: createTensionMock,
  updateTension: updateTensionMock,
  listExternalMcpConnections: listExternalMcpConnectionsMock,
  listGoals: listGoalsMock,
  getGoal: getGoalMock,
  createGoal: createGoalMock,
  updateGoal: updateGoalMock,
  deleteGoal: deleteGoalMock,
  listMembers: vi.fn(),
  listMembersEnriched: vi.fn(),
  createMember: vi.fn(),
  updateMember: vi.fn(),
  deactivateMember: vi.fn(),
  resendMemberAccessLink: vi.fn(),
  sendMemberSetupEmail: vi.fn(),
  createDocument: vi.fn(),
  createMeetingSeries: createMeetingSeriesMock,
  scheduleMeetingRecording: scheduleMeetingRecordingMock,
  cancelMeetingRecording: cancelMeetingRecordingMock,
  intakeMeetingTranscript: intakeMeetingTranscriptMock,
  listMeetings: vi.fn(),
  upsertRecorderCalendarSource: upsertRecorderCalendarSourceMock,
  getRecorderCalendarSource: getRecorderCalendarSourceMock,
  enqueueRecorderCalendarSync: enqueueRecorderCalendarSyncMock,
  scanRecorderCalendarSource: scanRecorderCalendarSourceMock,
  runMeetingRecorderSmoke: runMeetingRecorderSmokeMock,
  getMeetingRecorderCoverageReadiness: getMeetingRecorderCoverageReadinessMock,
  getMeetingRecorderEnterpriseReadiness: getMeetingRecorderEnterpriseReadinessMock,
  getCurrentConstitution: vi.fn(),
  listPolicyCorpus: vi.fn(),
  listAgentRuns: vi.fn(),
  listAgentCredentials: listAgentCredentialsMock,
  updateAgentCredentialScopes: updateAgentCredentialScopesMock,
  revokeAgentCredential: revokeAgentCredentialMock,
  listAgentConfigs: listAgentConfigsMock,
  getNewspaperDiagnostics: getNewspaperDiagnosticsMock,
  updateAgentConfig: updateAgentConfigMock,
  getModelUsageBudget: getModelUsageBudgetMock,
  updateModelUsageBudget: updateModelUsageBudgetMock,
  listCommunicationInstallations: vi.fn(),
  listExternalDataSources: vi.fn(),
  enqueueExternalDataSourceSync: vi.fn(),
  listInstalledApps: listInstalledAppsMock,
  getAppRoutingGuidance: getAppRoutingGuidanceMock,
  getAppConnectionInstructions: getAppConnectionInstructionsMock,
  invokeInstalledAppTool: invokeInstalledAppToolMock,
  requestAppInstall: requestAppInstallMock,
  listWorkspaceToolLinks: listWorkspaceToolLinksMock,
  upsertWorkspaceToolLink: upsertWorkspaceToolLinkMock,
  archiveWorkspaceToolLink: archiveWorkspaceToolLinkMock,
  revealWorkspaceToolLinkCredential: revealWorkspaceToolLinkCredentialMock,
  recordAudit: recordAuditMock,
  buildSelectedRegionContext: buildSelectedRegionContextMock,
  createContextGraphProposedDiff: createContextGraphProposedDiffMock,
  getContextGraphMapSchema: getContextGraphMapSchemaMock,
  importContextGraphMap: importContextGraphMapMock,
  getContextMapData: getContextMapDataMock,
  createExecutionRequest: createExecutionRequestMock,
  getExecutionPacket: getExecutionPacketMock,
  getCompanyContext: getCompanyContextMock,
  listWritebackTargets: listWritebackTargetsMock,
  submitExecutionResult: submitExecutionResultMock,
  getCrmAccount: getCrmAccountMock,
  listCrmAccounts: listCrmAccountsMock,
  listContacts: listContactsMock,
  listDeals: listDealsMock,
  listCrmActivities: listCrmActivitiesMock,
  listCommunicationSuggestions: listCommunicationSuggestionsMock,
  createActivity: createActivityMock,
  completeActivity: completeActivityMock,
  createCommunicationSuggestion: createCommunicationSuggestionMock,
  markCommunicationSuggestionSent: markCommunicationSuggestionSentMock,
  failCommunicationSuggestion: failCommunicationSuggestionMock,
  createConversationMessage: createConversationMessageMock,
  getFinanceReadiness: getFinanceReadinessMock,
  listWorkItemVersions: listWorkItemVersionsMock,
  getWorkItemVersion: getWorkItemVersionMock,
  getWorkspacePermanentPathForEntity: getWorkspacePermanentPathForEntityMock,
  listDeliberationEntries: listDeliberationEntriesMock,
  postDeliberationEntry: postDeliberationEntryMock,
  resolveDeliberationEntry: resolveDeliberationEntryMock,
  searchConnectedExternalMcpContext: searchConnectedExternalMcpContextMock,
  listRuntimeJobs: vi.fn(),
  listFailedJobs: vi.fn(),
  replayWorkflowJob: vi.fn(),
  discardFailedJob: vi.fn(),
  MCP_TOOL_CAPABILITIES,
  };
});

vi.mock("@corgtex/knowledge", () => ({
  searchIndexedKnowledge: searchIndexedKnowledgeMock,
}));

vi.mock("@corgtex/agents", () => ({
  processConversationTurn: vi.fn(),
}));

vi.mock("@corgtex/shared", () => ({
  prisma: {
    $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback({})),
    action: {
      findFirst: vi.fn(),
    },
    proposal: {
      findFirst: vi.fn(),
    },
    tension: {
      findFirst: vi.fn(),
    },
    workspace: {
      findUnique: vi.fn(),
    },
    workspaceFeatureFlag: {
      findMany: vi.fn(),
      upsert: vi.fn(),
    },
    deliberationEntry: {
      findFirst: vi.fn(),
    },
  },
  env: { APP_URL: "https://app.test" },
  toInputJson: (value: unknown) => value,
}));

vi.mock("./auth", () => ({
  requireScope: vi.fn(),
}));

describe("createCorgtexMcpServer", () => {
  beforeEach(async () => {
    vi.unstubAllEnvs();
    vi.stubEnv("MICROSOFT_CLIENT_ID", "microsoft-client-id");
    vi.stubEnv("MICROSOFT_CLIENT_SECRET", "microsoft-client-secret");
    compareAndSetFinanceConfigMock.mockReset();
    financeConfigIdentityMock.mockReset().mockReturnValue("d".repeat(64));
    createActionMock.mockReset().mockResolvedValue({
      id: "action-1",
      title: "Follow up",
      status: "DRAFT",
      version: 1,
      priority: 2,
      assigneeMemberId: "member-assignee",
    });
    createArticleMock.mockReset().mockResolvedValue({
      id: "article-1",
      slug: "article-1",
      title: "Article",
      type: "GLOSSARY",
    });
    createGoalMock.mockReset().mockResolvedValue({
      id: "goal-1",
      title: "Transform 1,000 businesses",
      status: "ACTIVE",
      cadence: "TEN_YEAR",
      ownerMemberId: "member-owner",
    });
    createProposalMock.mockReset().mockResolvedValue({
      id: "proposal-1",
      title: "Clarify ownership",
      status: "DRAFT",
      version: 1,
      priority: 3,
      ownerMemberId: "member-owner",
    });
    createTensionMock.mockReset().mockResolvedValue({
      id: "tension-1",
      title: "No clear owner",
      status: "DRAFT",
      version: 1,
      priority: 1,
      assigneeMemberId: "member-responsible",
      raisedByMemberId: "member-raiser",
    });
    createMeetingMock.mockReset().mockResolvedValue({
      id: "meeting-1",
      title: "Meeting",
      recordedAt: new Date("2026-07-20T10:00:00.000Z"),
    });
    intakeMeetingTranscriptMock.mockReset().mockResolvedValue({
      status: "meeting_created",
      meeting: {
        id: "meeting-1",
        title: "Meeting",
        recordedAt: new Date("2026-07-20T10:00:00.000Z"),
      },
    });
    listActionsMock.mockReset().mockResolvedValue({ items: [], total: 0 });
    listGoalsMock.mockReset().mockResolvedValue([]);
    listProposalsMock.mockReset().mockResolvedValue({ items: [], total: 0 });
    listTensionsMock.mockReset().mockResolvedValue({ items: [], total: 0 });
    loadAdviceRequestCountSummariesMock.mockReset().mockImplementation(async (_workspaceId: string, _subjectType: string, subjectIds: string[]) => new Map(
      subjectIds.map((subjectId) => [subjectId, {
        adviceRequestCount: 0,
        activeAdviceRequestCount: 0,
        inputRequestCount: 0,
        activeInputRequestCount: 0,
      }]),
    ));
    getGoalMock.mockReset().mockResolvedValue({ id: "goal-1", cadence: "QUARTERLY" });
    updateActionMock.mockReset().mockResolvedValue({
      id: "action-1",
      status: "OPEN",
      version: 2,
      priority: 3,
      assigneeMemberId: "member-assignee",
    });
    updateGoalMock.mockReset().mockResolvedValue({ id: "goal-1", status: "ACTIVE", cadence: "QUARTERLY" });
    updateProposalMock.mockReset().mockResolvedValue({
      id: "proposal-1",
      status: "DRAFT",
      version: 2,
      priority: 2,
      ownerMemberId: "member-owner",
    });
    updateTensionMock.mockReset().mockResolvedValue({
      id: "tension-1",
      status: "OPEN",
      version: 2,
      priority: 2,
      assigneeMemberId: "member-responsible",
    });
    deleteGoalMock.mockReset().mockResolvedValue(undefined);
    listWorkspaceToolLinksMock.mockReset().mockResolvedValue([]);
    listInstalledAppsMock.mockReset().mockResolvedValue({ installed: [], available: [], webUrl: "/workspaces/ws-1/tools?type=APP" });
    getAppRoutingGuidanceMock.mockReset().mockResolvedValue({ routing: "CORGTEX_MCP", guidance: "Use Corgtex." });
    getAppConnectionInstructionsMock.mockReset().mockResolvedValue({
      app: { id: "finance-suite", title: "Finance Suite" },
      instructions: ["Connect Finance Suite MCP."],
      connectionReady: true,
    });
    invokeInstalledAppToolMock.mockReset().mockResolvedValue({
      appKey: "finance-suite",
      appInstallationId: "installation-1",
      toolName: "create_expenses",
      scopes: ["finance:write"],
      result: { persisted: { created: 1 } },
    });
    requestAppInstallMock.mockReset().mockResolvedValue({
      request: { id: "request-1", status: "PENDING" },
      app: { id: "finance-suite", title: "Finance Suite" },
    });
    upsertWorkspaceToolLinkMock.mockReset().mockResolvedValue({
      id: "tool-1",
      title: "Miro board",
      hasCredential: true,
    });
    archiveWorkspaceToolLinkMock.mockReset().mockResolvedValue({ id: "tool-1" });
    revealWorkspaceToolLinkCredentialMock.mockReset().mockResolvedValue({
      credentialLabel: "Board password",
      credentialSecret: "board-pass",
    });
    supportReopenResolvedProposalsMock.mockReset().mockResolvedValue({
      workspaceId: "ws-1",
      reopened: [{ id: "proposal-1", status: "OPEN", flowId: "flow-1", policyCorpusRowsDeleted: 1 }],
    });
    listAgentCredentialsMock.mockReset().mockResolvedValue([]);
    updateAgentCredentialScopesMock.mockReset().mockResolvedValue({ id: "cred-1", label: "Production MCP", scopes: ["workspace:read"], isActive: true });
    revokeAgentCredentialMock.mockReset().mockResolvedValue({ id: "cred-1", label: "Production MCP", scopes: ["workspace:read"], isActive: false });
    listAgentConfigsMock.mockReset().mockResolvedValue([]);
    getNewspaperDiagnosticsMock.mockReset().mockResolvedValue({});
    updateAgentConfigMock.mockReset().mockResolvedValue({
      id: "config-1",
      agentKey: "meeting-summary",
      enabled: true,
      modelOverride: null,
      governancePolicy: null,
      updatedAt: new Date("2026-05-01T00:00:00.000Z"),
    });
    getModelUsageBudgetMock.mockReset().mockResolvedValue(null);
    updateModelUsageBudgetMock.mockReset().mockResolvedValue({ id: "budget-1", monthlyCostCapUsd: "250.00" });
    executeExternalMcpToolMock.mockReset().mockResolvedValue({ skipped: false, result: { ok: true } });
    fetchConnectedExternalMcpContextMock.mockReset().mockResolvedValue({ providerKey: "notion", externalId: "page-1", content: { title: "Launch" } });
    listExternalMcpConnectionsMock.mockReset().mockResolvedValue([]);
    recordAuditMock.mockReset().mockResolvedValue({ id: "audit-1" });
    searchConnectedExternalMcpContextMock.mockReset().mockResolvedValue({ results: [], errors: [] });
    searchIndexedKnowledgeMock.mockReset().mockResolvedValue([]);
    createExecutionRequestMock.mockReset().mockResolvedValue({ id: "request-1", status: "PENDING" });
    getExecutionPacketMock.mockReset().mockResolvedValue({ id: "request-1", goal: "Draft follow-up" });
    getCompanyContextMock.mockReset().mockResolvedValue({ workspace: { id: "ws-1", name: "Acme" } });
    listWritebackTargetsMock.mockReset().mockResolvedValue({ items: [{ type: "ACTION", id: "action-1", title: "Follow up" }] });
    submitExecutionResultMock.mockReset().mockResolvedValue({ id: "result-1", status: "ACCEPTED" });
    getCrmAccountMock.mockReset().mockResolvedValue({
      id: "account-1",
      name: "Acme Buyers",
      contacts: [{ id: "contact-1", accountId: "account-1", email: "buyer@example.test" }],
      deals: [{ id: "deal-1", accountId: "account-1", title: "Pilot" }],
      activities: [{ id: "activity-1", accountId: "account-1", title: "Follow up" }],
    });
    listCrmAccountsMock.mockReset().mockResolvedValue({ items: [{ id: "account-1", name: "Acme Buyers" }], total: 1, take: 10, skip: 0 });
    listContactsMock.mockReset().mockResolvedValue({ items: [{ id: "contact-1", accountId: "account-1", email: "buyer@example.test" }], total: 1, take: 10, skip: 0 });
    listDealsMock.mockReset().mockResolvedValue({ items: [{ id: "deal-1", accountId: "account-1", title: "Pilot" }], total: 1, take: 10, skip: 0 });
    listCrmActivitiesMock.mockReset().mockResolvedValue({ items: [{ id: "activity-1", accountId: "account-1", title: "Follow up" }], total: 1, take: 10, skip: 0 });
    listCommunicationSuggestionsMock.mockReset().mockResolvedValue({ items: [{ id: "suggestion-1", accountId: "account-1", title: "Send recap" }], total: 1, take: 10, skip: 0 });
    createActivityMock.mockReset().mockResolvedValue({ id: "activity-1", type: "TASK", accountId: "account-1" });
    completeActivityMock.mockReset().mockResolvedValue({ id: "activity-1", type: "TASK", accountId: "account-1", completedAt: new Date("2026-06-05T09:00:00.000Z") });
    createCommunicationSuggestionMock.mockReset().mockResolvedValue({ id: "suggestion-2", status: "SUGGESTED", accountId: "account-1" });
    markCommunicationSuggestionSentMock.mockReset().mockResolvedValue({ id: "suggestion-1", status: "SENT", accountId: "account-1" });
    failCommunicationSuggestionMock.mockReset().mockResolvedValue({ id: "suggestion-1", status: "FAILED", accountId: "account-1" });
    createConversationMessageMock.mockReset().mockResolvedValue({ id: "message-1" });
    getFinanceReadinessMock.mockReset().mockResolvedValue({
      workspaceId: "ws-1",
      flags: [{ key: "overview", label: "Overview", enabled: true, source: "default", updatedAt: null }],
      access: { canRead: true, canWrite: true, reason: "finance_role", financeAllMemberWrite: true },
      counts: {
        projects: 1,
        clients: 1,
        consultants: 1,
        timeEntries: 0,
        expenses: 0,
        contributionEntries: 1,
        requestedPayables: 1,
      },
      latestFinanceUpdateAt: "2026-07-28T00:00:00.000Z",
      paymentSafety: {
        cashOnlyConfirmation: true,
        peerReviewRequired: true,
        staleConflictProtection: true,
      },
      retiredPracticeLedger: {
        retired: true,
        activeCatalogItems: 0,
        activeDefinitions: 0,
        activeInstallations: 0,
      },
    });
    listWorkItemVersionsMock.mockReset().mockResolvedValue({
      entityType: "Tension",
      entityId: "tension-1",
      currentVersion: 3,
      versions: [{ id: "v-2", version: 2, changedFields: ["title"] }],
    });
    getWorkItemVersionMock.mockReset().mockResolvedValue({
      entityType: "Tension",
      entityId: "tension-1",
      currentVersion: 3,
      version: { id: "v-2", version: 2, previousState: { title: "Old" } },
    });
    getWorkspacePermanentPathForEntityMock.mockReset().mockResolvedValue(null);
    listDeliberationEntriesMock.mockReset().mockResolvedValue([]);
    postDeliberationEntryMock.mockReset().mockResolvedValue({
      id: "entry-1",
      workspaceId: "ws-1",
      parentType: "PROPOSAL",
      parentId: "proposal-1",
      parentVersion: 1,
      entryType: "REACTION",
      bodyMd: "Looks good.",
      resolvedAt: null,
      resolvedNote: null,
      createdAt: new Date("2026-06-01T00:00:00.000Z"),
    });
    resolveDeliberationEntryMock.mockReset().mockResolvedValue({
      id: "entry-1",
      workspaceId: "ws-1",
      parentType: "PROPOSAL",
      parentId: "proposal-1",
      parentVersion: 1,
      entryType: "REACTION",
      bodyMd: "Looks good.",
      resolvedAt: new Date("2026-06-01T01:00:00.000Z"),
      resolvedNote: "Addressed.",
      createdAt: new Date("2026-06-01T00:00:00.000Z"),
    });
    requireWorkspaceMembershipMock.mockReset().mockResolvedValue({
      id: "member-1",
      workspaceId: "ws-1",
      userId: "user-1",
      role: "ADMIN",
      isActive: true,
    });
    const recorderCalendarSource = {
      id: "source-1",
      workspaceId: "ws-1",
      provider: "MICROSOFT",
      providerAccountId: "ms-user-1",
      providerAccountEmail: "recorder@example.com",
      displayName: "Recorder Calendar",
      scopes: ["Calendars.Read"],
      status: "ACTIVE",
      lastSyncAt: new Date("2026-07-20T06:00:00.000Z"),
      lastSyncError: null,
      lastDryRunAt: new Date("2026-07-20T06:05:00.000Z"),
      lastUpcomingEventCount: 3,
      lastSchedulableEventCount: 2,
    };
    upsertRecorderCalendarSourceMock.mockReset().mockResolvedValue(recorderCalendarSource);
    getRecorderCalendarSourceMock.mockReset().mockResolvedValue(recorderCalendarSource);
    enqueueRecorderCalendarSyncMock.mockReset().mockResolvedValue({ id: "job-1" });
    scanRecorderCalendarSourceMock.mockReset().mockResolvedValue({
      source: recorderCalendarSource,
      provider: "MICROSOFT",
      upcomingEventCount: 3,
      schedulableEventCount: 2,
      skippedEventCount: 1,
    });
    runMeetingRecorderSmokeMock.mockReset().mockResolvedValue({
      id: "smoke-1",
      workspaceId: "ws-1",
      deploymentId: null,
      provider: "RECALL_AI",
      status: "SCHEDULED",
      joinAt: new Date("2099-07-20T06:30:00.000Z"),
      liveVendorCall: true,
      meetingId: "meeting-1",
      recordingId: "recording-1",
      meetingUrlHash: "hash-1",
      failureMessage: null,
      completedAt: null,
    });
    createMeetingSeriesMock.mockReset().mockResolvedValue({
      series: {
        id: "series-1",
        meetingUrl: "https://teams.microsoft.com/l/meetup-join/private",
      },
      meetings: [
        { id: "meeting-1", title: "Weekly Tactical", status: "SCHEDULED", recordedAt: new Date("2099-07-20T06:30:00.000Z") },
      ],
    });
    scheduleMeetingRecordingMock.mockReset().mockResolvedValue({
      id: "recording-1",
      provider: "RECALL_AI",
      status: "SCHEDULED",
      failureCode: null,
      externalBotId: "bot-secret",
      joinAt: new Date("2099-07-20T06:30:00.000Z"),
      scheduledAt: new Date("2099-07-20T06:00:00.000Z"),
    });
    cancelMeetingRecordingMock.mockReset().mockResolvedValue({
      id: "recording-1",
      provider: "RECALL_AI",
      status: "CANCELLED",
      endedAt: new Date("2099-07-20T06:10:00.000Z"),
    });
    getMeetingRecorderEnterpriseReadinessMock.mockReset().mockResolvedValue({
      workspaceId: "ws-1",
      ready: true,
      checks: [
        { key: "entitlement", label: "Recorder entitlement", ok: true, detail: "MEETING_RECORDERS is enabled." },
        { key: "recorder_config", label: "Recorder config", ok: true, detail: "RECALL_AI enabled." },
        { key: "public_base_url", label: "Public recorder URL", ok: true, detail: "Configured." },
        { key: "recall_api_key", label: "Recall API key", ok: true, detail: "Configured." },
        { key: "recall_webhook_secret", label: "Recall webhook secret", ok: true, detail: "Configured." },
        { key: "calendar_source", label: "Master Microsoft calendar", ok: true, detail: "recorder@example.com is active." },
        { key: "worker_sync", label: "Recorder calendar sync", ok: true, detail: "No failed recorder calendar sync jobs." },
        { key: "provider_proof", label: "Recorder provider proof", ok: true, detail: "Recent recorder proof at 2026-07-20T06:00:00.000Z." },
      ],
      config: {
        enabled: true,
        defaultProvider: "RECALL_AI",
        fallbackProvider: null,
        providerSettings: { apiKey: "should-not-return" },
      },
      lastSmokeRun: {
        id: "smoke-1",
        status: "COMPLETED",
        createdAt: "2026-07-20T05:00:00.000Z",
        completedAt: "2026-07-20T05:02:00.000Z",
      },
      lastSuccessfulRecording: {
        id: "recording-1",
        provider: "RECALL_AI",
        status: "COMPLETED",
        observedAt: "2026-07-20T06:00:00.000Z",
      },
      lastProviderAuthFailure: {
        id: "failed-recording-1",
        provider: "RECALL_AI",
        status: "FAILED",
        failureCode: "AUTH",
        detail: "Old auth failure.",
        updatedAt: "2026-07-01T00:00:00.000Z",
      },
    });
    getMeetingRecorderCoverageReadinessMock.mockReset().mockResolvedValue({
      workspaceId: "ws-1",
      generatedAt: "2026-07-20T06:00:00.000Z",
      window: {
        from: "2026-07-20T06:00:00.000Z",
        to: "2026-08-19T06:00:00.000Z",
      },
      featureEnabled: true,
      configEnabled: true,
      autoRecordEnabled: false,
      providerConfigOk: true,
      providerChecks: [
        { key: "recall_api_key", label: "Recall API key", ok: true, detail: "Configured." },
      ],
      counts: {
        total: 1,
        eligible: 0,
        blockers: { already_covered: 1 },
      },
      meetings: [{
        meetingId: "meeting-1",
        recordedAt: "2026-07-22T16:00:00.000Z",
        hasOccurrenceUrl: false,
        hasSeriesUrl: false,
        blockerReasons: ["already_covered"],
      }],
    });
    const { prisma } = await import("@corgtex/shared");
    vi.mocked(prisma.action.findFirst).mockReset().mockResolvedValue(null as never);
    vi.mocked(prisma.proposal.findFirst).mockReset().mockResolvedValue(null as never);
    vi.mocked(prisma.tension.findFirst).mockReset().mockResolvedValue(null as never);
    vi.mocked(prisma.workspace.findUnique).mockReset().mockResolvedValue({
      id: "ws-1",
      slug: "acme",
      name: "Acme",
    } as never);
    getContextGraphMapSchemaMock.mockReset().mockReturnValue({
      objectTypes: ["Process", "Agent", "Evidence"],
      relationshipTypes: ["supports", "has_evidence"],
      evidenceRefFormat: { sourceType: "BrainSource", sourceId: "brain-source-id" },
      layoutItemFormat: { objectRef: "process", x: 80, y: 80 },
      defaultMaps: [{ key: "critical-path", name: "Critical path process map" }],
      exampleImportPayloads: [{ name: "Critical path process map", objects: [] }],
      writePath: { auditedImportTool: "import_context_graph_map" },
    });
    importContextGraphMapMock.mockReset().mockResolvedValue({
      mapViewId: "map-1",
      objectCount: 2,
      relationshipCount: 1,
      evidenceCount: 2,
      layoutItemCount: 2,
    });
  });

  it("returns safe current MCP connection details without credential material", async () => {
    const { createCorgtexMcpServer } = await import("./server");
    const { requireScope } = await import("./auth");

    const server = createCorgtexMcpServer({
      actor: {
        kind: "user",
        user: { id: "user-1", email: "user@example.com", displayName: "User One" },
      } as any,
      workspaceId: "ws-1",
      authKind: "oauth",
      scopes: ["workspace:read", "brain:read"],
      resource: "https://app.test/api/mcp",
      providerKey: "cursor",
      clientName: "Cursor",
    });

    const response = await (server as any)._registeredTools.get_current_connection.handler({});
    const payload = JSON.parse(response.content[0].text);

    expect(vi.mocked(requireScope)).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws-1" }), "workspace:read");
    expect(payload).toEqual({
      authKind: "oauth",
      corgtexUser: {
        id: "user-1",
        displayName: "User One",
        email: "user@example.com",
      },
      workspace: {
        id: "ws-1",
        name: "Acme",
        slug: "acme",
      },
      providerKey: "cursor",
      clientName: "Cursor",
      scopes: ["workspace:read", "brain:read"],
      resource: "https://app.test/api/mcp",
    });
    expect(JSON.stringify(payload)).not.toContain("token");
    expect(JSON.stringify(payload)).not.toContain("secret");
  });

  it("returns compact recorder operations readiness without raw recorder secrets", async () => {
    const { createCorgtexMcpServer } = await import("./server");
    const { requireScope } = await import("./auth");

    const server = createCorgtexMcpServer({
      actor: {
        kind: "user",
        user: { id: "user-1", email: "user@example.com", displayName: "User One" },
      } as any,
      workspaceId: "ws-1",
      authKind: "oauth",
      scopes: ["meetings:read"],
      resource: "https://app.test/api/mcp",
      providerKey: "cursor",
      clientName: "Cursor",
    });

    const response = await (server as any)._registeredTools.get_meeting_recorder_operations_readiness.handler({});
    const payload = JSON.parse(response.content[0].text);

    expect(vi.mocked(requireScope)).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws-1" }), "meetings:read");
    expect(payload).toMatchObject({
      workspaceId: "ws-1",
      ready: true,
      configured: true,
      provider: "RECALL_AI",
      fallbackProvider: null,
      checks: expect.arrayContaining([
        expect.objectContaining({ key: "provider_proof", ok: true }),
      ]),
      coverage: {
        counts: {
          total: 1,
          eligible: 0,
          blockers: { already_covered: 1 },
        },
      },
      lastSmokeRun: {
        status: "COMPLETED",
      },
      lastSuccessfulRecording: {
        provider: "RECALL_AI",
        status: "COMPLETED",
      },
      lastProviderAuthFailure: {
        provider: "RECALL_AI",
        status: "FAILED",
        failureCode: "AUTH",
      },
    });
    expect(JSON.stringify(payload)).not.toContain("should-not-return");
    expect(JSON.stringify(payload)).not.toContain("apiKey");
  });

  it("connects a recorder calendar through a support-only MCP tool without returning token material", async () => {
    const { createCorgtexMcpServer } = await import("./server");
    const { requireScope } = await import("./auth");

    const server = createCorgtexMcpServer({
      actor: { kind: "agent", authProvider: "support", credentialId: "cred-1" } as any,
      workspaceId: "ws-1",
      authKind: "agent",
      scopes: ["meetings:write", "support:write"],
    });

    const response = await (server as any)._registeredTools.connect_meeting_recorder_calendar.handler({
      providerAccountId: "ms-user-1",
      providerAccountEmail: "recorder@example.com",
      displayName: "Recorder Calendar",
      accessToken: "access-token-secret",
      refreshToken: "refresh-token-secret",
      expiresIn: 3600,
      scopes: ["offline_access", "Calendars.Read"],
    });
    const payload = JSON.parse(response.content[0].text);

    expect(vi.mocked(requireScope)).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws-1" }), "meetings:write");
    expect(vi.mocked(requireScope)).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws-1" }), "support:write");
    expect(upsertRecorderCalendarSourceMock).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      providerAccountId: "ms-user-1",
      providerAccountEmail: "recorder@example.com",
      displayName: "Recorder Calendar",
      accessToken: "access-token-secret",
      refreshToken: "refresh-token-secret",
      expiresIn: 3600,
      scopes: ["offline_access", "Calendars.Read"],
    });
    expect(enqueueRecorderCalendarSyncMock).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      sourceId: "source-1",
      reason: "support_connector_oauth_connected",
    });
    expect(payload).toMatchObject({
      workspaceId: "ws-1",
      source: {
        id: "source-1",
        provider: "MICROSOFT",
        providerAccountEmail: "recorder@example.com",
        status: "ACTIVE",
      },
      workflowJobId: "job-1",
    });
    expect(JSON.stringify(payload)).not.toContain("access-token-secret");
    expect(JSON.stringify(payload)).not.toContain("refresh-token-secret");
    expect(JSON.stringify(payload)).not.toContain("ms-user-1");
  });

  it("creates internal Corgtex scheduled meetings without sending calendar invites", async () => {
    const { createCorgtexMcpServer } = await import("./server");
    const { requireScope } = await import("./auth");

    const server = createCorgtexMcpServer({
      actor: { kind: "user", user: { id: "user-1", email: "user@example.com" } } as any,
      workspaceId: "ws-1",
      authKind: "oauth",
      scopes: ["meetings:write"],
    });

    const response = await (server as any)._registeredTools.create_scheduled_meeting.handler({
      title: "Weekly Tactical",
      startsAt: "2099-07-20T06:30:00.000Z",
      scheduledEndAt: "2099-07-20T07:00:00.000Z",
      recurrenceRule: "FREQ=WEEKLY;COUNT=1",
      meetingUrl: "https://teams.microsoft.com/l/meetup-join/private",
      participantEmails: [" Member@Example.com "],
    });
    const payload = JSON.parse(response.content[0].text);

    expect(vi.mocked(requireScope)).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws-1" }), "meetings:write");
    expect(createMeetingSeriesMock).toHaveBeenCalledWith(expect.objectContaining({ kind: "user" }), {
      workspaceId: "ws-1",
      title: "Weekly Tactical",
      description: null,
      startsAt: new Date("2099-07-20T06:30:00.000Z"),
      scheduledEndAt: new Date("2099-07-20T07:00:00.000Z"),
      recurrenceRule: "FREQ=WEEKLY;COUNT=1",
      meetingUrl: "https://teams.microsoft.com/l/meetup-join/private",
      participantIds: [],
      participantEmails: [" Member@Example.com "],
    });
    expect(payload).toEqual({
      seriesId: "series-1",
      meetingIds: ["meeting-1"],
      firstMeetingId: "meeting-1",
      createdMeetingCount: 1,
      hasMeetingUrl: true,
      webUrl: "https://app.test/workspaces/ws-1/meetings",
    });
    expect(JSON.stringify(payload)).not.toContain("teams.microsoft.com");
  });

  it("rejects recorder calendar connect before storing tokens when Microsoft refresh config is missing or mismatched", async () => {
    const { createCorgtexMcpServer } = await import("./server");

    const server = createCorgtexMcpServer({
      actor: { kind: "agent", authProvider: "support", credentialId: "cred-1" } as any,
      workspaceId: "ws-1",
      authKind: "agent",
      scopes: ["meetings:write", "support:write"],
    });

    vi.stubEnv("MICROSOFT_CLIENT_SECRET", "");
    await expect((server as any)._registeredTools.connect_meeting_recorder_calendar.handler({
      providerAccountId: "ms-user-1",
      accessToken: "access-token-secret",
      refreshToken: "refresh-token-secret",
      oauthClientId: "microsoft-client-id",
    })).rejects.toMatchObject({
      status: 503,
      code: "MICROSOFT_NOT_CONFIGURED",
    });

    vi.stubEnv("MICROSOFT_CLIENT_SECRET", "microsoft-client-secret");
    vi.stubEnv("MICROSOFT_CLIENT_ID", "remote-client-id");
    await expect((server as any)._registeredTools.connect_meeting_recorder_calendar.handler({
      providerAccountId: "ms-user-1",
      accessToken: "access-token-secret",
      refreshToken: "refresh-token-secret",
      oauthClientId: "control-plane-client-id",
    })).rejects.toMatchObject({
      status: 503,
      code: "MICROSOFT_CLIENT_MISMATCH",
    });
    expect(upsertRecorderCalendarSourceMock).not.toHaveBeenCalled();
    expect(enqueueRecorderCalendarSyncMock).not.toHaveBeenCalled();
  });

  it("runs compact support-only recorder sync, dry-run, and live-smoke operations", async () => {
    const { createCorgtexMcpServer } = await import("./server");

    const server = createCorgtexMcpServer({
      actor: { kind: "agent", authProvider: "support", credentialId: "cred-1" } as any,
      workspaceId: "ws-1",
      authKind: "agent",
      scopes: ["meetings:write", "support:write"],
    });

    const syncResponse = await (server as any)._registeredTools.enqueue_meeting_recorder_calendar_sync.handler({});
    const dryRunResponse = await (server as any)._registeredTools.dry_run_meeting_recorder_calendar_scan.handler({});
    runMeetingRecorderSmokeMock.mockResolvedValueOnce({
      id: "smoke-1",
      workspaceId: "ws-1",
      deploymentId: null,
      provider: "RECALL_AI",
      status: "FAILED",
      joinAt: new Date("2099-07-20T06:30:00.000Z"),
      liveVendorCall: true,
      meetingId: "meeting-1",
      recordingId: "recording-1",
      meetingUrlHash: "hash-1",
      failureMessage: "Provider echoed https://teams.microsoft.com/l/meetup-join/private for external bot bot-remote.",
      completedAt: null,
    });
    const smokeResponse = await (server as any)._registeredTools.run_meeting_recorder_live_smoke.handler({
      meetingUrl: "https://teams.microsoft.com/l/meetup-join/private",
      joinAt: "2099-07-20T06:30:00.000Z",
      provider: "RECALL_AI",
    });
    const syncPayload = JSON.parse(syncResponse.content[0].text);
    const dryRunPayload = JSON.parse(dryRunResponse.content[0].text);
    const smokePayload = JSON.parse(smokeResponse.content[0].text);

    expect(enqueueRecorderCalendarSyncMock).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      sourceId: "source-1",
      reason: "support_connector",
    });
    expect(scanRecorderCalendarSourceMock).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      sourceId: "source-1",
    });
    expect(runMeetingRecorderSmokeMock).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      meetingUrl: "https://teams.microsoft.com/l/meetup-join/private",
      joinAt: new Date("2099-07-20T06:30:00.000Z"),
      provider: "RECALL_AI",
      liveVendorCall: true,
    });
    expect(syncPayload).toMatchObject({ workflowJobId: "job-1", source: { id: "source-1" } });
    expect(dryRunPayload).toMatchObject({
      provider: "MICROSOFT",
      upcomingEventCount: 3,
      schedulableEventCount: 2,
      skippedEventCount: 1,
    });
    expect(smokePayload).toMatchObject({
      smokeRun: {
        id: "smoke-1",
        status: "FAILED",
        provider: "RECALL_AI",
        hasMeeting: true,
        hasRecording: true,
        failureMessage: "Meeting recorder smoke failed. Review customer runtime logs for details.",
      },
    });
    expect(JSON.stringify(smokePayload)).not.toContain("teams.microsoft.com");
    expect(JSON.stringify(smokePayload)).not.toContain("bot-remote");
    expect(JSON.stringify(smokePayload)).not.toContain("recording-1");
    expect(JSON.stringify(smokePayload)).not.toContain("hash-1");
  });

  it("runs support-only meeting recorder schedule and cancel without returning bot ids", async () => {
    const { createCorgtexMcpServer } = await import("./server");
    const { requireScope } = await import("./auth");

    const server = createCorgtexMcpServer({
      actor: { kind: "agent", authProvider: "support", credentialId: "cred-1", scopes: ["support:write"] } as any,
      workspaceId: "ws-1",
      authKind: "agent",
      scopes: ["meetings:write", "support:write"],
    });

    const scheduleResponse = await (server as any)._registeredTools.schedule_meeting_recording.handler({
      meetingId: "meeting-1",
      provider: "RECALL_AI",
    });
    const cancelResponse = await (server as any)._registeredTools.cancel_meeting_recording.handler({
      meetingId: "meeting-1",
    });
    const schedulePayload = JSON.parse(scheduleResponse.content[0].text);
    const cancelPayload = JSON.parse(cancelResponse.content[0].text);

    expect(vi.mocked(requireScope)).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws-1" }), "meetings:write");
    expect(vi.mocked(requireScope)).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws-1" }), "support:write");
    expect(scheduleMeetingRecordingMock).toHaveBeenCalledWith(expect.objectContaining({ authProvider: "support" }), {
      workspaceId: "ws-1",
      meetingId: "meeting-1",
      provider: "RECALL_AI",
      mode: "manual",
    });
    expect(cancelMeetingRecordingMock).toHaveBeenCalledWith(expect.objectContaining({ authProvider: "support" }), {
      workspaceId: "ws-1",
      meetingId: "meeting-1",
    });
    expect(schedulePayload).toMatchObject({
      workspaceId: "ws-1",
      meetingId: "meeting-1",
      recording: {
        id: "recording-1",
        provider: "RECALL_AI",
        status: "SCHEDULED",
        hasExternalBot: true,
      },
    });
    expect(cancelPayload).toMatchObject({
      workspaceId: "ws-1",
      meetingId: "meeting-1",
      recording: {
        id: "recording-1",
        provider: "RECALL_AI",
        status: "CANCELLED",
      },
    });
    expect(JSON.stringify(schedulePayload)).not.toContain("bot-secret");
    expect(JSON.stringify(cancelPayload)).not.toContain("bot-secret");
  });

  it("rejects remote recorder live smoke without a timezone-aware future join time", async () => {
    const { createCorgtexMcpServer } = await import("./server");

    const server = createCorgtexMcpServer({
      actor: { kind: "agent", authProvider: "support", credentialId: "cred-1" } as any,
      workspaceId: "ws-1",
      authKind: "agent",
      scopes: ["meetings:write", "support:write"],
    });

    await expect((server as any)._registeredTools.run_meeting_recorder_live_smoke.handler({
      meetingUrl: "https://teams.microsoft.com/l/meetup-join/private",
      joinAt: "2099-07-20T06:30:00",
    })).rejects.toMatchObject({
      status: 400,
      code: "INVALID_INPUT",
    });
    await expect((server as any)._registeredTools.run_meeting_recorder_live_smoke.handler({
      meetingUrl: "https://teams.microsoft.com/l/meetup-join/private",
      joinAt: "2099-02-31T06:30:00Z",
    })).rejects.toMatchObject({
      status: 400,
      code: "INVALID_INPUT",
    });
    expect(runMeetingRecorderSmokeMock).not.toHaveBeenCalled();
  });

  it("includes proposal owner fields in the daily overview", async () => {
    const { createCorgtexMcpServer } = await import("./server");
    const { requireScope } = await import("./auth");
    const { listMeetings } = await import("@corgtex/domain");

    listActionsMock.mockResolvedValueOnce({ items: [], total: 0 });
    listProposalsMock.mockResolvedValueOnce({
      items: [{
        id: "proposal-1",
        title: "Clarify ownership",
        status: "OPEN",
        resolutionOutcome: null,
        ownerMemberId: "member-owner",
        ownerMember: { id: "member-owner", user: { displayName: "Owner", email: "owner@example.test" } },
        createdAt: new Date("2026-07-15T12:00:00.000Z"),
      }],
      total: 1,
    });
    listTensionsMock.mockResolvedValueOnce({ items: [], total: 0 });
    vi.mocked(listMeetings).mockResolvedValueOnce([]);

    const server = createCorgtexMcpServer({
      actor: { kind: "agent", authProvider: "bootstrap" } as any,
      workspaceId: "ws-1",
      authKind: "agent",
    });

    const response = await (server as any)._registeredTools.daily_overview.handler({ windowHours: 12 });
    const payload = JSON.parse(response.content[0].text);

    expect(vi.mocked(requireScope)).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws-1" }), "proposals:read");
    expect(payload.inFlightProposals).toEqual([expect.objectContaining({
      id: "proposal-1",
      ownerMemberId: "member-owner",
      ownerMemberName: "Owner",
      owner: "Owner",
    })]);
  });

  it("enforces all five legitimate daily overview scopes during invocation and never requires finance:read", async () => {
    const { createCorgtexMcpServer } = await import("./server");
    const { requireScope } = await import("./auth");
    const { listMeetings, MCP_TOOL_CAPABILITIES } = await import("@corgtex/domain");

    listActionsMock.mockResolvedValueOnce({ items: [], total: 0 });
    listProposalsMock.mockResolvedValueOnce({ items: [], total: 0 });
    listTensionsMock.mockResolvedValueOnce({ items: [], total: 0 });
    vi.mocked(listMeetings).mockResolvedValueOnce([]);

    expect(MCP_TOOL_CAPABILITIES.daily_overview.scopes).toEqual([
      "workspace:read",
      "actions:read",
      "proposals:read",
      "tensions:read",
      "meetings:read",
    ]);

    const server = createCorgtexMcpServer({
      actor: { kind: "agent", authProvider: "bootstrap" } as any,
      workspaceId: "ws-1",
      authKind: "agent",
    });

    vi.mocked(requireScope).mockClear();

    await (server as any)._registeredTools.daily_overview.handler({ windowHours: 24 });

    const calledScopes = vi.mocked(requireScope).mock.calls.map((call) => call[1]);
    expect(calledScopes).toEqual([
      "workspace:read",
      "actions:read",
      "proposals:read",
      "tensions:read",
      "meetings:read",
      "workspace:read",
      "actions:read",
      "proposals:read",
      "tensions:read",
      "meetings:read",
    ]);
    expect(calledScopes).not.toContain("finance:read");
  });


  it("lists and fetches work item versions with the matching entity read scope", async () => {
    const { createCorgtexMcpServer } = await import("./server");
    const { requireScope } = await import("./auth");

    const server = createCorgtexMcpServer({
      actor: { kind: "agent", authProvider: "bootstrap" } as any,
      workspaceId: "ws-1",
      authKind: "agent",
    });

    const listResponse = await (server as any)._registeredTools.list_work_item_versions.handler({
      entityType: "TENSION",
      entityId: "tension-1",
    });
    const getResponse = await (server as any)._registeredTools.get_work_item_version.handler({
      entityType: "TENSION",
      entityId: "tension-1",
      version: 2,
    });

    expect((server as any)._registeredTools.list_work_item_versions.annotations).toMatchObject({
      readOnlyHint: true,
      idempotentHint: true,
    });
    expect(vi.mocked(requireScope)).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws-1" }), "tensions:read");
    expect(listWorkItemVersionsMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "agent" }),
      { workspaceId: "ws-1", entityType: "TENSION", entityId: "tension-1" },
    );
    expect(getWorkItemVersionMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "agent" }),
      { workspaceId: "ws-1", entityType: "TENSION", entityId: "tension-1", version: 2 },
    );
    expect(JSON.parse(listResponse.content[0].text)).toMatchObject({
      entityType: "Tension",
      currentVersion: 3,
      versions: [{ id: "v-2", version: 2 }],
    });
    expect(JSON.parse(getResponse.content[0].text)).toMatchObject({
      entityType: "Tension",
      version: { id: "v-2", version: 2 },
    });
  });

  it("lists, posts, and resolves proposal and tension comments through scoped MCP tools", async () => {
    const { createCorgtexMcpServer } = await import("./server");
    const { requireScope } = await import("./auth");
    const { prisma } = await import("@corgtex/shared");

    vi.mocked(prisma.deliberationEntry.findFirst)
      .mockReset()
      .mockResolvedValueOnce({ id: "proposal-entry-1" } as never)
      .mockResolvedValueOnce({ id: "tension-entry-1" } as never);

    listDeliberationEntriesMock
      .mockResolvedValueOnce([{
        id: "proposal-entry-1",
        parentType: "PROPOSAL",
        parentId: "proposal-1",
        parentVersion: 2,
        entryType: "REACTION",
        bodyMd: "Proposal looks good.",
        resolvedAt: null,
        resolvedNote: null,
        createdAt: new Date("2026-06-01T00:00:00.000Z"),
        author: { id: "user-1", displayName: "User", email: "user@example.com" },
      }])
      .mockResolvedValueOnce([{
        id: "tension-entry-1",
        parentType: "TENSION",
        parentId: "tension-1",
        parentVersion: 1,
        entryType: "OBJECTION",
        bodyMd: "Tension needs more context.",
        resolvedAt: null,
        resolvedNote: null,
        createdAt: new Date("2026-06-01T00:00:00.000Z"),
        author: { id: "user-1", displayName: "User", email: "user@example.com" },
      }]);
    postDeliberationEntryMock
      .mockResolvedValueOnce({
        id: "proposal-entry-2",
        parentType: "PROPOSAL",
        parentId: "proposal-1",
        parentVersion: 2,
        entryType: "REACTION",
        bodyMd: "Posted from MCP.",
        resolvedAt: null,
        resolvedNote: null,
        createdAt: new Date("2026-06-01T00:05:00.000Z"),
      })
      .mockResolvedValueOnce({
        id: "tension-entry-2",
        parentType: "TENSION",
        parentId: "tension-1",
        parentVersion: 1,
        entryType: "OBJECTION",
        bodyMd: "Blocked until owner is clear.",
        resolvedAt: null,
        resolvedNote: null,
        createdAt: new Date("2026-06-01T00:05:00.000Z"),
      });
    resolveDeliberationEntryMock
      .mockResolvedValueOnce({
        id: "proposal-entry-1",
        parentType: "PROPOSAL",
        parentId: "proposal-1",
        parentVersion: 2,
        entryType: "REACTION",
        bodyMd: "Proposal looks good.",
        resolvedAt: new Date("2026-06-01T01:00:00.000Z"),
        resolvedNote: "Acknowledged.",
        createdAt: new Date("2026-06-01T00:00:00.000Z"),
      })
      .mockResolvedValueOnce({
        id: "tension-entry-1",
        parentType: "TENSION",
        parentId: "tension-1",
        parentVersion: 1,
        entryType: "OBJECTION",
        bodyMd: "Tension needs more context.",
        resolvedAt: new Date("2026-06-01T01:00:00.000Z"),
        resolvedNote: "Owner added.",
        createdAt: new Date("2026-06-01T00:00:00.000Z"),
      });

    const server = createCorgtexMcpServer({
      actor: { kind: "agent", authProvider: "bootstrap" } as any,
      workspaceId: "ws-1",
      authKind: "agent",
    });

    const proposalListResponse = await (server as any)._registeredTools.list_proposal_comments.handler({ proposalId: "proposal-1" });
    const proposalPostResponse = await (server as any)._registeredTools.post_proposal_comment.handler({
      proposalId: "proposal-1",
      bodyMd: "Posted from MCP.",
    });
    const proposalResolveResponse = await (server as any)._registeredTools.resolve_proposal_comment.handler({
      entryId: "proposal-entry-1",
      resolvedNote: "Acknowledged.",
    });
    const tensionListResponse = await (server as any)._registeredTools.list_tension_comments.handler({ tensionId: "tension-1" });
    const tensionPostResponse = await (server as any)._registeredTools.post_tension_comment.handler({
      tensionId: "tension-1",
      bodyMd: "Blocked until owner is clear.",
      entryType: "OBJECTION",
      targetCircleId: "circle-1",
    });
    const tensionResolveResponse = await (server as any)._registeredTools.resolve_tension_comment.handler({
      entryId: "tension-entry-1",
      resolvedNote: "Owner added.",
    });

    expect(vi.mocked(requireScope)).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws-1" }), "proposals:read");
    expect(vi.mocked(requireScope)).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws-1" }), "proposals:write");
    expect(vi.mocked(requireScope)).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws-1" }), "tensions:read");
    expect(vi.mocked(requireScope)).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws-1" }), "tensions:write");
    expect(listDeliberationEntriesMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "agent" }),
      { workspaceId: "ws-1", parentType: "PROPOSAL", parentId: "proposal-1" },
    );
    expect(listDeliberationEntriesMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "agent" }),
      { workspaceId: "ws-1", parentType: "TENSION", parentId: "tension-1" },
    );
    expect(postDeliberationEntryMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "agent" }),
      expect.objectContaining({
        workspaceId: "ws-1",
        parentType: "PROPOSAL",
        parentId: "proposal-1",
        entryType: "REACTION",
        bodyMd: "Posted from MCP.",
      }),
    );
    expect(postDeliberationEntryMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "agent" }),
      expect.objectContaining({
        workspaceId: "ws-1",
        parentType: "TENSION",
        parentId: "tension-1",
        entryType: "OBJECTION",
        targetCircleId: "circle-1",
      }),
    );
    expect(prisma.deliberationEntry.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "proposal-entry-1", workspaceId: "ws-1", parentType: "PROPOSAL" }),
    }));
    expect(prisma.deliberationEntry.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "tension-entry-1", workspaceId: "ws-1", parentType: "TENSION" }),
    }));
    expect(resolveDeliberationEntryMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "agent" }),
      { workspaceId: "ws-1", entryId: "proposal-entry-1", resolvedNote: "Acknowledged." },
    );
    expect(resolveDeliberationEntryMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "agent" }),
      { workspaceId: "ws-1", entryId: "tension-entry-1", resolvedNote: "Owner added." },
    );
    expect((server as any)._registeredTools.list_proposal_comments.annotations).toMatchObject({ readOnlyHint: true });
    expect((server as any)._registeredTools.post_proposal_comment.annotations).toMatchObject({ readOnlyHint: false });
    expect((server as any)._registeredTools.list_tension_comments.annotations).toMatchObject({ readOnlyHint: true });
    expect((server as any)._registeredTools.post_tension_comment.annotations).toMatchObject({ readOnlyHint: false });
    expect(JSON.parse(proposalListResponse.content[0].text)).toMatchObject({
      items: [{ id: "proposal-entry-1", parentType: "PROPOSAL", bodyMd: "Proposal looks good." }],
      webUrl: "https://app.test/workspaces/ws-1/proposals/proposal-1",
    });
    expect(JSON.parse(proposalPostResponse.content[0].text)).toMatchObject({
      id: "proposal-entry-2",
      entryType: "REACTION",
      webUrl: "https://app.test/workspaces/ws-1/proposals/proposal-1",
    });
    expect(JSON.parse(proposalResolveResponse.content[0].text)).toMatchObject({
      id: "proposal-entry-1",
      resolvedNote: "Acknowledged.",
      webUrl: "https://app.test/workspaces/ws-1/proposals/proposal-1",
    });
    expect(JSON.parse(tensionListResponse.content[0].text)).toMatchObject({
      items: [{ id: "tension-entry-1", parentType: "TENSION", bodyMd: "Tension needs more context." }],
      webUrl: "https://app.test/workspaces/ws-1/tensions/tension-1",
    });
    expect(JSON.parse(tensionPostResponse.content[0].text)).toMatchObject({
      id: "tension-entry-2",
      entryType: "OBJECTION",
      webUrl: "https://app.test/workspaces/ws-1/tensions/tension-1",
    });
    expect(JSON.parse(tensionResolveResponse.content[0].text)).toMatchObject({
      id: "tension-entry-1",
      resolvedNote: "Owner added.",
      webUrl: "https://app.test/workspaces/ws-1/tensions/tension-1",
    });
  });

  it("does not let proposal-scoped comment resolution resolve a tension entry", async () => {
    const { createCorgtexMcpServer } = await import("./server");
    const { prisma } = await import("@corgtex/shared");

    vi.mocked(prisma.deliberationEntry.findFirst).mockReset().mockResolvedValueOnce(null as never);

    const server = createCorgtexMcpServer({
      actor: { kind: "agent", authProvider: "bootstrap" } as any,
      workspaceId: "ws-1",
      authKind: "agent",
    });

    await expect((server as any)._registeredTools.resolve_proposal_comment.handler({
      entryId: "tension-entry-1",
      resolvedNote: "Wrong parent type.",
    })).rejects.toMatchObject({
      status: 404,
      code: "NOT_FOUND",
    });
    expect(resolveDeliberationEntryMock).not.toHaveBeenCalled();
  });

  it("creates execution requests and returns execution packet context", async () => {
    const { createCorgtexMcpServer } = await import("./server");
    const { requireScope } = await import("./auth");

    const server = createCorgtexMcpServer({
      actor: { kind: "agent", authProvider: "bootstrap" } as any,
      workspaceId: "ws-1",
      authKind: "agent",
    });

    const createResponse = await (server as any)._registeredTools.create_execution_request.handler({
      goal: "Draft the implementation follow-up",
      provider: "OPENWORK",
      writebackTargetType: "ACTION",
      idempotencyKey: "request-key",
    });
    const packetResponse = await (server as any)._registeredTools.get_execution_packet.handler({
      requestId: "request-1",
    });

    expect((server as any)._registeredTools.get_execution_packet.annotations).toMatchObject({
      readOnlyHint: false,
      idempotentHint: false,
      destructiveHint: false,
      openWorldHint: false,
    });
    expect(vi.mocked(requireScope)).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws-1" }), "execution:write");
    expect(vi.mocked(requireScope)).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws-1" }), "execution:read");
    expect(createExecutionRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "agent" }),
      expect.objectContaining({
        workspaceId: "ws-1",
        goal: "Draft the implementation follow-up",
        provider: "OPENWORK",
        writebackTargetType: "ACTION",
        idempotencyKey: "request-key",
      }),
    );
    expect(getExecutionPacketMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "agent" }),
      { workspaceId: "ws-1", requestId: "request-1" },
    );
    expect(JSON.parse(createResponse.content[0].text)).toMatchObject({
      id: "request-1",
      webUrl: "https://app.test/workspaces/ws-1/settings?tab=ai-workspaces&executionRequest=request-1",
    });
    expect(JSON.parse(packetResponse.content[0].text)).toEqual({ id: "request-1", goal: "Draft follow-up" });
  });

  it("returns company context and write-back targets for execution clients", async () => {
    const { createCorgtexMcpServer } = await import("./server");
    const { requireScope } = await import("./auth");

    const server = createCorgtexMcpServer({
      actor: { kind: "agent", authProvider: "bootstrap" } as any,
      workspaceId: "ws-1",
      authKind: "agent",
    });

    const contextResponse = await (server as any)._registeredTools.get_company_context.handler({});
    const targetsResponse = await (server as any)._registeredTools.list_writeback_targets.handler({
      query: "Follow",
      targetTypes: ["ACTION"],
      take: 5,
    });

    expect(vi.mocked(requireScope)).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws-1" }), "workspace:read");
    expect(vi.mocked(requireScope)).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws-1" }), "execution:read");
    expect(vi.mocked(requireScope)).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws-1" }), "actions:read");
    expect(vi.mocked(requireScope)).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws-1" }), "tensions:read");
    expect(vi.mocked(requireScope)).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws-1" }), "proposals:read");
    expect(vi.mocked(requireScope)).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws-1" }), "meetings:read");
    expect(vi.mocked(requireScope)).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws-1" }), "brain:read");
    expect(getCompanyContextMock).toHaveBeenCalledWith(expect.objectContaining({ kind: "agent" }), "ws-1");
    expect(listWritebackTargetsMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "agent" }),
      { workspaceId: "ws-1", query: "Follow", targetTypes: ["ACTION"], take: 5 },
    );
    expect(JSON.parse(contextResponse.content[0].text)).toEqual({ workspace: { id: "ws-1", name: "Acme" } });
    expect(JSON.parse(targetsResponse.content[0].text).items[0]).toEqual(expect.objectContaining({ type: "ACTION", id: "action-1" }));
  });

  it("submits idempotent execution results through the audited write-back path", async () => {
    const { createCorgtexMcpServer } = await import("./server");
    const { requireScope } = await import("./auth");

    const server = createCorgtexMcpServer({
      actor: { kind: "agent", authProvider: "bootstrap" } as any,
      workspaceId: "ws-1",
      authKind: "agent",
    });

    const response = await (server as any)._registeredTools.submit_execution_result.handler({
      requestId: "request-1",
      idempotencyKey: "result-key",
      targetType: "ACTION",
      output: { title: "Follow up" },
    });

    expect(vi.mocked(requireScope)).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws-1" }), "execution:write");
    expect(submitExecutionResultMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "agent" }),
      {
        workspaceId: "ws-1",
        requestId: "request-1",
        idempotencyKey: "result-key",
        targetType: "ACTION",
        output: { title: "Follow up" },
      },
    );
    expect(JSON.parse(response.content[0].text)).toMatchObject({
      id: "result-1",
      status: "ACCEPTED",
      webUrl: "https://app.test/workspaces/ws-1/settings?tab=ai-workspaces&executionRequest=request-1",
    });
  });

  it("exposes scoped relationship read tools for CRM accounts, contacts, deals, due work, and suggestions", async () => {
    const { createCorgtexMcpServer } = await import("./server");
    const { requireScope } = await import("./auth");

    const server = createCorgtexMcpServer({
      actor: { kind: "agent", authProvider: "bootstrap" } as any,
      workspaceId: "ws-1",
      authKind: "agent",
    });

    const accountsResponse = await (server as any)._registeredTools.list_relationship_accounts.handler({
      query: "Acme",
      take: 10,
    });
    const accountResponse = await (server as any)._registeredTools.get_relationship_account.handler({
      accountId: "account-1",
    });
    const contactsResponse = await (server as any)._registeredTools.list_relationship_contacts.handler({
      accountId: "account-1",
      query: "buyer",
      take: 10,
    });
    const dealsResponse = await (server as any)._registeredTools.list_relationship_deals.handler({
      accountId: "account-1",
      contactId: "contact-1",
      stage: "QUALIFIED",
      take: 10,
    });
    const dueWorkResponse = await (server as any)._registeredTools.list_due_relationship_work.handler({
      accountId: "account-1",
      dueTo: "2026-06-03T00:00:00.000Z",
    });
    const suggestionsResponse = await (server as any)._registeredTools.list_communication_suggestions.handler({
      accountId: "account-1",
      status: "SUGGESTED",
      take: 10,
    });

    expect(vi.mocked(requireScope)).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws-1" }), "relationships:read");
    expect(listCrmAccountsMock).toHaveBeenCalledWith(expect.objectContaining({ kind: "agent" }), "ws-1", {
      query: "Acme",
      take: 10,
    });
    expect(getCrmAccountMock).toHaveBeenCalledWith(expect.objectContaining({ kind: "agent" }), {
      workspaceId: "ws-1",
      accountId: "account-1",
    });
    expect(listContactsMock).toHaveBeenCalledWith(expect.objectContaining({ kind: "agent" }), "ws-1", {
      accountId: "account-1",
      query: "buyer",
      take: 10,
    });
    expect(listDealsMock).toHaveBeenCalledWith(expect.objectContaining({ kind: "agent" }), "ws-1", {
      accountId: "account-1",
      contactId: "contact-1",
      stage: "QUALIFIED",
      take: 10,
      skip: undefined,
    });
    expect(listCrmActivitiesMock).toHaveBeenCalledWith(expect.objectContaining({ kind: "agent" }), "ws-1", expect.objectContaining({
      accountId: "account-1",
      type: "TASK",
      completion: "open",
      sort: "due",
      dueTo: new Date("2026-06-03T00:00:00.000Z"),
    }));
    expect(listCommunicationSuggestionsMock).toHaveBeenCalledWith(expect.objectContaining({ kind: "agent" }), "ws-1", {
      accountId: "account-1",
      status: "SUGGESTED",
      take: 10,
    });
    expect(JSON.parse(accountsResponse.content[0].text)).toMatchObject({
      items: [{ id: "account-1", name: "Acme Buyers", webUrl: "https://app.test/workspaces/ws-1/leads/accounts/account-1" }],
      webUrl: "https://app.test/workspaces/ws-1/leads?view=accounts",
    });
    expect(JSON.parse(accountResponse.content[0].text)).toMatchObject({
      account: {
        id: "account-1",
        webUrl: "https://app.test/workspaces/ws-1/leads/accounts/account-1",
        contacts: [{ id: "contact-1", webUrl: "https://app.test/workspaces/ws-1/leads/accounts/account-1?view=contacts" }],
        deals: [{ id: "deal-1", webUrl: "https://app.test/workspaces/ws-1/leads/accounts/account-1?view=pipeline" }],
      },
    });
    expect(JSON.parse(contactsResponse.content[0].text)).toMatchObject({
      items: [{ id: "contact-1", webUrl: "https://app.test/workspaces/ws-1/leads/accounts/account-1?view=contacts" }],
      webUrl: "https://app.test/workspaces/ws-1/leads/accounts/account-1?view=contacts",
    });
    expect(JSON.parse(dealsResponse.content[0].text)).toMatchObject({
      items: [{ id: "deal-1", webUrl: "https://app.test/workspaces/ws-1/leads/accounts/account-1?view=pipeline" }],
      webUrl: "https://app.test/workspaces/ws-1/leads/accounts/account-1?view=pipeline",
    });
    expect(JSON.parse(dueWorkResponse.content[0].text)).toMatchObject({
      items: [{ id: "activity-1", title: "Follow up", webUrl: "https://app.test/workspaces/ws-1/leads/accounts/account-1?view=activity" }],
      webUrl: "https://app.test/workspaces/ws-1/leads?view=activity",
    });
    expect(JSON.parse(suggestionsResponse.content[0].text)).toMatchObject({
      items: [{ id: "suggestion-1", webUrl: "https://app.test/workspaces/ws-1/leads/accounts/account-1?view=suggestions" }],
      webUrl: "https://app.test/workspaces/ws-1/leads/accounts/account-1?view=suggestions",
    });
  });

  it("records relationship activity and completes communication suggestions through scoped MCP tools", async () => {
    const { createCorgtexMcpServer } = await import("./server");
    const { requireScope } = await import("./auth");

    const server = createCorgtexMcpServer({
      actor: { kind: "agent", authProvider: "bootstrap" } as any,
      workspaceId: "ws-1",
      authKind: "agent",
    });

    const activityResponse = await (server as any)._registeredTools.record_relationship_activity.handler({
      title: "Follow up next week",
      type: "TASK",
      accountId: "account-1",
      dueAt: "2026-06-04T00:00:00.000Z",
    });
    const completedActivityResponse = await (server as any)._registeredTools.complete_relationship_activity.handler({
      activityId: "activity-1",
      completedAt: "2026-06-05T09:00:00.000Z",
    });
    const suggestionDraftResponse = await (server as any)._registeredTools.create_communication_suggestion.handler({
      title: "Draft pilot recap",
      bodyMd: "Draft only. Do not send.",
      subject: "Pilot recap",
      accountId: "account-1",
      contactId: "contact-1",
      dealId: "deal-1",
    });
    const completeResponse = await (server as any)._registeredTools.complete_communication_suggestion.handler({
      suggestionId: "suggestion-1",
      status: "SENT",
      sentAt: "2026-06-02T10:30:00.000Z",
      conversationId: "conversation-1",
      conversationBodyMd: "Sent externally via Claude.",
    });

    expect(vi.mocked(requireScope)).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws-1" }), "relationships:write");
    expect(createActivityMock).toHaveBeenCalledWith(expect.objectContaining({ kind: "agent" }), expect.objectContaining({
      workspaceId: "ws-1",
      title: "Follow up next week",
      type: "TASK",
      accountId: "account-1",
      source: "mcp",
      dueAt: new Date("2026-06-04T00:00:00.000Z"),
    }));
    expect(completeActivityMock).toHaveBeenCalledWith(expect.objectContaining({ kind: "agent" }), {
      workspaceId: "ws-1",
      activityId: "activity-1",
      completedAt: new Date("2026-06-05T09:00:00.000Z"),
    });
    expect(createCommunicationSuggestionMock).toHaveBeenCalledWith(expect.objectContaining({ kind: "agent" }), {
      workspaceId: "ws-1",
      title: "Draft pilot recap",
      bodyMd: "Draft only. Do not send.",
      subject: "Pilot recap",
      recipientEmail: undefined,
      recipientName: undefined,
      channel: undefined,
      ownerUserId: undefined,
      accountId: "account-1",
      contactId: "contact-1",
      dealId: "deal-1",
      activityId: undefined,
      source: "mcp",
    });
    expect(markCommunicationSuggestionSentMock).toHaveBeenCalledWith(expect.objectContaining({ kind: "agent" }), {
      workspaceId: "ws-1",
      suggestionId: "suggestion-1",
      sentAt: new Date("2026-06-02T10:30:00.000Z"),
    });
    expect(createConversationMessageMock).toHaveBeenCalledWith(expect.objectContaining({ kind: "agent" }), {
      workspaceId: "ws-1",
      conversationId: "conversation-1",
      senderType: "ADMIN",
      senderEmail: undefined,
      bodyMd: "Sent externally via Claude.",
    });
    expect(JSON.parse(activityResponse.content[0].text)).toMatchObject({
      id: "activity-1",
      webUrl: "https://app.test/workspaces/ws-1/leads/accounts/account-1?view=activity",
    });
    expect(JSON.parse(completedActivityResponse.content[0].text)).toMatchObject({
      id: "activity-1",
      completedAt: "2026-06-05T09:00:00.000Z",
      webUrl: "https://app.test/workspaces/ws-1/leads/accounts/account-1?view=activity",
    });
    expect(JSON.parse(suggestionDraftResponse.content[0].text)).toMatchObject({
      id: "suggestion-2",
      status: "SUGGESTED",
      webUrl: "https://app.test/workspaces/ws-1/leads/accounts/account-1?view=suggestions",
    });
    expect(JSON.parse(completeResponse.content[0].text)).toMatchObject({
      id: "suggestion-1",
      status: "SENT",
      webUrl: "https://app.test/workspaces/ws-1/leads/accounts/account-1?view=review",
    });
  });

  it("records failed communication suggestion completion through MCP without marking sent", async () => {
    const { createCorgtexMcpServer } = await import("./server");

    const server = createCorgtexMcpServer({
      actor: { kind: "agent", authProvider: "bootstrap" } as any,
      workspaceId: "ws-1",
      authKind: "agent",
    });

    const response = await (server as any)._registeredTools.complete_communication_suggestion.handler({
      suggestionId: "suggestion-1",
      status: "FAILED",
      failureReason: "External mailbox rejected the draft.",
    });

    expect(failCommunicationSuggestionMock).toHaveBeenCalledWith(expect.objectContaining({ kind: "agent" }), {
      workspaceId: "ws-1",
      suggestionId: "suggestion-1",
      failureReason: "External mailbox rejected the draft.",
    });
    expect(markCommunicationSuggestionSentMock).not.toHaveBeenCalled();
    expect(JSON.parse(response.content[0].text)).toMatchObject({
      id: "suggestion-1",
      status: "FAILED",
    });
  });

  it("returns read-only Finance readiness through MCP", async () => {
    const { createCorgtexMcpServer } = await import("./server");
    const { requireScope } = await import("./auth");

    const actor = {
      kind: "user",
      user: { id: "user-1", email: "user@example.com", displayName: "User" },
    } as any;
    const server = createCorgtexMcpServer({
      actor,
      workspaceId: "ws-1",
      authKind: "oauth",
      scopes: ["finance:read"],
    });

    const response = await (server as any)._registeredTools.get_finance_readiness.handler({});
    const payload = JSON.parse(response.content[0].text);

    expect(vi.mocked(requireScope)).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws-1" }), "finance:read");
    expect(getFinanceReadinessMock).toHaveBeenCalledWith(actor, "ws-1");
    expect(payload).toMatchObject({
      workspaceId: "ws-1",
      access: { financeAllMemberWrite: true },
      paymentSafety: {
        cashOnlyConfirmation: true,
        peerReviewRequired: true,
        staleConflictProtection: true,
      },
      retiredPracticeLedger: { retired: true },
      webUrl: "https://app.test/workspaces/ws-1/finance",
    });
    expect((server as any)._registeredTools.get_finance_readiness.annotations).toMatchObject({
      readOnlyHint: true,
    });
  });

  it("lists and sets feature flag config for customer support operations", async () => {
    const { createCorgtexMcpServer } = await import("./server");
    const { prisma } = await import("@corgtex/shared");
    vi.mocked(prisma.workspaceFeatureFlag.findMany).mockResolvedValueOnce([
      {
        flag: "FINANCE",
        enabled: true,
        config: { channelId: "C123" },
        updatedAt: new Date("2026-05-20T00:00:00.000Z"),
      },
    ] as never);
    vi.mocked(prisma.workspaceFeatureFlag.upsert).mockResolvedValueOnce({
      flag: "GOALS",
      enabled: true,
      config: { channelId: "C456" },
    } as never);

    const server = createCorgtexMcpServer({
      actor: { kind: "agent", authProvider: "bootstrap" } as any,
      workspaceId: "ws-1",
      authKind: "agent",
    });

    const listResponse = await (server as any)._registeredTools.list_feature_flags.handler({});
    const listedFlags = JSON.parse(listResponse.content[0].text).flags;
    expect(listedFlags.find((flag: { flag: string }) => flag.flag === "FINANCE")).toMatchObject({
      enabled: true,
      config: { channelId: "C123" },
      configIdentity: "d".repeat(64),
    });
    expect(listedFlags.find((flag: { flag: string }) => flag.flag === "GOALS")).not.toHaveProperty("configIdentity");

    const setResponse = await (server as any)._registeredTools.set_feature_flag.handler({
      flag: "GOALS",
      enabled: true,
      config: { channelId: "C456" },
    });

    expect(prisma.workspaceFeatureFlag.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({ enabled: true, config: { channelId: "C456" } }),
      create: expect.objectContaining({ enabled: true, config: { channelId: "C456" } }),
    }));
    expect(requireWorkspaceMembershipMock).toHaveBeenCalledWith({
      actor: expect.objectContaining({ kind: "agent" }),
      workspaceId: "ws-1",
      allowedRoles: ["ADMIN"],
    });
    expect(JSON.parse(setResponse.content[0].text)).toMatchObject({
      flag: "GOALS",
      enabled: true,
      config: { channelId: "C456" },
    });
  });

  it("returns versioned Finance report-import updates and conflicts", async () => {
    const { createCorgtexMcpServer } = await import("./server");
    const { prisma } = await import("@corgtex/shared");
    compareAndSetFinanceConfigMock
      .mockResolvedValueOnce({
        status: "updated",
        enabled: true,
        config: { financeAllMemberWrite: true, financeCapabilities: { reports: true, reportImports: true } },
        reportImportsEnabled: true,
        updatedAt: new Date("2026-08-08T01:00:01.000Z"),
        configIdentity: "a".repeat(64),
      })
      .mockResolvedValueOnce({
        status: "conflict",
        code: "FEATURE_CONFIG_CONFLICT",
        currentConfigIdentity: "b".repeat(64),
      })
      .mockResolvedValueOnce({
        status: "updated",
        enabled: true,
        config: { financeCapabilities: { reports: true } },
        reportImportsEnabled: false,
        updatedAt: new Date("2026-08-08T01:00:03.000Z"),
        configIdentity: "c".repeat(64),
      })
      .mockResolvedValueOnce({
        status: "invalid",
        code: "FINANCE_CONFIG_INVALID",
        reason: "CONFIG_NOT_OBJECT",
        currentConfigIdentity: "c".repeat(64),
      });
    const server = createCorgtexMcpServer({
      actor: { kind: "agent", authProvider: "bootstrap" } as any,
      workspaceId: "ws-1",
      authKind: "agent",
    });

    const updated = await (server as any)._registeredTools.set_feature_flag.handler({
      flag: "FINANCE",
      reportImportsEnabled: true,
      expectedConfigIdentity: null,
    });
    expect(compareAndSetFinanceConfigMock).toHaveBeenLastCalledWith({
      workspaceId: "ws-1",
      reportImportsEnabled: true,
      expectedConfigIdentity: null,
    });
    expect(updated.structuredContent).toMatchObject({
      status: "updated",
      enabled: true,
      reportImportsEnabled: true,
      updatedAt: "2026-08-08T01:00:01.000Z",
      configIdentity: "a".repeat(64),
    });

    const conflict = await (server as any)._registeredTools.set_feature_flag.handler({
      flag: "FINANCE",
      reportImportsEnabled: false,
      expectedConfigIdentity: "a".repeat(64),
    });
    expect(conflict.structuredContent).toEqual({
      status: "conflict",
      code: "FEATURE_CONFIG_CONFLICT",
      currentConfigIdentity: "b".repeat(64),
    });

    await (server as any)._registeredTools.set_feature_flag.handler({
      flag: "FINANCE",
      enabled: true,
      config: { financeCapabilities: { reports: true } },
      expectedConfigIdentity: "b".repeat(64),
    });
    expect(compareAndSetFinanceConfigMock).toHaveBeenLastCalledWith({
      workspaceId: "ws-1",
      enabled: true,
      config: { financeCapabilities: { reports: true } },
      expectedConfigIdentity: "b".repeat(64),
    });

    const invalid = await (server as any)._registeredTools.set_feature_flag.handler({
      flag: "FINANCE",
      reportImportsEnabled: true,
      expectedConfigIdentity: "c".repeat(64),
    });
    expect(invalid.structuredContent).toMatchObject({
      status: "invalid",
      code: "FINANCE_CONFIG_INVALID",
      reason: "CONFIG_NOT_OBJECT",
    });

    for (const input of [
      { flag: "GOALS", reportImportsEnabled: true, expectedConfigIdentity: null },
      { flag: "FINANCE", enabled: true, reportImportsEnabled: true, expectedConfigIdentity: null },
      { flag: "FINANCE", reportImportsEnabled: true, config: {}, expectedConfigIdentity: null },
      { flag: "FINANCE", reportImportsEnabled: true, expectedConfigIdentity: "not-a-valid-identity" },
      { flag: "FINANCE", reportImportsEnabled: true, expectedConfigIdentity: undefined },
      { flag: "GOALS", enabled: true, config: {}, expectedConfigIdentity: "a".repeat(64) },
      { flag: "FINANCE", enabled: true, expectedConfigIdentity: "a".repeat(64) },
      { flag: "FINANCE", enabled: true, config: { financeCapabilities: { reports: true } } },
    ]) await expect((server as any)._registeredTools.set_feature_flag.handler(input)).rejects.toMatchObject({ status: 400, code: "INVALID_INPUT" });
  });

  it("annotates read-only and destructive tools for connector approval reviews", async () => {
    const { createCorgtexMcpServer } = await import("./server");

    const server = createCorgtexMcpServer({
      actor: { kind: "agent", authProvider: "bootstrap" } as any,
      workspaceId: "ws-1",
      authKind: "agent",
    });

    expect((server as any)._registeredTools.search.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect((server as any)._registeredTools.fetch.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect((server as any)._registeredTools.delete_action.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    });
    expect((server as any)._registeredTools.archive_goal.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    });
    expect((server as any)._registeredTools.archive_tool_link.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    });
    expect((server as any)._registeredTools.reveal_tool_link_credential.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      sensitiveHint: true,
      openWorldHint: false,
    });
    expect((server as any)._registeredTools.set_feature_flag.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      sensitiveHint: true,
      openWorldHint: false,
    });
    expect((server as any)._registeredTools.support_reopen_resolved_proposals.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      sensitiveHint: true,
      openWorldHint: false,
    });
    expect((server as any)._registeredTools.import_context_graph_map.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      sensitiveHint: true,
      openWorldHint: false,
    });
    expect((server as any)._registeredTools.connect_meeting_recorder_calendar.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      sensitiveHint: true,
      openWorldHint: false,
    });
    expect((server as any)._registeredTools.run_meeting_recorder_live_smoke.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      sensitiveHint: true,
      openWorldHint: false,
    });
    expect((server as any)._registeredTools.list_agent_credentials.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    });
    expect((server as any)._registeredTools.update_agent_policy.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      sensitiveHint: true,
      openWorldHint: false,
    });
    expect((server as any)._registeredTools.revoke_agent_credential.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      sensitiveHint: true,
      openWorldHint: false,
    });
  });

  it("lists agent credentials without returning token hashes or private reason text", async () => {
    const { createCorgtexMcpServer } = await import("./server");
    const { requireScope } = await import("./auth");
    listAgentCredentialsMock.mockResolvedValueOnce([
      {
        id: "cred-1",
        label: "Production MCP",
        scopes: ["workspace:read", "agents:read"],
        catalogItemId: "catalog-1",
        reasonMd: "Private customer setup note.",
        tokenHash: "sha256-secret",
        monthlyBudgetCents: null,
        dailyCallLimit: null,
        isActive: true,
        lastUsedAt: null,
        createdAt: new Date("2026-05-01T00:00:00.000Z"),
        updatedAt: new Date("2026-05-01T00:00:00.000Z"),
      },
    ]);

    const server = createCorgtexMcpServer({
      actor: { kind: "agent", authProvider: "bootstrap" } as any,
      workspaceId: "ws-1",
      authKind: "agent",
    });

    const response = await (server as any)._registeredTools.list_agent_credentials.handler({});
    const body = JSON.parse(response.content[0].text);

    expect(vi.mocked(requireScope)).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws-1" }), "agents:read");
    expect(body.items[0]).toEqual(expect.objectContaining({
      id: "cred-1",
      label: "Production MCP",
      scopes: ["workspace:read", "agents:read"],
      isActive: true,
    }));
    expect(body.items[0]).not.toHaveProperty("reasonMd");
    expect(body.items[0]).not.toHaveProperty("tokenHash");
    expect(response.content[0].text).not.toContain("Private customer setup note");
    expect(response.content[0].text).not.toContain("sha256-secret");
  });

  it("redacts agent governance policy bodies from support config reads and writes", async () => {
    const { createCorgtexMcpServer } = await import("./server");
    const { requireScope } = await import("./auth");
    listAgentConfigsMock.mockResolvedValueOnce([
      {
        agentKey: "meeting-summary",
        label: "Meeting Summary",
        category: "knowledge",
        enabled: true,
        modelOverride: "openai/gpt-test",
        governancePolicy: "Do not expose raw customer policy.",
        costTier: "medium",
      },
    ]);
    updateAgentConfigMock.mockResolvedValueOnce({
      id: "config-1",
      agentKey: "meeting-summary",
      enabled: true,
      modelOverride: "openai/gpt-test",
      governancePolicy: "Do not expose updated policy.",
      updatedAt: new Date("2026-05-01T00:00:00.000Z"),
    });

    const server = createCorgtexMcpServer({
      actor: { kind: "agent", authProvider: "bootstrap" } as any,
      workspaceId: "ws-1",
      authKind: "agent",
    });

    const listResponse = await (server as any)._registeredTools.list_agent_configs.handler({});
    const updateResponse = await (server as any)._registeredTools.update_agent_policy.handler({
      agentKey: "meeting-summary",
      governancePolicy: "Replacement policy body.",
      modelOverride: "openai/gpt-test",
    });

    expect(vi.mocked(requireScope)).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws-1" }), "agents:read");
    expect(vi.mocked(requireScope)).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws-1" }), "support:write");
    expect(JSON.parse(listResponse.content[0].text).items[0]).toEqual(expect.objectContaining({
      agentKey: "meeting-summary",
      modelOverride: "openai/gpt-test",
      hasGovernancePolicy: true,
    }));
    expect(JSON.parse(updateResponse.content[0].text).config).toEqual(expect.objectContaining({
      agentKey: "meeting-summary",
      modelOverride: "openai/gpt-test",
      hasGovernancePolicy: true,
    }));
    expect(listResponse.content[0].text).not.toContain("Do not expose raw customer policy");
    expect(updateResponse.content[0].text).not.toContain("Do not expose updated policy");
  });

  it("returns newspaper diagnostics through a read-only support tool", async () => {
    const { createCorgtexMcpServer } = await import("./server");
    const { requireScope } = await import("./auth");
    getNewspaperDiagnosticsMock.mockResolvedValueOnce({
      defaultSchedule: { cadence: "WEEKLY", weekday: "MONDAY", localTime: "08:00", timeZone: "UTC" },
      sourceCounts: { sevenDays: { meetings: 2 } },
    });

    const server = createCorgtexMcpServer({
      actor: { kind: "agent", authProvider: "bootstrap" } as any,
      workspaceId: "ws-1",
      authKind: "agent",
    });

    const response = await (server as any)._registeredTools.get_newspaper_diagnostics.handler({ take: 5 });
    const body = JSON.parse(response.content[0].text);

    expect(vi.mocked(requireScope)).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws-1" }), "agents:read");
    expect(vi.mocked(requireScope)).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws-1" }), "runtime:read");
    expect(getNewspaperDiagnosticsMock).toHaveBeenCalledWith(expect.objectContaining({ kind: "agent" }), "ws-1", { take: 5 });
    expect(body.diagnostics.sourceCounts.sevenDays.meetings).toBe(2);
  });

  it("updates and revokes agent credentials through support-scoped tools without returning token material", async () => {
    const { createCorgtexMcpServer } = await import("./server");
    const { requireScope } = await import("./auth");
    updateAgentCredentialScopesMock.mockResolvedValueOnce({
      id: "cred-1",
      label: "Production MCP",
      scopes: ["workspace:read"],
      isActive: true,
      tokenHash: "sha256-secret",
    });
    revokeAgentCredentialMock.mockResolvedValueOnce({
      id: "cred-1",
      label: "Production MCP",
      scopes: ["workspace:read"],
      isActive: false,
      tokenHash: "sha256-secret",
    });

    const server = createCorgtexMcpServer({
      actor: { kind: "agent", authProvider: "bootstrap" } as any,
      workspaceId: "ws-1",
      authKind: "agent",
    });

    const updateResponse = await (server as any)._registeredTools.update_agent_credential_scopes.handler({
      credentialId: "cred-1",
      scopes: ["workspace:read"],
    });
    const revokeResponse = await (server as any)._registeredTools.revoke_agent_credential.handler({
      credentialId: "cred-1",
    });

    expect(vi.mocked(requireScope)).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws-1" }), "support:write");
    expect(updateAgentCredentialScopesMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "agent" }),
      { workspaceId: "ws-1", credentialId: "cred-1", scopes: ["workspace:read"] },
    );
    expect(revokeAgentCredentialMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "agent" }),
      { workspaceId: "ws-1", credentialId: "cred-1" },
    );
    expect(updateResponse.content[0].text).not.toContain("sha256-secret");
    expect(revokeResponse.content[0].text).not.toContain("sha256-secret");
  });

  it("runs the support proposal repair tool with support and proposal scopes", async () => {
    const { createCorgtexMcpServer } = await import("./server");
    const { requireScope } = await import("./auth");

    const server = createCorgtexMcpServer({
      actor: { kind: "agent", authProvider: "bootstrap" } as any,
      workspaceId: "ws-1",
      authKind: "agent",
    });

    const repairTool = (server as any)._registeredTools.support_reopen_resolved_proposals;
    const response = await repairTool.handler({
      proposalIds: ["proposal-1"],
      reason: "Undo accidental system auto-resolution.",
    });

    expect(vi.mocked(requireScope)).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws-1" }), "support:write");
    expect(vi.mocked(requireScope)).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws-1" }), "proposals:write");
    expect(supportReopenResolvedProposalsMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "agent" }),
      {
        workspaceId: "ws-1",
        proposalIds: ["proposal-1"],
        reason: "Undo accidental system auto-resolution.",
      },
    );
    expect(JSON.parse(response.content[0].text)).toEqual({
      workspaceId: "ws-1",
      reopened: [{ id: "proposal-1", status: "OPEN", flowId: "flow-1", policyCorpusRowsDeleted: 1 }],
      webUrls: ["https://app.test/workspaces/ws-1/proposals/proposal-1"],
    });
  });

  it("imports an approved context graph map through the sensitive context-map tool", async () => {
    const { createCorgtexMcpServer } = await import("./server");
    const { requireScope } = await import("./auth");

    const server = createCorgtexMcpServer({
      actor: { kind: "agent", authProvider: "bootstrap" } as any,
      workspaceId: "ws-1",
      authKind: "agent",
    });

    const response = await (server as any)._registeredTools.import_context_graph_map.handler({
      name: "CRNA Critical Path",
      objects: [
        { ref: "process", objectType: "Process", title: "CR North America critical path" },
        { ref: "step", objectType: "ProcessStep", title: "Decision to proceed" },
      ],
      relationships: [
        { sourceRef: "step", targetRef: "process", relationshipType: "part_of" },
      ],
      evidenceRefs: [
        { objectRef: "step", sourceType: "DOCUMENT", sourceId: "doc-1" },
      ],
      layoutItems: [
        { objectRef: "step", x: 280, y: 120 },
      ],
    });

    expect(vi.mocked(requireScope)).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws-1" }), "context-graph:approve");
    expect(importContextGraphMapMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "agent" }),
      expect.objectContaining({
        workspaceId: "ws-1",
        name: "CRNA Critical Path",
        objects: expect.arrayContaining([expect.objectContaining({ title: "Decision to proceed" })]),
      }),
    );
    expect(JSON.parse(response.content[0].text)).toEqual({
      mapViewId: "map-1",
      objectCount: 2,
      relationshipCount: 1,
      evidenceCount: 2,
      layoutItemCount: 2,
      webUrl: "https://app.test/workspaces/ws-1/maps?view=map-1",
    });
  });

  it("exposes context graph map schema through a read-scoped MCP tool", async () => {
    const { createCorgtexMcpServer } = await import("./server");
    const { requireScope } = await import("./auth");

    const server = createCorgtexMcpServer({
      actor: { kind: "agent", authProvider: "bootstrap" } as any,
      workspaceId: "ws-1",
      authKind: "agent",
    });

    const response = await (server as any)._registeredTools.get_context_graph_map_schema.handler({});

    expect(vi.mocked(requireScope)).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws-1" }), "context-graph:read");
    expect(getContextGraphMapSchemaMock).toHaveBeenCalled();
    expect(JSON.parse(response.content[0].text)).toEqual(expect.objectContaining({
      objectTypes: ["Process", "Agent", "Evidence"],
      relationshipTypes: ["supports", "has_evidence"],
      evidenceRefFormat: expect.objectContaining({ sourceType: "BrainSource" }),
      layoutItemFormat: expect.objectContaining({ objectRef: "process" }),
      writePath: expect.objectContaining({ auditedImportTool: "import_context_graph_map" }),
    }));
  });

  it("preserves responsibility and labeled priority through MCP work-item write tools", async () => {
    const { createCorgtexMcpServer } = await import("./server");
    const { requireScope } = await import("./auth");
    const { prisma } = await import("@corgtex/shared");

    vi.mocked(prisma.action.findFirst)
      .mockResolvedValueOnce({
        id: "action-1",
        status: "DRAFT",
        version: 1,
        priority: 2,
        assigneeMemberId: "member-assignee",
        assigneeMember: { id: "member-assignee", user: { displayName: "Assignee", email: "assignee@example.test" } },
      } as never)
      .mockResolvedValueOnce({
        id: "action-1",
        status: "OPEN",
        version: 2,
        priority: 3,
        assigneeMemberId: "member-assignee",
        assigneeMember: { id: "member-assignee", user: { displayName: "Assignee", email: "assignee@example.test" } },
      } as never);
    vi.mocked(prisma.tension.findFirst)
      .mockResolvedValueOnce({
        id: "tension-1",
        status: "DRAFT",
        version: 1,
        priority: 1,
        assigneeMemberId: "member-responsible",
        raisedByMemberId: "member-raiser",
        assigneeMember: { id: "member-responsible", user: { displayName: "Responsible", email: "responsible@example.test" } },
        raisedByMember: { id: "member-raiser", user: { displayName: "Raiser", email: "raiser@example.test" } },
      } as never)
      .mockResolvedValueOnce({
        id: "tension-1",
        status: "OPEN",
        version: 2,
        priority: 2,
        assigneeMemberId: "member-responsible",
        raisedByMemberId: "member-raiser",
        assigneeMember: { id: "member-responsible", user: { displayName: "Responsible", email: "responsible@example.test" } },
        raisedByMember: { id: "member-raiser", user: { displayName: "Raiser", email: "raiser@example.test" } },
      } as never);
    vi.mocked(prisma.proposal.findFirst)
      .mockResolvedValueOnce({
        id: "proposal-1",
        title: "Clarify ownership",
        status: "DRAFT",
        version: 1,
        priority: 3,
        ownerMemberId: "member-owner",
        ownerMember: { id: "member-owner", user: { displayName: "Owner", email: "owner@example.test" } },
      } as never)
      .mockResolvedValueOnce({
        id: "proposal-1",
        title: "Clarify ownership",
        status: "DRAFT",
        version: 2,
        priority: 2,
        ownerMemberId: "member-owner",
        ownerMember: { id: "member-owner", user: { displayName: "Owner", email: "owner@example.test" } },
      } as never);
    loadAdviceRequestCountSummariesMock
      .mockResolvedValueOnce(new Map([["action-1", {
        adviceRequestCount: 0,
        activeAdviceRequestCount: 0,
        inputRequestCount: 0,
        activeInputRequestCount: 0,
      }]]))
      .mockResolvedValueOnce(new Map([["action-1", {
        adviceRequestCount: 2,
        activeAdviceRequestCount: 1,
        inputRequestCount: 2,
        activeInputRequestCount: 1,
      }]]))
      .mockResolvedValueOnce(new Map([["tension-1", {
        adviceRequestCount: 0,
        activeAdviceRequestCount: 0,
        inputRequestCount: 0,
        activeInputRequestCount: 0,
      }]]))
      .mockResolvedValueOnce(new Map([["tension-1", {
        adviceRequestCount: 3,
        activeAdviceRequestCount: 2,
        inputRequestCount: 3,
        activeInputRequestCount: 2,
      }]]));

    const server = createCorgtexMcpServer({
      actor: { kind: "agent", authProvider: "bootstrap" } as any,
      workspaceId: "ws-1",
      authKind: "agent",
    });

    const createActionResponse = await (server as any)._registeredTools.create_action.handler({
      title: "Follow up",
      assigneeMemberId: "member-assignee",
      priority: "Important",
    });
    const updateActionResponse = await (server as any)._registeredTools.update_action.handler({
      actionId: "action-1",
      assigneeMemberId: "member-assignee",
      priority: "Urgent",
    });
    const createTensionResponse = await (server as any)._registeredTools.create_tension.handler({
      title: "No clear owner",
      assigneeMemberId: "member-responsible",
      raisedByMemberId: "member-raiser",
      priority: "Medium",
    });
    const updateTensionResponse = await (server as any)._registeredTools.update_tension.handler({
      tensionId: "tension-1",
      assigneeMemberId: "member-responsible",
      priority: "Important",
    });
    const createProposalResponse = await (server as any)._registeredTools.create_proposal.handler({
      title: "Clarify ownership",
      bodyMd: "Assign an owner before adoption.",
      ownerMemberId: "member-owner",
      priority: "Urgent",
    });
    const updateProposalResponse = await (server as any)._registeredTools.update_proposal.handler({
      proposalId: "proposal-1",
      ownerMemberId: "member-owner",
      priority: "Important",
    });

    expect(vi.mocked(requireScope)).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws-1" }), "actions:write");
    expect(vi.mocked(requireScope)).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws-1" }), "tensions:write");
    expect(vi.mocked(requireScope)).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws-1" }), "proposals:write");
    expect(createActionMock).toHaveBeenCalledWith(expect.objectContaining({ kind: "agent" }), expect.objectContaining({
      workspaceId: "ws-1",
      assigneeMemberId: "member-assignee",
      priority: 2,
    }));
    expect(updateActionMock).toHaveBeenCalledWith(expect.objectContaining({ kind: "agent" }), expect.objectContaining({
      workspaceId: "ws-1",
      actionId: "action-1",
      assigneeMemberId: "member-assignee",
      priority: 3,
    }));
    expect(createTensionMock).toHaveBeenCalledWith(expect.objectContaining({ kind: "agent" }), expect.objectContaining({
      workspaceId: "ws-1",
      assigneeMemberId: "member-responsible",
      raisedByMemberId: "member-raiser",
      priority: 1,
    }));
    expect(updateTensionMock).toHaveBeenCalledWith(expect.objectContaining({ kind: "agent" }), expect.objectContaining({
      workspaceId: "ws-1",
      tensionId: "tension-1",
      assigneeMemberId: "member-responsible",
      priority: 2,
    }));
    expect(createProposalMock).toHaveBeenCalledWith(expect.objectContaining({ kind: "agent" }), expect.objectContaining({
      workspaceId: "ws-1",
      ownerMemberId: "member-owner",
      priority: 3,
    }));
    expect(updateProposalMock).toHaveBeenCalledWith(expect.objectContaining({ kind: "agent" }), expect.objectContaining({
      workspaceId: "ws-1",
      proposalId: "proposal-1",
      ownerMemberId: "member-owner",
      priority: 2,
    }));

    expect(JSON.parse(createActionResponse.content[0].text)).toMatchObject({
      priorityLabel: "Important",
      assigneeMemberId: "member-assignee",
      assigneeMemberName: "Assignee",
      assignee: "Assignee",
      inputRequestCount: 0,
      activeInputRequestCount: 0,
    });
    expect(JSON.parse(updateActionResponse.content[0].text)).toMatchObject({
      priorityLabel: "Urgent",
      assigneeMemberId: "member-assignee",
      assigneeMemberName: "Assignee",
      assignee: "Assignee",
      inputRequestCount: 2,
      activeInputRequestCount: 1,
    });
    expect(JSON.parse(createTensionResponse.content[0].text)).toMatchObject({
      priorityLabel: "Medium",
      responsibleMemberId: "member-responsible",
      responsibleMemberName: "Responsible",
      responsiblePerson: "Responsible",
      raisedByMemberId: "member-raiser",
      raisedByMemberName: "Raiser",
      inputRequestCount: 0,
      activeInputRequestCount: 0,
    });
    expect(JSON.parse(updateTensionResponse.content[0].text)).toMatchObject({
      priorityLabel: "Important",
      responsibleMemberId: "member-responsible",
      responsibleMemberName: "Responsible",
      responsiblePerson: "Responsible",
      inputRequestCount: 3,
      activeInputRequestCount: 2,
    });
    expect(JSON.parse(createProposalResponse.content[0].text)).toMatchObject({
      priorityLabel: "Urgent",
      ownerMemberId: "member-owner",
      ownerMemberName: "Owner",
      owner: "Owner",
    });
    expect(JSON.parse(updateProposalResponse.content[0].text)).toMatchObject({
      priorityLabel: "Important",
      ownerMemberId: "member-owner",
      ownerMemberName: "Owner",
      owner: "Owner",
    });
  });

  it("returns structured duplicate confirmation for MCP create_action and accepts each resolution", async () => {
    const { createCorgtexMcpServer } = await import("./server");
    const { prisma } = await import("@corgtex/shared");
    const duplicateError = {
      status: 409,
      code: "DUPLICATE_GUARD_MATCH",
      candidate: {
        entityType: "Action",
        entityId: "action-existing",
        title: "Send Acme proposal",
        excerpt: null,
        score: 0.91,
        matchKind: "likely",
        reasons: ["similar title", "same assignee"],
        createdAt: "2026-07-20T10:00:00.000Z",
        updatedAt: "2026-07-20T10:05:00.000Z",
      },
      recommendedResolution: "update_existing",
      allowedResolutions: ["use_existing", "update_existing", "create_new"],
    };
    createActionMock
      .mockRejectedValueOnce(duplicateError)
      .mockResolvedValue({
        id: "action-existing",
        title: "Send Acme proposal",
        status: "OPEN",
        version: 2,
        priority: 2,
        assigneeMemberId: "member-assignee",
      });
    vi.mocked(prisma.action.findFirst).mockResolvedValue({
      id: "action-existing",
      title: "Send Acme proposal",
      status: "OPEN",
      version: 2,
      priority: 2,
      assigneeMemberId: "member-assignee",
      assigneeMember: { id: "member-assignee", user: { displayName: "Assignee", email: "assignee@example.test" } },
    } as never);

    const server = createCorgtexMcpServer({
      actor: { kind: "agent", authProvider: "bootstrap" } as any,
      workspaceId: "ws-1",
      authKind: "agent",
    });

    const confirmationResponse = await (server as any)._registeredTools.create_action.handler({
      title: "Send proposal to Acme",
      assigneeMemberId: "member-assignee",
    });

    expect(JSON.parse(confirmationResponse.content[0].text)).toMatchObject({
      status: "duplicate_confirmation_required",
      candidate: expect.objectContaining({ entityId: "action-existing" }),
      recommendedResolution: "update_existing",
      allowedResolutions: ["use_existing", "update_existing", "create_new"],
    });

    for (const resolution of ["use_existing", "update_existing", "create_new"] as const) {
      await (server as any)._registeredTools.create_action.handler({
        title: "Send proposal to Acme",
        assigneeMemberId: "member-assignee",
        duplicateResolution: resolution,
        duplicateTargetEntityId: "action-existing",
      });
    }

    expect(createActionMock).toHaveBeenNthCalledWith(2, expect.objectContaining({ kind: "agent" }), expect.objectContaining({
      duplicateGuard: { resolution: "use_existing", targetEntityId: "action-existing" },
    }));
    expect(createActionMock).toHaveBeenNthCalledWith(3, expect.objectContaining({ kind: "agent" }), expect.objectContaining({
      duplicateGuard: { resolution: "update_existing", targetEntityId: "action-existing" },
    }));
    expect(createActionMock).toHaveBeenNthCalledWith(4, expect.objectContaining({ kind: "agent" }), expect.objectContaining({
      duplicateGuard: { resolution: "create_new", targetEntityId: "action-existing" },
    }));
  });

  it("returns structured duplicate confirmation for MCP transcript uploads and accepts a retry resolution", async () => {
    const { createCorgtexMcpServer } = await import("./server");
    const duplicateError = {
      status: 409,
      code: "DUPLICATE_GUARD_MATCH",
      candidate: {
        entityType: "Meeting",
        entityId: "meeting-existing",
        title: "Weekly Review",
        excerpt: "Transcript body",
        score: 0.93,
        matchKind: "likely",
        reasons: ["similar content"],
        status: "COMPLETED",
        createdAt: "2026-07-20T10:00:00.000Z",
        updatedAt: "2026-07-20T10:05:00.000Z",
        archivedAt: null,
      },
      recommendedResolution: "update_existing",
      allowedResolutions: ["use_existing", "update_existing", "create_new"],
    };
    intakeMeetingTranscriptMock
      .mockRejectedValueOnce(duplicateError)
      .mockResolvedValueOnce({
        status: "meeting_created",
        meeting: {
          id: "meeting-existing",
          title: "Weekly Review",
          recordedAt: new Date("2026-07-20T10:00:00.000Z"),
        },
      });

    const server = createCorgtexMcpServer({
      actor: { kind: "agent", authProvider: "bootstrap" } as any,
      workspaceId: "ws-1",
      authKind: "agent",
    });

    const confirmationResponse = await (server as any)._registeredTools.upload_meeting.handler({
      title: "Weekly Review",
      source: "manual-upload",
      recordedAt: "2026-07-20T10:00:00.000Z",
      transcript: "Transcript body",
    });

    expect(JSON.parse(confirmationResponse.content[0].text)).toMatchObject({
      status: "duplicate_confirmation_required",
      candidate: expect.objectContaining({ entityId: "meeting-existing" }),
      recommendedResolution: "update_existing",
    });

    await (server as any)._registeredTools.upload_meeting.handler({
      title: "Weekly Review",
      source: "manual-upload",
      recordedAt: "2026-07-20T10:00:00.000Z",
      transcript: "Transcript body",
      duplicateResolution: "update_existing",
      duplicateTargetEntityId: "meeting-existing",
    });

    expect(intakeMeetingTranscriptMock).toHaveBeenNthCalledWith(2, expect.objectContaining({ kind: "agent" }), expect.objectContaining({
      duplicateGuard: { resolution: "update_existing", targetEntityId: "meeting-existing" },
    }));
  });

  it("returns structured duplicate confirmation for MCP create_article and accepts a retry resolution", async () => {
    const { createCorgtexMcpServer } = await import("./server");
    const duplicateError = {
      status: 409,
      code: "DUPLICATE_GUARD_MATCH",
      candidate: {
        entityType: "BrainArticle",
        entityId: "article-existing",
        title: "Incident review policy",
        excerpt: "Incident reviews are references.",
        score: 1,
        matchKind: "exact",
        reasons: ["identical title and content"],
        status: "DRAFT",
        createdAt: "2026-07-20T10:00:00.000Z",
        updatedAt: "2026-07-20T10:05:00.000Z",
        archivedAt: null,
      },
      recommendedResolution: "use_existing",
      allowedResolutions: ["use_existing", "update_existing", "create_new"],
    };
    createArticleMock
      .mockRejectedValueOnce(duplicateError)
      .mockResolvedValueOnce({
        id: "article-existing",
        slug: "incident-review-policy",
        type: "PROCESS",
      });

    const server = createCorgtexMcpServer({
      actor: { kind: "agent", authProvider: "bootstrap" } as any,
      workspaceId: "ws-1",
      authKind: "agent",
    });

    const confirmationResponse = await (server as any)._registeredTools.create_article.handler({
      title: "Incident review policy",
      type: "PROCESS",
      bodyMd: "Incident reviews are references.",
    });

    expect(JSON.parse(confirmationResponse.content[0].text)).toMatchObject({
      status: "duplicate_confirmation_required",
      candidate: expect.objectContaining({ entityId: "article-existing" }),
      recommendedResolution: "use_existing",
    });

    await (server as any)._registeredTools.create_article.handler({
      title: "Incident review policy",
      type: "PROCESS",
      bodyMd: "Incident reviews are references.",
      duplicateResolution: "use_existing",
      duplicateTargetEntityId: "article-existing",
    });

    expect(createArticleMock).toHaveBeenNthCalledWith(2, expect.objectContaining({ kind: "agent" }), expect.objectContaining({
      duplicateGuard: { resolution: "use_existing", targetEntityId: "article-existing" },
    }));
  });

  it("omits ownerMemberId from MCP create_proposal input so the domain default applies", async () => {
    const { createCorgtexMcpServer } = await import("./server");
    const { prisma } = await import("@corgtex/shared");

    vi.mocked(prisma.proposal.findFirst).mockResolvedValueOnce({
      id: "proposal-1",
      title: "Clarify ownership",
      status: "DRAFT",
      version: 1,
      priority: 0,
      ownerMemberId: "member-default",
      ownerMember: { id: "member-default", user: { displayName: "Default Owner", email: "default@example.test" } },
    } as never);

    const server = createCorgtexMcpServer({
      actor: { kind: "agent", authProvider: "bootstrap" } as any,
      workspaceId: "ws-1",
      authKind: "agent",
    });

    const response = await (server as any)._registeredTools.create_proposal.handler({
      title: "Clarify ownership",
      bodyMd: "Assign an owner before adoption.",
    });

    expect(createProposalMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "agent" }),
      expect.not.objectContaining({ ownerMemberId: expect.anything() }),
    );
    expect(JSON.parse(response.content[0].text)).toMatchObject({
      ownerMemberId: "member-default",
      ownerMemberName: "Default Owner",
      owner: "Default Owner",
    });
  });

  it("keeps MCP get_proposal advice counts aligned with list responses", async () => {
    const { createCorgtexMcpServer } = await import("./server");
    const { requireScope } = await import("./auth");
    const { prisma } = await import("@corgtex/shared");

    vi.mocked(prisma.proposal.findFirst).mockResolvedValueOnce({
      id: "proposal-1",
      title: "Clarify ownership",
      status: "DRAFT",
      version: 1,
      priority: 2,
      ownerMemberId: "member-owner",
      ownerMember: { id: "member-owner", user: { displayName: "Owner", email: "owner@example.test" } },
      adviceProcess: {
        requests: [
          { status: "ACTIVE" },
          { status: "RESOLVED" },
        ],
      },
    } as never);

    const server = createCorgtexMcpServer({
      actor: { kind: "agent", authProvider: "bootstrap" } as any,
      workspaceId: "ws-1",
      authKind: "agent",
    });

    const response = await (server as any)._registeredTools.get_proposal.handler({
      proposalId: "proposal-1",
    });

    expect(vi.mocked(requireScope)).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws-1" }), "proposals:read");
    expect(prisma.proposal.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      include: expect.objectContaining({
        adviceProcess: {
          include: {
            requests: {
              select: { status: true },
            },
          },
        },
      }),
    }));
    expect(JSON.parse(response.content[0].text)).toMatchObject({
      adviceRequestCount: 2,
      activeAdviceRequestCount: 1,
      inputRequestCount: 2,
      activeInputRequestCount: 1,
    });
  });

  it("classifies MCP member kind instead of trusting stale stored kind", async () => {
    const { createCorgtexMcpServer } = await import("./server");
    const { requireScope } = await import("./auth");
    const { listMembers } = await import("@corgtex/domain");

    vi.mocked(listMembers).mockResolvedValueOnce([
      {
        id: "member-system",
        role: "MEMBER",
        kind: "HUMAN",
        isActive: true,
        joinedAt: new Date("2026-07-17T00:00:00.000Z"),
        user: {
          displayName: "Corgtex Support",
          email: "support+corgtex@example.test",
        },
      },
    ] as never);

    const server = createCorgtexMcpServer({
      actor: { kind: "agent", authProvider: "bootstrap" } as any,
      workspaceId: "ws-1",
      authKind: "agent",
    });

    const response = await (server as any)._registeredTools.list_members.handler({});

    expect(vi.mocked(requireScope)).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws-1" }), "members:read");
    expect(JSON.parse(response.content[0].text)).toMatchObject({
      members: [
        {
          id: "member-system",
          kind: "SYSTEM",
        },
      ],
    });
  });

  it("returns the created goal identifier from create_goal", async () => {
    const { createCorgtexMcpServer } = await import("./server");
    const { requireScope } = await import("./auth");

    const server = createCorgtexMcpServer({
      actor: { kind: "agent", authProvider: "bootstrap" } as any,
      workspaceId: "ws-1",
      authKind: "agent",
    });

    const createGoalTool = (server as any)._registeredTools.create_goal;
    const response = await createGoalTool.handler({
      title: "Transform 1,000 businesses",
      cadence: "TEN_YEAR",
      keyResults: [{ title: "Acquire first pilot", targetValue: 1, currentValue: 0 }],
    });

    expect(createGoalMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "agent" }),
      expect.objectContaining({
        workspaceId: "ws-1",
        title: "Transform 1,000 businesses",
        cadence: "TEN_YEAR",
        keyResults: [{ title: "Acquire first pilot", targetValue: 1, currentValue: 0 }],
      }),
    );
    expect(vi.mocked(requireScope)).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws-1" }),
      "goals:write",
    );
    expect(JSON.parse(response.content[0].text)).toEqual({
      id: "goal-1",
      title: "Transform 1,000 businesses",
      status: "ACTIVE",
      ownerMemberId: "member-owner",
      ownerMemberName: null,
      webUrl: "https://app.test/workspaces/ws-1/goals?view=tree&cadence=TEN_YEAR",
      permanentUrl: null,
    });
  });

  it("registers goal read, update, and archive tools with scopes and URLs", async () => {
    const { createCorgtexMcpServer } = await import("./server");
    const { requireScope } = await import("./auth");

    listGoalsMock.mockResolvedValueOnce([{
      id: "goal-1",
      title: "Quarterly traction",
      cadence: "QUARTERLY",
      level: "COMPANY",
      status: "ACTIVE",
      progressPercent: 20,
      circle: null,
      ownerMember: null,
      keyResults: [],
    }]);
    getGoalMock.mockResolvedValueOnce({ id: "goal-1", cadence: "QUARTERLY", title: "Quarterly traction" });
    updateGoalMock.mockResolvedValueOnce({ id: "goal-1", status: "ON_TRACK", cadence: "QUARTERLY" });

    const server = createCorgtexMcpServer({
      actor: { kind: "agent", authProvider: "bootstrap" } as any,
      workspaceId: "ws-1",
      authKind: "agent",
    });

    const listResponse = await (server as any)._registeredTools.list_goals.handler({ cadence: "QUARTERLY" });
    const getResponse = await (server as any)._registeredTools.get_goal.handler({ goalId: "goal-1" });
    const updateResponse = await (server as any)._registeredTools.update_goal.handler({ goalId: "goal-1", status: "ON_TRACK" });
    const archiveResponse = await (server as any)._registeredTools.archive_goal.handler({ goalId: "goal-1" });

    expect(vi.mocked(requireScope)).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws-1" }), "goals:read");
    expect(vi.mocked(requireScope)).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws-1" }), "goals:write");
    expect(JSON.parse(listResponse.content[0].text).items[0].webUrl).toBe("https://app.test/workspaces/ws-1/goals?view=tree&cadence=QUARTERLY");
    expect(JSON.parse(listResponse.content[0].text).items[0]).not.toHaveProperty("priorityLabel");
    expect(JSON.parse(getResponse.content[0].text).webUrl).toBe("https://app.test/workspaces/ws-1/goals?view=tree&cadence=QUARTERLY");
    expect(JSON.parse(getResponse.content[0].text)).not.toHaveProperty("priorityLabel");
    expect(JSON.parse(updateResponse.content[0].text)).toEqual({
      id: "goal-1",
      status: "ON_TRACK",
      ownerMemberId: null,
      ownerMemberName: null,
      webUrl: "https://app.test/workspaces/ws-1/goals?view=tree&cadence=QUARTERLY",
    });
    expect(JSON.parse(archiveResponse.content[0].text)).toEqual({
      id: "goal-1",
      archived: true,
      webUrl: "https://app.test/workspaces/ws-1/audit?tab=archive",
    });
  });

  it("upserts a shared tool link without returning credential material", async () => {
    const { createCorgtexMcpServer } = await import("./server");
    const { requireScope } = await import("./auth");

    const server = createCorgtexMcpServer({
      actor: { kind: "agent", authProvider: "bootstrap" } as any,
      workspaceId: "ws-1",
      authKind: "agent",
    });

    const upsertTool = (server as any)._registeredTools.upsert_tool_link;
    const response = await upsertTool.handler({
      title: "Miro board",
      url: "https://miro.com/app/board/example",
      category: "WHITEBOARD",
      credentialLabel: "Board password",
      credentialSecret: "replace with access code",
    });

    expect(upsertWorkspaceToolLinkMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "agent" }),
      expect.objectContaining({
        workspaceId: "ws-1",
        title: "Miro board",
        url: "https://miro.com/app/board/example",
        category: "WHITEBOARD",
        credentialLabel: "Board password",
        credentialSecret: "replace with access code",
      }),
    );
    expect(vi.mocked(requireScope)).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws-1" }),
      "tools:write",
    );
    expect(JSON.parse(response.content[0].text)).toEqual({
      id: "tool-1",
      title: "Miro board",
      hasCredential: true,
      webUrl: "https://app.test/workspaces/ws-1/tools",
    });
    expect(response.content[0].text).not.toContain("replace with access code");
  });

  it("reveals tool link credentials through a separate sensitive scoped tool", async () => {
    const { createCorgtexMcpServer } = await import("./server");
    const { requireScope } = await import("./auth");

    const actor = {
      kind: "user",
      user: { id: "user-1", email: "user@example.com", displayName: "User" },
    } as any;
    const server = createCorgtexMcpServer({
      actor,
      workspaceId: "ws-1",
      authKind: "oauth",
      scopes: ["tools:credentials:read"],
    });

    const revealTool = (server as any)._registeredTools.reveal_tool_link_credential;
    const response = await revealTool.handler({ toolLinkId: "tool-1" });

    expect(revealWorkspaceToolLinkCredentialMock).toHaveBeenCalledWith(
      actor,
      { workspaceId: "ws-1", toolLinkId: "tool-1" },
    );
    expect(vi.mocked(requireScope)).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws-1" }),
      "tools:credentials:read",
    );
    expect(JSON.parse(response.content[0].text)).toEqual({
      toolLinkId: "tool-1",
      credentialLabel: "Board password",
      credentialSecret: "board-pass",
    });
  });

  it("rejects support-only tools from OAuth user sessions even when support scope is present", async () => {
    const { createCorgtexMcpServer } = await import("./server");

    const server = createCorgtexMcpServer({
      actor: {
        kind: "user",
        user: { id: "user-1", email: "user@example.com", displayName: "User" },
      } as any,
      workspaceId: "ws-1",
      authKind: "oauth",
      scopes: ["support:write"],
    });

    await expect((server as any)._registeredTools.record_support_audit.handler({
      action: "support.test",
      reason: "Regression",
      operationId: "operation-1",
    })).rejects.toMatchObject({
      status: 403,
      code: "FORBIDDEN",
    });
  });

  it("passes the real actor into MCP chat instead of falling back to a bootstrap agent", async () => {
    const { createCorgtexMcpServer } = await import("./server");
    const { processConversationTurn } = await import("@corgtex/agents");

    const actor = {
      kind: "user",
      user: { id: "user-1", email: "user@example.com", displayName: "User" },
    } as any;
    vi.mocked(processConversationTurn).mockResolvedValueOnce({
      assistantMessage: "done",
      contextUsed: {},
    } as any);

    const server = createCorgtexMcpServer({
      actor,
      workspaceId: "ws-1",
      authKind: "oauth",
      scopes: ["conversations:write"],
    });

    await (server as any)._registeredTools.chat.handler({ message: "show tools" });

    expect(processConversationTurn).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "ws-1",
      sessionId: "mcp-ws-1-user-1",
      userId: "user-1",
      userMessage: "show tools",
      actor,
    }));
  });

  it("lists same-user connected external tools with external tool scope", async () => {
    const { createCorgtexMcpServer } = await import("./server");
    const { requireScope } = await import("./auth");
    listExternalMcpConnectionsMock.mockResolvedValueOnce([
      {
        providerKey: "notion",
        displayName: "Notion",
        status: "connected",
        connectionId: "connection-1",
        connectionOwnerUserId: "user-1",
        scopes: ["search"],
        capabilities: { searchToolName: "notion-search" },
      },
    ]);

    const actor = {
      kind: "user",
      user: { id: "user-1", email: "user@example.com", displayName: "User" },
    } as any;
    const server = createCorgtexMcpServer({
      actor,
      workspaceId: "ws-1",
      authKind: "oauth",
      scopes: ["external-tools:read"],
    });

    const response = await (server as any)._registeredTools.list_connected_tools.handler({});

    expect(vi.mocked(requireScope)).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws-1" }), "external-tools:read");
    expect(listExternalMcpConnectionsMock).toHaveBeenCalledWith(actor, "ws-1");
    expect(JSON.parse(response.content[0].text).items[0]).toEqual(expect.objectContaining({
      providerKey: "notion",
      status: "connected",
    }));
    expect((server as any)._registeredTools.list_connected_tools.annotations).toMatchObject({
      readOnlyHint: true,
      openWorldHint: true,
    });
  });

  it("lists installed marketplace apps and returns app routing guidance", async () => {
    const { createCorgtexMcpServer } = await import("./server");
    const { requireScope } = await import("./auth");
    listInstalledAppsMock.mockResolvedValueOnce({
      installed: [{
        id: "app-1",
        appKey: "finance-suite",
        title: "Finance Suite",
        category: "FINANCE",
        installationStatus: "INSTALLED",
      }],
      available: [],
    });
    getAppRoutingGuidanceMock.mockResolvedValueOnce({
      routing: "APP_MCP",
      target: { appKey: "finance-suite", title: "Finance Suite" },
      guidance: "Use Finance Suite MCP for structured finance writes.",
      corgtexDoesNotProxyWrites: true,
    });

    const actor = {
      kind: "user",
      user: { id: "user-1", email: "user@example.com", displayName: "User" },
    } as any;
    const server = createCorgtexMcpServer({
      actor,
      workspaceId: "ws-1",
      authKind: "oauth",
      scopes: ["tools:read"],
    });

    const listResponse = await (server as any)._registeredTools.list_installed_apps.handler({});
    const guidanceResponse = await (server as any)._registeredTools.get_app_routing_guidance.handler({
      intent: "save these expenses from a statement",
    });

    expect(vi.mocked(requireScope)).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws-1" }), "tools:read");
    expect(listInstalledAppsMock).toHaveBeenCalledWith(actor, { workspaceId: "ws-1" });
    expect(getAppRoutingGuidanceMock).toHaveBeenCalledWith(actor, {
      workspaceId: "ws-1",
      intent: "save these expenses from a statement",
      recordType: undefined,
    });
    expect(JSON.parse(listResponse.content[0].text).installed[0]).toEqual(expect.objectContaining({
      appKey: "finance-suite",
    }));
    expect(JSON.parse(guidanceResponse.content[0].text)).toEqual(expect.objectContaining({
      routing: "APP_MCP",
      corgtexDoesNotProxyWrites: true,
    }));
    expect((server as any)._registeredTools.get_app_routing_guidance.annotations).toMatchObject({
      readOnlyHint: true,
      openWorldHint: true,
    });
  });

  it("returns app connection instructions and can request app install", async () => {
    const { createCorgtexMcpServer } = await import("./server");
    const { requireScope } = await import("./auth");
    const actor = {
      kind: "user",
      user: { id: "user-1", email: "user@example.com", displayName: "User" },
    } as any;
    const server = createCorgtexMcpServer({
      actor,
      workspaceId: "ws-1",
      authKind: "oauth",
      scopes: ["tools:read", "tools:write"],
    });

    const instructionsResponse = await (server as any)._registeredTools.get_app_connection_instructions.handler({
      appKey: "finance-suite",
    });
    const requestResponse = await (server as any)._registeredTools.request_app_install.handler({
      appKey: "finance-suite",
      reasonMd: "Need expense intake.",
    });

    expect(vi.mocked(requireScope)).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws-1" }), "tools:read");
    expect(vi.mocked(requireScope)).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws-1" }), "tools:write");
    expect(getAppConnectionInstructionsMock).toHaveBeenCalledWith(actor, {
      workspaceId: "ws-1",
      catalogItemId: undefined,
      appKey: "finance-suite",
    });
    expect(requestAppInstallMock).toHaveBeenCalledWith(actor, {
      workspaceId: "ws-1",
      catalogItemId: undefined,
      appKey: "finance-suite",
      reasonMd: "Need expense intake.",
    });
    expect(JSON.parse(instructionsResponse.content[0].text).app.title).toBe("Finance Suite");
    expect(JSON.parse(requestResponse.content[0].text).request.status).toBe("PENDING");
  });

  it("invokes installed app tools through Corgtex app governance", async () => {
    const { createCorgtexMcpServer } = await import("./server");
    const { requireScope } = await import("./auth");
    const actor = {
      kind: "user",
      user: { id: "user-1", email: "user@example.com", displayName: "User" },
    } as any;
    const server = createCorgtexMcpServer({
      actor,
      workspaceId: "ws-1",
      authKind: "oauth",
      scopes: ["tools:write", "finance:write"],
    });

    const response = await (server as any)._registeredTools.invoke_installed_app_tool.handler({
      surface: "FINANCE",
      toolName: "create_expenses",
      arguments: { expenses: [{ amountCents: 4200 }] },
    });

    expect(vi.mocked(requireScope)).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws-1" }), "tools:write");
    expect(vi.mocked(requireScope)).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws-1" }), "finance:write");
    expect(invokeInstalledAppToolMock).toHaveBeenCalledWith(actor, {
      workspaceId: "ws-1",
      appKey: undefined,
      surface: "FINANCE",
      toolName: "create_expenses",
      arguments: { expenses: [{ amountCents: 4200 }] },
      requiredScopes: ["finance:write"],
    });
    expect(JSON.parse(response.content[0].text)).toEqual(expect.objectContaining({
      appKey: "finance-suite",
      toolName: "create_expenses",
      webUrl: "https://app.test/workspaces/ws-1/finance",
    }));
    expect((server as any)._registeredTools.invoke_installed_app_tool.annotations).toMatchObject({
      readOnlyHint: false,
      openWorldHint: true,
    });
  });

  it("searches connected Corgtex and external context with provenance", async () => {
    const { createCorgtexMcpServer } = await import("./server");
    const { requireScope } = await import("./auth");
    searchIndexedKnowledgeMock.mockResolvedValueOnce([
      {
        chunkId: "chunk-1",
        title: "Corgtex rollout",
        sourceType: "BrainArticle",
        sourceId: "article-1",
        chunkIndex: 0,
        score: 0.91,
        snippet: "Corgtex source",
      },
    ]);
    searchConnectedExternalMcpContextMock.mockResolvedValueOnce({
      results: [
        {
          id: "notion:page-1",
          source: "external_mcp",
          providerKey: "notion",
          providerDisplayName: "Notion",
          externalId: "page-1",
          title: "Notion rollout",
          text: "Notion source",
        },
      ],
      errors: [],
    });

    const actor = {
      kind: "user",
      user: { id: "user-1", email: "user@example.com", displayName: "User" },
    } as any;
    const server = createCorgtexMcpServer({
      actor,
      workspaceId: "ws-1",
      authKind: "oauth",
      scopes: ["external-tools:read", "brain:read"],
    });

    const response = await (server as any)._registeredTools.search_connected_context.handler({
      query: "rollout",
      limit: 5,
    });
    const body = JSON.parse(response.content[0].text);

    expect(vi.mocked(requireScope)).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws-1" }), "external-tools:read");
    expect(vi.mocked(requireScope)).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws-1" }), "brain:read");
    expect(body.results).toEqual([
      expect.objectContaining({
        id: "corgtex:chunk-1",
        source: "corgtex",
        providerDisplayName: "Corgtex Brain",
      }),
      expect.objectContaining({
        id: "notion:page-1",
        source: "external_mcp",
        providerDisplayName: "Notion",
      }),
    ]);
    expect(body.externalErrors).toEqual([]);
  });

  it("executes external tools through delegated policy and scope enforcement", async () => {
    const { createCorgtexMcpServer } = await import("./server");
    const { requireScope } = await import("./auth");
    executeExternalMcpToolMock.mockResolvedValueOnce({
      skipped: false,
      providerKey: "notion",
      toolName: "notion-create-page",
      result: { id: "page-1" },
    });

    const actor = {
      kind: "user",
      user: { id: "user-1", email: "user@example.com", displayName: "User" },
    } as any;
    const server = createCorgtexMcpServer({
      actor,
      workspaceId: "ws-1",
      authKind: "oauth",
      scopes: ["external-tools:write"],
    });

    const response = await (server as any)._registeredTools.execute_external_tool.handler({
      providerKey: "notion",
      toolName: "notion-create-page",
      arguments: { title: "Decision log" },
      confidence: 0.95,
    });

    expect(vi.mocked(requireScope)).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws-1" }), "external-tools:write");
    expect(executeExternalMcpToolMock).toHaveBeenCalledWith(actor, {
      workspaceId: "ws-1",
      providerKey: "notion",
      toolName: "notion-create-page",
      arguments: { title: "Decision log" },
      operation: undefined,
      confidence: 0.95,
      explicitUserIntent: false,
    });
    expect(JSON.parse(response.content[0].text)).toEqual(expect.objectContaining({
      skipped: false,
      providerKey: "notion",
      toolName: "notion-create-page",
    }));
    expect((server as any)._registeredTools.execute_external_tool.annotations).toMatchObject({
      readOnlyHint: false,
      openWorldHint: true,
    });
  });
});
