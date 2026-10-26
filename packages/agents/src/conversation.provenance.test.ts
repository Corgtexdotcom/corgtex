import { beforeEach, describe, expect, it, vi } from "vitest";
import { installSourcePermissionEpochFixture } from "../../domain/src/source-permission-epochs.test-fixture";
import type { AppActor } from "@corgtex/shared";
import type { ModelAttemptGuard } from "@corgtex/models";
import type { LineageKind, LineageRoot } from "../../domain/src/source-lineage";

const fixture = vi.hoisted(() => {
  const modelEnv = { MODEL_PROVIDER: "fake", MODEL_CHAT_CONVERSATION: "synthetic-chat", KNOWLEDGE_SEARCH_PROVIDER: "postgres" };
  const tables = new Map<string, Map<string, any>>();
  const memberships = new Map<string, { id: string; role: string }>();
  const delegates = new Map<string, any>();
  const membership = vi.fn();
  const chat = vi.fn(); const eventStream = vi.fn(); const chatStream = vi.fn();
  const embedding = vi.fn(); const rerank = vi.fn(); const cache = new Map<string, any>();
  const updateHook = { current: null as null | ((delegate: string, row: any) => void) };
  const commitHook = { current: null as null | ((result: any) => void) };
  const transactionErrors: Error[] = [];
  let serial = 0;
  const matches = (row: any, where: any): boolean => {
    if (!row) return false;
    for (const [key, value] of Object.entries(where ?? {}) as Array<[string, any]>) {
      if (key === "AND") { if (!(value as any[]).every((entry) => matches(row, entry))) return false; }
      else if (key === "OR") { if (!(value as any[]).some((entry) => matches(row, entry))) return false; }
      else if (value instanceof Date) { if (!(row[key] instanceof Date) || row[key].getTime() !== value.getTime()) return false; }
      else if (value && typeof value === "object" && "in" in value) { if (!(value.in as any[]).includes(row[key])) return false; }
      else if (value && typeof value === "object" && "startsWith" in value) { if (!String(row[key]).startsWith(String(value.startsWith))) return false; }
      else if (value === undefined) continue;
      else if (key === "conversation") { if (!matches(tables.get("conversationSession")?.get(row.conversationId), value)) return false; }
      else if (["account", "contact", "deal"].includes(key) && value && typeof value === "object") {
        const related = row[`${key}Id`] ? tables.get(`crm${key[0].toUpperCase()}${key.slice(1)}`)?.get(row[`${key}Id`]) : null;
        if ("is" in value ? !matches(related, value.is) : !matches(related, value)) return false;
      }
      else if (value && typeof value === "object" && "path" in value) { if (row[key]?.[value.path[0]] !== value.equals) return false; }
      else if (value && typeof value === "object" && "not" in value) { if ((row[key] ?? null) === value.not) return false; }
      else if (value && typeof value === "object" && "lt" in value) { if (!(row[key] < value.lt)) return false; }
      else if (value && typeof value === "object" && "gt" in value) { if (!(row[key] > value.gt)) return false; }
      else if (value && typeof value === "object" && "some" in value) { if (!Array.isArray(row[key]) || !row[key].some((entry: any) => matches(entry, value.some))) return false; }
      else if (value && typeof value === "object" && key.includes("_")) { if (!matches(row, value)) return false; }
      else if ((row[key] ?? null) !== value) return false;
    }
    return true;
  };
  const project = (row: any, select: any) => select ? Object.fromEntries(Object.keys(select).map((key) => [key, row[key]])) : structuredClone(row);
  const base = { $transaction: vi.fn(), $executeRaw: vi.fn(), $queryRaw: vi.fn(async () => [] as any[]) };
  const prisma = new Proxy(base, { get(target, property) {
    if (property in target) return target[property as keyof typeof target];
    const name = String(property);
    if (!delegates.has(name)) {
      const rows = () => [...(tables.get(name)?.values() ?? [])];
      const find = ({ where, select, orderBy, take }: any) => {
        let result = rows().filter((row) => matches(row, where));
        for (const [field, direction] of Object.entries(Array.isArray(orderBy) ? Object.assign({}, ...orderBy) : orderBy ?? {})) result.sort((a, b) => {
          const left = a[field] instanceof Date ? a[field].getTime() : a[field];
          const right = b[field] instanceof Date ? b[field].getTime() : b[field];
          return (left === right ? 0 : left > right ? 1 : -1) * (direction === "desc" ? -1 : 1);
        });
        return result.slice(0, take ?? result.length).map((row) => project(row, select));
      };
      delegates.set(name, {
        findFirst: vi.fn(async (args) => find(args)[0] ?? null), findUnique: vi.fn(async (args) => find(args)[0] ?? null),
        findMany: vi.fn(async (args) => find(args)),
        create: vi.fn(async ({ data }) => {
          const now = new Date();
          const row = { id: name === "conversationPendingOperation" ? `123e4567-e89b-12d3-a456-${String(++serial).padStart(12, "0")}` : `${name}-${++serial}`, createdAt: now, updatedAt: now,
            ...(name === "conversationPendingOperation" ? { status: "PENDING", proposedAt: now, resultJson: null, errorCode: null, errorMessage: null, executedAt: null, canceledAt: null } : {}), ...structuredClone(data) };
          if (!tables.has(name)) tables.set(name, new Map());
          tables.get(name)!.set(row.id, row);
          return structuredClone(row);
        }),
        update: vi.fn(async ({ where, data }) => {
          const row = rows().find((entry) => matches(entry, where));
          if (!row) throw new Error("Synthetic row unavailable");
          Object.assign(row, { updatedAt: new Date() }, structuredClone(data));
          updateHook.current?.(name, row);
          return structuredClone(row);
        }),
        updateMany: vi.fn(async ({ where, data }) => {
          const found = rows().filter((row) => matches(row, where));
          for (const row of found) Object.assign(row, { updatedAt: new Date() }, structuredClone(data));
          return { count: found.length };
        }),
      });
    }
    return delegates.get(name);
  } });
  return { modelEnv, tables, memberships, delegates, membership, prisma, base, chat, eventStream, chatStream, embedding, rerank, cache, updateHook, commitHook, transactionErrors };
});

vi.mock("@corgtex/shared", async () => ({
  ...await import("../../shared/src/mcp-context"), ...await import("../../shared/src/math"),
  prisma: fixture.prisma, toInputJson: (value: unknown) => value,
  getSupportAuthorizationContext: () => undefined,
  getCacheJson: async (key: string) => fixture.cache.get(key) ?? null,
  setCacheJson: async (key: string, value: unknown) => { fixture.cache.set(key, structuredClone(value)); },
  getCacheVersion: async () => 0, incrementCacheVersion: async () => 0,
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
  env: fixture.modelEnv,
}));
vi.mock("../../domain/src/auth", () => ({ requireWorkspaceMembership: fixture.membership, requireGlobalOperator: vi.fn() }));
vi.mock("../../domain/src/brain-access", () => ({ resolveKnowledgeAccessDomains: vi.fn(async (actor, workspaceId) => {
  await fixture.membership({ actor, workspaceId }); return ["WORKSPACE"];
}) }));
vi.mock("../../knowledge/src/azure-search", () => ({ getKnowledgeSearchProvider: () => "postgres", isAzureKnowledgeSearchConfigured: () => false,
  normalizeKnowledgeAccessDomains: (domains: string[]) => [...new Set(domains)], searchAzureKnowledge: async () => { throw new Error("No external provider in synthetic test"); } }));
vi.mock("@corgtex/knowledge", async () => await import("../../knowledge/src/retrieval"));
vi.mock("@corgtex/models", async (importOriginal) => ({ ...await importOriginal<typeof import("@corgtex/models")>(),
  assertCatalogModelBudget: vi.fn(), defaultModelGateway: { chat: fixture.chat, chatEventStream: fixture.eventStream, chatStream: fixture.chatStream,
    embed: fixture.embedding, rerank: fixture.rerank } }));
vi.mock("./pending-crm-operations", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./pending-crm-operations")>();
  return { ...actual, markCrmPendingOperationFailed: async (...args: Parameters<typeof actual.markCrmPendingOperationFailed>) => {
    fixture.transactionErrors.push(args[2] as Error);
    return actual.markCrmPendingOperationFailed(...args);
  } };
});
vi.mock("@corgtex/domain", async () => ({
  ...await import("../../domain/src/artifact-commit-preflight"),
  ...await import("../../domain/src/agent-operation-capabilities"),
  ...await import("../../domain/src/agent-operation-authorization"),
  ...await import("../../domain/src/source-lineage"), ...await import("../../domain/src/conversation-lineage"),
  ...await import("../../domain/src/conversation-ingress"), ...await import("../../domain/src/conversations"),
  ...await import("../../domain/src/agent-memory"), ...await import("../../domain/src/digest-lineage"), ...await import("../../domain/src/source-scoped-read"),
  ...await import("../../domain/src/crm"),
  ...await import("../../domain/src/privacy"),
  AppError: (await import("../../domain/src/errors")).AppError,
  requireWorkspaceMembership: fixture.membership, resolveKnowledgeAccessDomains: (await import("../../domain/src/brain-access")).resolveKnowledgeAccessDomains,
  checkBudget: async () => ({ allowed: true }), supportCapabilityVersion: async () => 1,
  buildRoleOnboardingContextWithLineageForConversation: async () => null,
}));

import { AppError } from "../../domain/src/errors";
import { mcpCredentialVersion, mcpScopesHash, runWithMcpOrigin, assertMcpOriginActive, getMcpOrigin, captureMcpOAuthGrantEpoch } from "../../shared/src/mcp-context";
import { captureArtifactInputProof, isArtifactInputProofReadable, lineageContentFingerprint, recordArtifactInputLineage } from "../../domain/src/source-lineage";
import { conversationAttemptRequest, processConversationTurn, processConversationTurnStream } from "./conversation";
import { createConversationLineageCollector } from "./conversation-lineage";

const workspaceId = "synthetic-ws-a";
const alice: AppActor = { kind: "user", user: { id: "synthetic-alice", email: "alice@example.test", displayName: null } };
const bob: AppActor = { kind: "user", user: { id: "synthetic-bob", email: "bob@example.test", displayName: null } };
const base = { actor: alice, workspaceId, sessionId: "session-alice", userId: "synthetic-alice", agentKey: "assistant", userMessage: "Synthetic policy follow-up" };
const tx = fixture.prisma as any;
const reply = (content = "Synthetic answer citing only the public policy", tool_calls?: any[]) => ({ content, tool_calls, model: "synthetic", usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
function insert(delegate: string, value: { id: string; [key: string]: unknown }) {
  const row: { id: string; [key: string]: any } = { createdAt: new Date(), updatedAt: new Date(), ...value };
  if (!fixture.tables.has(delegate)) fixture.tables.set(delegate, new Map());
  fixture.tables.get(delegate)!.set(row.id, row); return row;
}
async function original(kind: LineageKind, delegate: string, value: { id: string; [key: string]: unknown }) {
  const row = insert(delegate, value);
  await recordArtifactInputLineage({ tx, actor: alice, workspaceId: String(value.workspaceId ?? workspaceId), artifact: { kind, id: row.id }, content: row, origin: "HUMAN_ORIGINAL", inputs: [] });
  return row;
}
async function derived(kind: LineageKind, delegate: string, value: { id: string; [key: string]: unknown }, roots: LineageRoot[]) {
  const row = insert(delegate, value);
  await recordArtifactInputLineage({ tx, actor: alice, workspaceId: String(value.workspaceId ?? workspaceId), artifact: { kind, id: row.id }, content: row, origin: "DERIVED", inputs: [], inheritedRoots: roots });
  return row;
}
async function chunk(article: any) {
  const roots = await captureArtifactInputProof(alice, article.workspaceId, [{ kind: "BrainArticle", id: article.id }], tx);
  const row = insert("knowledgeChunk", { id: `chunk-${article.id}`, workspaceId: article.workspaceId, sourceType: "BRAIN_ARTICLE", sourceId: article.id, sourceTitle: article.title,
    chunkIndex: 0, content: article.bodyMd, accessDomain: "WORKSPACE", sensitivity: "INTERNAL", metadata: { sourceContentHash: lineageContentFingerprint("BrainArticle", article) }, embedding: [1, 0], embeddingModel: "synthetic-embedding", tokenCount: 7 });
  // KnowledgeChunk is immutable and has no updatedAt column. The SQL receipt
  // projection must match the actual persisted row, without fixture-only fields.
  delete row.updatedAt;
  await recordArtifactInputLineage({ tx, actor: alice, workspaceId: article.workspaceId, artifact: { kind: "KnowledgeChunk", id: row.id },
    content: row, origin: "DERIVED", inputs: [], inheritedRoots: roots });
  return row;
}
async function mixedKnowledge() {
  const privateSource = await original("BrainArticle", "brainArticle", { id: "private-input", workspaceId, title: "Synthetic private contributor", bodyMd: "Synthetic private policy fact", isPrivate: true, ownerMemberId: "member-alice", archivedAt: null });
  const privateRoots = await captureArtifactInputProof(alice, workspaceId, [{ kind: "BrainArticle", id: privateSource.id }], tx);
  const mixed = await derived("BrainArticle", "brainArticle", { id: "mixed-derived", workspaceId, title: "Synthetic mixed policy", bodyMd: "Synthetic policy from private and public material", isPrivate: false, ownerMemberId: null, archivedAt: null }, privateRoots);
  await chunk(mixed); return privateSource;
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }
async function collect(stream: ReturnType<typeof processConversationTurnStream>) {
  const chunks: string[] = [];
  while (true) { const next = await stream.next(); if (next.done) return { chunks, result: next.value }; chunks.push(next.value); }
}
function crmCompletionCall() { return { id: "synthetic-completion-tool", type: "function", function: { name: "complete_relationship_activity", arguments: JSON.stringify({ activityId: "activity-to-complete" }) } }; }
async function pendingCompletion() {
  await original("CrmAccount", "crmAccount", { id: "account-public", workspaceId, name: "Synthetic account", archivedAt: null });
  const activity = await original("CrmActivity", "crmActivity", { id: "activity-to-complete", workspaceId, accountId: "account-public", contactId: null, dealId: null,
    title: "Synthetic original activity", bodyMd: "Original activity bytes", type: "TASK", dueAt: null, completedAt: null, archivedAt: null });
  fixture.chat.mockResolvedValueOnce(reply("", [crmCompletionCall()])).mockResolvedValueOnce(reply("Please confirm the prepared CRM operation"));
  await processConversationTurn(base);
  const operation = [...fixture.tables.get("conversationPendingOperation")!.values()][0];
  expect(operation.status).toBe("PENDING"); return { activity, operation };
}

beforeEach(async () => {
  fixture.modelEnv.MODEL_PROVIDER = "fake";
  vi.clearAllMocks(); fixture.tables.clear(); fixture.memberships.clear(); fixture.cache.clear(); fixture.updateHook.current = null; fixture.commitHook.current = null; fixture.transactionErrors.length = 0;
  fixture.memberships.set(`${workspaceId}:synthetic-alice`, { id: "member-alice", role: "CONTRIBUTOR" });
  fixture.memberships.set(`${workspaceId}:synthetic-bob`, { id: "member-bob", role: "CONTRIBUTOR" });
  fixture.memberships.set("synthetic-ws-b:synthetic-bob", { id: "member-bob-b", role: "CONTRIBUTOR" });
  fixture.membership.mockImplementation(async ({ actor, workspaceId: ws }) => {
    const origin = getMcpOrigin(); if (origin) await assertMcpOriginActive(tx, origin, ws);
    if (actor.kind === "agent") { if (!actor.workspaceIds?.includes(ws)) throw new AppError(403, "FORBIDDEN", "Synthetic workspace unavailable"); return null; }
    const member = fixture.memberships.get(`${ws}:${actor.user.id}`);
    if (!member) throw new AppError(403, "NOT_A_MEMBER", "Synthetic membership unavailable"); return member;
  });
  fixture.base.$transaction.mockImplementation(async (callback) => {
    const prior = structuredClone(fixture.tables);
    let result;
    try { result = await callback(new Proxy(fixture.prisma, { get(target, property) { return property === "$transaction" ? undefined : Reflect.get(target, property); } })); } catch (error) { fixture.transactionErrors.push(error as Error); fixture.tables.clear(); for (const [key, rows] of prior) fixture.tables.set(key, rows); throw error; }
    fixture.commitHook.current?.(result);
    return result;
  });
  fixture.base.$executeRaw.mockReset().mockResolvedValue(1);
  fixture.base.$queryRaw.mockReset().mockResolvedValue([]);
  installSourcePermissionEpochFixture(tx);
  fixture.chat.mockResolvedValue(reply());
  fixture.embedding.mockResolvedValue({ embeddings: [[1, 0]], usage: {} });
  fixture.rerank.mockImplementation(async ({ documents }: any) => ({ results: documents.map((_: string, index: number) => ({ index, score: 1 - index / 10 })), usage: {} }));
  fixture.eventStream.mockImplementation(async function* () { yield { type: "content_delta", content: "Synthetic streamed answer" }; return reply("Synthetic streamed answer"); });
  fixture.chatStream.mockImplementation(async function* () { yield "Synthetic follow-up"; return reply("Synthetic follow-up"); });
  insert("conversationSession", { id: base.sessionId, workspaceId, userId: base.userId, agentKey: "assistant", systemPrompt: null });
  insert("conversationSession", { id: "session-bob", workspaceId, userId: "synthetic-bob", agentKey: "assistant", systemPrompt: null });
  insert("conversationSession", { id: "session-bob-b", workspaceId: "synthetic-ws-b", userId: "synthetic-bob", agentKey: "assistant", systemPrompt: null });
  insert("workspace", { id: workspaceId, name: "Synthetic workspace", slug: workspaceId });
  insert("member", { id: "member-alice", workspaceId, userId: base.userId, role: "CONTRIBUTOR", isActive: true });
  insert("member", { id: "member-bob", workspaceId, userId: "synthetic-bob", role: "CONTRIBUTOR", isActive: true });
  const publicArticle = await original("BrainArticle", "brainArticle", { id: "public-input", workspaceId, title: "Synthetic public policy", bodyMd: "Synthetic public policy fact", isPrivate: false, ownerMemberId: null, archivedAt: null });
  await chunk(publicArticle);
});

describe("conversation orchestration using actual provenance and permissions", () => {
  it("forwards the exact gateway attempt context before checking the original collector", async () => {
    const source = await mixedKnowledge();
    const collector = createConversationLineageCollector(alice, workspaceId);
    await collector.capture("Synthetic private contributor", [{ kind: "BrainArticle", id: source.id, snapshot: source }]);
    const attemptContext = Object.freeze({ signal: new AbortController().signal });
    let revoke = false;
    const originalGuard = vi.fn<ModelAttemptGuard>(async context => {
      expect(context).toBe(attemptContext);
      await Promise.resolve();
      if (revoke) source.ownerMemberId = "member-bob";
    });
    const request = conversationAttemptRequest({ ...base, collector }, {
      workspaceId, model: "synthetic", taskType: "AGENT", messages: [], authorizeAttempt: originalGuard,
    });
    await expect(request.authorizeAttempt(attemptContext)).resolves.toBeUndefined();
    revoke = true;
    await expect(request.authorizeAttempt(attemptContext)).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(originalGuard).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["chat", "credentials"], ["chat", "retry"],
    ["eventStream", "credentials"], ["eventStream", "retry"],
    ["chatStream", "credentials"], ["chatStream", "retry"],
    ["chat", "permitted"], ["eventStream", "permitted"], ["chatStream", "permitted"],
  ] as const)("fences private provider sends after %s %s wait", async (method, phase) => {
    const source = await mixedKnowledge();
    let sends = 0;
    const send = async (request: { authorizeAttempt?: ModelAttemptGuard }) => {
      const attemptContext = { signal: new AbortController().signal };
      // The adapter has already received the private prompt. Credential lookup
      // and provider backoff happen inside it, after the outer preflight.
      if (phase === "credentials") source.ownerMemberId = "member-bob";
      await request.authorizeAttempt?.(attemptContext);
      sends++;
      if (phase !== "credentials") {
        if (phase === "retry") source.ownerMemberId = "member-bob";
        await request.authorizeAttempt?.(attemptContext);
        sends++;
      }
    };
    if (method === "chat") {
      fixture.chat.mockImplementation(async request => { await send(request); return reply(); });
    } else if (method === "eventStream") {
      fixture.eventStream.mockImplementation(async function* (request) {
        await send(request); yield { type: "content_delta", content: "Synthetic streamed answer" };
        return reply("Synthetic streamed answer");
      });
    } else {
      fixture.modelEnv.MODEL_PROVIDER = "openai";
      const route = { id: "attempt-route", type: "function", function: { name: "route_conversation_tools",
        arguments: JSON.stringify({ calls: [{ name: "query_tensions", arguments: {} }] }) } };
      fixture.eventStream.mockImplementation(async function* () {
        yield { type: "tool_call_delta", index: 0, idDelta: route.id, nameDelta: route.function.name,
          argumentsDelta: route.function.arguments };
        return reply("", [route]);
      });
      fixture.chatStream.mockImplementation(async function* (request) {
        await send(request); yield "Synthetic follow-up"; return reply("Synthetic follow-up");
      });
    }
    const result = method === "chat" ? processConversationTurn(base) : collect(processConversationTurnStream(base));
    if (phase === "permitted") await expect(result).resolves.toBeDefined();
    else await expect(result).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(sends).toBe(phase === "credentials" ? 0 : phase === "retry" ? 1 : 2);
    expect(fixture[method]).toHaveBeenCalledTimes(1);
  });

  it("captures uncited private ranking/context inputs, filters other users and isolates workspaces", async () => {
    await mixedKnowledge();
    fixture.rerank.mockImplementation(async ({ documents }: any) => ({ results: [{ index: documents.findIndex((value: string) => value.includes("Synthetic public policy fact")), score: 1 }], usage: {} }));
    const own = await processConversationTurn(base);
    expect(own.contextUsed.knowledgeResults).toMatchObject([{ sourceId: "public-input" }]);
    expect(own.lineageRoots.some((root) => root.kind === "BrainArticle" && root.id === "private-input")).toBe(true);
    expect(own.lineageRoots.some((root) => root.kind === "KnowledgeChunk" && root.id === "chunk-mixed-derived")).toBe(true);
    expect(own.assistantMessage).not.toContain("private");
    const other = await processConversationTurn({ ...base, actor: bob, userId: "synthetic-bob", sessionId: "session-bob" });
    expect(other.lineageRoots.some((root) => root.id === "private-input")).toBe(false);
    const foreign = await processConversationTurn({ ...base, actor: bob, workspaceId: "synthetic-ws-b", userId: "synthetic-bob", sessionId: "session-bob-b" });
    expect(foreign.contextUsed.knowledgeResults).toBeUndefined();
    expect(foreign.lineageRoots.some((root) => root.id === "public-input" || root.id === "private-input")).toBe(false);
  });

  it("withholds model output when an uncited contributing source changes privacy during generation", async () => {
    const source = await mixedKnowledge();
    fixture.chat.mockImplementation(async () => { source.ownerMemberId = "member-bob"; return reply("Forbidden synthetic output"); });
    await expect(processConversationTurn(base)).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  });

  it("rechecks current membership after the model instead of releasing stale output", async () => {
    fixture.chat.mockImplementation(async () => { fixture.memberships.delete(`${workspaceId}:synthetic-alice`); return reply("Forbidden departed member output"); });
    await expect(processConversationTurn(base)).rejects.toMatchObject({ code: "NOT_A_MEMBER" });
  });

  it("admits complete private memory inputs and withholds unknown or another member's derived memories", async () => {
    const source = await original("BrainArticle", "brainArticle", { id: "memory-source", workspaceId, title: "Private memory source", bodyMd: "Synthetic private memory fact", isPrivate: true, ownerMemberId: "member-alice", archivedAt: null });
    const roots = await captureArtifactInputProof(alice, workspaceId, [{ kind: "BrainArticle", id: source.id }], tx);
    await derived("AgentMemory", "agentMemory", { id: "known-memory", workspaceId, agentKey: "assistant", memoryType: "conversation-summary", content: "Synthetic copied private memory", metadata: null }, roots);
    insert("agentMemory", { id: "unknown-memory", workspaceId, agentKey: "assistant", memoryType: "conversation-summary", content: "Synthetic unproven legacy memory", metadata: null });
    const own = await processConversationTurn(base);
    expect(JSON.stringify(fixture.chat.mock.calls[0][0].messages)).toContain("Synthetic copied private memory");
    expect(JSON.stringify(fixture.chat.mock.calls[0][0].messages)).not.toContain("Synthetic unproven legacy memory");
    expect(own.lineageRoots.some((root) => root.id === source.id)).toBe(true);
    const other = await processConversationTurn({ ...base, actor: bob, userId: "synthetic-bob", sessionId: "session-bob" });
    expect(JSON.stringify(fixture.chat.mock.calls.at(-1)![0].messages)).not.toContain("Synthetic copied private memory");
    expect(other.contextUsed.memories).toBeUndefined();
  });

  it("feeds only currently source-permitted query rows into model tools and keeps uncited read provenance", async () => {
    const source = await original("BrainArticle", "brainArticle", { id: "query-source", workspaceId, title: "Private query contributor", bodyMd: "Synthetic private query fact", isPrivate: true, ownerMemberId: "member-alice", archivedAt: null });
    const roots = await captureArtifactInputProof(alice, workspaceId, [{ kind: "BrainArticle", id: source.id }], tx);
    const author = { id: "synthetic-alice", email: "alice@example.test", displayName: "Synthetic Alice", bio: null };
    insert("user", { ...author, memberships: [{ workspaceId, isActive: true }] });
    await derived("Tension", "tension", { id: "mixed-tension", workspaceId, title: "Synthetic source-derived tension", bodyMd: "Synthetic source-derived body", isPrivate: false,
      authorUserId: author.id, author, assigneeMember: null, status: "OPEN", priority: 1, version: 1, archivedAt: null }, roots);
    insert("tension", { id: "legacy-tension", workspaceId, title: "Unproven legacy tension", bodyMd: "Unproven body", isPrivate: false, author, status: "OPEN", archivedAt: null });
    const call = { id: "query-tool", type: "function", function: { name: "query_tensions", arguments: "{}" } };
    fixture.chat.mockResolvedValueOnce(reply("", [call])).mockResolvedValueOnce(reply("Synthetic query summary"));
    const own = await processConversationTurn(base);
    const ownTool = fixture.chat.mock.calls.at(-1)![0].messages.find((message: any) => message.role === "tool");
    expect(JSON.parse(ownTool.content)).toMatchObject([{ id: "mixed-tension", title: "Synthetic source-derived tension" }]);
    expect(ownTool.content).not.toContain("legacy");
    expect(own.lineageRoots.some((root) => root.id === source.id)).toBe(true);
    fixture.chat.mockResolvedValueOnce(reply("", [call])).mockResolvedValueOnce(reply("Synthetic empty query summary"));
    await processConversationTurn({ ...base, actor: bob, userId: "synthetic-bob", sessionId: "session-bob" });
    const otherTool = fixture.chat.mock.calls.at(-1)![0].messages.find((message: any) => message.role === "tool");
    expect(JSON.parse(otherTool.content)).toEqual([]);
  });

  it("buffers stream chunks until terminal source proof and releases none on model-time privacy revocation", async () => {
    const source = await mixedKnowledge(); const produced = deferred(); const terminal = deferred();
    fixture.eventStream.mockImplementation(async function* () { yield { type: "content_delta", content: "Synthetic restricted chunk" }; produced.resolve(); await terminal.promise; return reply("Synthetic restricted chunk"); });
    const stream = processConversationTurnStream(base); const first = stream.next(); let delivered = false;
    void first.then(() => { delivered = true; }, () => undefined);
    await produced.promise; expect(delivered).toBe(false);
    source.ownerMemberId = "member-bob"; terminal.resolve();
    await expect(first).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  });

  it("checks permissions again when a streaming consumer resumes after a delivered chunk", async () => {
    const source = await mixedKnowledge(); const stream = processConversationTurnStream(base);
    expect(await stream.next()).toMatchObject({ done: false, value: "Synthetic streamed answer" });
    source.ownerMemberId = "member-bob";
    await expect(stream.next()).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  });

  it("returns permitted streamed content with its complete terminal proof", async () => {
    await mixedKnowledge(); const result = await collect(processConversationTurnStream(base));
    expect(result.chunks.join("")).toBe(result.result.assistantMessage);
    expect(result.result.lineageRoots.some((root) => root.id === "private-input")).toBe(true);
  });

  it("uses native MCP credential ingress and denies scope revocation during model generation", async () => {
    const credential = insert("agentCredential", { id: "credential-a", workspaceId, isActive: true, tokenHash: "synthetic-token", scopes: ["conversations:write", "brain:read"] });
    const actor: AppActor = { kind: "agent", authProvider: "credential", label: "Synthetic agent", credentialId: credential.id, credentialVersion: mcpCredentialVersion(credential.tokenHash), scopes: [...credential.scopes], workspaceIds: [workspaceId] };
    const request = { ...base, actor, userId: "agent", requestSource: "MCP" as const, systemPrompt: "Untrusted client prompt" };
    const result = await processConversationTurn(request);
    expect(result.promptInputId).toBeUndefined(); expect(result.lineageRoots.some((root) => root.kind === "ConversationIngressInput")).toBe(true);
    expect(JSON.stringify(fixture.chat.mock.calls[0][0].messages)).not.toContain("Untrusted client prompt");
    fixture.chat.mockImplementation(async () => { credential.scopes = ["brain:read"]; return reply("Restricted agent result"); });
    await expect(processConversationTurn(request)).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  });

  it("honors native MCP OAuth membership and live scope revocation", async () => {
    const token = insert("mcpOAuthAccessToken", { id: "oauth-a", workspaceId, userId: base.userId, scopes: ["conversations:write"], revokedAt: null, client: { isActive: true }, refreshExpiresAt: null });
    const origin = { kind: "oauth" as const, id: token.id, workspaceId, scopeHash: mcpScopesHash(token.scopes), grantEpoch: await captureMcpOAuthGrantEpoch(tx, workspaceId, token.id), requiredScopes: ["conversations:write"] };
    const result = await runWithMcpOrigin(origin, () => processConversationTurn({ ...base, requestSource: "MCP" }));
    expect(result.lineageRoots.some((root) => root.kind === "ConversationIngressInput")).toBe(true);
    fixture.chat.mockImplementation(async () => { token.scopes = []; return reply("Revoked OAuth result"); });
    await expect(runWithMcpOrigin(origin, () => processConversationTurn({ ...base, requestSource: "MCP" }))).rejects.toThrow("MCP_AUTHORIZATION_REVOKED");
  });

  it("peeks only scoped pending tool metadata and never reads a stored tool outside the caller's grant", async () => {
    const { operation } = await pendingCompletion();
    const stored = fixture.tables.get("conversationPendingOperation")!.get(operation.id);
    stored.toolName = "reveal_tool_link_credential";
    stored.argsJson = { secret: "wrong-scope-argument-canary" };
    stored.resultJson = { secret: "wrong-scope-result-canary" };
    const pendingDelegate = fixture.delegates.get("conversationPendingOperation");
    pendingDelegate.findFirst.mockClear(); pendingDelegate.findUnique.mockClear(); pendingDelegate.update.mockClear();
    fixture.chat.mockClear();
    const result = await processConversationTurn({ ...base, userMessage: `confirm ${operation.id}`,
      operationScopes: ["conversations:write", "relationships:write"] });
    expect(pendingDelegate.findFirst).toHaveBeenCalledOnce();
    expect(pendingDelegate.findFirst).toHaveBeenCalledWith({
      where: { workspaceId, conversationId: base.sessionId, userId: base.userId, agentKey: base.agentKey,
        id: operation.id, toolName: { in: ["record_relationship_activity", "complete_relationship_activity", "create_communication_suggestion"] } },
      select: { id: true, status: true, toolName: true }, orderBy: { createdAt: "desc" },
    });
    expect(pendingDelegate.findUnique).not.toHaveBeenCalled();
    expect(pendingDelegate.update).not.toHaveBeenCalled();
    expect(JSON.stringify(fixture.chat.mock.calls)).not.toContain("wrong-scope-");
    expect(JSON.stringify(result)).not.toContain("wrong-scope-");
    expect(fixture.tables.get("crmActivity")!.get("activity-to-complete").completedAt).toBeNull();
  });

  it("confirms stored CRM arguments through the actual mutator and prevents replay effects", async () => {
    const { operation } = await pendingCompletion();
    const pendingDelegate = fixture.delegates.get("conversationPendingOperation");
    pendingDelegate.findFirst.mockClear();
    const response = await processConversationTurn({ ...base, userMessage: `confirm ${operation.id}`,
      operationScopes: ["conversations:write", "relationships:write"] });
    expect(pendingDelegate.findFirst.mock.calls[0][0]).toMatchObject({ select: { id: true, status: true, toolName: true } });
    expect(pendingDelegate.findFirst.mock.calls[1][0]).toMatchObject({ where: { id: operation.id, toolName: "complete_relationship_activity" } });
    expect(response.assistantMessage, fixture.transactionErrors.map((error) => error.stack).join("\n")).toContain("Activity ID: activity-to-complete");
    expect(fixture.tables.get("crmActivity")!.get("activity-to-complete").completedAt).toBeInstanceOf(Date);
    expect(fixture.tables.get("conversationPendingOperation")!.get(operation.id).status).toBe("EXECUTED");
    const updates = fixture.delegates.get("crmActivity").update.mock.calls.length;
    expect((await processConversationTurn({ ...base, userMessage: `confirm ${operation.id}` })).assistantMessage).toContain("Activity ID: activity-to-complete");
    expect(fixture.delegates.get("crmActivity").update.mock.calls.length).toBe(updates);
  });

  it("preserves immutable mutation inputs but withholds completed CRM results after current privacy revocation", async () => {
    const source = await mixedKnowledge(); const { operation } = await pendingCompletion();
    const confirmed = await processConversationTurn({ ...base, userMessage: `confirm ${operation.id}` });
    expect(confirmed.assistantMessage).toContain("Activity ID: activity-to-complete");
    expect(await isArtifactInputProofReadable(alice, workspaceId, confirmed.lineageRoots, tx)).toBe(true);
    const snapshots = [...fixture.tables.get("artifactInputSnapshot")!.values()];
    expect(snapshots.some((row) => row.sourceKind === "CrmActivity" && row.contentJson.completedAt === null && row.contentJson.bodyMd === "Original activity bytes")).toBe(true);
    source.ownerMemberId = "member-bob";
    expect(await isArtifactInputProofReadable(alice, workspaceId, confirmed.lineageRoots, tx)).toBe(false);
    const updates = fixture.delegates.get("crmActivity").update.mock.calls.length;
    const replay = await processConversationTurn({ ...base, userMessage: `confirm ${operation.id}` });
    expect(replay.assistantMessage).not.toContain("Activity ID: activity-to-complete");
    expect(fixture.delegates.get("crmActivity").update.mock.calls.length).toBe(updates);
  });

  it("rolls back CRM mutation and copied receipt when cancellation invalidates its persistence fence", async () => {
    const { operation } = await pendingCompletion(); const controller = new AbortController(); const canceled = new Error("Synthetic cancellation");
    fixture.updateHook.current = (delegate) => { if (delegate === "crmActivity") controller.abort(canceled); };
    const persistenceFence = async () => { if (controller.signal.aborted) throw canceled; };
    await expect(processConversationTurn({ ...base, userMessage: `confirm ${operation.id}`, signal: controller.signal, persistenceFence })).rejects.toThrow("Synthetic cancellation");
    expect(fixture.tables.get("crmActivity")!.get("activity-to-complete").completedAt).toBeNull();
    expect([...fixture.tables.get("artifactInputLineage")!.values()].filter((row) => row.artifactType === "CrmActivity")).toHaveLength(1);
  });

  it("withholds a result revoked after commit without overwriting its canonical EXECUTED state", async () => {
    const source = await mixedKnowledge(); const { operation } = await pendingCompletion();
    fixture.commitHook.current = (result) => {
      if (result?.operation?.status === "EXECUTED") source.ownerMemberId = "member-bob";
    };
    await expect(processConversationTurn({ ...base, userMessage: `confirm ${operation.id}` })).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(fixture.tables.get("conversationPendingOperation")!.get(operation.id).status).toBe("EXECUTED");
    expect(fixture.tables.get("crmActivity")!.get("activity-to-complete").completedAt).toBeInstanceOf(Date);
    expect(fixture.delegates.get("conversationPendingOperation").update.mock.calls.some(([args]: any[]) => args.data.status === "FAILED")).toBe(false);
  });
});
