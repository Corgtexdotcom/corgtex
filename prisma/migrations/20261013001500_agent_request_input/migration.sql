CREATE TABLE "AgentRequestInput" (
 "id" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "userId" TEXT NOT NULL, "agentKey" TEXT NOT NULL, "prompt" TEXT NOT NULL, "meetingId" TEXT, "proposalId" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "AgentRequestInput_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "AgentRequestInput" ADD CONSTRAINT "AgentRequestInput_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "AgentRequestInput_workspaceId_userId_agentKey_idx" ON "AgentRequestInput"("workspaceId", "userId", "agentKey");
