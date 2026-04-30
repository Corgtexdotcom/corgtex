-- Add low-friction public trial requests with hard entitlement metadata.
CREATE TABLE "ProcurementTrial" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT,
  "agentCredentialId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'REVIEW_REQUIRED',
  "companyName" TEXT NOT NULL,
  "adminEmail" TEXT NOT NULL,
  "adminName" TEXT,
  "emailDomain" TEXT NOT NULL,
  "billingContactEmail" TEXT,
  "acceptedTermsVersion" TEXT NOT NULL,
  "sourceAgent" JSONB,
  "riskStatus" TEXT NOT NULL DEFAULT 'REVIEW_REQUIRED',
  "riskReasons" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "connectorTokenEnc" TEXT,
  "connectorTokenRevealedAt" TIMESTAMP(3),
  "claimEmailStatus" JSONB,
  "modelMonthlyBudgetCents" INTEGER NOT NULL DEFAULT 500,
  "storageLimitMb" INTEGER NOT NULL DEFAULT 100,
  "memberLimit" INTEGER NOT NULL DEFAULT 5,
  "mcpDailyCallLimit" INTEGER NOT NULL DEFAULT 100,
  "trialExpiresAt" TIMESTAMP(3) NOT NULL,
  "suspendedAt" TIMESTAMP(3),
  "suspensionReason" TEXT,
  "convertedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ProcurementTrial_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProcurementTrial_workspaceId_key" ON "ProcurementTrial"("workspaceId");
CREATE UNIQUE INDEX "ProcurementTrial_agentCredentialId_key" ON "ProcurementTrial"("agentCredentialId");
CREATE INDEX "ProcurementTrial_status_trialExpiresAt_idx" ON "ProcurementTrial"("status", "trialExpiresAt");
CREATE INDEX "ProcurementTrial_adminEmail_status_idx" ON "ProcurementTrial"("adminEmail", "status");
CREATE INDEX "ProcurementTrial_emailDomain_status_idx" ON "ProcurementTrial"("emailDomain", "status");
CREATE INDEX "ProcurementTrial_riskStatus_createdAt_idx" ON "ProcurementTrial"("riskStatus", "createdAt");
CREATE UNIQUE INDEX "ProcurementTrial_active_adminEmail_key" ON "ProcurementTrial"("adminEmail") WHERE "status" = 'ACTIVE';
CREATE UNIQUE INDEX "ProcurementTrial_active_emailDomain_key" ON "ProcurementTrial"("emailDomain") WHERE "status" = 'ACTIVE';

ALTER TABLE "ProcurementTrial"
ADD CONSTRAINT "ProcurementTrial_workspaceId_fkey"
FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ProcurementTrial"
ADD CONSTRAINT "ProcurementTrial_agentCredentialId_fkey"
FOREIGN KEY ("agentCredentialId") REFERENCES "AgentCredential"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
