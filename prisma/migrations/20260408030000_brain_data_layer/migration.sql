-- CreateEnum
CREATE TYPE "BrainArticleType" AS ENUM ('PRODUCT', 'ARCHITECTURE', 'PROCESS', 'RUNBOOK', 'DECISION', 'TEAM', 'PERSON', 'CUSTOMER', 'INCIDENT', 'PROJECT', 'INTEGRATION', 'PATTERN', 'STRATEGY', 'CULTURE', 'GLOSSARY');

-- CreateEnum
CREATE TYPE "BrainArticleAuthority" AS ENUM ('AUTHORITATIVE', 'REFERENCE', 'HISTORICAL', 'DRAFT');

-- CreateEnum
CREATE TYPE "BrainSourceType" AS ENUM ('MEETING', 'TICKET', 'PR', 'RFC', 'INCIDENT', 'SLACK', 'CUSTOMER_FEEDBACK', 'COMPETITOR', 'RESEARCH', 'ARTICLE', 'DOC', 'RUNBOOK', 'EMAIL');

-- CreateEnum
CREATE TYPE "BrainDiscussionTargetType" AS ENUM ('ARTICLE', 'SECTION', 'LINE');

-- CreateEnum
CREATE TYPE "BrainDiscussionStatus" AS ENUM ('OPEN', 'RESOLVED', 'ABSORBED');

-- AlterEnum
ALTER TYPE "KnowledgeSourceType" ADD VALUE 'BRAIN_ARTICLE';

-- CreateTable
CREATE TABLE "BrainArticle" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "type" "BrainArticleType" NOT NULL,
    "authority" "BrainArticleAuthority" NOT NULL DEFAULT 'DRAFT',
    "bodyMd" TEXT NOT NULL,
    "frontmatterJson" JSONB,
    "ownerMemberId" TEXT,
    "lastVerifiedAt" TIMESTAMP(3),
    "staleAfterDays" INTEGER NOT NULL DEFAULT 90,
    "sourceIds" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BrainArticle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BrainArticleVersion" (
    "id" TEXT NOT NULL,
    "articleId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "bodyMd" TEXT NOT NULL,
    "changeSummary" TEXT,
    "agentRunId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BrainArticleVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BrainSource" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "sourceType" "BrainSourceType" NOT NULL,
    "tier" INTEGER NOT NULL,
    "externalId" TEXT,
    "authorMemberId" TEXT,
    "channel" TEXT,
    "title" TEXT,
    "content" TEXT NOT NULL,
    "metadata" JSONB,
    "absorbedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BrainSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BrainBacklink" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "fromArticleId" TEXT NOT NULL,
    "toArticleId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BrainBacklink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BrainDiscussionThread" (
    "id" TEXT NOT NULL,
    "articleId" TEXT NOT NULL,
    "authorMemberId" TEXT NOT NULL,
    "targetType" "BrainDiscussionTargetType" NOT NULL,
    "targetRef" TEXT,
    "status" "BrainDiscussionStatus" NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "absorbedAt" TIMESTAMP(3),

    CONSTRAINT "BrainDiscussionThread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BrainDiscussionComment" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "authorMemberId" TEXT,
    "agentRunId" TEXT,
    "bodyMd" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BrainDiscussionComment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BrainArticle_workspaceId_type_idx" ON "BrainArticle"("workspaceId", "type");

-- CreateIndex
CREATE INDEX "BrainArticle_workspaceId_authority_idx" ON "BrainArticle"("workspaceId", "authority");

-- CreateIndex
CREATE UNIQUE INDEX "BrainArticle_workspaceId_slug_key" ON "BrainArticle"("workspaceId", "slug");

-- CreateIndex
CREATE INDEX "BrainArticleVersion_articleId_version_idx" ON "BrainArticleVersion"("articleId", "version");

-- CreateIndex
CREATE INDEX "BrainSource_workspaceId_sourceType_idx" ON "BrainSource"("workspaceId", "sourceType");

-- CreateIndex
CREATE INDEX "BrainSource_workspaceId_absorbedAt_idx" ON "BrainSource"("workspaceId", "absorbedAt");

-- CreateIndex
CREATE INDEX "BrainBacklink_workspaceId_idx" ON "BrainBacklink"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "BrainBacklink_fromArticleId_toArticleId_key" ON "BrainBacklink"("fromArticleId", "toArticleId");

-- CreateIndex
CREATE INDEX "BrainDiscussionThread_articleId_status_idx" ON "BrainDiscussionThread"("articleId", "status");

-- CreateIndex
CREATE INDEX "BrainDiscussionComment_threadId_idx" ON "BrainDiscussionComment"("threadId");

-- AddForeignKey
ALTER TABLE "BrainArticle" ADD CONSTRAINT "BrainArticle_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrainArticle" ADD CONSTRAINT "BrainArticle_ownerMemberId_fkey" FOREIGN KEY ("ownerMemberId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrainArticleVersion" ADD CONSTRAINT "BrainArticleVersion_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "BrainArticle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrainSource" ADD CONSTRAINT "BrainSource_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrainSource" ADD CONSTRAINT "BrainSource_authorMemberId_fkey" FOREIGN KEY ("authorMemberId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrainBacklink" ADD CONSTRAINT "BrainBacklink_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrainBacklink" ADD CONSTRAINT "BrainBacklink_fromArticleId_fkey" FOREIGN KEY ("fromArticleId") REFERENCES "BrainArticle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrainBacklink" ADD CONSTRAINT "BrainBacklink_toArticleId_fkey" FOREIGN KEY ("toArticleId") REFERENCES "BrainArticle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrainDiscussionThread" ADD CONSTRAINT "BrainDiscussionThread_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "BrainArticle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrainDiscussionThread" ADD CONSTRAINT "BrainDiscussionThread_authorMemberId_fkey" FOREIGN KEY ("authorMemberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrainDiscussionComment" ADD CONSTRAINT "BrainDiscussionComment_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "BrainDiscussionThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrainDiscussionComment" ADD CONSTRAINT "BrainDiscussionComment_authorMemberId_fkey" FOREIGN KEY ("authorMemberId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;
