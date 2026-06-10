import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock, markStaleContextGraphFactsMock, enqueueJobMock } = vi.hoisted(() => ({
  prismaMock: {
    member: { findMany: vi.fn() },
    goal: { findMany: vi.fn() },
    agentIdentity: { findMany: vi.fn() },
    $transaction: vi.fn(),
  },
  markStaleContextGraphFactsMock: vi.fn(),
  enqueueJobMock: vi.fn(),
}));

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
});
