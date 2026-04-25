-- Add archive metadata to customer-visible workspace entities.
ALTER TABLE "Action" ADD COLUMN "archivedAt" TIMESTAMP(3), ADD COLUMN "archivedByUserId" TEXT, ADD COLUMN "archiveReason" TEXT;
ALTER TABLE "AgentIdentity" ADD COLUMN "archivedAt" TIMESTAMP(3), ADD COLUMN "archivedByUserId" TEXT, ADD COLUMN "archiveReason" TEXT;
ALTER TABLE "BrainArticle" ADD COLUMN "archivedAt" TIMESTAMP(3), ADD COLUMN "archivedByUserId" TEXT, ADD COLUMN "archiveReason" TEXT;
ALTER TABLE "BrainSource" ADD COLUMN "archivedAt" TIMESTAMP(3), ADD COLUMN "archivedByUserId" TEXT, ADD COLUMN "archiveReason" TEXT;
ALTER TABLE "Circle" ADD COLUMN "archivedAt" TIMESTAMP(3), ADD COLUMN "archivedByUserId" TEXT, ADD COLUMN "archiveReason" TEXT;
ALTER TABLE "CrmContact" ADD COLUMN "archivedAt" TIMESTAMP(3), ADD COLUMN "archivedByUserId" TEXT, ADD COLUMN "archiveReason" TEXT;
ALTER TABLE "CrmDeal" ADD COLUMN "archivedAt" TIMESTAMP(3), ADD COLUMN "archivedByUserId" TEXT, ADD COLUMN "archiveReason" TEXT;
ALTER TABLE "Cycle" ADD COLUMN "archivedAt" TIMESTAMP(3), ADD COLUMN "archivedByUserId" TEXT, ADD COLUMN "archiveReason" TEXT;
ALTER TABLE "Document" ADD COLUMN "archivedAt" TIMESTAMP(3), ADD COLUMN "archivedByUserId" TEXT, ADD COLUMN "archiveReason" TEXT;
ALTER TABLE "ExpertiseTag" ADD COLUMN "archivedAt" TIMESTAMP(3), ADD COLUMN "archivedByUserId" TEXT, ADD COLUMN "archiveReason" TEXT;
ALTER TABLE "ExternalDataSource" ADD COLUMN "archivedAt" TIMESTAMP(3), ADD COLUMN "archivedByUserId" TEXT, ADD COLUMN "archiveReason" TEXT;
ALTER TABLE "Goal" ADD COLUMN "archivedAt" TIMESTAMP(3), ADD COLUMN "archivedByUserId" TEXT, ADD COLUMN "archiveReason" TEXT;
ALTER TABLE "LedgerAccount" ADD COLUMN "archivedAt" TIMESTAMP(3), ADD COLUMN "archivedByUserId" TEXT, ADD COLUMN "archiveReason" TEXT;
ALTER TABLE "Meeting" ADD COLUMN "archivedAt" TIMESTAMP(3), ADD COLUMN "archivedByUserId" TEXT, ADD COLUMN "archiveReason" TEXT;
ALTER TABLE "OAuthApp" ADD COLUMN "archivedAt" TIMESTAMP(3), ADD COLUMN "archivedByUserId" TEXT, ADD COLUMN "archiveReason" TEXT;
ALTER TABLE "Proposal" ADD COLUMN "archivedAt" TIMESTAMP(3), ADD COLUMN "archivedByUserId" TEXT, ADD COLUMN "archiveReason" TEXT;
ALTER TABLE "Role" ADD COLUMN "archivedAt" TIMESTAMP(3), ADD COLUMN "archivedByUserId" TEXT, ADD COLUMN "archiveReason" TEXT;
ALTER TABLE "SpendRequest" ADD COLUMN "archivedAt" TIMESTAMP(3), ADD COLUMN "archivedByUserId" TEXT, ADD COLUMN "archiveReason" TEXT;
ALTER TABLE "Tension" ADD COLUMN "archivedAt" TIMESTAMP(3), ADD COLUMN "archivedByUserId" TEXT, ADD COLUMN "archiveReason" TEXT;
ALTER TABLE "WebhookEndpoint" ADD COLUMN "archivedAt" TIMESTAMP(3), ADD COLUMN "archivedByUserId" TEXT, ADD COLUMN "archiveReason" TEXT;
ALTER TABLE "WorkspaceAgentConfig" ADD COLUMN "archivedAt" TIMESTAMP(3), ADD COLUMN "archivedByUserId" TEXT, ADD COLUMN "archiveReason" TEXT;

-- Create central archive record table for recovery and purge tombstones.
CREATE TABLE "WorkspaceArchiveRecord" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "entityLabel" TEXT,
    "previousState" JSONB,
    "archiveReason" TEXT,
    "archivedByUserId" TEXT,
    "archivedByLabel" TEXT,
    "archivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "restoredByUserId" TEXT,
    "restoredAt" TIMESTAMP(3),
    "purgedByUserId" TEXT,
    "purgedAt" TIMESTAMP(3),
    "purgeReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkspaceArchiveRecord_pkey" PRIMARY KEY ("id")
);

-- Create indexes for active-only filters and recovery views.
CREATE INDEX "Action_workspaceId_archivedAt_idx" ON "Action"("workspaceId", "archivedAt");
CREATE INDEX "AgentIdentity_workspaceId_archivedAt_idx" ON "AgentIdentity"("workspaceId", "archivedAt");
CREATE INDEX "BrainArticle_workspaceId_archivedAt_idx" ON "BrainArticle"("workspaceId", "archivedAt");
CREATE INDEX "BrainSource_workspaceId_archivedAt_idx" ON "BrainSource"("workspaceId", "archivedAt");
CREATE INDEX "Circle_workspaceId_archivedAt_idx" ON "Circle"("workspaceId", "archivedAt");
CREATE INDEX "CrmContact_workspaceId_archivedAt_idx" ON "CrmContact"("workspaceId", "archivedAt");
CREATE INDEX "CrmDeal_workspaceId_archivedAt_idx" ON "CrmDeal"("workspaceId", "archivedAt");
CREATE INDEX "Cycle_workspaceId_archivedAt_idx" ON "Cycle"("workspaceId", "archivedAt");
CREATE INDEX "Document_workspaceId_archivedAt_idx" ON "Document"("workspaceId", "archivedAt");
CREATE INDEX "ExpertiseTag_workspaceId_archivedAt_idx" ON "ExpertiseTag"("workspaceId", "archivedAt");
CREATE INDEX "ExternalDataSource_workspaceId_archivedAt_idx" ON "ExternalDataSource"("workspaceId", "archivedAt");
CREATE INDEX "Goal_workspaceId_archivedAt_idx" ON "Goal"("workspaceId", "archivedAt");
CREATE INDEX "LedgerAccount_workspaceId_archivedAt_idx" ON "LedgerAccount"("workspaceId", "archivedAt");
CREATE INDEX "Meeting_workspaceId_archivedAt_idx" ON "Meeting"("workspaceId", "archivedAt");
CREATE INDEX "OAuthApp_workspaceId_archivedAt_idx" ON "OAuthApp"("workspaceId", "archivedAt");
CREATE INDEX "Proposal_workspaceId_archivedAt_idx" ON "Proposal"("workspaceId", "archivedAt");
CREATE INDEX "Role_circleId_archivedAt_idx" ON "Role"("circleId", "archivedAt");
CREATE INDEX "SpendRequest_workspaceId_archivedAt_idx" ON "SpendRequest"("workspaceId", "archivedAt");
CREATE INDEX "Tension_workspaceId_archivedAt_idx" ON "Tension"("workspaceId", "archivedAt");
CREATE INDEX "WebhookEndpoint_workspaceId_archivedAt_idx" ON "WebhookEndpoint"("workspaceId", "archivedAt");
CREATE INDEX "WorkspaceAgentConfig_workspaceId_archivedAt_idx" ON "WorkspaceAgentConfig"("workspaceId", "archivedAt");
CREATE INDEX "WorkspaceArchiveRecord_workspaceId_entityType_archivedAt_idx" ON "WorkspaceArchiveRecord"("workspaceId", "entityType", "archivedAt");
CREATE INDEX "WorkspaceArchiveRecord_workspaceId_restoredAt_idx" ON "WorkspaceArchiveRecord"("workspaceId", "restoredAt");
CREATE INDEX "WorkspaceArchiveRecord_entityType_entityId_idx" ON "WorkspaceArchiveRecord"("entityType", "entityId");

-- Add foreign key.
ALTER TABLE "WorkspaceArchiveRecord" ADD CONSTRAINT "WorkspaceArchiveRecord_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
