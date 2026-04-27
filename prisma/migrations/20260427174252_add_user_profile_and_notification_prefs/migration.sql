/*
  Warnings:

  - You are about to alter the column `notifType` on the `NotificationPreference` table. The data in that column could be lost. The data in that column will be cast from `Text` to `VarChar(100)`.
  - You are about to alter the column `channel` on the `NotificationPreference` table. The data in that column could be lost. The data in that column will be cast from `Text` to `VarChar(50)`.
  - You are about to alter the column `ipAddress` on the `Session` table. The data in that column could be lost. The data in that column will be cast from `Text` to `VarChar(45)`.

*/
-- DropIndex
DROP INDEX "NotificationPreference_userId_idx";

-- AlterTable
ALTER TABLE "NotificationPreference" ALTER COLUMN "notifType" SET DATA TYPE VARCHAR(100),
ALTER COLUMN "channel" SET DATA TYPE VARCHAR(50);

-- AlterTable
ALTER TABLE "Session" ALTER COLUMN "ipAddress" SET DATA TYPE VARCHAR(45);

-- CreateTable
CREATE TABLE "McpOAuthClient" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "clientSecret" TEXT,
    "name" TEXT NOT NULL,
    "redirectUris" TEXT[],
    "scopes" TEXT[],
    "tokenEndpointAuthMethod" TEXT NOT NULL DEFAULT 'none',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "McpOAuthClient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "McpOAuthAuthorizationCode" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "instanceSlug" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "scopes" TEXT[],
    "redirectUri" TEXT NOT NULL,
    "resource" TEXT,
    "codeChallenge" TEXT NOT NULL,
    "codeChallengeMethod" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "McpOAuthAuthorizationCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "McpOAuthAccessToken" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "instanceSlug" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "refreshHash" TEXT,
    "scopes" TEXT[],
    "resource" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "refreshExpiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "McpOAuthAccessToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "McpOAuthClient_clientId_key" ON "McpOAuthClient"("clientId");

-- CreateIndex
CREATE INDEX "McpOAuthClient_createdAt_idx" ON "McpOAuthClient"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "McpOAuthAuthorizationCode_code_key" ON "McpOAuthAuthorizationCode"("code");

-- CreateIndex
CREATE INDEX "McpOAuthAuthorizationCode_code_idx" ON "McpOAuthAuthorizationCode"("code");

-- CreateIndex
CREATE INDEX "McpOAuthAuthorizationCode_clientId_idx" ON "McpOAuthAuthorizationCode"("clientId");

-- CreateIndex
CREATE INDEX "McpOAuthAuthorizationCode_userId_workspaceId_idx" ON "McpOAuthAuthorizationCode"("userId", "workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "McpOAuthAccessToken_tokenHash_key" ON "McpOAuthAccessToken"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "McpOAuthAccessToken_refreshHash_key" ON "McpOAuthAccessToken"("refreshHash");

-- CreateIndex
CREATE INDEX "McpOAuthAccessToken_tokenHash_idx" ON "McpOAuthAccessToken"("tokenHash");

-- CreateIndex
CREATE INDEX "McpOAuthAccessToken_refreshHash_idx" ON "McpOAuthAccessToken"("refreshHash");

-- CreateIndex
CREATE INDEX "McpOAuthAccessToken_clientId_idx" ON "McpOAuthAccessToken"("clientId");

-- CreateIndex
CREATE INDEX "McpOAuthAccessToken_userId_workspaceId_idx" ON "McpOAuthAccessToken"("userId", "workspaceId");

-- CreateIndex
CREATE INDEX "McpOAuthAccessToken_workspaceId_instanceSlug_idx" ON "McpOAuthAccessToken"("workspaceId", "instanceSlug");

-- AddForeignKey
ALTER TABLE "McpOAuthAuthorizationCode" ADD CONSTRAINT "McpOAuthAuthorizationCode_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "McpOAuthClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "McpOAuthAuthorizationCode" ADD CONSTRAINT "McpOAuthAuthorizationCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "McpOAuthAuthorizationCode" ADD CONSTRAINT "McpOAuthAuthorizationCode_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "McpOAuthAccessToken" ADD CONSTRAINT "McpOAuthAccessToken_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "McpOAuthClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "McpOAuthAccessToken" ADD CONSTRAINT "McpOAuthAccessToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "McpOAuthAccessToken" ADD CONSTRAINT "McpOAuthAccessToken_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
