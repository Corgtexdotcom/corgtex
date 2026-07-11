-- CreateTable
CREATE TABLE "NewspaperEdition" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "workflowJobId" TEXT,
    "cadence" "NewspaperCadence" NOT NULL,
    "dateKey" TEXT NOT NULL,
    "runKey" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "digestJson" JSONB NOT NULL,
    "bodyMd" TEXT NOT NULL,
    "sourceCounts" JSONB NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NewspaperEdition_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "NewspaperEdition_workspaceId_generatedAt_idx" ON "NewspaperEdition"("workspaceId", "generatedAt");

-- CreateIndex
CREATE INDEX "NewspaperEdition_workflowJobId_idx" ON "NewspaperEdition"("workflowJobId");

-- CreateIndex
CREATE UNIQUE INDEX "NewspaperEdition_workspaceId_cadence_dateKey_key" ON "NewspaperEdition"("workspaceId", "cadence", "dateKey");

-- CreateIndex
CREATE UNIQUE INDEX "NewspaperEdition_workspaceId_runKey_key" ON "NewspaperEdition"("workspaceId", "runKey");

-- AddForeignKey
ALTER TABLE "NewspaperEdition" ADD CONSTRAINT "NewspaperEdition_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NewspaperEdition" ADD CONSTRAINT "NewspaperEdition_workflowJobId_fkey" FOREIGN KEY ("workflowJobId") REFERENCES "WorkflowJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;
