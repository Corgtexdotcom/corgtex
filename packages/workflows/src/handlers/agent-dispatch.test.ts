import { beforeEach, describe, expect, it, vi } from "vitest";

const { runCompanyUnderstandingAgentMock, runActionExtractionAgentMock, runBrainSourceRegenerationJobMock, runProposalDraftingAgentMock, runConstitutionUpdateTriggerAgentMock, recoveryGuard, execute, absorb, captureProof, maintenance, maintenanceClaim, meetingWorker, meetingActor } = vi.hoisted(() => ({
  maintenanceClaim: vi.fn(),
  meetingWorker: vi.fn(),
  meetingActor: Object.freeze({kind: "agent", authProvider: "bootstrap", label: "claimed-meeting"}),
  runCompanyUnderstandingAgentMock: vi.fn(),
  runActionExtractionAgentMock: vi.fn(),
  runBrainSourceRegenerationJobMock: vi.fn(),
  runProposalDraftingAgentMock: vi.fn(),
  runConstitutionUpdateTriggerAgentMock: vi.fn(),
  recoveryGuard: vi.fn(), execute: vi.fn(), absorb: vi.fn(), captureProof: vi.fn(), maintenance: vi.fn(),
}));

vi.mock("../brain-maintenance-jobs", () => ({prepareMaintenanceClaim: maintenanceClaim, MaintenanceDeferred: class extends Error {}}));
vi.mock("@corgtex/domain", async () => ({...await import("../../../domain/src/errors"), assertBrainSourceRecoveryJob: recoveryGuard, captureArtifactInputProof: captureProof, withMeetingTranscriptWorker: meetingWorker }));

vi.mock("@corgtex/agents", () => ({
  executeAgentRun: execute,
  absorbSource: absorb,
  runBrainSourceRegenerationJob: runBrainSourceRegenerationJobMock,
  runBrainMaintenance: maintenance,
  runInboxTriageAgent: vi.fn(),
  runDailyCheckInAgent: vi.fn(),
  runMeetingSummaryAgent: vi.fn(),
  runActionExtractionAgent: runActionExtractionAgentMock,
  runProposalDraftingAgent: runProposalDraftingAgentMock,
  runConstitutionUpdateTriggerAgent: runConstitutionUpdateTriggerAgentMock,
  runConstitutionSynthesisAgent: vi.fn(),
  runCrmDripFollowupAgent: vi.fn(),
  runCrmEmailExtractionAgent: vi.fn(),
  runCrmLeadEnrichmentAgent: vi.fn(),
  runCompanyUnderstandingAgent: runCompanyUnderstandingAgentMock,
}));

describe("runAgentWorkflowJob", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    meetingWorker.mockImplementation(async (_claim, work) => work(meetingActor));
    runCompanyUnderstandingAgentMock.mockResolvedValue({ id: "run-1" });
    absorb.mockResolvedValue({ absorbed: true, sourceId: "source" });
  });

  it("binds maintenance planning and output to complete server-captured receipts", async () => {
    const {runAgentWorkflowJob} = await import("./agent-dispatch");
    const roots = [{kind: "Workspace", id: "ws-1", fingerprint: "a".repeat(64)}];
    const consumed = [{kind: "ArtifactInputSnapshot", id: "snapshot", fingerprint: "b".repeat(64)}];
    const token = Object.freeze({kind: "agent-input-receipt"});
    captureProof.mockResolvedValue(roots);
    const apply = vi.fn(), finish = vi.fn(), assertCurrent = vi.fn(), acknowledgeCommit = vi.fn();
    const state = {phase: "DISCUSSIONS"};
    maintenanceClaim.mockResolvedValue({state, assertCurrent, finish, acknowledgeCommit, recoverOrVerifyExisting: async () => false});
    maintenance.mockResolvedValue({report: {scope: "BATCH", staleThreadCount: 1}, lineageRoots: consumed, next: state, apply, assertCurrent: async () => {}});
    const captureInputs = vi.fn(async () => token);
    const step = vi.fn(async (_name, _input, work, proof) => {expect(proof.receipt).toBe(token); return work();});
    execute.mockImplementation(async params => {
      expect(params.lineageRoots).toBe(roots);
      expect(params.contextLineageRoots({})).toBe(roots);
      const output = await params.execute({}, {captureInputs, step}, "run", "model");
      expect(output).toEqual({resultJson: {scope: "BATCH", staleThreadCount: 1}, lineageReceipt: token});
      await params.beforeComplete({transaction: "same-final-tx"});
      return {status: "COMPLETED"};
    });
    expect(await runAgentWorkflowJob({id: "job", workspaceId: "ws-1", type: "agent.brain-maintenance", payload: {}}, "worker"))
      .toEqual({status: "COMPLETED"});
    expect(captureInputs).toHaveBeenCalledExactlyOnceWith(consumed);
    expect(maintenance.mock.calls[0][0].actor).toBe(execute.mock.calls[0][0].lineageActor);
    expect(assertCurrent.mock.invocationCallOrder[0]).toBeLessThan(apply.mock.invocationCallOrder[0]);
    expect(apply.mock.invocationCallOrder[0]).toBeLessThan(finish.mock.invocationCallOrder[0]);
    expect(finish).toHaveBeenCalledWith({transaction: "same-final-tx"}, state);
    expect(acknowledgeCommit).toHaveBeenCalledOnce();
  });

  it("dispatches advisory review feedback to a new drafting run without protected actions", async () => {
    const { runAgentWorkflowJob } = await import("./agent-dispatch");
    runProposalDraftingAgentMock.mockResolvedValue({ id: "new-run", status: "WAITING_APPROVAL" });
    await expect(runAgentWorkflowJob({
      id: "continuation-job", workspaceId: "ws-1", type: "agent.proposal-drafting",
      payload: { triggerType: "MANUAL", prompt: "Budget policy", meetingId: "meeting-1", reviewFeedback: "Clarify", previousAdvice: "Earlier draft" },
    })).resolves.toEqual({ id: "new-run", status: "WAITING_APPROVAL" });
    expect(runProposalDraftingAgentMock).toHaveBeenCalledExactlyOnceWith({
      workspaceId: "ws-1", triggerRef: "continuation-job", prompt: "Budget policy", meetingId: "meeting-1",
      triggerType: "MANUAL", requestInputId: undefined, feedbackInputId: undefined, priorRunSnapshotId: undefined,
    });
    expect(runConstitutionUpdateTriggerAgentMock).not.toHaveBeenCalled();
  });

  it("dispatches constitution feedback only to advisory analysis", async () => {
    const { runAgentWorkflowJob } = await import("./agent-dispatch");
    runConstitutionUpdateTriggerAgentMock.mockResolvedValue({ id: "new-run", status: "WAITING_APPROVAL" });
    await expect(runAgentWorkflowJob({
      id: "continuation-job", workspaceId: "ws-1", type: "agent.constitution-update-trigger",
      payload: { triggerType: "MANUAL", proposalId: "proposal-1", reviewFeedback: "Clarify", previousAdvice: "Earlier impact" },
    })).resolves.toEqual({ id: "new-run", status: "WAITING_APPROVAL" });
    expect(runConstitutionUpdateTriggerAgentMock).toHaveBeenCalledExactlyOnceWith({
      workspaceId: "ws-1", triggerRef: "continuation-job", proposalId: "proposal-1",
      triggerType: "MANUAL", requestInputId: undefined, feedbackInputId: undefined, priorRunSnapshotId: undefined,
    });
    expect(runProposalDraftingAgentMock).not.toHaveBeenCalled();
  });

  it("dispatches source regeneration using the job and tenant identity", async () => {
    const { runAgentWorkflowJob } = await import("./agent-dispatch");
    runBrainSourceRegenerationJobMock.mockResolvedValue({ phase: "READY", candidateCount: 1 });
    await expect(runAgentWorkflowJob({ id: "job-1", workspaceId: "ws-1", type: "agent.brain-source-regenerate", payload: {}, attempts: 1 }, "worker-1"))
      .resolves.toEqual({ phase: "READY", candidateCount: 1 });
    expect(runBrainSourceRegenerationJobMock).toHaveBeenCalledWith({ workspaceId: "ws-1", jobId: "job-1", expectedAttempt: 1, expectedOwner: "worker-1" });
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

  it.each([undefined, false])("does not pass a legacy reviewOnly=%s bypass on manual extraction", async (reviewOnly) => {
    const { runAgentWorkflowJob } = await import("./agent-dispatch");
    await runAgentWorkflowJob({
      id: "manual-job", attempts: 3,
      workspaceId: "ws-1",
      type: "agent.action-extraction",
      payload: { meetingId: "meeting-1", triggerType: "MANUAL", reviewOnly },
    }, "worker-1");
    expect(meetingWorker).toHaveBeenCalledWith({workspaceId: "ws-1", meetingId: "meeting-1", jobId: "manual-job", owner: "worker-1", attempt: 3, claim: undefined}, expect.any(Function));

    expect(runActionExtractionAgentMock).toHaveBeenCalledWith({
      lineageActor: meetingActor, workspaceId: "ws-1",
      triggerRef: "manual-job",
      meetingId: "meeting-1",
      triggerType: "MANUAL",
    });
  });
});
