-- Archive the retired Cycles feature before dropping its active tables.
WITH impacted_workspaces AS (
  SELECT DISTINCT "workspaceId"
  FROM "Cycle"
), retired_cycle_archive AS (
  SELECT
    iw."workspaceId",
    jsonb_build_object(
      'version', 1,
      'generatedAt', now(),
      'source', '20260716120000_practice_ledger_slicing_pie_refactor',
      'counts', jsonb_build_object(
        'cycles', (SELECT COUNT(*) FROM "Cycle" c WHERE c."workspaceId" = iw."workspaceId"),
        'cycleUpdates', (
          SELECT COUNT(*)
          FROM "CycleUpdate" cu
          INNER JOIN "Cycle" c ON c.id = cu."cycleId"
          WHERE c."workspaceId" = iw."workspaceId"
        ),
        'allocations', (
          SELECT COUNT(*)
          FROM "Allocation" a
          INNER JOIN "Cycle" c ON c.id = a."cycleId"
          WHERE c."workspaceId" = iw."workspaceId"
        )
      ),
      'tables', jsonb_build_object(
        'cycles', COALESCE((
          SELECT jsonb_agg(to_jsonb(c) ORDER BY c."createdAt", c.id)
          FROM "Cycle" c
          WHERE c."workspaceId" = iw."workspaceId"
        ), '[]'::jsonb),
        'cycleUpdates', COALESCE((
          SELECT jsonb_agg(to_jsonb(cu) ORDER BY cu."createdAt", cu.id)
          FROM "CycleUpdate" cu
          INNER JOIN "Cycle" c ON c.id = cu."cycleId"
          WHERE c."workspaceId" = iw."workspaceId"
        ), '[]'::jsonb),
        'allocations', COALESCE((
          SELECT jsonb_agg(to_jsonb(a) ORDER BY a."createdAt", a.id)
          FROM "Allocation" a
          INNER JOIN "Cycle" c ON c.id = a."cycleId"
          WHERE c."workspaceId" = iw."workspaceId"
        ), '[]'::jsonb)
      )
    ) AS "previousState"
  FROM impacted_workspaces iw
)
INSERT INTO "WorkspaceArchiveRecord" (
  id,
  "workspaceId",
  "entityType",
  "entityId",
  "entityLabel",
  "previousState",
  "archiveReason",
  "archivedByLabel",
  "archivedAt",
  "createdAt",
  "updatedAt"
)
SELECT
  'retired-cycles-archive-v1-' || "workspaceId",
  "workspaceId",
  'RetiredCyclesArchive',
  'retired-cycles-archive-v1',
  'Retired Cycles archive',
  "previousState",
  'Practice Ledger Slicing Pie refactor',
  'system:cycles-decommission',
  now(),
  now(),
  now()
FROM retired_cycle_archive
ON CONFLICT (id) DO NOTHING;

CREATE TYPE "PracticeContributionType" AS ENUM ('TIME', 'EXPENSE');
CREATE TYPE "PracticeContributionPaymentChoice" AS ENUM ('CASH', 'SLICING_PIE');
CREATE TYPE "PracticeContributionCashStatus" AS ENUM ('NOT_APPLICABLE', 'REQUESTED', 'PAID');

CREATE TABLE "PracticeContributionEntry" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "contributorUserId" TEXT NOT NULL,
  "type" "PracticeContributionType" NOT NULL,
  "paymentChoice" "PracticeContributionPaymentChoice" NOT NULL,
  "cashStatus" "PracticeContributionCashStatus" NOT NULL DEFAULT 'NOT_APPLICABLE',
  "description" TEXT NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL,
  "hoursTenths" INTEGER,
  "rateCents" INTEGER,
  "amountCents" INTEGER NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "receiptUrl" TEXT,
  "sliceMultiplier" INTEGER NOT NULL,
  "slices" INTEGER NOT NULL,
  "paidAt" TIMESTAMP(3),
  "paidByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "PracticeContributionEntry_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PracticeContributionEntry_workspaceId_occurredAt_idx" ON "PracticeContributionEntry"("workspaceId", "occurredAt");
CREATE INDEX "PracticeContributionEntry_workspaceId_contributorUserId_idx" ON "PracticeContributionEntry"("workspaceId", "contributorUserId");
CREATE INDEX "PracticeContributionEntry_projectId_occurredAt_idx" ON "PracticeContributionEntry"("projectId", "occurredAt");
CREATE INDEX "PracticeContributionEntry_workspaceId_paymentChoice_idx" ON "PracticeContributionEntry"("workspaceId", "paymentChoice");
CREATE INDEX "PracticeContributionEntry_workspaceId_cashStatus_idx" ON "PracticeContributionEntry"("workspaceId", "cashStatus");

ALTER TABLE "PracticeContributionEntry"
ADD CONSTRAINT "PracticeContributionEntry_workspaceId_fkey"
FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PracticeContributionEntry"
ADD CONSTRAINT "PracticeContributionEntry_projectId_fkey"
FOREIGN KEY ("projectId") REFERENCES "PracticeProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PracticeContributionEntry"
ADD CONSTRAINT "PracticeContributionEntry_contributorUserId_fkey"
FOREIGN KEY ("contributorUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PracticeContributionEntry"
ADD CONSTRAINT "PracticeContributionEntry_paidByUserId_fkey"
FOREIGN KEY ("paidByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Allocation" DROP CONSTRAINT "Allocation_cycleId_fkey";
ALTER TABLE "Allocation" DROP CONSTRAINT "Allocation_fromUserId_fkey";
ALTER TABLE "Allocation" DROP CONSTRAINT "Allocation_toUserId_fkey";
ALTER TABLE "CycleUpdate" DROP CONSTRAINT "CycleUpdate_cycleId_fkey";
ALTER TABLE "CycleUpdate" DROP CONSTRAINT "CycleUpdate_userId_fkey";
ALTER TABLE "Cycle" DROP CONSTRAINT "Cycle_workspaceId_fkey";

DROP TABLE "Allocation";
DROP TABLE "CycleUpdate";
DROP TABLE "Cycle";

DROP TYPE "CycleStatus";
