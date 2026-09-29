CREATE TABLE "DecisionRecord" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "bodyMd" TEXT NOT NULL,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "proposalId" TEXT,
    "tensionId" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DecisionRecord_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "DecisionRecord_workspaceId_archivedAt_decidedAt_idx"
    ON "DecisionRecord"("workspaceId", "archivedAt", "decidedAt");
CREATE INDEX "DecisionRecord_workspaceId_proposalId_idx"
    ON "DecisionRecord"("workspaceId", "proposalId");
CREATE INDEX "DecisionRecord_workspaceId_tensionId_idx"
    ON "DecisionRecord"("workspaceId", "tensionId");

ALTER TABLE "DecisionRecord" ADD CONSTRAINT "DecisionRecord_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
