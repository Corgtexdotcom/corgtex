-- Existing owners require verified assignment; never infer ownership from ADMIN.
CREATE TYPE "WorkspaceSupportRole" AS ENUM ('SETUP', 'FULL');
ALTER TABLE "Workspace" ADD COLUMN "supportOwnerUserId" TEXT;
ALTER TABLE "User" ADD COLUMN "isSupportAccount" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Event" ADD COLUMN "supportOriginUserId" TEXT, ADD COLUMN "supportGrantVersion" INTEGER;
ALTER TABLE "WorkflowJob" ADD COLUMN "supportOriginUserId" TEXT, ADD COLUMN "supportGrantVersion" INTEGER;
CREATE TABLE "WorkspaceSupportGrant" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "role" "WorkspaceSupportRole" NOT NULL DEFAULT 'SETUP',
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "version" INTEGER NOT NULL DEFAULT 1,
  "grantedByUserId" TEXT NOT NULL,
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "setupChecklist" JSONB,
  CONSTRAINT "WorkspaceSupportGrant_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WorkspaceSupportGrant_version_positive" CHECK ("version" > 0)
);
CREATE UNIQUE INDEX "WorkspaceSupportGrant_workspaceId_userId_key" ON "WorkspaceSupportGrant"("workspaceId", "userId");
CREATE INDEX "WorkspaceSupportGrant_userId_isActive_idx" ON "WorkspaceSupportGrant"("userId", "isActive");
ALTER TABLE "Workspace" ADD CONSTRAINT "Workspace_supportOwnerUserId_fkey" FOREIGN KEY ("supportOwnerUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WorkspaceSupportGrant" ADD CONSTRAINT "WorkspaceSupportGrant_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkspaceSupportGrant" ADD CONSTRAINT "WorkspaceSupportGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Only generated impersonation identities recorded by the legacy support flow.
-- Preserve the historical support-session records for audit.
UPDATE "User" SET "isSupportAccount" = true
WHERE id IN (SELECT "supportUserId" FROM "SelfServeSupportSession");

UPDATE "Member" SET "isActive" = false
WHERE "userId" IN (SELECT "supportUserId" FROM "SelfServeSupportSession");

DELETE FROM "Session"
WHERE "userId" IN (SELECT "supportUserId" FROM "SelfServeSupportSession");

UPDATE "AgentCredential" SET "isActive" = false
WHERE "createdByUserId" IN (SELECT "supportUserId" FROM "SelfServeSupportSession");

UPDATE "McpOAuthAccessToken" SET "revokedAt" = CURRENT_TIMESTAMP
WHERE "userId" IN (SELECT "supportUserId" FROM "SelfServeSupportSession") AND "revokedAt" IS NULL;

UPDATE "OAuthAccessToken" SET "revokedAt" = CURRENT_TIMESTAMP
WHERE "userId" IN (SELECT "supportUserId" FROM "SelfServeSupportSession") AND "revokedAt" IS NULL;

DELETE FROM "McpOAuthAuthorizationCode"
WHERE "userId" IN (SELECT "supportUserId" FROM "SelfServeSupportSession");

DELETE FROM "OAuthAuthorizationCode"
WHERE "userId" IN (SELECT "supportUserId" FROM "SelfServeSupportSession");

ALTER TABLE "AgentCredential" ADD COLUMN "supportGrantVersion" INTEGER;
ALTER TABLE "AppSession" ADD COLUMN "supportGrantVersion" INTEGER;

UPDATE "AppSession" SET "revokedAt" = CURRENT_TIMESTAMP
WHERE "actorUserId" IN (SELECT "supportUserId" FROM "SelfServeSupportSession") AND "revokedAt" IS NULL;

ALTER TABLE "WorkspaceSupportGrant" ADD COLUMN "setupConnectors" JSONB,
ADD COLUMN "setupRevision" INTEGER NOT NULL DEFAULT 0;
