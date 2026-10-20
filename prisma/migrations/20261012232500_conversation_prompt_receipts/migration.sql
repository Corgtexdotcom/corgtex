-- Additive input identity; legacy turns remain unproved until rebuilt.
CREATE TABLE "ConversationPromptInput" (
 "id" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "sessionId" TEXT NOT NULL, "userId" TEXT NOT NULL, "content" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "ConversationPromptInput_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "ConversationPromptInput" ADD CONSTRAINT "ConversationPromptInput_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConversationPromptInput" ADD CONSTRAINT "ConversationPromptInput_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ConversationSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "ConversationPromptInput_workspaceId_sessionId_userId_idx" ON "ConversationPromptInput"("workspaceId", "sessionId", "userId");
ALTER TABLE "ConversationTurn" ADD COLUMN "promptInputId" TEXT;
ALTER TABLE "ConversationTurn" ADD CONSTRAINT "ConversationTurn_promptInputId_fkey" FOREIGN KEY ("promptInputId") REFERENCES "ConversationPromptInput"("id") ON DELETE SET NULL ON UPDATE CASCADE;
