-- Add workspace-visible ingestion guidance to meeting and source records.
ALTER TABLE "Meeting" ADD COLUMN "ingestionGuidanceMd" TEXT;
ALTER TABLE "BrainSource" ADD COLUMN "ingestionGuidanceMd" TEXT;
