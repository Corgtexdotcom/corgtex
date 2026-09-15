CREATE TABLE "WorkspaceSupportAccessRequest" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "grantId" TEXT NOT NULL,
  "grantVersion" INTEGER NOT NULL,
  "requestedByUserId" TEXT NOT NULL,
  "command" JSONB NOT NULL,
  "targetState" JSONB NOT NULL,
  "status" "MemberInviteRequestStatus" NOT NULL DEFAULT 'PENDING',
  "decidedByUserId" TEXT,
  "decidedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WorkspaceSupportAccessRequest_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WorkspaceSupportAccessRequest_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "WorkspaceSupportAccessRequest_workspaceId_status_createdAt_idx" ON "WorkspaceSupportAccessRequest"("workspaceId", "status", "createdAt");
