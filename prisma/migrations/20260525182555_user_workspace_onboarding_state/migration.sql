-- CreateTable
CREATE TABLE "UserWorkspaceOnboardingState" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "tourKey" VARCHAR(64) NOT NULL,
    "tourVersion" VARCHAR(32) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "restartedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserWorkspaceOnboardingState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UserWorkspaceOnboardingState_workspaceId_tourKey_tourVersio_idx" ON "UserWorkspaceOnboardingState"("workspaceId", "tourKey", "tourVersion");

-- CreateIndex
CREATE INDEX "UserWorkspaceOnboardingState_userId_updatedAt_idx" ON "UserWorkspaceOnboardingState"("userId", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "UserWorkspaceOnboardingState_user_workspace_tour_key" ON "UserWorkspaceOnboardingState"("userId", "workspaceId", "tourKey", "tourVersion");

-- AddForeignKey
ALTER TABLE "UserWorkspaceOnboardingState" ADD CONSTRAINT "UserWorkspaceOnboardingState_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserWorkspaceOnboardingState" ADD CONSTRAINT "UserWorkspaceOnboardingState_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
