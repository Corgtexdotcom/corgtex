-- AlterTable
ALTER TABLE "CrmActivity" ADD COLUMN     "archiveReason" TEXT,
ADD COLUMN     "archivedAt" TIMESTAMP(3),
ADD COLUMN     "archivedByUserId" TEXT;

-- CreateIndex
CREATE INDEX "CrmActivity_workspaceId_archivedAt_idx" ON "CrmActivity"("workspaceId", "archivedAt");
