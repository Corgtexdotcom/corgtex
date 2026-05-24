-- CreateEnum
CREATE TYPE "WorkspacePlan" AS ENUM ('TRIAL', 'CORE_FREE', 'PAYG_AI', 'ENTERPRISE_MANAGED');

-- CreateEnum
CREATE TYPE "WorkspaceBillingStatus" AS ENUM ('NONE', 'CHECKOUT_PENDING', 'ACTIVE', 'PAST_DUE', 'PAYMENT_REQUIRED', 'CANCELED');

-- CreateEnum
CREATE TYPE "AiUsageLedgerStatus" AS ENUM ('PENDING', 'REPORTED', 'INVOICED', 'FAILED');

-- CreateEnum
CREATE TYPE "OAuthConnectionStatus" AS ENUM ('ACTIVE', 'PAUSED', 'ERROR', 'DISCONNECTED');

-- AlterTable
ALTER TABLE "Workspace"
  ADD COLUMN "plan" "WorkspacePlan" NOT NULL DEFAULT 'CORE_FREE',
  ADD COLUMN "planActivatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "trialEndsAt" TIMESTAMP(3);

-- Existing customer workspaces predate self-serve plans and should keep AI available.
UPDATE "Workspace" SET "plan" = 'ENTERPRISE_MANAGED' WHERE "plan" = 'CORE_FREE';

-- AlterTable
ALTER TABLE "ModelUsage"
  ADD COLUMN "rawProviderCostUsd" DECIMAL(12,6),
  ADD COLUMN "billableCostUsd" DECIMAL(12,6);

-- AlterTable
ALTER TABLE "OAuthConnection"
  ADD COLUMN "workspaceId" TEXT,
  ADD COLUMN "tokenStorageVersion" TEXT NOT NULL DEFAULT 'plaintext',
  ADD COLUMN "providerEmail" TEXT,
  ADD COLUMN "status" "OAuthConnectionStatus" NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN "syncSettings" JSONB,
  ADD COLUMN "lastSyncAt" TIMESTAMP(3),
  ADD COLUMN "lastSyncError" TEXT,
  ADD COLUMN "disconnectedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "WorkspaceBillingProfile" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "stripeCustomerId" TEXT,
  "stripeSubscriptionId" TEXT,
  "stripeSubscriptionItemId" TEXT,
  "stripePriceId" TEXT,
  "stripeCheckoutSessionId" TEXT,
  "billingStatus" "WorkspaceBillingStatus" NOT NULL DEFAULT 'NONE',
  "billingEmail" TEXT,
  "aiUsageMarkupBps" INTEGER NOT NULL DEFAULT 10000,
  "paymentMethodReady" BOOLEAN NOT NULL DEFAULT false,
  "currentPeriodStart" TIMESTAMP(3),
  "currentPeriodEnd" TIMESTAMP(3),
  "failedPaymentAt" TIMESTAMP(3),
  "canceledAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "WorkspaceBillingProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiUsageLedgerEntry" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "modelUsageId" TEXT,
  "provider" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "taskType" "ModelTaskType" NOT NULL,
  "rawProviderCostUsd" DECIMAL(12,6) NOT NULL,
  "billableCostUsd" DECIMAL(12,6) NOT NULL,
  "status" "AiUsageLedgerStatus" NOT NULL DEFAULT 'PENDING',
  "stripeUsageRecordId" TEXT,
  "stripeInvoiceId" TEXT,
  "stripeReportedAt" TIMESTAMP(3),
  "lastReportError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "AiUsageLedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StripeWebhookEvent" (
  "id" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "payload" JSONB,
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processedAt" TIMESTAMP(3),
  "error" TEXT,

  CONSTRAINT "StripeWebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceBillingProfile_workspaceId_key" ON "WorkspaceBillingProfile"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceBillingProfile_stripeCustomerId_key" ON "WorkspaceBillingProfile"("stripeCustomerId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceBillingProfile_stripeSubscriptionId_key" ON "WorkspaceBillingProfile"("stripeSubscriptionId");

-- CreateIndex
CREATE INDEX "WorkspaceBillingProfile_billingStatus_idx" ON "WorkspaceBillingProfile"("billingStatus");

-- CreateIndex
CREATE INDEX "WorkspaceBillingProfile_stripeSubscriptionItemId_idx" ON "WorkspaceBillingProfile"("stripeSubscriptionItemId");

-- CreateIndex
CREATE UNIQUE INDEX "AiUsageLedgerEntry_modelUsageId_key" ON "AiUsageLedgerEntry"("modelUsageId");

-- CreateIndex
CREATE INDEX "AiUsageLedgerEntry_workspaceId_status_createdAt_idx" ON "AiUsageLedgerEntry"("workspaceId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "AiUsageLedgerEntry_status_createdAt_idx" ON "AiUsageLedgerEntry"("status", "createdAt");

-- CreateIndex
CREATE INDEX "StripeWebhookEvent_type_receivedAt_idx" ON "StripeWebhookEvent"("type", "receivedAt");

-- CreateIndex
CREATE INDEX "OAuthConnection_workspaceId_provider_status_idx" ON "OAuthConnection"("workspaceId", "provider", "status");

-- AddForeignKey
ALTER TABLE "OAuthConnection" ADD CONSTRAINT "OAuthConnection_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceBillingProfile" ADD CONSTRAINT "WorkspaceBillingProfile_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiUsageLedgerEntry" ADD CONSTRAINT "AiUsageLedgerEntry_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiUsageLedgerEntry" ADD CONSTRAINT "AiUsageLedgerEntry_modelUsageId_fkey" FOREIGN KEY ("modelUsageId") REFERENCES "ModelUsage"("id") ON DELETE SET NULL ON UPDATE CASCADE;
