-- CreateEnum
CREATE TYPE "CustomerAccountStatus" AS ENUM ('PROSPECT', 'TRIAL', 'ONBOARDING', 'ACTIVE', 'SUSPENDED', 'CHURNED', 'INTERNAL', 'DEMO');

-- CreateEnum
CREATE TYPE "CustomerManagementAuthority" AS ENUM ('CORGTEX', 'CUSTOMER_CONTROL_PLANE', 'SELF_MANAGED');

-- CreateEnum
CREATE TYPE "CustomerDeploymentKind" AS ENUM ('SHARED_WORKSPACE', 'HOSTED_DEDICATED', 'REMOTE_MANAGED', 'SELF_HOSTED', 'CUSTOMER_CONTROL_PLANE', 'INTERNAL', 'DEMO');

-- CreateEnum
CREATE TYPE "CustomerDeploymentStatus" AS ENUM ('DRAFT', 'PROVISIONING', 'BOOTSTRAPPING', 'ACTIVE', 'DEGRADED', 'SUSPENDED', 'RETIRED');

-- CreateEnum
CREATE TYPE "FleetSnapshotKind" AS ENUM ('HEALTH', 'RELEASE', 'CONNECTOR', 'CONTEXT', 'INTEGRATION', 'SUPPORT_READY');

-- CreateTable
CREATE TABLE "CustomerAccount" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "status" "CustomerAccountStatus" NOT NULL DEFAULT 'PROSPECT',
    "managementAuthority" "CustomerManagementAuthority" NOT NULL DEFAULT 'CORGTEX',
    "supportOwnerEmail" TEXT,
    "notes" TEXT,
    "primaryDeploymentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerAccount_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "InstanceRegistry"
ADD COLUMN "customerAccountId" TEXT,
ADD COLUMN "deploymentKind" "CustomerDeploymentKind" NOT NULL DEFAULT 'REMOTE_MANAGED',
ADD COLUMN "deploymentStatus" "CustomerDeploymentStatus" NOT NULL DEFAULT 'DRAFT',
ADD COLUMN "remoteWorkspaceSlug" TEXT,
ADD COLUMN "remoteWorkspaceId" TEXT;

-- CreateTable
CREATE TABLE "FleetHealthSnapshot" (
    "id" TEXT NOT NULL,
    "customerAccountId" TEXT NOT NULL,
    "deploymentId" TEXT,
    "snapshotKind" "FleetSnapshotKind" NOT NULL,
    "status" TEXT NOT NULL,
    "summary" JSONB,
    "error" TEXT,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FleetHealthSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CustomerAccount_slug_key" ON "CustomerAccount"("slug");

-- Backfill one canonical customer account per existing registry row.
WITH source AS (
    SELECT
        "id" AS "instanceId",
        COALESCE("customerSlug", CONCAT('instance-', REPLACE(LEFT("id", 8), '-', ''))) AS "slug",
        "label" AS "displayName",
        CASE
            WHEN "environment" = 'internal' THEN 'INTERNAL'
            WHEN "environment" = 'demo' THEN 'DEMO'
            WHEN "provisioningStatus" = 'active' THEN 'ACTIVE'
            WHEN "provisioningStatus" = 'suspended' THEN 'SUSPENDED'
            ELSE 'ONBOARDING'
        END AS "accountStatus",
        "supportOwnerEmail",
        "createdAt",
        "updatedAt"
    FROM "InstanceRegistry"
),
upserted_accounts AS (
    INSERT INTO "CustomerAccount" (
        "id",
        "slug",
        "displayName",
        "status",
        "managementAuthority",
        "supportOwnerEmail",
        "createdAt",
        "updatedAt"
    )
    SELECT
        LOWER(CONCAT(
            SUBSTR(MD5(CONCAT("slug", ':customer-account')), 1, 8), '-',
            SUBSTR(MD5(CONCAT("slug", ':customer-account')), 9, 4), '-',
            SUBSTR(MD5(CONCAT("slug", ':customer-account')), 13, 4), '-',
            SUBSTR(MD5(CONCAT("slug", ':customer-account')), 17, 4), '-',
            SUBSTR(MD5(CONCAT("slug", ':customer-account')), 21, 12)
        )),
        "slug",
        "displayName",
        "accountStatus"::"CustomerAccountStatus",
        'CORGTEX'::"CustomerManagementAuthority",
        "supportOwnerEmail",
        "createdAt",
        "updatedAt"
    FROM source
    ON CONFLICT ("slug") DO UPDATE SET
        "displayName" = EXCLUDED."displayName",
        "supportOwnerEmail" = COALESCE(EXCLUDED."supportOwnerEmail", "CustomerAccount"."supportOwnerEmail"),
        "updatedAt" = CURRENT_TIMESTAMP
    RETURNING "id", "slug"
)
UPDATE "InstanceRegistry" AS registry
SET
    "customerAccountId" = account."id",
    "customerSlug" = COALESCE(registry."customerSlug", account."slug"),
    "deploymentKind" = CASE
        WHEN registry."environment" = 'internal' THEN 'INTERNAL'
        WHEN registry."environment" = 'demo' THEN 'DEMO'
        WHEN registry."railwayProjectId" IS NOT NULL THEN 'HOSTED_DEDICATED'
        WHEN registry."managedWorkspaceId" IS NOT NULL THEN 'SHARED_WORKSPACE'
        ELSE 'REMOTE_MANAGED'
    END::"CustomerDeploymentKind",
    "deploymentStatus" = CASE
        WHEN registry."provisioningStatus" = 'active' THEN 'ACTIVE'
        WHEN registry."provisioningStatus" IN ('awaiting_dns', 'bootstrapping') THEN 'BOOTSTRAPPING'
        WHEN registry."provisioningStatus" = 'provisioning' THEN 'PROVISIONING'
        WHEN registry."provisioningStatus" = 'degraded' THEN 'DEGRADED'
        WHEN registry."provisioningStatus" = 'suspended' THEN 'SUSPENDED'
        ELSE 'DRAFT'
    END::"CustomerDeploymentStatus"
FROM upserted_accounts AS account
WHERE account."slug" = COALESCE(registry."customerSlug", CONCAT('instance-', REPLACE(LEFT(registry."id", 8), '-', '')));

WITH ranked_deployments AS (
    SELECT
        "customerAccountId",
        "id",
        ROW_NUMBER() OVER (
            PARTITION BY "customerAccountId"
            ORDER BY
                CASE "deploymentStatus"
                    WHEN 'ACTIVE' THEN 0
                    WHEN 'BOOTSTRAPPING' THEN 1
                    WHEN 'PROVISIONING' THEN 2
                    WHEN 'DEGRADED' THEN 3
                    WHEN 'DRAFT' THEN 4
                    WHEN 'SUSPENDED' THEN 5
                    ELSE 6
                END,
                "createdAt" DESC
        ) AS deployment_rank
    FROM "InstanceRegistry"
    WHERE "customerAccountId" IS NOT NULL
)
UPDATE "CustomerAccount" AS account
SET "primaryDeploymentId" = ranked."id"
FROM ranked_deployments AS ranked
WHERE ranked."customerAccountId" = account."id"
  AND ranked.deployment_rank = 1
  AND account."primaryDeploymentId" IS NULL;

-- CreateIndex
CREATE UNIQUE INDEX "CustomerAccount_primaryDeploymentId_key" ON "CustomerAccount"("primaryDeploymentId");

-- CreateIndex
CREATE INDEX "CustomerAccount_status_idx" ON "CustomerAccount"("status");

-- CreateIndex
CREATE INDEX "CustomerAccount_managementAuthority_idx" ON "CustomerAccount"("managementAuthority");

-- CreateIndex
CREATE INDEX "CustomerAccount_supportOwnerEmail_idx" ON "CustomerAccount"("supportOwnerEmail");

-- CreateIndex
CREATE INDEX "InstanceRegistry_customerAccountId_idx" ON "InstanceRegistry"("customerAccountId");

-- CreateIndex
CREATE INDEX "InstanceRegistry_deploymentKind_idx" ON "InstanceRegistry"("deploymentKind");

-- CreateIndex
CREATE INDEX "InstanceRegistry_deploymentStatus_idx" ON "InstanceRegistry"("deploymentStatus");

-- CreateIndex
CREATE INDEX "InstanceRegistry_lastHealthStatus_idx" ON "InstanceRegistry"("lastHealthStatus");

-- CreateIndex
CREATE INDEX "FleetHealthSnapshot_customerAccountId_snapshotKind_createdAt_idx" ON "FleetHealthSnapshot"("customerAccountId", "snapshotKind", "createdAt");

-- CreateIndex
CREATE INDEX "FleetHealthSnapshot_deploymentId_snapshotKind_createdAt_idx" ON "FleetHealthSnapshot"("deploymentId", "snapshotKind", "createdAt");

-- CreateIndex
CREATE INDEX "FleetHealthSnapshot_snapshotKind_createdAt_idx" ON "FleetHealthSnapshot"("snapshotKind", "createdAt");

-- CreateIndex
CREATE INDEX "FleetHealthSnapshot_status_createdAt_idx" ON "FleetHealthSnapshot"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "CustomerAccount" ADD CONSTRAINT "CustomerAccount_primaryDeploymentId_fkey" FOREIGN KEY ("primaryDeploymentId") REFERENCES "InstanceRegistry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InstanceRegistry" ADD CONSTRAINT "InstanceRegistry_customerAccountId_fkey" FOREIGN KEY ("customerAccountId") REFERENCES "CustomerAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FleetHealthSnapshot" ADD CONSTRAINT "FleetHealthSnapshot_customerAccountId_fkey" FOREIGN KEY ("customerAccountId") REFERENCES "CustomerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FleetHealthSnapshot" ADD CONSTRAINT "FleetHealthSnapshot_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "InstanceRegistry"("id") ON DELETE SET NULL ON UPDATE CASCADE;
