-- CreateEnum
CREATE TYPE "NewspaperDeliveryStatus" AS ENUM ('SENT', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "NewspaperDeliveryKind" AS ENUM ('MEMBER_NEWSPAPER', 'DEMO_WELCOME');

-- AlterEnum
ALTER TYPE "NewspaperCadence" ADD VALUE 'OFF';

-- CreateTable
CREATE TABLE "NewspaperDelivery" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "workflowJobId" TEXT,
    "memberId" TEXT,
    "demoLeadId" TEXT,
    "kind" "NewspaperDeliveryKind" NOT NULL,
    "cadence" "NewspaperCadence",
    "runKey" TEXT NOT NULL,
    "recipientEmail" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "status" "NewspaperDeliveryStatus" NOT NULL,
    "providerMessageId" TEXT,
    "sentAt" TIMESTAMP(3),
    "skippedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NewspaperDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NewspaperTrackedLink" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "workflowJobId" TEXT,
    "runKey" TEXT NOT NULL,
    "targetUrl" TEXT NOT NULL,
    "targetUrlHash" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "clickCount" INTEGER NOT NULL DEFAULT 0,
    "firstClickedAt" TIMESTAMP(3),
    "lastClickedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NewspaperTrackedLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "NewspaperDelivery_workspaceId_createdAt_idx" ON "NewspaperDelivery"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "NewspaperDelivery_workspaceId_runKey_idx" ON "NewspaperDelivery"("workspaceId", "runKey");

-- CreateIndex
CREATE INDEX "NewspaperDelivery_workflowJobId_idx" ON "NewspaperDelivery"("workflowJobId");

-- CreateIndex
CREATE INDEX "NewspaperDelivery_memberId_idx" ON "NewspaperDelivery"("memberId");

-- CreateIndex
CREATE INDEX "NewspaperDelivery_demoLeadId_idx" ON "NewspaperDelivery"("demoLeadId");

-- CreateIndex
CREATE UNIQUE INDEX "NewspaperTrackedLink_tokenHash_key" ON "NewspaperTrackedLink"("tokenHash");

-- CreateIndex
CREATE INDEX "NewspaperTrackedLink_workspaceId_runKey_idx" ON "NewspaperTrackedLink"("workspaceId", "runKey");

-- CreateIndex
CREATE INDEX "NewspaperTrackedLink_workspaceId_createdAt_idx" ON "NewspaperTrackedLink"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "NewspaperTrackedLink_workflowJobId_idx" ON "NewspaperTrackedLink"("workflowJobId");

-- CreateIndex
CREATE UNIQUE INDEX "NewspaperTrackedLink_runKey_targetUrlHash_key" ON "NewspaperTrackedLink"("runKey", "targetUrlHash");

-- AddForeignKey
ALTER TABLE "NewspaperDelivery" ADD CONSTRAINT "NewspaperDelivery_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NewspaperDelivery" ADD CONSTRAINT "NewspaperDelivery_workflowJobId_fkey" FOREIGN KEY ("workflowJobId") REFERENCES "WorkflowJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NewspaperDelivery" ADD CONSTRAINT "NewspaperDelivery_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NewspaperDelivery" ADD CONSTRAINT "NewspaperDelivery_demoLeadId_fkey" FOREIGN KEY ("demoLeadId") REFERENCES "DemoLead"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NewspaperTrackedLink" ADD CONSTRAINT "NewspaperTrackedLink_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NewspaperTrackedLink" ADD CONSTRAINT "NewspaperTrackedLink_workflowJobId_fkey" FOREIGN KEY ("workflowJobId") REFERENCES "WorkflowJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;
