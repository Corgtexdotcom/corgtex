CREATE TABLE "ArtifactInputLineage" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "artifactType" TEXT NOT NULL,
    "artifactId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "origin" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "inputsJson" JSONB NOT NULL DEFAULT '[]',
    "rootsJson" JSONB NOT NULL DEFAULT '[]',
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ArtifactInputLineage_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ArtifactInputLineage_workspaceId_artifactType_artifactId_re_key"
    ON "ArtifactInputLineage"("workspaceId", "artifactType", "artifactId", "revision");
CREATE INDEX "ArtifactInputLineage_workspaceId_artifactType_artifactId_re_idx"
    ON "ArtifactInputLineage"("workspaceId", "artifactType", "artifactId", "recordedAt");

ALTER TABLE "ArtifactInputLineage" ADD CONSTRAINT "ArtifactInputLineage_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
