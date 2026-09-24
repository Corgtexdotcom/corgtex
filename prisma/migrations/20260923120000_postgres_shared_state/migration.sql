CREATE TABLE "SharedRateLimit" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "timestamps" BIGINT[] NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "SharedRateLimit_expiresAt_idx" ON "SharedRateLimit"("expiresAt");
CREATE TABLE "SharedCacheEntry" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "encryptedPayload" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "SharedCacheEntry_expiresAt_idx" ON "SharedCacheEntry"("expiresAt");
CREATE TABLE "SharedCacheVersion" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "version" INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE "PendingTranscriptUpload" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "workspaceId" TEXT NOT NULL,
  "encryptedPayload" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PendingTranscriptUpload_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "PendingTranscriptUpload_expiresAt_idx" ON "PendingTranscriptUpload"("expiresAt");
CREATE INDEX "PendingTranscriptUpload_workspaceId_idx" ON "PendingTranscriptUpload"("workspaceId");
