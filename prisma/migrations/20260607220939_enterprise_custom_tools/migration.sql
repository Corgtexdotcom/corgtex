-- CreateEnum
CREATE TYPE "AppDefinitionStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "AppRuntimeMode" AS ENUM ('SHARED_MULTI_TENANT', 'ISOLATED_SINGLE_TENANT', 'SELF_MANAGED_EXTERNAL');

-- CreateEnum
CREATE TYPE "AppRuntimeStatus" AS ENUM ('PROVISIONING', 'ACTIVE', 'UNHEALTHY', 'DISABLED');

-- CreateEnum
CREATE TYPE "AppReleaseStatus" AS ENUM ('PREPARED', 'ACTIVE', 'ROLLED_BACK', 'FAILED');

-- CreateEnum
CREATE TYPE "AppSurface" AS ENUM ('FINANCE');

-- CreateTable
CREATE TABLE "AppDefinition" (
    "id" TEXT NOT NULL,
    "appKey" VARCHAR(96) NOT NULL,
    "title" TEXT NOT NULL,
    "descriptionMd" TEXT,
    "repositoryUrl" TEXT,
    "manifestUrl" TEXT,
    "category" "AppCategory" NOT NULL DEFAULT 'OTHER',
    "visibility" "AppVisibility" NOT NULL DEFAULT 'CORGTEX_MANAGED',
    "defaultHostingMode" "AppHostingMode" NOT NULL DEFAULT 'CORGTEX_MANAGED_EXTERNAL',
    "defaultIntegrationDepth" "AppIntegrationDepth" NOT NULL DEFAULT 'LAUNCHABLE',
    "dataClassification" VARCHAR(64) NOT NULL DEFAULT 'INTERNAL',
    "supportedSurfaces" "AppSurface"[] DEFAULT ARRAY[]::"AppSurface"[],
    "requestedScopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "manifestJson" JSONB,
    "capabilitiesJson" JSONB,
    "status" "AppDefinitionStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppRuntime" (
    "id" TEXT NOT NULL,
    "appDefinitionId" TEXT NOT NULL,
    "customerDeploymentId" TEXT,
    "mode" "AppRuntimeMode" NOT NULL,
    "status" "AppRuntimeStatus" NOT NULL DEFAULT 'PROVISIONING',
    "environment" VARCHAR(64) NOT NULL DEFAULT 'production',
    "baseUrl" TEXT,
    "healthUrl" TEXT,
    "mcpUrl" TEXT,
    "railwayProjectId" TEXT,
    "railwayEnvironmentId" TEXT,
    "railwayServiceId" TEXT,
    "secretsRef" TEXT,
    "lastHealthAt" TIMESTAMP(3),
    "lastHealthStatus" TEXT,
    "lastHealthError" TEXT,
    "metadataJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppRuntime_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppRelease" (
    "id" TEXT NOT NULL,
    "appDefinitionId" TEXT NOT NULL,
    "runtimeId" TEXT,
    "version" VARCHAR(128) NOT NULL,
    "gitSha" TEXT,
    "imageTag" TEXT,
    "manifestVersion" TEXT,
    "status" "AppReleaseStatus" NOT NULL DEFAULT 'PREPARED',
    "healthStatus" TEXT,
    "releasedAt" TIMESTAMP(3),
    "metadataJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppRelease_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppInstallation" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "appDefinitionId" TEXT NOT NULL,
    "catalogItemId" TEXT,
    "runtimeId" TEXT,
    "releaseId" TEXT,
    "status" "AppInstallationStatus" NOT NULL DEFAULT 'NEEDS_SETUP',
    "tenantExternalId" TEXT,
    "tenantMappingJson" JSONB,
    "installedByUserId" TEXT,
    "installedAt" TIMESTAMP(3),
    "requestedScopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "grantedScopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "launchPath" TEXT,
    "sessionTtlSeconds" INTEGER NOT NULL DEFAULT 300,
    "configJson" JSONB,
    "lastHealthAt" TIMESTAMP(3),
    "lastHealthStatus" TEXT,
    "lastHealthError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppInstallation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppSurfaceAssignment" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "surface" "AppSurface" NOT NULL,
    "appInstallationId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "assignedByUserId" TEXT,
    "reasonMd" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppSurfaceAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppSession" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "appInstallationId" TEXT NOT NULL,
    "actorUserId" TEXT,
    "audience" VARCHAR(96) NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "payloadJson" JSONB,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),

    CONSTRAINT "AppSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AppDefinition_appKey_key" ON "AppDefinition"("appKey");

-- CreateIndex
CREATE INDEX "AppDefinition_category_status_idx" ON "AppDefinition"("category", "status");

-- CreateIndex
CREATE INDEX "AppDefinition_visibility_status_idx" ON "AppDefinition"("visibility", "status");

-- CreateIndex
CREATE INDEX "AppRuntime_appDefinitionId_mode_status_idx" ON "AppRuntime"("appDefinitionId", "mode", "status");

-- CreateIndex
CREATE INDEX "AppRuntime_customerDeploymentId_status_idx" ON "AppRuntime"("customerDeploymentId", "status");

-- CreateIndex
CREATE INDEX "AppRelease_runtimeId_status_idx" ON "AppRelease"("runtimeId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "AppRelease_appDefinitionId_version_key" ON "AppRelease"("appDefinitionId", "version");

-- CreateIndex
CREATE INDEX "AppInstallation_workspaceId_status_idx" ON "AppInstallation"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "AppInstallation_appDefinitionId_status_idx" ON "AppInstallation"("appDefinitionId", "status");

-- CreateIndex
CREATE INDEX "AppInstallation_runtimeId_status_idx" ON "AppInstallation"("runtimeId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "AppInstallation_workspaceId_appDefinitionId_key" ON "AppInstallation"("workspaceId", "appDefinitionId");

-- CreateIndex
CREATE INDEX "AppSurfaceAssignment_appInstallationId_enabled_idx" ON "AppSurfaceAssignment"("appInstallationId", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "AppSurfaceAssignment_workspaceId_surface_key" ON "AppSurfaceAssignment"("workspaceId", "surface");

-- CreateIndex
CREATE UNIQUE INDEX "AppSession_tokenHash_key" ON "AppSession"("tokenHash");

-- CreateIndex
CREATE INDEX "AppSession_workspaceId_appInstallationId_createdAt_idx" ON "AppSession"("workspaceId", "appInstallationId", "createdAt");

-- CreateIndex
CREATE INDEX "AppSession_audience_expiresAt_idx" ON "AppSession"("audience", "expiresAt");

-- CreateIndex
CREATE INDEX "AppSession_expiresAt_idx" ON "AppSession"("expiresAt");

-- AddForeignKey
ALTER TABLE "AppRuntime" ADD CONSTRAINT "AppRuntime_appDefinitionId_fkey" FOREIGN KEY ("appDefinitionId") REFERENCES "AppDefinition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppRuntime" ADD CONSTRAINT "AppRuntime_customerDeploymentId_fkey" FOREIGN KEY ("customerDeploymentId") REFERENCES "CustomerDeployment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppRelease" ADD CONSTRAINT "AppRelease_appDefinitionId_fkey" FOREIGN KEY ("appDefinitionId") REFERENCES "AppDefinition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppRelease" ADD CONSTRAINT "AppRelease_runtimeId_fkey" FOREIGN KEY ("runtimeId") REFERENCES "AppRuntime"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppInstallation" ADD CONSTRAINT "AppInstallation_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppInstallation" ADD CONSTRAINT "AppInstallation_appDefinitionId_fkey" FOREIGN KEY ("appDefinitionId") REFERENCES "AppDefinition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppInstallation" ADD CONSTRAINT "AppInstallation_catalogItemId_fkey" FOREIGN KEY ("catalogItemId") REFERENCES "CatalogItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppInstallation" ADD CONSTRAINT "AppInstallation_runtimeId_fkey" FOREIGN KEY ("runtimeId") REFERENCES "AppRuntime"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppInstallation" ADD CONSTRAINT "AppInstallation_releaseId_fkey" FOREIGN KEY ("releaseId") REFERENCES "AppRelease"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppSurfaceAssignment" ADD CONSTRAINT "AppSurfaceAssignment_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppSurfaceAssignment" ADD CONSTRAINT "AppSurfaceAssignment_appInstallationId_fkey" FOREIGN KEY ("appInstallationId") REFERENCES "AppInstallation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppSession" ADD CONSTRAINT "AppSession_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppSession" ADD CONSTRAINT "AppSession_appInstallationId_fkey" FOREIGN KEY ("appInstallationId") REFERENCES "AppInstallation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
