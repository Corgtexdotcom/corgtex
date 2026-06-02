-- CreateEnum
CREATE TYPE "ExecutionRequestStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'RESULT_SUBMITTED', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ExecutionResultStatus" AS ENUM ('SUBMITTED', 'ACCEPTED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ExecutionWritebackTargetType" AS ENUM ('ACTION', 'TENSION', 'PROPOSAL', 'MEETING', 'BRAIN_ARTICLE', 'BUILD_ARTIFACT', 'COMMENT');

-- CreateTable
CREATE TABLE "ExecutionRequest" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "createdByUserId" TEXT,
    "agentCredentialId" TEXT,
    "provider" "AiWorkspaceProvider",
    "status" "ExecutionRequestStatus" NOT NULL DEFAULT 'PENDING',
    "goal" TEXT NOT NULL,
    "actorJson" JSONB,
    "contextJson" JSONB,
    "allowedScopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "policyConstraintsJson" JSONB,
    "expectedOutputJson" JSONB,
    "approvalRule" TEXT,
    "writebackTargetType" "ExecutionWritebackTargetType",
    "writebackTargetId" TEXT,
    "writebackTargetLabel" TEXT,
    "packetJson" JSONB,
    "idempotencyKey" TEXT,
    "claimedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExecutionRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExecutionResult" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "executionRequestId" TEXT NOT NULL,
    "submittedByUserId" TEXT,
    "agentCredentialId" TEXT,
    "status" "ExecutionResultStatus" NOT NULL DEFAULT 'SUBMITTED',
    "idempotencyKey" TEXT NOT NULL,
    "targetType" "ExecutionWritebackTargetType",
    "targetId" TEXT,
    "outputJson" JSONB,
    "artifactJson" JSONB,
    "errorMessage" TEXT,
    "writebackEntityType" TEXT,
    "writebackEntityId" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acceptedAt" TIMESTAMP(3),
    "rejectedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExecutionResult_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ExecutionRequest_workspaceId_status_createdAt_idx" ON "ExecutionRequest"("workspaceId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "ExecutionRequest_workspaceId_writebackTargetType_writebackT_idx" ON "ExecutionRequest"("workspaceId", "writebackTargetType", "writebackTargetId");

-- CreateIndex
CREATE INDEX "ExecutionRequest_agentCredentialId_idx" ON "ExecutionRequest"("agentCredentialId");

-- CreateIndex
CREATE UNIQUE INDEX "ExecutionRequest_workspaceId_idempotencyKey_key" ON "ExecutionRequest"("workspaceId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "ExecutionResult_workspaceId_submittedAt_idx" ON "ExecutionResult"("workspaceId", "submittedAt");

-- CreateIndex
CREATE INDEX "ExecutionResult_workspaceId_targetType_targetId_idx" ON "ExecutionResult"("workspaceId", "targetType", "targetId");

-- CreateIndex
CREATE INDEX "ExecutionResult_agentCredentialId_idx" ON "ExecutionResult"("agentCredentialId");

-- CreateIndex
CREATE UNIQUE INDEX "ExecutionResult_executionRequestId_idempotencyKey_key" ON "ExecutionResult"("executionRequestId", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "ExecutionRequest" ADD CONSTRAINT "ExecutionRequest_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExecutionRequest" ADD CONSTRAINT "ExecutionRequest_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExecutionRequest" ADD CONSTRAINT "ExecutionRequest_agentCredentialId_fkey" FOREIGN KEY ("agentCredentialId") REFERENCES "AgentCredential"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExecutionResult" ADD CONSTRAINT "ExecutionResult_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExecutionResult" ADD CONSTRAINT "ExecutionResult_executionRequestId_fkey" FOREIGN KEY ("executionRequestId") REFERENCES "ExecutionRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExecutionResult" ADD CONSTRAINT "ExecutionResult_submittedByUserId_fkey" FOREIGN KEY ("submittedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExecutionResult" ADD CONSTRAINT "ExecutionResult_agentCredentialId_fkey" FOREIGN KEY ("agentCredentialId") REFERENCES "AgentCredential"("id") ON DELETE SET NULL ON UPDATE CASCADE;
