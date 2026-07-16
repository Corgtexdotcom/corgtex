-- CreateEnum
CREATE TYPE "PracticeClientStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "PracticeProjectLineKind" AS ENUM ('SERVICES', 'EXPENSES', 'SUBSCRIPTIONS', 'COMMISSION', 'INTERNAL');

-- CreateEnum
CREATE TYPE "PracticeEntryStatus" AS ENUM ('POSTED', 'REVERSED');

-- CreateEnum
CREATE TYPE "PracticeSourceDocumentType" AS ENUM ('INVOICE', 'STATEMENT', 'RECEIPT', 'TIMESHEET', 'OTHER');

-- CreateEnum
CREATE TYPE "PracticeSourceDocumentStatus" AS ENUM ('POSTED', 'NEEDS_REVIEW', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "PracticeEntryReviewTarget" AS ENUM ('TIME_ENTRY', 'EXPENSE');

-- CreateEnum
CREATE TYPE "PracticeEntryReviewStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'APPROVED', 'SETTLED');

-- AlterTable
ALTER TABLE "PracticeProject" ADD COLUMN     "billingCodeId" TEXT,
ADD COLUMN     "clientId" TEXT,
ADD COLUMN     "currency" TEXT NOT NULL DEFAULT 'USD',
ADD COLUMN     "endsOn" TIMESTAMP(3),
ADD COLUMN     "startsOn" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "PracticeClient" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "crmAccountId" TEXT,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "leadName" TEXT,
    "status" "PracticeClientStatus" NOT NULL DEFAULT 'ACTIVE',
    "sourceSatelliteId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PracticeClient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PracticeBillingCode" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "clientId" TEXT,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "billable" BOOLEAN NOT NULL DEFAULT true,
    "sourceSatelliteId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PracticeBillingCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PracticeConsultant" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "homeCurrency" TEXT NOT NULL DEFAULT 'USD',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sourceSatelliteId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PracticeConsultant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PracticeProjectLine" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "kind" "PracticeProjectLineKind" NOT NULL,
    "name" TEXT NOT NULL,
    "budgetCents" INTEGER NOT NULL DEFAULT 0,
    "billRateCents" INTEGER,
    "costRateCents" INTEGER,
    "sourceSatelliteId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PracticeProjectLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PracticePurchaseOrder" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "poNumber" TEXT NOT NULL,
    "issuedOn" TIMESTAMP(3),
    "amountCents" INTEGER NOT NULL DEFAULT 0,
    "remainingPriorCents" INTEGER NOT NULL DEFAULT 0,
    "sourceSatelliteId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PracticePurchaseOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PracticeProjectAssignment" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "consultantId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "sourceSatelliteId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PracticeProjectAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PracticeSourceDocument" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "type" "PracticeSourceDocumentType" NOT NULL,
    "status" "PracticeSourceDocumentStatus" NOT NULL DEFAULT 'POSTED',
    "fileName" TEXT,
    "mimeType" TEXT,
    "storageKey" TEXT,
    "contentHash" TEXT,
    "parserClient" TEXT,
    "parserConfidence" DECIMAL(5,4),
    "submittedPayload" JSONB,
    "createdRecords" JSONB,
    "sourceSatelliteId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PracticeSourceDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PracticePaymentBatch" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "consultantId" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "totalAmountCents" INTEGER NOT NULL DEFAULT 0,
    "cashAmountCents" INTEGER NOT NULL DEFAULT 0,
    "sliceAmountCents" INTEGER NOT NULL DEFAULT 0,
    "memo" TEXT,
    "settledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sourceSatelliteId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PracticePaymentBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PracticeTimeEntry" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "billingCodeId" TEXT,
    "projectId" TEXT NOT NULL,
    "projectLineId" TEXT,
    "consultantId" TEXT NOT NULL,
    "sourceDocumentId" TEXT,
    "paymentBatchId" TEXT,
    "workedOn" TIMESTAMP(3) NOT NULL,
    "weekEndingOn" TIMESTAMP(3) NOT NULL,
    "hours" DECIMAL(8,2) NOT NULL,
    "assignmentType" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "billCurrency" TEXT,
    "costCurrency" TEXT,
    "functionalCurrency" TEXT,
    "billRateCents" INTEGER NOT NULL DEFAULT 0,
    "costRateCents" INTEGER NOT NULL DEFAULT 0,
    "billAmountCents" INTEGER,
    "costAmountCents" INTEGER,
    "paidAmountCents" INTEGER,
    "status" "PracticeEntryStatus" NOT NULL DEFAULT 'POSTED',
    "sourceSatelliteId" TEXT,
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PracticeTimeEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PracticeExpense" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "billingCodeId" TEXT,
    "projectId" TEXT NOT NULL,
    "projectLineId" TEXT,
    "consultantId" TEXT,
    "sourceDocumentId" TEXT,
    "paymentBatchId" TEXT,
    "spentOn" TIMESTAMP(3) NOT NULL,
    "vendor" TEXT,
    "category" TEXT NOT NULL,
    "businessPurpose" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "amountFunctionalCents" INTEGER,
    "functionalCurrency" TEXT,
    "billable" BOOLEAN NOT NULL DEFAULT true,
    "status" "PracticeEntryStatus" NOT NULL DEFAULT 'POSTED',
    "sourceSatelliteId" TEXT,
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PracticeExpense_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PracticeEntryReview" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "targetType" "PracticeEntryReviewTarget" NOT NULL,
    "timeEntryId" TEXT,
    "expenseId" TEXT,
    "status" "PracticeEntryReviewStatus" NOT NULL DEFAULT 'SUBMITTED',
    "note" TEXT,
    "reviewedByUserId" TEXT,
    "sourceSatelliteId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PracticeEntryReview_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PracticeClient_workspaceId_status_idx" ON "PracticeClient"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "PracticeClient_workspaceId_crmAccountId_idx" ON "PracticeClient"("workspaceId", "crmAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "PracticeClient_workspaceId_code_key" ON "PracticeClient"("workspaceId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "PracticeClient_workspaceId_sourceSatelliteId_key" ON "PracticeClient"("workspaceId", "sourceSatelliteId");

-- CreateIndex
CREATE INDEX "PracticeBillingCode_workspaceId_clientId_idx" ON "PracticeBillingCode"("workspaceId", "clientId");

-- CreateIndex
CREATE UNIQUE INDEX "PracticeBillingCode_workspaceId_code_key" ON "PracticeBillingCode"("workspaceId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "PracticeBillingCode_workspaceId_sourceSatelliteId_key" ON "PracticeBillingCode"("workspaceId", "sourceSatelliteId");

-- CreateIndex
CREATE INDEX "PracticeConsultant_workspaceId_active_idx" ON "PracticeConsultant"("workspaceId", "active");

-- CreateIndex
CREATE INDEX "PracticeConsultant_workspaceId_email_idx" ON "PracticeConsultant"("workspaceId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "PracticeConsultant_workspaceId_sourceSatelliteId_key" ON "PracticeConsultant"("workspaceId", "sourceSatelliteId");

-- CreateIndex
CREATE INDEX "PracticeProjectLine_workspaceId_projectId_idx" ON "PracticeProjectLine"("workspaceId", "projectId");

-- CreateIndex
CREATE INDEX "PracticeProjectLine_projectId_kind_idx" ON "PracticeProjectLine"("projectId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "PracticeProjectLine_workspaceId_sourceSatelliteId_key" ON "PracticeProjectLine"("workspaceId", "sourceSatelliteId");

-- CreateIndex
CREATE INDEX "PracticePurchaseOrder_workspaceId_projectId_idx" ON "PracticePurchaseOrder"("workspaceId", "projectId");

-- CreateIndex
CREATE UNIQUE INDEX "PracticePurchaseOrder_projectId_poNumber_key" ON "PracticePurchaseOrder"("projectId", "poNumber");

-- CreateIndex
CREATE UNIQUE INDEX "PracticePurchaseOrder_workspaceId_sourceSatelliteId_key" ON "PracticePurchaseOrder"("workspaceId", "sourceSatelliteId");

-- CreateIndex
CREATE INDEX "PracticeProjectAssignment_workspaceId_projectId_idx" ON "PracticeProjectAssignment"("workspaceId", "projectId");

-- CreateIndex
CREATE INDEX "PracticeProjectAssignment_workspaceId_consultantId_idx" ON "PracticeProjectAssignment"("workspaceId", "consultantId");

-- CreateIndex
CREATE UNIQUE INDEX "PracticeProjectAssignment_workspaceId_projectId_consultantI_key" ON "PracticeProjectAssignment"("workspaceId", "projectId", "consultantId");

-- CreateIndex
CREATE UNIQUE INDEX "PracticeProjectAssignment_workspaceId_sourceSatelliteId_key" ON "PracticeProjectAssignment"("workspaceId", "sourceSatelliteId");

-- CreateIndex
CREATE INDEX "PracticeSourceDocument_workspaceId_type_idx" ON "PracticeSourceDocument"("workspaceId", "type");

-- CreateIndex
CREATE INDEX "PracticeSourceDocument_workspaceId_contentHash_idx" ON "PracticeSourceDocument"("workspaceId", "contentHash");

-- CreateIndex
CREATE UNIQUE INDEX "PracticeSourceDocument_workspaceId_sourceSatelliteId_key" ON "PracticeSourceDocument"("workspaceId", "sourceSatelliteId");

-- CreateIndex
CREATE INDEX "PracticePaymentBatch_workspaceId_consultantId_settledAt_idx" ON "PracticePaymentBatch"("workspaceId", "consultantId", "settledAt");

-- CreateIndex
CREATE UNIQUE INDEX "PracticePaymentBatch_workspaceId_sourceSatelliteId_key" ON "PracticePaymentBatch"("workspaceId", "sourceSatelliteId");

-- CreateIndex
CREATE INDEX "PracticeTimeEntry_workspaceId_workedOn_idx" ON "PracticeTimeEntry"("workspaceId", "workedOn");

-- CreateIndex
CREATE INDEX "PracticeTimeEntry_projectId_weekEndingOn_idx" ON "PracticeTimeEntry"("projectId", "weekEndingOn");

-- CreateIndex
CREATE INDEX "PracticeTimeEntry_consultantId_weekEndingOn_idx" ON "PracticeTimeEntry"("consultantId", "weekEndingOn");

-- CreateIndex
CREATE INDEX "PracticeTimeEntry_paymentBatchId_idx" ON "PracticeTimeEntry"("paymentBatchId");

-- CreateIndex
CREATE UNIQUE INDEX "PracticeTimeEntry_workspaceId_sourceSatelliteId_key" ON "PracticeTimeEntry"("workspaceId", "sourceSatelliteId");

-- CreateIndex
CREATE UNIQUE INDEX "PracticeTimeEntry_workspaceId_idempotencyKey_key" ON "PracticeTimeEntry"("workspaceId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "PracticeExpense_workspaceId_spentOn_idx" ON "PracticeExpense"("workspaceId", "spentOn");

-- CreateIndex
CREATE INDEX "PracticeExpense_projectId_spentOn_idx" ON "PracticeExpense"("projectId", "spentOn");

-- CreateIndex
CREATE INDEX "PracticeExpense_consultantId_spentOn_idx" ON "PracticeExpense"("consultantId", "spentOn");

-- CreateIndex
CREATE INDEX "PracticeExpense_paymentBatchId_idx" ON "PracticeExpense"("paymentBatchId");

-- CreateIndex
CREATE UNIQUE INDEX "PracticeExpense_workspaceId_sourceSatelliteId_key" ON "PracticeExpense"("workspaceId", "sourceSatelliteId");

-- CreateIndex
CREATE UNIQUE INDEX "PracticeExpense_workspaceId_idempotencyKey_key" ON "PracticeExpense"("workspaceId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "PracticeEntryReview_workspaceId_status_idx" ON "PracticeEntryReview"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "PracticeEntryReview_timeEntryId_idx" ON "PracticeEntryReview"("timeEntryId");

-- CreateIndex
CREATE INDEX "PracticeEntryReview_expenseId_idx" ON "PracticeEntryReview"("expenseId");

-- CreateIndex
CREATE UNIQUE INDEX "PracticeEntryReview_workspaceId_sourceSatelliteId_key" ON "PracticeEntryReview"("workspaceId", "sourceSatelliteId");

-- CreateIndex
CREATE UNIQUE INDEX "PracticeEntryReview_workspaceId_targetType_timeEntryId_key" ON "PracticeEntryReview"("workspaceId", "targetType", "timeEntryId");

-- CreateIndex
CREATE UNIQUE INDEX "PracticeEntryReview_workspaceId_targetType_expenseId_key" ON "PracticeEntryReview"("workspaceId", "targetType", "expenseId");

-- CreateIndex
CREATE INDEX "PracticeProject_workspaceId_clientId_idx" ON "PracticeProject"("workspaceId", "clientId");

-- CreateIndex
CREATE INDEX "PracticeProject_workspaceId_billingCodeId_idx" ON "PracticeProject"("workspaceId", "billingCodeId");

-- AddForeignKey
ALTER TABLE "PracticeClient" ADD CONSTRAINT "PracticeClient_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PracticeClient" ADD CONSTRAINT "PracticeClient_crmAccountId_fkey" FOREIGN KEY ("crmAccountId") REFERENCES "CrmAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PracticeBillingCode" ADD CONSTRAINT "PracticeBillingCode_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PracticeBillingCode" ADD CONSTRAINT "PracticeBillingCode_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "PracticeClient"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PracticeConsultant" ADD CONSTRAINT "PracticeConsultant_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PracticeProject" ADD CONSTRAINT "PracticeProject_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "PracticeClient"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PracticeProject" ADD CONSTRAINT "PracticeProject_billingCodeId_fkey" FOREIGN KEY ("billingCodeId") REFERENCES "PracticeBillingCode"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PracticeProjectLine" ADD CONSTRAINT "PracticeProjectLine_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PracticeProjectLine" ADD CONSTRAINT "PracticeProjectLine_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "PracticeProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PracticePurchaseOrder" ADD CONSTRAINT "PracticePurchaseOrder_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PracticePurchaseOrder" ADD CONSTRAINT "PracticePurchaseOrder_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "PracticeProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PracticeProjectAssignment" ADD CONSTRAINT "PracticeProjectAssignment_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PracticeProjectAssignment" ADD CONSTRAINT "PracticeProjectAssignment_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "PracticeProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PracticeProjectAssignment" ADD CONSTRAINT "PracticeProjectAssignment_consultantId_fkey" FOREIGN KEY ("consultantId") REFERENCES "PracticeConsultant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PracticeSourceDocument" ADD CONSTRAINT "PracticeSourceDocument_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PracticePaymentBatch" ADD CONSTRAINT "PracticePaymentBatch_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PracticePaymentBatch" ADD CONSTRAINT "PracticePaymentBatch_consultantId_fkey" FOREIGN KEY ("consultantId") REFERENCES "PracticeConsultant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PracticeTimeEntry" ADD CONSTRAINT "PracticeTimeEntry_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PracticeTimeEntry" ADD CONSTRAINT "PracticeTimeEntry_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "PracticeClient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PracticeTimeEntry" ADD CONSTRAINT "PracticeTimeEntry_billingCodeId_fkey" FOREIGN KEY ("billingCodeId") REFERENCES "PracticeBillingCode"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PracticeTimeEntry" ADD CONSTRAINT "PracticeTimeEntry_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "PracticeProject"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PracticeTimeEntry" ADD CONSTRAINT "PracticeTimeEntry_projectLineId_fkey" FOREIGN KEY ("projectLineId") REFERENCES "PracticeProjectLine"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PracticeTimeEntry" ADD CONSTRAINT "PracticeTimeEntry_consultantId_fkey" FOREIGN KEY ("consultantId") REFERENCES "PracticeConsultant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PracticeTimeEntry" ADD CONSTRAINT "PracticeTimeEntry_sourceDocumentId_fkey" FOREIGN KEY ("sourceDocumentId") REFERENCES "PracticeSourceDocument"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PracticeTimeEntry" ADD CONSTRAINT "PracticeTimeEntry_paymentBatchId_fkey" FOREIGN KEY ("paymentBatchId") REFERENCES "PracticePaymentBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PracticeExpense" ADD CONSTRAINT "PracticeExpense_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PracticeExpense" ADD CONSTRAINT "PracticeExpense_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "PracticeClient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PracticeExpense" ADD CONSTRAINT "PracticeExpense_billingCodeId_fkey" FOREIGN KEY ("billingCodeId") REFERENCES "PracticeBillingCode"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PracticeExpense" ADD CONSTRAINT "PracticeExpense_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "PracticeProject"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PracticeExpense" ADD CONSTRAINT "PracticeExpense_projectLineId_fkey" FOREIGN KEY ("projectLineId") REFERENCES "PracticeProjectLine"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PracticeExpense" ADD CONSTRAINT "PracticeExpense_consultantId_fkey" FOREIGN KEY ("consultantId") REFERENCES "PracticeConsultant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PracticeExpense" ADD CONSTRAINT "PracticeExpense_sourceDocumentId_fkey" FOREIGN KEY ("sourceDocumentId") REFERENCES "PracticeSourceDocument"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PracticeExpense" ADD CONSTRAINT "PracticeExpense_paymentBatchId_fkey" FOREIGN KEY ("paymentBatchId") REFERENCES "PracticePaymentBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PracticeEntryReview" ADD CONSTRAINT "PracticeEntryReview_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PracticeEntryReview" ADD CONSTRAINT "PracticeEntryReview_timeEntryId_fkey" FOREIGN KEY ("timeEntryId") REFERENCES "PracticeTimeEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PracticeEntryReview" ADD CONSTRAINT "PracticeEntryReview_expenseId_fkey" FOREIGN KEY ("expenseId") REFERENCES "PracticeExpense"("id") ON DELETE CASCADE ON UPDATE CASCADE;

