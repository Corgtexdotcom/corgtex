-- AlterTable
ALTER TABLE "Tension" ADD COLUMN "resolvedAt" TIMESTAMP(3);

-- Backfill the best available historical close date for already resolved tensions.
UPDATE "Tension"
SET "resolvedAt" = "updatedAt"
WHERE "status" = 'RESOLVED'
  AND "resolvedAt" IS NULL;

-- CreateIndex
CREATE INDEX "Tension_workspaceId_publishedAt_idx" ON "Tension"("workspaceId", "publishedAt");

-- CreateIndex
CREATE INDEX "Tension_workspaceId_resolvedAt_idx" ON "Tension"("workspaceId", "resolvedAt");
