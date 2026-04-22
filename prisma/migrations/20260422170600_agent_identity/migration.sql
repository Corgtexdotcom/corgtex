-- CreateEnum
CREATE TYPE "AgentMemberType" AS ENUM ('INTERNAL', 'EXTERNAL');

-- CreateTable
CREATE TABLE "AgentIdentity" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "agentKey" TEXT NOT NULL,
    "memberType" "AgentMemberType" NOT NULL DEFAULT 'INTERNAL',
    "displayName" TEXT NOT NULL,
    "avatarUrl" TEXT,
    "purposeMd" TEXT,
    "behaviorMd" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdByUserId" TEXT,
    "linkedCredentialId" TEXT,
    "maxSpendPerRunCents" INTEGER,
    "maxRunsPerDay" INTEGER,
    "maxRunsPerHour" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentIdentity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CircleAgentAssignment" (
    "id" TEXT NOT NULL,
    "circleId" TEXT NOT NULL,
    "agentIdentityId" TEXT NOT NULL,
    "roleId" TEXT,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CircleAgentAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentIdentity_workspaceId_isActive_idx" ON "AgentIdentity"("workspaceId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "AgentIdentity_workspaceId_agentKey_key" ON "AgentIdentity"("workspaceId", "agentKey");

-- CreateIndex
CREATE UNIQUE INDEX "CircleAgentAssignment_circleId_agentIdentityId_key" ON "CircleAgentAssignment"("circleId", "agentIdentityId");

-- AddForeignKey
ALTER TABLE "AgentIdentity" ADD CONSTRAINT "AgentIdentity_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentIdentity" ADD CONSTRAINT "AgentIdentity_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentIdentity" ADD CONSTRAINT "AgentIdentity_linkedCredentialId_fkey" FOREIGN KEY ("linkedCredentialId") REFERENCES "AgentCredential"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CircleAgentAssignment" ADD CONSTRAINT "CircleAgentAssignment_circleId_fkey" FOREIGN KEY ("circleId") REFERENCES "Circle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CircleAgentAssignment" ADD CONSTRAINT "CircleAgentAssignment_agentIdentityId_fkey" FOREIGN KEY ("agentIdentityId") REFERENCES "AgentIdentity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CircleAgentAssignment" ADD CONSTRAINT "CircleAgentAssignment_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE SET NULL ON UPDATE CASCADE;
