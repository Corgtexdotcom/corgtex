-- AlterTable
ALTER TABLE "Action" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "Tension" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "Proposal" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "SpendRequest" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "Goal" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "DeliberationEntry" ADD COLUMN "parentVersion" INTEGER;

-- CreateTable
CREATE TABLE "WorkItemVersion" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "changedFields" TEXT[],
    "previousState" JSONB NOT NULL,
    "actorUserId" TEXT,
    "actorLabel" TEXT,
    "source" TEXT NOT NULL DEFAULT 'WEB',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkItemVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DeliberationEntry_parentType_parentId_parentVersion_idx" ON "DeliberationEntry"("parentType", "parentId", "parentVersion");

-- CreateIndex
CREATE UNIQUE INDEX "WorkItemVersion_entityType_entityId_version_key" ON "WorkItemVersion"("entityType", "entityId", "version");

-- CreateIndex
CREATE INDEX "WorkItemVersion_workspaceId_entityType_entityId_version_idx" ON "WorkItemVersion"("workspaceId", "entityType", "entityId", "version");

-- CreateIndex
CREATE INDEX "WorkItemVersion_workspaceId_createdAt_idx" ON "WorkItemVersion"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "WorkItemVersion_actorUserId_createdAt_idx" ON "WorkItemVersion"("actorUserId", "createdAt");

-- AddForeignKey
ALTER TABLE "WorkItemVersion" ADD CONSTRAINT "WorkItemVersion_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkItemVersion" ADD CONSTRAINT "WorkItemVersion_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
