-- CreateEnum
CREATE TYPE "AiWorkspaceProvider" AS ENUM ('OPENWORK', 'CHATGPT', 'CLAUDE', 'GEMINI', 'CURSOR', 'CLAUDE_CODE', 'GENERIC_MCP');

-- CreateEnum
CREATE TYPE "AiWorkspaceOwnershipMode" AS ENUM ('USER_MANAGED', 'WORKSPACE_MANAGED', 'CORGTEX_MANAGED');

-- CreateEnum
CREATE TYPE "AiWorkspaceHealthStatus" AS ENUM ('CONNECTED', 'NEEDS_SETUP', 'UNHEALTHY', 'DISCONNECTED', 'REVOKED', 'MANAGED_EXTERNALLY');

-- CreateEnum
CREATE TYPE "EnterpriseServiceKey" AS ENUM ('MEETING_RECORDER', 'AI_WORKSPACE', 'INTEGRATIONS', 'WORKERS', 'SUPPORT');

-- CreateEnum
CREATE TYPE "EnterpriseServiceOwnershipMode" AS ENUM ('CUSTOMER_MANAGED', 'CORGTEX_MANAGED');

-- CreateEnum
CREATE TYPE "EnterpriseServiceHealthStatus" AS ENUM ('ACTIVE', 'NEEDS_SETUP', 'UNHEALTHY', 'DISCONNECTED', 'SUSPENDED', 'MANAGED_EXTERNALLY');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "CatalogSourceType" ADD VALUE 'AI_WORKSPACE';
ALTER TYPE "CatalogSourceType" ADD VALUE 'ENTERPRISE_SERVICE';

-- CreateTable
CREATE TABLE "AiWorkspaceConnection" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "createdByUserId" TEXT,
    "ownerUserId" TEXT,
    "catalogItemId" TEXT,
    "provider" "AiWorkspaceProvider" NOT NULL,
    "ownershipMode" "AiWorkspaceOwnershipMode" NOT NULL DEFAULT 'USER_MANAGED',
    "displayName" TEXT NOT NULL,
    "serverUrl" TEXT,
    "accessTokenEnc" TEXT,
    "refreshTokenEnc" TEXT,
    "apiKeyEnc" TEXT,
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "capabilities" JSONB,
    "setupState" JSONB,
    "healthStatus" "AiWorkspaceHealthStatus" NOT NULL DEFAULT 'NEEDS_SETUP',
    "lastHealthCheckAt" TIMESTAMP(3),
    "lastSuccessfulHealthCheckAt" TIMESTAMP(3),
    "lastError" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiWorkspaceConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkspaceEnterpriseService" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "catalogItemId" TEXT,
    "serviceKey" "EnterpriseServiceKey" NOT NULL,
    "ownershipMode" "EnterpriseServiceOwnershipMode" NOT NULL DEFAULT 'CUSTOMER_MANAGED',
    "displayName" TEXT NOT NULL,
    "providerKey" TEXT,
    "healthStatus" "EnterpriseServiceHealthStatus" NOT NULL DEFAULT 'NEEDS_SETUP',
    "lastHealthCheckAt" TIMESTAMP(3),
    "lastSuccessfulHealthCheckAt" TIMESTAMP(3),
    "lastSuccessfulSyncAt" TIMESTAMP(3),
    "lastError" TEXT,
    "usageJson" JSONB,
    "supportEscalationStatus" TEXT,
    "supportEscalatedAt" TIMESTAMP(3),
    "supportNotesMd" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkspaceEnterpriseService_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiWorkspaceConnection_workspaceId_provider_healthStatus_idx" ON "AiWorkspaceConnection"("workspaceId", "provider", "healthStatus");

-- CreateIndex
CREATE INDEX "AiWorkspaceConnection_workspaceId_ownershipMode_idx" ON "AiWorkspaceConnection"("workspaceId", "ownershipMode");

-- CreateIndex
CREATE INDEX "AiWorkspaceConnection_workspaceId_isDefault_idx" ON "AiWorkspaceConnection"("workspaceId", "isDefault");

-- CreateIndex
CREATE INDEX "AiWorkspaceConnection_ownerUserId_provider_idx" ON "AiWorkspaceConnection"("ownerUserId", "provider");

-- CreateIndex
CREATE INDEX "AiWorkspaceConnection_catalogItemId_idx" ON "AiWorkspaceConnection"("catalogItemId");

-- CreateIndex
CREATE INDEX "WorkspaceEnterpriseService_workspaceId_ownershipMode_health_idx" ON "WorkspaceEnterpriseService"("workspaceId", "ownershipMode", "healthStatus");

-- CreateIndex
CREATE INDEX "WorkspaceEnterpriseService_catalogItemId_idx" ON "WorkspaceEnterpriseService"("catalogItemId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceEnterpriseService_workspaceId_serviceKey_key" ON "WorkspaceEnterpriseService"("workspaceId", "serviceKey");

-- AddForeignKey
ALTER TABLE "AiWorkspaceConnection" ADD CONSTRAINT "AiWorkspaceConnection_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiWorkspaceConnection" ADD CONSTRAINT "AiWorkspaceConnection_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiWorkspaceConnection" ADD CONSTRAINT "AiWorkspaceConnection_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiWorkspaceConnection" ADD CONSTRAINT "AiWorkspaceConnection_catalogItemId_fkey" FOREIGN KEY ("catalogItemId") REFERENCES "CatalogItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceEnterpriseService" ADD CONSTRAINT "WorkspaceEnterpriseService_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceEnterpriseService" ADD CONSTRAINT "WorkspaceEnterpriseService_catalogItemId_fkey" FOREIGN KEY ("catalogItemId") REFERENCES "CatalogItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;
