ALTER TABLE "DecisionRecord"
    ADD COLUMN "archivedByUserId" TEXT,
    ADD COLUMN "archiveReason" TEXT;

ALTER TABLE "DecisionRecord" ADD CONSTRAINT "DecisionRecord_proposalId_fkey"
    FOREIGN KEY ("proposalId") REFERENCES "Proposal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "DecisionRecord" ADD CONSTRAINT "DecisionRecord_tensionId_fkey"
    FOREIGN KEY ("tensionId") REFERENCES "Tension"("id") ON DELETE SET NULL ON UPDATE CASCADE;
