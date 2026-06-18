-- AlterEnum
ALTER TYPE "MeetingInsightType" ADD VALUE 'CRM_CONTACT';
ALTER TYPE "MeetingInsightType" ADD VALUE 'CRM_DEAL';
ALTER TYPE "MeetingInsightType" ADD VALUE 'CRM_ACTIVITY';

-- AlterTable
ALTER TABLE "CrmActivity"
ADD COLUMN "sourceExternalId" TEXT,
ADD COLUMN "sourceUrl" TEXT,
ADD COLUMN "sourceOccurredAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "CrmConversation"
ADD COLUMN "source" TEXT NOT NULL DEFAULT 'manual',
ADD COLUMN "sourceExternalId" TEXT,
ADD COLUMN "sourceUrl" TEXT,
ADD COLUMN "sourceOccurredAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "MeetingInsight"
ADD COLUMN "metadataJson" JSONB NOT NULL DEFAULT '{}';

-- CreateIndex
CREATE INDEX "CrmActivity_workspaceId_source_sourceOccurredAt_idx" ON "CrmActivity"("workspaceId", "source", "sourceOccurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "CrmActivity_workspaceId_source_sourceExternalId_key" ON "CrmActivity"("workspaceId", "source", "sourceExternalId");

-- CreateIndex
CREATE INDEX "CrmConversation_workspaceId_source_sourceOccurredAt_idx" ON "CrmConversation"("workspaceId", "source", "sourceOccurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "CrmConversation_workspaceId_source_sourceExternalId_key" ON "CrmConversation"("workspaceId", "source", "sourceExternalId");
