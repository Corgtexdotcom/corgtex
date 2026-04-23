-- CreateTable
CREATE TABLE "DeliberationEntry" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "parentType" TEXT NOT NULL,
    "parentId" TEXT NOT NULL,
    "authorUserId" TEXT NOT NULL,
    "entryType" TEXT NOT NULL,
    "bodyMd" TEXT,
    "targetMemberId" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolvedNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeliberationEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DeliberationEntry_parentType_parentId_createdAt_idx" ON "DeliberationEntry"("parentType", "parentId", "createdAt");

-- CreateIndex
CREATE INDEX "DeliberationEntry_workspaceId_parentType_idx" ON "DeliberationEntry"("workspaceId", "parentType");

-- AddForeignKey
ALTER TABLE "DeliberationEntry" ADD CONSTRAINT "DeliberationEntry_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliberationEntry" ADD CONSTRAINT "DeliberationEntry_authorUserId_fkey" FOREIGN KEY ("authorUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
