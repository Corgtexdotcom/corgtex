import { describe, expect, it } from "vitest";
import type { MeetingTranscriptProcessingState } from "@corgtex/domain";
import { buildMeetingProcessingView } from "./meetingProcessingView";

function state(overrides: Partial<MeetingTranscriptProcessingState> = {}): MeetingTranscriptProcessingState {
  return {
    currentStage: "SUMMARIZING",
    diagnostics: [],
    stages: [
      { stage: "UPLOADED", detail: { status: "COMPLETED", startedAt: null, completedAt: null, failedAt: null, skippedAt: null, updatedAt: null, workflowJobId: null, workflowJobType: null, workflowJobStatus: null, attempts: null, chunkIndex: null, chunkCount: null, safeErrorCode: null, safeErrorMessage: null } },
      { stage: "SUMMARIZING", detail: { status: "ACTIVE", startedAt: null, completedAt: null, failedAt: null, skippedAt: null, updatedAt: null, workflowJobId: null, workflowJobType: null, workflowJobStatus: null, attempts: null, chunkIndex: 2, chunkCount: 5, safeErrorCode: null, safeErrorMessage: null } },
      { stage: "EXTRACTING_INSIGHTS", detail: { status: "PENDING", startedAt: null, completedAt: null, failedAt: null, skippedAt: null, updatedAt: null, workflowJobId: null, workflowJobType: null, workflowJobStatus: null, attempts: null, chunkIndex: null, chunkCount: null, safeErrorCode: null, safeErrorMessage: null } },
      { stage: "SYNCING_OUTPUTS", detail: { status: "PENDING", startedAt: null, completedAt: null, failedAt: null, skippedAt: null, updatedAt: null, workflowJobId: null, workflowJobType: null, workflowJobStatus: null, attempts: null, chunkIndex: null, chunkCount: null, safeErrorCode: null, safeErrorMessage: null } },
      { stage: "INDEXING_BRAIN", detail: { status: "PENDING", startedAt: null, completedAt: null, failedAt: null, skippedAt: null, updatedAt: null, workflowJobId: null, workflowJobType: null, workflowJobStatus: null, attempts: null, chunkIndex: null, chunkCount: null, safeErrorCode: null, safeErrorMessage: null } },
      { stage: "READY", detail: { status: "PENDING", startedAt: null, completedAt: null, failedAt: null, skippedAt: null, updatedAt: null, workflowJobId: null, workflowJobType: null, workflowJobStatus: null, attempts: null, chunkIndex: null, chunkCount: null, safeErrorCode: null, safeErrorMessage: null } },
    ],
    ...overrides,
  };
}

describe("buildMeetingProcessingView", () => {
  it("surfaces active step and chunk progress", () => {
    const view = buildMeetingProcessingView(state());

    expect(view?.overallClass).toBe("processing");
    expect(view?.activeStageLabelKey).toBe("processingStepSummarizing");
    expect(view?.steps.find((step) => step.stage === "SUMMARIZING")).toMatchObject({
      className: "active",
      chunkIndex: 2,
      chunkCount: 5,
    });
  });

  it("shows failed overall status when any step failed", () => {
    const failed = state({
      stages: state().stages.map((step) => step.stage === "EXTRACTING_INSIGHTS"
        ? { ...step, detail: { ...step.detail, status: "FAILED" } }
        : step),
    });

    expect(buildMeetingProcessingView(failed)?.overallClass).toBe("failed");
  });

  it("shows ready while indexing when Brain indexing is active", () => {
    const indexing = state({
      stages: state().stages.map((step) => {
        if (step.stage === "SUMMARIZING" || step.stage === "EXTRACTING_INSIGHTS" || step.stage === "SYNCING_OUTPUTS") {
          return { ...step, detail: { ...step.detail, status: "COMPLETED", chunkIndex: null, chunkCount: null } };
        }
        if (step.stage === "INDEXING_BRAIN") {
          return { ...step, detail: { ...step.detail, status: "ACTIVE" } };
        }
        return step;
      }),
    });

    expect(buildMeetingProcessingView(indexing)?.titleKey).toBe("processingOverallReadyIndexing");
  });
});
