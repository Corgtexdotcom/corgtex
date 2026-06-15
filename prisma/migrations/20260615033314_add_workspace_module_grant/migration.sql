-- CreateEnum
CREATE TYPE "ModuleGrantPrincipalType" AS ENUM ('MEMBER', 'MEMBER_ROLE', 'GOVERNANCE_ROLE', 'CIRCLE');

-- CreateEnum
CREATE TYPE "ModuleAccessLevel" AS ENUM ('NONE', 'READ', 'WRITE');

-- CreateTable
CREATE TABLE "WorkspaceModuleGrant" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "moduleKey" TEXT NOT NULL,
    "principalType" "ModuleGrantPrincipalType" NOT NULL,
    "principalId" TEXT NOT NULL,
    "accessLevel" "ModuleAccessLevel" NOT NULL,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkspaceModuleGrant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WorkspaceModuleGrant_workspaceId_moduleKey_idx" ON "WorkspaceModuleGrant"("workspaceId", "moduleKey");

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceModuleGrant_workspaceId_moduleKey_principalType_pr_key" ON "WorkspaceModuleGrant"("workspaceId", "moduleKey", "principalType", "principalId");

-- AddForeignKey
ALTER TABLE "WorkspaceModuleGrant" ADD CONSTRAINT "WorkspaceModuleGrant_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
