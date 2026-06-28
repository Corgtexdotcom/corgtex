ALTER TYPE "KnowledgeSourceType" ADD VALUE 'EXTERNAL_RESOURCE';

ALTER TABLE "ExternalMcpConnection"
ADD COLUMN "providerAccountId" TEXT,
ADD COLUMN "providerEmail" TEXT,
ADD COLUMN "expiresAt" TIMESTAMP(3);

CREATE TABLE "WorkspaceExternalResource" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "createdByUserId" TEXT,
  "providerKey" TEXT NOT NULL,
  "externalId" TEXT NOT NULL,
  "resourceType" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "url" TEXT NOT NULL,
  "sharedLinkUrl" TEXT,
  "mimeType" TEXT,
  "descriptionMd" TEXT,
  "summaryMd" TEXT,
  "metadata" JSONB,
  "lastEnrichedAt" TIMESTAMP(3),
  "lastEnrichmentError" TEXT,
  "archivedAt" TIMESTAMP(3),
  "archivedByUserId" TEXT,
  "archiveReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "WorkspaceExternalResource_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "WorkspaceExternalResourceAttachment" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "resourceId" TEXT NOT NULL,
  "entityType" TEXT NOT NULL,
  "entityId" TEXT NOT NULL,
  "purpose" TEXT NOT NULL DEFAULT 'reference',
  "createdByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "WorkspaceExternalResourceAttachment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WorkspaceExternalResource_workspaceId_providerKey_externalId_key"
ON "WorkspaceExternalResource"("workspaceId", "providerKey", "externalId");

CREATE INDEX "WorkspaceExternalResource_workspaceId_providerKey_archivedAt_idx"
ON "WorkspaceExternalResource"("workspaceId", "providerKey", "archivedAt");

CREATE INDEX "WorkspaceExternalResource_workspaceId_resourceType_idx"
ON "WorkspaceExternalResource"("workspaceId", "resourceType");

CREATE INDEX "WorkspaceExternalResource_createdByUserId_idx"
ON "WorkspaceExternalResource"("createdByUserId");

CREATE UNIQUE INDEX "WorkspaceExternalResourceAttachment_resourceId_entityType_entityId_purpose_key"
ON "WorkspaceExternalResourceAttachment"("resourceId", "entityType", "entityId", "purpose");

CREATE INDEX "WorkspaceExternalResourceAttachment_workspaceId_entityType_entityId_idx"
ON "WorkspaceExternalResourceAttachment"("workspaceId", "entityType", "entityId");

CREATE INDEX "WorkspaceExternalResourceAttachment_workspaceId_purpose_idx"
ON "WorkspaceExternalResourceAttachment"("workspaceId", "purpose");

CREATE INDEX "WorkspaceExternalResourceAttachment_createdByUserId_idx"
ON "WorkspaceExternalResourceAttachment"("createdByUserId");

ALTER TABLE "WorkspaceExternalResource"
ADD CONSTRAINT "WorkspaceExternalResource_workspaceId_fkey"
FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "WorkspaceExternalResource"
ADD CONSTRAINT "WorkspaceExternalResource_createdByUserId_fkey"
FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "WorkspaceExternalResourceAttachment"
ADD CONSTRAINT "WorkspaceExternalResourceAttachment_workspaceId_fkey"
FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "WorkspaceExternalResourceAttachment"
ADD CONSTRAINT "WorkspaceExternalResourceAttachment_resourceId_fkey"
FOREIGN KEY ("resourceId") REFERENCES "WorkspaceExternalResource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "WorkspaceExternalResourceAttachment"
ADD CONSTRAINT "WorkspaceExternalResourceAttachment_createdByUserId_fkey"
FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
