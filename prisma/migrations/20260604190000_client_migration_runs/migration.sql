-- Replace the legacy one-deployment-per-customer-slug constraint with a lookup index
-- so shared and hosted lanes can coexist under one CustomerAccount.
DROP INDEX IF EXISTS "CustomerDeployment_customerSlug_key";
CREATE INDEX "CustomerDeployment_customerSlug_idx" ON "CustomerDeployment"("customerSlug");

-- CreateTable
CREATE TABLE "ClientMigrationRun" (
    "id" TEXT NOT NULL,
    "customerAccountId" TEXT NOT NULL,
    "sourceDeploymentId" TEXT NOT NULL,
    "destinationDeploymentId" TEXT,
    "direction" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'planned',
    "actorUserId" TEXT,
    "actorLabel" TEXT,
    "reason" TEXT NOT NULL,
    "planSummary" JSONB,
    "verificationSummary" JSONB,
    "error" TEXT,
    "dryRunAt" TIMESTAMP(3),
    "executedAt" TIMESTAMP(3),
    "finalizedAt" TIMESTAMP(3),
    "rolledBackAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClientMigrationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClientMigrationIdMap" (
    "id" TEXT NOT NULL,
    "migrationRunId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "destinationId" TEXT,
    "checksum" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClientMigrationIdMap_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ClientMigrationRun_customerAccountId_status_createdAt_idx" ON "ClientMigrationRun"("customerAccountId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "ClientMigrationRun_sourceDeploymentId_createdAt_idx" ON "ClientMigrationRun"("sourceDeploymentId", "createdAt");

-- CreateIndex
CREATE INDEX "ClientMigrationRun_destinationDeploymentId_createdAt_idx" ON "ClientMigrationRun"("destinationDeploymentId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ClientMigrationIdMap_migrationRunId_entityType_sourceId_key" ON "ClientMigrationIdMap"("migrationRunId", "entityType", "sourceId");

-- CreateIndex
CREATE INDEX "ClientMigrationIdMap_destinationId_idx" ON "ClientMigrationIdMap"("destinationId");

-- AddForeignKey
ALTER TABLE "ClientMigrationRun" ADD CONSTRAINT "ClientMigrationRun_customerAccountId_fkey" FOREIGN KEY ("customerAccountId") REFERENCES "CustomerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientMigrationRun" ADD CONSTRAINT "ClientMigrationRun_sourceDeploymentId_fkey" FOREIGN KEY ("sourceDeploymentId") REFERENCES "CustomerDeployment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientMigrationRun" ADD CONSTRAINT "ClientMigrationRun_destinationDeploymentId_fkey" FOREIGN KEY ("destinationDeploymentId") REFERENCES "CustomerDeployment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientMigrationIdMap" ADD CONSTRAINT "ClientMigrationIdMap_migrationRunId_fkey" FOREIGN KEY ("migrationRunId") REFERENCES "ClientMigrationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
