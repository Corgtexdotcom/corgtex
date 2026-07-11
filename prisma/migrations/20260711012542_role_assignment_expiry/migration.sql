-- AlterTable
ALTER TABLE "RoleAssignment" ADD COLUMN     "expiresAt" TIMESTAMP(3),
ADD COLUMN     "transferReason" TEXT;

-- CreateIndex
CREATE INDEX "RoleAssignment_expiresAt_idx" ON "RoleAssignment"("expiresAt");
