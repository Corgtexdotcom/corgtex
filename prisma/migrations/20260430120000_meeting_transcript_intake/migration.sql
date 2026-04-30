-- CreateEnum
CREATE TYPE "MeetingInsightOperation" AS ENUM ('CREATE', 'RESOLVE');

-- AlterTable
ALTER TABLE "MeetingInsight"
  ADD COLUMN "operation" "MeetingInsightOperation" NOT NULL DEFAULT 'CREATE',
  ADD COLUMN "targetEntityType" TEXT,
  ADD COLUMN "targetEntityId" TEXT,
  ADD COLUMN "resolutionOutcome" "ProposalResolutionOutcome",
  ADD COLUMN "autoAppliedAt" TIMESTAMP(3),
  ADD COLUMN "autoApplyError" TEXT;
