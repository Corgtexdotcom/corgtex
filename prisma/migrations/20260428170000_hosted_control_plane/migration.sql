-- Extend the existing operator instance registry into a hosted-customer
-- control-plane registry. The registry stores operational metadata only;
-- raw customer seed data and provider credentials remain outside the DB.
ALTER TABLE "InstanceRegistry"
ADD COLUMN "customerSlug" TEXT,
ADD COLUMN "region" TEXT,
ADD COLUMN "dataResidency" TEXT,
ADD COLUMN "customDomain" TEXT,
ADD COLUMN "supportOwnerEmail" TEXT,
ADD COLUMN "provisioningStatus" TEXT NOT NULL DEFAULT 'draft',
ADD COLUMN "bootstrapStatus" TEXT NOT NULL DEFAULT 'not_started',
ADD COLUMN "releaseVersion" TEXT,
ADD COLUMN "releaseImageTag" TEXT,
ADD COLUMN "railwayProjectId" TEXT,
ADD COLUMN "railwayEnvironmentId" TEXT,
ADD COLUMN "railwayWebServiceId" TEXT,
ADD COLUMN "railwayWorkerServiceId" TEXT,
ADD COLUMN "railwayPostgresServiceId" TEXT,
ADD COLUMN "railwayRedisServiceId" TEXT,
ADD COLUMN "storageBucketName" TEXT,
ADD COLUMN "bootstrapBundleUri" TEXT,
ADD COLUMN "bootstrapBundleChecksum" TEXT,
ADD COLUMN "bootstrapBundleSchemaVersion" TEXT,
ADD COLUMN "lastProvisioningError" TEXT,
ADD COLUMN "lastWorkerHealthCheck" TIMESTAMP(3),
ADD COLUMN "lastWorkerHealthStatus" TEXT,
ADD COLUMN "lastReleaseCheck" TIMESTAMP(3);

CREATE UNIQUE INDEX "InstanceRegistry_customerSlug_key" ON "InstanceRegistry"("customerSlug");
CREATE INDEX "InstanceRegistry_provisioningStatus_idx" ON "InstanceRegistry"("provisioningStatus");
CREATE INDEX "InstanceRegistry_bootstrapStatus_idx" ON "InstanceRegistry"("bootstrapStatus");
CREATE INDEX "InstanceRegistry_region_idx" ON "InstanceRegistry"("region");

CREATE TABLE "HostedInstanceEvent" (
  "id" TEXT NOT NULL,
  "instanceId" TEXT,
  "actorUserId" TEXT,
  "action" TEXT NOT NULL,
  "meta" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "HostedInstanceEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "HostedInstanceEvent_instanceId_createdAt_idx" ON "HostedInstanceEvent"("instanceId", "createdAt");
CREATE INDEX "HostedInstanceEvent_action_createdAt_idx" ON "HostedInstanceEvent"("action", "createdAt");

ALTER TABLE "HostedInstanceEvent"
ADD CONSTRAINT "HostedInstanceEvent_instanceId_fkey"
FOREIGN KEY ("instanceId") REFERENCES "InstanceRegistry"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "InstanceBootstrapRun" (
  "id" TEXT NOT NULL,
  "customerSlug" TEXT NOT NULL,
  "bundleUri" TEXT NOT NULL,
  "bundleChecksum" TEXT NOT NULL,
  "schemaVersion" TEXT NOT NULL,
  "requestedBy" TEXT,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "error" TEXT,
  "appliedAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "InstanceBootstrapRun_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "InstanceBootstrapRun_customerSlug_bundleChecksum_key" ON "InstanceBootstrapRun"("customerSlug", "bundleChecksum");
CREATE INDEX "InstanceBootstrapRun_customerSlug_status_idx" ON "InstanceBootstrapRun"("customerSlug", "status");
