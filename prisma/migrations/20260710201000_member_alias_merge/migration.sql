-- AlterTable
ALTER TABLE "Member" ADD COLUMN     "mergedIntoMemberId" TEXT,
ADD COLUMN     "mergedAt" TIMESTAMP(3),
ADD COLUMN     "mergedByUserId" TEXT,
ADD COLUMN     "mergeReason" TEXT;

-- CreateTable
CREATE TABLE "MemberEmailAlias" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MemberEmailAlias_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MemberEmailAlias_workspaceId_email_key" ON "MemberEmailAlias"("workspaceId", "email");

-- CreateIndex
CREATE INDEX "MemberEmailAlias_memberId_idx" ON "MemberEmailAlias"("memberId");

-- CreateIndex
CREATE INDEX "MemberEmailAlias_createdByUserId_idx" ON "MemberEmailAlias"("createdByUserId");

-- CreateIndex
CREATE INDEX "Member_workspaceId_mergedAt_idx" ON "Member"("workspaceId", "mergedAt");

-- CreateIndex
CREATE INDEX "Member_mergedIntoMemberId_idx" ON "Member"("mergedIntoMemberId");

-- CreateIndex
CREATE INDEX "Member_mergedByUserId_idx" ON "Member"("mergedByUserId");

-- AddForeignKey
ALTER TABLE "Member" ADD CONSTRAINT "Member_mergedIntoMemberId_fkey" FOREIGN KEY ("mergedIntoMemberId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Member" ADD CONSTRAINT "Member_mergedByUserId_fkey" FOREIGN KEY ("mergedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberEmailAlias" ADD CONSTRAINT "MemberEmailAlias_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberEmailAlias" ADD CONSTRAINT "MemberEmailAlias_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberEmailAlias" ADD CONSTRAINT "MemberEmailAlias_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
