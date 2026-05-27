-- CreateEnum
CREATE TYPE "MeetingTranscriptSourceProvider" AS ENUM ('FIREFLIES', 'FATHOM', 'OTTER', 'GRANOLA', 'ZOOM', 'MICROSOFT_TEAMS', 'GOOGLE_MEET', 'READ_AI', 'TLDV', 'AVOMA', 'GONG', 'FELLOW', 'MEETGEEK', 'RECALL_AI', 'MEETING_BAAS', 'MANUAL_UPLOAD');

-- CreateEnum
CREATE TYPE "MeetingTranscriptSourceConnectionStatus" AS ENUM ('ACTIVE', 'DISABLED', 'ERROR');

-- CreateEnum
CREATE TYPE "MeetingTranscriptImportBatchStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'PARTIAL', 'FAILED');

-- CreateEnum
CREATE TYPE "MeetingTranscriptSourceRecordStatus" AS ENUM ('ACTIVE', 'SUPERSEDED', 'SKIPPED', 'FAILED');

-- AlterTable
ALTER TABLE "MeetingInsight" ADD COLUMN     "sourceRecordId" TEXT,
ADD COLUMN     "sourceRecordedAt" TIMESTAMP(3),
ADD COLUMN     "supersededAt" TIMESTAMP(3),
ADD COLUMN     "supersededByInsightId" TEXT;

-- CreateTable
CREATE TABLE "MeetingTranscriptSourceConnection" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "provider" "MeetingTranscriptSourceProvider" NOT NULL,
    "displayName" TEXT,
    "status" "MeetingTranscriptSourceConnectionStatus" NOT NULL DEFAULT 'ACTIVE',
    "authMode" TEXT NOT NULL,
    "accessTokenEnc" TEXT,
    "refreshTokenEnc" TEXT,
    "apiKeyEnc" TEXT,
    "webhookSecretEnc" TEXT,
    "cursorJson" JSONB,
    "lastSyncAt" TIMESTAMP(3),
    "lastBackfillAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MeetingTranscriptSourceConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MeetingTranscriptImportBatch" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "connectionId" TEXT,
    "provider" "MeetingTranscriptSourceProvider" NOT NULL,
    "sourceKind" TEXT NOT NULL,
    "status" "MeetingTranscriptImportBatchStatus" NOT NULL DEFAULT 'PENDING',
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "importedCount" INTEGER NOT NULL DEFAULT 0,
    "skippedCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MeetingTranscriptImportBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MeetingTranscriptSourceRecord" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "connectionId" TEXT,
    "batchId" TEXT,
    "meetingId" TEXT,
    "provider" "MeetingTranscriptSourceProvider" NOT NULL,
    "externalId" TEXT NOT NULL,
    "externalRevisionId" TEXT,
    "title" TEXT,
    "recordedAt" TIMESTAMP(3) NOT NULL,
    "sourceUpdatedAt" TIMESTAMP(3),
    "sourceUrl" TEXT,
    "contentHash" TEXT NOT NULL,
    "transcriptText" TEXT NOT NULL,
    "summaryMd" TEXT,
    "segmentsJson" JSONB,
    "participantsJson" JSONB,
    "rawMetadataJson" JSONB,
    "status" "MeetingTranscriptSourceRecordStatus" NOT NULL DEFAULT 'ACTIVE',
    "supersededByRecordId" TEXT,
    "processedAt" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MeetingTranscriptSourceRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MeetingTranscriptSourceConnection_workspaceId_status_idx" ON "MeetingTranscriptSourceConnection"("workspaceId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "MeetingTranscriptSourceConnection_workspaceId_provider_key" ON "MeetingTranscriptSourceConnection"("workspaceId", "provider");

-- CreateIndex
CREATE INDEX "MeetingTranscriptImportBatch_workspaceId_provider_createdAt_idx" ON "MeetingTranscriptImportBatch"("workspaceId", "provider", "createdAt");

-- CreateIndex
CREATE INDEX "MeetingTranscriptImportBatch_connectionId_createdAt_idx" ON "MeetingTranscriptImportBatch"("connectionId", "createdAt");

-- CreateIndex
CREATE INDEX "MeetingTranscriptImportBatch_workspaceId_status_idx" ON "MeetingTranscriptImportBatch"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "MeetingTranscriptSourceRecord_workspaceId_provider_external_idx" ON "MeetingTranscriptSourceRecord"("workspaceId", "provider", "externalId");

-- CreateIndex
CREATE INDEX "MeetingTranscriptSourceRecord_workspaceId_recordedAt_idx" ON "MeetingTranscriptSourceRecord"("workspaceId", "recordedAt");

-- CreateIndex
CREATE INDEX "MeetingTranscriptSourceRecord_meetingId_idx" ON "MeetingTranscriptSourceRecord"("meetingId");

-- CreateIndex
CREATE INDEX "MeetingTranscriptSourceRecord_batchId_idx" ON "MeetingTranscriptSourceRecord"("batchId");

-- CreateIndex
CREATE UNIQUE INDEX "MeetingTranscriptSourceRecord_workspaceId_provider_external_key" ON "MeetingTranscriptSourceRecord"("workspaceId", "provider", "externalId", "contentHash");

-- CreateIndex
CREATE INDEX "MeetingInsight_workspaceId_targetEntityType_targetEntityId__idx" ON "MeetingInsight"("workspaceId", "targetEntityType", "targetEntityId", "sourceRecordedAt");

-- CreateIndex
CREATE INDEX "MeetingInsight_sourceRecordId_idx" ON "MeetingInsight"("sourceRecordId");

-- AddForeignKey
ALTER TABLE "MeetingTranscriptSourceConnection" ADD CONSTRAINT "MeetingTranscriptSourceConnection_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeetingTranscriptImportBatch" ADD CONSTRAINT "MeetingTranscriptImportBatch_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeetingTranscriptImportBatch" ADD CONSTRAINT "MeetingTranscriptImportBatch_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "MeetingTranscriptSourceConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeetingTranscriptSourceRecord" ADD CONSTRAINT "MeetingTranscriptSourceRecord_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeetingTranscriptSourceRecord" ADD CONSTRAINT "MeetingTranscriptSourceRecord_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "MeetingTranscriptSourceConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeetingTranscriptSourceRecord" ADD CONSTRAINT "MeetingTranscriptSourceRecord_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "MeetingTranscriptImportBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeetingTranscriptSourceRecord" ADD CONSTRAINT "MeetingTranscriptSourceRecord_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "Meeting"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeetingTranscriptSourceRecord" ADD CONSTRAINT "MeetingTranscriptSourceRecord_supersededByRecordId_fkey" FOREIGN KEY ("supersededByRecordId") REFERENCES "MeetingTranscriptSourceRecord"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeetingInsight" ADD CONSTRAINT "MeetingInsight_sourceRecordId_fkey" FOREIGN KEY ("sourceRecordId") REFERENCES "MeetingTranscriptSourceRecord"("id") ON DELETE SET NULL ON UPDATE CASCADE;
