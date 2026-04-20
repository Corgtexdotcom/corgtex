ALTER TABLE "AgentRun"
ALTER COLUMN "agentKey" DROP DEFAULT;

ALTER TABLE "Constitution"
ADD COLUMN "diffSummary" TEXT,
ADD COLUMN "triggerRef" TEXT,
ADD COLUMN "triggerType" TEXT,
ADD COLUMN "version" INTEGER;

UPDATE "Constitution" AS c
SET "version" = ranked."version"
FROM (
  SELECT
    "id",
    ROW_NUMBER() OVER (PARTITION BY "workspaceId" ORDER BY "createdAt" ASC, "id" ASC) AS "version"
  FROM "Constitution"
) AS ranked
WHERE ranked."id" = c."id";

ALTER TABLE "Constitution"
ALTER COLUMN "version" SET NOT NULL,
ALTER COLUMN "version" SET DEFAULT 1;

CREATE TABLE "GovernanceScore" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "periodStart" TIMESTAMP(3) NOT NULL,
  "periodEnd" TIMESTAMP(3) NOT NULL,
  "overallScore" INTEGER NOT NULL,
  "participationPct" INTEGER NOT NULL DEFAULT 0,
  "decisionVelocityHrs" INTEGER NOT NULL DEFAULT 0,
  "policyCoverage" INTEGER NOT NULL DEFAULT 0,
  "tensionResolutionPct" INTEGER NOT NULL DEFAULT 0,
  "constitutionFreshness" INTEGER NOT NULL DEFAULT 0,
  "detailJson" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "GovernanceScore_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "GovernanceScore_workspaceId_periodEnd_idx"
ON "GovernanceScore"("workspaceId", "periodEnd");

CREATE UNIQUE INDEX "Constitution_workspaceId_version_key"
ON "Constitution"("workspaceId", "version");

ALTER TABLE "GovernanceScore"
ADD CONSTRAINT "GovernanceScore_workspaceId_fkey"
FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
