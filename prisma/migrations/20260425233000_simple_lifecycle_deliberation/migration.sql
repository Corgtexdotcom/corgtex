-- Simple lifecycle workflow: archive is kept in archivedAt, objection is derived,
-- and approval/payment outcomes are stored separately from lifecycle status.

CREATE TYPE "ProposalResolutionOutcome" AS ENUM ('ADOPTED', 'NOT_ADOPTED', 'WITHDRAWN');
CREATE TYPE "SpendResolutionOutcome" AS ENUM ('APPROVED', 'REJECTED', 'WITHDRAWN');

ALTER TABLE "Proposal" ADD COLUMN "resolutionOutcome" "ProposalResolutionOutcome";
ALTER TABLE "SpendRequest" ADD COLUMN "resolutionOutcome" "SpendResolutionOutcome";
ALTER TABLE "DeliberationEntry" ADD COLUMN "targetCircleId" TEXT;

UPDATE "DeliberationEntry"
SET "entryType" = 'REACTION'
WHERE "entryType" <> 'OBJECTION';

UPDATE "Proposal"
SET "resolutionOutcome" = CASE
  WHEN "status"::text = 'APPROVED' THEN 'ADOPTED'::"ProposalResolutionOutcome"
  WHEN "status"::text = 'REJECTED' THEN 'NOT_ADOPTED'::"ProposalResolutionOutcome"
  WHEN "status"::text = 'ARCHIVED' THEN (
    CASE (
      SELECT record."previousState"->>'status'
      FROM "WorkspaceArchiveRecord" AS record
      WHERE record."entityType" = 'Proposal'
        AND record."entityId" = "Proposal"."id"
        AND record."restoredAt" IS NULL
        AND record."purgedAt" IS NULL
      ORDER BY record."archivedAt" DESC
      LIMIT 1
    )
      WHEN 'APPROVED' THEN 'ADOPTED'::"ProposalResolutionOutcome"
      WHEN 'REJECTED' THEN 'NOT_ADOPTED'::"ProposalResolutionOutcome"
      ELSE NULL
    END
  )
  ELSE NULL
END;

UPDATE "SpendRequest"
SET "resolutionOutcome" = CASE
  WHEN "status"::text IN ('APPROVED', 'PAID') THEN 'APPROVED'::"SpendResolutionOutcome"
  WHEN "status"::text = 'REJECTED' THEN 'REJECTED'::"SpendResolutionOutcome"
  ELSE NULL
END;

ALTER TYPE "ActionStatus" RENAME TO "ActionStatus_old";
CREATE TYPE "ActionStatus" AS ENUM ('DRAFT', 'OPEN', 'IN_PROGRESS', 'COMPLETED');
ALTER TABLE "Action" ALTER COLUMN "status" DROP DEFAULT;
UPDATE "Action"
SET "completedVia" = COALESCE("completedVia", 'Cancelled before lifecycle simplification.')
WHERE "status"::text = 'CANCELLED';
ALTER TABLE "Action" ALTER COLUMN "status" TYPE "ActionStatus" USING (
  CASE
    WHEN "status"::text = 'OPEN' AND "isPrivate" = true THEN 'DRAFT'
    WHEN "status"::text = 'CANCELLED' THEN 'COMPLETED'
    ELSE "status"::text
  END
)::"ActionStatus";
ALTER TABLE "Action" ALTER COLUMN "status" SET DEFAULT 'DRAFT';
DROP TYPE "ActionStatus_old";

ALTER TYPE "TensionStatus" RENAME TO "TensionStatus_old";
CREATE TYPE "TensionStatus" AS ENUM ('DRAFT', 'OPEN', 'RESOLVED');
ALTER TABLE "Tension" ALTER COLUMN "status" DROP DEFAULT;
UPDATE "Tension"
SET "resolvedVia" = COALESCE(
  "resolvedVia",
  CASE
    WHEN "status"::text = 'CANCELLED' THEN 'Cancelled before lifecycle simplification.'
    ELSE 'Resolved before lifecycle simplification.'
  END
)
WHERE "status"::text IN ('COMPLETED', 'CANCELLED');
ALTER TABLE "Tension" ALTER COLUMN "status" TYPE "TensionStatus" USING (
  CASE
    WHEN "status"::text = 'COMPLETED' THEN 'RESOLVED'
    WHEN "status"::text = 'CANCELLED' THEN 'RESOLVED'
    WHEN "status"::text = 'IN_PROGRESS' THEN 'OPEN'
    WHEN "status"::text = 'OPEN' AND "isPrivate" = true THEN 'DRAFT'
    ELSE "status"::text
  END
)::"TensionStatus";
ALTER TABLE "Tension" ALTER COLUMN "status" SET DEFAULT 'DRAFT';
DROP TYPE "TensionStatus_old";

ALTER TYPE "ProposalStatus" RENAME TO "ProposalStatus_old";
CREATE TYPE "ProposalStatus" AS ENUM ('DRAFT', 'OPEN', 'RESOLVED');
ALTER TABLE "Proposal" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "Proposal" ADD COLUMN "_simpleLifecycleStatus" TEXT;
UPDATE "Proposal"
SET "_simpleLifecycleStatus" = (
  CASE
    WHEN "status"::text IN ('SUBMITTED', 'ADVICE_GATHERING') THEN 'OPEN'
    WHEN "status"::text IN ('APPROVED', 'REJECTED') THEN 'RESOLVED'
    WHEN "status"::text = 'ARCHIVED' THEN (
      CASE (
        SELECT record."previousState"->>'status'
        FROM "WorkspaceArchiveRecord" AS record
        WHERE record."entityType" = 'Proposal'
          AND record."entityId" = "Proposal"."id"
          AND record."restoredAt" IS NULL
          AND record."purgedAt" IS NULL
        ORDER BY record."archivedAt" DESC
        LIMIT 1
      )
        WHEN 'APPROVED' THEN 'RESOLVED'
        WHEN 'REJECTED' THEN 'RESOLVED'
        WHEN 'SUBMITTED' THEN 'OPEN'
        WHEN 'ADVICE_GATHERING' THEN 'OPEN'
        ELSE 'DRAFT'
      END
    )
    ELSE "status"::text
  END
);
ALTER TABLE "Proposal" ALTER COLUMN "status" TYPE "ProposalStatus" USING "_simpleLifecycleStatus"::"ProposalStatus";
ALTER TABLE "Proposal" DROP COLUMN "_simpleLifecycleStatus";
ALTER TABLE "Proposal" ALTER COLUMN "status" SET DEFAULT 'DRAFT';
DROP TYPE "ProposalStatus_old";

ALTER TYPE "SpendStatus" RENAME TO "SpendStatus_old";
CREATE TYPE "SpendStatus" AS ENUM ('DRAFT', 'OPEN', 'RESOLVED');
ALTER TABLE "SpendRequest" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "SpendRequest" ALTER COLUMN "status" TYPE "SpendStatus" USING (
  CASE
    WHEN "status"::text IN ('SUBMITTED', 'OBJECTED') THEN 'OPEN'
    WHEN "status"::text IN ('APPROVED', 'REJECTED', 'PAID') THEN 'RESOLVED'
    ELSE "status"::text
  END
)::"SpendStatus";
ALTER TABLE "SpendRequest" ALTER COLUMN "status" SET DEFAULT 'DRAFT';
DROP TYPE "SpendStatus_old";

CREATE INDEX "DeliberationEntry_targetCircleId_idx" ON "DeliberationEntry"("targetCircleId");
CREATE INDEX "DeliberationEntry_targetMemberId_idx" ON "DeliberationEntry"("targetMemberId");

UPDATE "DeliberationEntry"
SET "targetMemberId" = NULL
WHERE "targetMemberId" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "Member"
    WHERE "Member"."id" = "DeliberationEntry"."targetMemberId"
  );

ALTER TABLE "DeliberationEntry" ADD CONSTRAINT "DeliberationEntry_targetCircleId_fkey" FOREIGN KEY ("targetCircleId") REFERENCES "Circle"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "DeliberationEntry" ADD CONSTRAINT "DeliberationEntry_targetMemberId_fkey" FOREIGN KEY ("targetMemberId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;
