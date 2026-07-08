import type {
  MeetingTranscriptProcessingStage,
  MeetingTranscriptProcessingStageStatus,
  MeetingTranscriptProcessingState,
} from "@corgtex/domain";

const STAGE_LABEL_KEYS: Record<MeetingTranscriptProcessingStage, string> = {
  UPLOADED: "processingStepUploaded",
  SUMMARIZING: "processingStepSummarizing",
  EXTRACTING_INSIGHTS: "processingStepExtracting",
  SYNCING_OUTPUTS: "processingStepSyncing",
  INDEXING_BRAIN: "processingStepIndexing",
  READY: "processingStepReady",
};

const STATUS_LABEL_KEYS: Record<MeetingTranscriptProcessingStageStatus, string> = {
  PENDING: "processingStepStatusPending",
  ACTIVE: "processingStepStatusActive",
  COMPLETED: "processingStepStatusComplete",
  FAILED: "processingStepStatusFailed",
  SKIPPED: "processingStepStatusSkipped",
};

const STATUS_CLASS: Record<MeetingTranscriptProcessingStageStatus, string> = {
  PENDING: "pending",
  ACTIVE: "active",
  COMPLETED: "complete",
  FAILED: "failed",
  SKIPPED: "skipped",
};

export function buildMeetingProcessingView(state: MeetingTranscriptProcessingState | null) {
  if (!state) return null;

  const failedStep = state.stages.find((step) => step.detail.status === "FAILED");
  const activeStep = state.stages.find((step) => step.detail.status === "ACTIVE");
  const readyStep = state.stages.find((step) => step.stage === "READY");
  const indexingStep = state.stages.find((step) => step.stage === "INDEXING_BRAIN");
  const ready = readyStep?.detail.status === "COMPLETED";
  const readyIndexing = !ready && (
    indexingStep?.detail.status === "ACTIVE"
    || (!activeStep && indexingStep?.detail.status === "PENDING")
  );
  const overallClass = failedStep ? "failed" : ready ? "complete" : readyIndexing ? "ready-indexing" : "processing";
  const titleKey = failedStep
    ? "processingOverallFailed"
    : ready
      ? "processingOverallReady"
      : readyIndexing
        ? "processingOverallReadyIndexing"
        : "processingOverallProcessing";

  return {
    overallClass,
    titleKey,
    activeStageLabelKey: activeStep ? STAGE_LABEL_KEYS[activeStep.stage] : null,
    steps: state.stages.map((step) => ({
      stage: step.stage,
      labelKey: STAGE_LABEL_KEYS[step.stage],
      statusKey: STATUS_LABEL_KEYS[step.detail.status],
      className: STATUS_CLASS[step.detail.status],
      chunkIndex: step.detail.status === "ACTIVE" ? step.detail.chunkIndex : null,
      chunkCount: step.detail.status === "ACTIVE" ? step.detail.chunkCount : null,
    })),
    diagnostics: state.diagnostics,
  };
}
