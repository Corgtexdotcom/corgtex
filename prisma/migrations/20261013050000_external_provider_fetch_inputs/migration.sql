CREATE TABLE "ExternalProviderFetchInput" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "externalContentSourceId" TEXT NOT NULL,
  "connectionId" TEXT NOT NULL,
  "localUserId" TEXT NOT NULL,
  "providerKey" TEXT NOT NULL,
  "serverUrl" TEXT NOT NULL,
  "providerAccountId" TEXT,
  "sourceKind" TEXT NOT NULL,
  "externalId" TEXT NOT NULL,
  "toolName" TEXT NOT NULL,
  "requestJson" JSONB NOT NULL,
  "encryptedResponseJson" TEXT NOT NULL,
  "responseHash" VARCHAR(64) NOT NULL,
  "connectionGrantHash" VARCHAR(64) NOT NULL,
  "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ExternalProviderFetchInput_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ExternalProviderFetchInput_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "ExternalProviderFetchInput_workspaceId_externalContentSourceId_idx" ON "ExternalProviderFetchInput"("workspaceId", "externalContentSourceId");
CREATE INDEX "ExternalProviderFetchInput_workspaceId_connectionId_idx" ON "ExternalProviderFetchInput"("workspaceId", "connectionId");
