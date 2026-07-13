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
  it("returns summarized model usage for listed runs without exposing raw usage rows", async () => {
    const { prisma } = await import("@corgtex/shared");
    const { listAgentRuns } = await import("./agent-runs");

    vi.mocked(prisma.agentRun.findMany).mockResolvedValue([
      {
        id: "run-1",
        workspaceId: "ws-1",
        status: "COMPLETED",
        steps: [],
        toolCalls: [],
        modelUsage: [
          {
            provider: "openai",
            model: "gpt-4o",
            taskType: "CHAT",
            inputTokens: 10,
            outputTokens: 5,
            latencyMs: 100,
            estimatedCostUsd: "0.100000",
            billableCostUsd: "0.050000",
          },
          {
            provider: "openai",
            model: "gpt-4o",
            taskType: "CHAT",
            inputTokens: 7,
            outputTokens: 3,
            latencyMs: 30,
            estimatedCostUsd: "0.200000",
            billableCostUsd: null,
          },
          {
            provider: "anthropic",
            model: "claude-sonnet-4",
            taskType: "SUMMARY",
            inputTokens: 20,
            outputTokens: 8,
            latencyMs: 80,
            estimatedCostUsd: "0.030000",
            billableCostUsd: null,
          },
        ],
      },
    ] as any);

    const runs = await listAgentRuns({ kind: "user", user: { id: "u-1" } } as any, "ws-1");

    expect(runs[0]).not.toHaveProperty("modelUsage");
    expect(runs[0]?.modelUsageSummary).toEqual([
      {
        provider: "openai",
        model: "gpt-4o",
        taskType: "CHAT",
        inputTokens: 17,
        outputTokens: 8,
        latencyMs: 130,
        estimatedCostUsd: "0.250000",
      },
      {
        provider: "anthropic",
        model: "claude-sonnet-4",
        taskType: "SUMMARY",
        inputTokens: 20,
        outputTokens: 8,
        latencyMs: 80,
        estimatedCostUsd: "0.030000",
      },
    ]);
  });

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
