-- AlterTable
ALTER TABLE "CrmActivity" ADD COLUMN     "archiveReason" TEXT,
ADD COLUMN     "archivedAt" TIMESTAMP(3),
ADD COLUMN     "archivedByUserId" TEXT;

-- CreateIndex
CREATE INDEX "CrmActivity_workspaceId_archivedAt_idx" ON "CrmActivity"("workspaceId", "archivedAt");

-- Preserve independently archived activities (and their recovery ledger) when a parent is purged.
ALTER TABLE "CrmActivity" DROP CONSTRAINT "CrmActivity_contactId_fkey",
ADD CONSTRAINT "CrmActivity_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "CrmContact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CrmActivity" DROP CONSTRAINT "CrmActivity_dealId_fkey",
ADD CONSTRAINT "CrmActivity_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "CrmDeal"("id") ON DELETE SET NULL ON UPDATE CASCADE;
