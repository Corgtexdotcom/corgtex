-- Immutable authenticated submissions. Legacy model tool arguments are never promoted.
CREATE TABLE "McpToolInput" (
  "id" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "actorKind" TEXT NOT NULL,
  "userId" TEXT, "credentialId" TEXT, "credentialVersion" TEXT, "scopeHash" TEXT,
  "toolName" TEXT NOT NULL, "argumentsJson" TEXT NOT NULL, "requiredScopes" TEXT[],
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "McpToolInput_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "McpToolInput_workspaceId_userId_idx" ON "McpToolInput"("workspaceId", "userId");
CREATE INDEX "McpToolInput_workspaceId_credentialId_idx" ON "McpToolInput"("workspaceId", "credentialId");
ALTER TABLE "McpToolInput" ADD CONSTRAINT "McpToolInput_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
