-- AlterTable
ALTER TABLE "KnowledgeChunk" ADD COLUMN     "accessDomain" "KnowledgeAccessDomain" NOT NULL DEFAULT 'WORKSPACE';

-- CreateIndex
CREATE INDEX "KnowledgeChunk_workspaceId_accessDomain_sourceType_sourceId_idx" ON "KnowledgeChunk"("workspaceId", "accessDomain", "sourceType", "sourceId");
