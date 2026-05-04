-- CreateEnum
CREATE TYPE "MeetingRecorderProvider" AS ENUM ('RECALL_AI', 'MEETING_BAAS');

-- CreateEnum
CREATE TYPE "MeetingRecordingStatus" AS ENUM ('PENDING', 'SCHEDULED', 'JOINING', 'RECORDING', 'COMPLETED', 'FAILED', 'CANCELLED', 'SKIPPED');

-- AlterTable
ALTER TABLE "Meeting" ADD COLUMN     "meetingUrl" TEXT,
ADD COLUMN     "meetingUrlHash" TEXT;

-- CreateTable
CREATE TABLE "WorkspaceMeetingRecorderConfig" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "defaultProvider" "MeetingRecorderProvider" NOT NULL DEFAULT 'RECALL_AI',
    "fallbackProvider" "MeetingRecorderProvider",
    "botName" TEXT NOT NULL DEFAULT 'Corgtex Recorder',
    "entryMessage" TEXT,
    "autoRecordEnabled" BOOLEAN NOT NULL DEFAULT true,
    "monthlyMinuteCap" INTEGER NOT NULL DEFAULT 6000,
    "providerSettings" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkspaceMeetingRecorderConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MeetingRecording" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "meetingId" TEXT NOT NULL,
    "provider" "MeetingRecorderProvider" NOT NULL,
    "externalBotId" TEXT,
    "meetingUrl" TEXT NOT NULL,
    "scheduledAt" TIMESTAMP(3),
    "joinAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "status" "MeetingRecordingStatus" NOT NULL DEFAULT 'PENDING',
    "failureCode" TEXT,
    "failureMessage" TEXT,
    "transcriptProcessedAt" TIMESTAMP(3),
    "durationSeconds" INTEGER,
    "providerMetadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MeetingRecording_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MeetingRecorderProviderEvent" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT,
    "recordingId" TEXT,
    "provider" "MeetingRecorderProvider" NOT NULL,
    "externalEventId" TEXT,
    "externalBotId" TEXT,
    "eventType" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "redactedAt" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MeetingRecorderProviderEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceMeetingRecorderConfig_workspaceId_key" ON "WorkspaceMeetingRecorderConfig"("workspaceId");

-- CreateIndex
CREATE INDEX "MeetingRecording_workspaceId_meetingId_idx" ON "MeetingRecording"("workspaceId", "meetingId");

-- CreateIndex
CREATE INDEX "MeetingRecording_workspaceId_status_joinAt_idx" ON "MeetingRecording"("workspaceId", "status", "joinAt");

-- CreateIndex
CREATE INDEX "MeetingRecording_workspaceId_provider_externalBotId_idx" ON "MeetingRecording"("workspaceId", "provider", "externalBotId");

-- CreateIndex
CREATE UNIQUE INDEX "MeetingRecording_provider_externalBotId_key" ON "MeetingRecording"("provider", "externalBotId");

-- CreateIndex
CREATE UNIQUE INDEX "MeetingRecorderProviderEvent_dedupeKey_key" ON "MeetingRecorderProviderEvent"("dedupeKey");

-- CreateIndex
CREATE INDEX "MeetingRecorderProviderEvent_workspaceId_provider_eventType_idx" ON "MeetingRecorderProviderEvent"("workspaceId", "provider", "eventType");

-- CreateIndex
CREATE INDEX "MeetingRecorderProviderEvent_recordingId_idx" ON "MeetingRecorderProviderEvent"("recordingId");

-- CreateIndex
CREATE INDEX "MeetingRecorderProviderEvent_provider_externalBotId_idx" ON "MeetingRecorderProviderEvent"("provider", "externalBotId");

-- CreateIndex
CREATE INDEX "Meeting_workspaceId_meetingUrlHash_idx" ON "Meeting"("workspaceId", "meetingUrlHash");

-- AddForeignKey
ALTER TABLE "WorkspaceMeetingRecorderConfig" ADD CONSTRAINT "WorkspaceMeetingRecorderConfig_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeetingRecording" ADD CONSTRAINT "MeetingRecording_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeetingRecording" ADD CONSTRAINT "MeetingRecording_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "Meeting"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeetingRecorderProviderEvent" ADD CONSTRAINT "MeetingRecorderProviderEvent_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeetingRecorderProviderEvent" ADD CONSTRAINT "MeetingRecorderProviderEvent_recordingId_fkey" FOREIGN KEY ("recordingId") REFERENCES "MeetingRecording"("id") ON DELETE SET NULL ON UPDATE CASCADE;
