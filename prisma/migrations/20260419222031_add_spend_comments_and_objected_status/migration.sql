-- AlterEnum
ALTER TYPE "SpendStatus" ADD VALUE 'OBJECTED';

-- CreateTable
CREATE TABLE "SpendComment" (
    "id" TEXT NOT NULL,
    "spendId" TEXT NOT NULL,
    "authorUserId" TEXT NOT NULL,
    "bodyMd" TEXT NOT NULL,
    "isObjection" BOOLEAN NOT NULL DEFAULT false,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SpendComment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SpendComment_spendId_createdAt_idx" ON "SpendComment"("spendId", "createdAt");

-- AddForeignKey
ALTER TABLE "SpendComment" ADD CONSTRAINT "SpendComment_spendId_fkey" FOREIGN KEY ("spendId") REFERENCES "SpendRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SpendComment" ADD CONSTRAINT "SpendComment_authorUserId_fkey" FOREIGN KEY ("authorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
