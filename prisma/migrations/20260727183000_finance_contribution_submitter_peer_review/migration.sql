-- Add auditable submitter tracking for native Finance contribution entries.
-- Historical submitter identity cannot be reconstructed reliably; leave it
-- null so existing requested cash payables stay blocked until reviewed with
-- explicit submitter ownership.

ALTER TABLE "PracticeContributionEntry"
  ADD COLUMN "submittedByUserId" TEXT;

CREATE INDEX "PracticeContributionEntry_workspaceId_submittedByUserId_idx"
  ON "PracticeContributionEntry"("workspaceId", "submittedByUserId");

ALTER TABLE "PracticeContributionEntry"
  ADD CONSTRAINT "PracticeContributionEntry_submittedByUserId_fkey"
  FOREIGN KEY ("submittedByUserId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
