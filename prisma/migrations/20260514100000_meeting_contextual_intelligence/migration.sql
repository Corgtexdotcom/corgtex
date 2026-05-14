ALTER TYPE "MeetingInsightType" ADD VALUE 'DELIBERATION_ENTRY';

ALTER TABLE "MeetingInsight"
  ADD COLUMN "deliberationEntryType" TEXT,
  ADD COLUMN "dedupeKey" TEXT;

CREATE UNIQUE INDEX "MeetingInsight_meetingId_dedupeKey_key" ON "MeetingInsight"("meetingId", "dedupeKey");
