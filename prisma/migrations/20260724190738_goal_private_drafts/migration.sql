-- AlterTable
ALTER TABLE "Goal" ADD COLUMN     "authorUserId" TEXT,
ADD COLUMN     "isPrivate" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "publishedAt" TIMESTAMP(3);

-- Existing draft goals follow the same private-draft invariant as new drafts.
UPDATE "Goal"
SET "isPrivate" = true
WHERE "status" = 'DRAFT';

-- Backfill legacy goal authors from the existing owner member when possible.
UPDATE "Goal" AS g
SET "authorUserId" = m."userId"
FROM "Member" AS m
WHERE g."authorUserId" IS NULL
  AND g."ownerMemberId" = m."id"
  AND g."workspaceId" = m."workspaceId";

-- CreateIndex
CREATE INDEX "Goal_authorUserId_idx" ON "Goal"("authorUserId");

-- AddForeignKey
ALTER TABLE "Goal" ADD CONSTRAINT "Goal_authorUserId_fkey" FOREIGN KEY ("authorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
