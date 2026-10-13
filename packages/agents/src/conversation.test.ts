import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import type { AppActor } from "@corgtex/shared";

const {
  assertCatalogModelBudgetMock,
  applyContextGraphProposedDiffMock,
  buildSelectedRegionContextMock,
  buildRoleOnboardingContextForConversationMock,
  checkBudgetMock,
  chatEventStreamMock,
  chatMock,
  chatStreamMock,
  completeActivityMock,
  conversationPendingOperationCreateMock,
  conversationPendingOperationCountMock,
  conversationPendingOperationFindFirstMock,
  conversationPendingOperationFindUniqueMock,
  conversationPendingOperationStore,
  conversationPendingOperationUpdateManyMock,
  conversationPendingOperationUpdateMock,
  conversationTurnFindManyMock,
  createActivityMock,
  createCommunicationSuggestionMock,
  createContextGraphProposedDiffMock,
  executeExternalMcpToolMock,
  fetchConnectedExternalMcpContextMock,
  getContextMapDataMock,
  listCrmActivitiesMock,
  listExternalMcpConnectionsMock,
  listGoalsMock,
  listWorkspaceToolLinksMock,
  loadRelevantMemoriesMock,
  resolveKnowledgeAccessDomainsMock,
  searchConnectedExternalMcpContextMock,
  storeAgentMemoryMock,
  workspaceFeatureFlagFindManyMock,
} = vi.hoisted(() => ({
  assertCatalogModelBudgetMock: vi.fn(),
  applyContextGraphProposedDiffMock: vi.fn(),
  buildSelectedRegionContextMock: vi.fn(),
  buildRoleOnboardingContextForConversationMock: vi.fn(),
  checkBudgetMock: vi.fn(),
  chatEventStreamMock: vi.fn(),
  chatMock: vi.fn(),
  chatStreamMock: vi.fn(),
  completeActivityMock: vi.fn(),
  conversationPendingOperationCreateMock: vi.fn(),
  conversationPendingOperationCountMock: vi.fn(),
  conversationPendingOperationFindFirstMock: vi.fn(),
  conversationPendingOperationFindUniqueMock: vi.fn(),
  conversationPendingOperationStore: [] as any[],
  conversationPendingOperationUpdateManyMock: vi.fn(),
  conversationPendingOperationUpdateMock: vi.fn(),
  conversationTurnFindManyMock: vi.fn(),
  createActivityMock: vi.fn(),
  createCommunicationSuggestionMock: vi.fn(),
  createContextGraphProposedDiffMock: vi.fn(),
  executeExternalMcpToolMock: vi.fn(),
  fetchConnectedExternalMcpContextMock: vi.fn(),
  getContextMapDataMock: vi.fn(),
  listCrmActivitiesMock: vi.fn(),
  listExternalMcpConnectionsMock: vi.fn(),
  listGoalsMock: vi.fn(),
  listWorkspaceToolLinksMock: vi.fn(),
  loadRelevantMemoriesMock: vi.fn(),
  resolveKnowledgeAccessDomainsMock: vi.fn(),
  searchConnectedExternalMcpContextMock: vi.fn(),
  storeAgentMemoryMock: vi.fn(),
  workspaceFeatureFlagFindManyMock: vi.fn(),
}));

vi.mock("@corgtex/shared", () => ({
  getSupportAuthorizationContext: vi.fn().mockReturnValue(undefined),
  env: {
    MODEL_CHAT_CONVERSATION: "chat-model",
    MODEL_PROVIDER: "openai_compatible",
  },
  prisma: {
    $transaction: vi.fn(async (work) => work((await import("@corgtex/shared")).prisma)),
    $executeRaw: vi.fn().mockResolvedValue(1),
    $queryRaw: vi.fn().mockResolvedValue([]),
    conversationSession: { findFirst: vi.fn(async ({ where }) => ({ id: where.id, workspaceId: where.workspaceId, userId: where.userId, agentKey: where.agentKey })) },
    agentCredential: { findFirst: vi.fn() },
    modelUsage: { count: vi.fn(), findMany: vi.fn() },
    conversationTurn: {
      findMany: conversationTurnFindManyMock,
    },
    auditLog: { findFirst: vi.fn().mockResolvedValue(null), update: vi.fn() },
    tension: { findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0) },
    action: { findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0) },
    proposal: { findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0) },
    goal: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
    member: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
    circle: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
    crmActivity: { findFirst: vi.fn(async () => {
      const args = createActivityMock.mock.calls.at(-1)?.[1] ?? {};
      const result = await createActivityMock.mock.results.at(-1)?.value;
      return result ? { ...args, ...result, bodyMd: result.bodyMd ?? args.bodyMd ?? null, dueAt: result.dueAt ?? args.dueAt ?? null,
        actorUserId: "user-1", source: "workspace-chat", createdAt: new Date() } : null;
    }) },
    artifactInputSnapshot: { findFirst: vi.fn(async ({ where }) => ({ ...where, id: "snapshot-fixture" })) },
    conversationPendingOperation: {
      create: conversationPendingOperationCreateMock,
      count: conversationPendingOperationCountMock,
      findFirst: conversationPendingOperationFindFirstMock,
      findMany: vi.fn(async ({ where }) => conversationPendingOperationStore.filter(item => item.workspaceId === where.workspaceId && item.idempotencyKey.startsWith(where.idempotencyKey.startsWith))),
      findUnique: conversationPendingOperationFindUniqueMock,
      update: conversationPendingOperationUpdateMock,
      updateMany: conversationPendingOperationUpdateManyMock,
    },
    brainArticle: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
    oAuthConnection: {
      findFirst: vi.fn(),
    },
    workspaceFeatureFlag: {
      findMany: workspaceFeatureFlagFindManyMock,
    },
  },
}));

vi.mock("@corgtex/knowledge", () => ({
  searchIndexedKnowledge: vi.fn().mockResolvedValue([]),
  getKnowledgeSearchInputRoots: vi.fn().mockResolvedValue([{ kind: "Workspace", id: "ws-1", fingerprint: "a".repeat(64) }]),
}));


vi.mock("./conversation-inputs", async () => {
  const shared = await import("@corgtex/shared");
  const domain = await import("@corgtex/domain");
  const collector = { roots: async () => [{ kind: "Workspace", id: "ws-1", fingerprint: "a".repeat(64) }],
    assertReadable: async () => {}, admitRecords: async (_kind: unknown, rows: unknown[]) => rows,
    admitKnowledgeResults: async (rows: unknown[]) => rows,
    capture: async () => {}, captureTrusted: async () => {}, addReceipt: async () => {}, preserveConsumedRevisions: async () => {} };
  return {
    prepareConversationInputs: async (ctx: any) => {
      await domain.requireWorkspaceMembership({ actor: ctx.actor, workspaceId: ctx.workspaceId });
      return { collector: { ...collector, assertReadable: () => domain.requireWorkspaceMembership({ actor: ctx.actor, workspaceId: ctx.workspaceId }) },
        promptInputId: "prompt-fixture", pageContext: ctx.pageContext ?? null, systemPrompt: ctx.systemPrompt ?? null };
    },
    loadConversationHistory: async (_actor: unknown, _ws: string, sessionId: string, limit: number) => (await shared.prisma.conversationTurn.findMany({
      where: { conversationId: sessionId }, orderBy: { sequenceNumber: "desc" }, take: limit })).reverse(),
    loadConversationOnboarding: async (workspaceId: string, conversationId: string, userId: string) => domain.buildRoleOnboardingContextForConversation({ workspaceId, conversationId, userId }),
  };
});

vi.mock("@corgtex/models", async (importOriginal) => ({
  ...await importOriginal<typeof import("@corgtex/models")>(),
  assertCatalogModelBudget: assertCatalogModelBudgetMock,
  defaultModelGateway: { chat: chatMock, chatEventStream: chatEventStreamMock, chatStream: chatStreamMock },
}));

vi.mock("@corgtex/domain", async () => ({
  sealArtifactInputActor: (await import("../../domain/src/source-lineage")).sealArtifactInputActor,
  mergeArtifactInputProofs: (await import("../../domain/src/digest-lineage")).mergeArtifactInputProofs,
  // Orchestration fixtures model already-admitted SQL inputs. Full permission,
  // provenance and revocation behavior is exercised in conversation.provenance.
  withArtifactInputWriteFence: (_fence: unknown, work: () => Promise<unknown>) => work(),
  // This orchestration suite mocks source proofs; actual transaction/permission
  // publication is covered by pending-crm-operations.integration.test.ts.
  withAdditionalArtifactInputWriteFence: (_fence: unknown, work: () => Promise<unknown>) => work(),
  prepareArtifactCommitPreflight: vi.fn().mockResolvedValue(Object.freeze({})),
  withArtifactCommitPreflight: async (_actor: unknown, _ws: string, _tx: unknown, _roots: unknown, _token: unknown, work: () => Promise<unknown>) => work(),
  withArtifactInputReadCapture: async (_actor: unknown, _ws: string, read: () => Promise<unknown>) => ({ value: await read(), roots: [{ kind: "Workspace", id: "ws-1", fingerprint: "a".repeat(64) }] }),
  captureConversationInputReceipt: vi.fn(async () => ({})),
  captureArtifactInputProof: vi.fn().mockResolvedValue([{ kind: "Workspace", id: "ws-1", fingerprint: "a".repeat(64) }, { kind: "ArtifactInputSnapshot", id: "snapshot-fixture", fingerprint: "a".repeat(64) }]),
  captureImmutableArtifactInputProof: vi.fn(async (_actor, _ws, roots) => [...roots, { kind: "ArtifactInputSnapshot", id: "snapshot-fixture", fingerprint: "a".repeat(64) }]),
  captureArtifactInputSnapshotProof: vi.fn(async () => [{ kind: "ArtifactInputSnapshot", id: "snapshot-fixture", fingerprint: "a".repeat(64) }]),
  currentArtifactInputRoots: vi.fn(async () => [{ kind: "Workspace", id: "ws-1", fingerprint: "a".repeat(64) }]),
  isArtifactInputProofReadable: vi.fn().mockResolvedValue(true),
  lineageContentFingerprint: vi.fn().mockReturnValue("a".repeat(64)),
  recordArtifactInputLineage: vi.fn().mockResolvedValue(undefined),
  assertArtifactInputWriteFence: vi.fn().mockResolvedValue(undefined),
  scanSourceReadableRecords: vi.fn(async ({ load }) => load(undefined, 5001)),
  captureReadableDigestInputs: vi.fn(async ({ records }) => ({ records: records.filter(Boolean), roots: [{ kind: "Workspace", id: "ws-1", fingerprint: "a".repeat(64) }] })),
  getWorkspaceToolLinkInputRoots: vi.fn().mockResolvedValue([{ kind: "Workspace", id: "ws-1", fingerprint: "a".repeat(64) }]),
  duplicateGuardErrorPayload: vi.fn(),
  isDuplicateGuardMatchError: vi.fn().mockReturnValue(false),
  readableArtifactIds: vi.fn(async (_actor, _ws, _kind, rows) => new Set(rows.map((row: any) => row.id))),
  ...await import("../../domain/src/agent-operation-capabilities"),
  requireWorkspaceOperation: vi.fn(async (params: { actor: AppActor; operation: string }) => {
    const { requireAgentOperation } = await import("../../domain/src/agent-operation-capabilities");
    requireAgentOperation(params.actor, params.operation);
    return null;
  }),
  supportCapabilityVersion: vi.fn().mockResolvedValue(1),
  ...await import("../../domain/src/errors"),
  privacyFilter: (a: any) => a?.kind === "user" ? { OR: [{ isPrivate: false }, { isPrivate: true, status: "DRAFT", authorUserId: a.user.id }] } : { isPrivate: false },
  archiveWorkspaceToolLink: vi.fn(),
  applyContextGraphProposedDiff: applyContextGraphProposedDiffMock,
  assignRole: vi.fn(),
  buildSelectedRegionContext: buildSelectedRegionContextMock,
  buildRoleOnboardingContextForConversation: buildRoleOnboardingContextForConversationMock,
  checkBudget: checkBudgetMock,
  completeActivity: completeActivityMock,
  createActivity: createActivityMock,
  createCommunicationSuggestion: createCommunicationSuggestionMock,
  actionRequestSource: (type: string, principalId: string, key: string) => ({ type, id: `${principalId}:${key}` }),
  createAction: vi.fn(),
  createContextGraphProposedDiff: createContextGraphProposedDiffMock,
  createGoal: vi.fn(),
  createProposal: vi.fn(),
  createTension: vi.fn(),
  executeExternalMcpTool: executeExternalMcpToolMock,
  fetchConnectedExternalMcpContext: fetchConnectedExternalMcpContextMock,
  getContextMapData: getContextMapDataMock,
  getMemberProfile: vi.fn(),
  ingestConversationOnDemand: vi.fn(),
  listCrmActivities: listCrmActivitiesMock,
  listExternalMcpConnections: listExternalMcpConnectionsMock,
  requireWorkspaceMembership: vi.fn().mockResolvedValue({ id: "membership-1", workspaceId: "ws-1", userId: "u-1", role: "MEMBER", isActive: true }),
  listGoals: listGoalsMock,
  listMembersEnriched: vi.fn(),
  listWorkspaceToolLinks: listWorkspaceToolLinksMock,
  loadRelevantMemories: loadRelevantMemoriesMock,
  refreshOAuthTokenIfNeeded: vi.fn(),
  resolveKnowledgeAccessDomains: resolveKnowledgeAccessDomainsMock,
  revealWorkspaceToolLinkCredential: vi.fn(),
  searchConnectedExternalMcpContext: searchConnectedExternalMcpContextMock,
  storeAgentMemory: storeAgentMemoryMock,
  unassignRole: vi.fn(),
  updateAction: vi.fn(),
  updateMember: vi.fn(),
  updateProposal: vi.fn(),
  updateTension: vi.fn(),
  upsertWorkspaceToolLink: vi.fn(),
}));

import { searchIndexedKnowledge } from "@corgtex/knowledge";
import { env } from "@corgtex/shared";

function pendingOperationId(index: number) {
  return `123e4567-e89b-12d3-a456-42661417400${index}`;
}

function pendingOperationFixture(overrides: Record<string, any> = {}) {
  const now = new Date();
  const result = {
    id: pendingOperationId(1),
    workspaceId: "ws-1",
    conversationId: "session-1",
    userId: "user-1",
    agentKey: "assistant",
    toolName: "record_relationship_activity",
    argsJson: { title: "Follow up", type: "TASK", accountId: "account-1" },
    argsHash: "hash",
    idempotencyKey: "crm-pending:test",
    relatedEntityType: "CrmAccount",
    relatedEntityId: "account-1",
    riskLabel: "crm-write:record-activity",
    status: "PENDING",
    resultJson: null,
    errorCode: null,
    errorMessage: null,
    proposedAt: now,
    expiresAt: new Date(now.getTime() + 15 * 60_000),
    executedAt: null,
    canceledAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
  const canonicalize = (value: any): any => Array.isArray(value) ? value.map(canonicalize) : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])])) : value;
  result.argsHash = createHash("sha256").update(JSON.stringify(canonicalize({ toolName: result.toolName, args: result.argsJson }))).digest("hex");
  return result;
}

describe("processConversationTurn", () => {
  beforeEach(() => {
    vi.clearAllMocks(); (env as any).MODEL_PROVIDER = "openai_compatible"; chatMock.mockReset(); chatStreamMock.mockReset(); chatEventStreamMock.mockReset();
    chatEventStreamMock.mockImplementation((request: any) => (async function* () { const stream = chatStreamMock(request)[Symbol.asyncIterator](); let message = ""; let terminal: any; while (true) { const next = await stream.next(); if (next.done) { terminal = next.value; break; } message += next.value; } const calls = terminal?.tool_calls ?? []; const name = calls.length ? "route_conversation_tools" : "respond_conversation"; const args = calls.length ? { calls: calls.map((call: any) => { try { return { name: call.function.name, arguments: JSON.parse(call.function.arguments) }; } catch { return { name: call.function.name, arguments: null }; } }) } : { answer: message || terminal?.content || "" }; const wrapper = { id: "route-test", type: "function", function: { name, arguments: JSON.stringify(args) } }; yield { type: "tool_call_delta", index: 0, idDelta: wrapper.id, nameDelta: name, argumentsDelta: wrapper.function.arguments }; return { ...terminal, content: "", tool_calls: [wrapper] }; })());
    vi.mocked(searchIndexedKnowledge).mockReset().mockResolvedValue([]);
    checkBudgetMock.mockReset().mockResolvedValue({ allowed: true, usedPct: 0, usedUsd: 0, capUsd: 5 });
    assertCatalogModelBudgetMock.mockReset().mockResolvedValue(undefined);
    conversationTurnFindManyMock.mockResolvedValue([]);
    resolveKnowledgeAccessDomainsMock.mockResolvedValue(["WORKSPACE"]);
    conversationPendingOperationStore.length = 0;
    conversationPendingOperationFindUniqueMock.mockImplementation(({ where }: any) => {
      if (where?.id) {
        return Promise.resolve(conversationPendingOperationStore.find((operation: any) => operation.id === where.id) ?? null);
      }
      const key = where?.workspaceId_idempotencyKey;
      if (key) {
        return Promise.resolve(conversationPendingOperationStore.find((operation: any) => (
          operation.workspaceId === key.workspaceId && operation.idempotencyKey === key.idempotencyKey
        )) ?? null);
      }
      return Promise.resolve(null);
    });
    conversationPendingOperationFindFirstMock.mockImplementation(({ where }: any) => {
      const matches = conversationPendingOperationStore.filter((operation: any) => (
        (!where?.id || operation.id === where.id)
        && (!where?.workspaceId || operation.workspaceId === where.workspaceId)
        && (!where?.conversationId || operation.conversationId === where.conversationId)
        && (!Object.prototype.hasOwnProperty.call(where ?? {}, "userId") || operation.userId === where.userId)
        && (!where?.agentKey || operation.agentKey === where.agentKey)
        && (typeof where?.idempotencyKey !== "string" || operation.idempotencyKey === where.idempotencyKey)
        && (typeof where?.idempotencyKey?.startsWith !== "string" || operation.idempotencyKey.startsWith(where.idempotencyKey.startsWith))
        && (!where?.status?.in || where.status.in.includes(operation.status))
      ));
      return Promise.resolve(matches.at(-1) ?? null);
    });
    conversationPendingOperationCountMock.mockImplementation(({ where }: any) => {
      const matches = conversationPendingOperationStore.filter((operation: any) => (
        (!where?.workspaceId || operation.workspaceId === where.workspaceId)
        && (typeof where?.idempotencyKey?.startsWith !== "string" || operation.idempotencyKey.startsWith(where.idempotencyKey.startsWith))
      ));
      return Promise.resolve(matches.length);
    });
    conversationPendingOperationCreateMock.mockImplementation(({ data }: any) => {
      if (conversationPendingOperationStore.some((operation: any) => (
        operation.workspaceId === data.workspaceId && operation.idempotencyKey === data.idempotencyKey
      ))) {
        const error = new Error("Unique constraint failed on the fields: (`workspaceId`,`idempotencyKey`)");
        (error as any).code = "P2002";
        throw error;
      }
      const operation = {
        id: pendingOperationId(conversationPendingOperationStore.length + 1),
        createdAt: new Date(),
        updatedAt: new Date(),
        proposedAt: new Date(),
        canceledAt: null,
        executedAt: null,
        resultJson: null,
        errorCode: null,
        errorMessage: null,
        status: "PENDING",
        ...data,
      };
      conversationPendingOperationStore.push(operation);
      return Promise.resolve(operation);
    });
    conversationPendingOperationUpdateMock.mockImplementation(({ where, data }: any) => {
      const operation = conversationPendingOperationStore.find((item: any) => item.id === where.id);
      if (!operation) throw new Error(`Missing pending operation ${where.id}`);
      Object.assign(operation, data, { updatedAt: new Date() });
      return Promise.resolve(operation);
    });
    conversationPendingOperationUpdateManyMock.mockImplementation(({ where, data }: any) => {
      let count = 0;
      for (const operation of conversationPendingOperationStore) {
        const expiresAfter = where?.expiresAt?.gt ? operation.expiresAt > where.expiresAt.gt : true;
        const expiresBeforeOrEqual = where?.expiresAt?.lte ? operation.expiresAt <= where.expiresAt.lte : true;
        const updatedBeforeOrEqual = where?.updatedAt?.lte ? operation.updatedAt <= where.updatedAt.lte : true;
        if (operation.id === where.id && operation.status === where.status && expiresAfter && expiresBeforeOrEqual && updatedBeforeOrEqual) {
          Object.assign(operation, data, { updatedAt: new Date() });
          count += 1;
        }
      }
      return Promise.resolve({ count });
    });
    loadRelevantMemoriesMock.mockResolvedValue([]);
    storeAgentMemoryMock.mockResolvedValue(undefined);
    workspaceFeatureFlagFindManyMock.mockResolvedValue([]);
    createContextGraphProposedDiffMock.mockResolvedValue({ id: "diff-1", status: "pending" });
    applyContextGraphProposedDiffMock.mockResolvedValue({ id: "diff-1", status: "applied" });
    getContextMapDataMock.mockResolvedValue({
      mapView: { id: "map-1", name: "CRNA Critical Path", viewType: "process" },
      permissions: { canRead: true, canPropose: true, canApprove: true },
      objects: [
        { id: "step-1", objectType: "ProcessStep", title: "Decision to proceed", status: "approved", properties: {} },
      ],
      relationships: [],
    });
    buildSelectedRegionContextMock.mockResolvedValue({ objects: [], relationships: [], evidenceRefs: [] });
    buildRoleOnboardingContextForConversationMock.mockResolvedValue(null);
    executeExternalMcpToolMock.mockResolvedValue({ skipped: false, result: { ok: true } });
    fetchConnectedExternalMcpContextMock.mockResolvedValue({ providerKey: "notion", externalId: "page-1", content: {} });
    listCrmActivitiesMock.mockResolvedValue({ total: 1, items: [{ id: "activity-1", title: "Follow up", type: "TASK", accountId: "account-1", dueAt: new Date("2026-06-20T10:00:00.000Z"), completedAt: null }] });
    createActivityMock.mockImplementation(async (_actor, params) => ({ ...params, id: "activity-1", dueAt: params.dueAt ?? null, completedAt: null }));
    completeActivityMock.mockResolvedValue({ id: "activity-1", title: "Follow up", type: "TASK", accountId: "account-1", completedAt: new Date("2026-06-20T11:00:00.000Z") });
    createCommunicationSuggestionMock.mockResolvedValue({ id: "suggestion-1", title: "Draft follow-up", status: "SUGGESTED", accountId: "account-1" });
    listExternalMcpConnectionsMock.mockResolvedValue([]);
    listGoalsMock.mockResolvedValue([
      {
        id: "goal-1",
        title: "Launch goal",
        descriptionMd: "Launch safely.",
        cadence: "QUARTERLY",
        level: "COMPANY",
        status: "ACTIVE",
        progressPercent: 25,
        targetDate: null,
        startDate: null,
        circle: { name: "General" },
        ownerMember: { user: { displayName: "Owner" } },
        keyResults: [],
      },
    ]);
    searchConnectedExternalMcpContextMock.mockResolvedValue({ results: [], errors: [] });
    listWorkspaceToolLinksMock.mockResolvedValue([
      {
        id: "tool-1",
        title: "Miro board",
        hasCredential: true,
      },
    ]);
  });

  function enableContextMapAi() {
    workspaceFeatureFlagFindManyMock.mockResolvedValue([
      { flag: "CONTEXT_MAPS", enabled: true },
      { flag: "CONTEXT_MAP_AI", enabled: true },
    ]);
  }

  function testUserActor() {
    return {
      kind: "user" as const,
      user: { id: "user-1", email: "user@example.com", displayName: "User" },
    };
  }

  it("stops a support stream on revocation before returning another content chunk", async () => {
    const { getSupportAuthorizationContext } = await import("@corgtex/shared");
    const { supportCapabilityVersion } = await import("@corgtex/domain");
    vi.mocked(getSupportAuthorizationContext).mockReturnValueOnce({ origin: { userId: "user-1", workspaceId: "ws-1", version: 1 } });
    vi.mocked(supportCapabilityVersion).mockResolvedValueOnce(1).mockRejectedValueOnce(new Error("SUPPORT_AUTHORIZATION_REVOKED"));
    chatEventStreamMock.mockReturnValueOnce(eventResponse([
      { type: "tool_call_delta", index: 0, idDelta: "answer", nameDelta: "respond_conversation", argumentsDelta: "{\"answer\":\"Allowed" },
      { type: "tool_call_delta", index: 0, argumentsDelta: " RESTRICTED\"}" },
    ], { content: "", tool_calls: [answerCall("answer", "Allowed RESTRICTED")] }));
    const { processConversationTurnStream } = await import("./conversation");
    const stream = processConversationTurnStream({ ...turnContext(), userMessage: "Say hello." });
    await expect(stream.next()).rejects.toThrow("SUPPORT_AUTHORIZATION_REVOKED");
    expect(supportCapabilityVersion).toHaveBeenLastCalledWith("user-1", "ws-1", 1);
  });

  function turnContext(actor = testUserActor()) { return { workspaceId: "ws-1", sessionId: "session-1", userId: "user-1", agentKey: "assistant", userMessage: "Update it.", actor }; } function toolCall(id: string, name: string, args: Record<string, unknown> = {}) { return { id, function: { name, arguments: JSON.stringify(args) } }; } function answerCall(id: string, answer: string) { return toolCall(id, "respond_conversation", { answer }); } function eventResponse(events: any[], result: Record<string, any>) { return (async function* () { for (const event of events) yield event; return result; })(); }
  function streamResponse(chunks: string[], result: Record<string, any>) {
    return (async function* () {
      for (const chunk of chunks) {
        yield chunk;
      }
      return result;
    })();
  }

  function throwingStream(chunks: string[] = [], error = new Error("model stream failed")) {
    return (async function* () {
      for (const chunk of chunks) {
        yield chunk;
      }
      throw error;
    })();
  }

  async function collectConversationStream(
    stream: AsyncGenerator<string, { assistantMessage: string; contextUsed: Record<string, any> }>
  ) {
    const chunks: string[] = [];
    while (true) {
      const { done, value } = await stream.next();
      if (done) {
        return { chunks, result: value };
      }
      chunks.push(value);
    }
  }

  describe.each([false, true])("bounded Brain continuation (stream=%s)", (streaming) => {
    function script(responses: Record<string, any>[]) {
      for (const response of responses) {
        chatMock.mockResolvedValueOnce(response);
        chatStreamMock.mockReturnValueOnce(streamResponse([response.content || ""], response));
      }
    }

    async function run(ctx: Parameters<typeof import("./conversation").processConversationTurn>[0] = turnContext()) {
      const { processConversationTurn, processConversationTurnStream } = await import("./conversation");
      if (!streaming) return processConversationTurn(ctx);
      const { chunks, result } = await collectConversationStream(processConversationTurnStream(ctx));
      expect(chunks.join("")).toBe(result.assistantMessage);
      return result;
    }

    it("executes the second ordinary Brain read round and returns its final answer", async () => {
      script([
        { content: "", tool_calls: [toolCall("first", "search_brain", { query: "launch overview" })] },
        { content: "I already finished.", tool_calls: [toolCall("second", "search_brain", { query: "launch dependencies" })] },
        { content: "The launch depends on the approval recorded in Brain." },
      ]);
      const result = await run();
      expect(vi.mocked(searchIndexedKnowledge).mock.calls.map(([args]) => args.query)).toEqual([
        "Update it.", "launch overview", "launch dependencies",
      ]);
      expect(result.assistantMessage).toBe("The launch depends on the approval recorded in Brain.");
      const gateway = streaming ? chatStreamMock : chatMock;
      expect(gateway).toHaveBeenCalledTimes(3);
      expect(gateway.mock.calls[1][0].tools.map((tool: any) => tool.function.name)).toEqual(["search_brain"]);
      expect(gateway.mock.calls[2][0]).toMatchObject({ tool_choice: "none" });
      expect(gateway.mock.calls[2][0].tools).toBeUndefined();
    });

    it.each([
      ["malformed JSON", () => [{ id: "bad", function: { name: "search_brain", arguments: "{" } }]],
      ["nonobject arguments", () => [{ id: "bad", function: { name: "search_brain", arguments: "null" } }]],
      ["wrong query type", () => [toolCall("bad", "search_brain", { query: 4 })]],
      ["wrong limit type", () => [toolCall("bad", "search_brain", { query: "x", limit: "4" })]],
      ["missing query", () => [toolCall("bad", "search_brain")]],
      ["duplicate IDs", () => [toolCall("same", "search_brain", { query: "x" }), toolCall("same", "search_brain", { query: "y" })]],
      ["reused initial ID", () => [toolCall(streaming ? "route-test:0" : "first", "search_brain", { query: "x" })]],
      ["empty ID", () => [toolCall(" ", "search_brain", { query: "x" })]],
      ["five calls", () => Array.from({ length: 5 }, (_, i) => toolCall(`extra-${i}`, "search_brain", { query: "x" }))],
      ...["create_action", "update_action", "update_tension", "record_relationship_activity", "apply_context_map_diff", "update_member", "execute_external_tool", "query_actions", "toString", "unknown_tool"]
        .map((name) => [name, () => [toolCall("good", "search_brain", { query: "valid but must not run" }), toolCall("bad", name)]] as const),
    ] as const)("rejects %s atomically without emitting attached success text", async (_label, calls) => {
      script([
        { content: "", tool_calls: [toolCall("first", "search_brain", { query: "overview" })] },
        { content: "Done: I changed the workspace.", tool_calls: calls() },
      ]);
      const result = await run();
      expect(result.assistantMessage).toBe("I could not safely run the additional Brain search batch. No calls in that batch were executed.");
      expect(searchIndexedKnowledge).toHaveBeenCalledTimes(2);
      expect(streaming ? chatStreamMock : chatMock).toHaveBeenCalledTimes(2);
      const { createAction, updateAction, updateTension, updateMember } = await import("@corgtex/domain");
      for (const handler of [createAction, updateAction, updateTension, updateMember, conversationPendingOperationCreateMock, createActivityMock, executeExternalMcpToolMock, applyContextGraphProposedDiffMock]) expect(handler).not.toHaveBeenCalled();
    });

    it("bounds two batches of four even when queries repeat and the final model asks for more", async () => {
      script([
        { content: "", tool_calls: Array.from({ length: 4 }, (_, i) => toolCall(`first-${i}`, "search_brain", { query: "same query" })) },
        { content: "Already done.", tool_calls: Array.from({ length: 4 }, (_, i) => toolCall(`second-${i}`, "search_brain", { query: "same query" })) },
        { content: "Saved it to Brain.", tool_calls: [toolCall("third", "save_to_brain", { content: "do not save" })] },
      ]);
      const result = await run();
      expect(searchIndexedKnowledge).toHaveBeenCalledTimes(9); // Eager context plus eight requested reads.
      expect(streaming ? chatStreamMock : chatMock).toHaveBeenCalledTimes(3);
      expect(result.assistantMessage).toBe("Brain searches completed: 8; failed: 0. I could not complete a final answer from the Brain search results. Please retry or narrow the question.");
      const { ingestConversationOnDemand } = await import("@corgtex/domain");
      expect(ingestConversationOnDemand).not.toHaveBeenCalled();
    });

    it("propagates the authenticated caller and catalog usage context despite model identity arguments", async () => {
      const actor = { kind: "agent", authProvider: "credential", credentialId: "credential-1", catalogItemId: "catalog-1", workspaceIds: ["ws-1"], scopes: ["conversations:write", "brain:read"] } as any;
      script([
        { content: "", tool_calls: [toolCall("first", "search_brain", { query: "overview" })] },
        { content: "", tool_calls: [toolCall("second", "search_brain", { query: "details", workspaceId: "foreign", actor: { kind: "system" }, userId: "other", catalogItemId: "forged-catalog", agentCredentialId: "forged-credential" })] },
        { content: "Grounded answer." },
      ]);
      await run({ ...turnContext(), actor });
      const { requireWorkspaceMembership } = await import("@corgtex/domain");
      expect(vi.mocked(requireWorkspaceMembership).mock.calls.every(([args]) => args.actor === actor && args.workspaceId === "ws-1")).toBe(true);
      expect(resolveKnowledgeAccessDomainsMock.mock.calls.every(([caller, workspaceId]) => caller === actor && workspaceId === "ws-1")).toBe(true);
      expect(searchIndexedKnowledge).toHaveBeenCalledTimes(3);
      for (const [request] of vi.mocked(searchIndexedKnowledge).mock.calls) expect(request).toMatchObject({ workspaceId: "ws-1", catalogItemId: "catalog-1", agentCredentialId: "credential-1" });
      for (const [request] of (streaming ? chatStreamMock : chatMock).mock.calls) expect(request).toMatchObject({ workspaceId: "ws-1", catalogItemId: "catalog-1", agentCredentialId: "credential-1", model: "chat-model", taskType: "AGENT" });
    });

    it.each(["empty", "error"])("does not replay reads after an %s final synthesis", async (kind) => {
      script([
        { content: "", tool_calls: [toolCall("first", "search_brain", { query: "overview" })] },
        { content: "Premature answer.", tool_calls: [toolCall("second", "search_brain", { query: "details" })] },
      ]);
      if (kind === "empty") script([{ content: "   " }]);
      else if (streaming) chatStreamMock.mockReturnValueOnce(throwingStream());
      else chatMock.mockRejectedValueOnce(new Error("private model failure"));
      expect((await run()).assistantMessage).toBe("Brain searches completed: 2; failed: 0. I could not complete a final answer from the Brain search results. Please retry or narrow the question.");
      expect(streaming ? chatStreamMock : chatMock).toHaveBeenCalledTimes(3);
      expect(searchIndexedKnowledge).toHaveBeenCalledTimes(3);
    });

    it("sanitizes retrieval failures and uses only the remaining answer-only synthesis", async () => {
      vi.mocked(searchIndexedKnowledge).mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockRejectedValueOnce(new Error("private backend address and secret"));
      script([
        { content: "", tool_calls: [toolCall("first", "search_brain", { query: "overview" })] },
        { content: "I found everything.", tool_calls: [toolCall("second", "search_brain", { query: "details" })] },
        { content: "The additional search failed; I cannot establish the details." },
      ]);
      expect((await run()).assistantMessage).toBe("The additional search failed; I cannot establish the details.");
      const request = (streaming ? chatStreamMock : chatMock).mock.calls[2][0];
      expect(JSON.stringify(request.messages)).not.toContain("private backend");
      expect(request.messages.at(-1)).toMatchObject({ role: "tool", tool_call_id: "second", content: expect.stringContaining("Brain search could not be completed") });
    });

    it("reports partial read outcomes when final synthesis is unavailable", async () => {
      vi.mocked(searchIndexedKnowledge).mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockRejectedValueOnce(new Error("private retrieval failure")).mockResolvedValueOnce([]);
      script([
        { content: "", tool_calls: [toolCall("first", "search_brain", { query: "overview" })] },
        { content: "", tool_calls: [toolCall("second", "search_brain", { query: "fails" }), toolCall("third", "search_brain", { query: "works" })] },
        { content: "" },
      ]);
      expect((await run()).assistantMessage).toBe("Brain searches completed: 2; failed: 1. I could not complete a final answer from the Brain search results. Please retry or narrow the question.");
      expect(searchIndexedKnowledge).toHaveBeenCalledTimes(4);
      expect(streaming ? chatStreamMock : chatMock).toHaveBeenCalledTimes(3);
    });

    it.each(["before continuation", "before added read", "before synthesis"])("stops at the monetary budget %s", async (stage) => {
      const allowed = stage === "before continuation" ? 1 : stage === "before added read" ? 2 : 3;
      checkBudgetMock.mockReset();
      for (let i = 0; i < allowed; i++) checkBudgetMock.mockResolvedValueOnce({ allowed: true });
      checkBudgetMock.mockResolvedValue({ allowed: false });
      script([
        { content: "", tool_calls: [toolCall("first", "search_brain", { query: "overview" })] },
        { content: "", tool_calls: [toolCall("second", "search_brain", { query: "details" })] },
      ]);
      const result = await run();
      expect(result.assistantMessage).toContain("workspace model budget was reached");
      expect(streaming ? chatStreamMock : chatMock).toHaveBeenCalledTimes(stage === "before continuation" ? 1 : 2);
      expect(searchIndexedKnowledge).toHaveBeenCalledTimes(stage === "before synthesis" ? 3 : 2);
    });

    it("rejects eager Finance context revoked during the initial model before any tool or continuation", async () => {
      resolveKnowledgeAccessDomainsMock.mockResolvedValue(["WORKSPACE", "FINANCE"]);
      vi.mocked(searchIndexedKnowledge).mockResolvedValueOnce([{ snippet: "SYNTHETIC_FINANCE_MARKER" }] as any);
      conversationTurnFindManyMock.mockResolvedValue(Array.from({ length: 5 }, (_, index) => ({ sequenceNumber: index + 1, userMessage: "prior", assistantMessage: "answer" })));
      const initial = { content: "", tool_calls: [toolCall("first", "search_brain", { query: "overview" })] };
      const revoke = () => { resolveKnowledgeAccessDomainsMock.mockResolvedValue(["WORKSPACE"]); return initial; };
      if (streaming) chatStreamMock.mockReturnValueOnce((async function* () { yield ""; return revoke(); })());
      else chatMock.mockImplementationOnce(async () => revoke());
      script([
        { content: "", tool_calls: [toolCall("second", "search_brain", { query: "details" })] },
        { content: "SYNTHETIC_FINANCE_MARKER" },
      ]);
      await expect(run()).rejects.toMatchObject({ code: "KNOWLEDGE_ACCESS_CHANGED" });
      expect(streaming ? chatStreamMock : chatMock).toHaveBeenCalledTimes(1);
      expect(searchIndexedKnowledge).toHaveBeenCalledTimes(1);
      expect(storeAgentMemoryMock).not.toHaveBeenCalled();
    });

    it.each(["daily", "monthly"])("preserves initial model %s denial after eager retrieval spends the last credential allowance", async (kind) => {
      const { prisma } = await import("@corgtex/shared");
      const { assertCatalogModelBudget, CatalogBudgetError } = await vi.importActual<typeof import("@corgtex/models")>("@corgtex/models");
      const scope = { workspaceId: "ws-1", catalogItemId: "catalog-1", agentCredentialId: "credential-1" };
      const actor = { kind: "agent", authProvider: "credential", credentialId: scope.agentCredentialId, catalogItemId: scope.catalogItemId, workspaceIds: [scope.workspaceId], scopes: ["conversations:write", "brain:read"] } as any;
      const usage: Array<{ estimatedCostUsd: string; billableCostUsd: string }> = [];
      vi.mocked(prisma.agentCredential.findFirst).mockResolvedValue({
        catalogItemId: scope.catalogItemId, isActive: true, catalogItem: null,
        dailyCallLimit: kind === "daily" ? 1 : null, monthlyBudgetCents: kind === "monthly" ? 1 : null,
      } as any);
      vi.mocked(prisma.modelUsage.count).mockResolvedValue(0);
      vi.mocked(prisma.modelUsage.findMany).mockResolvedValue([]);
      await assertCatalogModelBudget(scope); // The turn starts with remaining allowance.
      vi.mocked(searchIndexedKnowledge).mockImplementationOnce(async (request) => {
        expect(request).toMatchObject(scope);
        usage.push({ estimatedCostUsd: "0.01", billableCostUsd: "0.01" });
        vi.mocked(prisma.modelUsage.count).mockResolvedValue(usage.length);
        vi.mocked(prisma.modelUsage.findMany).mockResolvedValue(usage as any);
        return [{ chunkId: "eager-chunk", sourceId: "doc-1", sourceType: "DOCUMENT", title: "Policy", chunkIndex: 0, snippet: "Synthetic policy evidence.", score: 1 }];
      });
      conversationTurnFindManyMock.mockResolvedValue(Array.from({ length: 5 }, (_, index) => ({ sequenceNumber: index + 1, userMessage: "prior", assistantMessage: "answer" })));
      let budgetError: unknown;
      const denyInitialModel = async (request: Record<string, any>) => {
        expect(request).toMatchObject(scope);
        expect(usage).toHaveLength(1);
        expect(JSON.stringify(request.messages)).toContain("Synthetic policy evidence.");
        try { await assertCatalogModelBudget(request as typeof scope); }
        catch (error) { budgetError = error; throw error; }
        throw new Error("Expected the initial model budget gate to deny the request.");
      };
      const closeRoute = vi.fn(async () => ({ done: true as const, value: undefined }));
      if (streaming) chatEventStreamMock.mockImplementationOnce((request) => ({
        next: () => denyInitialModel(request), return: closeRoute, [Symbol.asyncIterator]() { return this; },
      }));
      else chatMock.mockImplementationOnce(denyInitialModel);
      const emitted: string[] = [];
      const { processConversationTurn, processConversationTurnStream } = await import("./conversation");
      const ctx = { ...turnContext(), actor };
      const result = streaming ? (async () => {
        for await (const chunk of processConversationTurnStream(ctx)) emitted.push(chunk);
      })() : processConversationTurn(ctx);
      const caught = await result.then(() => null, (error: unknown) => error);
      expect(emitted).toEqual([]);
      expect(caught).toMatchObject({ code: kind === "daily" ? "CATALOG_DAILY_LIMIT_EXCEEDED" : "CATALOG_MONTHLY_BUDGET_EXCEEDED", status: 429 });
      expect(caught).toBe(budgetError);
      expect(budgetError).toBeInstanceOf(CatalogBudgetError);
      expect(searchIndexedKnowledge).toHaveBeenCalledOnce();
      expect(streaming ? chatEventStreamMock : chatMock).toHaveBeenCalledOnce();
      expect(chatStreamMock).not.toHaveBeenCalled();
      if (streaming) expect(closeRoute).toHaveBeenCalledOnce();
      expect(storeAgentMemoryMock).not.toHaveBeenCalled();
      expect(conversationPendingOperationCreateMock).not.toHaveBeenCalled();
      expect(createActivityMock).not.toHaveBeenCalled();
    });

    it.each(["eager read", "initial model", "initial read", "followup", "added read", "synthesis"].flatMap((stage) =>
      ["daily", "monthly", "workspace"].map((kind) => [stage, kind] as const),
    ))("preserves the canonical %s %s budget error", async (stage, kind) => {
      const { CatalogBudgetError, WorkspaceModelBudgetError } = await import("@corgtex/models");
      const error = kind === "workspace"
        ? new WorkspaceModelBudgetError("BUDGET_EXCEEDED", "Workspace model budget reached.")
        : new CatalogBudgetError(kind === "daily" ? "CATALOG_DAILY_LIMIT_EXCEEDED" : "CATALOG_MONTHLY_BUDGET_EXCEEDED", "Credential model budget reached.");
      if (stage !== "initial model") script([{ content: "", tool_calls: [toolCall("first", "search_brain", { query: "overview" })] }]);
      if (stage === "added read" || stage === "synthesis") {
        script([{ content: "", tool_calls: [toolCall("second", "search_brain", { query: "details" })] }]);
      }
      const closed = vi.fn();
      if (stage === "eager read" || stage === "initial read" || stage === "added read") {
        if (stage !== "eager read") vi.mocked(searchIndexedKnowledge).mockResolvedValueOnce([]);
        if (stage === "added read") vi.mocked(searchIndexedKnowledge).mockResolvedValueOnce([]);
        vi.mocked(searchIndexedKnowledge).mockRejectedValueOnce(error);
      } else if (streaming) {
        chatStreamMock.mockReturnValueOnce((async function* () {
          try { yield "Unverified partial answer."; throw error; }
          finally { closed(); }
        })());
      } else chatMock.mockRejectedValueOnce(error);
      const actor = { kind: "agent", authProvider: "credential", credentialId: "credential-1", catalogItemId: "catalog-1", workspaceIds: ["ws-1"], scopes: ["conversations:write", "brain:read"] } as any;
      await expect(run({ ...turnContext(), actor })).rejects.toBe(error);
      expect(streaming ? chatStreamMock : chatMock).toHaveBeenCalledTimes(stage === "eager read" ? 0 : stage === "initial model" || stage === "initial read" ? 1 : stage === "synthesis" ? 3 : 2);
      expect(searchIndexedKnowledge).toHaveBeenCalledTimes(stage === "eager read" || stage === "initial model" ? 1 : stage === "initial read" || stage === "followup" ? 2 : 3);
      expect(storeAgentMemoryMock).not.toHaveBeenCalled();
      if (streaming && (stage === "initial model" || stage === "followup" || stage === "synthesis")) expect(closed).toHaveBeenCalledOnce();
    });

    it.each(["daily", "monthly"])("uses the canonical credential %s gate when chat 2 spends the remaining allowance", async (kind) => {
      const { prisma } = await import("@corgtex/shared");
      const { assertCatalogModelBudget } = await vi.importActual<typeof import("@corgtex/models")>("@corgtex/models");
      assertCatalogModelBudgetMock.mockImplementation(assertCatalogModelBudget);
      vi.mocked(prisma.agentCredential.findFirst).mockResolvedValue({
        catalogItemId: "catalog-1", isActive: true,
        dailyCallLimit: kind === "daily" ? 2 : null,
        monthlyBudgetCents: kind === "monthly" ? 2 : null,
        catalogItem: null,
      } as any);
      vi.mocked(prisma.modelUsage.count).mockResolvedValue(1);
      vi.mocked(prisma.modelUsage.findMany).mockResolvedValue([{ estimatedCostUsd: "0.01", billableCostUsd: "0.01" }] as any);
      script([{ content: "", tool_calls: [toolCall("first", "search_brain", { query: "overview" })] }]);
      const spend = () => {
        vi.mocked(prisma.modelUsage.count).mockResolvedValue(2);
        vi.mocked(prisma.modelUsage.findMany).mockResolvedValue(Array.from({ length: 2 }, () => ({ estimatedCostUsd: "0.01", billableCostUsd: "0.01" })) as any);
        return { content: "Unverified result.", tool_calls: [toolCall("second", "search_brain", { query: "must not run" })] };
      };
      if (streaming) chatStreamMock.mockReturnValueOnce((async function* () { yield "Unverified result."; return spend(); })());
      else chatMock.mockImplementationOnce(async () => spend());
      const actor = { kind: "agent", authProvider: "credential", credentialId: "credential-1", catalogItemId: "catalog-1", workspaceIds: ["ws-1"], scopes: ["conversations:write", "brain:read"] } as any;
      await expect(run({ ...turnContext(), actor })).rejects.toMatchObject({ code: kind === "daily" ? "CATALOG_DAILY_LIMIT_EXCEEDED" : "CATALOG_MONTHLY_BUDGET_EXCEEDED" });
      expect(assertCatalogModelBudgetMock).toHaveBeenCalledWith({ workspaceId: "ws-1", catalogItemId: "catalog-1", agentCredentialId: "credential-1" });
      expect(searchIndexedKnowledge).toHaveBeenCalledTimes(2);
      expect(streaming ? chatStreamMock : chatMock).toHaveBeenCalledTimes(2);
      expect(storeAgentMemoryMock).not.toHaveBeenCalled();
      const usage = kind === "daily" ? prisma.modelUsage.count : prisma.modelUsage.findMany;
      expect(usage).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ workspaceId: "ws-1", agentCredentialId: "credential-1" }) }));
    });

    it("rechecks the canonical credential allowance between added reads", async () => {
      const { prisma } = await import("@corgtex/shared");
      const { assertCatalogModelBudget } = await vi.importActual<typeof import("@corgtex/models")>("@corgtex/models");
      assertCatalogModelBudgetMock.mockImplementation(assertCatalogModelBudget);
      vi.mocked(prisma.agentCredential.findFirst).mockResolvedValue({ catalogItemId: "catalog-1", isActive: true, dailyCallLimit: 2, monthlyBudgetCents: null, catalogItem: null } as any);
      // Another request can consume the remaining allowance between read boundaries.
      vi.mocked(prisma.modelUsage.count).mockReset().mockResolvedValueOnce(1).mockResolvedValueOnce(2);
      script([
        { content: "", tool_calls: [toolCall("first", "search_brain", { query: "overview" })] },
        { content: "", tool_calls: [toolCall("second", "search_brain", { query: "permitted" }), toolCall("third", "search_brain", { query: "must not run" })] },
      ]);
      const actor = { kind: "agent", authProvider: "credential", credentialId: "credential-1", catalogItemId: "catalog-1", workspaceIds: ["ws-1"], scopes: ["conversations:write", "brain:read"] } as any;
      await expect(run({ ...turnContext(), actor })).rejects.toMatchObject({ code: "CATALOG_DAILY_LIMIT_EXCEEDED" });
      expect(assertCatalogModelBudgetMock).toHaveBeenCalledTimes(2);
      expect(vi.mocked(searchIndexedKnowledge).mock.calls.map(([args]) => args.query)).toEqual(["Update it.", "overview", "permitted"]);
      expect(streaming ? chatStreamMock : chatMock).toHaveBeenCalledTimes(2);
    });

    it.each(["membership", "support", "finance"])("stops after an added read revokes %s access, before synthesis or memory", async (kind) => {
      const { AppError, requireWorkspaceMembership, supportCapabilityVersion } = await import("@corgtex/domain");
      const { getSupportAuthorizationContext } = await import("@corgtex/shared");
      const membership = vi.mocked(requireWorkspaceMembership);
      const support = vi.mocked(supportCapabilityVersion);
      const origin = vi.mocked(getSupportAuthorizationContext);
      conversationTurnFindManyMock.mockResolvedValue(Array.from({ length: 5 }, (_, index) => ({ sequenceNumber: index + 1, userMessage: "prior", assistantMessage: "answer", createdAt: new Date() })));
      if (kind === "support") origin.mockReturnValue({ origin: { userId: "user-1", workspaceId: "ws-1", version: 1 } } as any);
      resolveKnowledgeAccessDomainsMock.mockResolvedValue(["WORKSPACE", "FINANCE"]);
      vi.mocked(searchIndexedKnowledge).mockImplementation(async ({ query }) => {
        if (query === "details") {
          if (kind === "membership") membership.mockRejectedValue(new AppError(403, "NOT_A_MEMBER", "access revoked"));
          if (kind === "support") support.mockRejectedValue(new AppError(403, "SUPPORT_AUTHORIZATION_REVOKED", "access revoked"));
          if (kind === "finance") resolveKnowledgeAccessDomainsMock.mockResolvedValue(["WORKSPACE"]);
        }
        return [];
      });
      script([
        { content: "", tool_calls: [toolCall("first", "search_brain", { query: "overview" })] },
        { content: "", tool_calls: [toolCall("second", "search_brain", { query: "details" }), toolCall("third", "search_brain", { query: "must not run" })] },
      ]);
      try {
        await expect(run()).rejects.toThrow(kind === "finance" ? "Knowledge access changed" : "access revoked");
        expect(searchIndexedKnowledge).toHaveBeenCalledTimes(3);
        expect(streaming ? chatStreamMock : chatMock).toHaveBeenCalledTimes(2);
        expect(storeAgentMemoryMock).not.toHaveBeenCalled();
      } finally {
        membership.mockResolvedValue({ id: "membership-1" } as any);
        support.mockResolvedValue(1);
        origin.mockReturnValue(undefined);
      }
    });

    it("stops after in-flight retrieval settles on cancellation without another read or memory", async () => {
      const controller = new AbortController();
      conversationTurnFindManyMock.mockResolvedValue(Array.from({ length: 5 }, (_, index) => ({ sequenceNumber: index + 1, userMessage: "prior", assistantMessage: "answer", createdAt: new Date() })));
      vi.mocked(searchIndexedKnowledge).mockImplementation(async ({ query }) => {
        if (query === "details") controller.abort(new Error("user canceled"));
        return [];
      });
      script([
        { content: "", tool_calls: [toolCall("first", "search_brain", { query: "overview" })] },
        { content: "", tool_calls: [toolCall("second", "search_brain", { query: "details" }), toolCall("third", "search_brain", { query: "must not run" })] },
      ]);
      await expect(run({ ...turnContext(), signal: controller.signal })).rejects.toThrow("user canceled");
      expect(searchIndexedKnowledge).toHaveBeenCalledTimes(3);
      expect(streaming ? chatStreamMock : chatMock).toHaveBeenCalledTimes(2);
      expect(storeAgentMemoryMock).not.toHaveBeenCalled();
    });

    it.each(["continuation", "synthesis"])("revalidates after the %s model before using its response", async (stage) => {
      const { AppError, requireWorkspaceMembership } = await import("@corgtex/domain");
      const membership = vi.mocked(requireWorkspaceMembership);
      script([{ content: "", tool_calls: [toolCall("first", "search_brain", { query: "overview" })] }]);
      if (stage === "synthesis") script([{ content: "", tool_calls: [toolCall("second", "search_brain", { query: "details" })] }]);
      const revoke = () => {
        membership.mockRejectedValue(new AppError(403, "NOT_A_MEMBER", "access revoked during model"));
        return stage === "continuation"
          ? { content: "Do not deliver.", tool_calls: [toolCall("second", "search_brain", { query: "must not run" })] }
          : { content: "Do not deliver." };
      };
      if (streaming) chatStreamMock.mockReturnValueOnce((async function* () { yield "Do not deliver."; return revoke(); })());
      else chatMock.mockImplementationOnce(async () => revoke());
      try {
        await expect(run()).rejects.toThrow("access revoked during model");
        expect(searchIndexedKnowledge).toHaveBeenCalledTimes(stage === "continuation" ? 2 : 3);
        expect(storeAgentMemoryMock).not.toHaveBeenCalled();
      } finally {
        membership.mockResolvedValue({ id: "membership-1" } as any);
      }
    });

    it("does not offer a continuation after a failed initial read", async () => {
      vi.mocked(searchIndexedKnowledge).mockResolvedValueOnce([]).mockRejectedValueOnce(new Error("initial read failed"));
      script([
        { content: "", tool_calls: [toolCall("first", "search_brain", { query: "overview" })] },
        { content: "I could not read Brain.", tool_calls: [toolCall("second", "search_brain", { query: "must not run" })] },
      ]);
      expect((await run()).assistantMessage).toBe("I could not read Brain.");
      expect(searchIndexedKnowledge).toHaveBeenCalledTimes(2);
      expect(streaming ? chatStreamMock : chatMock).toHaveBeenCalledTimes(2);
      expect((streaming ? chatStreamMock : chatMock).mock.calls[1][0].tools.length).toBeGreaterThan(1);
    });

    it("preserves a mixed initial batch and does not continue its ordinary reads", async () => {
      script([
        { content: "", tool_calls: [toolCall("first", "search_brain", { query: "overview" }), toolCall("actions", "query_actions")] },
        { content: "Existing mixed-batch summary.", tool_calls: [toolCall("second", "search_brain", { query: "must not run" })] },
      ]);
      expect((await run()).assistantMessage).toBe("Existing mixed-batch summary.");
      expect(searchIndexedKnowledge).toHaveBeenCalledTimes(2);
      expect((streaming ? chatStreamMock : chatMock).mock.calls[1][0].tools.length).toBeGreaterThan(1);
    });

    if (streaming) {
      it("revalidates after the consumer pauses at the answer before storing memory", async () => {
        const { AppError, requireWorkspaceMembership } = await import("@corgtex/domain");
        const membership = vi.mocked(requireWorkspaceMembership);
        conversationTurnFindManyMock.mockResolvedValue(Array.from({ length: 5 }, (_, index) => ({ sequenceNumber: index + 1, userMessage: "prior", assistantMessage: "answer", createdAt: new Date() })));
        script([
          { content: "", tool_calls: [toolCall("first", "search_brain", { query: "overview" })] },
          { content: "", tool_calls: [toolCall("second", "search_brain", { query: "details" })] },
          { content: "Grounded answer." },
        ]);
        const { processConversationTurnStream } = await import("./conversation");
        const stream = processConversationTurnStream(turnContext());
        await expect(stream.next()).resolves.toEqual({ done: false, value: "Grounded answer." });
        membership.mockRejectedValue(new AppError(403, "NOT_A_MEMBER", "access revoked after yield"));
        try {
          await expect(stream.next()).rejects.toThrow("access revoked after yield");
          expect(storeAgentMemoryMock).not.toHaveBeenCalled();
        } finally {
          membership.mockResolvedValue({ id: "membership-1" } as any);
        }
      });

      it.each(["followup", "synthesis"])("closes a canceled %s iterator and drops partial prose", async (stage) => {
        const controller = new AbortController();
        const closed = vi.fn();
        script([{ content: "", tool_calls: [toolCall("first", "search_brain", { query: "overview" })] }]);
        if (stage === "synthesis") script([{ content: "", tool_calls: [toolCall("second", "search_brain", { query: "details" })] }]);
        chatStreamMock.mockReturnValueOnce((async function* () {
          try { controller.abort(new Error("stream canceled")); yield "Unverified success."; return { content: "Unverified success." }; }
          finally { closed(); }
        })());
        await expect(run({ ...turnContext(), signal: controller.signal })).rejects.toThrow("stream canceled");
        expect(closed).toHaveBeenCalledOnce();
        expect(storeAgentMemoryMock).not.toHaveBeenCalled();
      });

      it.each(["followup", "synthesis"])("drops partial prose from a failed %s stream", async (stage) => {
        script([{ content: "", tool_calls: [toolCall("first", "search_brain", { query: "overview" })] }]);
        if (stage === "synthesis") script([{ content: "", tool_calls: [toolCall("second", "search_brain", { query: "details" })] }]);
        chatStreamMock.mockReturnValueOnce(throwingStream(["Unverified success."]));
        expect((await run()).assistantMessage).toBe(`Brain searches completed: ${stage === "followup" ? 1 : 2}; failed: 0. I could not complete a final answer from the Brain search results. Please retry or narrow the question.`);
      });
    }
  });

  function crmPageContext() {
    return {
      surface: "crm" as const,
      route: "/workspaces/ws-1/leads/accounts/account-1",
      workspaceId: "ws-1",
      view: "account-detail",
      section: "overview",
      selectedIds: { accountId: "account-1", contactId: null, dealId: null, activityId: null, suggestionId: null },
      filters: { view: "overview" },
      pagination: { page: null, pageCount: null, total: null },
      visibleContext: {
        metrics: [],
        accounts: [{
          id: "account-1",
          name: "Acme",
          domain: "acme.test",
          relationshipType: "CLIENT",
          lifecycleStage: "ACTIVE",
          webUrl: "/workspaces/ws-1/leads/accounts/account-1",
        }],
        contacts: [],
        deals: [],
        activities: [],
        suggestions: [],
      },
    };
  }

  function addPendingCrmOperation(overrides: Record<string, any> = {}) {
    const operation = pendingOperationFixture({
      id: pendingOperationId(conversationPendingOperationStore.length + 1),
      workspaceId: "ws-1",
      conversationId: "session-1",
      userId: "user-1",
      agentKey: "assistant",
      toolName: "record_relationship_activity",
      argsJson: {
        title: "Follow up",
        type: "TASK",
        accountId: "account-1",
        dueAt: "2026-06-20T10:00:00.000Z",
      },
      argsHash: "args-hash",
      idempotencyKey: "crm-pending:test",
      relatedEntityType: "CrmAccount",
      relatedEntityId: "account-1",
      riskLabel: "crm-write:record-activity",
      status: "PENDING",
      resultJson: null,
      errorCode: null,
      errorMessage: null,
      proposedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      executedAt: null,
      canceledAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    });
    conversationPendingOperationStore.push(operation);
    return operation;
  }

  it("executes chat tools with the real user actor", async () => {
    const actor = {
      kind: "user" as const,
      user: {
        id: "user-1",
        email: "user@example.com",
        displayName: "User",
      },
    };
    chatMock
      .mockResolvedValueOnce({
        content: "",
        tool_calls: [
          {
            id: "call-1",
            function: {
              name: "list_tool_links",
              arguments: "{}",
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        content: "The shared tool is Miro board.",
      });

    const { processConversationTurn } = await import("./conversation");
    const result = await processConversationTurn({
      workspaceId: "ws-1",
      sessionId: "session-1",
      userId: "user-1",
      agentKey: "assistant",
      userMessage: "What tools do we have?",
      actor,
    });

    expect(listWorkspaceToolLinksMock).toHaveBeenCalledWith(actor, { workspaceId: "ws-1" });
    expect(result.assistantMessage).toBe("The shared tool is Miro board.");
  });

  it("executes goal query tools with the real user actor", async () => {
    const actor = {
      kind: "user" as const,
      user: {
        id: "user-1",
        email: "user@example.com",
        displayName: "User",
      },
    };
    chatMock
      .mockResolvedValueOnce({
        content: "",
        tool_calls: [
          {
            id: "call-1",
            function: {
              name: "query_goals",
              arguments: JSON.stringify({ cadence: "QUARTERLY", level: "COMPANY", status: "ACTIVE" }),
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        content: "The active quarterly goal is Launch goal.",
      });

    const { processConversationTurn } = await import("./conversation");
    const result = await processConversationTurn({
      workspaceId: "ws-1",
      sessionId: "session-1",
      userId: "user-1",
      agentKey: "assistant",
      userMessage: "What are our active quarterly company goals?",
      actor,
    });

    expect(listGoalsMock).toHaveBeenCalledWith(actor, expect.objectContaining({
      workspaceId: "ws-1",
      cadence: "QUARTERLY",
      level: "COMPANY",
      status: "ACTIVE",
      take: 20,
    }));
    expect(result.assistantMessage).toBe("The active quarterly goal is Launch goal.");
  });

  it.each(["turn", "stream"] as const)("keeps the authenticated human actor for every workspace reader in the %s path", async (path) => {
    const actor = testUserActor();
    const { prisma } = await import("@corgtex/shared");
    const { requireWorkspaceMembership } = await import("@corgtex/domain");
    const injected = {
      workspaceId: "foreign-workspace", userId: "other-user",
      actor: { kind: "agent", workspaceIds: ["foreign-workspace"] },
      assigneeId: "other-member", status: "DRAFT",
    };
    const calls = [
      toolCall("read-actions", "query_actions", injected),
      toolCall("read-tensions", "query_tensions", injected),
      toolCall("read-proposals", "query_proposals", injected),
      toolCall("read-overview", "get_workspace_overview", injected),
    ];
    if (path === "turn") {
      chatMock.mockResolvedValueOnce({ content: "", tool_calls: calls })
        .mockResolvedValueOnce({ content: "Read results." });
      const { processConversationTurn } = await import("./conversation");
      await processConversationTurn(turnContext(actor));
    } else {
      chatStreamMock.mockReturnValueOnce(streamResponse([], { content: "", tool_calls: calls }))
        .mockReturnValueOnce(streamResponse(["Read results."], { content: "Read results." }));
      const { processConversationTurnStream } = await import("./conversation");
      await collectConversationStream(processConversationTurnStream(turnContext(actor)));
    }
    expect(vi.mocked(requireWorkspaceMembership).mock.calls.length).toBeGreaterThanOrEqual(5);
    for (const [params] of vi.mocked(requireWorkspaceMembership).mock.calls) {
      expect(params.actor).toBe(actor);
      expect(params.workspaceId).toBe("ws-1");
    }
    const visibility = {
      workspaceId: "ws-1", archivedAt: null,
      OR: [{ isPrivate: false }, { isPrivate: true, status: "DRAFT", authorUserId: actor.user.id }],
    };
    for (const model of [prisma.action, prisma.tension]) {
      expect(model.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: { AND: [{ ...visibility, status: "DRAFT", assigneeMemberId: "other-member" }] },
      }));
      expect(model.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { AND: [{ ...visibility, status: "OPEN" }] } }));
      expect(model.count).not.toHaveBeenCalled();
    }
    expect(prisma.proposal.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { AND: [{ ...visibility, status: "DRAFT" }] } }));
    expect(prisma.proposal.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { AND: [{ ...visibility, status: { in: ["DRAFT", "OPEN"] } }] } }));
    expect(prisma.goal.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { AND: [{ ...visibility, status: { notIn: ["DRAFT", "ABANDONED"] } }] } }));
  });

  it("does not fall back to a bootstrap agent when no authenticated actor is provided", async () => {
    chatMock.mockResolvedValueOnce({
      content: "",
      tool_calls: [
        {
          id: "call-1",
          function: {
            name: "list_tool_links",
            arguments: "{}",
          },
        },
      ],
    });

    const { processConversationTurn } = await import("./conversation");

    await expect(processConversationTurn({
      workspaceId: "ws-1",
      sessionId: "session-1",
      userId: "user-1",
      agentKey: "assistant",
      userMessage: "What tools do we have?",
    })).rejects.toThrow("Authenticated actor is required");
    expect(listWorkspaceToolLinksMock).not.toHaveBeenCalled();
  });

  it("blocks model calls when the workspace budget is exhausted", async () => {
    checkBudgetMock.mockResolvedValueOnce({ allowed: false, usedPct: 100, usedUsd: 5, capUsd: 5 });

    const { processConversationTurn } = await import("./conversation");

    await expect(processConversationTurn({
      workspaceId: "ws-1",
      sessionId: "session-1",
      userId: "user-1",
      agentKey: "assistant",
      userMessage: "Can you summarize the workspace?",
      actor: testUserActor(),
    })).rejects.toMatchObject({
      status: 429,
      code: "BUDGET_EXCEEDED",
    });
    expect(chatMock).not.toHaveBeenCalled();
  });

  it("confirms a pending CRM operation before model budget gating", async () => {
    const actor = {
      kind: "user" as const,
      user: {
        id: "user-1",
        email: "user@example.com",
        displayName: "User",
      },
    };
    conversationPendingOperationStore.push(pendingOperationFixture());
    checkBudgetMock.mockResolvedValue({ allowed: false, usedPct: 100, usedUsd: 5, capUsd: 5 });

    const { processConversationTurn } = await import("./conversation");
    const result = await processConversationTurn({
      workspaceId: "ws-1",
      sessionId: "session-1",
      userId: "user-1",
      agentKey: "assistant",
      userMessage: `confirm ${pendingOperationId(1)}`,
      actor,
    });

    expect(result.assistantMessage).toContain("Activity ID: activity-1");
    expect(createActivityMock).toHaveBeenCalledWith(actor, expect.objectContaining({
      title: "Follow up",
      type: "TASK",
      accountId: "account-1",
    }));
    expect(checkBudgetMock).not.toHaveBeenCalled();
    expect(chatMock).not.toHaveBeenCalled();
    checkBudgetMock.mockResolvedValue({ allowed: true, usedPct: 0, usedUsd: 0, capUsd: 5 });
  });

  it("streams pending CRM confirmations before model budget gating", async () => {
    const actor = {
      kind: "user" as const,
      user: {
        id: "user-1",
        email: "user@example.com",
        displayName: "User",
      },
    };
    conversationPendingOperationStore.push(pendingOperationFixture());
    checkBudgetMock.mockResolvedValue({ allowed: false, usedPct: 100, usedUsd: 5, capUsd: 5 });

    const { processConversationTurnStream } = await import("./conversation");
    const { chunks, result } = await collectConversationStream(processConversationTurnStream({
      workspaceId: "ws-1",
      sessionId: "session-1",
      userId: "user-1",
      agentKey: "assistant",
      userMessage: `confirm ${pendingOperationId(1)}`,
      actor,
    }));

    expect(chunks.join("")).toContain("Activity ID: activity-1");
    expect(result.assistantMessage).toContain("Activity ID: activity-1");
    expect(createActivityMock).toHaveBeenCalledWith(actor, expect.objectContaining({
      title: "Follow up",
      type: "TASK",
      accountId: "account-1",
    }));
    expect(checkBudgetMock).not.toHaveBeenCalled();
    expect(chatStreamMock).not.toHaveBeenCalled();
  });

  it("recovers stale executing pending CRM operations when confirmation is retried", async () => {
    const actor = {
      kind: "user" as const,
      user: {
        id: "user-1",
        email: "user@example.com",
        displayName: "User",
      },
    };
    conversationPendingOperationStore.push(pendingOperationFixture({
      status: "EXECUTING",
      updatedAt: new Date(Date.now() - 10 * 60_000),
    }));

    const { processConversationTurn } = await import("./conversation");
    const result = await processConversationTurn({
      workspaceId: "ws-1",
      sessionId: "session-1",
      userId: "user-1",
      agentKey: "assistant",
      userMessage: `confirm ${pendingOperationId(1)}`,
      actor,
    });

    expect(result.assistantMessage).toContain("Check CRM before preparing this change again");
    expect(conversationPendingOperationStore[0].status).toBe("FAILED");
    expect(conversationPendingOperationStore[0].errorCode).toBe("CRM_PENDING_OPERATION_EXECUTION_ABANDONED");
    expect(createActivityMock).not.toHaveBeenCalled();
    expect(chatMock).not.toHaveBeenCalled();
  });

  it("runs retrieval for short follow-up questions using recent conversation context", async () => {
    conversationTurnFindManyMock.mockResolvedValueOnce([{
      sequenceNumber: 1,
      userMessage: "Can you find the name from the meeting transcript?",
      assistantMessage: "I will check the meeting transcript for the name.",
    }]);
    vi.mocked(searchIndexedKnowledge).mockResolvedValueOnce([{
      chunkId: "chunk-1",
      sourceType: "MEETING",
      sourceId: "meeting-1",
      title: "Transcript",
      chunkIndex: 0,
      snippet: "The name mentioned was Jan.",
      score: 0.95,
    } as any]);
    chatMock.mockResolvedValueOnce({ content: "The name was Jan." });

    const { processConversationTurn } = await import("./conversation");
    const result = await processConversationTurn({
      workspaceId: "ws-1",
      sessionId: "session-1",
      userId: "user-1",
      agentKey: "assistant",
      userMessage: "any name?",
      actor: testUserActor(),
    });

    expect(searchIndexedKnowledge).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "ws-1",
      limit: 4,
      query: expect.stringContaining("Recent conversation context"),
    }));
    expect(vi.mocked(searchIndexedKnowledge).mock.calls[0]?.[0]?.query).toContain("meeting transcript");
    expect(result.contextUsed.knowledgeSearch).toMatchObject({
      hitCount: 1,
    });
    expect(chatMock).toHaveBeenCalledWith(expect.objectContaining({
      messages: expect.arrayContaining([
        expect.objectContaining({
          role: "system",
          content: expect.stringContaining("Knowledge retrieval already searched accessible indexed Brain knowledge"),
        }),
      ]),
    }));
  });

  it("passes authenticated actor Finance domains into conversation retrieval", async () => {
    const actor = testUserActor();
    resolveKnowledgeAccessDomainsMock.mockResolvedValueOnce(["WORKSPACE", "FINANCE"]);
    chatMock.mockResolvedValueOnce({ content: "Revenue increased." });

    const { processConversationTurn } = await import("./conversation");
    await processConversationTurn({
      workspaceId: "ws-1",
      sessionId: "session-1",
      userId: "user-1",
      agentKey: "assistant",
      userMessage: "What did the finance report say about revenue?",
      actor,
    });

    expect(resolveKnowledgeAccessDomainsMock).toHaveBeenCalledWith(actor, "ws-1");
    expect(searchIndexedKnowledge).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "ws-1",
      accessDomains: ["WORKSPACE", "FINANCE"],
      sourceTypes: ["BRAIN_ARTICLE", "DOCUMENT", "MEETING"],
    }));
  });

  it("does not search when conversation actor authorization fails", async () => {
    const actor = testUserActor();
    resolveKnowledgeAccessDomainsMock.mockRejectedValueOnce(new Error("FORBIDDEN"));
    chatMock.mockResolvedValueOnce({ content: "I could not verify that." });

    const { processConversationTurn } = await import("./conversation");
    const result = await processConversationTurn({
      workspaceId: "ws-1",
      sessionId: "session-1",
      userId: "user-1",
      agentKey: "assistant",
      userMessage: "What did the finance report say?",
      actor,
    });

    expect(searchIndexedKnowledge).not.toHaveBeenCalled();
    expect(result.contextUsed.knowledgeSearch).toMatchObject({
      hitCount: 0,
      error: "Knowledge search is temporarily unavailable.",
    });
  });

  it("routes Slack follow-up retrieval to indexed Slack knowledge", async () => {
    conversationTurnFindManyMock.mockResolvedValueOnce([{
      sequenceNumber: 1,
      userMessage: "Who was discussed in the transcript?",
      assistantMessage: "The transcript context was inconclusive.",
    }]);
    chatMock.mockResolvedValueOnce({ content: "I did not find a Slack match." });

    const { processConversationTurn } = await import("./conversation");
    await processConversationTurn({
      actor: testUserActor(),
      workspaceId: "ws-1",
      sessionId: "session-1",
      userId: "user-1",
      agentKey: "assistant",
      userMessage: "can you check slack too",
    });

    expect(searchIndexedKnowledge).toHaveBeenCalledWith(expect.objectContaining({
      sourceTypes: ["SLACK"],
      query: expect.stringContaining("Who was discussed in the transcript?"),
    }));
    expect(chatMock).toHaveBeenCalledWith(expect.objectContaining({
      messages: expect.arrayContaining([
        expect.objectContaining({
          role: "system",
          content: expect.stringContaining("indexed public Slack knowledge"),
        }),
      ]),
    }));
  });

  it("warns the model not to claim source checks when retrieval fails", async () => {
    vi.mocked(searchIndexedKnowledge).mockRejectedValueOnce(new Error("search unavailable"));
    chatMock.mockResolvedValueOnce({ content: "I could not verify that from indexed Slack context." });

    const { processConversationTurn } = await import("./conversation");
    await processConversationTurn({
      actor: testUserActor(),
      workspaceId: "ws-1",
      sessionId: "session-1",
      userId: "user-1",
      agentKey: "assistant",
      userMessage: "can you check slack too",
    });

    expect(chatMock).toHaveBeenCalledWith(expect.objectContaining({
      messages: expect.arrayContaining([
        expect.objectContaining({
          role: "system",
          content: expect.stringContaining("Do not claim that you checked or searched that source"),
        }),
      ]),
    }));
  });

  it("guides the assistant to create proposals from tensions instead of action conversions", async () => {
    const actor = {
      kind: "user" as const,
      user: {
        id: "user-1",
        email: "user@example.com",
        displayName: "User",
      },
    };
    chatMock.mockResolvedValueOnce({ content: "I will use the tension as the source." });

    const { processConversationTurn } = await import("./conversation");
    await processConversationTurn({
      workspaceId: "ws-1",
      sessionId: "session-1",
      userId: "user-1",
      agentKey: "assistant",
      userMessage: "Turn the reimbursement tension into a proposal",
      actor,
    });

    expect(chatMock).toHaveBeenCalledWith(expect.objectContaining({
      messages: expect.arrayContaining([
        expect.objectContaining({
          role: "system",
          content: expect.stringContaining("sourceTensionId"),
        }),
      ]),
    }));
    expect(chatMock).toHaveBeenCalledWith(expect.objectContaining({
      messages: expect.arrayContaining([
        expect.objectContaining({
          role: "system",
          content: expect.stringContaining("Do not turn an action into a proposal unless the user explicitly asks"),
        }),
      ]),
    }));
    const firstCall = chatMock.mock.calls[0]?.[0];
    const toolNames = (firstCall.tools ?? []).map((tool: any) => tool.function.name);
    expect(toolNames).toEqual(expect.arrayContaining([
      "list_due_relationship_work",
      "record_relationship_activity",
      "create_communication_suggestion",
    ]));
    expect(firstCall.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: "system",
        content: expect.stringContaining("CRM write tools use a pending-operation approval contract"),
      }),
      expect.objectContaining({
        role: "system",
        content: expect.stringContaining("must not send email directly"),
      }),
    ]));
  });

  it("injects role onboarding context for guided onboarding conversations", async () => {
    buildRoleOnboardingContextForConversationMock.mockResolvedValue("ROLE ONBOARDING CONTEXT\nRole: Integrator");
    chatMock.mockResolvedValueOnce({ content: "Welcome to the Integrator role." });

    const { processConversationTurn } = await import("./conversation");
    const result = await processConversationTurn({
      actor: testUserActor(),
      workspaceId: "ws-1",
      sessionId: "session-1",
      userId: "user-1",
      agentKey: "role-onboarding",
      userMessage: "What should I know first?",
    });

    expect(result.contextUsed.roleOnboardingContext).toContain("Integrator");
    expect(buildRoleOnboardingContextForConversationMock).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      conversationId: "session-1",
      userId: "user-1",
    });
    expect(chatMock).toHaveBeenCalledWith(expect.objectContaining({
      messages: expect.arrayContaining([
        expect.objectContaining({
          role: "system",
          content: expect.stringContaining("ROLE ONBOARDING CONTEXT"),
        }),
      ]),
    }));
  });

  it("exposes connected external MCP tools to the assistant", async () => {
    const actor = {
      kind: "user" as const,
      user: {
        id: "user-1",
        email: "user@example.com",
        displayName: "User",
      },
    };
    chatMock.mockResolvedValueOnce({ content: "I can search Notion live." });

    const { processConversationTurn } = await import("./conversation");
    await processConversationTurn({
      workspaceId: "ws-1",
      sessionId: "session-1",
      userId: "user-1",
      agentKey: "assistant",
      userMessage: "Find the customer rollout notes in Notion",
      actor,
    });

    expect(chatMock).toHaveBeenCalledWith(expect.objectContaining({
      tools: expect.arrayContaining([
        expect.objectContaining({
          function: expect.objectContaining({ name: "list_connected_tools" }),
        }),
        expect.objectContaining({
          function: expect.objectContaining({ name: "search_connected_context" }),
        }),
        expect.objectContaining({
          function: expect.objectContaining({ name: "fetch_connected_context" }),
        }),
        expect.objectContaining({
          function: expect.objectContaining({ name: "execute_external_tool" }),
        }),
      ]),
      messages: expect.arrayContaining([
        expect.objectContaining({
          role: "system",
          content: expect.stringContaining("Use live retrieval from connected tools first"),
        }),
      ]),
    }));
  });

  it("adds sanitized context map page context without changing the visible user message", async () => {
    const actor = {
      kind: "user" as const,
      user: {
        id: "user-1",
        email: "user@example.com",
        displayName: "User",
      },
    };
    chatMock.mockResolvedValueOnce({ content: "I know which map you are viewing." });

    const { processConversationTurn } = await import("./conversation");
    await processConversationTurn({
      workspaceId: "ws-1",
      sessionId: "session-1",
      userId: "user-1",
      agentKey: "assistant",
      userMessage: "yes, do it",
      actor,
      pageContext: {
        surface: "context-map",
        route: "/workspaces/ws-1/maps?view=map-1",
        mapView: { id: "map-1", name: "CRNA Critical Path", viewType: "process" },
        includeStale: false,
        selectedObjectIds: ["step-1"],
        selectedObjects: [{ id: "step-1", title: "Decision to proceed", objectType: "ProcessStep", status: "approved" }],
        selectedRelationship: null,
      },
    });

    expect(chatMock).toHaveBeenCalledWith(expect.objectContaining({
      messages: expect.arrayContaining([
        expect.objectContaining({
          role: "system",
          content: expect.stringContaining("CURRENT PAGE CONTEXT"),
        }),
        expect.objectContaining({
          role: "user",
          content: "yes, do it",
        }),
      ]),
    }));
  });

  it("sanitizes context map page context before model use", async () => {
    const { sanitizeConversationPageContext } = await import("./page-context");
    const context = sanitizeConversationPageContext({
      surface: "context-map",
      route: `/workspaces/ws-1/maps?${"x".repeat(400)}`,
      mapView: { id: "map-1", name: "CRNA Critical Path", viewType: "process" },
      selectedObjectIds: Array.from({ length: 20 }, (_, index) => `step-${index}`),
      selectedObjects: [{
        id: "step-1",
        title: "Decision to proceed",
        objectType: "ProcessStep",
        status: "approved",
        summary: "This should not be carried into page context.",
      }],
      selectedRelationship: null,
    });

    expect(context?.route?.length).toBe(240);
    expect(context?.surface).toBe("context-map");
    if (context?.surface !== "context-map") throw new Error("Expected context map context");
    expect(context?.selectedObjectIds).toHaveLength(12);
    expect(context?.selectedObjects[0]).toEqual({
      id: "step-1",
      title: "Decision to proceed",
      objectType: "ProcessStep",
      status: "approved",
    });
  });

  it("adds sanitized CRM page context without changing the visible user message", async () => {
    const actor = {
      kind: "user" as const,
      user: {
        id: "user-1",
        email: "user@example.com",
        displayName: "User",
      },
    };
    chatMock.mockResolvedValueOnce({ content: "You are viewing the Acme account." });

    const { processConversationTurn } = await import("./conversation");
    await processConversationTurn({
      workspaceId: "ws-1",
      sessionId: "session-1",
      userId: "user-1",
      agentKey: "assistant",
      userMessage: "Summarize the current CRM page.",
      actor,
      pageContext: {
        surface: "crm",
        route: "/workspaces/ws-1/leads/accounts/account-1",
        workspaceId: "ws-1",
        view: "account-detail",
        section: "overview",
        selectedIds: { accountId: "account-1", contactId: null, dealId: null, activityId: null, suggestionId: null },
        filters: { view: "overview" },
        pagination: { page: null, pageCount: null, total: null },
        visibleContext: {
          metrics: [{ label: "activeDeals", value: "2", detail: null }],
          accounts: [{
            id: "account-1",
            name: "Acme",
            domain: "acme.test",
            relationshipType: "CLIENT",
            lifecycleStage: "ACTIVE",
            webUrl: "/workspaces/ws-1/leads/accounts/account-1",
          }],
          contacts: [],
          deals: [],
          activities: [],
          suggestions: [],
        },
      },
    });

    expect(chatMock).toHaveBeenCalledWith(expect.objectContaining({
      messages: expect.arrayContaining([
        expect.objectContaining({
          role: "system",
          content: expect.stringContaining("user-visible CRM state"),
        }),
        expect.objectContaining({
          role: "system",
          content: expect.stringContaining('"accountId": "account-1"'),
        }),
        expect.objectContaining({
          role: "user",
          content: "Summarize the current CRM page.",
        }),
      ]),
    }));
  });

  it("answers selected CRM account questions directly from page context", async () => {
    const actor = testUserActor();

    const { processConversationTurnStream } = await import("./conversation");
    const { chunks, result } = await collectConversationStream(processConversationTurnStream({
      workspaceId: "ws-1",
      sessionId: "session-1",
      userId: "user-1",
      agentKey: "assistant",
      userMessage: "Use the current CRM page context. What CRM account am I viewing? Include this exact account id if available: account-1.",
      actor,
      pageContext: crmPageContext(),
    }));

    const streamedMessage = chunks.join("");
    expect(streamedMessage).toContain("Acme (account-1)");
    expect(result.assistantMessage).toContain("Acme (account-1)");
    expect(result.contextUsed.pageContext).toMatchObject({
      surface: "crm",
      selectedIds: { accountId: "account-1" },
    });
    expect(chatStreamMock).not.toHaveBeenCalled();
  });

  it("does not bypass the model for compound CRM account requests", async () => {
    const actor = testUserActor();
    const response = answerCall("compound", "I can help with both requests."); chatEventStreamMock.mockReturnValueOnce(eventResponse([
      { type: "tool_call_delta", index: 0, idDelta: "compound", nameDelta: "respond_conversation", argumentsDelta: response.function.arguments },
    ], { content: "", tool_calls: [response] }));

    const { processConversationTurnStream } = await import("./conversation");
    const { chunks, result } = await collectConversationStream(processConversationTurnStream({
      workspaceId: "ws-1",
      sessionId: "session-1",
      userId: "user-1",
      agentKey: "assistant",
      userMessage: "What CRM account am I viewing, and prepare a pending CRM follow-up for tomorrow?",
      actor,
      pageContext: crmPageContext(),
    }));

    expect(chunks.join("")).toBe("I can help with both requests.");
    expect(result.assistantMessage).toBe("I can help with both requests.");
    expect(chatEventStreamMock).toHaveBeenCalledOnce();
  });

  it("closes the ordinary response stream when the conversation stream is canceled", async () => {
    const actor = testUserActor();
    let firstModelStreamClosed = false;

    async function* cancellableModelStream() {
      try {
        yield { type: "tool_call_delta", index: 0, idDelta: "cancel", nameDelta: "respond_conversation", argumentsDelta: "{\"answer\":\"Partial answer" };
      } finally {
        firstModelStreamClosed = true;
      }
    }

    chatEventStreamMock.mockReturnValueOnce(cancellableModelStream());

    const { processConversationTurnStream } = await import("./conversation");
    const stream = processConversationTurnStream({
      workspaceId: "ws-1",
      sessionId: "session-1",
      userId: "user-1",
      agentKey: "assistant",
      userMessage: "Summarize the workspace.",
      actor,
    });

    await expect(stream.next()).resolves.toMatchObject({
      done: false,
      value: "Partial answer",
    });

    await stream.return({
      assistantMessage: "",
      contextUsed: {}, promptInputId: "", lineageRoots: [],
    });

    expect(firstModelStreamClosed).toBe(true);
  });

  it("does not store agent memory after stream cancellation", async () => {
    const actor = testUserActor();
    const controller = new AbortController();
    const cancellationError = new Error("client cancelled");
    conversationTurnFindManyMock.mockResolvedValueOnce([{
      sequenceNumber: 5,
      userMessage: "Earlier context",
      assistantMessage: "Earlier response",
    }]);

    async function* canceledModelStream() {
      yield { type: "tool_call_delta", index: 0, idDelta: "abort", nameDelta: "respond_conversation", argumentsDelta: "{\"answer\":\"Partial answer" };
      controller.abort(cancellationError);
      throw cancellationError;
    }

    chatEventStreamMock.mockReturnValueOnce(canceledModelStream());

    const { processConversationTurnStream } = await import("./conversation");
    const stream = processConversationTurnStream({
      workspaceId: "ws-1",
      sessionId: "session-1",
      userId: "user-1",
      agentKey: "assistant",
      userMessage: "Summarize the workspace.",
      actor,
      signal: controller.signal,
    });

    await expect(stream.next()).rejects.toThrow("client cancelled");
    expect(storeAgentMemoryMock).not.toHaveBeenCalled();
  });

  it("answers explicit CRM due-work tool commands without invoking the model", async () => {
    const actor = testUserActor();

    const { processConversationTurnStream } = await import("./conversation");
    const { chunks, result } = await collectConversationStream(processConversationTurnStream({
      workspaceId: "ws-1",
      sessionId: "session-1",
      userId: "user-1",
      agentKey: "assistant",
      userMessage: "Use list_due_relationship_work for selected account account-1. Reply with a short due-work summary.",
      actor,
      pageContext: crmPageContext(),
    }));

    const streamedMessage = chunks.join("");
    expect(streamedMessage).toContain("1 open CRM relationship work item");
    expect(streamedMessage).toContain("Follow up");
    expect(result.assistantMessage).toBe(streamedMessage);
    expect(listCrmActivitiesMock).toHaveBeenCalledWith(actor, "ws-1", expect.objectContaining({
      accountId: "account-1",
      type: "TASK",
      completion: "open",
      take: 5,
    }));
    expect(chatStreamMock).not.toHaveBeenCalled();
  });

  it("prepares explicit CRM record-activity commands as pending operations without invoking the model", async () => {
    const actor = testUserActor();
    const dueAt = "2026-07-20T15:00:00.000Z";

    const { processConversationTurnStream } = await import("./conversation");
    const { chunks, result } = await collectConversationStream(processConversationTurnStream({
      workspaceId: "ws-1",
      sessionId: "session-1",
      userId: "user-1",
      agentKey: "assistant",
      userMessage: `Prepare a pending CRM follow-up by calling record_relationship_activity now. Title: Exact validation follow-up. Type: TASK. accountId: account-1. dueAt: ${dueAt}. Return the pending operation ID for confirmation.`,
      actor,
      pageContext: crmPageContext(),
    }));

    const streamedMessage = chunks.join("");
    expect(streamedMessage).toContain(`Pending operation ID: ${pendingOperationId(1)}`);
    expect(streamedMessage).toContain("CRM operation: record_relationship_activity");
    expect(streamedMessage).toContain("confirm");
    expect(result.assistantMessage).toBe(streamedMessage);
    expect(conversationPendingOperationCreateMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        workspaceId: "ws-1",
        conversationId: "session-1",
        userId: "user-1",
        toolName: "record_relationship_activity",
        argsJson: {
          title: "Exact validation follow-up",
          type: "TASK",
          accountId: "account-1",
          dueAt,
        },
        relatedEntityType: "CrmAccount",
        relatedEntityId: "account-1",
        riskLabel: "crm-write:record-activity",
      }),
    }));
    expect(createActivityMock).not.toHaveBeenCalled();
    expect(chatStreamMock).not.toHaveBeenCalled();
  });

  it("prepares explicit CRM completion commands as pending operations without invoking the model", async () => {
    const actor = testUserActor();

    const { processConversationTurnStream } = await import("./conversation");
    const { chunks, result } = await collectConversationStream(processConversationTurnStream({
      workspaceId: "ws-1",
      sessionId: "session-1",
      userId: "user-1",
      agentKey: "assistant",
      userMessage: "Prepare a pending completion by calling complete_relationship_activity now for selected CRM follow-up activity-1. Return the pending operation ID for confirmation.",
      actor,
      pageContext: crmPageContext(),
    }));

    const streamedMessage = chunks.join("");
    expect(streamedMessage).toContain(`Pending operation ID: ${pendingOperationId(1)}`);
    expect(streamedMessage).toContain("CRM operation: complete_relationship_activity");
    expect(result.assistantMessage).toBe(streamedMessage);
    expect(conversationPendingOperationCreateMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        workspaceId: "ws-1",
        conversationId: "session-1",
        userId: "user-1",
        toolName: "complete_relationship_activity",
        argsJson: { activityId: "activity-1" },
        relatedEntityType: "CrmActivity",
        relatedEntityId: "activity-1",
        riskLabel: "crm-write:complete-activity",
      }),
    }));
    expect(completeActivityMock).not.toHaveBeenCalled();
    expect(chatStreamMock).not.toHaveBeenCalled();
  });

  it("streams a grounded CRM page-context fallback when the model returns empty text", async () => {
    const actor = testUserActor();
    chatStreamMock.mockReturnValueOnce(streamResponse([], { content: "" })).mockReturnValueOnce(streamResponse([], { content: "" }));

    const { processConversationTurnStream } = await import("./conversation");
    const { chunks, result } = await collectConversationStream(processConversationTurnStream({
      workspaceId: "ws-1",
      sessionId: "session-1",
      userId: "user-1",
      agentKey: "assistant",
      userMessage: "Summarize the current CRM page.",
      actor,
      pageContext: crmPageContext(),
    }));

    const streamedMessage = chunks.join("");
    expect(streamedMessage).toContain("Acme (account-1)");
    expect(result.assistantMessage).toContain("Acme (account-1)");
    expect(result.contextUsed.pageContext).toMatchObject({
      surface: "crm",
      selectedIds: { accountId: "account-1" },
    });
  });

  it("escapes named CRM account IDs in direct page-context answers", async () => {
    const actor = testUserActor();
    const maliciousId = "[Open](javascript:alert(document.domain))";
    const context = crmPageContext();

    const { processConversationTurnStream } = await import("./conversation");
    const { chunks } = await collectConversationStream(processConversationTurnStream({
      workspaceId: "ws-1",
      sessionId: "session-1",
      userId: "user-1",
      agentKey: "assistant",
      userMessage: "What CRM account am I viewing?",
      actor,
      pageContext: {
        ...context,
        selectedIds: { ...context.selectedIds, accountId: maliciousId },
        visibleContext: {
          ...context.visibleContext,
          accounts: [{
            id: maliciousId,
            name: "Malicious Account",
            stage: null,
            ownerId: null,
            updatedAt: null,
            nextActivityAt: null,
            webUrl: "/workspaces/ws-1/leads/accounts/malicious",
          }],
        },
      },
    }));

    const streamedMessage = chunks.join("");
    expect(streamedMessage).toContain("Malicious Account (\\[Open\\]\\(javascript:alert\\(document\\.domain\\)\\))");
    expect(streamedMessage).not.toContain("Malicious Account ([Open](javascript:alert(document.domain)))");
  });

  it("does not claim the first listed CRM account is selected when no account is selected", async () => {
    const actor = testUserActor();
    const context = crmPageContext();

    const { processConversationTurnStream } = await import("./conversation");
    const { chunks, result } = await collectConversationStream(processConversationTurnStream({
      workspaceId: "ws-1",
      sessionId: "session-1",
      userId: "user-1",
      agentKey: "assistant",
      userMessage: "What CRM account am I viewing?",
      actor,
      pageContext: {
        ...context,
        view: "accounts",
        selectedIds: { ...context.selectedIds, accountId: null },
      },
    }));

    const streamedMessage = chunks.join("");
    expect(streamedMessage).not.toContain("Acme (account-1)");
    expect(result.assistantMessage).toContain("do not have a selected CRM account");
    expect(chatStreamMock).not.toHaveBeenCalled();
  });

  it("streams a CRM due-work fallback when tool execution succeeds but the follow-up model is empty", async () => {
    const actor = testUserActor();
    chatStreamMock
      .mockReturnValueOnce(streamResponse([], {
        content: "",
        tool_calls: [{
          id: "call-1",
          function: {
            name: "list_due_relationship_work",
            arguments: JSON.stringify({ accountId: "account-1", take: 5 }),
          },
        }],
      }))
      .mockReturnValueOnce(streamResponse([], { content: "" }));

    const { processConversationTurnStream } = await import("./conversation");
    const { chunks, result } = await collectConversationStream(processConversationTurnStream({
      workspaceId: "ws-1",
      sessionId: "session-1",
      userId: "user-1",
      agentKey: "assistant",
      userMessage: "Use list_due_relationship_work for selected account account-1.",
      actor,
      pageContext: crmPageContext(),
    }));

    const streamedMessage = chunks.join("");
    expect(streamedMessage).toContain("1 open CRM relationship work item");
    expect(streamedMessage).toContain("Follow up");
    expect(result.assistantMessage).toContain("1 open CRM relationship work item");
    expect(listCrmActivitiesMock).toHaveBeenCalledWith(actor, "ws-1", expect.objectContaining({
      accountId: "account-1",
      type: "TASK",
      completion: "open",
    }));
  });

  it("closes the follow-up model stream when the conversation stream is canceled after tools", async () => {
    const actor = testUserActor();
    let followupModelStreamClosed = false;

    async function* cancellableFollowupStream() {
      try {
        yield "Follow-up answer";
      } finally {
        followupModelStreamClosed = true;
      }
    }

    chatStreamMock
      .mockReturnValueOnce(streamResponse([], {
        content: "",
        tool_calls: [{
          id: "call-1",
          function: {
            name: "list_due_relationship_work",
            arguments: JSON.stringify({ accountId: "account-1", take: 5 }),
          },
        }],
      }))
      .mockReturnValueOnce(cancellableFollowupStream());

    const { processConversationTurnStream } = await import("./conversation");
    const stream = processConversationTurnStream({
      workspaceId: "ws-1",
      sessionId: "session-1",
      userId: "user-1",
      agentKey: "assistant",
      userMessage: "Use list_due_relationship_work for selected account account-1.",
      actor,
      pageContext: crmPageContext(),
    });

    await expect(stream.next()).resolves.toMatchObject({
      done: false,
      value: "Follow-up answer",
    });

    await stream.return({
      assistantMessage: "",
      contextUsed: {}, promptInputId: "", lineageRoots: [],
    });

    expect(followupModelStreamClosed).toBe(true);
  });

  it("passes the abort signal to first and follow-up model streams", async () => {
    const actor = testUserActor();
    const controller = new AbortController();
    chatStreamMock
      .mockReturnValueOnce(streamResponse([], {
        content: "",
        tool_calls: [{
          id: "call-1",
          function: {
            name: "list_due_relationship_work",
            arguments: JSON.stringify({ accountId: "account-1", take: 5 }),
          },
        }],
      }))
      .mockReturnValueOnce(streamResponse(["Follow-up answer"], { content: "Follow-up answer" }));

    const { processConversationTurnStream } = await import("./conversation");
    const { result } = await collectConversationStream(processConversationTurnStream({
      workspaceId: "ws-1",
      sessionId: "session-1",
      userId: "user-1",
      agentKey: "assistant",
      userMessage: "Use list_due_relationship_work for selected account account-1.",
      actor,
      pageContext: crmPageContext(),
      signal: controller.signal,
    }));

    expect(result.assistantMessage).toContain("Follow-up answer");
    expect(chatStreamMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
      signal: controller.signal,
    }));
    expect(chatStreamMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
      signal: controller.signal,
    }));
  });

  it("streams a CRM due-work fallback when the follow-up model stream fails", async () => {
    const actor = testUserActor();
    chatStreamMock
      .mockReturnValueOnce(streamResponse([], {
        content: "",
        tool_calls: [{
          id: "call-1",
          function: {
            name: "list_due_relationship_work",
            arguments: JSON.stringify({ accountId: "account-1", take: 5 }),
          },
        }],
      }))
      .mockReturnValueOnce(throwingStream());

    const { processConversationTurnStream } = await import("./conversation");
    const { chunks, result } = await collectConversationStream(processConversationTurnStream({
      workspaceId: "ws-1",
      sessionId: "session-1",
      userId: "user-1",
      agentKey: "assistant",
      userMessage: "Use list_due_relationship_work for selected account account-1.",
      actor,
      pageContext: crmPageContext(),
    }));

    const streamedMessage = chunks.join("");
    expect(streamedMessage).toContain("1 open CRM relationship work item");
    expect(streamedMessage).toContain("Follow up");
    expect(result.assistantMessage).toContain("1 open CRM relationship work item");
    expect(result.assistantMessage).toBe(streamedMessage);
    expect(listCrmActivitiesMock).toHaveBeenCalledWith(actor, "ws-1", expect.objectContaining({
      accountId: "account-1",
      type: "TASK",
      completion: "open",
    }));
  });

  it("streams a clear fallback when the first model stream fails before tools run", async () => {
    const actor = testUserActor();
    chatStreamMock.mockReturnValueOnce(throwingStream());

    const { processConversationTurnStream } = await import("./conversation");
    const { chunks, result } = await collectConversationStream(processConversationTurnStream({
      workspaceId: "ws-1",
      sessionId: "session-1",
      userId: "user-1",
      agentKey: "assistant",
      userMessage: "Summarize the workspace.",
      actor,
    }));

    const streamedMessage = chunks.join("");
    expect(streamedMessage).toContain("could not safely complete");
    expect(result.assistantMessage).toBe(streamedMessage);
    expect(listCrmActivitiesMock).not.toHaveBeenCalled();
  });

  it("uses the due-work tool scope and escapes CRM titles in empty-model fallbacks", async () => {
    const actor = testUserActor();
    listCrmActivitiesMock.mockResolvedValueOnce({
      total: 1,
      items: [{
        id: "activity-2",
        title: "[Open](javascript:alert(document.domain))",
        type: "TASK",
        accountId: "account-2",
        dueAt: new Date("2026-06-20T10:00:00.000Z"),
        completedAt: null,
      }],
    });
    chatStreamMock
      .mockReturnValueOnce(streamResponse([], {
        content: "",
        tool_calls: [{
          id: "call-1",
          function: {
            name: "list_due_relationship_work",
            arguments: JSON.stringify({ accountId: "account-2", take: 5 }),
          },
        }],
      }))
      .mockReturnValueOnce(streamResponse([], { content: "" }));

    const { processConversationTurnStream } = await import("./conversation");
    const { chunks } = await collectConversationStream(processConversationTurnStream({
      workspaceId: "ws-1",
      sessionId: "session-1",
      userId: "user-1",
      agentKey: "assistant",
      userMessage: "Use list_due_relationship_work for account account-2.",
      actor,
      pageContext: crmPageContext(),
    }));

    const streamedMessage = chunks.join("");
    expect(streamedMessage).toContain("for CRM account account-2");
    expect(streamedMessage).not.toContain("for CRM account Acme (account-1)");
    expect(streamedMessage).not.toContain("[Open](javascript:alert(document.domain))");
    expect(streamedMessage).toContain("\\[Open\\]\\(javascript:alert\\(document\\.domain\\)\\)");
  });

  it("does not attribute empty account-id CRM due-work requests to the selected account", async () => {
    const actor = testUserActor();
    listCrmActivitiesMock.mockResolvedValueOnce({
      total: 1,
      items: [{
        id: "activity-2",
        title: "Workspace-wide follow up",
        type: "TASK",
        accountId: "account-2",
        dueAt: new Date("2026-06-20T10:00:00.000Z"),
        completedAt: null,
      }],
    });
    chatStreamMock
      .mockReturnValueOnce(streamResponse([], {
        content: "",
        tool_calls: [{
          id: "call-1",
          function: {
            name: "list_due_relationship_work",
            arguments: JSON.stringify({ accountId: "", take: 5 }),
          },
        }],
      }))
      .mockReturnValueOnce(streamResponse([], { content: "" }));

    const { processConversationTurnStream } = await import("./conversation");
    const { chunks } = await collectConversationStream(processConversationTurnStream({
      workspaceId: "ws-1",
      sessionId: "session-1",
      userId: "user-1",
      agentKey: "assistant",
      userMessage: "Use list_due_relationship_work with an empty account id.",
      actor,
      pageContext: crmPageContext(),
    }));

    const streamedMessage = chunks.join("");
    expect(listCrmActivitiesMock).toHaveBeenCalledWith(actor, "ws-1", expect.objectContaining({
      accountId: "",
      type: "TASK",
      completion: "open",
    }));
    expect(streamedMessage).toContain("Workspace-wide follow up");
    expect(streamedMessage).toContain("for the requested CRM scope");
    expect(streamedMessage).not.toContain("Acme (account-1)");
  });

  it("preserves whitespace in CRM due-work query scope labels", async () => {
    const actor = testUserActor();
    listCrmActivitiesMock.mockResolvedValueOnce({ total: 0, items: [] });
    chatStreamMock
      .mockReturnValueOnce(streamResponse([], {
        content: "",
        tool_calls: [{
          id: "call-1",
          function: {
            name: "list_due_relationship_work",
            arguments: JSON.stringify({ accountId: " account-1 ", take: 5 }),
          },
        }],
      }))
      .mockReturnValueOnce(streamResponse([], { content: "" }));

    const { processConversationTurnStream } = await import("./conversation");
    const { chunks } = await collectConversationStream(processConversationTurnStream({
      workspaceId: "ws-1",
      sessionId: "session-1",
      userId: "user-1",
      agentKey: "assistant",
      userMessage: "Use list_due_relationship_work for this exact account filter.",
      actor,
      pageContext: crmPageContext(),
    }));

    const streamedMessage = chunks.join("");
    expect(listCrmActivitiesMock).toHaveBeenCalledWith(actor, "ws-1", expect.objectContaining({
      accountId: " account-1 ",
    }));
    expect(streamedMessage).toContain("CRM account  account-1 ");
    expect(streamedMessage).not.toContain("CRM account Acme (account-1)");
  });

  it("keeps streamed preambles and partial CRM due-work failures alongside successful fallbacks", async () => {
    const actor = testUserActor();
    listCrmActivitiesMock
      .mockResolvedValueOnce({
        total: 1,
        items: [{ id: "activity-1", title: "First follow up", type: "TASK", accountId: "account-1", dueAt: null, completedAt: null }],
      })
      .mockRejectedValueOnce(new Error("CRM unavailable"));
    chatStreamMock
      .mockReturnValueOnce(streamResponse(["I'll check that."], {
        content: "",
        tool_calls: [
          {
            id: "call-1",
            function: {
              name: "list_due_relationship_work",
              arguments: JSON.stringify({ accountId: "account-1", take: 5 }),
            },
          },
          {
            id: "call-2",
            function: {
              name: "list_due_relationship_work",
              arguments: JSON.stringify({ accountId: "account-2", take: 5 }),
            },
          },
        ],
      }))
      .mockReturnValueOnce(streamResponse([], { content: "" }));

    const { processConversationTurnStream } = await import("./conversation");
    const { chunks } = await collectConversationStream(processConversationTurnStream({
      workspaceId: "ws-1",
      sessionId: "session-1",
      userId: "user-1",
      agentKey: "assistant",
      userMessage: "Compare due work for account-1 and account-2.",
      actor,
      pageContext: crmPageContext(),
    }));

    const streamedMessage = chunks.join("");
    expect(streamedMessage).not.toContain("I'll check that.");
    expect(streamedMessage).toContain("First follow up");
    expect(streamedMessage).toContain("I could not complete the CRM relationship-work request for CRM account account-2");
    expect(streamedMessage).toContain("The CRM request could not be completed");
    expect(streamedMessage).not.toContain("CRM unavailable");
    expect(streamedMessage).not.toContain("You are viewing the CRM account");
  });

  it("includes due-date bounds and escapes CRM filter IDs in empty-model fallbacks", async () => {
    const actor = testUserActor();
    listCrmActivitiesMock.mockResolvedValueOnce({ total: 0, items: [] });
    chatStreamMock
      .mockReturnValueOnce(streamResponse([], {
        content: "",
        tool_calls: [{
          id: "call-1",
          function: {
            name: "list_due_relationship_work",
            arguments: JSON.stringify({
              contactId: "[Open](javascript:alert(document.domain))",
              dealId: "deal-1",
              dueTo: "2026-07-20T00:00:00.000Z",
              take: 5,
            }),
          },
        }],
      }))
      .mockReturnValueOnce(streamResponse([], { content: "" }));

    const { processConversationTurnStream } = await import("./conversation");
    const { chunks } = await collectConversationStream(processConversationTurnStream({
      workspaceId: "ws-1",
      sessionId: "session-1",
      userId: "user-1",
      agentKey: "assistant",
      userMessage: "Use list_due_relationship_work for this contact before July 20.",
      actor,
      pageContext: crmPageContext(),
    }));

    const streamedMessage = chunks.join("");
    expect(streamedMessage).toContain("CRM account Acme (account-1)");
    expect(streamedMessage).toContain("CRM contact \\[Open\\]\\(javascript:alert\\(document\\.domain\\)\\)");
    expect(streamedMessage).toContain("CRM deal deal-1");
    expect(streamedMessage).toContain("due by 2026-07-20");
    expect(streamedMessage).not.toContain("CRM contact [Open](javascript:alert(document.domain))");
  });

  it("includes every successful CRM due-work result in empty-model fallbacks", async () => {
    const actor = testUserActor();
    listCrmActivitiesMock
      .mockResolvedValueOnce({
        total: 1,
        items: [{ id: "activity-1", title: "First follow up", type: "TASK", accountId: "account-1", dueAt: null, completedAt: null }],
      })
      .mockResolvedValueOnce({
        total: 1,
        items: [{ id: "activity-2", title: "Second follow up", type: "TASK", accountId: "account-2", dueAt: null, completedAt: null }],
      });
    chatStreamMock
      .mockReturnValueOnce(streamResponse([], {
        content: "",
        tool_calls: [
          {
            id: "call-1",
            function: {
              name: "list_due_relationship_work",
              arguments: JSON.stringify({ accountId: "account-1", take: 5 }),
            },
          },
          {
            id: "call-2",
            function: {
              name: "list_due_relationship_work",
              arguments: JSON.stringify({ accountId: "account-2", take: 5 }),
            },
          },
        ],
      }))
      .mockReturnValueOnce(streamResponse([], { content: "" }));

    const { processConversationTurnStream } = await import("./conversation");
    const { chunks } = await collectConversationStream(processConversationTurnStream({
      workspaceId: "ws-1",
      sessionId: "session-1",
      userId: "user-1",
      agentKey: "assistant",
      userMessage: "Compare due CRM work for account-1 and account-2.",
      actor,
      pageContext: crmPageContext(),
    }));

    const streamedMessage = chunks.join("");
    expect(streamedMessage).toContain("First follow up");
    expect(streamedMessage).toContain("Second follow up");
    expect(streamedMessage).toContain("for CRM account Acme (account-1)");
    expect(streamedMessage).toContain("for CRM account account-2");
  });

  it("keeps due-work fallback text when the same empty-model turn also creates a pending CRM operation", async () => {
    const actor = {
      kind: "user" as const,
      user: {
        id: "user-1",
        email: "user@example.com",
        displayName: "User",
      },
    };
    chatStreamMock
      .mockReturnValueOnce(streamResponse([], {
        content: "",
        tool_calls: [
          {
            id: "call-1",
            function: {
              name: "list_due_relationship_work",
              arguments: JSON.stringify({ accountId: "account-1", take: 5 }),
            },
          },
          {
            id: "call-2",
            function: {
              name: "record_relationship_activity",
              arguments: JSON.stringify({ title: "New follow up", type: "TASK", accountId: "account-1" }),
            },
          },
        ],
      }))
      .mockReturnValueOnce(streamResponse([], { content: "" }));

    const { processConversationTurnStream } = await import("./conversation");
    const { chunks, result } = await collectConversationStream(processConversationTurnStream({
      workspaceId: "ws-1",
      sessionId: "session-1",
      userId: "user-1",
      agentKey: "assistant",
      userMessage: "Summarize due work and prepare a follow-up for account-1.",
      actor,
      pageContext: crmPageContext(),
    }));

    const streamedMessage = chunks.join("");
    expect(streamedMessage).toContain("1 open CRM relationship work item");
    expect(streamedMessage).toContain("Pending operation ID:");
    expect(result.assistantMessage).toContain("1 open CRM relationship work item");
    expect(result.assistantMessage).toContain(`Pending operation ID: ${pendingOperationId(1)}`);
  });

  it("sanitizes CRM page context before model use", async () => {
    const { sanitizeConversationPageContext } = await import("./page-context");
    const context = sanitizeConversationPageContext({
      surface: "crm",
      route: `/workspaces/ws-1/leads/accounts/account-1?${"x".repeat(400)}`,
      workspaceId: "ws-1",
      view: "account-detail",
      section: "overview",
      selectedIds: {
        accountId: "account-1",
        ignoredId: "should-not-pass",
      },
      filters: Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`filter-${index}`, `value-${index}`])),
      pagination: { page: "2", pageCount: 5, total: 80 },
      visibleContext: {
        accounts: Array.from({ length: 20 }, (_, index) => ({
          id: `account-${index}`,
          name: `Account ${index}`,
          domain: "example.test",
          bodyMd: "Do not pass descriptions.",
        })),
        suggestions: [{
          id: "suggestion-1",
          title: "Follow up",
          status: "SUGGESTED",
          bodyMd: "Do not pass draft bodies.",
          recipientEmail: "lead@example.test",
        }],
      },
      unsafe: "do not pass",
    });

    expect(context?.surface).toBe("crm");
    if (context?.surface !== "crm") throw new Error("Expected CRM context");
    expect(context.route?.length).toBe(240);
    expect(Object.keys(context.filters)).toHaveLength(12);
    expect(context.selectedIds).toEqual({
      accountId: "account-1",
      contactId: null,
      dealId: null,
      activityId: null,
      suggestionId: null,
    });
    expect(context.pagination).toEqual({ page: 2, pageCount: 5, total: 80 });
    expect(context.visibleContext.accounts).toHaveLength(12);
    expect(context.visibleContext.accounts[0]).toMatchObject({
      id: "account-0",
      name: "Account 0",
      domain: "example.test",
    });
    expect(context.visibleContext.suggestions[0]).toMatchObject({
      id: "suggestion-1",
      title: "Follow up",
      status: "SUGGESTED",
      recipientEmail: "lead@example.test",
    });
    expect(JSON.stringify(context)).not.toContain("bodyMd");
    expect(JSON.stringify(context)).not.toContain("unsafe");
  });

  it("persists CRM write tool calls as pending operations before confirmation", async () => {
    const actor = {
      kind: "user" as const,
      user: {
        id: "user-1",
        email: "user@example.com",
        displayName: "User",
      },
    };
    chatMock
      .mockResolvedValueOnce({
        content: "",
        tool_calls: [{
          id: "call-1",
          function: {
            name: "record_relationship_activity",
            arguments: JSON.stringify({ title: "Follow up", type: "TASK", accountId: "account-1" }),
          },
        }],
      })
      .mockResolvedValueOnce({ content: "Please confirm before I create that CRM follow-up." });

    const { processConversationTurn } = await import("./conversation");
    const result = await processConversationTurn({
      workspaceId: "ws-1",
      sessionId: "session-1",
      userId: "user-1",
      agentKey: "assistant",
      userMessage: "Create a CRM follow-up for Acme.",
      actor,
    });

    const toolMessage = chatMock.mock.calls[1]?.[0]?.messages.find((message: any) => message.role === "tool");
    expect(toolMessage.content).toContain("PENDING_CONFIRMATION");
    expect(toolMessage.content).toContain("pendingOperationId");
    expect(conversationPendingOperationCreateMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        workspaceId: "ws-1",
        conversationId: "session-1",
        userId: "user-1",
        toolName: "record_relationship_activity",
        argsJson: expect.objectContaining({
          title: "Follow up",
          type: "TASK",
          accountId: "account-1",
        }),
        relatedEntityType: "CrmAccount",
        relatedEntityId: "account-1",
        riskLabel: "crm-write:record-activity",
      }),
    }));
    expect(createActivityMock).not.toHaveBeenCalled();
    expect(result.assistantMessage).toContain("Please confirm before I create that CRM follow-up.");
    expect(result.assistantMessage).toContain(`Pending operation ID: ${pendingOperationId(1)}`);
  });

  it("returns the CRM pending operation ID when the follow-up model budget is exhausted", async () => {
    const actor = {
      kind: "user" as const,
      user: {
        id: "user-1",
        email: "user@example.com",
        displayName: "User",
      },
    };
    checkBudgetMock
      .mockResolvedValueOnce({ allowed: true, usedPct: 80, usedUsd: 4, capUsd: 5 })
      .mockResolvedValueOnce({ allowed: false, usedPct: 100, usedUsd: 5, capUsd: 5 });
    listCrmActivitiesMock.mockResolvedValueOnce({
      total: 1,
      items: [{ id: "activity-1", title: "First follow up", type: "TASK", accountId: "account-1", dueAt: null, completedAt: null }],
    });
    chatMock.mockResolvedValueOnce({
      content: "I'll check that.",
      tool_calls: [
        {
          id: "call-1",
          function: {
            name: "list_due_relationship_work",
            arguments: JSON.stringify({ accountId: "account-1", take: 5 }),
          },
        },
        {
          id: "call-2",
          function: {
            name: "record_relationship_activity",
            arguments: JSON.stringify({ title: "Follow up", type: "TASK", accountId: "account-1" }),
          },
        },
      ],
    });

    const { processConversationTurn } = await import("./conversation");
    const result = await processConversationTurn({
      workspaceId: "ws-1",
      sessionId: "session-1",
      userId: "user-1",
      agentKey: "assistant",
      userMessage: "Create a CRM follow-up for Acme.",
      actor,
    });

    expect(result.assistantMessage).toContain("I'll check that.");
    expect(result.assistantMessage).toContain("1 open CRM relationship work item");
    expect(result.assistantMessage).toContain(`Pending operation ID: ${pendingOperationId(1)}`);
    expect(result.assistantMessage).toContain("Stored args:");
    expect(chatMock).toHaveBeenCalledTimes(1);
  });

  it("streams complete CRM pending operation notices after follow-up whitespace", async () => {
    const actor = {
      kind: "user" as const,
      user: {
        id: "user-1",
        email: "user@example.com",
        displayName: "User",
      },
    };
    chatStreamMock
      .mockReturnValueOnce(streamResponse([], {
        content: "",
        tool_calls: [{
          id: "call-1",
          function: {
            name: "record_relationship_activity",
            arguments: JSON.stringify({ title: "Follow up", type: "TASK", accountId: "account-1" }),
          },
        }],
      }))
      .mockReturnValueOnce(streamResponse(["Pending operation is ready.\n"], {
        content: "Pending operation is ready.\n",
      }));

    const { processConversationTurnStream } = await import("./conversation");
    const { chunks, result } = await collectConversationStream(processConversationTurnStream({
      workspaceId: "ws-1",
      sessionId: "session-1",
      userId: "user-1",
      agentKey: "assistant",
      userMessage: "Create a CRM follow-up for Acme.",
      actor,
    }));

    const streamedMessage = chunks.join("");
    expect(streamedMessage).toContain("Pending operation is ready.\n\nPending operation ID:");
    expect(streamedMessage).not.toContain("\n\nending operation ID:");
    expect(result.assistantMessage).toContain(`Pending operation ID: ${pendingOperationId(1)}`);
    expect(result.assistantMessage).toContain("Stored args:");
  });

  it("withholds CRM confirmation without a current user-owned conversation", async () => {
    const actor = {
      kind: "agent" as const,
      authProvider: "credential",
      credentialId: "credential-1",
      catalogItemId: "catalog-1",
      scopes: ["conversations:write", "relationships:write"],
    } as any;
    chatMock
      .mockResolvedValueOnce({
        content: "",
        tool_calls: [{
          id: "call-1",
          function: {
            name: "record_relationship_activity",
            arguments: JSON.stringify({ title: "Agent follow up", type: "TASK", accountId: "account-1" }),
          },
        }],
      })
      .mockResolvedValueOnce({ content: "Pending operation is ready." });

    const { processConversationTurn } = await import("./conversation");
    const result = await processConversationTurn({
      workspaceId: "ws-1",
      sessionId: "mcp-ws-1-agent",
      userId: "",
      agentKey: "assistant",
      userMessage: "Create a CRM follow-up for Acme.",
      actor,
    });

    expect(conversationPendingOperationCreateMock).not.toHaveBeenCalled();
    expect(createActivityMock).not.toHaveBeenCalled();
    const toolMessage = chatMock.mock.calls[1]?.[0]?.messages.find((message: any) => message.role === "tool");
    expect(JSON.parse(toolMessage.content)).toMatchObject({ success: false, contentWithheld: true,
      message: "CRM confirmation requires a current user-owned conversation." });
    expect(result.assistantMessage).not.toContain("Stored args:");
  });

  it("does not reuse expired pending operations when preparing the same CRM write again", async () => {
    const actor = {
      kind: "user" as const,
      user: {
        id: "user-1",
        email: "user@example.com",
        displayName: "User",
      },
    };
    const userMessage = "Create a CRM follow-up for Acme.";
    const toolCall = {
      id: "call-1",
      function: {
        name: "record_relationship_activity",
        arguments: JSON.stringify({ title: "Follow up", type: "TASK", accountId: "account-1" }),
      },
    };
    chatMock
      .mockResolvedValueOnce({ content: "", tool_calls: [toolCall] })
      .mockResolvedValueOnce({ content: "Pending operation is ready." })
      .mockResolvedValueOnce({ content: "", tool_calls: [toolCall] })
      .mockResolvedValueOnce({ content: "Fresh pending operation is ready." })
      .mockResolvedValueOnce({ content: "", tool_calls: [toolCall] })
      .mockResolvedValueOnce({ content: "Existing pending operation is ready." });

    const { processConversationTurn } = await import("./conversation");
    await processConversationTurn({
      workspaceId: "ws-1",
      sessionId: "session-1",
      userId: "user-1",
      agentKey: "assistant",
      userMessage,
      actor,
    });
    conversationPendingOperationStore[0].expiresAt = new Date(Date.now() - 60_000);

    const result = await processConversationTurn({
      workspaceId: "ws-1",
      sessionId: "session-1",
      userId: "user-1",
      agentKey: "assistant",
      userMessage,
      actor,
    });

    expect(conversationPendingOperationStore).toHaveLength(2);
    expect(conversationPendingOperationStore[0].status).toBe("EXPIRED");
    expect(conversationPendingOperationStore[1].status).toBe("PENDING");
    expect(conversationPendingOperationStore[1].idempotencyKey).not.toBe(conversationPendingOperationStore[0].idempotencyKey);
    expect(conversationPendingOperationStore[1].idempotencyKey).toBe(`${conversationPendingOperationStore[0].idempotencyKey}:retry:1`);
    expect(result.assistantMessage).toContain(`Pending operation ID: ${pendingOperationId(2)}`);

    const repeatResult = await processConversationTurn({
      workspaceId: "ws-1",
      sessionId: "session-1",
      userId: "user-1",
      agentKey: "assistant",
      userMessage,
      actor,
    });

    expect(conversationPendingOperationStore).toHaveLength(2);
    expect(repeatResult.assistantMessage).toContain(`Pending operation ID: ${pendingOperationId(2)}`);
  });

  it("reuses the winning retry operation when concurrent retry creation hits a unique key", async () => {
    const actor = {
      kind: "user" as const,
      user: {
        id: "user-1",
        email: "user@example.com",
        displayName: "User",
      },
    };
    const userMessage = "Create a CRM follow-up for Acme.";
    const toolCall = {
      id: "call-1",
      function: {
        name: "record_relationship_activity",
        arguments: JSON.stringify({ title: "Follow up", type: "TASK", accountId: "account-1" }),
      },
    };
    chatMock
      .mockResolvedValueOnce({ content: "", tool_calls: [toolCall] })
      .mockResolvedValueOnce({ content: "Pending operation is ready." })
      .mockResolvedValueOnce({ content: "", tool_calls: [toolCall] })
      .mockResolvedValueOnce({ content: "Concurrent pending operation is ready." });

    const { processConversationTurn } = await import("./conversation");
    await processConversationTurn({
      workspaceId: "ws-1",
      sessionId: "session-1",
      userId: "user-1",
      agentKey: "assistant",
      userMessage,
      actor,
    });
    conversationPendingOperationStore[0].expiresAt = new Date(Date.now() - 60_000);

    conversationPendingOperationCreateMock.mockImplementationOnce(({ data }: any) => {
      const competingOperation = {
        id: pendingOperationId(2),
        createdAt: new Date(),
        updatedAt: new Date(),
        proposedAt: new Date(),
        canceledAt: null,
        executedAt: null,
        resultJson: null,
        errorCode: null,
        errorMessage: null,
        status: "PENDING",
        ...data,
      };
      conversationPendingOperationStore.push(competingOperation);
      const error = new Error("Unique constraint failed on the fields: (`workspaceId`,`idempotencyKey`)");
      (error as any).code = "P2002";
      throw error;
    });

    const result = await processConversationTurn({
      workspaceId: "ws-1",
      sessionId: "session-1",
      userId: "user-1",
      agentKey: "assistant",
      userMessage,
      actor,
    });

    expect(conversationPendingOperationStore).toHaveLength(2);
    expect(conversationPendingOperationStore[0].status).toBe("EXPIRED");
    expect(conversationPendingOperationStore[1].idempotencyKey).toBe(`${conversationPendingOperationStore[0].idempotencyKey}:retry:1`);
    expect(result.assistantMessage).toContain(`Pending operation ID: ${pendingOperationId(2)}`);
  });

  it("does not reuse abandoned executing CRM operations as confirmable pending operations", async () => {
    const actor = {
      kind: "user" as const,
      user: {
        id: "user-1",
        email: "user@example.com",
        displayName: "User",
      },
    };
    const userMessage = "Create a CRM follow-up for Acme.";
    const toolCall = {
      id: "call-1",
      function: {
        name: "record_relationship_activity",
        arguments: JSON.stringify({ title: "Follow up", type: "TASK", accountId: "account-1" }),
      },
    };
    chatMock
      .mockResolvedValueOnce({ content: "", tool_calls: [toolCall] })
      .mockResolvedValueOnce({ content: "Pending operation is ready." })
      .mockResolvedValueOnce({ content: "", tool_calls: [toolCall] })
      .mockResolvedValueOnce({ content: "Please check CRM before preparing this change again." });

    const { processConversationTurn } = await import("./conversation");
    await processConversationTurn({
      workspaceId: "ws-1",
      sessionId: "session-1",
      userId: "user-1",
      agentKey: "assistant",
      userMessage,
      actor,
    });
    conversationPendingOperationStore[0].status = "EXECUTING";
    conversationPendingOperationStore[0].updatedAt = new Date(Date.now() - 10 * 60_000);

    const result = await processConversationTurn({
      workspaceId: "ws-1",
      sessionId: "session-1",
      userId: "user-1",
      agentKey: "assistant",
      userMessage,
      actor,
    });

    const toolMessage = chatMock.mock.calls[3]?.[0]?.messages.find((message: any) => message.role === "tool");
    expect(toolMessage.content).toContain("Check CRM before preparing this change again");
    expect(conversationPendingOperationStore).toHaveLength(1);
    expect(conversationPendingOperationStore[0].status).toBe("FAILED");
    expect(conversationPendingOperationStore[0].errorCode).toBe("CRM_PENDING_OPERATION_EXECUTION_ABANDONED");
    expect(result.assistantMessage).toBe("Please check CRM before preparing this change again.");
  });

  it("rejects unbound CRM activity completions before storing a pending operation", async () => {
    const actor = {
      kind: "user" as const,
      user: {
        id: "user-1",
        email: "user@example.com",
        displayName: "User",
      },
    };
    chatMock
      .mockResolvedValueOnce({
        content: "",
        tool_calls: [{
          id: "call-1",
          function: {
            name: "complete_relationship_activity",
            arguments: JSON.stringify({ completedAt: "2026-06-20T11:00:00.000Z" }),
          },
        }],
      })
      .mockResolvedValueOnce({ content: "Please select a CRM activity before preparing completion." });

    const { processConversationTurn } = await import("./conversation");
    const result = await processConversationTurn({
      workspaceId: "ws-1",
      sessionId: "session-1",
      userId: "user-1",
      agentKey: "assistant",
      userMessage: "Complete the CRM follow-up.",
      actor,
    });

    const toolMessage = chatMock.mock.calls[1]?.[0]?.messages.find((message: any) => message.role === "tool");
    expect(toolMessage.content).toContain("A CRM activity ID is required");
    expect(conversationPendingOperationCreateMock).not.toHaveBeenCalled();
    expect(completeActivityMock).not.toHaveBeenCalled();
    expect(result.assistantMessage).toBe("Please select a CRM activity before preparing completion.");
  });

  it("rejects CRM activity preparations without a title before storing a pending operation", async () => {
    const actor = {
      kind: "user" as const,
      user: {
        id: "user-1",
        email: "user@example.com",
        displayName: "User",
      },
    };
    chatMock
      .mockResolvedValueOnce({
        content: "",
        tool_calls: [{
          id: "call-1",
          function: {
            name: "record_relationship_activity",
            arguments: JSON.stringify({ type: "TASK", accountId: "account-1" }),
          },
        }],
      })
      .mockResolvedValueOnce({ content: "Please provide a title before I prepare the CRM activity." });

    const { processConversationTurn } = await import("./conversation");
    const result = await processConversationTurn({
      workspaceId: "ws-1",
      sessionId: "session-1",
      userId: "user-1",
      agentKey: "assistant",
      userMessage: "Create a CRM follow-up for Acme.",
      actor,
    });

    const toolMessage = chatMock.mock.calls[1]?.[0]?.messages.find((message: any) => message.role === "tool");
    expect(toolMessage.content).toContain("A CRM activity title is required");
    expect(conversationPendingOperationCreateMock).not.toHaveBeenCalled();
    expect(createActivityMock).not.toHaveBeenCalled();
    expect(result.assistantMessage).toBe("Please provide a title before I prepare the CRM activity.");
  });

  it("rejects CRM activity preparations without a relationship link before storing a pending operation", async () => {
    const actor = {
      kind: "user" as const,
      user: {
        id: "user-1",
        email: "user@example.com",
        displayName: "User",
      },
    };
    chatMock
      .mockResolvedValueOnce({
        content: "",
        tool_calls: [{
          id: "call-1",
          function: {
            name: "record_relationship_activity",
            arguments: JSON.stringify({ title: "Follow up", type: "TASK" }),
          },
        }],
      })
      .mockResolvedValueOnce({ content: "Please select the CRM relationship before I prepare the activity." });

    const { processConversationTurn } = await import("./conversation");
    const result = await processConversationTurn({
      workspaceId: "ws-1",
      sessionId: "session-1",
      userId: "user-1",
      agentKey: "assistant",
      userMessage: "Create a CRM follow-up.",
      actor,
    });

    const toolMessage = chatMock.mock.calls[1]?.[0]?.messages.find((message: any) => message.role === "tool");
    expect(toolMessage.content).toContain("A CRM activity must be linked to an account, contact, or deal");
    expect(conversationPendingOperationCreateMock).not.toHaveBeenCalled();
    expect(createActivityMock).not.toHaveBeenCalled();
    expect(result.assistantMessage).toBe("Please select the CRM relationship before I prepare the activity.");
  });

  it("maps list results and keeps failed-stream persistence aligned with safe fallbacks", async () => { const actor = testUserActor(); const { prisma } = await import("@corgtex/shared"); const { AppError, updateAction, updateTension } = await import("@corgtex/domain"); vi.mocked(prisma.tension.findMany).mockResolvedValueOnce([{ id: "t-1", version: 4, status: "OPEN", author: {} } as any]); vi.mocked(prisma.action.findMany).mockResolvedValueOnce([{ id: "a-1", version: 7, status: "OPEN", author: {} } as any]); vi.mocked(updateTension).mockResolvedValueOnce({ id: "t-1", version: 5 } as any); vi.mocked(updateAction).mockRejectedValueOnce(new AppError(409, "VERSION_CONFLICT", "conflict")); chatMock.mockResolvedValueOnce({ content: "", tool_calls: [toolCall("rt", "query_tensions", { status: "OPEN" }), toolCall("ra", "query_actions")] }).mockResolvedValueOnce({ content: "", tool_calls: [toolCall("wt", "update_tension", { tensionId: "t-1", expectedVersion: 4 }), toolCall("wa", "update_action", { actionId: "a-1", expectedVersion: 7 })] }); const { processConversationTurn } = await import("./conversation"); const result = await processConversationTurn(turnContext(actor)); expect(updateTension).toHaveBeenCalledWith(actor, expect.objectContaining({ tensionId: "t-1", expectedVersion: 4 })); expect(updateAction).toHaveBeenCalledWith(actor, expect.objectContaining({ actionId: "a-1", expectedVersion: 7 })); expect(result.assistantMessage).toBe("Partial update result — succeeded: tension t-1; failed: action a-1. The record was modified by another request. Read the latest version and apply your changes again."); vi.mocked(prisma.tension.findMany).mockResolvedValueOnce([{ id: "t-2", version: 4, status: "OPEN", author: {} } as any]); vi.mocked(prisma.action.findMany).mockResolvedValueOnce([{ id: "a-2", version: 7, status: "OPEN", author: {} } as any]); vi.mocked(updateTension).mockResolvedValueOnce({ id: "t-2", version: 5 } as any); vi.mocked(updateAction).mockRejectedValueOnce(new AppError(409, "VERSION_CONFLICT", "conflict")); chatStreamMock.mockReturnValueOnce(streamResponse([], { content: "", tool_calls: [toolCall("srt", "query_tensions"), toolCall("sra", "query_actions")] })).mockReturnValueOnce(streamResponse([], { content: "", tool_calls: [toolCall("swt", "update_tension", { tensionId: "t-2", expectedVersion: 4 }), toolCall("swa", "update_action", { actionId: "a-2", expectedVersion: 7 })] })); const { processConversationTurnStream } = await import("./conversation"); expect((await collectConversationStream(processConversationTurnStream(turnContext(actor)))).chunks.join("")).toBe("Partial update result — succeeded: tension t-2; failed: action a-2. The record was modified by another request. Read the latest version and apply your changes again."); vi.mocked(prisma.action.findMany).mockResolvedValueOnce([{ id: "a-2", version: 1, status: "OPEN", author: {} } as any]); vi.mocked(updateAction).mockResolvedValueOnce({ id: "a-2", version: 2 } as any); chatStreamMock.mockReturnValueOnce(streamResponse([], { content: "", tool_calls: [toolCall("r", "query_actions")] })).mockReturnValueOnce(streamResponse(["Updated."], { content: "Updated.", tool_calls: [toolCall("w", "update_action", { actionId: "a-2", expectedVersion: 1 })] })).mockReturnValueOnce(throwingStream(["Truncated success."])); const { chunks } = await collectConversationStream(processConversationTurnStream(turnContext(actor))); expect(chunks.join("")).toBe("Updated.The versioned update was processed, but I could not generate a final summary. Read the current item version before retrying."); expect(chunks.join("").match(/Updated\./g)).toHaveLength(1); vi.mocked(prisma.action.findMany).mockResolvedValueOnce([{ id: "a-3", version: 1, status: "OPEN", author: {} } as any]); chatStreamMock.mockReturnValueOnce(streamResponse(["Updated."], { content: "Updated.", tool_calls: [toolCall("fr", "query_actions")] })).mockReturnValueOnce(throwingStream(["Still working."])); const failed = await collectConversationStream(processConversationTurnStream(turnContext(actor))); expect(failed.result.assistantMessage).toBe(failed.chunks.join("")); expect(failed.chunks.join("")).not.toMatch(/Updated|Still working/); });
  it("associates mixed failures with safe guidance in both response paths", async () => { const actor = testUserActor(); const { prisma } = await import("@corgtex/shared"); const { AppError, updateAction, updateTension } = await import("@corgtex/domain"); vi.mocked(prisma.action.findMany).mockResolvedValue([{ id: "a-mixed", version: 2, status: "OPEN", author: {} } as any]); vi.mocked(prisma.tension.findMany).mockResolvedValue([{ id: "t-mixed", version: 3, status: "OPEN", author: {} } as any]); vi.mocked(updateAction).mockRejectedValue(new AppError(400, "INVALID_INPUT", "Completion note is required.")); vi.mocked(updateTension).mockRejectedValue(new AppError(409, "VERSION_CONFLICT", "conflict")); const reads = [toolCall("ra", "query_actions"), toolCall("rt", "query_tensions")]; const writes = [toolCall("wa", "update_action", { actionId: "a-mixed", expectedVersion: 2 }), toolCall("wt", "update_tension", { tensionId: "t-mixed", expectedVersion: 3 })]; chatMock.mockResolvedValueOnce({ content: "", tool_calls: reads }).mockResolvedValueOnce({ content: "", tool_calls: writes }); chatStreamMock.mockReturnValueOnce(streamResponse([], { content: "", tool_calls: reads })).mockReturnValueOnce(streamResponse([], { content: "", tool_calls: writes })); const expected = "Failed update result — action a-mixed — Completion note is required.; tension t-mixed — The record was modified by another request. Read the latest version and apply your changes again."; const { processConversationTurn, processConversationTurnStream } = await import("./conversation"); expect((await processConversationTurn(turnContext(actor))).assistantMessage).toBe(expected); expect((await collectConversationStream(processConversationTurnStream(turnContext(actor)))).chunks.join("")).toBe(expected); });
  it.each([["VERSION_CONFLICT", "The record was modified by another request. Read the latest version and apply your changes again."], ["INVALID_INPUT", "Completion note is required."], ["OTHER", "The versioned update could not be completed. Read the current item version before retrying."]])("streams deterministic %s guidance instead of false success", async (failureCode, expected) => { const actor = testUserActor(); const { prisma } = await import("@corgtex/shared"); const { AppError, updateAction } = await import("@corgtex/domain"); vi.mocked(prisma.action.findMany).mockResolvedValue([{ id: "a-1", version: 1, status: "OPEN", author: {} } as any]); vi.mocked(updateAction).mockRejectedValue(failureCode === "VERSION_CONFLICT" ? new AppError(409, failureCode, "conflict") : failureCode === "INVALID_INPUT" ? new AppError(400, failureCode, expected) : new Error("private failure")); chatMock.mockResolvedValueOnce({ content: "", tool_calls: [toolCall("nr", "query_actions")] }).mockResolvedValueOnce({ content: "", tool_calls: [toolCall("nw", "update_action", { actionId: "a-1", expectedVersion: 1 })] }); chatStreamMock.mockReturnValueOnce(streamResponse(["Updated."], { content: "Updated.", tool_calls: [toolCall("r", "query_actions")] })).mockReturnValueOnce(streamResponse([], { content: "", tool_calls: [toolCall("w", "update_action", { actionId: "a-1", expectedVersion: 1 })] })); const { processConversationTurn, processConversationTurnStream } = await import("./conversation"); expect((await processConversationTurn(turnContext(actor))).assistantMessage).toBe(expected); const { chunks, result } = await collectConversationStream(processConversationTurnStream(turnContext(actor))); expect(chunks.join("")).toBe(expected); expect(result.assistantMessage).toBe(expected); expect(result.assistantMessage).not.toContain("private failure"); });
  it("preserves safe tension validation guidance in both response paths", async () => { const actor = testUserActor(); const { prisma } = await import("@corgtex/shared"); const { AppError, updateTension } = await import("@corgtex/domain"); vi.mocked(prisma.tension.findMany).mockResolvedValue([{ id: "t-1", version: 1, status: "OPEN", author: {} } as any]); vi.mocked(updateTension).mockRejectedValue(new AppError(400, "INVALID_INPUT", "Resolution note is required.")); chatMock.mockResolvedValueOnce({ content: "", tool_calls: [toolCall("nr", "query_tensions")] }).mockResolvedValueOnce({ content: "", tool_calls: [toolCall("nw", "update_tension", { tensionId: "t-1", expectedVersion: 1 })] }); chatStreamMock.mockReturnValueOnce(streamResponse([], { content: "", tool_calls: [toolCall("r", "query_tensions")] })).mockReturnValueOnce(streamResponse([], { content: "", tool_calls: [toolCall("w", "update_tension", { tensionId: "t-1", expectedVersion: 1 })] })); const { processConversationTurn, processConversationTurnStream } = await import("./conversation"); expect((await processConversationTurn(turnContext(actor))).assistantMessage).toBe("Resolution note is required."); expect((await collectConversationStream(processConversationTurnStream(turnContext(actor)))).chunks.join("")).toBe("Resolution note is required."); });
  it("rejects guessed first-call updates without preserving claims in either response path", async () => {
    const actor = testUserActor(); const { prisma } = await import("@corgtex/shared"); const { updateAction, updateTension } = await import("@corgtex/domain");
    chatMock.mockResolvedValueOnce({ content: "Updated.", tool_calls: [toolCall("a1", "update_action", { actionId: "a-1", expectedVersion: 1 })] }).mockResolvedValueOnce({ content: "" }); const { processConversationTurn, processConversationTurnStream } = await import("./conversation"); const result = await processConversationTurn(turnContext(actor));
    expect(updateAction).not.toHaveBeenCalled(); expect(result.assistantMessage).toBe("The assistant did not return a natural-language response. Please retry or ask for a more specific summary.");
    expect(chatMock.mock.calls[0][0].tools.map((tool: any) => tool.function.name)).not.toEqual(expect.arrayContaining(["update_action", "update_tension"]));
    expect(chatMock.mock.calls[1][0].tools.map((tool: any) => tool.function.name)).toEqual(expect.arrayContaining(["update_action", "update_tension"]));
    chatStreamMock.mockReturnValueOnce(streamResponse(["Unverified."], { content: "Unverified.", tool_calls: [toolCall("t1", "update_tension", { tensionId: "t-1", expectedVersion: 1 })] })); const { chunks } = await collectConversationStream(processConversationTurnStream(turnContext(actor)));
    expect(updateTension).not.toHaveBeenCalled(); expect(prisma.tension.findMany).not.toHaveBeenCalled(); expect(chunks.join("")).toContain("could not safely complete"); expect(chunks.join("")).not.toContain("Unverified");
  });
  it("preserves ordinary follow-ups and incrementally streams no-tool chat", async () => {
    const actor = testUserActor(); chatMock.mockResolvedValueOnce({ content: "", tool_calls: [toolCall("s1", "search_brain", { query: "actions" })] }).mockResolvedValueOnce({ content: "Useful list response." }); const { processConversationTurn, processConversationTurnStream } = await import("./conversation"); expect((await processConversationTurn({ ...turnContext(actor), userMessage: "Show actions." })).assistantMessage).toBe("Useful list response."); chatStreamMock.mockReturnValueOnce(streamResponse([], { content: "", tool_calls: [toolCall("search", "search_brain", { query: "actions" })] })).mockReturnValueOnce(streamResponse(["Useful streamed response."], { content: "Useful streamed response." })); const { chunks, result } = await collectConversationStream(processConversationTurnStream({ ...turnContext(actor), userMessage: "Show actions." })); expect(chunks.join("")).toBe("Useful streamed response."); expect(result.assistantMessage).toBe("Useful streamed response.");
    const answer = answerCall("answer", "Hello world."); chatEventStreamMock.mockReturnValueOnce(eventResponse([{ type: "tool_call_delta", index: 0, idDelta: "answer", nameDelta: "respond_conversation", argumentsDelta: "{\"answer\":\"Hello" }, { type: "tool_call_delta", index: 0, argumentsDelta: " world.\"}" }], { content: "", tool_calls: [answer] })); const priorLegacyCalls = chatStreamMock.mock.calls.length; const stream = processConversationTurnStream({ ...turnContext(), userMessage: "Say hello." }); await expect(stream.next()).resolves.toEqual({ done: false, value: "Hello" }); await expect(stream.next()).resolves.toEqual({ done: false, value: " world." }); await expect(stream.next()).resolves.toMatchObject({ done: true, value: { assistantMessage: "Hello world." } }); expect(chatStreamMock).toHaveBeenCalledTimes(priorLegacyCalls); expect(chatEventStreamMock).toHaveBeenLastCalledWith(expect.objectContaining({ tool_choice: "required", tools: expect.arrayContaining([expect.objectContaining({ function: expect.objectContaining({ name: "respond_conversation" }) }), expect.objectContaining({ function: expect.objectContaining({ name: "route_conversation_tools" }) })]) }));
    checkBudgetMock.mockReset().mockResolvedValueOnce({ allowed: true }).mockResolvedValueOnce({ allowed: false }); chatEventStreamMock.mockReturnValueOnce(eventResponse([{ type: "tool_call_delta", index: 0, idDelta: "budget", nameDelta: "respond_conversation", argumentsDelta: "{\"answer\":\"Still answered.\"}" }], { content: "", tool_calls: [answerCall("budget", "Still answered.")] })); const budget = await collectConversationStream(processConversationTurnStream({ ...turnContext(), userMessage: "Explain it." })); expect(budget.chunks.join("")).toBe("Still answered."); expect(budget.result.assistantMessage).toBe(budget.chunks.join("")); expect(checkBudgetMock).toHaveBeenCalledOnce(); checkBudgetMock.mockReset().mockResolvedValue({ allowed: true }); chatEventStreamMock.mockReturnValueOnce((async function* () { yield { type: "tool_call_delta", index: 0, idDelta: "failed", nameDelta: "respond_conversation", argumentsDelta: "{\"answer\":\"Partial" }; throw new Error("private stream failure"); })()); const failed = await collectConversationStream(processConversationTurnStream(turnContext())); expect(failed.chunks.join("")).toBe("Partial\n\nI could not safely complete that response. Please retry."); expect(failed.result.assistantMessage).toBe(failed.chunks.join(""));
  });
  it("reports committed initial tools when follow-up budget is exhausted without retrying", async () => { const actor = testUserActor(); const { createAction, createGoal } = await import("@corgtex/domain"); vi.mocked(createAction).mockResolvedValue({ id: "a-committed" } as any); vi.mocked(createGoal).mockRejectedValue(new Error("private failure")); const calls = [toolCall("a", "create_action", { title: "Do it" }), toolCall("g", "create_goal", { title: "Goal" })]; checkBudgetMock.mockReset().mockResolvedValueOnce({ allowed: true }).mockResolvedValueOnce({ allowed: false }); chatStreamMock.mockReturnValueOnce(streamResponse([], { content: "", tool_calls: calls })); const { processConversationTurnStream } = await import("./conversation"); const streamed = await collectConversationStream(processConversationTurnStream(turnContext(actor))); const partial = "Tool execution result — succeeded: create_action (action a-committed); failed: create_goal. The workspace model budget was reached before a follow-up summary could be generated. Retry only failed calls after checking current state."; expect(streamed.chunks.join("")).toBe(partial); expect(streamed.result.assistantMessage).toBe(partial); expect(createAction).toHaveBeenCalledOnce(); expect(createGoal).toHaveBeenCalledOnce(); expect(chatEventStreamMock).toHaveBeenCalledOnce(); expect(chatStreamMock).toHaveBeenCalledOnce(); vi.mocked(createAction).mockClear().mockResolvedValue({ id: "a-one" } as any); checkBudgetMock.mockReset().mockResolvedValueOnce({ allowed: true }).mockResolvedValueOnce({ allowed: false }); chatMock.mockResolvedValueOnce({ content: "", tool_calls: [toolCall("only", "create_action", { title: "Once" })] }); const { processConversationTurn } = await import("./conversation"); const direct = await processConversationTurn(turnContext(actor)); expect(direct.assistantMessage).toBe("Tool execution result — succeeded: create_action (action a-one). The workspace model budget was reached before a follow-up summary could be generated. Do not retry successful calls."); expect(createAction).toHaveBeenCalledOnce(); expect(chatMock).toHaveBeenCalledOnce(); });
  it("uses a one-call answer-only boundary for the fake provider", async () => { (env as any).MODEL_PROVIDER = "fake"; const { createAction } = await import("@corgtex/domain"); chatEventStreamMock.mockReturnValueOnce(eventResponse([{ type: "content_delta", content: "Fake " }, { type: "content_delta", content: "answer." }], { content: "Fake answer." })); const { processConversationTurnStream } = await import("./conversation"); const delivered = await collectConversationStream(processConversationTurnStream(turnContext())); expect(delivered.chunks).toEqual(["Fake ", "answer."]); expect(delivered.result.assistantMessage).toBe(delivered.chunks.join("")); expect(chatEventStreamMock).toHaveBeenCalledOnce(); expect(chatEventStreamMock).toHaveBeenCalledWith(expect.not.objectContaining({ tools: expect.anything(), tool_choice: expect.anything() })); expect(chatStreamMock).not.toHaveBeenCalled(); expect(createAction).not.toHaveBeenCalled(); });
  it.each(["content", "duplicate", "malformed", "unoffered"])("fails closed for %s route wrappers without mutation", async (kind) => { const { updateAction } = await import("@corgtex/domain"); const answer = answerCall("a", "Draft"); const route = kind === "unoffered" ? toolCall("r", "route_conversation_tools", { calls: [{ name: "update_action", arguments: { actionId: "a-1", expectedVersion: 1 } }] }) : kind === "malformed" ? { id: "a", function: { name: "respond_conversation", arguments: "{\"answer\":\"Cut" } } : answer; const events = kind === "content" ? [{ type: "content_delta", content: "Outside" }] : kind === "duplicate" ? [{ type: "tool_call_delta", index: 0, idDelta: "a", nameDelta: "respond_conversation", argumentsDelta: answer.function.arguments }, { type: "tool_call_delta", index: 1, idDelta: "b", nameDelta: "respond_conversation", argumentsDelta: answer.function.arguments }] : [{ type: "tool_call_delta", index: 0, idDelta: route.id, nameDelta: route.function.name, argumentsDelta: route.function.arguments }]; const terminal = { content: kind === "content" ? "Outside" : "", tool_calls: kind === "duplicate" ? [answer, answerCall("b", "Draft")] : [route] }; chatEventStreamMock.mockReturnValueOnce(eventResponse(events, terminal)); const result = await collectConversationStream((await import("./conversation")).processConversationTurnStream(turnContext())); expect(result.result.assistantMessage).toBe(result.chunks.join("")); expect(result.chunks.join("")).toContain("could not safely complete"); if (kind === "content") expect(result.chunks.join("")).not.toContain("Outside"); expect(updateAction).not.toHaveBeenCalled(); }); it.each(["Revise this action's title.", "Adjust the assignee.", "The other one too."])("keeps versioned follow-up tools for contextual wording: %s", async (userMessage) => {
    chatStreamMock.mockReturnValueOnce(streamResponse([], { content: "", tool_calls: [toolCall("r", "query_actions")] })).mockReturnValueOnce(streamResponse(["Current action."], { content: "Current action." })); const { processConversationTurnStream } = await import("./conversation"); await collectConversationStream(processConversationTurnStream({ ...turnContext(), userMessage }));
    expect(chatStreamMock.mock.calls[1][0].tools.map((tool: any) => tool.function.name)).toEqual(expect.arrayContaining(["update_action", "update_tension"]));
  });

  it("rejects CRM activity preparations with invalid due dates before storing a pending operation", async () => {
    const actor = {
      kind: "user" as const,
      user: {
        id: "user-1",
        email: "user@example.com",
        displayName: "User",
      },
    };
    chatMock
      .mockResolvedValueOnce({
        content: "",
        tool_calls: [{
          id: "call-1",
          function: {
            name: "record_relationship_activity",
            arguments: JSON.stringify({
              title: "Follow up",
              type: "TASK",
              accountId: "account-1",
              dueAt: "tomorrow",
            }),
          },
        }],
      })
      .mockResolvedValueOnce({ content: "Please provide a specific due date before I prepare the CRM activity." });

    const { processConversationTurn } = await import("./conversation");
    const result = await processConversationTurn({
      workspaceId: "ws-1",
      sessionId: "session-1",
      userId: "user-1",
      agentKey: "assistant",
      userMessage: "Create a CRM follow-up for tomorrow.",
      actor,
    });

    const toolMessage = chatMock.mock.calls[1]?.[0]?.messages.find((message: any) => message.role === "tool");
    expect(toolMessage.content).toContain("CRM activity due date must be a valid date");
    expect(conversationPendingOperationCreateMock).not.toHaveBeenCalled();
    expect(createActivityMock).not.toHaveBeenCalled();
    expect(result.assistantMessage).toBe("Please provide a specific due date before I prepare the CRM activity.");
  });

  it("rejects CRM activity preparations with unsupported activity types before storing a pending operation", async () => {
    const actor = {
      kind: "user" as const,
      user: {
        id: "user-1",
        email: "user@example.com",
        displayName: "User",
      },
    };
    chatMock
      .mockResolvedValueOnce({
        content: "",
        tool_calls: [{
          id: "call-1",
          function: {
            name: "record_relationship_activity",
            arguments: JSON.stringify({ title: "Follow up", type: "VISIT", accountId: "account-1" }),
          },
        }],
      })
      .mockResolvedValueOnce({ content: "Please use a supported CRM activity type." });

    const { processConversationTurn } = await import("./conversation");
    const result = await processConversationTurn({
      workspaceId: "ws-1",
      sessionId: "session-1",
      userId: "user-1",
      agentKey: "assistant",
      userMessage: "Create a CRM visit for Acme.",
      actor,
    });

    const toolMessage = chatMock.mock.calls[1]?.[0]?.messages.find((message: any) => message.role === "tool");
    expect(toolMessage.content).toContain("Unsupported CRM activity type");
    expect(conversationPendingOperationCreateMock).not.toHaveBeenCalled();
    expect(createActivityMock).not.toHaveBeenCalled();
    expect(result.assistantMessage).toBe("Please use a supported CRM activity type.");
  });

  it("rejects CRM suggestion preparations without required fields before storing a pending operation", async () => {
    const actor = {
      kind: "user" as const,
      user: {
        id: "user-1",
        email: "user@example.com",
        displayName: "User",
      },
    };
    chatMock
      .mockResolvedValueOnce({
        content: "",
        tool_calls: [{
          id: "call-1",
          function: {
            name: "create_communication_suggestion",
            arguments: JSON.stringify({ title: "Draft outreach", accountId: "account-1" }),
          },
        }],
      })
      .mockResolvedValueOnce({ content: "Please provide the draft body before I prepare the CRM suggestion." });

    const { processConversationTurn } = await import("./conversation");
    const result = await processConversationTurn({
      workspaceId: "ws-1",
      sessionId: "session-1",
      userId: "user-1",
      agentKey: "assistant",
      userMessage: "Prepare a CRM communication suggestion for Acme.",
      actor,
    });

    const toolMessage = chatMock.mock.calls[1]?.[0]?.messages.find((message: any) => message.role === "tool");
    expect(toolMessage.content).toContain("CRM communication suggestion body text is required");
    expect(conversationPendingOperationCreateMock).not.toHaveBeenCalled();
    expect(createCommunicationSuggestionMock).not.toHaveBeenCalled();
    expect(result.assistantMessage).toBe("Please provide the draft body before I prepare the CRM suggestion.");
  });

  it("rejects CRM suggestions without a relationship link before storing a pending operation", async () => {
    const actor = {
      kind: "user" as const,
      user: {
        id: "user-1",
        email: "user@example.com",
        displayName: "User",
      },
    };
    chatMock
      .mockResolvedValueOnce({
        content: "",
        tool_calls: [{
          id: "call-1",
          function: {
            name: "create_communication_suggestion",
            arguments: JSON.stringify({ title: "Draft outreach", bodyMd: "Hello from Corgtex." }),
          },
        }],
      })
      .mockResolvedValueOnce({ content: "Please select the CRM relationship before I prepare the suggestion." });

    const { processConversationTurn } = await import("./conversation");
    const result = await processConversationTurn({
      workspaceId: "ws-1",
      sessionId: "session-1",
      userId: "user-1",
      agentKey: "assistant",
      userMessage: "Prepare a CRM communication suggestion.",
      actor,
    });

    const toolMessage = chatMock.mock.calls[1]?.[0]?.messages.find((message: any) => message.role === "tool");
    expect(toolMessage.content).toContain("A CRM communication suggestion must be linked to an account, contact, deal, or activity");
    expect(conversationPendingOperationCreateMock).not.toHaveBeenCalled();
    expect(createCommunicationSuggestionMock).not.toHaveBeenCalled();
    expect(result.assistantMessage).toBe("Please select the CRM relationship before I prepare the suggestion.");
  });

  it("rejects CRM activity completions with invalid completion dates before storing a pending operation", async () => {
    const actor = {
      kind: "user" as const,
      user: {
        id: "user-1",
        email: "user@example.com",
        displayName: "User",
      },
    };
    chatMock
      .mockResolvedValueOnce({
        content: "",
        tool_calls: [{
          id: "call-1",
          function: {
            name: "complete_relationship_activity",
            arguments: JSON.stringify({ activityId: "activity-1", completedAt: "later" }),
          },
        }],
      })
      .mockResolvedValueOnce({ content: "Please provide a valid completion timestamp." });

    const { processConversationTurn } = await import("./conversation");
    const result = await processConversationTurn({
      workspaceId: "ws-1",
      sessionId: "session-1",
      userId: "user-1",
      agentKey: "assistant",
      userMessage: "Complete the CRM follow-up later.",
      actor,
    });

    const toolMessage = chatMock.mock.calls[1]?.[0]?.messages.find((message: any) => message.role === "tool");
    expect(toolMessage.content).toContain("CRM activity completion date must be a valid date");
    expect(conversationPendingOperationCreateMock).not.toHaveBeenCalled();
    expect(completeActivityMock).not.toHaveBeenCalled();
    expect(result.assistantMessage).toBe("Please provide a valid completion timestamp.");
  });

  it("rejects CRM suggestions with invalid channels before storing a pending operation", async () => {
    const actor = {
      kind: "user" as const,
      user: {
        id: "user-1",
        email: "user@example.com",
        displayName: "User",
      },
    };
    chatMock
      .mockResolvedValueOnce({
        content: "",
        tool_calls: [{
          id: "call-1",
          function: {
            name: "create_communication_suggestion",
            arguments: JSON.stringify({
              title: "Draft outreach",
              bodyMd: "Hello from Corgtex.",
              accountId: "account-1",
              channel: "email/channel",
            }),
          },
        }],
      })
      .mockResolvedValueOnce({ content: "Please provide a supported communication channel." });

    const { processConversationTurn } = await import("./conversation");
    const result = await processConversationTurn({
      workspaceId: "ws-1",
      sessionId: "session-1",
      userId: "user-1",
      agentKey: "assistant",
      userMessage: "Prepare a CRM communication suggestion for Acme.",
      actor,
    });

    const toolMessage = chatMock.mock.calls[1]?.[0]?.messages.find((message: any) => message.role === "tool");
    expect(toolMessage.content).toContain("CRM communication suggestion channel must be an uppercase code");
    expect(conversationPendingOperationCreateMock).not.toHaveBeenCalled();
    expect(createCommunicationSuggestionMock).not.toHaveBeenCalled();
    expect(result.assistantMessage).toBe("Please provide a supported communication channel.");
  });

  it("appends stored args when the model mentions only the pending operation ID", async () => {
    const actor = {
      kind: "user" as const,
      user: {
        id: "user-1",
        email: "user@example.com",
        displayName: "User",
      },
    };
    chatMock
      .mockResolvedValueOnce({
        content: "",
        tool_calls: [{
          id: "call-1",
          function: {
            name: "record_relationship_activity",
            arguments: JSON.stringify({ title: "Follow up", type: "TASK", accountId: "account-1" }),
          },
        }],
      })
      .mockResolvedValueOnce({ content: `Pending operation ${pendingOperationId(1)} is ready.` });

    const { processConversationTurn } = await import("./conversation");
    const result = await processConversationTurn({
      workspaceId: "ws-1",
      sessionId: "session-1",
      userId: "user-1",
      agentKey: "assistant",
      userMessage: "Create a CRM follow-up for Acme.",
      actor,
    });

    expect(result.assistantMessage).toContain(`Pending operation ${pendingOperationId(1)} is ready.`);
    expect(result.assistantMessage).toContain("Stored args: {\"accountId\":\"account-1\",\"title\":\"Follow up\",\"type\":\"TASK\"}");
    expect(createActivityMock).not.toHaveBeenCalled();
  });

  it("executes confirmed CRM writes from stored pending operation args", async () => {
    addPendingCrmOperation({
      argsJson: {
        title: "Stored follow up",
        type: "TASK",
        accountId: "account-1",
        dueAt: "2026-06-20T10:00:00.000Z",
      },
    });
    const actor = {
      kind: "user" as const,
      user: {
        id: "user-1",
        email: "user@example.com",
        displayName: "User",
      },
    };

    const { processConversationTurn } = await import("./conversation");
    const result = await processConversationTurn({
      workspaceId: "ws-1",
      sessionId: "session-1",
      userId: "user-1",
      agentKey: "assistant",
      userMessage: `confirm ${pendingOperationId(1)}, but call it Different follow up`,
      actor,
    });

    expect(createActivityMock).toHaveBeenCalledWith(actor, expect.objectContaining({
      workspaceId: "ws-1",
      title: "Stored follow up",
      type: "TASK",
      accountId: "account-1",
      source: "workspace-chat",
      dueAt: new Date("2026-06-20T10:00:00.000Z"),
    }));
    expect(chatMock).not.toHaveBeenCalled();
    expect(conversationPendingOperationStore[0].status).toBe("EXECUTED");
    expect(result.assistantMessage).toContain(`Confirmed pending operation ID: ${pendingOperationId(1)}`);
    expect(result.assistantMessage).toContain("Activity ID: activity-1");
  });

  it("repeated CRM confirmation is idempotent and does not duplicate writes", async () => {
    addPendingCrmOperation({
      status: "EXECUTED",
      resultJson: { success: true, activity: { id: "activity-1" } },
      executedAt: new Date(),
    });
    const actor = {
      kind: "user" as const,
      user: {
        id: "user-1",
        email: "user@example.com",
        displayName: "User",
      },
    };

    const { processConversationTurn } = await import("./conversation");
    const result = await processConversationTurn({
      workspaceId: "ws-1",
      sessionId: "session-1",
      userId: "user-1",
      agentKey: "assistant",
      userMessage: `confirm ${pendingOperationId(1)} again`,
      actor,
    });

    expect(createActivityMock).not.toHaveBeenCalled();
    expect(result.assistantMessage).toContain(`Confirmed pending operation ID: ${pendingOperationId(1)}`);
    expect(result.assistantMessage).toContain("Activity ID: activity-1");
  });

  it("does not execute CRM pending operations from generic confirmation without the operation ID", async () => {
    addPendingCrmOperation();
    const actor = {
      kind: "user" as const,
      user: {
        id: "user-1",
        email: "user@example.com",
        displayName: "User",
      },
    };
    chatMock.mockResolvedValueOnce({ content: "Please confirm the pending operation ID before I make that CRM change." });

    const { processConversationTurn } = await import("./conversation");
    const result = await processConversationTurn({
      workspaceId: "ws-1",
      sessionId: "session-1",
      userId: "user-1",
      agentKey: "assistant",
      userMessage: "yes, do it",
      actor,
    });

    expect(createActivityMock).not.toHaveBeenCalled();
    expect(conversationPendingOperationStore[0].status).toBe("PENDING");
    expect(result.assistantMessage).toContain("confirm the pending operation ID");
  });

  it("does not execute CRM pending operations from hypothetical confirmation text", async () => {
    addPendingCrmOperation();
    const actor = {
      kind: "user" as const,
      user: {
        id: "user-1",
        email: "user@example.com",
        displayName: "User",
      },
    };
    chatMock.mockResolvedValueOnce({ content: "Confirmation would create the stored CRM follow-up." });

    const { processConversationTurn } = await import("./conversation");
    const result = await processConversationTurn({
      workspaceId: "ws-1",
      sessionId: "session-1",
      userId: "user-1",
      agentKey: "assistant",
      userMessage: `what happens if I confirm ${pendingOperationId(1)}?`,
      actor,
    });

    expect(createActivityMock).not.toHaveBeenCalled();
    expect(conversationPendingOperationStore[0].status).toBe("PENDING");
    expect(result.assistantMessage).toBe("Confirmation would create the stored CRM follow-up.");
  });

  it("cancels pending CRM operations without executing the write", async () => {
    addPendingCrmOperation();
    const actor = {
      kind: "user" as const,
      user: {
        id: "user-1",
        email: "user@example.com",
        displayName: "User",
      },
    };

    const { processConversationTurn } = await import("./conversation");
    const result = await processConversationTurn({
      workspaceId: "ws-1",
      sessionId: "session-1",
      userId: "user-1",
      agentKey: "assistant",
      userMessage: `cancel ${pendingOperationId(1)}`,
      actor,
    });

    expect(createActivityMock).not.toHaveBeenCalled();
    expect(conversationPendingOperationStore[0].status).toBe("CANCELED");
    expect(result.assistantMessage).toBe(`Canceled pending operation ID: ${pendingOperationId(1)}`);
  });

  it("expires stale CRM pending operations before executing", async () => {
    addPendingCrmOperation({
      expiresAt: new Date(Date.now() - 60_000),
    });
    const actor = {
      kind: "user" as const,
      user: {
        id: "user-1",
        email: "user@example.com",
        displayName: "User",
      },
    };

    const { processConversationTurn } = await import("./conversation");
    const result = await processConversationTurn({
      workspaceId: "ws-1",
      sessionId: "session-1",
      userId: "user-1",
      agentKey: "assistant",
      userMessage: `confirm ${pendingOperationId(1)}`,
      actor,
    });

    expect(createActivityMock).not.toHaveBeenCalled();
    expect(conversationPendingOperationStore[0].status).toBe("EXPIRED");
    expect(result.assistantMessage).toContain("expired before confirmation");
  });

  it("does not overwrite an in-flight CRM pending operation as expired", async () => {
    addPendingCrmOperation({
      expiresAt: new Date(Date.now() - 60_000),
    });
    conversationPendingOperationUpdateManyMock.mockImplementationOnce(() => {
      conversationPendingOperationStore[0].status = "EXECUTING";
      return Promise.resolve({ count: 0 });
    });
    const actor = {
      kind: "user" as const,
      user: {
        id: "user-1",
        email: "user@example.com",
        displayName: "User",
      },
    };

    const { processConversationTurn } = await import("./conversation");
    const result = await processConversationTurn({
      workspaceId: "ws-1",
      sessionId: "session-1",
      userId: "user-1",
      agentKey: "assistant",
      userMessage: `confirm ${pendingOperationId(1)}`,
      actor,
    });

    expect(createActivityMock).not.toHaveBeenCalled();
    expect(conversationPendingOperationStore[0].status).toBe("EXECUTING");
    expect(result.assistantMessage).toContain("cannot be confirmed because it is executing");
  });

  it("does not expose context map tools when the premium AI flag is disabled", async () => {
    const actor = {
      kind: "user" as const,
      user: {
        id: "user-1",
        email: "user@example.com",
        displayName: "User",
      },
    };
    chatMock.mockResolvedValueOnce({ content: "Context map AI is not enabled." });

    const { processConversationTurn } = await import("./conversation");
    await processConversationTurn({
      workspaceId: "ws-1",
      sessionId: "session-1",
      userId: "user-1",
      agentKey: "assistant",
      userMessage: "Update this map",
      actor,
    });

    const tools = chatMock.mock.calls[0]?.[0]?.tools ?? [];
    const toolNames = tools.map((tool: any) => tool.function.name);
    expect(toolNames).not.toContain("get_context_map_info");
    expect(toolNames).not.toContain("apply_context_map_diff");
  });

  it("exposes context map tools and merge guidance when the premium AI flag is enabled", async () => {
    enableContextMapAi();
    const actor = {
      kind: "user" as const,
      user: {
        id: "user-1",
        email: "user@example.com",
        displayName: "User",
      },
    };
    chatMock.mockResolvedValueOnce({ content: "I can work with this map." });

    const { processConversationTurn } = await import("./conversation");
    await processConversationTurn({
      workspaceId: "ws-1",
      sessionId: "session-1",
      userId: "user-1",
      agentKey: "assistant",
      userMessage: "Merge these two process steps",
      actor,
    });

    const firstCall = chatMock.mock.calls[0]?.[0];
    const toolNames = (firstCall.tools ?? []).map((tool: any) => tool.function.name);
    expect(toolNames).toContain("get_context_map_info");
    expect(toolNames).toContain("apply_context_map_diff");
    expect(firstCall.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: "system",
        content: expect.stringContaining("For merge requests, ask which item survives if unclear"),
      }),
    ]));
  });

  it("applies context map diffs through the audited proposed-diff path", async () => {
    enableContextMapAi();
    const actor = {
      kind: "user" as const,
      user: {
        id: "user-1",
        email: "user@example.com",
        displayName: "User",
      },
    };
    chatMock
      .mockResolvedValueOnce({
        content: "",
        tool_calls: [{
          id: "call-1",
          function: {
            name: "apply_context_map_diff",
            arguments: JSON.stringify({
              reason: "Merge duplicate steps",
              diff: {
                objectUpdates: [
                  { id: "step-1", title: "Decision to proceed" },
                  { id: "step-2", status: "archived" },
                ],
              },
              evidence: {
                kind: "forged",
                pageContext: { unsafe: true },
              },
            }),
          },
        }],
      })
      .mockResolvedValueOnce({ content: "Applied the map change." });

    const { processConversationTurn } = await import("./conversation");
    const result = await processConversationTurn({
      workspaceId: "ws-1",
      sessionId: "session-1",
      userId: "user-1",
      agentKey: "assistant",
      userMessage: "yes, do it",
      actor,
    });

    expect(createContextGraphProposedDiffMock).toHaveBeenCalledWith(actor, expect.objectContaining({
      workspaceId: "ws-1",
      reason: "Merge duplicate steps",
      diff: expect.objectContaining({
        objectUpdates: expect.any(Array),
      }),
      evidence: expect.objectContaining({
        kind: "context-map-chat",
        pageContext: null,
      }),
    }));
    expect(applyContextGraphProposedDiffMock).toHaveBeenCalledWith(actor, {
      workspaceId: "ws-1",
      proposedDiffId: "diff-1",
    });
    expect(result.assistantMessage).toBe("Applied the map change.");
    expect(result.contextUsed.mapGraphChanged).toBe(true);
  });

  it("leaves a pending context map diff when direct apply lacks approval permission", async () => {
    enableContextMapAi();
    applyContextGraphProposedDiffMock.mockRejectedValueOnce(Object.assign(new Error("Forbidden"), {
      status: 403,
      code: "FORBIDDEN",
    }));
    const actor = {
      kind: "user" as const,
      user: {
        id: "user-1",
        email: "user@example.com",
        displayName: "User",
      },
    };
    chatMock
      .mockResolvedValueOnce({
        content: "",
        tool_calls: [{
          id: "call-1",
          function: {
            name: "apply_context_map_diff",
            arguments: JSON.stringify({
              diff: {
                objectUpdates: [{ id: "step-1", title: "Decision to proceed" }],
              },
            }),
          },
        }],
      })
      .mockResolvedValueOnce({ content: "I created a pending change for approval." });

    const { processConversationTurn } = await import("./conversation");
    const result = await processConversationTurn({
      workspaceId: "ws-1",
      sessionId: "session-1",
      userId: "user-1",
      agentKey: "assistant",
      userMessage: "do it",
      actor,
    });

    const toolMessage = chatMock.mock.calls[1]?.[0]?.messages.find((message: any) => message.role === "tool");
    expect(toolMessage.content).toContain("approval_required");
    expect(createContextGraphProposedDiffMock).toHaveBeenCalled();
    expect(result.contextUsed.mapGraphChanged).toBe(true);
  });

  it("reports completed reads when the tool-followup budget is exhausted", async () => {
    const actor = {
      kind: "user" as const,
      user: {
        id: "user-1",
        email: "user@example.com",
        displayName: "User",
      },
    };
    checkBudgetMock
      .mockResolvedValueOnce({ allowed: true, usedPct: 80, usedUsd: 4, capUsd: 5 })
      .mockResolvedValueOnce({ allowed: false, usedPct: 100, usedUsd: 5, capUsd: 5 });
    chatMock.mockResolvedValueOnce({
      content: "",
      tool_calls: [
        {
          id: "call-1",
          function: {
            name: "list_tool_links",
            arguments: "{}",
          },
        },
      ],
    });

    const { processConversationTurn } = await import("./conversation");

    const result = await processConversationTurn({
      workspaceId: "ws-1",
      sessionId: "session-1",
      userId: "user-1",
      agentKey: "assistant",
      userMessage: "What tools do we have?",
      actor,
    });
    expect(result.assistantMessage).toBe("Tool execution result — completed: list_tool_links. The workspace model budget was reached before a follow-up summary could be generated. Check current state before retrying.");
    expect(chatMock).toHaveBeenCalledTimes(1);
    expect(listWorkspaceToolLinksMock).toHaveBeenCalledWith(actor, { workspaceId: "ws-1" });
  });
});
