-- AlterTable
ALTER TABLE "CrmActivity" ADD COLUMN     "completedAt" TIMESTAMP(3),
ADD COLUMN     "completedByUserId" TEXT,
ADD COLUMN     "dueAt" TIMESTAMP(3),
ADD COLUMN     "ownerUserId" TEXT,
ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'manual';

-- CreateIndex
CREATE INDEX "CrmActivity_workspaceId_type_dueAt_idx" ON "CrmActivity"("workspaceId", "type", "dueAt");

-- CreateIndex
CREATE INDEX "CrmActivity_workspaceId_completedAt_idx" ON "CrmActivity"("workspaceId", "completedAt");

-- CreateIndex
CREATE INDEX "CrmActivity_workspaceId_ownerUserId_dueAt_idx" ON "CrmActivity"("workspaceId", "ownerUserId", "dueAt");
