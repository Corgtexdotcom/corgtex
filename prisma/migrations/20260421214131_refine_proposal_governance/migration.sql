-- DropIndex
DROP INDEX "ProposalReaction_proposalId_userId_key";

-- AlterTable
ALTER TABLE "Proposal" ADD COLUMN     "autoApproveAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "ProposalReaction" ADD COLUMN     "bodyMd" TEXT,
ADD COLUMN     "resolvedAt" TIMESTAMP(3),
ADD COLUMN     "resolvedNote" TEXT;

-- CreateIndex
CREATE INDEX "ProposalReaction_proposalId_createdAt_idx" ON "ProposalReaction"("proposalId", "createdAt");
