-- CreateEnum
CREATE TYPE "WorkspaceBriefingPeriod" AS ENUM ('DAILY', 'WEEKLY');

-- CreateEnum
CREATE TYPE "WorkspaceBriefingStatus" AS ENUM ('GENERATED', 'FAILED');

-- CreateTable
CREATE TABLE "WorkspaceBriefing" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "workflowJobId" TEXT,
    "period" "WorkspaceBriefingPeriod" NOT NULL,
    "dateKey" TEXT NOT NULL,
    "runKey" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" "WorkspaceBriefingStatus" NOT NULL DEFAULT 'GENERATED',
    "modelUsed" TEXT,
    "introMd" TEXT,
    "bodyMd" TEXT NOT NULL,
    "briefingJson" JSONB NOT NULL,
    "sourceRefsJson" JSONB NOT NULL,
    "sourceCounts" JSONB,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkspaceBriefing_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceBriefing_workspaceId_period_dateKey_key" ON "WorkspaceBriefing"("workspaceId", "period", "dateKey");

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceBriefing_workspaceId_runKey_key" ON "WorkspaceBriefing"("workspaceId", "runKey");

-- CreateIndex
CREATE INDEX "WorkspaceBriefing_workspaceId_generatedAt_idx" ON "WorkspaceBriefing"("workspaceId", "generatedAt");

-- CreateIndex
CREATE INDEX "WorkspaceBriefing_workflowJobId_idx" ON "WorkspaceBriefing"("workflowJobId");

-- CreateIndex
CREATE INDEX "WorkspaceBriefing_status_idx" ON "WorkspaceBriefing"("status");

-- AddForeignKey
ALTER TABLE "WorkspaceBriefing" ADD CONSTRAINT "WorkspaceBriefing_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceBriefing" ADD CONSTRAINT "WorkspaceBriefing_workflowJobId_fkey" FOREIGN KEY ("workflowJobId") REFERENCES "WorkflowJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;
