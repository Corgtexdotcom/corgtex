-- CreateTable
CREATE TABLE "WorkspaceToolLink" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "createdByUserId" TEXT,
    "title" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'OTHER',
    "descriptionMd" TEXT,
    "accessNotesMd" TEXT,
    "previewTitle" TEXT,
    "previewDescription" TEXT,
    "previewImageUrl" TEXT,
    "previewFaviconUrl" TEXT,
    "credentialLabel" TEXT,
    "credentialSecretEnc" TEXT,
    "archivedAt" TIMESTAMP(3),
    "archivedByUserId" TEXT,
    "archiveReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkspaceToolLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkspaceToolLinkCircleTag" (
    "id" TEXT NOT NULL,
    "toolLinkId" TEXT NOT NULL,
    "circleId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkspaceToolLinkCircleTag_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WorkspaceToolLink_workspaceId_archivedAt_idx" ON "WorkspaceToolLink"("workspaceId", "archivedAt");

-- CreateIndex
CREATE INDEX "WorkspaceToolLink_workspaceId_category_idx" ON "WorkspaceToolLink"("workspaceId", "category");

-- CreateIndex
CREATE INDEX "WorkspaceToolLink_workspaceId_createdAt_idx" ON "WorkspaceToolLink"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "WorkspaceToolLink_createdByUserId_idx" ON "WorkspaceToolLink"("createdByUserId");

-- CreateIndex
CREATE INDEX "WorkspaceToolLinkCircleTag_circleId_idx" ON "WorkspaceToolLinkCircleTag"("circleId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceToolLinkCircleTag_toolLinkId_circleId_key" ON "WorkspaceToolLinkCircleTag"("toolLinkId", "circleId");

-- AddForeignKey
ALTER TABLE "WorkspaceToolLink" ADD CONSTRAINT "WorkspaceToolLink_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceToolLink" ADD CONSTRAINT "WorkspaceToolLink_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceToolLinkCircleTag" ADD CONSTRAINT "WorkspaceToolLinkCircleTag_toolLinkId_fkey" FOREIGN KEY ("toolLinkId") REFERENCES "WorkspaceToolLink"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceToolLinkCircleTag" ADD CONSTRAINT "WorkspaceToolLinkCircleTag_circleId_fkey" FOREIGN KEY ("circleId") REFERENCES "Circle"("id") ON DELETE CASCADE ON UPDATE CASCADE;
