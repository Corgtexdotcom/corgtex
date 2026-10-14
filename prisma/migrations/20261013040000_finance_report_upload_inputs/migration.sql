CREATE TABLE "FinanceReportUploadInput" (
  "id" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "batchId" TEXT NOT NULL,
  "documentId" TEXT NOT NULL, "brainSourceId" TEXT NOT NULL, "uploadedByUserId" TEXT NOT NULL,
  "fileHash" TEXT NOT NULL, "storageKey" TEXT NOT NULL, "mimeType" TEXT NOT NULL,
  "fileSizeBytes" INTEGER NOT NULL, "originalFilename" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FinanceReportUploadInput_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "FinanceReportUploadInput_workspaceId_batchId_key" ON "FinanceReportUploadInput"("workspaceId", "batchId");
CREATE INDEX "FinanceReportUploadInput_workspaceId_uploadedByUserId_idx" ON "FinanceReportUploadInput"("workspaceId", "uploadedByUserId");
ALTER TABLE "FinanceReportUploadInput" ADD CONSTRAINT "FinanceReportUploadInput_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
