-- AlterTable
ALTER TABLE "Proposal" ADD COLUMN     "ownerMemberId" TEXT;

-- CreateIndex
CREATE INDEX "Proposal_ownerMemberId_idx" ON "Proposal"("ownerMemberId");

-- AddForeignKey
ALTER TABLE "Proposal" ADD CONSTRAINT "Proposal_ownerMemberId_fkey" FOREIGN KEY ("ownerMemberId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;
