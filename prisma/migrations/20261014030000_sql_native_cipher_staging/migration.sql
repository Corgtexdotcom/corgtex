-- Bounded ciphertext transport avoids passing a complete encrypted run through
-- the worker's native query engine. Every part belongs to the same workspace
-- and uncommitted capture; only the atomic complete original is authoritative.
-- No existing original, source/cursor, grant or private record is changed.
CREATE TABLE "SqlNativeCapturePart" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "nativeInputId" TEXT NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "ciphertextPart" TEXT NOT NULL,
  CONSTRAINT "SqlNativeCapturePart_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pun68_cipher_part_bound" CHECK ("ordinal" >= 0 AND
    octet_length("ciphertextPart") BETWEEN 1 AND 524288)
);
CREATE UNIQUE INDEX "SqlNativeCapturePart_workspaceId_nativeInputId_ordinal_key"
  ON "SqlNativeCapturePart"("workspaceId", "nativeInputId", "ordinal");
ALTER TABLE "SqlNativeCapturePart" ADD CONSTRAINT "SqlNativeCapturePart_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
