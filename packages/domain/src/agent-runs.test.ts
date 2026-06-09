import { describe, expect, it, vi } from "vitest";

vi.mock("@corgtex/shared", async (importOriginal) => {
  const actual = await importOriginal<any>();
  const mockedPrisma = {
    ...actual.prisma,
    agentStep: { update: vi.fn() },
    agentRun: { update: vi.fn(), findUnique: vi.fn(), findMany: vi.fn() },
  };
  mockedPrisma.$transaction = vi.fn(async (cb) => cb(mockedPrisma));

  return {
    ...actual,
    prisma: mockedPrisma,
    checkRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
    RATE_LIMITS: actual.RATE_LIMITS,
  };
});

vi.mock("./auth", () => ({
  requireWorkspaceMembership: vi.fn().mockResolvedValue(true),
}));

describe("agent-runs", () => {
  it("routes manual company-understanding triggers to the company-understanding workflow job", async () => {
    const { prisma } = await import("@corgtex/shared");
    const { triggerAgentRun } = await import("./agent-runs");
    (prisma as any).workflowJob = { create: vi.fn() };
    (prisma as any).auditLog = { create: vi.fn() };
    vi.mocked((prisma as any).workflowJob.create).mockResolvedValue({
      id: "job-1",
      type: "agent.company-understanding",
      status: "PENDING",
      createdAt: new Date(),
    });

    await triggerAgentRun({ kind: "user", user: { id: "u-1" } } as any, {
      workspaceId: "ws-1",
      agentKey: "company-understanding",
    });

    expect((prisma as any).workflowJob.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        workspaceId: "ws-1",
        type: "agent.company-understanding",
        payload: expect.objectContaining({ triggerType: "MANUAL" }),
      }),
    }));
  });

  describe("submitAgentFeedback", () => {
    it("verifies run ownership, scopes step update by agentRunId, and resumes the run", async () => {
      const { prisma } = await import("@corgtex/shared");
      const { submitAgentFeedback } = await import("./agent-runs");

      // Run exists in the workspace
      vi.mocked(prisma.agentRun.findUnique).mockResolvedValue({
        id: "run-1",
      } as any);

      vi.mocked(prisma.agentStep.update).mockResolvedValue({
        id: "step-1",
        humanFeedback: "proceed",
        status: "COMPLETED",
      } as any);

      vi.mocked(prisma.agentRun.update).mockResolvedValue({
        id: "run-1",
        status: "PENDING",
      } as any);

      const actor = { kind: "user", user: { id: "u-1" } } as any;

      const result = await submitAgentFeedback(actor, {
        workspaceId: "ws-1",
        agentRunId: "run-1",
        stepId: "step-1",
        feedback: "proceed",
      });

      // Verify the run was looked up scoped to workspace
      expect(prisma.agentRun.findUnique).toHaveBeenCalledWith({
        where: { id: "run-1", workspaceId: "ws-1" },
        select: { id: true },
      });

      expect(result.id).toBe("step-1");
      // Step update must be scoped by agentRunId to prevent cross-run writes
      expect(prisma.agentStep.update).toHaveBeenCalledWith({
        where: { id: "step-1", agentRunId: "run-1" },
        data: expect.objectContaining({ humanFeedback: "proceed", status: "COMPLETED" }),
      });
      expect(prisma.agentRun.update).toHaveBeenCalledWith({
        where: { id: "run-1", workspaceId: "ws-1" },
        data: { status: "PENDING" },
      });
    });
  });
});
