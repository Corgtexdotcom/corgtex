ALTER TABLE "WorkspaceSupportGrant" ADD COLUMN "setupConnectors" JSONB,
ADD COLUMN "setupRevision" INTEGER NOT NULL DEFAULT 0;
