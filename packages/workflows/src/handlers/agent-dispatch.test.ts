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
