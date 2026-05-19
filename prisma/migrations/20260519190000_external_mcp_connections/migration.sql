CREATE TYPE "ExternalMcpConnectionStatus" AS ENUM ('ACTIVE', 'DISCONNECTED', 'ERROR');

CREATE TABLE "ExternalMcpConnection" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "providerKey" TEXT NOT NULL,
  "displayName" TEXT NOT NULL,
  "serverUrl" TEXT NOT NULL,
  "accessTokenEnc" TEXT,
  "refreshTokenEnc" TEXT,
  "scopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "capabilities" JSONB,
  "status" "ExternalMcpConnectionStatus" NOT NULL DEFAULT 'ACTIVE',
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ExternalMcpConnection_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ExternalMcpConnection_workspaceId_userId_providerKey_key"
ON "ExternalMcpConnection"("workspaceId", "userId", "providerKey");

CREATE INDEX "ExternalMcpConnection_workspaceId_providerKey_status_idx"
ON "ExternalMcpConnection"("workspaceId", "providerKey", "status");

CREATE INDEX "ExternalMcpConnection_userId_providerKey_idx"
ON "ExternalMcpConnection"("userId", "providerKey");

ALTER TABLE "ExternalMcpConnection"
ADD CONSTRAINT "ExternalMcpConnection_workspaceId_fkey"
FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ExternalMcpConnection"
ADD CONSTRAINT "ExternalMcpConnection_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
