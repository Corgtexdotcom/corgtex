-- Persist self-serve smoke evidence, allowlisted setup-email captures, and
-- audited support sessions for shared-cloud customer debugging.

CREATE TABLE "SelfServeEmailCapture" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT,
  "procurementTrialId" TEXT,
  "toEmail" TEXT NOT NULL,
  "emailDomain" TEXT NOT NULL,
  "subject" TEXT NOT NULL,
  "setupUrlEnc" TEXT NOT NULL,
  "providerStatus" JSONB,
  "runId" TEXT,
  "source" TEXT NOT NULL DEFAULT 'member_setup',
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "SelfServeEmailCapture_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SelfServeSmokeRun" (
  "id" TEXT NOT NULL,
  "deploymentId" TEXT,
  "workspaceId" TEXT,
  "procurementTrialId" TEXT,
  "runId" TEXT NOT NULL,
  "runKind" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "baseUrl" TEXT,
  "siteUrl" TEXT,
  "triggeredByUserId" TEXT,
  "triggeredByLabel" TEXT,
  "summary" JSONB,
  "artifacts" JSONB,
  "error" TEXT,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "SelfServeSmokeRun_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SelfServeSupportSession" (
  "id" TEXT NOT NULL,
  "deploymentId" TEXT,
  "workspaceId" TEXT NOT NULL,
  "operationId" TEXT,
  "supportUserId" TEXT NOT NULL,
  "supportMemberId" TEXT NOT NULL,
  "targetMemberId" TEXT,
  "tokenHash" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "usedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "SelfServeSupportSession_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SelfServeSmokeRun_runId_key" ON "SelfServeSmokeRun"("runId");
CREATE UNIQUE INDEX "SelfServeSupportSession_tokenHash_key" ON "SelfServeSupportSession"("tokenHash");

CREATE INDEX "SelfServeEmailCapture_toEmail_createdAt_idx" ON "SelfServeEmailCapture"("toEmail", "createdAt");
CREATE INDEX "SelfServeEmailCapture_emailDomain_createdAt_idx" ON "SelfServeEmailCapture"("emailDomain", "createdAt");
CREATE INDEX "SelfServeEmailCapture_workspaceId_createdAt_idx" ON "SelfServeEmailCapture"("workspaceId", "createdAt");
CREATE INDEX "SelfServeEmailCapture_procurementTrialId_createdAt_idx" ON "SelfServeEmailCapture"("procurementTrialId", "createdAt");
CREATE INDEX "SelfServeEmailCapture_runId_createdAt_idx" ON "SelfServeEmailCapture"("runId", "createdAt");
CREATE INDEX "SelfServeEmailCapture_expiresAt_idx" ON "SelfServeEmailCapture"("expiresAt");

CREATE INDEX "SelfServeSmokeRun_status_createdAt_idx" ON "SelfServeSmokeRun"("status", "createdAt");
CREATE INDEX "SelfServeSmokeRun_runKind_createdAt_idx" ON "SelfServeSmokeRun"("runKind", "createdAt");
CREATE INDEX "SelfServeSmokeRun_deploymentId_createdAt_idx" ON "SelfServeSmokeRun"("deploymentId", "createdAt");
CREATE INDEX "SelfServeSmokeRun_workspaceId_createdAt_idx" ON "SelfServeSmokeRun"("workspaceId", "createdAt");
CREATE INDEX "SelfServeSmokeRun_procurementTrialId_createdAt_idx" ON "SelfServeSmokeRun"("procurementTrialId", "createdAt");

CREATE INDEX "SelfServeSupportSession_workspaceId_createdAt_idx" ON "SelfServeSupportSession"("workspaceId", "createdAt");
CREATE INDEX "SelfServeSupportSession_deploymentId_createdAt_idx" ON "SelfServeSupportSession"("deploymentId", "createdAt");
CREATE INDEX "SelfServeSupportSession_operationId_idx" ON "SelfServeSupportSession"("operationId");
CREATE INDEX "SelfServeSupportSession_supportUserId_idx" ON "SelfServeSupportSession"("supportUserId");
CREATE INDEX "SelfServeSupportSession_expiresAt_idx" ON "SelfServeSupportSession"("expiresAt");
