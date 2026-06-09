-- AlterTable
ALTER TABLE "CheckIn" ADD COLUMN     "questionType" TEXT NOT NULL DEFAULT 'WELLBEING',
ADD COLUMN     "priority" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'OPEN',
ADD COLUMN     "confidence" DOUBLE PRECISION,
ADD COLUMN     "metadata" JSONB,
ADD COLUMN     "relatedEntityType" TEXT,
ADD COLUMN     "relatedEntityId" TEXT,
ADD COLUMN     "relatedConversationId" TEXT,
ADD COLUMN     "responseUsePolicy" TEXT NOT NULL DEFAULT 'MEMBER_CHECKIN';

-- Preserve existing answered check-ins when introducing explicit status.
UPDATE "CheckIn" SET "status" = 'ANSWERED' WHERE "respondedAt" IS NOT NULL;

-- AlterTable
ALTER TABLE "GoalLink" ADD COLUMN     "source" TEXT,
ADD COLUMN     "metadata" JSONB;

-- CreateIndex
CREATE INDEX "CheckIn_workspaceId_memberId_status_createdAt_idx" ON "CheckIn"("workspaceId", "memberId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "CheckIn_workspaceId_questionType_status_idx" ON "CheckIn"("workspaceId", "questionType", "status");

-- CreateIndex
CREATE INDEX "CheckIn_relatedEntityType_relatedEntityId_idx" ON "CheckIn"("relatedEntityType", "relatedEntityId");

-- CreateIndex
CREATE INDEX "CheckIn_relatedConversationId_idx" ON "CheckIn"("relatedConversationId");

-- CreateIndex
CREATE INDEX "GoalLink_source_idx" ON "GoalLink"("source");

-- AddForeignKey
ALTER TABLE "CheckIn" ADD CONSTRAINT "CheckIn_relatedConversationId_fkey" FOREIGN KEY ("relatedConversationId") REFERENCES "ConversationSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;
