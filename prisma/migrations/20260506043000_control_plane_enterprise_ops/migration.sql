-- CreateEnum
CREATE TYPE "CustomerEntitlementStatus" AS ENUM ('DRAFT', 'ENABLED', 'DISABLED', 'DEGRADED', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "CustomerReleaseTargetStatus" AS ENUM ('PREPARED', 'PROBING', 'APPLYING', 'APPLIED', 'FAILED', 'ROLLBACK_READY', 'ROLLED_BACK');

-- CreateTable
CREATE TABLE "CustomerEntitlement" (
    "id" TEXT NOT NULL,
    "customerAccountId" TEXT NOT NULL,
    "deploymentId" TEXT,
    "scopeKey" TEXT NOT NULL,
    "entitlementKey" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "status" "CustomerEntitlementStatus" NOT NULL DEFAULT 'DRAFT',
    "intent" JSONB,
    "evidence" JSONB,
    "source" TEXT NOT NULL DEFAULT 'control_plane',
    "configuredByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerEntitlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerReleaseTarget" (
    "id" TEXT NOT NULL,
    "customerAccountId" TEXT NOT NULL,
    "deploymentId" TEXT NOT NULL,
    "targetReleaseImageTag" TEXT NOT NULL,
    "targetReleaseVersion" TEXT,
    "status" "CustomerReleaseTargetStatus" NOT NULL DEFAULT 'PREPARED',
    "evidence" JSONB,
    "preparedByUserId" TEXT,
    "preparedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "appliedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerReleaseTarget_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CustomerEntitlement_account_scope_entitlement_key" ON "CustomerEntitlement"("customerAccountId", "scopeKey", "entitlementKey");

-- CreateIndex
CREATE INDEX "CustomerEntitlement_customerAccountId_status_idx" ON "CustomerEntitlement"("customerAccountId", "status");

-- CreateIndex
CREATE INDEX "CustomerEntitlement_deploymentId_entitlementKey_idx" ON "CustomerEntitlement"("deploymentId", "entitlementKey");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerReleaseTarget_deploymentId_targetReleaseImageTag_key" ON "CustomerReleaseTarget"("deploymentId", "targetReleaseImageTag");

-- CreateIndex
CREATE INDEX "CustomerReleaseTarget_customerAccountId_status_idx" ON "CustomerReleaseTarget"("customerAccountId", "status");

-- CreateIndex
CREATE INDEX "CustomerReleaseTarget_deploymentId_status_createdAt_idx" ON "CustomerReleaseTarget"("deploymentId", "status", "createdAt");

-- AddForeignKey
ALTER TABLE "CustomerEntitlement" ADD CONSTRAINT "CustomerEntitlement_customerAccountId_fkey" FOREIGN KEY ("customerAccountId") REFERENCES "CustomerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerEntitlement" ADD CONSTRAINT "CustomerEntitlement_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "InstanceRegistry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerReleaseTarget" ADD CONSTRAINT "CustomerReleaseTarget_customerAccountId_fkey" FOREIGN KEY ("customerAccountId") REFERENCES "CustomerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerReleaseTarget" ADD CONSTRAINT "CustomerReleaseTarget_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "InstanceRegistry"("id") ON DELETE CASCADE ON UPDATE CASCADE;
