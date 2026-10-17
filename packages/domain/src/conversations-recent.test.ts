import { beforeEach, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";

const f = vi.hoisted(() => ({
  sessions: [] as Array<Record<string, any>>, turns: [] as Array<Record<string, any>>, prompts: [] as Array<Record<string, any>>,
  allowed: new Set<string>(), versions: new Map<string, number>(), active: true,
  beforeTurns: vi.fn(), membership: vi.fn(), sessionQuery: vi.fn(), turnQuery: vi.fn(), promptQuery: vi.fn(), final: vi.fn(),
}));
vi.mock("@corgtex/shared", () => ({ prisma: { conversationSession: { findMany: f.sessionQuery },
  conversationTurn: { findMany: f.turnQuery }, conversationPromptInput: { findMany: f.promptQuery } }, toInputJson: (value: unknown) => value }));
vi.mock("./auth", () => ({ requireWorkspaceMembership: f.membership }));
vi.mock("./role-onboarding", () => ({ updateRoleOnboardingStatusByConversation: vi.fn() }));
vi.mock("./source-lineage", async () => ({
  sealArtifactInputActor: (await import("./artifact-input-actor")).sealArtifactInputActor,
  captureReadableConversationInputs: async () => null,
  readableArtifactIds: async (_actor: unknown, _ws: string, _kind: string, rows: Array<{ id: string }>) => new Set(rows.filter(row => f.allowed.has(row.id)).map(row => row.id)),
  captureArtifactInputProof: async (_actor: unknown, _ws: string, inputs: Array<{ kind: string; id: string }>) => {
    if (inputs.some(row => !f.allowed.has(row.id))) throw new (await import("./errors")).AppError(409, "UNKNOWN_LINEAGE", "Synthetic denied input");
    return inputs.map(row => ({ kind: row.kind, id: row.id, fingerprint: String(f.versions.get(row.id) ?? 1) }));
  },
  captureArtifactReadHeadObservation: async (read: () => Promise<unknown>) => ({ value: await read(), heads: new Map() }),
  mergeLineageInputRoot: (prior: { fingerprint: string } | undefined, root: { fingerprint: string }) => {
    if (prior && prior.fingerprint !== root.fingerprint) throw new Error("Conflicting original");
    return root;
  },
  withArtifactCountReleaseSnapshot: async (_actor: unknown, _ws: string, roots: Array<{ id: string; fingerprint: string }>, remote: () => Promise<void>, finish: (tx: unknown) => Promise<unknown>) => {
    f.final(roots);
    if (roots.some(row => !f.allowed.has(row.id) || row.fingerprint !== String(f.versions.get(row.id) ?? 1))) {
      throw new (await import("./errors")).AppError(409, "SOURCE_CHANGED", "Original changed");
    }
    await remote(); return finish({});
  },
}));
import { listRecentConversations } from "./conversations";
const actor: AppActor = { kind: "user", user: { id: "user-1", email: "synthetic@example.test" } };
function session(id: string, readable = true) {
  const row = { id, workspaceId: "ws-1", userId: "user-1", topic: `Topic ${id}`, systemPrompt: "Private system prompt",
    updatedAt: new Date("2026-01-01"), roleOnboarding: null };
  f.sessions.push(row); if (readable) f.allowed.add(id); return row;
}
function turn(conversationId: string, sequenceNumber: number, readable = true, promptInputId: string | null = null) {
  const row = { id: `${conversationId}-turn-${sequenceNumber}`, conversationId, sequenceNumber, userMessage: "Original question",
    assistantMessage: "Original assistant answer", contextJson: { private: "context" }, promptInputId };
  f.turns.push(row); if (readable) f.allowed.add(row.id); return row;
}
beforeEach(() => {
  vi.clearAllMocks(); f.beforeTurns.mockReset(); f.sessions.length = 0; f.turns.length = 0; f.prompts.length = 0;
  f.allowed.clear(); f.versions.clear(); f.active = true;
  f.membership.mockImplementation(async () => {
    if (!f.active) throw new (await import("./errors")).AppError(403, "NOT_A_MEMBER", "Synthetic caller departed");
    return { id: "member-1", isActive: true };
  });
  f.sessionQuery.mockImplementation(async ({ where, take }) => f.sessions.filter(row => row.workspaceId === where.workspaceId && row.userId === where.userId
    && (!where.OR || row.updatedAt < where.OR[0].updatedAt.lt || row.updatedAt.getTime() === where.OR[1].updatedAt.getTime() && row.id < where.OR[1].id.lt))
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime() || b.id.localeCompare(a.id)).slice(0, take));
  f.turnQuery.mockImplementation(async ({ where, take }) => {
    await f.beforeTurns(where);
    return f.turns.filter(row => row.conversationId === where.conversationId && (!where.OR
      || row.sequenceNumber < where.OR[0].sequenceNumber.lt || row.sequenceNumber === where.OR[1].sequenceNumber && row.id < where.OR[1].id.lt))
      .sort((a, b) => b.sequenceNumber - a.sequenceNumber || b.id.localeCompare(a.id)).slice(0, take);
  });
  f.promptQuery.mockImplementation(async ({ where }) => f.prompts.filter(row => row.workspaceId === where.workspaceId && where.id.in.includes(row.id)));
});

it("loads only the newest preview first and stops at the requested visible limit", async () => {
  for (const id of ["a", "b", "c"]) { session(id); turn(id, 1); turn(id, 2); }
  const result = await listRecentConversations(actor, "ws-1", { take: 2 });
  expect(result).toMatchObject({ complete: false, items: [{ id: "c", topic: "Topic c", systemPrompt: null, turns: [{ sequenceNumber: 2 }] },
    { id: "b", turns: [{ sequenceNumber: 2 }] }] });
  expect(result.items).toHaveLength(2);
  expect(f.sessionQuery).toHaveBeenCalledTimes(1);
  expect(f.turnQuery.mock.calls.map(([query]) => query.take)).toEqual([1, 1]);
});

it("bounds hidden sessions and denied preview history with one request-wide budget", async () => {
  for (let i = 0; i < 251; i++) session(`session-${String(i).padStart(3, "0")}`, i === 0);
  for (let i = 1; i <= 5001; i++) turn("session-250", i, false);
  expect(await listRecentConversations(actor, "ws-1", { take: 30 })).toEqual({ items: [], complete: false });
  expect(f.sessionQuery.mock.calls.map(([query]) => query.take)).toEqual([30, 30, 30, 30, 30, 30, 20]);
  expect(f.turnQuery.mock.calls.map(([query]) => query.take)).toEqual([1, 100, 99]);
  expect(f.turnQuery.mock.calls.every(([query]) => query.where.conversationId === "session-250")).toBe(true);
});

it("can retain proved topics without previews after the global turn budget is exhausted", async () => {
  session("z", false); session("b"); session("a");
  for (let i = 1; i <= 5001; i++) turn("z", i, false);
  expect(await listRecentConversations(actor, "ws-1", { take: 30 })).toMatchObject({ complete: false,
    items: [{ id: "b", topic: "Topic b", turns: [] }, { id: "a", topic: "Topic a", turns: [] }] });
  expect(f.turnQuery).toHaveBeenCalledTimes(3);
});

it("admits unknown sessions only through a proved exact original prompt, redacting assistant and topic", async () => {
  session("a", false); turn("a", 1, false, "prompt-a");
  f.prompts.push({ id: "prompt-a", workspaceId: "ws-1", content: "Original question" });
  expect(await listRecentConversations(actor, "ws-1")).toEqual({ items: [], complete: true });
  f.allowed.add("prompt-a");
  expect(await listRecentConversations(actor, "ws-1")).toMatchObject({ complete: true, items: [{ topic: null, systemPrompt: null,
    turns: [{ userMessage: "Original question", assistantMessage: "", contextJson: null, assistantContentWithheld: true }] }] });
  f.prompts[0].content = "Unrelated original";
  expect(await listRecentConversations(actor, "ws-1")).toEqual({ items: [], complete: true });
});

it("keeps owner/workspace scope and stable tied-date ordering", async () => {
  session("a"); session("c"); session("b"); session("foreign").workspaceId = "ws-2"; session("other-user").userId = "user-2";
  const result = await listRecentConversations(actor, "ws-1", { take: 30 });
  expect(result.complete).toBe(true);
  expect(result.items.map(row => row.id)).toEqual(["c", "b", "a"]);
  expect(f.sessionQuery).toHaveBeenCalledWith(expect.objectContaining({ where: { workspaceId: "ws-1", userId: "user-1" },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }], take: 30 }));
});

it.each(["session", "turn"])("withholds original %s proof revoked and restored during a later preview", async kind => {
  session("b"); session("a"); const selected = turn("b", 1); turn("a", 1);
  f.beforeTurns.mockImplementation(async where => { if (where.conversationId === "a") f.versions.set(kind === "session" ? "b" : selected.id, 3); });
  await expect(listRecentConversations(actor, "ws-1")).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  expect(f.final.mock.calls[0][0]).toEqual(expect.arrayContaining([expect.objectContaining({ id: "b", fingerprint: "1" }),
    expect.objectContaining({ id: selected.id, fingerprint: "1" })]));
});

it("withholds a completed response when the caller loses membership during preview reads", async () => {
  session("a"); turn("a", 1);
  f.beforeTurns.mockImplementation(async () => { f.active = false; });
  await expect(listRecentConversations(actor, "ws-1")).rejects.toMatchObject({ code: "NOT_A_MEMBER" });
});

it("validates requested limits and distinguishes an unscanned zero take from an exhausted empty list", async () => {
  await expect(listRecentConversations(actor, "ws-1", { take: 31 })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  expect(await listRecentConversations(actor, "ws-1", { take: 0 })).toEqual({ items: [], complete: false });
  expect(f.sessionQuery).not.toHaveBeenCalled();
  expect(await listRecentConversations(actor, "ws-1")).toEqual({ items: [], complete: true });
  expect(f.membership).toHaveBeenCalledTimes(4);
});
