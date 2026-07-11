-- CreateEnum
CREATE TYPE "MeetingAudioAssetStatus" AS ENUM ('UPLOADED', 'TRANSCRIBING', 'TRANSCRIBED', 'INGESTED', 'FAILED');

-- AlterEnum
ALTER TYPE "ModelTaskType" ADD VALUE 'TRANSCRIPTION';

-- CreateTable
CREATE TABLE "MeetingAudioAsset" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "meetingId" TEXT,
    "uploadedByUserId" TEXT,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT,
    "storageKey" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "durationSeconds" INTEGER,
    "title" TEXT,
    "recordedAt" TIMESTAMP(3),
    "participantEmails" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "MeetingAudioAssetStatus" NOT NULL DEFAULT 'UPLOADED',
    "transcriptText" TEXT,
    "transcriptProvider" TEXT,
    "transcriptModel" TEXT,
    "transcriptMetadata" JSONB,
    "intakeMeetingId" TEXT,
    "workflowJobId" TEXT,
    "failureCode" TEXT,
    "failureMessage" TEXT,
    "transcribedAt" TIMESTAMP(3),
    "ingestedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MeetingAudioAsset_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MeetingAudioAsset_storageKey_key" ON "MeetingAudioAsset"("storageKey");

-- CreateIndex
CREATE INDEX "MeetingAudioAsset_workspaceId_status_createdAt_idx" ON "MeetingAudioAsset"("workspaceId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "MeetingAudioAsset_workspaceId_meetingId_idx" ON "MeetingAudioAsset"("workspaceId", "meetingId");

-- CreateIndex
CREATE INDEX "MeetingAudioAsset_workflowJobId_idx" ON "MeetingAudioAsset"("workflowJobId");

-- AddForeignKey
ALTER TABLE "MeetingAudioAsset" ADD CONSTRAINT "MeetingAudioAsset_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeetingAudioAsset" ADD CONSTRAINT "MeetingAudioAsset_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "Meeting"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeetingAudioAsset" ADD CONSTRAINT "MeetingAudioAsset_uploadedByUserId_fkey" FOREIGN KEY ("uploadedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeetingAudioAsset" ADD CONSTRAINT "MeetingAudioAsset_workflowJobId_fkey" FOREIGN KEY ("workflowJobId") REFERENCES "WorkflowJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;
