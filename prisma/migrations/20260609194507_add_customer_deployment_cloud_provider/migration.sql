-- CreateEnum
CREATE TYPE "CustomerDeploymentCloudProvider" AS ENUM ('RAILWAY', 'AZURE', 'SELF_HOSTED', 'UNKNOWN');

-- AlterTable
ALTER TABLE "CustomerDeployment" ADD COLUMN     "cloudProvider" "CustomerDeploymentCloudProvider" NOT NULL DEFAULT 'RAILWAY',
ADD COLUMN     "providerCostUrl" TEXT,
ADD COLUMN     "providerEnvironmentId" TEXT,
ADD COLUMN     "providerLogsUrl" TEXT,
ADD COLUMN     "providerMetadata" JSONB,
ADD COLUMN     "providerPostgresServiceId" TEXT,
ADD COLUMN     "providerProjectId" TEXT,
ADD COLUMN     "providerRedisServiceId" TEXT,
ADD COLUMN     "providerResourceGroup" TEXT,
ADD COLUMN     "providerStorageResourceId" TEXT,
ADD COLUMN     "providerSubscriptionId" TEXT,
ADD COLUMN     "providerWebServiceId" TEXT,
ADD COLUMN     "providerWorkerServiceId" TEXT;

-- CreateIndex
CREATE INDEX "CustomerDeployment_cloudProvider_idx" ON "CustomerDeployment"("cloudProvider");

-- CreateIndex
CREATE INDEX "CustomerDeployment_cloudProvider_deploymentStatus_idx" ON "CustomerDeployment"("cloudProvider", "deploymentStatus");
