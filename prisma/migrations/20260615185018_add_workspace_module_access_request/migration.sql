-- CreateEnum
CREATE TYPE "ModuleAccessRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "WorkspaceModuleAccessRequest" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "moduleKey" TEXT NOT NULL,
    "requestedAccess" "ModuleAccessLevel" NOT NULL,
    "requesterUserId" TEXT NOT NULL,
    "reasonMd" TEXT NOT NULL,
    "status" "ModuleAccessRequestStatus" NOT NULL DEFAULT 'PENDING',
    "decisionNoteMd" TEXT,
    "decidedByUserId" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkspaceModuleAccessRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WorkspaceModuleAccessRequest_workspaceId_status_idx" ON "WorkspaceModuleAccessRequest"("workspaceId", "status");

-- AddForeignKey
ALTER TABLE "WorkspaceModuleAccessRequest" ADD CONSTRAINT "WorkspaceModuleAccessRequest_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
