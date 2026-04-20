-- AlterEnum
ALTER TYPE "KnowledgeSourceType" ADD VALUE 'EXTERNAL_DATABASE';

-- CreateTable
CREATE TABLE "ExternalDataSource" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "driverType" TEXT NOT NULL DEFAULT 'postgres',
    "connectionStringEnc" TEXT NOT NULL,
    "selectedTables" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "pullCadenceMinutes" INTEGER NOT NULL DEFAULT 60,
    "cursorColumn" TEXT NOT NULL DEFAULT 'updated_at',
    "lastCursorValue" TEXT,
    "lastSyncAt" TIMESTAMP(3),
    "lastSyncError" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExternalDataSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExternalDataSyncLog" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "rowsProcessed" INTEGER NOT NULL DEFAULT 0,
    "chunksCreated" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "ExternalDataSyncLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ExternalDataSource_workspaceId_isActive_idx" ON "ExternalDataSource"("workspaceId", "isActive");

-- CreateIndex
CREATE INDEX "ExternalDataSyncLog_sourceId_startedAt_idx" ON "ExternalDataSyncLog"("sourceId", "startedAt");

-- AddForeignKey
ALTER TABLE "ExternalDataSource" ADD CONSTRAINT "ExternalDataSource_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalDataSyncLog" ADD CONSTRAINT "ExternalDataSyncLog_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "ExternalDataSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;
