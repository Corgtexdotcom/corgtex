-- CreateTable
CREATE TABLE "ContextGraphObject" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "objectType" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT,
    "properties" JSONB NOT NULL DEFAULT '{}',
    "confidence" DOUBLE PRECISION,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "createdByType" TEXT NOT NULL DEFAULT 'human',
    "createdByUserId" TEXT,
    "createdByAgentRunId" TEXT,
    "sourceEntityType" TEXT,
    "sourceEntityId" TEXT,
    "dedupeKey" TEXT,
    "validFrom" TIMESTAMP(3),
    "validTo" TIMESTAMP(3),
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastVerifiedAt" TIMESTAMP(3),
    "supersededByObjectId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContextGraphObject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContextGraphRelationship" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "sourceObjectId" TEXT NOT NULL,
    "targetObjectId" TEXT NOT NULL,
    "relationshipType" TEXT NOT NULL,
    "properties" JSONB NOT NULL DEFAULT '{}',
    "confidence" DOUBLE PRECISION,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "createdByType" TEXT NOT NULL DEFAULT 'human',
    "createdByUserId" TEXT,
    "createdByAgentRunId" TEXT,
    "sourceEntityType" TEXT,
    "sourceEntityId" TEXT,
    "dedupeKey" TEXT,
    "validFrom" TIMESTAMP(3),
    "validTo" TIMESTAMP(3),
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastVerifiedAt" TIMESTAMP(3),
    "supersededByRelationshipId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContextGraphRelationship_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContextGraphEvidenceRef" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "objectId" TEXT,
    "relationshipId" TEXT,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "knowledgeChunkId" TEXT,
    "quote" TEXT,
    "relevanceScore" DOUBLE PRECISION,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContextGraphEvidenceRef_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContextMapView" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "viewType" TEXT NOT NULL,
    "query" JSONB NOT NULL DEFAULT '{}',
    "layoutVersion" INTEGER NOT NULL DEFAULT 1,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContextMapView_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContextMapLayoutItem" (
    "id" TEXT NOT NULL,
    "mapViewId" TEXT NOT NULL,
    "objectId" TEXT NOT NULL,
    "x" DOUBLE PRECISION NOT NULL,
    "y" DOUBLE PRECISION NOT NULL,
    "width" DOUBLE PRECISION,
    "height" DOUBLE PRECISION,
    "visualState" JSONB NOT NULL DEFAULT '{}',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContextMapLayoutItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContextGraphProposedDiff" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "proposedByType" TEXT NOT NULL,
    "proposedByUserId" TEXT,
    "proposedByAgentRunId" TEXT,
    "diffJson" JSONB NOT NULL,
    "reason" TEXT,
    "evidenceJson" JSONB,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "reviewedByUserId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "appliedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContextGraphProposedDiff_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ContextGraphObject_workspaceId_objectType_status_idx" ON "ContextGraphObject"("workspaceId", "objectType", "status");

-- CreateIndex
CREATE INDEX "ContextGraphObject_workspaceId_sourceEntityType_sourceEntit_idx" ON "ContextGraphObject"("workspaceId", "sourceEntityType", "sourceEntityId");

-- CreateIndex
CREATE INDEX "ContextGraphObject_workspaceId_validFrom_validTo_idx" ON "ContextGraphObject"("workspaceId", "validFrom", "validTo");

-- CreateIndex
CREATE UNIQUE INDEX "ContextGraphObject_dedupeKey_key" ON "ContextGraphObject"("dedupeKey");

-- CreateIndex
CREATE UNIQUE INDEX "ContextGraphRelationship_dedupeKey_key" ON "ContextGraphRelationship"("dedupeKey");

-- CreateIndex
CREATE INDEX "ContextGraphRelationship_workspaceId_relationshipType_statu_idx" ON "ContextGraphRelationship"("workspaceId", "relationshipType", "status");

-- CreateIndex
CREATE INDEX "ContextGraphRelationship_workspaceId_sourceObjectId_idx" ON "ContextGraphRelationship"("workspaceId", "sourceObjectId");

-- CreateIndex
CREATE INDEX "ContextGraphRelationship_workspaceId_targetObjectId_idx" ON "ContextGraphRelationship"("workspaceId", "targetObjectId");

-- CreateIndex
CREATE INDEX "ContextGraphRelationship_workspaceId_sourceEntityType_sourc_idx" ON "ContextGraphRelationship"("workspaceId", "sourceEntityType", "sourceEntityId");

-- CreateIndex
CREATE INDEX "ContextGraphRelationship_workspaceId_validFrom_validTo_idx" ON "ContextGraphRelationship"("workspaceId", "validFrom", "validTo");

-- CreateIndex
CREATE INDEX "ContextGraphEvidenceRef_workspaceId_sourceType_sourceId_idx" ON "ContextGraphEvidenceRef"("workspaceId", "sourceType", "sourceId");

-- CreateIndex
CREATE INDEX "ContextGraphEvidenceRef_workspaceId_objectId_idx" ON "ContextGraphEvidenceRef"("workspaceId", "objectId");

-- CreateIndex
CREATE INDEX "ContextGraphEvidenceRef_workspaceId_relationshipId_idx" ON "ContextGraphEvidenceRef"("workspaceId", "relationshipId");

-- CreateIndex
CREATE INDEX "ContextGraphEvidenceRef_workspaceId_knowledgeChunkId_idx" ON "ContextGraphEvidenceRef"("workspaceId", "knowledgeChunkId");

-- CreateIndex
CREATE INDEX "ContextMapView_workspaceId_viewType_idx" ON "ContextMapView"("workspaceId", "viewType");

-- CreateIndex
CREATE UNIQUE INDEX "ContextMapLayoutItem_mapViewId_objectId_key" ON "ContextMapLayoutItem"("mapViewId", "objectId");

-- CreateIndex
CREATE INDEX "ContextGraphProposedDiff_workspaceId_status_createdAt_idx" ON "ContextGraphProposedDiff"("workspaceId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "ContextGraphProposedDiff_workspaceId_proposedByType_idx" ON "ContextGraphProposedDiff"("workspaceId", "proposedByType");

-- AddForeignKey
ALTER TABLE "ContextGraphObject" ADD CONSTRAINT "ContextGraphObject_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContextGraphRelationship" ADD CONSTRAINT "ContextGraphRelationship_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContextGraphRelationship" ADD CONSTRAINT "ContextGraphRelationship_sourceObjectId_fkey" FOREIGN KEY ("sourceObjectId") REFERENCES "ContextGraphObject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContextGraphRelationship" ADD CONSTRAINT "ContextGraphRelationship_targetObjectId_fkey" FOREIGN KEY ("targetObjectId") REFERENCES "ContextGraphObject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContextGraphEvidenceRef" ADD CONSTRAINT "ContextGraphEvidenceRef_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContextGraphEvidenceRef" ADD CONSTRAINT "ContextGraphEvidenceRef_objectId_fkey" FOREIGN KEY ("objectId") REFERENCES "ContextGraphObject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContextGraphEvidenceRef" ADD CONSTRAINT "ContextGraphEvidenceRef_relationshipId_fkey" FOREIGN KEY ("relationshipId") REFERENCES "ContextGraphRelationship"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContextMapView" ADD CONSTRAINT "ContextMapView_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContextMapLayoutItem" ADD CONSTRAINT "ContextMapLayoutItem_mapViewId_fkey" FOREIGN KEY ("mapViewId") REFERENCES "ContextMapView"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContextMapLayoutItem" ADD CONSTRAINT "ContextMapLayoutItem_objectId_fkey" FOREIGN KEY ("objectId") REFERENCES "ContextGraphObject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContextGraphProposedDiff" ADD CONSTRAINT "ContextGraphProposedDiff_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
