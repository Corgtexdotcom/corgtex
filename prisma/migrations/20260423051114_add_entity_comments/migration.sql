-- AlterTable
ALTER TABLE "Action" ADD COLUMN     "resolvedAt" TIMESTAMP(3),
ADD COLUMN     "resolvedVia" TEXT;

-- AlterTable
ALTER TABLE "Tension" ADD COLUMN     "resolvedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "Comment" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "authorUserId" TEXT NOT NULL,
    "bodyMd" TEXT NOT NULL,
    "mentionedMemberIds" TEXT[],
    "mentionedCircleIds" TEXT[],
    "resolvedAt" TIMESTAMP(3),
    "resolvedNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Comment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Comment_workspaceId_entityType_entityId_idx" ON "Comment"("workspaceId", "entityType", "entityId");

-- CreateIndex
CREATE INDEX "Comment_workspaceId_authorUserId_idx" ON "Comment"("workspaceId", "authorUserId");

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_authorUserId_fkey" FOREIGN KEY ("authorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
