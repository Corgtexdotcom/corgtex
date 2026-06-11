-- AlterTable
ALTER TABLE "Action" ADD COLUMN     "priority" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Proposal" ADD COLUMN     "priority" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "Action_workspaceId_priority_idx" ON "Action"("workspaceId", "priority");

-- CreateIndex
CREATE INDEX "Proposal_workspaceId_priority_idx" ON "Proposal"("workspaceId", "priority");
