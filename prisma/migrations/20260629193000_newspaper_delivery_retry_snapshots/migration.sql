-- AlterTable
ALTER TABLE "NewspaperDelivery" ADD COLUMN "retryOfDeliveryId" TEXT;
ALTER TABLE "NewspaperDelivery" ADD COLUMN "htmlSnapshot" TEXT;

-- CreateIndex
CREATE INDEX "NewspaperDelivery_workspaceId_runKey_status_idx" ON "NewspaperDelivery"("workspaceId", "runKey", "status");

-- CreateIndex
CREATE INDEX "NewspaperDelivery_workflowJobId_status_idx" ON "NewspaperDelivery"("workflowJobId", "status");

-- CreateIndex
CREATE INDEX "NewspaperDelivery_retryOfDeliveryId_idx" ON "NewspaperDelivery"("retryOfDeliveryId");

-- AddForeignKey
ALTER TABLE "NewspaperDelivery" ADD CONSTRAINT "NewspaperDelivery_retryOfDeliveryId_fkey" FOREIGN KEY ("retryOfDeliveryId") REFERENCES "NewspaperDelivery"("id") ON DELETE SET NULL ON UPDATE CASCADE;
