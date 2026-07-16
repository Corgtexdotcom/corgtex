-- CreateEnum
CREATE TYPE "ConversationPendingOperationStatus" AS ENUM ('PENDING', 'EXECUTING', 'EXECUTED', 'CANCELED', 'EXPIRED', 'FAILED');

-- CreateTable
CREATE TABLE "ConversationPendingOperation" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "agentKey" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "argsJson" JSONB NOT NULL,
    "argsHash" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "relatedEntityType" TEXT,
    "relatedEntityId" TEXT,
    "riskLabel" TEXT NOT NULL,
    "status" "ConversationPendingOperationStatus" NOT NULL DEFAULT 'PENDING',
    "resultJson" JSONB,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "proposedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "executedAt" TIMESTAMP(3),
    "canceledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConversationPendingOperation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ConversationPendingOperation_conversationId_status_createdA_idx" ON "ConversationPendingOperation"("conversationId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "ConversationPendingOperation_workspaceId_status_expiresAt_idx" ON "ConversationPendingOperation"("workspaceId", "status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "ConversationPendingOperation_workspaceId_idempotencyKey_key" ON "ConversationPendingOperation"("workspaceId", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "ConversationPendingOperation" ADD CONSTRAINT "ConversationPendingOperation_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationPendingOperation" ADD CONSTRAINT "ConversationPendingOperation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
