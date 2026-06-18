-- CreateTable
CREATE TABLE "CrmCommunicationSuggestion" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "accountId" TEXT,
    "contactId" TEXT,
    "dealId" TEXT,
    "activityId" TEXT,
    "actorUserId" TEXT,
    "ownerUserId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'SUGGESTED',
    "channel" TEXT NOT NULL DEFAULT 'EMAIL',
    "title" TEXT NOT NULL,
    "subject" TEXT,
    "bodyMd" TEXT NOT NULL,
    "recipientEmail" TEXT,
    "recipientName" TEXT,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "requestedAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "declinedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "externalRequestId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmCommunicationSuggestion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CrmCommunicationSuggestion_workspaceId_status_createdAt_idx" ON "CrmCommunicationSuggestion"("workspaceId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "CrmCommunicationSuggestion_workspaceId_ownerUserId_status_idx" ON "CrmCommunicationSuggestion"("workspaceId", "ownerUserId", "status");

-- CreateIndex
CREATE INDEX "CrmCommunicationSuggestion_accountId_status_idx" ON "CrmCommunicationSuggestion"("accountId", "status");

-- CreateIndex
CREATE INDEX "CrmCommunicationSuggestion_contactId_status_idx" ON "CrmCommunicationSuggestion"("contactId", "status");

-- CreateIndex
CREATE INDEX "CrmCommunicationSuggestion_dealId_status_idx" ON "CrmCommunicationSuggestion"("dealId", "status");

-- CreateIndex
CREATE INDEX "CrmCommunicationSuggestion_activityId_idx" ON "CrmCommunicationSuggestion"("activityId");

-- AddForeignKey
ALTER TABLE "CrmCommunicationSuggestion" ADD CONSTRAINT "CrmCommunicationSuggestion_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmCommunicationSuggestion" ADD CONSTRAINT "CrmCommunicationSuggestion_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "CrmAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmCommunicationSuggestion" ADD CONSTRAINT "CrmCommunicationSuggestion_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "CrmContact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmCommunicationSuggestion" ADD CONSTRAINT "CrmCommunicationSuggestion_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "CrmDeal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmCommunicationSuggestion" ADD CONSTRAINT "CrmCommunicationSuggestion_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "CrmActivity"("id") ON DELETE SET NULL ON UPDATE CASCADE;
