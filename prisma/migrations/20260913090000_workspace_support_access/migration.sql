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
