-- CreateEnum
CREATE TYPE "MemberKind" AS ENUM ('HUMAN', 'SYSTEM');

-- AlterTable
ALTER TABLE "Member" ADD COLUMN     "kind" "MemberKind" NOT NULL DEFAULT 'HUMAN';

UPDATE "Member"
SET "kind" = 'SYSTEM'
FROM "User"
WHERE "Member"."userId" = "User"."id"
  AND (
    lower("User"."email") LIKE 'system+%'
    OR lower("User"."email") LIKE 'support+%'
    OR lower(coalesce("User"."displayName", '')) = 'corgtex support'
  );

-- CreateIndex
CREATE INDEX "Member_workspaceId_kind_idx" ON "Member"("workspaceId", "kind");
