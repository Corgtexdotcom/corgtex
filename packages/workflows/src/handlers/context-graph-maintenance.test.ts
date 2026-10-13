import { beforeEach, describe, expect, it, vi } from "vitest";

const { leaseMock, prismaMock, markStaleContextGraphFactsMock, enqueueJobMock } = vi.hoisted(() => ({
  leaseMock: vi.fn(),
  prismaMock: {
    meeting: { findMany: vi.fn() },
    member: { findMany: vi.fn() },
    brainArticle: { findMany: vi.fn() },
    proposal: { findMany: vi.fn() },
    action: { findMany: vi.fn() },
    tension: { findMany: vi.fn() },
    circle: { findMany: vi.fn() },
    role: { findMany: vi.fn() },
    document: { findMany: vi.fn() },

    goal: { findMany: vi.fn() },
    agentIdentity: { findMany: vi.fn() },
    $transaction: vi.fn(),
  },
  markStaleContextGraphFactsMock: vi.fn(),
  enqueueJobMock: vi.fn(),
}));

vi.mock("../../../domain/src/context-graph-retirement", () => ({ assertContextGraphJobLease: leaseMock, retireContextGraphChangedSourceDescendants: vi.fn() }));

vi.mock("@corgtex/shared", () => ({
  prisma: prismaMock,
}));

vi.mock("@corgtex/domain", () => ({
  contextGraphSystemActor: vi.fn(() => ({ kind: "agent", authProvider: "control-plane", label: "context-graph-sync" })),
  markStaleContextGraphFacts: markStaleContextGraphFactsMock,
}));

vi.mock("../outbox", () => ({
  enqueueJob: enqueueJobMock,
}));

describe("context graph maintenance handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.meeting.findMany.mockReset().mockResolvedValue([]);
    prismaMock.member.findMany.mockReset().mockResolvedValue([]);
    prismaMock.goal.findMany.mockReset().mockResolvedValue([]);
    prismaMock.agentIdentity.findMany.mockReset().mockResolvedValue([]);
    prismaMock.brainArticle.findMany.mockReset().mockResolvedValue([]);
    prismaMock.proposal.findMany.mockReset().mockResolvedValue([]);
    prismaMock.action.findMany.mockReset().mockResolvedValue([]);
    prismaMock.tension.findMany.mockReset().mockResolvedValue([]);
    prismaMock.circle.findMany.mockReset().mockResolvedValue([]);
    prismaMock.role.findMany.mockReset().mockResolvedValue([]);
    prismaMock.document.findMany.mockReset().mockResolvedValue([]);

    vi.unstubAllEnvs();
    prismaMock.$transaction.mockImplementation(async (callback: (tx: typeof prismaMock) => Promise<unknown>) => callback(prismaMock));
  });

  it("runs the staleness sweep with the system actor and default threshold", async () => {
    const { handleContextGraphStalenessSweep } = await import("./context-graph-maintenance");
    markStaleContextGraphFactsMock.mockResolvedValueOnce({ staleObjects: 1, staleRelationships: 0 });

    await handleContextGraphStalenessSweep("job-1", {}, "ws-1");

    expect(markStaleContextGraphFactsMock).toHaveBeenCalledWith(
      expect.objectContaining({ label: "context-graph-sync" }),
      { workspaceId: "ws-1", staleAfterDays: undefined },
    );
  });

  it("prefers payload threshold and falls back to the env threshold", async () => {
    const { handleContextGraphStalenessSweep } = await import("./context-graph-maintenance");
    markStaleContextGraphFactsMock.mockResolvedValue({ staleObjects: 0, staleRelationships: 0 });

    await handleContextGraphStalenessSweep("job-1", { staleAfterDays: 10 }, "ws-1");
    expect(markStaleContextGraphFactsMock).toHaveBeenLastCalledWith(expect.anything(), {
      workspaceId: "ws-1",
      staleAfterDays: 10,
    });

    vi.stubEnv("CONTEXT_GRAPH_STALE_AFTER_DAYS", "60");
    await handleContextGraphStalenessSweep("job-2", {}, "ws-1");
    expect(markStaleContextGraphFactsMock).toHaveBeenLastCalledWith(expect.anything(), {
      workspaceId: "ws-1",
      staleAfterDays: 60,
    });
  });

  it("enqueues idempotent reconcile sync jobs for members, goals, and agent identities", async () => {
    const { handleContextGraphReconcile } = await import("./context-graph-maintenance");
    prismaMock.member.findMany.mockResolvedValueOnce([{ id: "member-1" }]);
    prismaMock.goal.findMany.mockResolvedValueOnce([{ id: "goal-1" }, { id: "goal-2" }]);
    prismaMock.agentIdentity.findMany.mockResolvedValueOnce([{ id: "agent-1" }]);

    const result = await handleContextGraphReconcile("job-1", { dateISO: "2026-06-09" }, "ws-1");

    expect(result).toEqual({ enqueued: 4 });
    expect(enqueueJobMock).toHaveBeenCalledTimes(4);
    expect(enqueueJobMock).toHaveBeenCalledWith(prismaMock, {
      workspaceId: "ws-1",
      type: "context-graph.sync",
      payload: { sourceType: "MEMBER", sourceId: "member-1" },
      dedupeKey: "ws-1:context-graph-reconcile:MEMBER:member-1:2026-06-09",
    });
    expect(enqueueJobMock).toHaveBeenCalledWith(prismaMock, {
      workspaceId: "ws-1",
      type: "context-graph.sync",
      payload: { sourceType: "GOAL", sourceId: "goal-2" },
      dedupeKey: "ws-1:context-graph-reconcile:GOAL:goal-2:2026-06-09",
    });
    expect(enqueueJobMock).toHaveBeenCalledWith(prismaMock, {
      workspaceId: "ws-1",
      type: "context-graph.sync",
      payload: { sourceType: "AGENT_IDENTITY", sourceId: "agent-1" },
      dedupeKey: "ws-1:context-graph-reconcile:AGENT_IDENTITY:agent-1:2026-06-09",
    });
  });
  it("binds child sync jobs to the exact live reconcile parent and its event", async () => {
    const { handleContextGraphReconcile } = await import("./context-graph-maintenance");
    const execution = { attempts: 3, expectedLease: { lockedBy: "worker", lockedAt: new Date() } };
    prismaMock.document.findMany.mockResolvedValueOnce([{ id: "document-1" }]);
    leaseMock.mockResolvedValue({ id: "parent", eventId: "event", payload: { dateISO: "rebuild:event" } });
    await handleContextGraphReconcile("parent", { dateISO: "rebuild:event" }, "ws-1", execution);
    expect(leaseMock).toHaveBeenCalledWith(prismaMock, { workflowJobId: "parent", workspaceId: "ws-1", type: "context-graph.reconcile", ...execution });
    expect(enqueueJobMock).toHaveBeenCalledWith(prismaMock, expect.objectContaining({
      eventId: "event", dependsOnJobId: "parent", payload: { sourceType: "DOCUMENT", sourceId: "document-1" },
    }));
  });

  it("reconciles subsequent keyset pages and every native content family", async () => {
    const first = Array.from({ length: 1000 }, (_, index) => ({ id: `m-${String(index).padStart(4, "0")}` }));
    prismaMock.member.findMany.mockResolvedValueOnce(first).mockResolvedValueOnce([{ id: "m-1000" }]);
    for (const [kind, id] of [["meeting", "meeting"], ["brainArticle", "a"], ["proposal", "p"], ["action", "w"], ["tension", "t"], ["circle", "c"], ["role", "r"], ["document", "d"]] as const) {
      prismaMock[kind].findMany.mockResolvedValueOnce([{ id }]);
    }
    const { handleContextGraphReconcile } = await import("./context-graph-maintenance");
    await expect(handleContextGraphReconcile("job", { dateISO: "2026-10-12" }, "ws-1")).resolves.toEqual({ enqueued: 1009 });
    expect(prismaMock.member.findMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: { workspaceId: "ws-1", id: { gt: "m-0999" } }, orderBy: { id: "asc" }, take: 1000,
    }));
    expect(prismaMock.role.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { circle: { workspaceId: "ws-1" } } }));
    expect(enqueueJobMock.mock.calls.map((call) => call[1].payload.sourceType)).toEqual(expect.arrayContaining([
      "MEETING", "BRAIN_ARTICLE", "PROPOSAL", "ACTION", "TENSION", "CIRCLE", "ROLE", "DOCUMENT",
    ]));
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(10);
  });

});
