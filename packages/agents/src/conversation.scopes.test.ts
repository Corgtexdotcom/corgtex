import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";
import type { ChatCompletionResponse } from "@corgtex/models";
import { MCP_TOOL_CAPABILITIES } from "../../domain/src/mcp-tool-capabilities";

const m = vi.hoisted(() => ({
  membership: vi.fn(), credential: vi.fn(), grant: vi.fn(),
  chat: vi.fn(), events: vi.fn(), stream: vi.fn(), search: vi.fn(), memories: vi.fn(), profile: vi.fn(), onboarding: vi.fn(),
  reveal: vi.fn(), pending: vi.fn(), pendingFind: vi.fn(), pendingFindUnique: vi.fn(), pendingUpdate: vi.fn(), pendingUpdateMany: vi.fn(),
  activity: vi.fn(), actions: vi.fn(), storeMemory: vi.fn(), accessDomains: vi.fn(),
}));
vi.mock("@corgtex/shared", () => ({
  getSupportAuthorizationContext: () => undefined,
  mcpCredentialVersion: (hash: string) => `version:${hash}`,
  env: { MODEL_CHAT_CONVERSATION: "synthetic-model", MODEL_PROVIDER: "openai_compatible" },
  prisma: {
    agentCredential: { findUnique: m.credential, findFirst: vi.fn() },
    workspaceSupportGrant: { findUnique: m.grant },
    modelUsage: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
    conversationTurn: { findMany: vi.fn().mockResolvedValue([]) },
    conversationPendingOperation: {
      findUnique: m.pendingFindUnique, findFirst: m.pendingFind, count: vi.fn().mockResolvedValue(0),
      create: m.pending, update: m.pendingUpdate, updateMany: m.pendingUpdateMany,
    },
    auditLog: { findFirst: vi.fn().mockResolvedValue(null), update: vi.fn() },
    brainArticle: { findUnique: m.profile },
    workspaceFeatureFlag: { findMany: vi.fn().mockResolvedValue([]) },
    oAuthConnection: { findFirst: vi.fn() },
    action: { findMany: m.actions, count: vi.fn().mockResolvedValue(0) },
    tension: { findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0) },
    proposal: { findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0) },
    goal: { count: vi.fn().mockResolvedValue(0) }, member: { count: vi.fn().mockResolvedValue(0) }, circle: { count: vi.fn().mockResolvedValue(0) },
  },
}));
vi.mock("../../domain/src/auth", () => ({ requireWorkspaceMembership: m.membership }));
vi.mock("@corgtex/knowledge", () => ({ searchIndexedKnowledge: m.search }));
vi.mock("@corgtex/models", async importOriginal => ({
  ...await importOriginal<typeof import("@corgtex/models")>(),
  assertCatalogModelBudget: vi.fn().mockResolvedValue(undefined),
  defaultModelGateway: { chat: m.chat, chatEventStream: m.events, chatStream: m.stream },
}));
vi.mock("@corgtex/domain", async () => ({
  ...await import("../../domain/src/errors"),
  ...await import("../../domain/src/agent-operation-capabilities"),
  ...await import("../../domain/src/agent-operation-authorization"),
  requireWorkspaceMembership: m.membership,
  checkBudget: vi.fn().mockResolvedValue({ allowed: true, usedPct: 0, usedUsd: 0, capUsd: 5 }),
  supportCapabilityVersion: vi.fn().mockResolvedValue(1),
  privacyFilter: () => ({ isPrivate: false }),
  resolveKnowledgeAccessDomains: m.accessDomains,
  loadRelevantMemories: m.memories, storeAgentMemory: m.storeMemory,
  buildRoleOnboardingContextForConversation: m.onboarding,
  revealWorkspaceToolLinkCredential: m.reveal, createActivity: m.activity,
  archiveWorkspaceToolLink: vi.fn(), upsertWorkspaceToolLink: vi.fn(), listWorkspaceToolLinks: vi.fn().mockResolvedValue([]),
  listExternalMcpConnections: vi.fn().mockResolvedValue([]), executeExternalMcpTool: vi.fn(),
  fetchConnectedExternalMcpContext: vi.fn(), searchConnectedExternalMcpContext: vi.fn(),
  applyContextGraphProposedDiff: vi.fn(), createContextGraphProposedDiff: vi.fn(), buildSelectedRegionContext: vi.fn(), getContextMapData: vi.fn(),
  assignRole: vi.fn(), unassignRole: vi.fn(), listMembersEnriched: vi.fn(), getMemberProfile: vi.fn(), updateMember: vi.fn(),
  createAction: vi.fn(), updateAction: vi.fn(), createTension: vi.fn(), updateTension: vi.fn(),
  createProposal: vi.fn(), createProposalFromTension: vi.fn(), updateProposal: vi.fn(), createGoal: vi.fn(), listGoals: vi.fn().mockResolvedValue([]),
  createMeetingSeries: vi.fn(), intakeMeetingTranscript: vi.fn(), refreshOAuthTokenIfNeeded: vi.fn(), ingestConversationOnDemand: vi.fn(),
  actionRequestSource: vi.fn(), completeActivity: vi.fn(), createCommunicationSuggestion: vi.fn(), listCrmActivities: vi.fn(),
}));

import { processConversationTurn, processConversationTurnStream } from "./conversation";

const workspaceId = "synthetic-workspace";
const allScopes = [...new Set(Object.values(MCP_TOOL_CAPABILITIES).flatMap(capability => [...capability.scopes]))];
const agent = (scopes: string[]): AppActor => ({
  kind: "agent", authProvider: "credential", label: "synthetic-agent", workspaceIds: [workspaceId], scopes,
  credentialId: "synthetic-credential", credentialVersion: "version:synthetic-hash",
});
const oauthHuman: AppActor = { kind: "user", user: { id: "synthetic-user", email: "synthetic@example.test", displayName: null, globalRole: "OPERATOR" } };
type Context = Parameters<typeof processConversationTurn>[0] & { operationScopes?: readonly string[] };
const context = (actor: AppActor, operationScopes?: readonly string[]): Context => ({
  workspaceId, sessionId: "synthetic-session", userId: "synthetic-user", agentKey: "assistant",
  userMessage: "Please help with this synthetic request.", actor, operationScopes,
});
const toolCall = (name: string, args: Record<string, unknown> = {}) => ({
  id: "synthetic-call", type: "function" as const, function: { name, arguments: JSON.stringify(args) },
});
const response = (calls: ReturnType<typeof toolCall>[] = []): ChatCompletionResponse => ({
  content: calls.length ? "" : "Synthetic answer.", tool_calls: calls,
  usage: { provider: "synthetic", model: "synthetic-model", inputTokens: 1, outputTokens: 1 },
});

function script(first: ChatCompletionResponse) {
  m.chat.mockReset().mockResolvedValue(response()).mockResolvedValueOnce(first);
  m.events.mockImplementation(() => (async function* () {
    const name = first.tool_calls?.length ? "route_conversation_tools" : "respond_conversation";
    const args = first.tool_calls?.length
      ? { calls: first.tool_calls.map(call => ({ name: call.function.name, arguments: JSON.parse(call.function.arguments) })) }
      : { answer: first.content };
    const call = { id: "synthetic-route", type: "function" as const, function: { name, arguments: JSON.stringify(args) } };
    yield { type: "tool_call_delta", index: 0, idDelta: call.id, nameDelta: name, argumentsDelta: call.function.arguments };
    return { ...response(), content: "", tool_calls: [call] };
  })());
  m.stream.mockImplementation(() => (async function* () {
    yield "Synthetic answer.";
    return response();
  })());
}

async function run(streaming: boolean, ctx: Context) {
  if (!streaming) return processConversationTurn(ctx);
  const iterator = processConversationTurnStream(ctx);
  while (true) {
    const next = await iterator.next();
    if (next.done) return next.value;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  m.chat.mockReset(); m.events.mockReset(); m.stream.mockReset();
  m.membership.mockResolvedValue({ id: "synthetic-member", workspaceId, userId: "synthetic-user", role: "ADMIN", isActive: true });
  m.credential.mockResolvedValue({ workspaceId, isActive: true, tokenHash: "synthetic-hash", scopes: allScopes, createdBy: null, supportGrantVersion: null });
  m.grant.mockResolvedValue(null);
  m.search.mockResolvedValue([]);
  m.accessDomains.mockResolvedValue(["WORKSPACE"]);
  m.pendingFind.mockResolvedValue(null); m.pendingFindUnique.mockResolvedValue(null);
  m.pendingUpdate.mockResolvedValue(null); m.pendingUpdateMany.mockResolvedValue({ count: 0 });
  m.memories.mockResolvedValue([{ content: "synthetic-private-memory", memoryType: "FACT" }]);
  m.profile.mockResolvedValue({ bodyMd: "synthetic-private-profile" });
  m.onboarding.mockResolvedValue("synthetic-private-onboarding");
  m.reveal.mockResolvedValue({ credentialLabel: "synthetic-label", credentialSecret: "synthetic-secret" });
  m.pending.mockImplementation(({ data }) => ({ ...data, id: "synthetic-pending", expiresAt: new Date(Date.now() + 60_000) }));
  m.actions.mockResolvedValue([]);
  script(response());
});

describe.each([false, true])("conversation scope enforcement (streaming=%s)", streaming => {
  it.each(["credential", "oauth-human"] as const)("skips eager Brain, memory, profile, and onboarding for chat-only %s", async principal => {
    const actor = principal === "credential" ? agent(["conversations:write"]) : oauthHuman;
    const ctx = { ...context(actor, principal === "oauth-human" ? ["conversations:write"] : undefined), agentKey: "role-onboarding" };
    await run(streaming, ctx);
    for (const loader of [m.search, m.memories, m.profile, m.onboarding]) expect(loader).not.toHaveBeenCalled();
    const request = (streaming ? m.events : m.chat).mock.calls[0][0];
    const modelContext = JSON.stringify(request.messages);
    for (const privateText of ["synthetic-private-memory", "synthetic-private-profile", "synthetic-private-onboarding"]) expect(modelContext).not.toContain(privateText);
  });

  it.each(["credential", "oauth-human"] as const)("omits disallowed native tools for chat-only %s", async principal => {
    const actor = principal === "credential" ? agent(["conversations:write"]) : oauthHuman;
    await run(streaming, context(actor, principal === "oauth-human" ? ["conversations:write"] : undefined));
    const request = (streaming ? m.events : m.chat).mock.calls[0][0];
    expect(JSON.stringify(request.tools)).not.toContain("reveal_tool_link_credential");
    expect(JSON.stringify(request.tools)).not.toContain("query_actions");
    expect(JSON.stringify(request.tools)).not.toContain("create_tension");
  });

  it.each(["credential", "oauth-human"] as const)("denies model-requested secret reveal before the secret function for %s", async principal => {
    script(response([toolCall("reveal_tool_link_credential", { toolLinkId: "synthetic-link", operationScopes: allScopes })]));
    const actor = principal === "credential" ? agent(["conversations:write"]) : oauthHuman;
    await run(streaming, context(actor, principal === "oauth-human" ? ["conversations:write"] : undefined));
    expect(m.reveal).not.toHaveBeenCalled();
  });

  it.each(["credential", "oauth-human"] as const)("denies a pure requested Brain batch before knowledge access resolution for %s", async principal => {
    script(response([toolCall("search_brain", { query: "synthetic-knowledge-query", operationScopes: allScopes })]));
    const actor = principal === "credential" ? agent(["conversations:write"]) : oauthHuman;
    await run(streaming, context(actor, principal === "oauth-human" ? ["conversations:write"] : undefined))
      .catch(error => expect(error).toMatchObject({ status: 403 }));
    expect(m.accessDomains).not.toHaveBeenCalled();
    expect(m.search).not.toHaveBeenCalled();
  });

  it.each(["credential", "oauth-human"] as const)("allows an explicitly granted sensitive native operation for %s", async principal => {
    script(response([toolCall("reveal_tool_link_credential", { toolLinkId: "synthetic-link" })]));
    const scopes = ["conversations:write", "tools:credentials:read"];
    const actor = principal === "credential" ? agent(scopes) : oauthHuman;
    await run(streaming, context(actor, principal === "oauth-human" ? scopes : undefined));
    expect(m.reveal).toHaveBeenCalledOnce();
    expect(m.reveal).toHaveBeenCalledWith(actor, { workspaceId, toolLinkId: "synthetic-link" });
  });

  it("does not create a CRM pending operation before its write scope check", async () => {
    script(response([toolCall("record_relationship_activity", { title: "Synthetic follow-up", type: "TASK", accountId: "synthetic-account" })]));
    await run(streaming, context(agent(["conversations:write"])));
    expect(m.pending).not.toHaveBeenCalled();
    expect(m.activity).not.toHaveBeenCalled();
  });

  it.each(["confirm", "cancel"])("blocks chat-only pending CRM %s before lookup or stored-result delivery", async intent => {
    const id = "123e4567-e89b-12d3-a456-426614174000";
    const stored = {
      id, workspaceId, conversationId: "synthetic-session", userId: "synthetic-user", agentKey: "assistant",
      toolName: "record_relationship_activity", argsJson: { title: "synthetic-stored-args" }, status: "EXECUTED",
      resultJson: { activity: { id: "synthetic-stored-result" } }, expiresAt: new Date(Date.now() + 60_000),
    };
    m.pendingFind.mockResolvedValue(stored); m.pendingFindUnique.mockResolvedValue(stored);
    const result = await run(streaming, { ...context(agent(["conversations:write"])), userMessage: `${intent} ${id}` })
      .catch(error => { expect(error).toMatchObject({ status: 403 }); return undefined; });
    for (const lookupOrWrite of [m.pendingFind, m.pendingFindUnique, m.pendingUpdate, m.pendingUpdateMany, m.activity]) {
      expect(lookupOrWrite).not.toHaveBeenCalled();
    }
    expect(result?.assistantMessage ?? "").not.toContain("synthetic-stored-result");
  });

  it("permits an explicitly scoped native Action read", async () => {
    script(response([toolCall("query_actions")]));
    await run(streaming, context(agent(["conversations:write", "actions:read"])));
    expect(m.actions).toHaveBeenCalledOnce();
    expect(m.actions.mock.calls[0][0]).toMatchObject({ where: { workspaceId, isPrivate: false } });
  });

  it("rejects revoked chat credentials before model or eager storage reads", async () => {
    m.credential.mockResolvedValue({ workspaceId, isActive: false, tokenHash: "synthetic-hash", scopes: allScopes });
    await expect(run(streaming, context(agent(["conversations:write"])))).rejects.toMatchObject({ code: "AGENT_AUTHORIZATION_REVOKED" });
    for (const reader of [m.chat, m.events, m.search, m.memories, m.profile, m.onboarding]) expect(reader).not.toHaveBeenCalled();
  });

  it.each(["credential", "oauth-human"] as const)("removes Finance from indexed queries when a Brain-only ceiling represents %s", async principal => {
    m.accessDomains.mockResolvedValue(["WORKSPACE", "FINANCE"]);
    const cachedScopes = ["conversations:write", "brain:read", "finance:read"];
    m.credential.mockResolvedValue({
      workspaceId, isActive: true, tokenHash: "synthetic-hash", scopes: cachedScopes, createdBy: null, supportGrantVersion: null,
    });
    const actor = principal === "credential" ? agent(cachedScopes) : oauthHuman;
    await run(streaming, context(actor, ["conversations:write", "brain:read"]));
    expect(m.search).toHaveBeenCalledOnce();
    expect(m.search.mock.calls[0][0]).toMatchObject({ workspaceId, accessDomains: ["WORKSPACE"] });
  });

  it("rejects Finance scope removal before eager content or model reads for a cached full credential", async () => {
    m.accessDomains.mockResolvedValue(["WORKSPACE", "FINANCE"]);
    const cachedScopes = ["conversations:write", "brain:read", "finance:read"];
    m.credential.mockResolvedValue({
      workspaceId, isActive: true, tokenHash: "synthetic-hash", scopes: ["conversations:write", "brain:read"],
      createdBy: null, supportGrantVersion: null,
    });
    const ctx = { ...context(agent(cachedScopes), cachedScopes), agentKey: "role-onboarding" };
    await expect(run(streaming, ctx)).rejects.toMatchObject({ code: "AGENT_AUTHORIZATION_REVOKED" });
    for (const reader of [m.search, m.memories, m.profile, m.onboarding, m.chat, m.events, m.stream]) {
      expect(reader).not.toHaveBeenCalled();
    }
  });

  it("preserves ordinary-human Finance domains authorized by role", async () => {
    m.accessDomains.mockResolvedValue(["WORKSPACE", "FINANCE"]);
    await run(streaming, context(oauthHuman));
    expect(m.search).toHaveBeenCalledOnce();
    expect(m.search.mock.calls[0][0]).toMatchObject({ workspaceId, accessDomains: ["WORKSPACE", "FINANCE"] });
    expect(m.credential).not.toHaveBeenCalled();
  });
});
