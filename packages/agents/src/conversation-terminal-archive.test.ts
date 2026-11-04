import { beforeEach, describe, expect, it, vi } from "vitest";
import { installSourcePermissionEpochFixture } from "../../domain/src/source-permission-epochs.test-fixture";
import type { AppActor } from "@corgtex/shared";
import type { LineageKind, LineageRoot } from "../../domain/src/source-lineage";

const fixture = vi.hoisted(() => {
  const tables = new Map<string, Map<string, any>>();
  const memberships = new Map<string, { id: string; role: string; isActive: boolean }>();
  const delegates = new Map<string, any>();
  const membership = vi.fn();
  const chat = vi.fn(); const eventStream = vi.fn(); const chatStream = vi.fn();
  const embedding = vi.fn(); const rerank = vi.fn(); const cache = new Map<string, any>();
  const updateHook = { current: null as null | ((delegate: string, row: any) => void) };
  const transactionErrors: Error[] = [];
  const provider = { value: "fake" };
  const commitHook = { current: null as null | (() => void) };
  const rollbackHook = { current: null as null | (() => void) };
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
  return { tables, memberships, delegates, membership, prisma, base, chat, eventStream, chatStream, embedding, rerank, cache, updateHook, transactionErrors, provider, commitHook, rollbackHook };
});

vi.mock("@corgtex/shared", async () => ({
  ...await import("../../shared/src/mcp-context"), ...await import("../../shared/src/math"),
  prisma: fixture.prisma, toInputJson: (value: unknown) => value,
  getSupportAuthorizationContext: () => undefined,
  getCacheJson: async (key: string) => fixture.cache.get(key) ?? null,
  setCacheJson: async (key: string, value: unknown) => { fixture.cache.set(key, structuredClone(value)); },
  getCacheVersion: async () => 0, incrementCacheVersion: async () => 0,
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
  env: { get MODEL_PROVIDER() { return fixture.provider.value; }, MODEL_CHAT_CONVERSATION: "synthetic-chat", KNOWLEDGE_SEARCH_PROVIDER: "postgres" },
}));
vi.mock("../../domain/src/auth", () => ({ requireWorkspaceMembership: fixture.membership, requireGlobalOperator: vi.fn(), actorUserIdForWorkspace: async (actor: AppActor) => actor.kind === "user" ? actor.user.id : null }));
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
  ...await import("../../domain/src/source-lineage"), ...await import("../../domain/src/conversation-lineage"),
  ...await import("../../domain/src/conversation-ingress"), ...await import("../../domain/src/conversations"),
  ...await import("../../domain/src/agent-memory"), ...await import("../../domain/src/digest-lineage"), ...await import("../../domain/src/source-scoped-read"),
  ...await import("../../domain/src/crm"),
  ...await import("../../domain/src/privacy"), ...await import("../../domain/src/tool-links"), ...await import("../../domain/src/conversation-operation-outcome"),
  AppError: (await import("../../domain/src/errors")).AppError,
  requireWorkspaceMembership: fixture.membership, resolveKnowledgeAccessDomains: (await import("../../domain/src/brain-access")).resolveKnowledgeAccessDomains,
  checkBudget: async () => ({ allowed: true }), supportCapabilityVersion: async () => 1,
  buildRoleOnboardingContextWithLineageForConversation: async () => null,
}));

import { AppError } from "../../domain/src/errors";
import { assertMcpOriginActive, getMcpOrigin } from "../../shared/src/mcp-context";
import { captureArtifactInputProof, isArtifactInputProofReadable, lineageContentFingerprint, recordArtifactInputLineage } from "../../domain/src/source-lineage";
import { processConversationTurn, processConversationTurnStream } from "./conversation";
import { createConversationPromptInput } from "../../domain/src/conversations";
import { getConversationOperationOutcomeInputRoots } from "../../domain/src/conversation-operation-outcome";
import { archiveToolLinkAction, getToolLinkArchiveEffectReceipt } from "./tools/tool-links";
import { createConversationLineageCollector } from "./conversation-lineage";
import { withArtifactInputWriteFence } from "../../domain/src/source-lineage";

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
beforeEach(async () => {
  vi.clearAllMocks(); fixture.tables.clear(); fixture.memberships.clear(); fixture.cache.clear(); fixture.updateHook.current = null; fixture.transactionErrors.length = 0; fixture.provider.value = "fake"; fixture.commitHook.current = null; fixture.rollbackHook.current = null;
  fixture.memberships.set(`${workspaceId}:synthetic-alice`, { id: "member-alice", role: "CONTRIBUTOR", isActive: true });
  fixture.memberships.set(`${workspaceId}:synthetic-bob`, { id: "member-bob", role: "CONTRIBUTOR", isActive: true });
  fixture.memberships.set("synthetic-ws-b:synthetic-bob", { id: "member-bob-b", role: "CONTRIBUTOR", isActive: true });
  fixture.membership.mockImplementation(async ({ actor, workspaceId: ws }) => {
    const origin = getMcpOrigin(); if (origin) await assertMcpOriginActive(tx, origin, ws);
    if (actor.kind === "agent") { if (!actor.workspaceIds?.includes(ws)) throw new AppError(403, "FORBIDDEN", "Synthetic workspace unavailable"); return null; }
    const member = fixture.memberships.get(`${ws}:${actor.user.id}`);
    if (!member) throw new AppError(403, "NOT_A_MEMBER", "Synthetic membership unavailable"); return member;
  });
  fixture.base.$transaction.mockImplementation(async (callback) => {
    const prior = structuredClone(fixture.tables);
    try { const value = await callback(fixture.prisma); fixture.commitHook.current?.(); return value; } catch (error) { fixture.transactionErrors.push(error as Error); fixture.tables.clear(); for (const [key, rows] of prior) fixture.tables.set(key, rows); fixture.rollbackHook.current?.(); throw error; }
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

const marker = "SYNTHETIC_PRIVATE_TOOL_CONTEXT";
const acknowledgment = { success: true, message: "The tool link was archived." };
async function privateTool() {
  const source = await original("BrainArticle", "brainArticle", { id: "private-tool-source", workspaceId, title: marker, bodyMd: `${marker} body`, isPrivate: true, ownerMemberId: "member-alice", archivedAt: null });
  const sourceRoots = await captureArtifactInputProof(alice, workspaceId, [{ kind: "BrainArticle", id: source.id }], tx);
  const tool = await derived("WorkspaceToolLink", "workspaceToolLink", { id: "private-tool", workspaceId, createdByUserId: base.userId,
    title: marker, url: "https://example.test/private-tool", descriptionMd: source.bodyMd, accessNotesMd: `${marker} access notes`,
    credentialLabel: null, credentialSecretEnc: null, archivedAt: null, archivedByUserId: null, archiveReason: null, circleTags: [] }, sourceRoots);
  return { source, tool };
}
async function actionContext(tool: any) {
  const prompt = await createConversationPromptInput(alice, { workspaceId, conversationId: base.sessionId, content: "Archive the selected tool." });
  const requestLineageRoots = await captureArtifactInputProof(alice, workspaceId, [{ kind: "ConversationPromptInput", id: prompt.id }], tx);
  const lineageRoots = await captureArtifactInputProof(alice, workspaceId, [{ kind: "WorkspaceToolLink", id: tool.id }], tx);
  return { workspaceId, lineageRoots: [...requestLineageRoots, ...lineageRoots], requestLineageRoots };
}
function archiveCall() { return { id: "synthetic-archive", type: "function", function: { name: "archive_tool_link", arguments: JSON.stringify({ toolLinkId: "private-tool" }) } }; }
function routeArchive() { return { id: "synthetic-archive-route", type: "function", function: { name: "route_conversation_tools", arguments: JSON.stringify({ calls: [{ name: "archive_tool_link", arguments: { toolLinkId: "private-tool" } }] }) } }; }

describe("terminal archive facts using actual domain receipts and conversation collectors", () => {
  it("binds only the constant committed outcome and native request after old private context is revoked", async () => {
    const { source, tool } = await privateTool(); const ctx = await actionContext(tool);
    const oldCollector = createConversationLineageCollector(alice, workspaceId); await oldCollector.captureTrusted({ body: tool.descriptionMd }, ctx.lineageRoots);
    const value = await archiveToolLinkAction(alice, ctx, { toolLinkId: tool.id });
    expect(value).toEqual(acknowledgment); expect(JSON.stringify(value)).not.toContain(marker);
    source.ownerMemberId = "member-bob";
    await expect(oldCollector.assertReadable()).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    const roots = await getConversationOperationOutcomeInputRoots(alice, workspaceId, value);
    expect(roots.some((root) => root.kind === "ConversationOperationOutcome")).toBe(true);
    expect(roots.some((root) => root.kind === "ConversationPromptInput")).toBe(true);
    expect(roots.some((root) => ["BrainArticle", "WorkspaceToolLink"].includes(root.kind))).toBe(false);
    const fresh = createConversationLineageCollector(alice, workspaceId); await fresh.addReceipt(value, await getToolLinkArchiveEffectReceipt(alice, workspaceId, value));
    await expect(fresh.assertReadable()).resolves.toBeUndefined();
    await expect(getToolLinkArchiveEffectReceipt(alice, workspaceId, { ...value })).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    await expect(getToolLinkArchiveEffectReceipt(bob, workspaceId, value)).rejects.toMatchObject({ code: "INVALID_INPUT_RECEIPT" });
    expect(fixture.tables.get("workspaceArchiveRecord")!.size).toBe(1);
  });

  it("replays an exact committed fact without rereading or executing the archived body and rejects another request", async () => {
    const { source, tool } = await privateTool(); const ctx = await actionContext(tool);
    const value = await archiveToolLinkAction(alice, ctx, { toolLinkId: tool.id }); source.ownerMemberId = "member-bob";
    const writes = fixture.delegates.get("workspaceToolLink").update.mock.calls.length;
    expect(await archiveToolLinkAction(alice, ctx, { toolLinkId: tool.id })).toEqual(value);
    expect(fixture.delegates.get("workspaceToolLink").update).toHaveBeenCalledTimes(writes);
    const otherPrompt = await createConversationPromptInput(alice, { workspaceId, conversationId: base.sessionId, content: "Archive the selected tool." });
    const otherRequest = await captureArtifactInputProof(alice, workspaceId, [{ kind: "ConversationPromptInput", id: otherPrompt.id }], tx);
    await expect(archiveToolLinkAction(alice, { ...ctx, requestLineageRoots: otherRequest }, { toolLinkId: tool.id })).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(fixture.tables.get("conversationOperationOutcome")!.size).toBe(1);
  });

  it("does not mint an acknowledgment when the archive transaction throws or its owner fence expires", async () => {
    const { tool } = await privateTool(); const ctx = await actionContext(tool);
    const create = tx.conversationOperationOutcome.create; const realCreate = create.getMockImplementation()!;
    create.mockImplementationOnce(async (args: any) => { await realCreate(args); throw new Error("Synthetic outcome commit rejected"); });
    await expect(archiveToolLinkAction(alice, ctx, { toolLinkId: tool.id })).rejects.toThrow("Synthetic outcome commit rejected");
    expect(fixture.tables.get("workspaceToolLink")!.get(tool.id).archivedAt).toBeNull();
    expect(fixture.tables.get("conversationOperationOutcome")?.size ?? 0).toBe(0); expect(fixture.tables.get("workspaceArchiveRecord")?.size ?? 0).toBe(0);
    await expect(withArtifactInputWriteFence(async () => { throw new AppError(409, "OWNER_STALE", "Synthetic owner expired"); },
      () => archiveToolLinkAction(alice, ctx, { toolLinkId: tool.id }))).rejects.toMatchObject({ code: "OWNER_STALE" });
    expect(fixture.tables.get("workspaceToolLink")!.get(tool.id).archivedAt).toBeNull(); expect(fixture.tables.get("conversationOperationOutcome")?.size ?? 0).toBe(0);
  });

  it("terminates the actual conversation with no model follow-up or old body after commit", async () => {
    const { source } = await privateTool(); const modelSource = await mixedKnowledge();
    fixture.chat.mockResolvedValueOnce(reply("", [archiveCall()]));
    fixture.commitHook.current = () => { if (fixture.tables.get("conversationOperationOutcome")?.size) { source.ownerMemberId = "member-bob"; modelSource.ownerMemberId = "member-bob"; } };
    const result = await processConversationTurn({ ...base, userMessage: "Archive the selected tool." });
    expect(result.assistantMessage).toBe(acknowledgment.message); expect(result.contextUsed).toEqual({}); expect(fixture.chat).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain(marker); expect(result.lineageRoots.some((root) => root.kind === "ConversationOperationOutcome")).toBe(true);
    expect(await isArtifactInputProofReadable(alice, workspaceId, result.lineageRoots, tx)).toBe(true);
    fixture.chat.mockResolvedValueOnce(reply("", [archiveCall()]));
    const replay = await processConversationTurn({ ...base, userMessage: "Archive the selected tool.", promptInputId: result.promptInputId });
    expect(replay.assistantMessage).toBe(acknowledgment.message); expect(replay.contextUsed).toEqual({});
    expect(fixture.delegates.get("workspaceToolLink").update).toHaveBeenCalledTimes(1);
  });

  describe.each([false, true])("terminal archive cancellation (stream=%s)", (streaming) => {
    it.each([false, true])("preserves cancellation after a committed terminal archive when aborted=%s", async (aborted) => {
      await privateTool();
      const controller = new AbortController();
      const cancellation = new Error("synthetic terminal archive canceled");
      fixture.commitHook.current = () => {
        if (aborted && fixture.tables.get("conversationOperationOutcome")?.size) controller.abort(cancellation);
      };
      if (streaming) {
        fixture.provider.value = "synthetic";
        const route = routeArchive();
        fixture.eventStream.mockImplementation(async function* () {
          yield { type: "tool_call_delta", index: 0, idDelta: route.id, nameDelta: route.function.name, argumentsDelta: route.function.arguments };
          return reply("", [route]);
        });
      } else {
        fixture.chat.mockResolvedValueOnce(reply("", [archiveCall()]));
      }
      const chunks: string[] = [];
      const ctx = { ...base, userMessage: "Archive the selected tool.", signal: controller.signal };
      const turn = streaming ? (async () => {
        const iterator = processConversationTurnStream(ctx);
        while (true) {
          const next = await iterator.next();
          if (next.done) return next.value;
          chunks.push(next.value);
        }
      })() : processConversationTurn(ctx);
      if (aborted) {
        await expect(turn).rejects.toBe(cancellation);
        expect(chunks).toEqual([]);
      } else {
        expect((await turn).assistantMessage).toBe(acknowledgment.message);
        expect(chunks).toEqual(streaming ? [acknowledgment.message] : []);
      }
      expect(fixture.tables.get("conversationOperationOutcome")?.size).toBe(1);
      expect(fixture.tables.get("workspaceToolLink")!.get("private-tool").archivedAt).toBeInstanceOf(Date);
      expect(streaming ? fixture.eventStream : fixture.chat).toHaveBeenCalledOnce();
      expect(fixture.chatStream).not.toHaveBeenCalled();
    });
  });

  it("withholds the actual conversation after archive rollback and current private context revocation", async () => {
    await privateTool(); await mixedKnowledge();
    const create = tx.conversationOperationOutcome.create; const realCreate = create.getMockImplementation()!;
    create.mockImplementationOnce(async (args: any) => { await realCreate(args); throw new Error("Synthetic outcome commit rejected"); });
    fixture.rollbackHook.current = () => { fixture.tables.get("brainArticle")!.get("private-input").ownerMemberId = "member-bob"; };
    fixture.chat.mockResolvedValueOnce(reply("", [archiveCall()]));
    await expect(processConversationTurn({ ...base, userMessage: "Archive the selected tool." })).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(fixture.chat).toHaveBeenCalledTimes(1); expect(fixture.tables.get("conversationOperationOutcome")?.size ?? 0).toBe(0);
    expect(fixture.tables.get("workspaceToolLink")!.get("private-tool").archivedAt).toBeNull();
  });

  it("rechecks native acknowledgment grants when the streaming consumer resumes and never yields archived context", async () => {
    await privateTool(); fixture.provider.value = "synthetic";
    const route = routeArchive(); fixture.eventStream.mockImplementation(async function* () {
      yield { type: "tool_call_delta", index: 0, idDelta: route.id, nameDelta: route.function.name, argumentsDelta: route.function.arguments };
      return reply("", [route]);
    });
    const stream = processConversationTurnStream({ ...base, userMessage: "Archive the selected tool." });
    expect(await stream.next()).toEqual({ done: false, value: acknowledgment.message });
    fixture.memberships.delete(`${workspaceId}:synthetic-alice`);
    await expect(stream.next()).rejects.toMatchObject({ code: "NOT_A_MEMBER" });
    expect(fixture.eventStream).toHaveBeenCalledTimes(1); expect(fixture.chatStream).not.toHaveBeenCalled();
  });
});
