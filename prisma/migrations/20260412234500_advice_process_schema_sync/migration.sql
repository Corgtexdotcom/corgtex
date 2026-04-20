-- CreateEnum
CREATE TYPE "ExpertiseLevel" AS ENUM ('LEARNING', 'PRACTITIONER', 'EXPERT', 'AUTHORITY');

-- CreateEnum
CREATE TYPE "AdviceProcessStatus" AS ENUM ('GATHERING', 'READY', 'EXECUTED', 'WITHDRAWN');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "KnowledgeSourceType" ADD VALUE 'TENSION';
ALTER TYPE "KnowledgeSourceType" ADD VALUE 'ACTION';
ALTER TYPE "KnowledgeSourceType" ADD VALUE 'CIRCLE';
ALTER TYPE "KnowledgeSourceType" ADD VALUE 'ROLE';

-- AlterEnum
ALTER TYPE "ProposalStatus" ADD VALUE 'ADVICE_GATHERING';

-- AlterTable
ALTER TABLE "Action" ADD COLUMN     "isPrivate" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "publishedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "BrainArticle" ADD COLUMN     "isPrivate" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "publishedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Proposal" ADD COLUMN     "isPrivate" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "publishedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Tension" ADD COLUMN     "isPrivate" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "publishedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "ExpertiseTag" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExpertiseTag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemberExpertise" (
    "id" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "expertiseTagId" TEXT NOT NULL,
    "level" "ExpertiseLevel" NOT NULL DEFAULT 'PRACTITIONER',
    "endorsedCount" INTEGER NOT NULL DEFAULT 0,
    "source" TEXT NOT NULL DEFAULT 'SELF',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MemberExpertise_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdviceProcess" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "proposalId" TEXT NOT NULL,
    "authorMemberId" TEXT NOT NULL,
    "status" "AdviceProcessStatus" NOT NULL DEFAULT 'GATHERING',
    "adviceDeadline" TIMESTAMP(3),
    "executedAt" TIMESTAMP(3),
    "withdrawnAt" TIMESTAMP(3),
    "advisorySuggestionsJson" JSONB,
    "processLintJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdviceProcess_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdviceRecord" (
    "id" TEXT NOT NULL,
    "processId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "bodyMd" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdviceRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImpactFootprint" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "proposalsAuthored" INTEGER NOT NULL DEFAULT 0,
    "proposalsExecuted" INTEGER NOT NULL DEFAULT 0,
    "adviceGiven" INTEGER NOT NULL DEFAULT 0,
    "adviceSoughtCount" INTEGER NOT NULL DEFAULT 0,
    "tensionsResolved" INTEGER NOT NULL DEFAULT 0,
    "actionsCompleted" INTEGER NOT NULL DEFAULT 0,
    "endorsementsReceived" INTEGER NOT NULL DEFAULT 0,
    "concernsRaised" INTEGER NOT NULL DEFAULT 0,
    "meetingsParticipated" INTEGER NOT NULL DEFAULT 0,
    "detailJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ImpactFootprint_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ExpertiseTag_workspaceId_idx" ON "ExpertiseTag"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ExpertiseTag_workspaceId_slug_key" ON "ExpertiseTag"("workspaceId", "slug");

-- CreateIndex
CREATE INDEX "MemberExpertise_expertiseTagId_idx" ON "MemberExpertise"("expertiseTagId");

-- CreateIndex
CREATE UNIQUE INDEX "MemberExpertise_memberId_expertiseTagId_key" ON "MemberExpertise"("memberId", "expertiseTagId");

-- CreateIndex
CREATE UNIQUE INDEX "AdviceProcess_proposalId_key" ON "AdviceProcess"("proposalId");

-- CreateIndex
CREATE INDEX "AdviceProcess_workspaceId_status_idx" ON "AdviceProcess"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "AdviceRecord_processId_idx" ON "AdviceRecord"("processId");

-- CreateIndex
CREATE INDEX "AdviceRecord_memberId_idx" ON "AdviceRecord"("memberId");

-- CreateIndex
CREATE INDEX "ImpactFootprint_workspaceId_memberId_idx" ON "ImpactFootprint"("workspaceId", "memberId");

-- CreateIndex
CREATE UNIQUE INDEX "ImpactFootprint_workspaceId_memberId_periodStart_periodEnd_key" ON "ImpactFootprint"("workspaceId", "memberId", "periodStart", "periodEnd");

-- AddForeignKey
ALTER TABLE "ExpertiseTag" ADD CONSTRAINT "ExpertiseTag_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberExpertise" ADD CONSTRAINT "MemberExpertise_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberExpertise" ADD CONSTRAINT "MemberExpertise_expertiseTagId_fkey" FOREIGN KEY ("expertiseTagId") REFERENCES "ExpertiseTag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdviceProcess" ADD CONSTRAINT "AdviceProcess_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdviceProcess" ADD CONSTRAINT "AdviceProcess_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "Proposal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdviceProcess" ADD CONSTRAINT "AdviceProcess_authorMemberId_fkey" FOREIGN KEY ("authorMemberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdviceRecord" ADD CONSTRAINT "AdviceRecord_processId_fkey" FOREIGN KEY ("processId") REFERENCES "AdviceProcess"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdviceRecord" ADD CONSTRAINT "AdviceRecord_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImpactFootprint" ADD CONSTRAINT "ImpactFootprint_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImpactFootprint" ADD CONSTRAINT "ImpactFootprint_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

