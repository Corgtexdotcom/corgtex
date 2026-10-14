-- Additive only. Existing articles retain their original content and unknown lineage.
ALTER TABLE "BrainArticle"
  ADD COLUMN "variantOfArticleId" TEXT,
  ADD COLUMN "variantTargetFingerprint" TEXT,
  ADD COLUMN "variantInputSetHash" TEXT,
  ADD COLUMN "variantSourceStateJson" JSONB,
  ADD COLUMN "variantGenerationJobId" TEXT;
CREATE UNIQUE INDEX "BrainArticle_variant_recipe_key" ON "BrainArticle"("workspaceId", "variantOfArticleId", "ownerMemberId", "variantTargetFingerprint", "variantInputSetHash");
CREATE INDEX "BrainArticle_workspaceId_variantOfArticleId_ownerMemberId_idx" ON "BrainArticle"("workspaceId", "variantOfArticleId", "ownerMemberId");
