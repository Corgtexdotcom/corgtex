-- Immutable directly authored feedback input; no inference about prior model text.
CREATE TABLE "AgentFeedbackInput" (
 "id" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "agentRunId" TEXT NOT NULL, "stepId" TEXT NOT NULL, "userId" TEXT NOT NULL, "content" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "AgentFeedbackInput_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "AgentFeedbackInput" ADD CONSTRAINT "AgentFeedbackInput_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "AgentFeedbackInput_workspaceId_agentRunId_userId_idx" ON "AgentFeedbackInput"("workspaceId", "agentRunId", "userId");
