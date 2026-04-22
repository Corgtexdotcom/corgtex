-- CreateEnum
CREATE TYPE "GoalCadence" AS ENUM ('WEEKLY', 'MONTHLY', 'QUARTERLY', 'ANNUAL', 'FIVE_YEAR', 'TEN_YEAR');

-- CreateEnum
CREATE TYPE "GoalStatus" AS ENUM ('DRAFT', 'ACTIVE', 'ON_TRACK', 'AT_RISK', 'BEHIND', 'COMPLETED', 'ABANDONED');

-- CreateEnum
CREATE TYPE "GoalLevel" AS ENUM ('COMPANY', 'CIRCLE', 'PERSONAL');

-- CreateTable
CREATE TABLE "Goal" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "parentGoalId" TEXT,
    "circleId" TEXT,
    "ownerMemberId" TEXT,
    "title" TEXT NOT NULL,
    "descriptionMd" TEXT,
    "level" "GoalLevel" NOT NULL DEFAULT 'COMPANY',
    "cadence" "GoalCadence" NOT NULL DEFAULT 'QUARTERLY',
    "status" "GoalStatus" NOT NULL DEFAULT 'DRAFT',
    "progressPercent" INTEGER NOT NULL DEFAULT 0,
    "targetDate" TIMESTAMP(3),
    "startDate" TIMESTAMP(3),
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Goal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KeyResult" (
    "id" TEXT NOT NULL,
    "goalId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "targetValue" DOUBLE PRECISION,
    "currentValue" DOUBLE PRECISION DEFAULT 0,
    "unit" TEXT,
    "progressPercent" INTEGER NOT NULL DEFAULT 0,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KeyResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GoalUpdate" (
    "id" TEXT NOT NULL,
    "goalId" TEXT NOT NULL,
    "authorMemberId" TEXT,
    "source" TEXT NOT NULL DEFAULT 'human',
    "bodyMd" TEXT NOT NULL,
    "newProgress" INTEGER,
    "statusChange" "GoalStatus",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GoalUpdate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GoalLink" (
    "id" TEXT NOT NULL,
    "goalId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "linkedBy" TEXT NOT NULL DEFAULT 'human',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GoalLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Recognition" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "goalId" TEXT,
    "recipientMemberId" TEXT NOT NULL,
    "authorMemberId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "storyMd" TEXT NOT NULL,
    "valueTags" TEXT[],
    "visibility" TEXT NOT NULL DEFAULT 'WORKSPACE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Recognition_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Goal_workspaceId_level_cadence_idx" ON "Goal"("workspaceId", "level", "cadence");

-- CreateIndex
CREATE INDEX "Goal_workspaceId_status_idx" ON "Goal"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "Goal_parentGoalId_idx" ON "Goal"("parentGoalId");

-- CreateIndex
CREATE INDEX "Goal_circleId_idx" ON "Goal"("circleId");

-- CreateIndex
CREATE INDEX "Goal_ownerMemberId_idx" ON "Goal"("ownerMemberId");

-- CreateIndex
CREATE INDEX "KeyResult_goalId_idx" ON "KeyResult"("goalId");

-- CreateIndex
CREATE INDEX "GoalUpdate_goalId_createdAt_idx" ON "GoalUpdate"("goalId", "createdAt");

-- CreateIndex
CREATE INDEX "GoalLink_entityType_entityId_idx" ON "GoalLink"("entityType", "entityId");

-- CreateIndex
CREATE UNIQUE INDEX "GoalLink_goalId_entityType_entityId_key" ON "GoalLink"("goalId", "entityType", "entityId");

-- CreateIndex
CREATE INDEX "Recognition_workspaceId_createdAt_idx" ON "Recognition"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "Recognition_recipientMemberId_idx" ON "Recognition"("recipientMemberId");

-- AddForeignKey
ALTER TABLE "Goal" ADD CONSTRAINT "Goal_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Goal" ADD CONSTRAINT "Goal_parentGoalId_fkey" FOREIGN KEY ("parentGoalId") REFERENCES "Goal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Goal" ADD CONSTRAINT "Goal_circleId_fkey" FOREIGN KEY ("circleId") REFERENCES "Circle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Goal" ADD CONSTRAINT "Goal_ownerMemberId_fkey" FOREIGN KEY ("ownerMemberId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KeyResult" ADD CONSTRAINT "KeyResult_goalId_fkey" FOREIGN KEY ("goalId") REFERENCES "Goal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoalUpdate" ADD CONSTRAINT "GoalUpdate_goalId_fkey" FOREIGN KEY ("goalId") REFERENCES "Goal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoalUpdate" ADD CONSTRAINT "GoalUpdate_authorMemberId_fkey" FOREIGN KEY ("authorMemberId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoalLink" ADD CONSTRAINT "GoalLink_goalId_fkey" FOREIGN KEY ("goalId") REFERENCES "Goal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Recognition" ADD CONSTRAINT "Recognition_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Recognition" ADD CONSTRAINT "Recognition_goalId_fkey" FOREIGN KEY ("goalId") REFERENCES "Goal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Recognition" ADD CONSTRAINT "Recognition_recipientMemberId_fkey" FOREIGN KEY ("recipientMemberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Recognition" ADD CONSTRAINT "Recognition_authorMemberId_fkey" FOREIGN KEY ("authorMemberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;
