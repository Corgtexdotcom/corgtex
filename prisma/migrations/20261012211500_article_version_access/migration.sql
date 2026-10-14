-- Historical permissions cannot be inferred from a current owner or privacy flag.
-- Legacy versions remain unknown until independently rebuilt or verified.
ALTER TABLE "BrainArticleVersion" ADD COLUMN "accessEnvelopeJson" JSONB;
