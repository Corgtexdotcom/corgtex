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
  };
});

describe("agent-runs", () => {
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

      vi.mock("./auth", () => ({
        requireWorkspaceMembership: vi.fn().mockResolvedValue(true),
      }));

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
