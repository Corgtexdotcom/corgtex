-- CreateTable
CREATE TABLE "CrmDealStageTransition" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "dealId" TEXT NOT NULL,
    "fromStage" "CrmDealStage",
    "toStage" "CrmDealStage" NOT NULL,
    "actorUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CrmDealStageTransition_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CrmDealStageTransition_workspaceId_createdAt_idx" ON "CrmDealStageTransition"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "CrmDealStageTransition_workspaceId_toStage_createdAt_idx" ON "CrmDealStageTransition"("workspaceId", "toStage", "createdAt");

-- CreateIndex
CREATE INDEX "CrmDealStageTransition_dealId_createdAt_idx" ON "CrmDealStageTransition"("dealId", "createdAt");

-- AddForeignKey
ALTER TABLE "CrmDealStageTransition" ADD CONSTRAINT "CrmDealStageTransition_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmDealStageTransition" ADD CONSTRAINT "CrmDealStageTransition_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "CrmDeal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill one initial stage transition per existing deal so stage age and
-- conversion reporting have a stable baseline after deployment.
INSERT INTO "CrmDealStageTransition" (
    "id",
    "workspaceId",
    "dealId",
    "fromStage",
    "toStage",
    "actorUserId",
    "createdAt"
)
SELECT
    LOWER(CONCAT(
        SUBSTRING(MD5(d."id" || ':initial-stage-transition') FROM 1 FOR 8), '-',
        SUBSTRING(MD5(d."id" || ':initial-stage-transition') FROM 9 FOR 4), '-',
        SUBSTRING(MD5(d."id" || ':initial-stage-transition') FROM 13 FOR 4), '-',
        SUBSTRING(MD5(d."id" || ':initial-stage-transition') FROM 17 FOR 4), '-',
        SUBSTRING(MD5(d."id" || ':initial-stage-transition') FROM 21 FOR 12)
    )),
    d."workspaceId",
    d."id",
    NULL,
    d."stage",
    NULL,
    d."createdAt"
FROM "CrmDeal" d
ON CONFLICT ("id") DO NOTHING;
