import { beforeEach, describe, expect, it, vi } from "vitest";

const { runCompanyUnderstandingAgentMock, recoveryGuard, execute, absorb } = vi.hoisted(() => ({
  runCompanyUnderstandingAgentMock: vi.fn(),
  recoveryGuard: vi.fn(), execute: vi.fn(), absorb: vi.fn(),
}));

vi.mock("@corgtex/domain", () => ({ assertBrainSourceRecoveryJob: recoveryGuard }));

vi.mock("@corgtex/agents", () => ({
  executeAgentRun: execute,
  absorbSource: absorb,
  runBrainMaintenance: vi.fn(),
  runInboxTriageAgent: vi.fn(),
  runDailyCheckInAgent: vi.fn(),
  runMeetingSummaryAgent: vi.fn(),
  runActionExtractionAgent: vi.fn(),
  runProposalDraftingAgent: vi.fn(),
  runConstitutionUpdateTriggerAgent: vi.fn(),
  runConstitutionSynthesisAgent: vi.fn(),
  runCrmDripFollowupAgent: vi.fn(),
  runCrmEmailExtractionAgent: vi.fn(),
  runCrmLeadEnrichmentAgent: vi.fn(),
  runCompanyUnderstandingAgent: runCompanyUnderstandingAgentMock,
}));

describe("runAgentWorkflowJob", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    runCompanyUnderstandingAgentMock.mockResolvedValue({ id: "run-1" });
    absorb.mockResolvedValue({ absorbed: true, sourceId: "source" });
  });

  it("validates recovery before agent runtime and passes its identity to absorption", async () => {
    const { runAgentWorkflowJob } = await import("./agent-dispatch");
    const identity = "a".repeat(64);
    execute.mockImplementation(async (params) => params.execute({}, { step: (_name: string, _input: unknown, fn: () => unknown) => fn() }, "run", "model"));
    await runAgentWorkflowJob({ id: "job", workspaceId: "ws", type: "agent.brain-absorb", payload: { sourceId: "source", supportRecovery: true, expectedSourceIdentity: identity } });
    expect(recoveryGuard).toHaveBeenCalledWith({ workspaceId: "ws", sourceId: "source", workflowJobId: "job", expectedSourceIdentity: identity });
    expect(recoveryGuard.mock.invocationCallOrder[0]).toBeLessThan(execute.mock.invocationCallOrder[0]);
    expect(absorb).toHaveBeenCalledWith({ workspaceId: "ws", sourceId: "source", agentRunId: "run", model: "model", expectedSourceIdentity: identity });
    expect(runCompanyUnderstandingAgentMock).not.toHaveBeenCalled();
  });

  it("fails closed on invalid or stale recovery admission before agent runtime", async () => {
    const { runAgentWorkflowJob } = await import("./agent-dispatch");
    const job = { id: "job", workspaceId: "ws", type: "agent.brain-absorb", payload: { sourceId: "source", supportRecovery: true } };
    await expect(runAgentWorkflowJob(job)).rejects.toThrow("Invalid source recovery identity");
    recoveryGuard.mockRejectedValue(new Error("SOURCE_CHANGED"));
    await expect(runAgentWorkflowJob({ ...job, payload: { ...job.payload, expectedSourceIdentity: "a".repeat(64) } })).rejects.toThrow("SOURCE_CHANGED");
    expect(execute).not.toHaveBeenCalled();
  });

  it("acknowledges a proven completed own recovery without calling runtime or absorption", async () => {
    const { runAgentWorkflowJob } = await import("./agent-dispatch");
    const receipt = { alreadyCompleted: true, agentRunId: "run", workflowJobId: "job", sourceId: "source" };
    recoveryGuard.mockResolvedValue(receipt);
    await expect(runAgentWorkflowJob({ id: "job", workspaceId: "ws", type: "agent.brain-absorb", payload: { sourceId: "source", supportRecovery: true, expectedSourceIdentity: "a".repeat(64) } })).resolves.toBe(receipt);
    expect(execute).not.toHaveBeenCalled();
    expect(absorb).not.toHaveBeenCalled();
  });

  it.each(["not_found", "archived", "already_absorbed", "private diagnostic"])("rejects nested recovery skip %s before runtime success recording", async (reason) => {
    const { runAgentWorkflowJob } = await import("./agent-dispatch");
    const recordSuccess = vi.fn();
    execute.mockImplementation(async (params) => {
      const outcome = await params.execute({}, { step: (_name: string, _input: unknown, fn: () => unknown) => fn() }, "run", "model");
      recordSuccess(outcome);
      return outcome;
    });
    const skipped = { skipped: true, reason };
    absorb.mockResolvedValue(skipped);
    const job = { id: "job", workspaceId: "ws", type: "agent.brain-absorb", payload: { sourceId: "source" } };
    await expect(runAgentWorkflowJob({ ...job, payload: { ...job.payload, supportRecovery: true, expectedSourceIdentity: "a".repeat(64) } })).rejects.toThrow("Brain source recovery did not complete absorption.");
    expect(recordSuccess).not.toHaveBeenCalled();
    await expect(runAgentWorkflowJob(job)).resolves.toEqual({ resultJson: skipped });
    expect(recordSuccess).toHaveBeenCalledExactlyOnceWith({ resultJson: skipped });
  });

  it.each(["agent_disabled", "kill_switch", "budget_exceeded", "agent_identity_inactive", "daily_rate_limit", "hourly_rate_limit", "concurrency_limit", "untrusted private diagnostic"])("rejects recovery runtime skip %s instead of returning a completable result", async (reason) => {
    const { runAgentWorkflowJob } = await import("./agent-dispatch");
    execute.mockResolvedValue({ skipped: true, reason });
    const job = { id: "job", workspaceId: "ws", type: "agent.brain-absorb", payload: { sourceId: "source", supportRecovery: true, expectedSourceIdentity: "a".repeat(64) } };
    const completed = vi.fn();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(runAgentWorkflowJob(job).then(completed)).rejects.toThrow("Brain source recovery was skipped by agent runtime before processing.");
    }
    expect(completed).not.toHaveBeenCalled();
    expect(recoveryGuard).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(recoveryGuard.mock.invocationCallOrder[1]).toBeLessThan(execute.mock.invocationCallOrder[1]);
    expect(absorb).not.toHaveBeenCalled();
  });

  it("returns successful recovery and ordinary absorption skips unchanged", async () => {
    const { runAgentWorkflowJob } = await import("./agent-dispatch");
    const job = { id: "job", workspaceId: "ws", type: "agent.brain-absorb", payload: { sourceId: "source" } };
    const success = { id: "run", status: "COMPLETED" };
    execute.mockResolvedValueOnce(success);
    await expect(runAgentWorkflowJob({ ...job, payload: { ...job.payload, supportRecovery: true, expectedSourceIdentity: "a".repeat(64) } })).resolves.toBe(success);
    recoveryGuard.mockClear();
    for (const reason of ["agent_disabled", "kill_switch", "budget_exceeded", "agent_identity_inactive", "daily_rate_limit", "hourly_rate_limit", "concurrency_limit"]) {
      const skipped = { skipped: true, reason };
      execute.mockResolvedValueOnce(skipped);
      await expect(runAgentWorkflowJob(job)).resolves.toBe(skipped);
    }
    expect(recoveryGuard).not.toHaveBeenCalled();
  });

  it("dispatches company-understanding jobs with source context", async () => {
    const { runAgentWorkflowJob } = await import("./agent-dispatch");

    await runAgentWorkflowJob({
      id: "job-1",
      workspaceId: "workspace-1",
      type: "agent.company-understanding",
      payload: {
        sourceId: "source-1",
      },
    });

    expect(runCompanyUnderstandingAgentMock).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      triggerRef: "job-1",
      sourceId: "source-1",
      triggerType: "EVENT",
    });
  });
});
