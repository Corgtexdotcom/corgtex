-- CreateEnum
CREATE TYPE "PracticeProjectStatus" AS ENUM ('ACTIVE', 'ON_HOLD', 'CLOSED');

-- CreateTable
CREATE TABLE "PracticeProject" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "clientName" TEXT NOT NULL,
    "status" "PracticeProjectStatus" NOT NULL DEFAULT 'ACTIVE',
    "poValueCents" INTEGER NOT NULL DEFAULT 0,
    "serviceBudgetCents" INTEGER NOT NULL DEFAULT 0,
    "expenseBudgetCents" INTEGER NOT NULL DEFAULT 0,
    "usedCents" INTEGER NOT NULL DEFAULT 0,
    "weeklyBurnCents" INTEGER NOT NULL DEFAULT 0,
    "targetMarginBps" INTEGER,
    "currentMarginBps" INTEGER,
    "sourceSatelliteId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PracticeProject_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PracticeProject_workspaceId_status_idx" ON "PracticeProject"("workspaceId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PracticeProject_workspaceId_code_key" ON "PracticeProject"("workspaceId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "PracticeProject_workspaceId_sourceSatelliteId_key" ON "PracticeProject"("workspaceId", "sourceSatelliteId");

-- AddForeignKey
ALTER TABLE "PracticeProject" ADD CONSTRAINT "PracticeProject_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

