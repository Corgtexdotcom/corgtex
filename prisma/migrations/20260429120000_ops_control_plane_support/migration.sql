-- Add first-class control-plane support access and audited support operations.
-- The control plane stores operational metadata only; support credentials are encrypted.

CREATE TYPE "ControlPlaneInstanceRole" AS ENUM ('SUPPORT_VIEWER', 'SUPPORT_ADMIN', 'CUSTOMER_IT_ADMIN');

CREATE TYPE "SupportOperationStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED');

ALTER TABLE "InstanceRegistry"
ADD COLUMN "supportBaseUrl" TEXT,
ADD COLUMN "supportMcpUrl" TEXT,
ADD COLUMN "supportCredentialEnc" TEXT,
ADD COLUMN "supportCredentialLabel" TEXT,
ADD COLUMN "supportConnectorStatus" TEXT NOT NULL DEFAULT 'not_configured',
ADD COLUMN "supportAccessMode" TEXT NOT NULL DEFAULT 'broad',
ADD COLUMN "supportLastConnectedAt" TIMESTAMP(3),
ADD COLUMN "supportLastSyncAt" TIMESTAMP(3),
ADD COLUMN "supportLastSyncError" TEXT,
ADD COLUMN "supportNotes" TEXT;

CREATE TABLE "ControlPlaneInstanceAccess" (
  "id" TEXT NOT NULL,
  "instanceId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "role" "ControlPlaneInstanceRole" NOT NULL DEFAULT 'SUPPORT_VIEWER',
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ControlPlaneInstanceAccess_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SupportOperation" (
  "id" TEXT NOT NULL,
  "instanceId" TEXT,
  "workspaceId" TEXT,
  "actorUserId" TEXT,
  "actorLabel" TEXT NOT NULL DEFAULT 'Corgtex Support',
  "action" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "status" "SupportOperationStatus" NOT NULL DEFAULT 'PENDING',
  "inputSummary" JSONB,
  "resultSummary" JSONB,
  "error" TEXT,
  "idempotencyKey" TEXT,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "SupportOperation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ControlPlaneInstanceAccess_instanceId_userId_key"
ON "ControlPlaneInstanceAccess"("instanceId", "userId");

CREATE INDEX "ControlPlaneInstanceAccess_userId_isActive_idx"
ON "ControlPlaneInstanceAccess"("userId", "isActive");

CREATE INDEX "ControlPlaneInstanceAccess_instanceId_isActive_idx"
ON "ControlPlaneInstanceAccess"("instanceId", "isActive");

CREATE UNIQUE INDEX "SupportOperation_idempotencyKey_key"
ON "SupportOperation"("idempotencyKey");

CREATE INDEX "SupportOperation_instanceId_createdAt_idx"
ON "SupportOperation"("instanceId", "createdAt");

CREATE INDEX "SupportOperation_workspaceId_createdAt_idx"
ON "SupportOperation"("workspaceId", "createdAt");

CREATE INDEX "SupportOperation_status_createdAt_idx"
ON "SupportOperation"("status", "createdAt");

CREATE INDEX "SupportOperation_action_createdAt_idx"
ON "SupportOperation"("action", "createdAt");

CREATE INDEX "InstanceRegistry_supportConnectorStatus_idx"
ON "InstanceRegistry"("supportConnectorStatus");

ALTER TABLE "ControlPlaneInstanceAccess"
ADD CONSTRAINT "ControlPlaneInstanceAccess_instanceId_fkey"
FOREIGN KEY ("instanceId") REFERENCES "InstanceRegistry"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ControlPlaneInstanceAccess"
ADD CONSTRAINT "ControlPlaneInstanceAccess_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SupportOperation"
ADD CONSTRAINT "SupportOperation_instanceId_fkey"
FOREIGN KEY ("instanceId") REFERENCES "InstanceRegistry"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "SupportOperation"
ADD CONSTRAINT "SupportOperation_actorUserId_fkey"
FOREIGN KEY ("actorUserId") REFERENCES "User"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
