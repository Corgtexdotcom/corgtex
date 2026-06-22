-- CreateEnum
CREATE TYPE "AdviceRequestAudienceType" AS ENUM ('MEMBERS', 'CIRCLE', 'WORKSPACE');

-- CreateEnum
CREATE TYPE "AdviceRequestPreferredChannel" AS ENUM ('IN_APP', 'SLACK', 'EMAIL', 'COPY');

-- CreateEnum
CREATE TYPE "AdviceRequestStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'CANCELED');

-- AlterTable
ALTER TABLE "AdviceProcess" ADD COLUMN     "closedAt" TIMESTAMP(3),
ADD COLUMN     "ownerMemberId" TEXT,
ADD COLUMN     "subjectId" TEXT,
ADD COLUMN     "subjectType" TEXT NOT NULL DEFAULT 'PROPOSAL';

UPDATE "AdviceProcess"
SET "subjectId" = "proposalId",
    "ownerMemberId" = "authorMemberId"
WHERE "subjectId" IS NULL;

ALTER TABLE "AdviceProcess" ALTER COLUMN "subjectId" SET NOT NULL;

-- AlterTable
ALTER TABLE "DeliberationEntry" ADD COLUMN     "adviceRequestId" TEXT;

-- CreateTable
CREATE TABLE "AdviceRequest" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "processId" TEXT NOT NULL,
    "requestedByUserId" TEXT NOT NULL,
    "audienceType" "AdviceRequestAudienceType" NOT NULL,
    "targetCircleId" TEXT,
    "messageMd" TEXT NOT NULL,
    "deadlineAt" TIMESTAMP(3),
    "reminderAt" TIMESTAMP(3),
    "preferredChannel" "AdviceRequestPreferredChannel" NOT NULL DEFAULT 'IN_APP',
    "status" "AdviceRequestStatus" NOT NULL DEFAULT 'ACTIVE',
    "completedAt" TIMESTAMP(3),
    "canceledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdviceRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdviceRequestRecipient" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdviceRequestRecipient_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AdviceRequest_workspaceId_processId_idx" ON "AdviceRequest"("workspaceId", "processId");

-- CreateIndex
CREATE INDEX "AdviceRequest_workspaceId_status_deadlineAt_idx" ON "AdviceRequest"("workspaceId", "status", "deadlineAt");

-- CreateIndex
CREATE INDEX "AdviceRequest_workspaceId_status_reminderAt_idx" ON "AdviceRequest"("workspaceId", "status", "reminderAt");

-- CreateIndex
CREATE INDEX "AdviceRequest_targetCircleId_idx" ON "AdviceRequest"("targetCircleId");

-- CreateIndex
CREATE INDEX "AdviceRequestRecipient_memberId_idx" ON "AdviceRequestRecipient"("memberId");

-- CreateIndex
CREATE UNIQUE INDEX "AdviceRequestRecipient_requestId_memberId_key" ON "AdviceRequestRecipient"("requestId", "memberId");

-- CreateIndex
CREATE INDEX "AdviceProcess_workspaceId_subjectType_subjectId_idx" ON "AdviceProcess"("workspaceId", "subjectType", "subjectId");

-- CreateIndex
CREATE INDEX "AdviceProcess_workspaceId_subjectType_status_idx" ON "AdviceProcess"("workspaceId", "subjectType", "status");

-- CreateIndex
CREATE INDEX "AdviceProcess_ownerMemberId_idx" ON "AdviceProcess"("ownerMemberId");

-- CreateIndex
CREATE INDEX "DeliberationEntry_adviceRequestId_idx" ON "DeliberationEntry"("adviceRequestId");

-- AddForeignKey
ALTER TABLE "DeliberationEntry" ADD CONSTRAINT "DeliberationEntry_adviceRequestId_fkey" FOREIGN KEY ("adviceRequestId") REFERENCES "AdviceRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdviceProcess" ADD CONSTRAINT "AdviceProcess_ownerMemberId_fkey" FOREIGN KEY ("ownerMemberId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdviceRequest" ADD CONSTRAINT "AdviceRequest_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdviceRequest" ADD CONSTRAINT "AdviceRequest_processId_fkey" FOREIGN KEY ("processId") REFERENCES "AdviceProcess"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdviceRequest" ADD CONSTRAINT "AdviceRequest_requestedByUserId_fkey" FOREIGN KEY ("requestedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdviceRequest" ADD CONSTRAINT "AdviceRequest_targetCircleId_fkey" FOREIGN KEY ("targetCircleId") REFERENCES "Circle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdviceRequestRecipient" ADD CONSTRAINT "AdviceRequestRecipient_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "AdviceRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdviceRequestRecipient" ADD CONSTRAINT "AdviceRequestRecipient_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;
