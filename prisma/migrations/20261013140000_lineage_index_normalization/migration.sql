-- Normalize the earlier local index spelling without changing stored lineage.
-- Fresh migration replay already creates the canonical name and needs no rename.
DO $$ BEGIN
  IF to_regclass('"ArtifactInputLineage_workspaceId_artifactType_artifactId_r_idx"') IS NOT NULL THEN
    IF to_regclass('"ArtifactInputLineage_workspaceId_artifactType_artifactId_re_idx"') IS NOT NULL THEN
      RAISE EXCEPTION 'Conflicting ArtifactInputLineage index identities';
    END IF;
    ALTER INDEX "ArtifactInputLineage_workspaceId_artifactType_artifactId_r_idx"
      RENAME TO "ArtifactInputLineage_workspaceId_artifactType_artifactId_re_idx";
  END IF;
END $$;
