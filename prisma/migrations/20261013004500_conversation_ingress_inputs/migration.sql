-- Native authenticated ingress. Legacy fabricated sessions are never backfilled as proof.
CREATE TABLE "ConversationIngressInput" (
  "id" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "actorKind" TEXT NOT NULL,
  "userId" TEXT, "credentialId" TEXT, "credentialVersion" TEXT, "scopeHash" TEXT,
  "content" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ConversationIngressInput_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ConversationIngressInput_workspaceId_userId_idx" ON "ConversationIngressInput"("workspaceId", "userId");
CREATE INDEX "ConversationIngressInput_workspaceId_credentialId_idx" ON "ConversationIngressInput"("workspaceId", "credentialId");
ALTER TABLE "ConversationIngressInput" ADD CONSTRAINT "ConversationIngressInput_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
