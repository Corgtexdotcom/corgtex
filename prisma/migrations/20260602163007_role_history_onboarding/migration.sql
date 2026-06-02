-- CreateEnum
CREATE TYPE "RoleHolderKind" AS ENUM ('MEMBER', 'AGENT');

-- CreateEnum
CREATE TYPE "RoleOnboardingStatus" AS ENUM ('PENDING', 'ACTIVE', 'COMPLETED', 'DISMISSED');

-- CreateTable
CREATE TABLE "RoleVersion" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "circleId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "purposeMd" TEXT,
    "accountabilities" TEXT[],
    "artifacts" TEXT[],
    "metricsMd" TEXT,
    "coreRoleType" TEXT,
    "changeType" TEXT NOT NULL,
    "changedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RoleVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoleHolderHistory" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "holderKind" "RoleHolderKind" NOT NULL,
    "memberId" TEXT,
    "agentIdentityId" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "startedByUserId" TEXT,
    "endedByUserId" TEXT,
    "assignmentId" TEXT,

    CONSTRAINT "RoleHolderHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoleOnboardingSession" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "status" "RoleOnboardingStatus" NOT NULL DEFAULT 'PENDING',
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "dismissedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RoleOnboardingSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RoleVersion_workspaceId_createdAt_idx" ON "RoleVersion"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "RoleVersion_roleId_createdAt_idx" ON "RoleVersion"("roleId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "RoleVersion_roleId_version_key" ON "RoleVersion"("roleId", "version");

-- CreateIndex
CREATE INDEX "RoleHolderHistory_workspaceId_roleId_startedAt_idx" ON "RoleHolderHistory"("workspaceId", "roleId", "startedAt");

-- CreateIndex
CREATE INDEX "RoleHolderHistory_memberId_endedAt_idx" ON "RoleHolderHistory"("memberId", "endedAt");

-- CreateIndex
CREATE INDEX "RoleHolderHistory_agentIdentityId_endedAt_idx" ON "RoleHolderHistory"("agentIdentityId", "endedAt");

-- CreateIndex
CREATE UNIQUE INDEX "RoleOnboardingSession_conversationId_key" ON "RoleOnboardingSession"("conversationId");

-- CreateIndex
CREATE INDEX "RoleOnboardingSession_workspaceId_memberId_status_idx" ON "RoleOnboardingSession"("workspaceId", "memberId", "status");

-- CreateIndex
CREATE INDEX "RoleOnboardingSession_roleId_status_idx" ON "RoleOnboardingSession"("roleId", "status");

-- Backfill open holder history for current human role assignments.
INSERT INTO "RoleHolderHistory" (
    "id",
    "workspaceId",
    "roleId",
    "holderKind",
    "memberId",
    "startedAt",
    "assignmentId"
)
SELECT
    'role-holder-history:member:' || ra."id",
    c."workspaceId",
    ra."roleId",
    'MEMBER'::"RoleHolderKind",
    ra."memberId",
    ra."assignedAt",
    ra."id"
FROM "RoleAssignment" ra
JOIN "Role" r ON r."id" = ra."roleId"
JOIN "Circle" c ON c."id" = r."circleId"
WHERE r."archivedAt" IS NULL
  AND c."archivedAt" IS NULL
  AND NOT EXISTS (
      SELECT 1
      FROM "RoleHolderHistory" rh
      WHERE rh."roleId" = ra."roleId"
        AND rh."memberId" = ra."memberId"
        AND rh."endedAt" IS NULL
  );

-- Backfill open holder history for current AI agent role assignments.
INSERT INTO "RoleHolderHistory" (
    "id",
    "workspaceId",
    "roleId",
    "holderKind",
    "agentIdentityId",
    "startedAt",
    "assignmentId"
)
SELECT
    'role-holder-history:agent:' || caa."id",
    c."workspaceId",
    caa."roleId",
    'AGENT'::"RoleHolderKind",
    caa."agentIdentityId",
    caa."assignedAt",
    caa."id"
FROM "CircleAgentAssignment" caa
JOIN "Role" r ON r."id" = caa."roleId"
JOIN "Circle" c ON c."id" = r."circleId"
WHERE caa."roleId" IS NOT NULL
  AND r."archivedAt" IS NULL
  AND c."archivedAt" IS NULL
  AND NOT EXISTS (
      SELECT 1
      FROM "RoleHolderHistory" rh
      WHERE rh."roleId" = caa."roleId"
        AND rh."agentIdentityId" = caa."agentIdentityId"
        AND rh."endedAt" IS NULL
  );

-- AddForeignKey
ALTER TABLE "RoleVersion" ADD CONSTRAINT "RoleVersion_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoleVersion" ADD CONSTRAINT "RoleVersion_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoleVersion" ADD CONSTRAINT "RoleVersion_changedByUserId_fkey" FOREIGN KEY ("changedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoleHolderHistory" ADD CONSTRAINT "RoleHolderHistory_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoleHolderHistory" ADD CONSTRAINT "RoleHolderHistory_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoleHolderHistory" ADD CONSTRAINT "RoleHolderHistory_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoleHolderHistory" ADD CONSTRAINT "RoleHolderHistory_agentIdentityId_fkey" FOREIGN KEY ("agentIdentityId") REFERENCES "AgentIdentity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoleHolderHistory" ADD CONSTRAINT "RoleHolderHistory_startedByUserId_fkey" FOREIGN KEY ("startedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoleHolderHistory" ADD CONSTRAINT "RoleHolderHistory_endedByUserId_fkey" FOREIGN KEY ("endedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoleOnboardingSession" ADD CONSTRAINT "RoleOnboardingSession_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoleOnboardingSession" ADD CONSTRAINT "RoleOnboardingSession_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoleOnboardingSession" ADD CONSTRAINT "RoleOnboardingSession_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoleOnboardingSession" ADD CONSTRAINT "RoleOnboardingSession_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "ConversationSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
