-- AlterTable
ALTER TABLE "Circle" ADD COLUMN     "maturityStage" TEXT NOT NULL DEFAULT 'GETTING_STARTED';

-- AlterTable
ALTER TABLE "Role" ADD COLUMN     "artifacts" TEXT[],
ADD COLUMN     "coreRoleType" TEXT;

-- CreateTable
CREATE TABLE "CheckIn" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "questionText" TEXT NOT NULL,
    "questionSource" TEXT NOT NULL,
    "responseMd" TEXT,
    "sentiment" TEXT,
    "aiAnalysis" JSONB,
    "respondedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CheckIn_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CheckIn_workspaceId_memberId_createdAt_idx" ON "CheckIn"("workspaceId", "memberId", "createdAt");

-- AddForeignKey
ALTER TABLE "CheckIn" ADD CONSTRAINT "CheckIn_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckIn" ADD CONSTRAINT "CheckIn_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;
