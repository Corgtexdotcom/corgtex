-- AlterTable
ALTER TABLE "PracticeProject"
ADD COLUMN "crmAccountId" TEXT,
ADD COLUMN "crmDealId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "PracticeProject_crmDealId_key" ON "PracticeProject"("crmDealId");

-- CreateIndex
CREATE INDEX "PracticeProject_workspaceId_crmAccountId_idx" ON "PracticeProject"("workspaceId", "crmAccountId");

-- AddForeignKey
ALTER TABLE "PracticeProject"
ADD CONSTRAINT "PracticeProject_crmAccountId_fkey"
FOREIGN KEY ("crmAccountId") REFERENCES "CrmAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PracticeProject"
ADD CONSTRAINT "PracticeProject_crmDealId_fkey"
FOREIGN KEY ("crmDealId") REFERENCES "CrmDeal"("id") ON DELETE SET NULL ON UPDATE CASCADE;
