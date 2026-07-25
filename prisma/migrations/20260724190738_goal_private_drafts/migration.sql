-- AlterTable
ALTER TABLE "Goal" ADD COLUMN     "authorUserId" TEXT,
ADD COLUMN     "isPrivate" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "publishedAt" TIMESTAMP(3);

-- Existing draft goals follow the same private-draft invariant as new drafts.
UPDATE "Goal"
SET "isPrivate" = true
WHERE "status" = 'DRAFT';

-- Existing draft goals may already have context-graph rows from the old public
-- draft flow. Archive those rows during the same privacy transition so private
-- draft titles/descriptions are not left readable until a later graph sync.
UPDATE "ContextGraphObject" AS cgo
SET "status" = 'archived',
    "updatedAt" = NOW()
FROM "Goal" AS g
WHERE cgo."workspaceId" = g."workspaceId"
  AND cgo."sourceEntityType" = 'Goal'
  AND cgo."sourceEntityId" = g."id"
  AND g."status" = 'DRAFT'
  AND cgo."status" <> 'archived';

UPDATE "ContextGraphRelationship" AS cgr
SET "status" = 'archived',
    "updatedAt" = NOW()
FROM "Goal" AS g
WHERE cgr."workspaceId" = g."workspaceId"
  AND cgr."sourceEntityType" = 'Goal'
  AND cgr."sourceEntityId" = g."id"
  AND g."status" = 'DRAFT'
  AND cgr."status" <> 'archived';

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
