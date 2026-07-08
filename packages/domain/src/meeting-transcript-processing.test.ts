import { describe, expect, it } from "vitest";
import {
  deriveMeetingTranscriptProcessingState,
  normalizeMeetingTranscriptStageStatuses,
} from "./meeting-transcript-processing";

describe("meeting transcript processing progress", () => {
  it("shows uploaded complete and summarizing active for a new transcript fallback", () => {
    const state = deriveMeetingTranscriptProcessingState({
      meeting: {
        transcript: "Meeting transcript",
        summaryMd: null,
        aiProcessedAt: null,
        insightCount: 0,
      },
    });

    expect(state?.stages.find((step) => step.stage === "UPLOADED")?.detail.status).toBe("COMPLETED");
    expect(state?.stages.find((step) => step.stage === "SUMMARIZING")?.detail.status).toBe("ACTIVE");
  });

  it("keeps real chunk progress on the active stage", () => {
    const state = deriveMeetingTranscriptProcessingState({
      meeting: {
        transcript: "Long meeting transcript",
        summaryMd: null,
        aiProcessedAt: null,
      },
      progress: {
        currentStage: "SUMMARIZING",
        stageStatuses: {
          ...normalizeMeetingTranscriptStageStatuses({}),
          UPLOADED: { status: "COMPLETED" },
          SUMMARIZING: {
            status: "ACTIVE",
            chunkIndex: 3,
            chunkCount: 9,
          },
        },
      } as any,
    });

    const summarizing = state?.stages.find((step) => step.stage === "SUMMARIZING");
    expect(summarizing?.detail.status).toBe("ACTIVE");
    expect(summarizing?.detail.chunkIndex).toBe(3);
    expect(summarizing?.detail.chunkCount).toBe(9);
  });

  it("maps failed jobs to a safe failed stage and diagnostic", () => {
    const state = deriveMeetingTranscriptProcessingState({
      meeting: {
        transcript: "Meeting transcript",
        summaryMd: "Summary",
        aiProcessedAt: null,
      },
      jobs: [
        {
          id: "job-1",
          type: "meeting.insights.extract",
          status: "FAILED",
          attempts: 5,
          error: "raw provider failure with possible private content",
          updatedAt: "2026-07-08T10:00:00.000Z",
        },
      ],
    });

    const extraction = state?.stages.find((step) => step.stage === "EXTRACTING_INSIGHTS");
    expect(extraction?.detail.status).toBe("FAILED");
    expect(state?.diagnostics[0]).toMatchObject({
      workflowJobId: "job-1",
      safeErrorCode: "WORKFLOW_JOB_FAILED",
      safeErrorMessage: "The background job failed. Retry it or review workflow logs.",
      retrySupported: true,
    });
  });

  it("distinguishes ready from ready while Brain indexing is active", () => {
    const indexing = deriveMeetingTranscriptProcessingState({
      meeting: {
        transcript: "Meeting transcript",
        summaryMd: "Summary",
        aiProcessedAt: "2026-07-08T10:00:00.000Z",
      },
      jobs: [
        {
          id: "job-2",
          type: "knowledge.sync.meeting",
          status: "RUNNING",
          attempts: 1,
          updatedAt: "2026-07-08T10:01:00.000Z",
        },
      ],
    });
    const ready = deriveMeetingTranscriptProcessingState({
      meeting: {
        transcript: "Meeting transcript",
        summaryMd: "Summary",
        aiProcessedAt: "2026-07-08T10:00:00.000Z",
      },
    });

    expect(indexing?.stages.find((step) => step.stage === "INDEXING_BRAIN")?.detail.status).toBe("ACTIVE");
    expect(indexing?.stages.find((step) => step.stage === "READY")?.detail.status).toBe("PENDING");
    expect(ready?.stages.find((step) => step.stage === "READY")?.detail.status).toBe("COMPLETED");
  });
});
