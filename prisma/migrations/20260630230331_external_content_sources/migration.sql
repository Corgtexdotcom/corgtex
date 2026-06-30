-- CreateEnum
CREATE TYPE "ExternalContentSourceKind" AS ENUM ('HUB', 'FOLDER', 'FILE');

-- CreateEnum
CREATE TYPE "ExternalContentSourceStatus" AS ENUM ('ACTIVE', 'SYNCING', 'ERROR', 'ARCHIVED');

-- AlterEnum
ALTER TYPE "BrainSourceType" ADD VALUE 'EXTERNAL_CONTENT';

-- AlterEnum
ALTER TYPE "KnowledgeSourceType" ADD VALUE 'EXTERNAL_CONTENT';

-- CreateTable
CREATE TABLE "ExternalContentSource" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "connectionId" TEXT,
    "selectedByUserId" TEXT,
    "providerKey" TEXT NOT NULL,
    "sourceKind" "ExternalContentSourceKind" NOT NULL,
    "externalId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "externalUrl" TEXT,
    "syncMode" TEXT NOT NULL DEFAULT 'SELECTED',
    "status" "ExternalContentSourceStatus" NOT NULL DEFAULT 'ACTIVE',
    "lastRemoteVersion" TEXT,
    "lastSyncedAt" TIMESTAMP(3),
    "lastSyncError" TEXT,
    "metadata" JSONB,
    "archivedAt" TIMESTAMP(3),
    "archivedByUserId" TEXT,
    "archiveReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExternalContentSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExternalContentSyncLog" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "workflowJobId" TEXT,
    "status" TEXT NOT NULL,
    "remoteVersion" TEXT,
    "chunksCreated" INTEGER NOT NULL DEFAULT 0,
    "brainSourceId" TEXT,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "ExternalContentSyncLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ExternalContentSource_workspace_provider_status_idx" ON "ExternalContentSource"("workspaceId", "providerKey", "status");

-- CreateIndex
CREATE INDEX "ExternalContentSource_connection_idx" ON "ExternalContentSource"("connectionId");

-- CreateIndex
CREATE INDEX "ExternalContentSource_selectedByUser_idx" ON "ExternalContentSource"("selectedByUserId");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalContentSource_workspace_provider_kind_external_key" ON "ExternalContentSource"("workspaceId", "providerKey", "sourceKind", "externalId");

-- CreateIndex
CREATE INDEX "ExternalContentSyncLog_workspace_started_idx" ON "ExternalContentSyncLog"("workspaceId", "startedAt");

-- CreateIndex
CREATE INDEX "ExternalContentSyncLog_source_started_idx" ON "ExternalContentSyncLog"("sourceId", "startedAt");

-- CreateIndex
CREATE INDEX "ExternalContentSyncLog_workflowJob_idx" ON "ExternalContentSyncLog"("workflowJobId");

-- AddForeignKey
ALTER TABLE "ExternalContentSource" ADD CONSTRAINT "ExternalContentSource_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalContentSource" ADD CONSTRAINT "ExternalContentSource_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "ExternalMcpConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalContentSource" ADD CONSTRAINT "ExternalContentSource_selectedByUserId_fkey" FOREIGN KEY ("selectedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalContentSyncLog" ADD CONSTRAINT "ExternalContentSyncLog_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalContentSyncLog" ADD CONSTRAINT "ExternalContentSyncLog_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "ExternalContentSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;
