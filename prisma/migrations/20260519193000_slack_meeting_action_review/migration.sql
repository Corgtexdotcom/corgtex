-- CreateEnum
CREATE TYPE "MeetingFollowUpReviewStatus" AS ENUM ('OPEN', 'CLOSED', 'EXPIRED');

-- AlterTable
ALTER TABLE "MeetingInsight" ADD COLUMN "dueAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "MeetingFollowUpReview" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "meetingId" TEXT NOT NULL,
  "installationId" TEXT NOT NULL,
  "provider" "CommunicationProvider" NOT NULL DEFAULT 'SLACK',
  "channelId" TEXT NOT NULL,
  "messageTs" TEXT,
  "threadTs" TEXT,
  "status" "MeetingFollowUpReviewStatus" NOT NULL DEFAULT 'OPEN',
  "postedAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "closedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "MeetingFollowUpReview_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MeetingFollowUpReview_meetingId_key" ON "MeetingFollowUpReview"("meetingId");

-- CreateIndex
CREATE INDEX "MeetingFollowUpReview_workspaceId_status_expiresAt_idx" ON "MeetingFollowUpReview"("workspaceId", "status", "expiresAt");

-- CreateIndex
CREATE INDEX "MeetingFollowUpReview_installationId_channelId_messageTs_idx" ON "MeetingFollowUpReview"("installationId", "channelId", "messageTs");

-- AddForeignKey
ALTER TABLE "MeetingFollowUpReview" ADD CONSTRAINT "MeetingFollowUpReview_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeetingFollowUpReview" ADD CONSTRAINT "MeetingFollowUpReview_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "Meeting"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeetingFollowUpReview" ADD CONSTRAINT "MeetingFollowUpReview_installationId_fkey" FOREIGN KEY ("installationId") REFERENCES "CommunicationInstallation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
