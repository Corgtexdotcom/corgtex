-- AlterTable
ALTER TABLE "Goal" ADD COLUMN     "authorUserId" TEXT,
ADD COLUMN     "isPrivate" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "publishedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Goal_authorUserId_idx" ON "Goal"("authorUserId");

-- AddForeignKey
ALTER TABLE "Goal" ADD CONSTRAINT "Goal_authorUserId_fkey" FOREIGN KEY ("authorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
