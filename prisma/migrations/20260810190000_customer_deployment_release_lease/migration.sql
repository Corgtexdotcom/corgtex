-- CreateEnum
CREATE TYPE "CustomerDeploymentReleaseLeasePhase" AS ENUM ('RESERVED', 'MUTATING', 'RECOVERY_REQUIRED');

-- AlterTable
ALTER TABLE "CustomerDeployment"
ADD COLUMN "releaseLeaseFence" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "releaseLeaseId" TEXT,
ADD COLUMN "releaseLeaseTokenHash" TEXT,
ADD COLUMN "releaseLeaseOwner" TEXT,
ADD COLUMN "releaseLeaseExpectedImageTag" TEXT,
ADD COLUMN "releaseLeaseIncomingImageTag" TEXT,
ADD COLUMN "releaseLeaseIncomingVersion" TEXT,
ADD COLUMN "releaseLeasePhase" "CustomerDeploymentReleaseLeasePhase",
ADD COLUMN "releaseLeaseAcquiredAt" TIMESTAMP(3),
ADD COLUMN "releaseLeaseHeartbeatAt" TIMESTAMP(3),
ADD COLUMN "releaseLeaseExpiresAt" TIMESTAMP(3),
ADD COLUMN "releaseLeaseRollbackRecord" JSONB,
ADD COLUMN "releaseLeaseRecoveryEvidence" JSONB,
ADD COLUMN "releaseLeaseError" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "CustomerDeployment_releaseLeaseId_key" ON "CustomerDeployment"("releaseLeaseId");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerDeployment_releaseLeaseTokenHash_key" ON "CustomerDeployment"("releaseLeaseTokenHash");

-- CreateIndex
CREATE INDEX "CustomerDeployment_releaseLeasePhase_releaseLeaseExpiresAt_idx" ON "CustomerDeployment"("releaseLeasePhase", "releaseLeaseExpiresAt");

-- AddConstraint
ALTER TABLE "CustomerDeployment" ADD CONSTRAINT "CustomerDeployment_release_lease_slot_check" CHECK (
  "releaseLeaseFence" >= 0
  AND (
    (
      "releaseLeaseId" IS NULL
      AND "releaseLeaseTokenHash" IS NULL
      AND "releaseLeaseOwner" IS NULL
      AND "releaseLeaseExpectedImageTag" IS NULL
      AND "releaseLeaseIncomingImageTag" IS NULL
      AND "releaseLeaseIncomingVersion" IS NULL
      AND "releaseLeasePhase" IS NULL
      AND "releaseLeaseAcquiredAt" IS NULL
      AND "releaseLeaseHeartbeatAt" IS NULL
      AND "releaseLeaseExpiresAt" IS NULL
      AND "releaseLeaseRollbackRecord" IS NULL
      AND "releaseLeaseRecoveryEvidence" IS NULL
      AND "releaseLeaseError" IS NULL
    )
    OR (
      "releaseLeaseFence" > 0
      AND "releaseLeaseId" IS NOT NULL
      AND btrim("releaseLeaseId") <> ''
      AND "releaseLeaseTokenHash" IS NOT NULL
      AND "releaseLeaseTokenHash" ~ '^[0-9a-f]{64}$'
      AND "releaseLeaseOwner" IS NOT NULL
      AND btrim("releaseLeaseOwner") <> ''
      AND "releaseLeaseExpectedImageTag" IS NOT NULL
      AND "releaseLeaseExpectedImageTag" ~ '^sha-[0-9a-f]{40}$'
      AND "releaseLeaseIncomingImageTag" IS NOT NULL
      AND "releaseLeaseIncomingImageTag" ~ '^sha-[0-9a-f]{40}$'
      AND "releaseLeaseIncomingVersion" IS NOT NULL
      AND btrim("releaseLeaseIncomingVersion") <> ''
      AND "releaseLeasePhase" IS NOT NULL
      AND "releaseLeaseAcquiredAt" IS NOT NULL
      AND "releaseLeaseHeartbeatAt" IS NOT NULL
      AND "releaseLeaseExpiresAt" IS NOT NULL
      AND isfinite("releaseLeaseAcquiredAt")
      AND isfinite("releaseLeaseHeartbeatAt")
      AND isfinite("releaseLeaseExpiresAt")
      AND "releaseLeaseAcquiredAt" <= "releaseLeaseHeartbeatAt"
      AND "releaseLeaseHeartbeatAt" < "releaseLeaseExpiresAt"
      AND "releaseImageTag" IS NOT DISTINCT FROM "releaseLeaseExpectedImageTag"
    )
  )
);

-- AddConstraint
ALTER TABLE "CustomerDeployment" ADD CONSTRAINT "CustomerDeployment_release_lease_rollback_check" CHECK (
  "releaseLeasePhase" IS NULL
  OR "releaseLeasePhase" = 'RESERVED'
  OR (
    "releaseLeaseRollbackRecord" IS NOT NULL
    AND jsonb_typeof("releaseLeaseRollbackRecord") = 'object'
  )
);
