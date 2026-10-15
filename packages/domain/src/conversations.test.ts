import { AppError } from "./errors";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";
import type { Prisma } from "@prisma/client";

const { prismaMock } = vi.hoisted(() => {
  const prisma = {
    workspaceSupportGrant: { findUnique: vi.fn().mockResolvedValue(null) },
    $executeRaw: vi.fn(),
    $transaction: vi.fn(),
    conversationSession: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    conversationPendingOperation: {
      deleteMany: vi.fn(),
    },
    conversationTurn: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
    },
    conversationPromptInput: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn() },
    roleOnboardingSession: {
      updateMany: vi.fn(),
    },
  };
  return { prismaMock: prisma };
});

const lineage = vi.hoisted(() => ({ assertArtifactInputWriteFence: vi.fn(), readableArtifactIds: vi.fn(), recordArtifactInputLineage: vi.fn(),
  advanceHumanArtifactInputLineage: vi.fn(), currentArtifactInputRoots: vi.fn(), captureArtifactInputProof: vi.fn() }));
vi.mock("./source-lineage", async () => ({ ...lineage,
  sealArtifactInputActor: (await import("./artifact-input-actor")).sealArtifactInputActor,
  captureArtifactReadHeadObservation: async (read: () => Promise<unknown>) => ({ value: await read(), heads: new Map() }),
  mergeLineageInputRoot: (_previous: unknown, root: unknown) => root,
  withArtifactCountReleaseSnapshot: async (_actor: unknown, _ws: unknown, _roots: unknown, remote: () => Promise<void>, finish: (tx: unknown) => Promise<unknown>) => { await remote(); return finish(prismaMock); },
}));
vi.mock("./role-onboarding", () => ({ updateRoleOnboardingStatusByConversation: vi.fn() }));

vi.mock("./auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./auth")>();
  return { ...actual, requireWorkspaceMembership: (params: Parameters<typeof actual.requireWorkspaceMembership>[0]) => {
    // Operator fixtures also have an explicit ADMIN membership.
    if (params.actor.kind === "user" && params.actor.user.globalRole === "OPERATOR") {
      return actual.requireWorkspaceMembership({ ...params, resolvedMembership: {
        id: "fixture-admin", workspaceId: params.workspaceId, userId: params.actor.user.id, role: "ADMIN", isActive: true,
      } });
    }
    return actual.requireWorkspaceMembership(params);
  } };
});

vi.mock("@corgtex/shared", () => ({
  setSupportAuthorizationActor: vi.fn(),
  getMcpOrigin: () => undefined,
  prisma: prismaMock,
  toInputJson: vi.fn((value: unknown) => value),
  parseAllowedWorkspaceIds: vi.fn(() => new Set<string>()),
  env: {
    SESSION_LAST_SEEN_WRITE_INTERVAL_MS: 5 * 60 * 1000,
  },
}));

const actor: AppActor = {
  kind: "user",
  user: {
    id: "user-1",
    email: "user@example.com",
    displayName: "User",
    globalRole: "OPERATOR",
  },
};

describe("conversations domain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.$executeRaw.mockResolvedValue(0);
    prismaMock.$transaction.mockImplementation(async (callback: (tx: typeof prismaMock) => Promise<unknown>) => callback(prismaMock));
    prismaMock.roleOnboardingSession.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.conversationPendingOperation.deleteMany.mockResolvedValue({ count: 2 });
    lineage.captureArtifactInputProof.mockImplementation(async (_actor, _ws, inputs) => {
      for (const input of inputs) {
        const allowed = await lineage.readableArtifactIds(_actor,_ws,input.kind,[{id:input.id}]);
        if (!allowed.has(input.id)) throw new AppError(409,"UNKNOWN_LINEAGE","Denied fixture");
      }
      return inputs.map((input: {kind: string; id: string}) => ({kind:input.kind,id:input.id,fingerprint:"a".repeat(64)}));
    });
    lineage.currentArtifactInputRoots.mockResolvedValue([]);
    lineage.readableArtifactIds.mockImplementation(async (_actor, _workspaceId, _kind, rows) => new Set(rows.map((row: { id: string }) => row.id)));
    prismaMock.conversationPromptInput.findFirst.mockResolvedValue({ id: "prompt-1", workspaceId: "workspace-1", sessionId: "conversation-1", userId: "user-1", content: "What should I do first?" });
    prismaMock.conversationPromptInput.findMany.mockResolvedValue([]);
    prismaMock.conversationTurn.findMany.mockReset().mockResolvedValue([]);
  });

  it("serializes turn numbering with a per-conversation lock", async () => {
    prismaMock.conversationSession.findUnique.mockResolvedValue({
      id: "conversation-1",
      workspaceId: "workspace-1",
      userId: "user-1",
    });
    prismaMock.conversationTurn.findFirst.mockResolvedValue({ sequenceNumber: 2 });
    prismaMock.conversationTurn.create.mockResolvedValue({ id: "turn-3", sequenceNumber: 3 });
    prismaMock.conversationSession.update.mockResolvedValue({ id: "conversation-1" });

    const { addConversationTurn } = await import("./conversations");
    await expect(addConversationTurn(actor, {
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      userMessage: "What should I do first?",
      assistantMessage: "Start here.",
      contextJson: { source: "test" },
      promptInputId: "prompt-1",
      lineageRoots: [{ kind: "BrainSource", id: "source-1", fingerprint: "b".repeat(64) }],
    })).resolves.toMatchObject({ id: "turn-3", sequenceNumber: 3 });

    expect(prismaMock.$executeRaw).toHaveBeenCalled();
    expect(prismaMock.conversationTurn.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        conversationId: "conversation-1",
        promptInputId: "prompt-1",
        sequenceNumber: 3,
        userMessage: "What should I do first?",
        assistantMessage: "Start here.",
        contextJson: { source: "test" },
      }),
    });
    expect(lineage.recordArtifactInputLineage).toHaveBeenCalledWith(expect.objectContaining({
      tx: prismaMock, artifact: { kind: "ConversationTurn", id: "turn-3" }, origin: "DERIVED", inputs: [],
      inheritedRoots: [{ kind: "ConversationPromptInput", id: "prompt-1", fingerprint: "a".repeat(64) },
        { kind: "BrainSource", id: "source-1", fingerprint: "b".repeat(64) }],
    }));
  });

  it("rejects assistant persistence without an exact durable original prompt and complete roots", async () => {
    prismaMock.conversationSession.findUnique.mockResolvedValue({ id: "conversation-1", workspaceId: "workspace-1", userId: "user-1" });
    const { addConversationTurn } = await import("./conversations");
    await expect(addConversationTurn(actor, { workspaceId: "workspace-1", conversationId: "conversation-1", userMessage: "What should I do first?", assistantMessage: "Synthetic output" }))
      .rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    prismaMock.conversationPromptInput.findFirst.mockResolvedValue(null);
    await expect(addConversationTurn(actor, { workspaceId: "workspace-1", conversationId: "conversation-1", userMessage: "Changed utterance", assistantMessage: "Synthetic output",
      promptInputId: "prompt-1", lineageRoots: [{ kind: "BrainSource", id: "source-1", fingerprint: "b".repeat(64) }] })).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    expect(prismaMock.conversationTurn.create).not.toHaveBeenCalled();
    expect(prismaMock.conversationPromptInput.findFirst).toHaveBeenCalledWith({ where: { id: "prompt-1", workspaceId: "workspace-1", sessionId: "conversation-1", userId: "user-1", content: "Changed utterance" } });
  });

  it("seals the exact principal and copies turn content and roots before its first await", async () => {
    const principal = structuredClone(actor);
    const suppliedTx = { ...prismaMock } as unknown as Prisma.TransactionClient;
    const params = {
      workspaceId: "workspace-1", conversationId: "conversation-1", userMessage: "What should I do first?",
      assistantMessage: "Exact admitted answer", contextJson: { source: "exact admitted context" }, promptInputId: "prompt-1",
      lineageRoots: [{ kind: "BrainSource" as const, id: "source-1", fingerprint: "b".repeat(64) }], tx: suppliedTx,
    };
    prismaMock.conversationSession.findUnique.mockResolvedValue({ id: "conversation-1", workspaceId: "workspace-1", userId: "user-1" });
    prismaMock.conversationTurn.findFirst.mockResolvedValue(null);
    prismaMock.conversationTurn.create.mockResolvedValue({ id: "turn-immutable", sequenceNumber: 1 });
    const { addConversationTurn } = await import("./conversations");
    const pending = addConversationTurn(principal, params);
    expect(Object.isFrozen(principal)).toBe(true);
    expect(Object.isFrozen(principal.user)).toBe(true);
    expect(() => { principal.user.id = "other-user"; }).toThrow();
    params.workspaceId = "other-workspace";
    params.conversationId = "other-conversation";
    params.assistantMessage = "Changed answer";
    params.contextJson.source = "Changed context";
    params.lineageRoots[0].fingerprint = "c".repeat(64);
    params.tx = prismaMock as unknown as Prisma.TransactionClient;
    await expect(pending).resolves.toMatchObject({ id: "turn-immutable" });
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    expect(prismaMock.conversationTurn.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      conversationId: "conversation-1", assistantMessage: "Exact admitted answer", contextJson: { source: "exact admitted context" },
    }) });
    expect(lineage.recordArtifactInputLineage).toHaveBeenCalledWith(expect.objectContaining({ tx: suppliedTx,
      actor: principal, workspaceId: "workspace-1", inheritedRoots: expect.arrayContaining([
        { kind: "BrainSource", id: "source-1", fingerprint: "b".repeat(64) },
      ]),
    }));
  });

  it("creates an immutable prompt only in the requester's currently owned conversation", async () => {
    prismaMock.conversationSession.findFirst.mockResolvedValue({ id: "conversation-1", workspaceId: "workspace-1", userId: "user-1" });
    prismaMock.conversationPromptInput.create.mockResolvedValue({ id: "prompt-new", content: "Synthetic utterance" });
    const { createConversationPromptInput } = await import("./conversations");
    await expect(createConversationPromptInput(actor, { workspaceId: "workspace-1", conversationId: "conversation-1", content: "Synthetic utterance" })).resolves.toMatchObject({ id: "prompt-new" });
    expect(prismaMock.conversationSession.findFirst).toHaveBeenCalledWith({ where: { id: "conversation-1", workspaceId: "workspace-1", userId: "user-1" } });
    expect(prismaMock.conversationPromptInput.create).toHaveBeenCalledWith({ data: { workspaceId: "workspace-1", sessionId: "conversation-1", userId: "user-1", content: "Synthetic utterance" } });
    prismaMock.conversationSession.findFirst.mockResolvedValue(null);
    await expect(createConversationPromptInput(actor, { workspaceId: "workspace-2", conversationId: "other-person-session", content: "Synthetic utterance" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(prismaMock.conversationPromptInput.create).toHaveBeenCalledTimes(1);
  });

  it("records direct session creation and preserves its proof through explicit lifecycle edits", async () => {
    const session = { id: "conversation-1", workspaceId: "workspace-1", userId: "user-1", topic: "Original topic", status: "ACTIVE", systemPrompt: null };
    prismaMock.conversationSession.create.mockResolvedValue(session);
    prismaMock.conversationSession.findFirst.mockResolvedValue(session);
    prismaMock.conversationSession.update.mockImplementation(async ({ data }) => ({ ...session, ...data }));
    const { createConversation, closeConversation, renameConversation } = await import("./conversations");
    await createConversation(actor, { workspaceId: "workspace-1", topic: session.topic });
    expect(lineage.recordArtifactInputLineage).toHaveBeenCalledWith(expect.objectContaining({ artifact: { kind: "ConversationSession", id: session.id }, origin: "HUMAN_ORIGINAL", inputs: [] }));
    await closeConversation(actor, { workspaceId: "workspace-1", conversationId: session.id });
    await renameConversation(actor, { workspaceId: "workspace-1", conversationId: session.id, topic: "Human-edited topic" });
    expect(lineage.advanceHumanArtifactInputLineage).toHaveBeenCalledTimes(2);
    expect(lineage.advanceHumanArtifactInputLineage).toHaveBeenLastCalledWith(expect.objectContaining({ before: session, after: { ...session, topic: "Human-edited topic" } }));
  });

  it("carries uncited prompt context into a generated topic and rejects incomplete previous session lineage", async () => {
    const session = { id: "conversation-1", workspaceId: "workspace-1", userId: "user-1", topic: "Original topic", status: "ACTIVE", systemPrompt: null };
    const roots = [{ kind: "BrainSource" as const, id: "uncited-source", fingerprint: "c".repeat(64) }];
    prismaMock.conversationSession.findFirst.mockResolvedValue(session);
    prismaMock.conversationSession.update.mockResolvedValue({ ...session, topic: "Generated topic" });
    const { renameConversation } = await import("./conversations");
    await renameConversation(actor, { workspaceId: "workspace-1", conversationId: session.id, topic: "Generated topic", lineageRoots: roots });
    expect(lineage.recordArtifactInputLineage).toHaveBeenCalledWith(expect.objectContaining({ origin: "DERIVED", inheritedRoots: roots }));
    lineage.currentArtifactInputRoots.mockResolvedValue(null);
    await expect(renameConversation(actor, { workspaceId: "workspace-1", conversationId: session.id, topic: "Generated topic", lineageRoots: roots })).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
  });

  it("filters unproven session existence before totals and page positions", async () => {
    const unknown = Array.from({ length: 55 }, (_, index) => ({ id: `unknown-${index}`, workspaceId: "workspace-1", userId: "user-1", topic: "Restricted topic",
      systemPrompt: "Restricted system context", turns: [], roleOnboarding: null }));
    const known = { id: "known-session", workspaceId: "workspace-1", userId: "user-1", topic: "Human-created topic", systemPrompt: "Private custom instructions", turns: [], roleOnboarding: null };
    prismaMock.conversationSession.findMany.mockResolvedValue([...unknown, known]);
    lineage.readableArtifactIds.mockImplementation(async (_actor, _ws, kind, rows) => new Set(kind === "ConversationSession" ? rows.filter((row: { id: string }) => row.id === known.id).map((row: { id: string }) => row.id) : []));
    const { listConversations } = await import("./conversations");
    const result = await listConversations(actor, "workspace-1", { take: 1, skip: 0 });
    expect(result).toMatchObject({ total: 1, take: 1, skip: 0, items: [{ id: known.id, topic: known.topic, systemPrompt: null }] });
    expect(JSON.stringify(result)).not.toContain("Restricted");
    expect((await listConversations(actor, "workspace-1", { take: 1, skip: 1 })).items).toEqual([]);
  });

  it("finds a safe older last message after filtering newer unknown replies", async () => {
    const safe = { id: "safe-turn", sequenceNumber: 1, userMessage: "Known question", assistantMessage: "Known independently permitted response", contextJson: null, promptInputId: null };
    const unknown = { id: "unknown-turn", sequenceNumber: 2, userMessage: "Unknown copied question", assistantMessage: "Restricted latest answer", contextJson: { privateText: "Restricted context" }, promptInputId: null };
    prismaMock.conversationSession.findMany.mockResolvedValue([{ id: "known-session", workspaceId: "workspace-1", userId: "user-1", topic: "Human topic", systemPrompt: null,
      roleOnboarding: null, turns: [unknown, safe] }]);
    prismaMock.conversationTurn.findMany.mockResolvedValue([unknown, safe]);
    lineage.readableArtifactIds.mockImplementation(async (_actor, _ws, kind, rows) => new Set(rows.filter((row: { id: string }) => kind === "ConversationSession" || row.id === safe.id).map((row: { id: string }) => row.id)));
    const { listConversations } = await import("./conversations");
    const result = await listConversations(actor, "workspace-1");
    expect(result.total).toBe(1);
    expect(result.items[0]?.turns).toEqual([{ ...safe, assistantContentWithheld: false }]);
    expect(JSON.stringify(result)).not.toContain("Restricted");
  });

  it("retains an exact independently authored original prompt while withholding its derived reply, topic and role labels", async () => {
    const turn = { id: "restricted-turn", promptInputId: "prompt-1", userMessage: "Original human utterance", assistantMessage: "Restricted derived reply", contextJson: { privateText: "Restricted context" } };
    const session = { id: "conversation-1", workspaceId: "workspace-1", userId: "user-1", topic: "Restricted generated topic", systemPrompt: "Restricted system prompt",
      roleOnboarding: { id: "onboarding-1", roleId: "restricted-role", role: { id: "restricted-role", name: "Restricted role label" } }, turns: [turn] };
    prismaMock.conversationSession.findUnique.mockResolvedValue(session);
    prismaMock.conversationPromptInput.findMany.mockResolvedValue([{ id: "prompt-1", workspaceId: "workspace-1", sessionId: session.id, userId: "user-1", content: turn.userMessage }]);
    lineage.readableArtifactIds.mockImplementation(async (_actor, _ws, kind, rows) => new Set(kind === "ConversationPromptInput" ? rows.map((row: { id: string }) => row.id) : []));
    const { getConversation, listConversations } = await import("./conversations");
    const detail = await getConversation(actor, "workspace-1", session.id);
    expect(detail).toMatchObject({ topic: null, systemPrompt: null, roleOnboarding: null,
      turns: [{ id: turn.id, userMessage: turn.userMessage, assistantMessage: "", contextJson: null, assistantContentWithheld: true }] });
    expect(JSON.stringify(detail)).not.toContain("Restricted");
    prismaMock.conversationSession.findMany.mockResolvedValue([session]);
    prismaMock.conversationTurn.findMany.mockResolvedValue([turn]);
    expect((await listConversations(actor, "workspace-1")).total).toBe(1);
  });

  it("does not invent original user content from a missing, changed or unreadable prompt", async () => {
    const turn = { id: "restricted-turn", promptInputId: "prompt-1", userMessage: "Unproven current utterance", assistantMessage: "Restricted derived reply", contextJson: null };
    const session = { id: "conversation-1", workspaceId: "workspace-1", userId: "user-1", topic: "Restricted topic", systemPrompt: null, roleOnboarding: null, turns: [turn] };
    prismaMock.conversationSession.findMany.mockResolvedValue([session]);
    prismaMock.conversationTurn.findMany.mockResolvedValue([turn]);
    prismaMock.conversationPromptInput.findMany.mockResolvedValue([{ id: "prompt-1", content: "Different original content" }]);
    lineage.readableArtifactIds.mockImplementation(async (_actor, _ws, kind, rows) => new Set(kind === "ConversationPromptInput" ? rows.map((row: { id: string }) => row.id) : []));
    const { listConversations } = await import("./conversations");
    expect(await listConversations(actor, "workspace-1")).toMatchObject({ items: [], total: 0 });
    prismaMock.conversationPromptInput.findMany.mockResolvedValue([{ id: "prompt-1", content: turn.userMessage }]);
    lineage.readableArtifactIds.mockResolvedValue(new Set());
    expect(await listConversations(actor, "workspace-1")).toMatchObject({ items: [], total: 0 });
  });

  it("pages summaries without loading turns for every proved session outside the requested page", async () => {
    const sessions = Array.from({ length: 5005 }, (_, index) => ({ id: `session-${index}`, topic: `Topic ${index}`, roleOnboarding: null }));
    prismaMock.conversationSession.findMany.mockImplementation(async ({ where, take }) => {
      const start = where.OR ? Number(where.OR[1].id.lt.slice(8)) + 1 : 0;
      return sessions.slice(start, start + take);
    });
    prismaMock.conversationTurn.findMany.mockResolvedValue([]);
    const { listConversations } = await import("./conversations");
    const result = await listConversations(actor, "workspace-1", { take: 2, skip: 200 });
    expect(result.total).toBe(5005);
    expect(result.items.map(item => item.id)).toEqual(["session-200", "session-201"]);
    expect(prismaMock.conversationSession.findMany).toHaveBeenCalledTimes(51);
    expect(prismaMock.conversationTurn.findMany).toHaveBeenCalledTimes(2);
    for (const [query] of prismaMock.conversationSession.findMany.mock.calls) {
      expect(query.take).toBe(100);
      expect(query.include).not.toHaveProperty("turns");
    }
  });

  it("uses frozen sort values when a boundary session receives activity between pages", async () => {
    const date=new Date("2026-06-02");
    const sessions=Array.from({length:101},(_,i)=>({id:String(1000-i),updatedAt:date,topic:"Known",roleOnboarding:null}));
    let calls=0;
    prismaMock.conversationSession.findMany.mockImplementation(async ({where,take})=>{
      if(++calls===2) sessions[99].updatedAt=new Date("2026-06-03");
      return sessions.filter(row=>!where.OR || row.updatedAt<where.OR[0].updatedAt.lt || row.updatedAt.getTime()===where.OR[1].updatedAt.getTime() && row.id<where.OR[1].id.lt).slice(0,take).map(row=>({...row}));
    });
    const {listConversations}=await import("./conversations");
    expect(await listConversations(actor,"workspace-1",{take:0})).toMatchObject({total:101,items:[]});
    expect(calls).toBe(2);
    expect(prismaMock.conversationSession.findMany.mock.calls[1][0]).not.toHaveProperty("cursor");
    expect(prismaMock.conversationSession.findMany.mock.calls[1][0].where.OR[1]).toEqual({updatedAt:date,id:{lt:"901"}});
  });

  it("replenishes hidden sessions and searches older turns in bounded pages", async () => {
    const sessions = Array.from({ length: 102 }, (_, index) => ({ id: `session-${index}`, topic: "Hidden topic", roleOnboarding: null }));
    const turns = Array.from({ length: 102 }, (_, index) => ({ id: `turn-${index}`, sequenceNumber: 102 - index,
      promptInputId: null, userMessage: "Hidden input", assistantMessage: "Hidden reply", contextJson: null }));
    turns[101] = { ...turns[101], userMessage: "Safe question", assistantMessage: "Safe reply" };
    prismaMock.conversationSession.findMany.mockImplementation(async ({ where, take }) => {
      const start = where.OR ? Number(where.OR[1].id.lt.slice(8)) + 1 : 0;
      return sessions.slice(start, start + take);
    });
    prismaMock.conversationTurn.findMany.mockImplementation(async ({ where, cursor, take }) => {
      if (where.conversationId !== "session-101") return [];
      const start = cursor ? Number(cursor.id.slice(5)) + 1 : 0;
      return turns.slice(start, start + take);
    });
    lineage.readableArtifactIds.mockImplementation(async (_actor, _ws, kind, rows) => new Set(kind === "ConversationTurn"
      ? rows.filter((row: { id: string }) => row.id === "turn-101").map((row: { id: string }) => row.id) : []));
    const { listConversations } = await import("./conversations");
    const result = await listConversations(actor, "workspace-1", { take: 1 });
    expect(result).toMatchObject({ total: 1, items: [{ id: "session-101", topic: null, turns: [{ id: "turn-101", assistantMessage: "Safe reply" }] }] });
    expect(JSON.stringify(result)).not.toContain("Hidden");
    expect(prismaMock.conversationSession.findMany).toHaveBeenCalledTimes(2);
    const turnQueries = prismaMock.conversationTurn.findMany.mock.calls.map(([query]) => query);
    expect(turnQueries.every(query => query.take === 100)).toBe(true);
    expect(turnQueries.filter(query => query.where.conversationId === "session-101")).toHaveLength(2);
  });

  it("rejects malformed database pages and per-conversation oversized turn histories", async () => {
    const { listConversations } = await import("./conversations");
    prismaMock.conversationSession.findMany.mockResolvedValue(Array.from({ length: 5001 }, (_, index) => ({ id: `session-${index}`, turns: [] })));
    await expect(listConversations(actor, "workspace-1")).rejects.toMatchObject({ code: "SOURCE_READ_SCAN_CHANGED" });
    prismaMock.conversationSession.findMany.mockResolvedValue([{ id: "session-1", roleOnboarding: null }]);
    prismaMock.conversationTurn.findMany.mockResolvedValue(Array.from({ length: 5001 }, (_, index) => ({ id: `turn-${index}` })));
    await expect(listConversations(actor, "workspace-1")).rejects.toMatchObject({ code: "INPUT_SCAN_LIMIT" });
  });

  it("dismisses onboarding instead of deleting onboarding conversations", async () => {
    prismaMock.conversationSession.findUnique.mockResolvedValue({
      id: "conversation-1",
      workspaceId: "workspace-1",
      userId: "user-1",
      roleOnboarding: { id: "onboarding-1" },
    });
    prismaMock.conversationSession.update.mockResolvedValue({ id: "conversation-1", status: "COMPLETED" });

    const { deleteConversation } = await import("./conversations");
    await expect(deleteConversation(actor, {
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
    })).resolves.toMatchObject({ id: "conversation-1", status: "COMPLETED" });

    expect(prismaMock.roleOnboardingSession.updateMany).toHaveBeenCalledWith({
      where: {
        conversationId: "conversation-1",
        status: { in: ["PENDING", "ACTIVE"] },
      },
      data: expect.objectContaining({
        status: "DISMISSED",
        dismissedAt: expect.any(Date),
      }),
    });
    expect(prismaMock.conversationPendingOperation.deleteMany).toHaveBeenCalledWith({
      where: {
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        status: { not: "EXECUTING" },
      },
    });
    expect(prismaMock.conversationSession.delete).not.toHaveBeenCalled();
  });

  it("deletes ordinary conversations", async () => {
    prismaMock.conversationSession.findUnique.mockResolvedValue({
      id: "conversation-1",
      workspaceId: "workspace-1",
      userId: "user-1",
      roleOnboarding: null,
    });
    prismaMock.conversationSession.delete.mockResolvedValue({ id: "conversation-1" });

    const { deleteConversation } = await import("./conversations");
    await expect(deleteConversation(actor, {
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
    })).resolves.toEqual({ id: "conversation-1" });

    expect(prismaMock.conversationSession.delete).toHaveBeenCalledWith({
      where: { id: "conversation-1" },
    });
    expect(prismaMock.conversationPendingOperation.deleteMany).toHaveBeenCalledWith({
      where: {
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        status: { not: "EXECUTING" },
      },
    });
  });
});
