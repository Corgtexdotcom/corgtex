ALTER TABLE "BrainArticle"
  ADD COLUMN "derivationJson" JSONB,
  ADD COLUMN "humanEditedAt" TIMESTAMP(3);
