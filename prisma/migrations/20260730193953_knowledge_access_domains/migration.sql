-- CreateEnum
CREATE TYPE "KnowledgeAccessDomain" AS ENUM ('WORKSPACE', 'FINANCE');

-- AlterTable
ALTER TABLE "BrainSource" ADD COLUMN     "accessDomain" "KnowledgeAccessDomain" NOT NULL DEFAULT 'WORKSPACE';

-- AlterTable
ALTER TABLE "Document" ADD COLUMN     "accessDomain" "KnowledgeAccessDomain" NOT NULL DEFAULT 'WORKSPACE';

-- CreateIndex
CREATE INDEX "BrainSource_workspaceId_accessDomain_archivedAt_idx" ON "BrainSource"("workspaceId", "accessDomain", "archivedAt");

-- CreateIndex
CREATE INDEX "BrainSource_workspaceId_accessDomain_absorbedAt_idx" ON "BrainSource"("workspaceId", "accessDomain", "absorbedAt");

-- CreateIndex
CREATE INDEX "Document_workspaceId_accessDomain_archivedAt_idx" ON "Document"("workspaceId", "accessDomain", "archivedAt");
