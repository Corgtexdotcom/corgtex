ALTER TABLE "WorkflowJob"
ADD COLUMN "dependsOnJobId" TEXT;

CREATE INDEX "WorkflowJob_dependsOnJobId_idx"
ON "WorkflowJob"("dependsOnJobId");

ALTER TABLE "WorkflowJob"
ADD CONSTRAINT "WorkflowJob_dependsOnJobId_fkey"
FOREIGN KEY ("dependsOnJobId") REFERENCES "WorkflowJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TYPE "ConversationStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'PAUSED');

CREATE TABLE "ConversationSession" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "agentKey" TEXT NOT NULL DEFAULT 'assistant',
  "topic" TEXT,
  "status" "ConversationStatus" NOT NULL DEFAULT 'ACTIVE',
  "systemPrompt" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ConversationSession_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ConversationSession_workspaceId_userId_status_idx"
ON "ConversationSession"("workspaceId", "userId", "status");

CREATE TABLE "ConversationTurn" (
  "id" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "sequenceNumber" INTEGER NOT NULL,
  "userMessage" TEXT NOT NULL,
  "assistantMessage" TEXT NOT NULL,
  "contextJson" JSONB,
  "agentRunId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ConversationTurn_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ConversationTurn_conversationId_sequenceNumber_idx"
ON "ConversationTurn"("conversationId", "sequenceNumber");

CREATE TABLE "AgentMemory" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "agentKey" TEXT NOT NULL,
  "memoryType" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "embedding" JSONB,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "AgentMemory_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AgentMemory_workspaceId_agentKey_memoryType_idx"
ON "AgentMemory"("workspaceId", "agentKey", "memoryType");

ALTER TABLE "ConversationSession"
ADD CONSTRAINT "ConversationSession_workspaceId_fkey"
FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ConversationSession"
ADD CONSTRAINT "ConversationSession_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ConversationTurn"
ADD CONSTRAINT "ConversationTurn_conversationId_fkey"
FOREIGN KEY ("conversationId") REFERENCES "ConversationSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ConversationTurn"
ADD CONSTRAINT "ConversationTurn_agentRunId_fkey"
FOREIGN KEY ("agentRunId") REFERENCES "AgentRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "AgentMemory"
ADD CONSTRAINT "AgentMemory_workspaceId_fkey"
FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
