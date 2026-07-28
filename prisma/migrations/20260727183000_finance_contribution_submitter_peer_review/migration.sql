-- Add auditable submitter tracking for native Finance contribution entries.
-- Historical rows are conservatively backfilled from the contributor so
-- existing requested cash payables remain subject to peer review.

ALTER TABLE "PracticeContributionEntry"
  ADD COLUMN "submittedByUserId" TEXT;

UPDATE "PracticeContributionEntry"
SET "submittedByUserId" = "contributorUserId"
WHERE "submittedByUserId" IS NULL;

CREATE INDEX "PracticeContributionEntry_workspaceId_submittedByUserId_idx"
  ON "PracticeContributionEntry"("workspaceId", "submittedByUserId");

ALTER TABLE "PracticeContributionEntry"
  ADD CONSTRAINT "PracticeContributionEntry_submittedByUserId_fkey"
  FOREIGN KEY ("submittedByUserId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
