ALTER TABLE "AgentRun"
ADD COLUMN "agentKey" TEXT NOT NULL DEFAULT 'inbox-triage';

CREATE INDEX "AgentRun_workspaceId_agentKey_createdAt_idx"
ON "AgentRun"("workspaceId", "agentKey", "createdAt");

CREATE TABLE "AgentStep" (
  "id" TEXT NOT NULL,
  "agentRunId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "status" "AgentToolCallStatus" NOT NULL DEFAULT 'PENDING',
  "inputJson" JSONB,
  "outputJson" JSONB,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "error" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "AgentStep_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AgentStep_agentRunId_status_idx"
ON "AgentStep"("agentRunId", "status");

ALTER TABLE "AgentStep"
ADD CONSTRAINT "AgentStep_agentRunId_fkey"
FOREIGN KEY ("agentRunId") REFERENCES "AgentRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
