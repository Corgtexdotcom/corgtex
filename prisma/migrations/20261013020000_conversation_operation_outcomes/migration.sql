-- A committed operation fact records only its caller and opaque request identity.
CREATE TABLE "ConversationOperationOutcome" (
  "id" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "actorKind" TEXT NOT NULL,
  "userId" TEXT, "credentialId" TEXT, "credentialVersion" TEXT, "scopeHash" TEXT,
  "operation" TEXT NOT NULL, "requestKey" TEXT NOT NULL, "requiredScopes" TEXT[],
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ConversationOperationOutcome_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ConversationOperationOutcome_workspaceId_requestKey_key" ON "ConversationOperationOutcome"("workspaceId", "requestKey");
CREATE INDEX "ConversationOperationOutcome_workspaceId_userId_idx" ON "ConversationOperationOutcome"("workspaceId", "userId");
CREATE INDEX "ConversationOperationOutcome_workspaceId_credentialId_idx" ON "ConversationOperationOutcome"("workspaceId", "credentialId");
ALTER TABLE "ConversationOperationOutcome" ADD CONSTRAINT "ConversationOperationOutcome_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
