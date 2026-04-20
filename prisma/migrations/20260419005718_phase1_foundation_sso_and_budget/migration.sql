-- CreateTable
CREATE TABLE "WorkspaceSsoConfig" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "clientSecretEnc" TEXT NOT NULL,
    "allowedDomains" TEXT[],
    "isEnabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkspaceSsoConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserSsoIdentity" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerSubjectId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserSsoIdentity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModelUsageBudget" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "monthlyCostCapUsd" DECIMAL(12,2) NOT NULL,
    "alertThresholdPct" INTEGER NOT NULL DEFAULT 80,
    "periodStartDay" INTEGER NOT NULL DEFAULT 1,
    "alertSentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ModelUsageBudget_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceSsoConfig_workspaceId_provider_key" ON "WorkspaceSsoConfig"("workspaceId", "provider");

-- CreateIndex
CREATE INDEX "UserSsoIdentity_userId_idx" ON "UserSsoIdentity"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "UserSsoIdentity_provider_providerSubjectId_key" ON "UserSsoIdentity"("provider", "providerSubjectId");

-- CreateIndex
CREATE UNIQUE INDEX "ModelUsageBudget_workspaceId_key" ON "ModelUsageBudget"("workspaceId");

-- AddForeignKey
ALTER TABLE "WorkspaceSsoConfig" ADD CONSTRAINT "WorkspaceSsoConfig_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserSsoIdentity" ADD CONSTRAINT "UserSsoIdentity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModelUsageBudget" ADD CONSTRAINT "ModelUsageBudget_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
