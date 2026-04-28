-- Main already contains the procurement setup models; this migration brings
-- the migration history back in sync before hosted control-plane tables land.
CREATE TABLE "ProcurementSetupSession" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "companyName" TEXT NOT NULL,
  "adminEmail" TEXT NOT NULL,
  "billingContactEmail" TEXT NOT NULL,
  "planLabel" TEXT NOT NULL DEFAULT 'manual-invoice-v1',
  "acceptedTermsVersion" TEXT NOT NULL,
  "sourceAgent" JSONB,
  "emailStatus" JSONB,
  "invitedEmployeeCount" INTEGER NOT NULL DEFAULT 0,
  "maxEmployeeInvites" INTEGER NOT NULL DEFAULT 50,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ProcurementSetupSession_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProcurementSetupSession_tokenHash_key" ON "ProcurementSetupSession"("tokenHash");
CREATE INDEX "ProcurementSetupSession_workspaceId_idx" ON "ProcurementSetupSession"("workspaceId");
CREATE INDEX "ProcurementSetupSession_adminEmail_idx" ON "ProcurementSetupSession"("adminEmail");
CREATE INDEX "ProcurementSetupSession_expiresAt_idx" ON "ProcurementSetupSession"("expiresAt");

ALTER TABLE "ProcurementSetupSession"
ADD CONSTRAINT "ProcurementSetupSession_workspaceId_fkey"
FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ProcurementBillingHandoff" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "companyName" TEXT NOT NULL,
  "adminEmail" TEXT NOT NULL,
  "billingContactEmail" TEXT NOT NULL,
  "planLabel" TEXT NOT NULL DEFAULT 'manual-invoice-v1',
  "sourceAgent" JSONB,
  "status" TEXT NOT NULL DEFAULT 'PENDING_MANUAL_INVOICE',
  "notificationEmailSentAt" TIMESTAMP(3),
  "notificationError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ProcurementBillingHandoff_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProcurementBillingHandoff_workspaceId_key" ON "ProcurementBillingHandoff"("workspaceId");
CREATE INDEX "ProcurementBillingHandoff_status_idx" ON "ProcurementBillingHandoff"("status");
CREATE INDEX "ProcurementBillingHandoff_adminEmail_idx" ON "ProcurementBillingHandoff"("adminEmail");

ALTER TABLE "ProcurementBillingHandoff"
ADD CONSTRAINT "ProcurementBillingHandoff_workspaceId_fkey"
FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ProcurementIdempotencyKey" (
  "id" TEXT NOT NULL,
  "scope" TEXT NOT NULL,
  "keyHash" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "responseJson" JSONB,
  "workspaceId" TEXT,
  "setupSessionId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ProcurementIdempotencyKey_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProcurementIdempotencyKey_keyHash_key" ON "ProcurementIdempotencyKey"("keyHash");
CREATE INDEX "ProcurementIdempotencyKey_scope_createdAt_idx" ON "ProcurementIdempotencyKey"("scope", "createdAt");
CREATE INDEX "ProcurementIdempotencyKey_workspaceId_idx" ON "ProcurementIdempotencyKey"("workspaceId");
CREATE INDEX "ProcurementIdempotencyKey_setupSessionId_idx" ON "ProcurementIdempotencyKey"("setupSessionId");
