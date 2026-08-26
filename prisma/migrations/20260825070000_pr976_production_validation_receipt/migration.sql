-- CreateEnum
CREATE TYPE "ProductionValidationLifecycleState" AS ENUM ('PENDING', 'PROVISIONED', 'FEATURE_PROVEN', 'CLEANED', 'BLOCKED');

-- CreateEnum
CREATE TYPE "ProductionValidationOutcome" AS ENUM ('PENDING', 'COMPLETED', 'BLOCKED', 'FAILED');

-- CreateTable
CREATE TABLE "ProductionValidationReceipt" (
    "id" TEXT NOT NULL,
    "operationKey" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "targetPullRequest" INTEGER NOT NULL,
    "targetReleaseSha" TEXT NOT NULL,
    "deployedSha" TEXT NOT NULL,
    "ancestorSha" TEXT NOT NULL,
    "workflowRunId" TEXT NOT NULL,
    "workflowRunAttempt" INTEGER NOT NULL,
    "syntheticMarker" TEXT NOT NULL,
    "actionId" TEXT,
    "goalId" TEXT,
    "agentCredentialId" TEXT,
    "actionBaselineVersion" INTEGER,
    "goalBaselineVersion" INTEGER,
    "actionExpectedDigest" TEXT,
    "actionObservedDigest" TEXT,
    "goalExpectedProgress" INTEGER,
    "goalObservedProgress" INTEGER,
    "actionState" "ProductionValidationLifecycleState" NOT NULL DEFAULT 'PENDING',
    "goalState" "ProductionValidationLifecycleState" NOT NULL DEFAULT 'PENDING',
    "credentialState" "ProductionValidationLifecycleState" NOT NULL DEFAULT 'PENDING',
    "outcome" "ProductionValidationOutcome" NOT NULL DEFAULT 'PENDING',
    "actionArchiveRecordId" TEXT,
    "goalArchiveRecordId" TEXT,
    "cleanupStartedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "featureProvenAt" TIMESTAMP(3),
    "terminalizedAt" TIMESTAMP(3),
    "failureCode" TEXT,
    "failureMessage" TEXT,
    "transitions" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductionValidationReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProductionValidationReceipt_operationKey_workflowRunId_workflowRunAttempt_key" ON "ProductionValidationReceipt"("operationKey", "workflowRunId", "workflowRunAttempt");

-- CreateIndex
CREATE UNIQUE INDEX "ProductionValidationReceipt_actionId_key" ON "ProductionValidationReceipt"("actionId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductionValidationReceipt_goalId_key" ON "ProductionValidationReceipt"("goalId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductionValidationReceipt_agentCredentialId_key" ON "ProductionValidationReceipt"("agentCredentialId");

-- CreateIndex
CREATE INDEX "ProductionValidationReceipt_workspaceId_outcome_idx" ON "ProductionValidationReceipt"("workspaceId", "outcome");

-- CreateIndex
CREATE INDEX "ProductionValidationReceipt_targetPullRequest_targetRelease_idx" ON "ProductionValidationReceipt"("targetPullRequest", "targetReleaseSha");

-- AddForeignKey
ALTER TABLE "ProductionValidationReceipt" ADD CONSTRAINT "ProductionValidationReceipt_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
