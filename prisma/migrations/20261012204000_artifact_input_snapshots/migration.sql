CREATE TABLE "ArtifactInputSnapshot" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "sourceKind" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "sourceFingerprint" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "contentJson" JSONB NOT NULL,
    "accessEnvelopeJson" JSONB NOT NULL,
    "rootsJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ArtifactInputSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ArtifactInputSnapshot_workspaceId_sourceKind_sourceId_idx"
    ON "ArtifactInputSnapshot"("workspaceId", "sourceKind", "sourceId");

ALTER TABLE "ArtifactInputSnapshot" ADD CONSTRAINT "ArtifactInputSnapshot_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
