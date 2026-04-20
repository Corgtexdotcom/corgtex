CREATE TYPE "SpendReconciliationStatus" AS ENUM ('PENDING', 'STATEMENT_ATTACHED', 'RECONCILED');

ALTER TABLE "SpendRequest"
ADD COLUMN "reconciliationStatus" "SpendReconciliationStatus" NOT NULL DEFAULT 'PENDING',
ADD COLUMN "reconciliationNote" TEXT,
ADD COLUMN "statementStorageKey" TEXT,
ADD COLUMN "statementFileName" TEXT,
ADD COLUMN "statementMimeType" TEXT,
ADD COLUMN "statementUploadedAt" TIMESTAMP(3),
ADD COLUMN "reconciledAt" TIMESTAMP(3);

CREATE INDEX "SpendRequest_workspaceId_reconciliationStatus_idx"
ON "SpendRequest"("workspaceId", "reconciliationStatus");
