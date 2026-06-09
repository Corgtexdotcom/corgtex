import { beforeEach, describe, expect, it, vi } from "vitest";

const { runCompanyUnderstandingAgentMock } = vi.hoisted(() => ({
  runCompanyUnderstandingAgentMock: vi.fn(),
}));

vi.mock("@corgtex/agents", () => ({
  executeAgentRun: vi.fn(),
  absorbSource: vi.fn(),
  runBrainMaintenance: vi.fn(),
  runInboxTriageAgent: vi.fn(),
  runDailyCheckInAgent: vi.fn(),
  runMeetingSummaryAgent: vi.fn(),
  runActionExtractionAgent: vi.fn(),
  runProposalDraftingAgent: vi.fn(),
  runConstitutionUpdateTriggerAgent: vi.fn(),
  runFinanceReconciliationPrepAgent: vi.fn(),
  runConstitutionSynthesisAgent: vi.fn(),
  runAdviceRoutingAgent: vi.fn(),
  runProcessLintingAgent: vi.fn(),
  runSpendSubmissionAgent: vi.fn(),
  runCrmDripFollowupAgent: vi.fn(),
  runCrmEmailExtractionAgent: vi.fn(),
  runCrmLeadEnrichmentAgent: vi.fn(),
  runCompanyUnderstandingAgent: runCompanyUnderstandingAgentMock,
}));

describe("runAgentWorkflowJob", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runCompanyUnderstandingAgentMock.mockResolvedValue({ id: "run-1" });
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
