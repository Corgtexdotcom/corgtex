-- CreateEnum
CREATE TYPE "FinanceImportStage" AS ENUM ('UPLOADED', 'CLASSIFYING', 'EXTRACTING', 'MAPPING', 'RECONCILING', 'READY_FOR_REVIEW', 'APPLYING', 'APPLIED', 'NEEDS_INPUT', 'PARTIALLY_APPLIED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "FinanceImportCurrencyState" AS ENUM ('UNRESOLVED', 'RESOLVED');

-- CreateEnum
CREATE TYPE "FinanceImportCurrencySource" AS ENUM ('DOCUMENT', 'WORKSPACE_SINGLE_CURRENCY', 'USER_CONFIRMED');

-- CreateEnum
CREATE TYPE "FinanceImportCandidateAction" AS ENUM ('ADD', 'UPDATE', 'UNCHANGED', 'DUPLICATE', 'CONFLICT', 'SKIP');

-- CreateEnum
CREATE TYPE "FinanceImportCandidateReviewState" AS ENUM ('PROPOSED', 'VERIFIED', 'WARNING', 'BLOCKED', 'APPROVED', 'REJECTED', 'APPLIED');

-- CreateTable
CREATE TABLE "FinanceImportBatch" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "uploadedByUserId" TEXT NOT NULL,
    "documentId" TEXT,
    "brainSourceId" TEXT,
    "workflowJobId" TEXT,
    "agentRunId" TEXT,
    "fileHash" VARCHAR(64) NOT NULL,
    "mimeType" VARCHAR(127) NOT NULL,
    "originalFilename" VARCHAR(255) NOT NULL,
    "fileSizeBytes" INTEGER NOT NULL,
    "stage" "FinanceImportStage" NOT NULL DEFAULT 'UPLOADED',
    "safeErrorCode" VARCHAR(64),
    "safeErrorMessage" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "reportType" "FinanceReportType",
    "basis" "FinanceAccountingBasis",
    "cadence" "FinanceReportCadence",
    "periodStart" DATE,
    "periodEnd" DATE,
    "asOfDate" DATE,
    "title" VARCHAR(200),
    "currencyState" "FinanceImportCurrencyState" NOT NULL DEFAULT 'UNRESOLVED',
    "resolvedCurrency" VARCHAR(3),
    "currencyResolutionSource" "FinanceImportCurrencySource",
    "currencyConfirmedByUserId" TEXT,
    "currencyConfirmedAt" TIMESTAMP(3),
    "addCount" INTEGER NOT NULL DEFAULT 0,
    "updateCount" INTEGER NOT NULL DEFAULT 0,
    "unchangedCount" INTEGER NOT NULL DEFAULT 0,
    "duplicateCount" INTEGER NOT NULL DEFAULT 0,
    "conflictCount" INTEGER NOT NULL DEFAULT 0,
    "skippedCount" INTEGER NOT NULL DEFAULT 0,
    "warningCount" INTEGER NOT NULL DEFAULT 0,
    "blockerCount" INTEGER NOT NULL DEFAULT 0,
    "rejectedCount" INTEGER NOT NULL DEFAULT 0,
    "appliedCount" INTEGER NOT NULL DEFAULT 0,
    "approvedByUserId" TEXT,
    "approvedAt" TIMESTAMP(3),
    "appliedByUserId" TEXT,
    "appliedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinanceImportBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinanceImportCandidate" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "sourceKey" VARCHAR(64) NOT NULL,
    "sourceLocation" JSONB NOT NULL,
    "sourceLabel" VARCHAR(500) NOT NULL,
    "sourcePath" TEXT[],
    "proposedAccountPath" TEXT[],
    "factKind" "FinanceReportFactKind" NOT NULL,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "dimensions" JSONB,
    "extractionJson" JSONB NOT NULL,
    "proposalJson" JSONB NOT NULL,
    "action" "FinanceImportCandidateAction" NOT NULL,
    "reviewState" "FinanceImportCandidateReviewState" NOT NULL DEFAULT 'PROPOSED',
    "semanticKey" VARCHAR(64),
    "currentFactId" TEXT,
    "currentAmountCents" INTEGER,
    "confidenceBps" INTEGER NOT NULL,
    "evidenceMd" TEXT NOT NULL,
    "explanationMd" TEXT,
    "editedByUserId" TEXT,
    "editedAt" TIMESTAMP(3),
    "approvedByUserId" TEXT,
    "approvedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinanceImportCandidate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FinanceImportBatch_documentId_key" ON "FinanceImportBatch"("documentId");

-- CreateIndex
CREATE UNIQUE INDEX "FinanceImportBatch_brainSourceId_key" ON "FinanceImportBatch"("brainSourceId");

-- CreateIndex
CREATE INDEX "FinanceImportBatch_workspaceId_stage_createdAt_idx" ON "FinanceImportBatch"("workspaceId", "stage", "createdAt");

-- CreateIndex
CREATE INDEX "FinanceImportBatch_workflowJobId_idx" ON "FinanceImportBatch"("workflowJobId");

-- CreateIndex
CREATE INDEX "FinanceImportBatch_agentRunId_idx" ON "FinanceImportBatch"("agentRunId");

-- CreateIndex
CREATE UNIQUE INDEX "FinanceImportBatch_id_workspaceId_key" ON "FinanceImportBatch"("id", "workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "FinanceImportBatch_workspaceId_fileHash_key" ON "FinanceImportBatch"("workspaceId", "fileHash");

-- CreateIndex
CREATE INDEX "FinanceImportCandidate_workspaceId_batchId_reviewState_idx" ON "FinanceImportCandidate"("workspaceId", "batchId", "reviewState");

-- CreateIndex
CREATE INDEX "FinanceImportCandidate_workspaceId_semanticKey_idx" ON "FinanceImportCandidate"("workspaceId", "semanticKey");

-- CreateIndex
CREATE UNIQUE INDEX "FinanceImportCandidate_id_workspaceId_key" ON "FinanceImportCandidate"("id", "workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "FinanceImportCandidate_batchId_sourceKey_key" ON "FinanceImportCandidate"("batchId", "sourceKey");

-- CreateIndex
CREATE UNIQUE INDEX "FinanceReportFact_id_workspaceId_key" ON "FinanceReportFact"("id", "workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentRun_id_workspaceId_key" ON "AgentRun"("id", "workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "BrainSource_id_workspaceId_key" ON "BrainSource"("id", "workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "Document_id_workspaceId_key" ON "Document"("id", "workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowJob_id_workspaceId_key" ON "WorkflowJob"("id", "workspaceId");

-- AddForeignKey
ALTER TABLE "FinanceImportBatch" ADD CONSTRAINT "FinanceImportBatch_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinanceImportBatch" ADD CONSTRAINT "FinanceImportBatch_documentId_workspaceId_fkey" FOREIGN KEY ("documentId", "workspaceId") REFERENCES "Document"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinanceImportBatch" ADD CONSTRAINT "FinanceImportBatch_brainSourceId_workspaceId_fkey" FOREIGN KEY ("brainSourceId", "workspaceId") REFERENCES "BrainSource"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinanceImportBatch" ADD CONSTRAINT "FinanceImportBatch_workflowJobId_workspaceId_fkey" FOREIGN KEY ("workflowJobId", "workspaceId") REFERENCES "WorkflowJob"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinanceImportBatch" ADD CONSTRAINT "FinanceImportBatch_agentRunId_workspaceId_fkey" FOREIGN KEY ("agentRunId", "workspaceId") REFERENCES "AgentRun"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinanceImportCandidate" ADD CONSTRAINT "FinanceImportCandidate_batchId_workspaceId_fkey" FOREIGN KEY ("batchId", "workspaceId") REFERENCES "FinanceImportBatch"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinanceImportCandidate" ADD CONSTRAINT "FinanceImportCandidate_currentFactId_workspaceId_fkey" FOREIGN KEY ("currentFactId", "workspaceId") REFERENCES "FinanceReportFact"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
