import { afterEach, beforeEach, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({
  event: {} as Record<string, unknown>, job: {} as Record<string, unknown>, flow: null as Record<string, unknown> | null,
  row: null as Record<string, unknown> | null, removed: false, beforeTransaction: undefined as (() => void) | undefined,
  env: { KNOWLEDGE_SEARCH_PROVIDER: "postgres", AZURE_SEARCH_ENDPOINT: undefined as string | undefined,
    AZURE_SEARCH_INDEX_NAME: "synthetic", AZURE_SEARCH_AUTH_MODE: "managed_identity" },
  token: vi.fn(), sync: vi.fn(), document: vi.fn(), invalidate: vi.fn(),
  db: { event: { findFirst: vi.fn() }, workflowJob: { findFirst: vi.fn() }, approvalFlow: { findFirst: vi.fn() },
    proposal: { findFirst: vi.fn() }, meeting: { findFirst: vi.fn() }, document: { findFirst: vi.fn() },
    knowledgeChunk: { deleteMany: vi.fn() }, $queryRaw: vi.fn(), $transaction: vi.fn() },
}));
vi.mock("@azure/identity", () => ({ DefaultAzureCredential: class { getToken = f.token; } }));
vi.mock("@corgtex/shared", () => ({ prisma: f.db, getSharedStateBackend: () => "postgres", env: f.env, logger: { warn: vi.fn() } }));
vi.mock("@corgtex/knowledge", async () => ({
  ...await import("../../../knowledge/src/azure-search"),
  syncKnowledgeForSource: f.sync, syncDocumentKnowledge: f.document, invalidateKnowledgeCache: f.invalidate,
}));
import { handleEventKnowledgeSync, type EventKnowledgeSyncClaim } from "./event-knowledge-sync";

let claim: EventKnowledgeSyncClaim;
const run = () => handleEventKnowledgeSync("job", { eventId: "event" }, "workspace", claim);
const response = (value: unknown[] = []) => Response.json({ value });
beforeEach(() => {
  vi.clearAllMocks();
  f.event = { id: "event", workspaceId: "workspace", type: "proposal.submitted", aggregateType: "Proposal", aggregateId: "source",
    createdAt: new Date("2026-10-01Z"), payload: { secret: "EVENT_PAYLOAD_MUST_NEVER_BE_INDEXED" } };
  f.job = { id: "job", workspaceId: "workspace", type: "knowledge.sync.event", payload: { eventId: "event", nested: { b: 2, a: 1 } },
    attempts: 1, lockedBy: "worker", lockedAt: new Date(), startedAt: new Date(), status: "RUNNING" };
  claim = structuredClone(f.job) as unknown as EventKnowledgeSyncClaim;
  f.row = { id: "source", workspaceId: "workspace", title: "Canonical source", summary: "Current summary", bodyMd: "Current body",
    summaryMd: "Meeting summary", transcript: "Current transcript", updatedAt: new Date(), archivedAt: null };
  f.flow = { id: "flow", workspaceId: "workspace", subjectType: "PROPOSAL", subjectId: "source" };
  f.removed = false; f.beforeTransaction = undefined; f.env.AZURE_SEARCH_ENDPOINT = undefined; f.env.KNOWLEDGE_SEARCH_PROVIDER = "postgres";
  f.db.event.findFirst.mockImplementation(async ({ where, select }) => f.event.id === where.id && f.event.workspaceId === where.workspaceId
    ? Object.fromEntries(Object.keys(select).map(key => [key, f.event[key]])) : null);
  f.db.workflowJob.findFirst.mockImplementation(async () => structuredClone(f.job));
  f.db.approvalFlow.findFirst.mockImplementation(async ({ where }) => f.flow?.id === where.id && f.flow?.workspaceId === where.workspaceId ? structuredClone(f.flow) : null);
  for (const delegate of [f.db.proposal, f.db.meeting, f.db.document]) delegate.findFirst.mockImplementation(async ({ where }) =>
    f.row?.id === where.id && f.row?.workspaceId === where.workspaceId && !f.row?.archivedAt ? structuredClone(f.row) : null);
  f.db.$queryRaw.mockResolvedValue([]);
  f.db.knowledgeChunk.deleteMany.mockImplementation(async () => { f.removed = true; return { count: 1 }; });
  f.db.$transaction.mockImplementation(async work => {
    f.beforeTransaction?.();
    const removed = f.removed;
    try { return await work(f.db); } catch (error) { f.removed = removed; throw error; }
  });
  f.sync.mockImplementation(async input => { await input.sourceGuard(); return 1; });
  f.document.mockImplementation(async input => { await input.sourceGuard(); return 1; });
  f.token.mockResolvedValue({ token: "synthetic", expiresOnTimestamp: Date.now() + 60_000 });
  vi.stubGlobal("fetch", vi.fn(async () => response()));
});
afterEach(() => { vi.unstubAllGlobals(); });

it.each([
  ["proposal.submitted", "Proposal", "PROPOSAL"], ["proposal.opened", "Proposal", "PROPOSAL"],
  ["proposal.approved", "Proposal", "PROPOSAL"], ["document.created", "Document", "DOCUMENT"],
  ["meeting.created", "Meeting", "MEETING"], ["meeting.transcript-uploaded", "Meeting", "MEETING"],
  ["approval.finalized", "ApprovalFlow", "PROPOSAL"],
])("routes %s through its proven canonical source without event payload", async (type, kind, sourceType) => {
  Object.assign(f.event, { type, aggregateType: kind, aggregateId: kind === "ApprovalFlow" ? "flow" : "source" });
  // Equivalent JSONB recipes with different property ordering remain the same claim.
  f.job.payload = { nested: { a: 1, b: 2 }, eventId: "event" };
  await expect(run()).resolves.toMatchObject({ retiredEventCopies: true, indexed: 1 });
  expect(f.db.knowledgeChunk.deleteMany).toHaveBeenCalledWith({ where: { workspaceId: "workspace", sourceType: "EVENT", sourceId: "event" } });
  expect(f.invalidate).toHaveBeenCalledWith("workspace", f.db);
  for (const [args] of f.db.event.findFirst.mock.calls) expect(args.select).not.toHaveProperty("payload");
  const calls = sourceType === "DOCUMENT" ? f.document.mock.calls : f.sync.mock.calls;
  expect(calls).toHaveLength(1);
  expect(JSON.stringify(calls)).not.toContain("EVENT_PAYLOAD_MUST_NEVER_BE_INDEXED");
  expect(calls[0][0]).toMatchObject(sourceType === "DOCUMENT" ? { documentId: "source", sourceGuard: expect.any(Function) }
    : { sourceId: "source", sourceType, sourceGuard: expect.any(Function) });
});

it("retires old event copies for an archived aggregate without publishing an empty canonical replacement", async () => {
  f.row!.archivedAt = new Date();
  await expect(run()).resolves.toEqual({ retiredEventCopies: true, canonical: "UNAVAILABLE" });
  expect(f.removed).toBe(true); expect(f.sync).not.toHaveBeenCalled(); expect(f.document).not.toHaveBeenCalled();
});
it.each(["takeover", "expired", "recipe", "event", "before-transaction"])("rejects changed original authority: %s", async mode => {
  if (mode === "expired") { claim.lockedAt = new Date(Date.now() - 360_000); f.job.lockedAt = claim.lockedAt; }
  if (mode === "takeover") f.job.attempts = 2;
  if (mode === "recipe") f.job.payload = { eventId: "alien" };
  if (mode === "before-transaction") f.beforeTransaction = () => { f.job.lockedBy = "new-owner"; };
  if (mode === "event") f.beforeTransaction = () => { f.event.aggregateId = "replacement"; };
  await expect(run()).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  expect(f.removed).toBe(false); expect(f.sync).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
});
it("rejects a cross-workspace ApprovalFlow target", async () => {
  Object.assign(f.event, { type: "approval.finalized", aggregateType: "ApprovalFlow", aggregateId: "flow" });
  f.flow!.workspaceId = "other";
  await expect(run()).rejects.toMatchObject({ code: "EVENT_KNOWLEDGE_TARGET_UNSUPPORTED" });
  expect(f.sync).not.toHaveBeenCalled();
});
it("explicitly rejects unsupported event routing after exact legacy-copy retirement", async () => {
  f.event.aggregateType = "Unknown";
  await expect(run()).rejects.toMatchObject({ code: "EVENT_KNOWLEDGE_TARGET_UNSUPPORTED" });
  expect(f.removed).toBe(true); expect(f.sync).not.toHaveBeenCalled();
});
it("does not acknowledge a withheld canonical source as successfully indexed", async () => {
  f.sync.mockResolvedValueOnce(0);
  await expect(run()).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
});
it("retains the original claim in the canonical dispatch callback and latches swallowed denial", async () => {
  f.sync.mockImplementationOnce(async input => {
    f.job.attempts = 2;
    await input.sourceGuard().catch(() => {});
    f.job.attempts = 1;
    return 1;
  });
  await expect(run()).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
});
it("guards actual Azure cleanup after credentials load", async () => {
  f.env.AZURE_SEARCH_ENDPOINT = "https://synthetic.invalid";
  f.token.mockImplementationOnce(async () => { f.job.attempts = 2; return { token: "synthetic" }; });
  await expect(run()).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  expect(fetch).not.toHaveBeenCalled(); expect(f.sync).not.toHaveBeenCalled();
});
it("guards the delete batch after Azure lists exact scoped stale copies", async () => {
  f.env.AZURE_SEARCH_ENDPOINT = "https://synthetic.invalid";
  let sends = 0;
  vi.mocked(fetch).mockImplementation(async () => {
    if (++sends === 2) { f.job.attempts = 2; return response([{ id: "old-event-copy" }]); }
    return response();
  });
  await expect(run()).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(JSON.parse(String(vi.mocked(fetch).mock.calls[1][1]!.body)).filter).toBe("workspaceId eq 'workspace' and search.in(sourceType, 'EVENT') and sourceId eq 'event'");
  expect(f.sync).not.toHaveBeenCalled();
});
it("allows normal cleanup retry after a transport error without uploading EVENT payloads", async () => {
  f.env.AZURE_SEARCH_ENDPOINT = "https://synthetic.invalid";
  vi.mocked(fetch).mockRejectedValueOnce(new Error("Temporary transport failure"));
  await expect(run()).rejects.toThrow("Temporary transport failure");
  await expect(run()).resolves.toMatchObject({ indexed: 1 });
  expect(f.sync).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(vi.mocked(fetch).mock.calls)).not.toContain("EVENT_PAYLOAD_MUST_NEVER_BE_INDEXED");
});
