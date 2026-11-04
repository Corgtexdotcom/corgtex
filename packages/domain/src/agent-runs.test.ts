import { describe, expect, it, vi } from "vitest";

vi.mock("@corgtex/shared", async (importOriginal) => {
  const actual = await importOriginal<any>();
  const mockedPrisma = {
    ...actual.prisma,
    $queryRaw: vi.fn(async () => []),
    agentStep: { updateMany: vi.fn(), findFirst: vi.fn(async () => ({ id: "step-1", agentRunId: "run-1" })), findUniqueOrThrow: vi.fn(async () => ({ id: "step-1" })) },
    agentFeedbackInput: { create: vi.fn(async ({data}) => ({ id: "feedback-1", ...data })) },
    agentRequestInput: { create: vi.fn(async ({data}) => ({ id: "request-1", ...data })) },
    modelUsage: { findMany: vi.fn(async ({where}) => where.id.in.map((id: string) => ({id, workspaceId: "ws-1", estimatedCostUsd: "0.1", billableCostUsd: null, createdAt: new Date()}))) },
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
vi.mock("./source-lineage", async importOriginal => ({ ...await importOriginal<any>(),
  captureArtifactInputProof: vi.fn(async () => [{kind: "AgentFeedbackInput", id: "feedback-1", fingerprint: "a".repeat(64)}]),
  captureArtifactInputSnapshotProof: vi.fn(async () => [{kind: "ArtifactInputSnapshot", id: "snapshot-1", fingerprint: "a".repeat(64)}]),
  recordArtifactInputLineage: vi.fn(),
  readableArtifactIds: vi.fn(async (_actor, _workspaceId, _kind, records) => new Set(records.map((row: { id: string }) => row.id))) }));
// These tests cover request/summary contracts; real proof fencing is exercised in
// agent-runs.lineage.test.ts and agent-runs-release.integration.test.ts.
vi.mock("./digest-lineage", async importOriginal => ({ ...await importOriginal<any>(),
  DigestReadRelease: class {
    async capture(_kind: string, records: Array<{ id: string }>) { return { records, roots: [] }; }
    async finish<T>(value: T) { return value; }
  },
}));
vi.mock("./proposals", () => ({ getProposal: vi.fn() }));

describe("agent-runs", () => {
  it("includes all agent types for per-artifact lineage checks after the operational window", async () => {
    const { prisma } = await import("@corgtex/shared");
    const { listAgentRuns } = await import("./agent-runs");
    vi.mocked(prisma.agentRun.findMany).mockResolvedValue([
      { id: "other", workspaceId: "ws-1", agentKey: "meeting-summary", planJson: {}, steps: [], toolCalls: [], modelUsage: [] },
    ] as any);
    const runs = await listAgentRuns({ kind: "user", user: { id: "u-1" } } as any, "ws-1", { take: 2 });
    expect(prisma.agentRun.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { workspaceId: "ws-1", status: undefined },
      take: 2,
    }));
    expect(runs.map((run) => run.id)).toEqual(["other"]);
  });

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
            id: "usage-" + Math.random(), provider: "openai",
            model: "gpt-4o",
            taskType: "CHAT",
            inputTokens: 10,
            outputTokens: 5,
            latencyMs: 100,
            estimatedCostUsd: "0.100000",
            billableCostUsd: "0.050000",
          },
          {
            id: "usage-" + Math.random(), provider: "openai",
            model: "gpt-4o",
            taskType: "CHAT",
            inputTokens: 7,
            outputTokens: 3,
            latencyMs: 30,
            estimatedCostUsd: "0.200000",
            billableCostUsd: null,
          },
          {
            id: "usage-3", provider: "anthropic",
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
      });
      expect(prisma.agentRun.updateMany).toHaveBeenCalledWith({
        where: { id: "run-1", workspaceId: "ws-1", status: "WAITING_APPROVAL", approvalRequired: true },
        data: expect.objectContaining({ status: "COMPLETED", approvalRequired: false }),
      });
      expect(prisma.agentStep.updateMany).toHaveBeenCalledWith({
        where: { id: "step-1", agentRunId: "run-1", name: "approval-checkpoint", status: "PENDING", humanFeedback: null },
        data: expect.objectContaining({ humanFeedback: "Please clarify", status: "COMPLETED" }),
      });
      expect(prisma.workflowJob.create).toHaveBeenCalledWith({ data: expect.objectContaining({
        workspaceId: "ws-1", type: "agent.proposal-drafting",
        payload: { triggerType: "MANUAL", feedbackInputId: "feedback-1", priorRunSnapshotId: "snapshot-1" },
      }) });
      expect(prisma.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ action: "agentRun.feedbackSubmitted", entityId: "run-1" }) });
      expect(result).toEqual({ id: "step-1", continuationJobId: "job-2" });
      expect(prisma.agentFeedbackInput.create).toHaveBeenCalledWith({ data: expect.objectContaining({ content: "Please clarify", userId: "u-1", agentRunId: "run-1", stepId: "step-1", priorRunSnapshotId: "snapshot-1" }) });
      expect(prisma.agentRun.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.not.objectContaining({ resultJson: expect.anything() }) }));
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
