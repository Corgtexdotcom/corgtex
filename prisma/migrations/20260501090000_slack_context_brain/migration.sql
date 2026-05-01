ALTER TYPE "KnowledgeSourceType" ADD VALUE 'SLACK';

CREATE TABLE "CommunicationContextSummary" (
    "id" TEXT NOT NULL,
    "installationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "provider" "CommunicationProvider" NOT NULL,
    "externalChannelId" TEXT NOT NULL,
    "threadExternalId" TEXT,
    "summaryDate" TIMESTAMP(3) NOT NULL,
    "summaryKey" TEXT NOT NULL,
    "title" TEXT,
    "summaryMd" TEXT NOT NULL,
    "messageCount" INTEGER NOT NULL DEFAULT 0,
    "firstMessageTs" TIMESTAMP(3),
    "lastMessageTs" TIMESTAMP(3),
    "lastMessageExternalId" TEXT,
    "sourceMessageIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommunicationContextSummary_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CommunicationContextSummary_installationId_summaryKey_key" ON "CommunicationContextSummary"("installationId", "summaryKey");
CREATE INDEX "CommunicationContextSummary_workspaceId_provider_summaryDat_idx" ON "CommunicationContextSummary"("workspaceId", "provider", "summaryDate");
CREATE INDEX "CommunicationContextSummary_workspaceId_provider_externalCh_idx" ON "CommunicationContextSummary"("workspaceId", "provider", "externalChannelId", "threadExternalId");
CREATE INDEX "CommunicationMessage_installationId_externalChannelId_threa_idx" ON "CommunicationMessage"("installationId", "externalChannelId", "threadExternalId", "messageTs");
CREATE INDEX "CommunicationMessage_workspaceId_provider_externalChannelId_idx" ON "CommunicationMessage"("workspaceId", "provider", "externalChannelId", "messageTs");

ALTER TABLE "CommunicationContextSummary" ADD CONSTRAINT "CommunicationContextSummary_installationId_fkey" FOREIGN KEY ("installationId") REFERENCES "CommunicationInstallation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CommunicationContextSummary" ADD CONSTRAINT "CommunicationContextSummary_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
