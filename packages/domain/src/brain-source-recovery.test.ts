import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";

const { db, access } = vi.hoisted(() => ({
  db: {
    $transaction: vi.fn(), $executeRaw: vi.fn(), $queryRaw: vi.fn(),
    brainSource: { findFirst: vi.fn(), findMany: vi.fn(), count: vi.fn() },
    event: { findMany: vi.fn() }, workflowJob: { findMany: vi.fn(), findUnique: vi.fn(), count: vi.fn(), create: vi.fn() },
    brainArticle: { count: vi.fn() }, webhookEndpoint: { count: vi.fn() }, agentRun: { count: vi.fn() }, auditLog: { create: vi.fn() },
  },
  access: vi.fn(),
}));
vi.mock("@corgtex/shared", () => ({ prisma: db }));
vi.mock("./brain-access", () => ({ resolveKnowledgeAccessDomains: access }));
import { brainSourceRecoveryIdentity, listBrainSourceRecovery, reconcileBrainSource } from "./brain-source-recovery";

const actor: AppActor = { kind: "agent", authProvider: "credential", label: "Corgtex Support", workspaceIds: ["ws"], scopes: ["support:write", "brain:read", "runtime:read", "runtime:write"] };
const source = { id: "source", workspaceId: "ws", accessDomain: "WORKSPACE" as const, sourceType: "DOC" as const, tier: 1, title: "PRIVATE TITLE", channel: "PRIVATE CHANNEL", content: "PRIVATE CONTENT", ingestionGuidanceMd: "PRIVATE GUIDANCE", absorbedAt: null, archivedAt: null, createdAt: new Date("2026-01-01T00:00:00Z") };
const params = { workspaceId: "ws", sourceId: "source", expectedSourceIdentity: brainSourceRecoveryIdentity(source), reason: "Approved missing-source recovery" };
const event = { id: "event", status: "DISPATCHED", aggregateId: "source", aggregateType: "BrainSource", payload: { sourceId: "source" } };

describe("Brain source support recovery", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    db.$transaction.mockImplementation((fn) => fn(db));
    access.mockResolvedValue(["WORKSPACE"]);
    db.brainSource.findFirst.mockResolvedValue(source);
    db.brainSource.findMany.mockResolvedValue([source]);
    db.brainSource.count.mockResolvedValue(1);
    db.event.findMany.mockResolvedValue([event]);
    db.workflowJob.findMany.mockResolvedValue([]);
    db.workflowJob.findUnique.mockResolvedValue(null);
    db.workflowJob.count.mockResolvedValue(0);
    db.workflowJob.create.mockResolvedValue({ id: "job", status: "PENDING" });
    db.brainArticle.count.mockResolvedValue(0);
    db.webhookEndpoint.count.mockResolvedValue(0);
    db.agentRun.count.mockResolvedValue(0);
  });

  it("returns only metadata and applies the resolved access domain", async () => {
    const result = await listBrainSourceRecovery(actor, { workspaceId: "ws" });
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
    expect(result.items[0]).toMatchObject({ id: "source", contentLength: 15, blockReason: null, articleCount: 0 });
    expect(db.brainSource.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { workspaceId: "ws", accessDomain: { in: ["WORKSPACE"] }, absorbedAt: null, archivedAt: null } }));
    expect(db.workflowJob.create).not.toHaveBeenCalled();
  });

  it.each(["support:write", "brain:read", "runtime:read", "runtime:write"])("rejects missing %s before reading customer data", async (scope) => {
    await expect(reconcileBrainSource({ ...actor, scopes: actor.scopes!.filter((value) => value !== scope) }, params)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(db.brainSource.findFirst).not.toHaveBeenCalled();
  });

  it("rejects a user session and enforces workspace membership", async () => {
    await expect(reconcileBrainSource({ kind: "user", user: { id: "user", email: "test@example.test", displayName: null } }, params)).rejects.toMatchObject({ code: "FORBIDDEN" });
    access.mockRejectedValue(new Error("workspace denied"));
    await expect(reconcileBrainSource(actor, { ...params, workspaceId: "other" })).rejects.toThrow("workspace denied");
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("does not accept an inaccessible source ID", async () => {
    db.brainSource.findFirst.mockResolvedValue(null);
    await expect(reconcileBrainSource(actor, params)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(db.brainSource.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "source", workspaceId: "ws", accessDomain: { in: ["WORKSPACE"] } } }));
  });

  it.each([
    ["archived", { archivedAt: new Date() }], ["already_absorbed", { absorbedAt: new Date() }],
    ["empty_content", { content: " " }], ["restricted_source", { accessDomain: "FINANCE" }],
  ])("blocks %s", async (reason, update) => {
    const changed = { ...source, ...update } as typeof source;
    db.brainSource.findFirst.mockResolvedValue(changed);
    await expect(reconcileBrainSource(actor, { ...params, expectedSourceIdentity: brainSourceRecoveryIdentity(changed) })).rejects.toThrow(String(reason));
    expect(db.workflowJob.create).not.toHaveBeenCalled();
  });

  it("rejects stale identity and an empty reason", async () => {
    db.brainSource.findFirst.mockResolvedValue({ ...source, content: "changed" });
    await expect(reconcileBrainSource(actor, params)).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    await expect(reconcileBrainSource(actor, { ...params, reason: " " })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(db.workflowJob.create).not.toHaveBeenCalled();
  });

  it.each(["PENDING", "PROCESSING", "FAILED"])("rejects a %s original event", async (status) => {
    db.event.findMany.mockResolvedValue([{ ...event, status }]);
    await expect(reconcileBrainSource(actor, params)).rejects.toThrow("source_event_not_settled");
  });

  it("rejects ambiguous events and partial output including archived articles", async () => {
    db.event.findMany.mockResolvedValue([event, { ...event, id: "other" }]);
    await expect(reconcileBrainSource(actor, params)).rejects.toThrow("ambiguous_source_events");
    db.event.findMany.mockResolvedValue([event]);
    db.brainArticle.count.mockResolvedValue(1);
    await expect(reconcileBrainSource(actor, params)).rejects.toThrow("existing_output");
    expect(db.brainArticle.count).toHaveBeenCalledWith({ where: { workspaceId: "ws", sourceIds: { has: "source" } } });
  });

  it.each(["PENDING", "RUNNING", "COMPLETED", "FAILED", "CANCELLED"])("does not replace a %s counterpart", async (status) => {
    db.workflowJob.findMany.mockResolvedValue([{ id: "old-job", status, payload: { sourceId: "source" } }]);
    await expect(reconcileBrainSource(actor, params)).rejects.toThrow("existing_counterpart");
    expect(db.workflowJob.create).not.toHaveBeenCalled();
  });

  it("rejects a prior run even if its workflow job is absent", async () => {
    db.agentRun.count.mockResolvedValue(1);
    await expect(reconcileBrainSource(actor, params)).rejects.toThrow("existing_counterpart");
    expect(db.agentRun.count).toHaveBeenCalledWith({ where: expect.objectContaining({
      workspaceId: "ws", agentKey: "brain-absorb",
      OR: expect.arrayContaining([{ planJson: { path: ["payload", "sourceId"], equals: "source" } }]),
    }) });
  });

  it("rejects outbound subscriptions and competing runtime jobs", async () => {
    db.webhookEndpoint.count.mockResolvedValue(1);
    await expect(reconcileBrainSource(actor, params)).rejects.toThrow("outbound_subscriptions");
    db.webhookEndpoint.count.mockResolvedValue(0);
    db.workflowJob.count.mockResolvedValue(1);
    await expect(reconcileBrainSource(actor, params)).rejects.toMatchObject({ code: "RUNTIME_NOT_QUIET" });
  });

  it("reuses settled provenance and canonical dedupe without replaying events", async () => {
    expect(await reconcileBrainSource(actor, params)).toEqual({ id: "job", status: "PENDING", sourceId: "source", eventId: "event", created: true });
    expect(db.workflowJob.create).toHaveBeenCalledExactlyOnceWith({ data: { workspaceId: "ws", eventId: "event", type: "agent.brain-absorb", dedupeKey: "event:brain-absorb", payload: { sourceId: "source", expectedSourceIdentity: params.expectedSourceIdentity, supportRecovery: true } }, select: { id: true, status: true } });
    expect(db.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ actorUserId: null, action: "brain-source.reconciled", meta: expect.objectContaining({ reason: params.reason, provenance: "existing_event" }) }) }));
  });

  it("records absent provenance truthfully", async () => {
    db.event.findMany.mockResolvedValue([]);
    await reconcileBrainSource(actor, params);
    expect(db.workflowJob.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ eventId: null, dedupeKey: "brain-source-recovery:ws:source" }) }));
  });

  it("returns the previous identical receipt even after processing without admitting more work", async () => {
    db.workflowJob.findMany.mockResolvedValue([{ id: "job", type: "agent.brain-absorb", status: "COMPLETED", eventId: "event", payload: { supportRecovery: true, expectedSourceIdentity: params.expectedSourceIdentity } }]);
    db.brainSource.findFirst.mockResolvedValue({ ...source, absorbedAt: new Date() });
    expect(await reconcileBrainSource(actor, params)).toMatchObject({ id: "job", created: false });
    expect(db.workflowJob.create).not.toHaveBeenCalled();
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });

  it("reports an occupied mismatched recovery key as a conflict", async () => {
    db.workflowJob.findUnique.mockResolvedValue({ id: "unrelated" });
    await expect(reconcileBrainSource(actor, params)).rejects.toMatchObject({ code: "RECOVERY_IDENTITY_CONFLICT" });
    expect(db.workflowJob.create).not.toHaveBeenCalled();
  });
});
