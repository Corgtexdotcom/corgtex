import { describe, expect, it, vi } from "vitest";

vi.mock("@corgtex/shared", async (importOriginal) => {
  const actual = await importOriginal<any>();
  const mockedPrisma = {
    ...actual.prisma,
    agentStep: { update: vi.fn() },
    agentRun: { update: vi.fn(), findMany: vi.fn() },
  };
  mockedPrisma.$transaction = vi.fn(async (cb) => cb(mockedPrisma));
  
  return {
    ...actual,
    prisma: mockedPrisma,
  };
});

describe("agent-runs", () => {
  describe("submitAgentFeedback", () => {
    it("updates the step with feedback and resumes the run", async () => {
      const { prisma } = await import("@corgtex/shared");
      const { submitAgentFeedback } = await import("./agent-runs");

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

      expect(result.id).toBe("step-1");
      expect(prisma.agentStep.update).toHaveBeenCalledWith({
        where: { id: "step-1" },
        data: expect.objectContaining({ humanFeedback: "proceed", status: "COMPLETED" }),
      });
      expect(prisma.agentRun.update).toHaveBeenCalledWith({
        where: { id: "run-1", workspaceId: "ws-1" },
        data: { status: "PENDING" },
      });
    });
  });
});
