-- CreateTable
CREATE TABLE "ActionChecklistItem" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "actionId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "completedAt" TIMESTAMP(3),
    "completedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ActionChecklistItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ActionChecklistItem_workspaceId_actionId_sortOrder_idx" ON "ActionChecklistItem"("workspaceId", "actionId", "sortOrder");

-- CreateIndex
CREATE INDEX "ActionChecklistItem_workspaceId_completedAt_idx" ON "ActionChecklistItem"("workspaceId", "completedAt");

-- AddForeignKey
ALTER TABLE "ActionChecklistItem" ADD CONSTRAINT "ActionChecklistItem_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActionChecklistItem" ADD CONSTRAINT "ActionChecklistItem_actionId_fkey" FOREIGN KEY ("actionId") REFERENCES "Action"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActionChecklistItem" ADD CONSTRAINT "ActionChecklistItem_completedByUserId_fkey" FOREIGN KEY ("completedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
