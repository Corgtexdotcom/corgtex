-- CreateEnum
CREATE TYPE "CatalogItemType" AS ENUM ('APP', 'AGENT', 'TOOL', 'AUTOMATION', 'CONNECTOR', 'DATA_SOURCE');

-- CreateEnum
CREATE TYPE "CatalogSourceType" AS ENUM ('TOOL_LINK', 'AGENT_CONFIG', 'AGENT_IDENTITY', 'BUILD_ARTIFACT', 'COMMUNICATION_INSTALLATION', 'OAUTH_CONNECTION', 'MCP_CONNECTOR', 'MEETING_RECORDER', 'DATA_SOURCE', 'MANUAL');

-- CreateEnum
CREATE TYPE "CatalogItemStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'REQUEST_ONLY', 'DISABLED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "CatalogAccessMode" AS ENUM ('OPEN', 'REQUEST', 'ADMIN_ONLY', 'DISABLED');

-- CreateEnum
CREATE TYPE "CatalogRequestType" AS ENUM ('ACCESS', 'API_KEY', 'BUDGET_INCREASE', 'PUBLISH');

-- CreateEnum
CREATE TYPE "CatalogRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CatalogApprovalMode" AS ENUM ('ADMIN', 'AGENT_ASSISTED');

-- AlterTable
ALTER TABLE "AgentCredential"
ADD COLUMN "catalogItemId" TEXT,
ADD COLUMN "reasonMd" TEXT,
ADD COLUMN "monthlyBudgetCents" INTEGER,
ADD COLUMN "dailyCallLimit" INTEGER;

-- AlterTable
ALTER TABLE "ModelUsage"
ADD COLUMN "catalogItemId" TEXT;

-- CreateTable
CREATE TABLE "CatalogItem" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "createdByUserId" TEXT,
    "ownerUserId" TEXT,
    "type" "CatalogItemType" NOT NULL,
    "sourceType" "CatalogSourceType" NOT NULL DEFAULT 'MANUAL',
    "sourceId" TEXT,
    "title" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "outcome" TEXT,
    "descriptionMd" TEXT,
    "accessNotesMd" TEXT,
    "url" TEXT,
    "category" TEXT NOT NULL DEFAULT 'OTHER',
    "status" "CatalogItemStatus" NOT NULL DEFAULT 'PUBLISHED',
    "accessMode" "CatalogAccessMode" NOT NULL DEFAULT 'OPEN',
    "requestedScopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "monthlyBudgetCents" INTEGER,
    "dailyCallLimit" INTEGER,
    "featured" BOOLEAN NOT NULL DEFAULT false,
    "archivedAt" TIMESTAMP(3),
    "archivedByUserId" TEXT,
    "archiveReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CatalogItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CatalogFavorite" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "catalogItemId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CatalogFavorite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CatalogRequest" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "catalogItemId" TEXT,
    "requesterUserId" TEXT NOT NULL,
    "decidedByUserId" TEXT,
    "type" "CatalogRequestType" NOT NULL,
    "status" "CatalogRequestStatus" NOT NULL DEFAULT 'PENDING',
    "reasonMd" TEXT NOT NULL,
    "requestedScopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "requestedBudgetCents" INTEGER,
    "requestedDailyCallLimit" INTEGER,
    "title" TEXT,
    "payloadJson" JSONB,
    "decisionNoteMd" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CatalogRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CatalogSettings" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "approvalMode" "CatalogApprovalMode" NOT NULL DEFAULT 'ADMIN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CatalogSettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CatalogItem_workspaceId_slug_key" ON "CatalogItem"("workspaceId", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "CatalogItem_workspaceId_sourceType_sourceId_key" ON "CatalogItem"("workspaceId", "sourceType", "sourceId");

-- CreateIndex
CREATE INDEX "CatalogItem_workspaceId_type_status_idx" ON "CatalogItem"("workspaceId", "type", "status");

-- CreateIndex
CREATE INDEX "CatalogItem_workspaceId_ownerUserId_idx" ON "CatalogItem"("workspaceId", "ownerUserId");

-- CreateIndex
CREATE INDEX "CatalogItem_workspaceId_archivedAt_idx" ON "CatalogItem"("workspaceId", "archivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "CatalogFavorite_catalogItemId_userId_key" ON "CatalogFavorite"("catalogItemId", "userId");

-- CreateIndex
CREATE INDEX "CatalogFavorite_workspaceId_userId_idx" ON "CatalogFavorite"("workspaceId", "userId");

-- CreateIndex
CREATE INDEX "CatalogRequest_workspaceId_status_createdAt_idx" ON "CatalogRequest"("workspaceId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "CatalogRequest_workspaceId_requesterUserId_idx" ON "CatalogRequest"("workspaceId", "requesterUserId");

-- CreateIndex
CREATE INDEX "CatalogRequest_catalogItemId_status_idx" ON "CatalogRequest"("catalogItemId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "CatalogSettings_workspaceId_key" ON "CatalogSettings"("workspaceId");

-- CreateIndex
CREATE INDEX "AgentCredential_workspaceId_catalogItemId_idx" ON "AgentCredential"("workspaceId", "catalogItemId");

-- CreateIndex
CREATE INDEX "ModelUsage_workspaceId_catalogItemId_createdAt_idx" ON "ModelUsage"("workspaceId", "catalogItemId", "createdAt");

-- AddForeignKey
ALTER TABLE "AgentCredential" ADD CONSTRAINT "AgentCredential_catalogItemId_fkey" FOREIGN KEY ("catalogItemId") REFERENCES "CatalogItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModelUsage" ADD CONSTRAINT "ModelUsage_catalogItemId_fkey" FOREIGN KEY ("catalogItemId") REFERENCES "CatalogItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CatalogItem" ADD CONSTRAINT "CatalogItem_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CatalogItem" ADD CONSTRAINT "CatalogItem_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CatalogItem" ADD CONSTRAINT "CatalogItem_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CatalogFavorite" ADD CONSTRAINT "CatalogFavorite_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CatalogFavorite" ADD CONSTRAINT "CatalogFavorite_catalogItemId_fkey" FOREIGN KEY ("catalogItemId") REFERENCES "CatalogItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CatalogFavorite" ADD CONSTRAINT "CatalogFavorite_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CatalogRequest" ADD CONSTRAINT "CatalogRequest_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CatalogRequest" ADD CONSTRAINT "CatalogRequest_catalogItemId_fkey" FOREIGN KEY ("catalogItemId") REFERENCES "CatalogItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CatalogRequest" ADD CONSTRAINT "CatalogRequest_requesterUserId_fkey" FOREIGN KEY ("requesterUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CatalogRequest" ADD CONSTRAINT "CatalogRequest_decidedByUserId_fkey" FOREIGN KEY ("decidedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CatalogSettings" ADD CONSTRAINT "CatalogSettings_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
