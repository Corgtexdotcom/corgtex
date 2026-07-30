-- CreateEnum
CREATE TYPE "FinanceImportApplicationTargetType" AS ENUM ('REPORT_FACT');

-- CreateEnum
CREATE TYPE "FinanceImportApplicationOutcome" AS ENUM ('CREATED', 'UPDATED', 'UNCHANGED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "FinanceImportProfileStatus" AS ENUM ('ACTIVE', 'SUPERSEDED', 'RETIRED');

-- CreateTable
CREATE TABLE "FinanceImportApplication" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "idempotencyKey" VARCHAR(64) NOT NULL,
    "targetType" "FinanceImportApplicationTargetType" NOT NULL,
    "targetFactId" TEXT,
    "beforeValueJson" JSONB,
    "afterValueJson" JSONB,
    "beforeValueHash" VARCHAR(64),
    "afterValueHash" VARCHAR(64),
    "outcome" "FinanceImportApplicationOutcome" NOT NULL,
    "appliedByUserId" TEXT NOT NULL,
    "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FinanceImportApplication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinanceImportProfile" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "sourceFingerprint" VARCHAR(64) NOT NULL,
    "layoutFingerprint" VARCHAR(64) NOT NULL,
    "reportType" "FinanceReportType" NOT NULL,
    "basis" "FinanceAccountingBasis" NOT NULL,
    "cadence" "FinanceReportCadence" NOT NULL,
    "approvedAliasesJson" JSONB NOT NULL,
    "hierarchyMappingJson" JSONB NOT NULL,
    "periodMappingJson" JSONB NOT NULL,
    "approvedFromBatchId" TEXT NOT NULL,
    "approvedByUserId" TEXT NOT NULL,
    "approvedAt" TIMESTAMP(3) NOT NULL,
    "lastSuccessfulUseAt" TIMESTAMP(3),
    "successfulUseCount" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" "FinanceImportProfileStatus" NOT NULL DEFAULT 'ACTIVE',
    "supersedesProfileId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinanceImportProfile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FinanceImportApplication_candidateId_key" ON "FinanceImportApplication"("candidateId");

-- CreateIndex
CREATE INDEX "FinanceImportApplication_workspaceId_batchId_appliedAt_idx" ON "FinanceImportApplication"("workspaceId", "batchId", "appliedAt");

-- CreateIndex
CREATE UNIQUE INDEX "FinanceImportApplication_id_workspaceId_key" ON "FinanceImportApplication"("id", "workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "FinanceImportApplication_candidateId_workspaceId_key" ON "FinanceImportApplication"("candidateId", "workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "FinanceImportApplication_candidateId_batchId_workspaceId_key" ON "FinanceImportApplication"("candidateId", "batchId", "workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "FinanceImportApplication_workspaceId_idempotencyKey_key" ON "FinanceImportApplication"("workspaceId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "FinanceImportProfile_workspaceId_status_lastSuccessfulUseAt_idx" ON "FinanceImportProfile"("workspaceId", "status", "lastSuccessfulUseAt");

-- CreateIndex
CREATE UNIQUE INDEX "FinanceImportProfile_id_workspaceId_key" ON "FinanceImportProfile"("id", "workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "FinanceImportProfile_workspaceId_sourceFingerprint_layoutFi_key" ON "FinanceImportProfile"("workspaceId", "sourceFingerprint", "layoutFingerprint", "version");

-- CreateIndex
CREATE UNIQUE INDEX "FinanceImportProfile_workspaceId_supersedesProfileId_key" ON "FinanceImportProfile"("workspaceId", "supersedesProfileId");

-- CreateIndex
CREATE UNIQUE INDEX "FinanceImportCandidate_id_batchId_workspaceId_key" ON "FinanceImportCandidate"("id", "batchId", "workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "FinanceReport_sourceBatchId_workspaceId_key" ON "FinanceReport"("sourceBatchId", "workspaceId");

-- AddForeignKey
ALTER TABLE "FinanceReport" ADD CONSTRAINT "FinanceReport_sourceBatchId_workspaceId_fkey" FOREIGN KEY ("sourceBatchId", "workspaceId") REFERENCES "FinanceImportBatch"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinanceImportApplication" ADD CONSTRAINT "FinanceImportApplication_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinanceImportApplication" ADD CONSTRAINT "FinanceImportApplication_batchId_workspaceId_fkey" FOREIGN KEY ("batchId", "workspaceId") REFERENCES "FinanceImportBatch"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinanceImportApplication" ADD CONSTRAINT "FinanceImportApplication_candidateId_batchId_workspaceId_fkey" FOREIGN KEY ("candidateId", "batchId", "workspaceId") REFERENCES "FinanceImportCandidate"("id", "batchId", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinanceImportApplication" ADD CONSTRAINT "FinanceImportApplication_targetFactId_workspaceId_fkey" FOREIGN KEY ("targetFactId", "workspaceId") REFERENCES "FinanceReportFact"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinanceImportProfile" ADD CONSTRAINT "FinanceImportProfile_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinanceImportProfile" ADD CONSTRAINT "FinanceImportProfile_approvedFromBatchId_workspaceId_fkey" FOREIGN KEY ("approvedFromBatchId", "workspaceId") REFERENCES "FinanceImportBatch"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinanceImportProfile" ADD CONSTRAINT "FinanceImportProfile_supersedesProfileId_workspaceId_fkey" FOREIGN KEY ("supersedesProfileId", "workspaceId") REFERENCES "FinanceImportProfile"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
