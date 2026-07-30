-- CreateEnum
CREATE TYPE "FinanceReportType" AS ENUM ('PROFIT_AND_LOSS', 'BALANCE_SHEET', 'CASH_FLOW', 'TRIAL_BALANCE', 'OTHER');

-- CreateEnum
CREATE TYPE "FinanceAccountingBasis" AS ENUM ('CASH', 'ACCRUAL', 'UNSPECIFIED');

-- CreateEnum
CREATE TYPE "FinanceReportCadence" AS ENUM ('DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY', 'ANNUAL', 'CUSTOM');

-- CreateEnum
CREATE TYPE "FinanceReportStatus" AS ENUM ('ACTIVE', 'SUPERSEDED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "FinanceReportFactKind" AS ENUM ('LEAF', 'DERIVED');

-- CreateTable
CREATE TABLE "FinanceReport" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "reportType" "FinanceReportType" NOT NULL,
    "basis" "FinanceAccountingBasis" NOT NULL,
    "cadence" "FinanceReportCadence" NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "asOfDate" DATE,
    "title" VARCHAR(200) NOT NULL,
    "status" "FinanceReportStatus" NOT NULL DEFAULT 'ACTIVE',
    "sourceBatchId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinanceReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinanceReportFact" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "accountPath" TEXT[],
    "kind" "FinanceReportFactKind" NOT NULL,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "dimensions" JSONB,
    "semanticKey" VARCHAR(64) NOT NULL,
    "sourceBatchId" TEXT NOT NULL,
    "sourceCandidateId" TEXT NOT NULL,
    "appliedByUserId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinanceReportFact_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FinanceReport_sourceBatchId_key" ON "FinanceReport"("sourceBatchId");

-- CreateIndex
CREATE UNIQUE INDEX "FinanceReport_id_workspaceId_key" ON "FinanceReport"("id", "workspaceId");

-- CreateIndex
CREATE INDEX "FinanceReport_workspaceId_status_idx" ON "FinanceReport"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "FinanceReport_workspaceId_periodEnd_idx" ON "FinanceReport"("workspaceId", "periodEnd");

-- CreateIndex
CREATE UNIQUE INDEX "FinanceReportFact_sourceCandidateId_key" ON "FinanceReportFact"("sourceCandidateId");

-- CreateIndex
CREATE INDEX "FinanceReportFact_workspaceId_reportId_idx" ON "FinanceReportFact"("workspaceId", "reportId");

-- CreateIndex
CREATE INDEX "FinanceReportFact_workspaceId_periodStart_periodEnd_idx" ON "FinanceReportFact"("workspaceId", "periodStart", "periodEnd");

-- CreateIndex
CREATE INDEX "FinanceReportFact_sourceBatchId_idx" ON "FinanceReportFact"("sourceBatchId");

-- CreateIndex
CREATE UNIQUE INDEX "FinanceReportFact_workspaceId_semanticKey_key" ON "FinanceReportFact"("workspaceId", "semanticKey");

-- AddForeignKey
ALTER TABLE "FinanceReport" ADD CONSTRAINT "FinanceReport_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinanceReportFact" ADD CONSTRAINT "FinanceReportFact_reportId_workspaceId_fkey" FOREIGN KEY ("reportId", "workspaceId") REFERENCES "FinanceReport"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
