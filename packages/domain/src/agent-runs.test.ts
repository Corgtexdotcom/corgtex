import { describe, expect, it, vi } from "vitest";

vi.mock("@corgtex/shared", async (importOriginal) => {
  const actual = await importOriginal<any>();
  const mockedPrisma = {
    ...actual.prisma,
    agentStep: { updateMany: vi.fn() },
    agentRun: { updateMany: vi.fn(), findUnique: vi.fn(), findMany: vi.fn() },
    workflowJob: { create: vi.fn() },
    auditLog: { create: vi.fn() },
    proposal: { create: vi.fn(), update: vi.fn() },
    action: { create: vi.fn() },
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
vi.mock("./proposals", () => ({ getProposal: vi.fn() }));

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
    it("claims one review reply and queues an advisory continuation", async () => {
      const { prisma } = await import("@corgtex/shared");
      const { submitAgentFeedback } = await import("./agent-runs");
      vi.mocked(prisma.agentRun.findUnique).mockResolvedValue({
        id: "run-1", agentKey: "proposal-drafting", status: "WAITING_APPROVAL", approvalRequired: true,
        resultJson: { prompt: "Budget policy", proposalDraft: { title: "Draft" } },
        planJson: { payload: { meetingId: "meeting-1" } },
      } as any);
      vi.mocked(prisma.agentRun.updateMany).mockResolvedValue({ count: 1 } as any);
      vi.mocked(prisma.agentStep.updateMany).mockResolvedValue({ count: 1 } as any);
      vi.mocked(prisma.workflowJob.create).mockResolvedValue({ id: "job-2" } as any);

      const actor = { kind: "user", user: { id: "u-1" } } as any;
      const result = await submitAgentFeedback(actor, {
        workspaceId: "ws-1", agentRunId: "run-1", stepId: "step-1", feedback: "Please clarify",
      });
      expect(prisma.agentRun.findUnique).toHaveBeenCalledWith({
        where: { id: "run-1", workspaceId: "ws-1" },
        select: { id: true, agentKey: true, status: true, approvalRequired: true, resultJson: true, planJson: true },
      });
      expect(prisma.agentRun.updateMany).toHaveBeenCalledWith({
        where: { id: "run-1", workspaceId: "ws-1", status: "WAITING_APPROVAL", approvalRequired: true },
        data: expect.objectContaining({ status: "COMPLETED", approvalRequired: false, resultJson: expect.objectContaining({ feedbackDisposition: "ADVISORY_CONTINUATION_QUEUED" }) }),
      });
      expect(prisma.agentStep.updateMany).toHaveBeenCalledWith({
        where: { id: "step-1", agentRunId: "run-1", name: "approval-checkpoint", status: "PENDING", humanFeedback: null },
        data: expect.objectContaining({ humanFeedback: "Please clarify", status: "COMPLETED" }),
      });
      expect(prisma.workflowJob.create).toHaveBeenCalledWith({ data: expect.objectContaining({
        workspaceId: "ws-1", type: "agent.proposal-drafting",
        payload: expect.objectContaining({ reviewFeedback: "Please clarify", sourceAgentRunId: "run-1", meetingId: "meeting-1" }),
      }) });
      expect(prisma.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ action: "agentRun.feedbackSubmitted", entityId: "run-1" }) });
      expect(result).toEqual({ id: "step-1", continuationJobId: "job-2" });
      expect(prisma.proposal.create).not.toHaveBeenCalled();
      expect(prisma.proposal.update).not.toHaveBeenCalled();
      expect(prisma.action.create).not.toHaveBeenCalled();
    });

    it.each([
      [{ status: "COMPLETED", approvalRequired: false }, "stale run"],
      [{ agentKey: "meeting-summary" }, "unsupported agent"],
    ])("rejects %s without queueing", async (changes, _reason) => {
      const { prisma } = await import("@corgtex/shared");
      const { submitAgentFeedback } = await import("./agent-runs");
      vi.mocked(prisma.agentRun.findUnique).mockResolvedValue({
        id: "run-1", agentKey: "proposal-drafting", status: "WAITING_APPROVAL", approvalRequired: true,
        resultJson: { prompt: "Budget policy" }, ...changes,
      } as any);
      vi.mocked(prisma.workflowJob.create).mockClear();
      await expect(submitAgentFeedback({ kind: "user", user: { id: "u-1" } } as any, {
        workspaceId: "ws-1", agentRunId: "run-1", stepId: "step-1", feedback: "Clarify",
      })).rejects.toMatchObject({ status: 409 });
      expect(prisma.workflowJob.create).not.toHaveBeenCalled();
    });

    it.each(["agentRun", "agentStep"])("rejects an already claimed %s without queueing", async (failedClaim) => {
      const { prisma } = await import("@corgtex/shared");
      const { submitAgentFeedback } = await import("./agent-runs");
      vi.mocked(prisma.agentRun.findUnique).mockResolvedValue({
        id: "run-1", agentKey: "proposal-drafting", status: "WAITING_APPROVAL", approvalRequired: true,
        resultJson: { prompt: "Budget policy" },
      } as any);
      vi.mocked(prisma.agentRun.updateMany).mockResolvedValue({ count: failedClaim === "agentRun" ? 0 : 1 } as any);
      vi.mocked(prisma.agentStep.updateMany).mockResolvedValue({ count: failedClaim === "agentStep" ? 0 : 1 } as any);
      vi.mocked(prisma.workflowJob.create).mockClear();
      await expect(submitAgentFeedback({ kind: "user", user: { id: "u-1" } } as any, {
        workspaceId: "ws-1", agentRunId: "run-1", stepId: "step-1", feedback: "Clarify",
      })).rejects.toMatchObject({ status: 409 });
      expect(prisma.workflowJob.create).not.toHaveBeenCalled();
    });

    it("rechecks constitution proposal visibility before claiming a stale reply", async () => {
      const { prisma } = await import("@corgtex/shared");
      const { getProposal } = await import("./proposals");
      const { submitAgentFeedback } = await import("./agent-runs");
      vi.mocked(prisma.agentRun.findUnique).mockResolvedValue({
        id: "run-1", agentKey: "constitution-update-trigger", status: "WAITING_APPROVAL", approvalRequired: true,
        resultJson: { proposalId: "proposal-1", impactSummary: "Review policy" },
      } as any);
      vi.mocked(getProposal).mockRejectedValueOnce(new Error("Proposal not visible"));
      vi.mocked(prisma.agentRun.updateMany).mockClear();
      vi.mocked(prisma.workflowJob.create).mockClear();
      await expect(submitAgentFeedback({ kind: "user", user: { id: "u-1" } } as any, {
        workspaceId: "ws-1", agentRunId: "run-1", stepId: "step-1", feedback: "Clarify",
      })).rejects.toThrow("Proposal not visible");
      expect(getProposal).toHaveBeenCalledWith(expect.anything(), { workspaceId: "ws-1", proposalId: "proposal-1" });
      expect(prisma.agentRun.updateMany).not.toHaveBeenCalled();
      expect(prisma.workflowJob.create).not.toHaveBeenCalled();
    });
  });
});
