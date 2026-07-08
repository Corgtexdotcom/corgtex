CREATE TYPE "MeetingTranscriptProcessingStage" AS ENUM (
  'UPLOADED',
  'SUMMARIZING',
  'EXTRACTING_INSIGHTS',
  'SYNCING_OUTPUTS',
  'INDEXING_BRAIN',
  'READY'
);

CREATE TYPE "MeetingTranscriptProcessingStageStatus" AS ENUM (
  'PENDING',
  'ACTIVE',
  'COMPLETED',
  'FAILED',
  'SKIPPED'
);

CREATE TABLE "MeetingTranscriptProcessingProgress" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "meetingId" TEXT NOT NULL,
  "currentStage" "MeetingTranscriptProcessingStage" NOT NULL DEFAULT 'UPLOADED',
  "stageStatuses" JSONB NOT NULL DEFAULT '{}',
  "currentWorkflowJobId" TEXT,
  "currentWorkflowJobType" TEXT,
  "currentWorkflowJobStatus" "WorkflowJobStatus",
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "safeErrorCode" TEXT,
  "safeErrorMessage" TEXT,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "failedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "MeetingTranscriptProcessingProgress_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MeetingTranscriptProcessingProgress_meetingId_key"
  ON "MeetingTranscriptProcessingProgress"("meetingId");

CREATE INDEX "MeetingTranscriptProcessingProgress_workspaceId_currentStag_idx"
  ON "MeetingTranscriptProcessingProgress"("workspaceId", "currentStage");

CREATE INDEX "MeetingTranscriptProcessingProgress_workspaceId_updatedAt_idx"
  ON "MeetingTranscriptProcessingProgress"("workspaceId", "updatedAt");

ALTER TABLE "MeetingTranscriptProcessingProgress"
  ADD CONSTRAINT "MeetingTranscriptProcessingProgress_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MeetingTranscriptProcessingProgress"
  ADD CONSTRAINT "MeetingTranscriptProcessingProgress_meetingId_fkey"
  FOREIGN KEY ("meetingId") REFERENCES "Meeting"("id") ON DELETE CASCADE ON UPDATE CASCADE;
