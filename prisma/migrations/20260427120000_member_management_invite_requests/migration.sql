-- CreateEnum
CREATE TYPE "MemberInviteRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "MemberInviteRequest" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "requesterMemberId" TEXT NOT NULL,
    "deciderMemberId" TEXT,
    "email" TEXT NOT NULL,
    "displayName" TEXT,
    "status" "MemberInviteRequestStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),

    CONSTRAINT "MemberInviteRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MemberInviteRequest_workspaceId_status_createdAt_idx" ON "MemberInviteRequest"("workspaceId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "MemberInviteRequest_requesterMemberId_idx" ON "MemberInviteRequest"("requesterMemberId");

-- CreateIndex
CREATE INDEX "MemberInviteRequest_deciderMemberId_idx" ON "MemberInviteRequest"("deciderMemberId");

-- AddForeignKey
ALTER TABLE "MemberInviteRequest" ADD CONSTRAINT "MemberInviteRequest_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberInviteRequest" ADD CONSTRAINT "MemberInviteRequest_requesterMemberId_fkey" FOREIGN KEY ("requesterMemberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberInviteRequest" ADD CONSTRAINT "MemberInviteRequest_deciderMemberId_fkey" FOREIGN KEY ("deciderMemberId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;
