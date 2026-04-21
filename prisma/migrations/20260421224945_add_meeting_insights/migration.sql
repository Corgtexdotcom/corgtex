-- CreateEnum
CREATE TYPE "MeetingInsightType" AS ENUM ('DECISION', 'TENSION', 'ACTION_ITEM', 'PROPOSAL', 'FOLLOW_UP');

-- CreateEnum
CREATE TYPE "MeetingInsightStatus" AS ENUM ('SUGGESTED', 'CONFIRMED', 'APPLIED', 'DISMISSED');

-- CreateTable
CREATE TABLE "MeetingInsight" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "meetingId" TEXT NOT NULL,
    "type" "MeetingInsightType" NOT NULL,
    "status" "MeetingInsightStatus" NOT NULL DEFAULT 'SUGGESTED',
    "title" TEXT NOT NULL,
    "bodyMd" TEXT NOT NULL,
    "assigneeHint" TEXT,
    "confidence" DOUBLE PRECISION,
    "sourceQuote" TEXT,
    "appliedEntityType" TEXT,
    "appliedEntityId" TEXT,
    "reviewedByUserId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MeetingInsight_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MeetingInsight_workspaceId_meetingId_status_idx" ON "MeetingInsight"("workspaceId", "meetingId", "status");

-- AddForeignKey
ALTER TABLE "MeetingInsight" ADD CONSTRAINT "MeetingInsight_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeetingInsight" ADD CONSTRAINT "MeetingInsight_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "Meeting"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeetingInsight" ADD CONSTRAINT "MeetingInsight_reviewedByUserId_fkey" FOREIGN KEY ("reviewedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
