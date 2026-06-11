-- CreateTable
CREATE TABLE "WorkItemEvidence" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "entityType" TEXT NOT NULL,
  "entityId" TEXT NOT NULL,
  "documentId" TEXT NOT NULL,
  "purpose" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "WorkItemEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WorkItemEvidence_entityType_entityId_documentId_purpose_key" ON "WorkItemEvidence"("entityType", "entityId", "documentId", "purpose");

-- CreateIndex
CREATE INDEX "WorkItemEvidence_workspaceId_entityType_entityId_idx" ON "WorkItemEvidence"("workspaceId", "entityType", "entityId");

-- CreateIndex
CREATE INDEX "WorkItemEvidence_workspaceId_purpose_idx" ON "WorkItemEvidence"("workspaceId", "purpose");

-- CreateIndex
CREATE INDEX "WorkItemEvidence_documentId_idx" ON "WorkItemEvidence"("documentId");

-- AddForeignKey
ALTER TABLE "WorkItemEvidence" ADD CONSTRAINT "WorkItemEvidence_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkItemEvidence" ADD CONSTRAINT "WorkItemEvidence_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;
