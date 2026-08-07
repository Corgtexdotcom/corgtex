/*
  Warnings:

  - A unique constraint covering the columns `[id,customerAccountId]` on the table `CustomerDeployment` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "ProviderCutoverStatus" AS ENUM ('PLANNED', 'SHADOW', 'CUTOVER', 'OBSERVING', 'ARCHIVE_ONLY', 'DELETE_ELIGIBLE', 'DELETED', 'ROLLED_BACK');

-- CreateTable
CREATE TABLE "ProviderCutover" (
    "id" TEXT NOT NULL,
    "customerAccountId" TEXT NOT NULL,
    "sourceDeploymentId" TEXT NOT NULL,
    "destinationDeploymentId" TEXT,
    "sourceProvider" "CustomerDeploymentCloudProvider" NOT NULL,
    "destinationProvider" "CustomerDeploymentCloudProvider" NOT NULL,
    "status" "ProviderCutoverStatus" NOT NULL DEFAULT 'PLANNED',
    "sourceWriteStoppedAt" TIMESTAMP(3),
    "destinationWriteStartedAt" TIMESTAMP(3),
    "finalSnapshotAt" TIMESTAMP(3),
    "finalSnapshotChecksum" TEXT,
    "sourceDataFreshThroughAt" TIMESTAMP(3),
    "observationCompletedAt" TIMESTAMP(3),
    "archiveRestoreTestedAt" TIMESTAMP(3),
    "archiveRetentionDeadline" TIMESTAMP(3),
    "retentionWaiverApprovedAt" TIMESTAMP(3),
    "retentionWaiverApprovedBy" TEXT,
    "retentionWaiverReason" TEXT,
    "sourceDeletedAt" TIMESTAMP(3),
    "evidence" JSONB,
    "reason" TEXT NOT NULL,
    "recordedByUserId" TEXT,
    "transitionKey" TEXT NOT NULL,
    "activeTransitionKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderCutover_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProviderCutover_activeTransitionKey_key" ON "ProviderCutover"("activeTransitionKey");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderCutover_non_terminal_tuple_key" ON "ProviderCutover"("sourceDeploymentId", "sourceProvider", "destinationProvider") WHERE status IN ('PLANNED', 'SHADOW', 'CUTOVER', 'OBSERVING', 'ARCHIVE_ONLY', 'DELETE_ELIGIBLE');

-- CreateIndex
CREATE UNIQUE INDEX "CustomerDeployment_id_customerAccountId_key" ON "CustomerDeployment"("id", "customerAccountId");

-- AddForeignKey
ALTER TABLE "ProviderCutover" ADD CONSTRAINT "ProviderCutover_customerAccountId_fkey" FOREIGN KEY ("customerAccountId") REFERENCES "CustomerAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderCutover" ADD CONSTRAINT "ProviderCutover_sourceDeploymentId_customerAccountId_fkey" FOREIGN KEY ("sourceDeploymentId", "customerAccountId") REFERENCES "CustomerDeployment"("id", "customerAccountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderCutover" ADD CONSTRAINT "ProviderCutover_destinationDeploymentId_customerAccountId_fkey" FOREIGN KEY ("destinationDeploymentId", "customerAccountId") REFERENCES "CustomerDeployment"("id", "customerAccountId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ProviderCutover" ADD CONSTRAINT "ProviderCutover_active_mirror_check" CHECK (
  CASE WHEN status IN ('DELETED', 'ROLLED_BACK') THEN "activeTransitionKey" IS NULL
  ELSE "activeTransitionKey" IS NOT DISTINCT FROM "transitionKey"
  END
);

ALTER TABLE "ProviderCutover" ADD CONSTRAINT "ProviderCutover_provider_pair_check" CHECK (
  "sourceProvider" != "destinationProvider"
);

ALTER TABLE "ProviderCutover" ADD CONSTRAINT "ProviderCutover_deletion_consistency_check" CHECK (
  (status = 'DELETED') = ("sourceDeletedAt" IS NOT NULL)
);

ALTER TABLE "ProviderCutover" ADD CONSTRAINT "ProviderCutover_destination_required_check" CHECK (
  status IN ('PLANNED', 'SHADOW', 'ROLLED_BACK') OR "destinationDeploymentId" IS NOT NULL
);

ALTER TABLE "ProviderCutover" ADD CONSTRAINT "ProviderCutover_checksum_format_check" CHECK (
  "finalSnapshotChecksum" IS NULL OR "finalSnapshotChecksum" ~ '^[0-9a-f]{64}$'
);
