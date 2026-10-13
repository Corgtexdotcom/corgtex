import { memoryFixture } from "./conversation-memory.test-fixture";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";
import { installSourcePermissionEpochFixture } from "../../domain/src/source-permission-epochs.test-fixture";

vi.mock("@corgtex/shared", async () => ({
  ...await import("../../shared/src/mcp-context"), ...await import("../../shared/src/math"),
  prisma: memoryFixture.prisma, toInputJson: (value: unknown) => value,
  getSupportAuthorizationContext: () => undefined,
  getCacheJson: async (key: string) => memoryFixture.cache.get(key) ?? null,
  setCacheJson: async (key: string, value: unknown) => { memoryFixture.cache.set(key, structuredClone(value)); },
  getCacheVersion: async () => 0, incrementCacheVersion: async () => 0,
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
  env: { MODEL_PROVIDER: "fake", MODEL_CHAT_CONVERSATION: "synthetic-chat", KNOWLEDGE_SEARCH_PROVIDER: "postgres" },
}));
vi.mock("../../domain/src/auth", () => ({ requireWorkspaceMembership: memoryFixture.membership, requireGlobalOperator: vi.fn() }));
vi.mock("../../domain/src/finance", () => ({ getFinanceAccessPolicy: vi.fn(async (_actor, _workspaceId, usedTx) => {
  if (memoryFixture.boundary.inTransaction && usedTx !== memoryFixture.tx) throw new Error("Global finance read inside memory tx");
  return { canRead: false };
}) }));
vi.mock("../../knowledge/src/azure-search", () => ({ getKnowledgeSearchProvider: () => "postgres", isAzureKnowledgeSearchConfigured: () => false,
  normalizeKnowledgeAccessDomains: (domains: string[]) => [...new Set(domains)], searchAzureKnowledge: async () => { throw new Error("No external provider in synthetic test"); } }));
vi.mock("@corgtex/knowledge", () => ({ searchIndexedKnowledge: async () => [], getKnowledgeSearchInputRoots: () => [] }));
vi.mock("@corgtex/models", async (importOriginal) => ({ ...await importOriginal<typeof import("@corgtex/models")>(),
  assertCatalogModelBudget: vi.fn(), defaultModelGateway: { chat: memoryFixture.chat, chatEventStream: memoryFixture.eventStream, chatStream: memoryFixture.chatStream,
    embed: memoryFixture.embedding, rerank: memoryFixture.rerank } }));
vi.mock("@corgtex/domain", async () => ({
  ...await import("../../domain/src/source-lineage"), ...await import("../../domain/src/conversation-lineage"),
  ...await import("../../domain/src/conversation-ingress"), ...await import("../../domain/src/conversations"),
  ...await import("../../domain/src/agent-memory"), ...await import("../../domain/src/digest-lineage"), ...await import("../../domain/src/source-scoped-read"),
  ...await import("../../domain/src/crm"),
  ...await import("../../domain/src/privacy"),
  AppError: (await import("../../domain/src/errors")).AppError,
  requireWorkspaceMembership: memoryFixture.membership, resolveKnowledgeAccessDomains: (await import("../../domain/src/brain-access")).resolveKnowledgeAccessDomains,
  checkBudget: async () => ({ allowed: true }), supportCapabilityVersion: async () => 1,
  buildRoleOnboardingContextWithLineageForConversation: async () => null,
}));

import { AppError } from "../../domain/src/errors";
import { createConversationPromptInput, addConversationTurn } from "../../domain/src/conversations";
import { captureArtifactInputProof, isArtifactInputProofReadable } from "../../domain/src/source-lineage";
import { processConversationTurn, processConversationTurnStream } from "./conversation";

const workspaceId = "synthetic-memory-ws";
const actor: AppActor = { kind: "user", user: { id: "synthetic-memory-user", email: "memory@example.test", displayName: null } };
const ctx = { actor, workspaceId, sessionId: "synthetic-memory-session", userId: "synthetic-memory-user", agentKey: "assistant", userMessage: "Synthetic sixth request" };
const tx = memoryFixture.tx as any;
const reply = (content = "Synthetic sixth answer") => ({ content, model: "synthetic", usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
function insert(table: string, row: { id: string; [key: string]: unknown }) {
  if (!memoryFixture.tables.has(table)) memoryFixture.tables.set(table, new Map());
  memoryFixture.tables.get(table)!.set(row.id, { createdAt: new Date(), updatedAt: new Date(), ...row });
}
function size(table: string) { return memoryFixture.tables.get(table)?.size ?? 0; }
async function run(mode: "plain" | "stream", persistenceFence: (usedTx: any) => Promise<void>) {
  if (mode === "plain") return processConversationTurn({ ...ctx, persistenceFence });
  const stream = processConversationTurnStream({ ...ctx, persistenceFence });
  while (true) { const next = await stream.next(); if (next.done) return next.value; }
}

beforeEach(async () => {
  vi.clearAllMocks(); memoryFixture.tables.clear(); memoryFixture.memberships.clear(); memoryFixture.cache.clear();
  memoryFixture.boundary.inTransaction = false; memoryFixture.updateHook.current = null; memoryFixture.transactionErrors.length = 0;
  memoryFixture.memberships.set(`${workspaceId}:${ctx.userId}`, { id: "synthetic-memory-member", role: "CONTRIBUTOR" });
  memoryFixture.membership.mockImplementation(async ({ actor: requester, workspaceId: ws, tx: usedTx }) => {
    if (memoryFixture.boundary.inTransaction && usedTx !== tx) throw new Error("Global membership read inside memory tx");
    const member = memoryFixture.memberships.get(`${ws}:${requester.kind === "user" ? requester.user.id : "agent"}`);
    if (!member) throw new AppError(403, "NOT_A_MEMBER", "Synthetic membership unavailable");
    return member;
  });
  memoryFixture.base.$transaction.mockImplementation(async (work) => {
    const saved = structuredClone(memoryFixture.tables);
    memoryFixture.boundary.inTransaction = true;
    try { return await work(tx); } catch (error) {
      memoryFixture.transactionErrors.push(error as Error);
      memoryFixture.tables.clear(); for (const [table, rows] of saved) memoryFixture.tables.set(table, rows);
      throw error;
    } finally { memoryFixture.boundary.inTransaction = false; }
  });
  memoryFixture.chat.mockResolvedValue(reply());
  memoryFixture.eventStream.mockImplementation(async function* () { yield { type: "content_delta", content: "Synthetic sixth answer" }; return reply(); });
  memoryFixture.chatStream.mockImplementation(async function* () { yield "Synthetic sixth answer"; return reply(); });
  insert("conversationSession", { id: ctx.sessionId, workspaceId, userId: ctx.userId, agentKey: ctx.agentKey, systemPrompt: null });
  insert("workspace", { id: workspaceId, name: "Synthetic memory workspace", slug: workspaceId });
  insert("member", { id: "synthetic-memory-member", workspaceId, userId: ctx.userId, role: "CONTRIBUTOR", isActive: true });
  memoryFixture.bases.tx.$executeRaw.mockReset().mockResolvedValue(1);
  memoryFixture.bases.tx.$queryRaw.mockReset().mockResolvedValue([]);
  installSourcePermissionEpochFixture(tx);
  memoryFixture.base.$executeRaw.mockImplementation((...args) => memoryFixture.bases.tx.$executeRaw(...args));
  memoryFixture.base.$queryRaw.mockImplementation((...args) => memoryFixture.bases.tx.$queryRaw(...args));
  // Five genuine prior turns make the actual orchestration reach its periodic memory producer.
  for (let sequence = 1; sequence <= 5; sequence++) {
    const content = `Synthetic prior request ${sequence}`;
    const prompt = await createConversationPromptInput(actor, { workspaceId, conversationId: ctx.sessionId, content, tx });
    const lineageRoots = await captureArtifactInputProof(actor, workspaceId, [{ kind: "ConversationPromptInput", id: prompt.id }], tx);
    await addConversationTurn(actor, { workspaceId, conversationId: ctx.sessionId, promptInputId: prompt.id,
      userMessage: content, assistantMessage: `Synthetic prior answer ${sequence}`, lineageRoots, tx });
  }
  vi.clearAllMocks();
});

describe("periodic conversation memory uses the actual transactional producer", () => {
  it.each(["plain", "stream"] as const)("commits complete fifth-turn memory through distinct tx in %s mode", async (mode) => {
    expect(tx).not.toBe(memoryFixture.prisma);
    const fence = vi.fn(async (usedTx) => { if (memoryFixture.boundary.inTransaction) expect(usedTx).toBe(tx); });
    const result = await run(mode, fence);
    expect(result.assistantMessage).toBe("Synthetic sixth answer");
    expect(size("agentMemory")).toBe(1);
    const memory = [...memoryFixture.tables.get("agentMemory")!.values()][0];
    expect(memory.metadata.turnCount).toBe(5);
    expect(memoryFixture.tx.agentMemory.create).toHaveBeenCalledTimes(1);
    expect(memoryFixture.prisma.agentMemory.create).not.toHaveBeenCalled();
    const roots = await captureArtifactInputProof(actor, workspaceId, [{ kind: "AgentMemory", id: memory.id }], tx);
    expect(await isArtifactInputProofReadable(actor, workspaceId, roots, tx)).toBe(true);
    expect(fence.mock.calls.some(([usedTx]) => usedTx === tx)).toBe(true);
    expect(memoryFixture.transactionErrors).toEqual([]);
  });

  it.each(["plain", "stream"] as const)("withholds memory after ctx owner fence becomes stale during %s generation", async (mode) => {
    let stale = false;
    memoryFixture.chat.mockImplementation(async () => { stale = true; return reply(); });
    memoryFixture.eventStream.mockImplementation(async function* () { yield { type: "content_delta", content: "Synthetic sixth answer" }; stale = true; return reply(); });
    const fence = vi.fn(async (usedTx) => {
      if (memoryFixture.boundary.inTransaction) expect(usedTx).toBe(tx);
      if (stale) throw new AppError(409, "OWNER_STALE", "Synthetic owner expired");
    });
    expect((await run(mode, fence)).assistantMessage).toBe("Synthetic sixth answer");
    expect(memoryFixture.transactionErrors.some((error: any) => error.code === "OWNER_STALE")).toBe(true);
    expect(size("agentMemory")).toBe(0);
    expect([...memoryFixture.tables.get("artifactInputLineage")!.values()].some((row) => row.artifactType === "AgentMemory")).toBe(false);
  });

  it.each(["plain", "stream"] as const)("rolls back actual memory and receipt when owner expires after insertion in %s mode", async (mode) => {
    let stale = false;
    memoryFixture.updateHook.current = (table) => { if (table === "agentMemory") stale = true; };
    const fence = vi.fn(async (usedTx) => {
      if (memoryFixture.boundary.inTransaction) expect(usedTx).toBe(tx);
      if (stale) throw new AppError(409, "OWNER_STALE", "Synthetic owner expired after memory insert");
    });
    expect((await run(mode, fence)).assistantMessage).toBe("Synthetic sixth answer");
    expect(memoryFixture.tx.agentMemory.create).toHaveBeenCalledTimes(1);
    expect(memoryFixture.prisma.agentMemory.create).not.toHaveBeenCalled();
    expect(size("agentMemory")).toBe(0);
    expect([...memoryFixture.tables.get("artifactInputLineage")!.values()].some((row) => row.artifactType === "AgentMemory")).toBe(false);
    expect(memoryFixture.transactionErrors.some((error: any) => error.code === "OWNER_STALE")).toBe(true);
  });
});
