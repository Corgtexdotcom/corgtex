-- CreateEnum
CREATE TYPE "FinanceRecordStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "FinanceProjectStatus" AS ENUM ('ACTIVE', 'PAUSED', 'COMPLETED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "FinanceEntryStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'APPROVED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "FinanceContributionType" AS ENUM ('TIME', 'EXPENSE', 'CAPITAL');

-- CreateEnum
CREATE TYPE "FinanceContributionPaymentChoice" AS ENUM ('CASH', 'SLICING_PIE', 'CAPITAL');

-- CreateEnum
CREATE TYPE "FinanceContributionCashStatus" AS ENUM ('NOT_APPLICABLE', 'REQUESTED', 'PAID');

-- CreateTable
CREATE TABLE "FinanceClient" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "FinanceRecordStatus" NOT NULL DEFAULT 'ACTIVE',
    "notesMd" TEXT,
    "createdByUserId" TEXT,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinanceClient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinanceConsultant" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "memberId" TEXT,
    "status" "FinanceRecordStatus" NOT NULL DEFAULT 'ACTIVE',
    "defaultRateCents" INTEGER,
    "createdByUserId" TEXT,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinanceConsultant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinanceProject" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "clientId" TEXT,
    "name" TEXT NOT NULL,
    "status" "FinanceProjectStatus" NOT NULL DEFAULT 'ACTIVE',
    "budgetCents" INTEGER,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'USD',
    "createdByUserId" TEXT,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinanceProject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinanceTimeEntry" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT,
    "consultantId" TEXT,
    "occurredOn" TIMESTAMP(3) NOT NULL,
    "minutes" INTEGER NOT NULL,
    "rateCents" INTEGER,
    "status" "FinanceEntryStatus" NOT NULL DEFAULT 'SUBMITTED',
    "notesMd" TEXT,
    "createdByUserId" TEXT,
    "approvedByUserId" TEXT,
    "approvedAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinanceTimeEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinanceExpense" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT,
    "consultantId" TEXT,
    "occurredOn" TIMESTAMP(3) NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'USD',
    "status" "FinanceEntryStatus" NOT NULL DEFAULT 'SUBMITTED',
    "notesMd" TEXT,
    "createdByUserId" TEXT,
    "approvedByUserId" TEXT,
    "approvedAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinanceExpense_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinanceContributionEntry" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT,
    "consultantId" TEXT,
    "contributorUserId" TEXT,
    "submittedByUserId" TEXT,
    "type" "FinanceContributionType" NOT NULL,
    "paymentChoice" "FinanceContributionPaymentChoice" NOT NULL,
    "cashStatus" "FinanceContributionCashStatus" NOT NULL DEFAULT 'NOT_APPLICABLE',
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "minutes" INTEGER,
    "amountCents" INTEGER,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'USD',
    "descriptionMd" TEXT,
    "paidByUserId" TEXT,
    "paidAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinanceContributionEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FinanceClient_workspaceId_status_idx" ON "FinanceClient"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "FinanceClient_workspaceId_updatedAt_idx" ON "FinanceClient"("workspaceId", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "FinanceClient_workspaceId_name_key" ON "FinanceClient"("workspaceId", "name");

-- CreateIndex
CREATE INDEX "FinanceConsultant_workspaceId_status_idx" ON "FinanceConsultant"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "FinanceConsultant_workspaceId_memberId_idx" ON "FinanceConsultant"("workspaceId", "memberId");

-- CreateIndex
CREATE INDEX "FinanceConsultant_workspaceId_updatedAt_idx" ON "FinanceConsultant"("workspaceId", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "FinanceConsultant_workspaceId_name_key" ON "FinanceConsultant"("workspaceId", "name");

-- CreateIndex
CREATE INDEX "FinanceProject_workspaceId_status_idx" ON "FinanceProject"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "FinanceProject_workspaceId_clientId_idx" ON "FinanceProject"("workspaceId", "clientId");

-- CreateIndex
CREATE INDEX "FinanceProject_workspaceId_updatedAt_idx" ON "FinanceProject"("workspaceId", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "FinanceProject_workspaceId_name_key" ON "FinanceProject"("workspaceId", "name");

-- CreateIndex
CREATE INDEX "FinanceTimeEntry_workspaceId_occurredOn_idx" ON "FinanceTimeEntry"("workspaceId", "occurredOn");

-- CreateIndex
CREATE INDEX "FinanceTimeEntry_workspaceId_status_idx" ON "FinanceTimeEntry"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "FinanceTimeEntry_workspaceId_projectId_idx" ON "FinanceTimeEntry"("workspaceId", "projectId");

-- CreateIndex
CREATE INDEX "FinanceTimeEntry_workspaceId_consultantId_idx" ON "FinanceTimeEntry"("workspaceId", "consultantId");

-- CreateIndex
CREATE INDEX "FinanceTimeEntry_workspaceId_updatedAt_idx" ON "FinanceTimeEntry"("workspaceId", "updatedAt");

-- CreateIndex
CREATE INDEX "FinanceExpense_workspaceId_occurredOn_idx" ON "FinanceExpense"("workspaceId", "occurredOn");

-- CreateIndex
CREATE INDEX "FinanceExpense_workspaceId_status_idx" ON "FinanceExpense"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "FinanceExpense_workspaceId_projectId_idx" ON "FinanceExpense"("workspaceId", "projectId");

-- CreateIndex
CREATE INDEX "FinanceExpense_workspaceId_consultantId_idx" ON "FinanceExpense"("workspaceId", "consultantId");

-- CreateIndex
CREATE INDEX "FinanceExpense_workspaceId_updatedAt_idx" ON "FinanceExpense"("workspaceId", "updatedAt");

-- CreateIndex
CREATE INDEX "FinanceContributionEntry_workspaceId_occurredAt_idx" ON "FinanceContributionEntry"("workspaceId", "occurredAt");

-- CreateIndex
CREATE INDEX "FinanceContributionEntry_workspaceId_contributorUserId_idx" ON "FinanceContributionEntry"("workspaceId", "contributorUserId");

-- CreateIndex
CREATE INDEX "FinanceContributionEntry_workspaceId_submittedByUserId_idx" ON "FinanceContributionEntry"("workspaceId", "submittedByUserId");

-- CreateIndex
CREATE INDEX "FinanceContributionEntry_workspaceId_paymentChoice_idx" ON "FinanceContributionEntry"("workspaceId", "paymentChoice");

-- CreateIndex
CREATE INDEX "FinanceContributionEntry_workspaceId_cashStatus_idx" ON "FinanceContributionEntry"("workspaceId", "cashStatus");

-- CreateIndex
CREATE INDEX "FinanceContributionEntry_workspaceId_updatedAt_idx" ON "FinanceContributionEntry"("workspaceId", "updatedAt");

-- AddForeignKey
ALTER TABLE "FinanceClient" ADD CONSTRAINT "FinanceClient_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinanceConsultant" ADD CONSTRAINT "FinanceConsultant_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinanceConsultant" ADD CONSTRAINT "FinanceConsultant_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinanceProject" ADD CONSTRAINT "FinanceProject_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinanceProject" ADD CONSTRAINT "FinanceProject_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "FinanceClient"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinanceTimeEntry" ADD CONSTRAINT "FinanceTimeEntry_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinanceTimeEntry" ADD CONSTRAINT "FinanceTimeEntry_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "FinanceProject"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinanceTimeEntry" ADD CONSTRAINT "FinanceTimeEntry_consultantId_fkey" FOREIGN KEY ("consultantId") REFERENCES "FinanceConsultant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinanceExpense" ADD CONSTRAINT "FinanceExpense_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinanceExpense" ADD CONSTRAINT "FinanceExpense_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "FinanceProject"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinanceExpense" ADD CONSTRAINT "FinanceExpense_consultantId_fkey" FOREIGN KEY ("consultantId") REFERENCES "FinanceConsultant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinanceContributionEntry" ADD CONSTRAINT "FinanceContributionEntry_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinanceContributionEntry" ADD CONSTRAINT "FinanceContributionEntry_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "FinanceProject"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinanceContributionEntry" ADD CONSTRAINT "FinanceContributionEntry_consultantId_fkey" FOREIGN KEY ("consultantId") REFERENCES "FinanceConsultant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
