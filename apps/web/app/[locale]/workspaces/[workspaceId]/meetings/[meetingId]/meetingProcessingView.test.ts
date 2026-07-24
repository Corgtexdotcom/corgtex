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

function withStageStatuses(statuses: Record<string, MeetingTranscriptProcessingState["stages"][number]["detail"]["status"]>) {
  const base = state();
  return state({
    currentStage: statuses.READY === "COMPLETED" ? "READY" : base.currentStage,
    stages: base.stages.map((step) => ({
      ...step,
      detail: {
        ...step.detail,
        status: statuses[step.stage] ?? step.detail.status,
        chunkIndex: null,
        chunkCount: null,
      },
    })),
  });
}

function readyState(overrides: Partial<MeetingTranscriptProcessingState> = {}) {
  return {
    ...withStageStatuses({
      UPLOADED: "COMPLETED",
      SUMMARIZING: "COMPLETED",
      EXTRACTING_INSIGHTS: "COMPLETED",
      SYNCING_OUTPUTS: "COMPLETED",
      INDEXING_BRAIN: "COMPLETED",
      READY: "COMPLETED",
    }),
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

  it("collapses a complete ready state by default", () => {
    const view = buildMeetingProcessingView(readyState());

    expect(view?.overallClass).toBe("complete");
    expect(view?.summaryKey).toBe("processingCompactCompleteDescription");
    expect(view?.defaultExpanded).toBe(false);
    expect(view?.showReviewAction).toBe(false);
  });

  it("keeps active, queued, and indexing states expanded by default", () => {
    expect(buildMeetingProcessingView(state())?.defaultExpanded).toBe(true);

    const queued = withStageStatuses({
      UPLOADED: "COMPLETED",
      SUMMARIZING: "COMPLETED",
      EXTRACTING_INSIGHTS: "PENDING",
      SYNCING_OUTPUTS: "PENDING",
      INDEXING_BRAIN: "PENDING",
      READY: "PENDING",
    });
    expect(buildMeetingProcessingView(queued)?.defaultExpanded).toBe(true);

    const indexing = withStageStatuses({
      UPLOADED: "COMPLETED",
      SUMMARIZING: "COMPLETED",
      EXTRACTING_INSIGHTS: "COMPLETED",
      SYNCING_OUTPUTS: "COMPLETED",
      INDEXING_BRAIN: "ACTIVE",
      READY: "PENDING",
    });
    expect(buildMeetingProcessingView(indexing)?.defaultExpanded).toBe(true);
  });

  it("shows failed overall status when any step failed", () => {
    const failed = state({
      stages: state().stages.map((step) => step.stage === "EXTRACTING_INSIGHTS"
        ? { ...step, detail: { ...step.detail, status: "FAILED" } }
        : step),
    });

    const view = buildMeetingProcessingView(failed);
    expect(view?.overallClass).toBe("failed");
    expect(view?.defaultExpanded).toBe(true);
  });

  it("keeps a ready state compact but actionable when extracted items need review", () => {
    const view = buildMeetingProcessingView(readyState(), { reviewNeededCount: 3 });

    expect(view?.overallClass).toBe("complete");
    expect(view?.summaryKey).toBe("processingCompactReviewDescription");
    expect(view?.reviewNeededCount).toBe(3);
    expect(view?.showReviewAction).toBe(true);
    expect(view?.defaultExpanded).toBe(false);
  });

  it("keeps diagnostics admin-only and collapsed inside the detail view", () => {
    const diagnostics = [
      {
        workflowJobId: "job-1",
        workflowJobType: "meeting.insights.extract",
        status: "FAILED" as const,
        attempts: 2,
        updatedAt: "2026-07-24T10:00:00.000Z",
        safeErrorCode: "WORKFLOW_JOB_FAILED",
        safeErrorMessage: "The background job failed. Retry it or review workflow logs.",
        retrySupported: true,
      },
    ];
    const failedWithDiagnostics = state({ diagnostics });

    expect(buildMeetingProcessingView(failedWithDiagnostics, { canViewDiagnostics: false })?.diagnostics).toEqual([]);

    const adminView = buildMeetingProcessingView(failedWithDiagnostics, { canViewDiagnostics: true });
    expect(adminView?.diagnostics).toEqual(diagnostics);
    expect(adminView?.diagnosticsExpandedByDefault).toBe(false);
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

  it("shows ready while indexing when Brain indexing is queued", () => {
    const indexing = state({
      stages: state().stages.map((step) => {
        if (step.stage === "SUMMARIZING" || step.stage === "EXTRACTING_INSIGHTS" || step.stage === "SYNCING_OUTPUTS") {
          return { ...step, detail: { ...step.detail, status: "COMPLETED", chunkIndex: null, chunkCount: null } };
        }
        return step;
      }),
    });

    expect(buildMeetingProcessingView(indexing)?.titleKey).toBe("processingOverallReadyIndexing");
  });
});
