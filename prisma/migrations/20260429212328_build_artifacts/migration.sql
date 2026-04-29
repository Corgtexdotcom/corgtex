-- CreateEnum
CREATE TYPE "BuildArtifactStatus" AS ENUM ('OPEN', 'MERGED', 'CLOSED');

-- CreateEnum
CREATE TYPE "BuildArtifactClassification" AS ENUM ('OPEN_CORE', 'INTERNAL', 'CLIENT_PRIVATE');

-- CreateEnum
CREATE TYPE "BuildArtifactVisibility" AS ENUM ('PRIVATE', 'PUBLIC_REVIEW', 'REVOKED');

-- CreateEnum
CREATE TYPE "BuildArtifactAssetKind" AS ENUM ('SCREENSHOT', 'VIDEO', 'DOCUMENT', 'LOG', 'OTHER');

-- CreateTable
CREATE TABLE "BuildArtifact" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "createdByUserId" TEXT,
    "brainSourceId" TEXT,
    "repositoryOwner" TEXT NOT NULL,
    "repositoryName" TEXT NOT NULL,
    "pullRequestNumber" INTEGER,
    "pullRequestUrl" TEXT,
    "branchName" TEXT,
    "commitSha" TEXT,
    "mergeCommitSha" TEXT,
    "title" TEXT NOT NULL,
    "summaryMd" TEXT,
    "status" "BuildArtifactStatus" NOT NULL DEFAULT 'OPEN',
    "classification" "BuildArtifactClassification" NOT NULL DEFAULT 'INTERNAL',
    "visibility" "BuildArtifactVisibility" NOT NULL DEFAULT 'PRIVATE',
    "publicTokenHash" TEXT,
    "publicTokenEnc" TEXT,
    "publicEnabledAt" TIMESTAMP(3),
    "publicRevokedAt" TIMESTAMP(3),
    "mergedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BuildArtifact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BuildArtifactAsset" (
    "id" TEXT NOT NULL,
    "artifactId" TEXT NOT NULL,
    "kind" "BuildArtifactAssetKind" NOT NULL DEFAULT 'SCREENSHOT',
    "label" TEXT NOT NULL,
    "captionMd" TEXT,
    "storageKey" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "sha256" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BuildArtifactAsset_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BuildArtifact_brainSourceId_key" ON "BuildArtifact"("brainSourceId");

-- CreateIndex
CREATE UNIQUE INDEX "BuildArtifact_publicTokenHash_key" ON "BuildArtifact"("publicTokenHash");

-- CreateIndex
CREATE INDEX "BuildArtifact_workspaceId_status_createdAt_idx" ON "BuildArtifact"("workspaceId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "BuildArtifact_workspaceId_visibility_idx" ON "BuildArtifact"("workspaceId", "visibility");

-- CreateIndex
CREATE INDEX "BuildArtifact_repositoryOwner_repositoryName_pullRequestNum_idx" ON "BuildArtifact"("repositoryOwner", "repositoryName", "pullRequestNumber");

-- CreateIndex
CREATE INDEX "BuildArtifact_createdByUserId_idx" ON "BuildArtifact"("createdByUserId");

-- CreateIndex
CREATE UNIQUE INDEX "BuildArtifact_workspaceId_repositoryOwner_repositoryName_pu_key" ON "BuildArtifact"("workspaceId", "repositoryOwner", "repositoryName", "pullRequestNumber");

-- CreateIndex
CREATE UNIQUE INDEX "BuildArtifactAsset_storageKey_key" ON "BuildArtifactAsset"("storageKey");

-- CreateIndex
CREATE INDEX "BuildArtifactAsset_artifactId_sortOrder_idx" ON "BuildArtifactAsset"("artifactId", "sortOrder");

-- CreateIndex
CREATE INDEX "BuildArtifactAsset_kind_idx" ON "BuildArtifactAsset"("kind");

-- AddForeignKey
ALTER TABLE "BuildArtifact" ADD CONSTRAINT "BuildArtifact_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuildArtifact" ADD CONSTRAINT "BuildArtifact_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuildArtifact" ADD CONSTRAINT "BuildArtifact_brainSourceId_fkey" FOREIGN KEY ("brainSourceId") REFERENCES "BrainSource"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuildArtifactAsset" ADD CONSTRAINT "BuildArtifactAsset_artifactId_fkey" FOREIGN KEY ("artifactId") REFERENCES "BuildArtifact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
