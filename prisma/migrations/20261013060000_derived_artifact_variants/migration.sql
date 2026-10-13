-- CreateTable
CREATE TABLE "GenericDerivedArtifactVariant" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "targetKind" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "ownerMemberId" TEXT NOT NULL,
    "recipeVersion" INTEGER NOT NULL DEFAULT 1,
    "generatorKey" TEXT NOT NULL,
    "generatorVersion" TEXT NOT NULL,
    "instructionHash" VARCHAR(64) NOT NULL,
    "targetFingerprint" VARCHAR(64) NOT NULL,
    "inputSetHash" VARCHAR(64) NOT NULL,
    "sourceStateJson" JSONB NOT NULL,
    "targetsJson" JSONB NOT NULL,
    "scopeJson" JSONB NOT NULL,
    "payloadJson" JSONB NOT NULL,
    "generationJobId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GenericDerivedArtifactVariant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DerivedArtifactRebuildState" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "targetKind" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "targetManifestId" TEXT NOT NULL,
    "targetFingerprint" VARCHAR(64) NOT NULL,
    "sourceStateJson" JSONB NOT NULL,
    "generationKey" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "replacementVariantId" TEXT,
    "eventId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DerivedArtifactRebuildState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GenericDerivedArtifactVariant_workspaceId_ownerMemberId_cre_idx" ON "GenericDerivedArtifactVariant"("workspaceId", "ownerMemberId", "createdAt");

-- CreateIndex
CREATE INDEX "GenericDerivedArtifactVariant_workspaceId_targetKind_target_idx" ON "GenericDerivedArtifactVariant"("workspaceId", "targetKind", "targetId");

-- CreateIndex
CREATE INDEX "GenericDerivedArtifactVariant_generationJobId_idx" ON "GenericDerivedArtifactVariant"("generationJobId");

-- CreateIndex
CREATE UNIQUE INDEX "GenericDerivedArtifactVariant_generation_key" ON "GenericDerivedArtifactVariant"("workspaceId", "targetKind", "targetId", "ownerMemberId", "targetFingerprint", "inputSetHash");

-- CreateIndex
CREATE INDEX "DerivedArtifactRebuildState_workspaceId_state_idx" ON "DerivedArtifactRebuildState"("workspaceId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "DerivedArtifactRebuildState_target_manifest_key" ON "DerivedArtifactRebuildState"("workspaceId", "targetKind", "targetId", "targetManifestId");

-- AddForeignKey
ALTER TABLE "GenericDerivedArtifactVariant" ADD CONSTRAINT "GenericDerivedArtifactVariant_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DerivedArtifactRebuildState" ADD CONSTRAINT "DerivedArtifactRebuildState_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
