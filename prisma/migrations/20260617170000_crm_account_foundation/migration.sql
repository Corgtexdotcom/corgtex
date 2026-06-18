-- AlterTable
ALTER TABLE "CrmContact" ADD COLUMN "accountId" TEXT;

-- AlterTable
ALTER TABLE "CrmDeal" ADD COLUMN "accountId" TEXT;

-- AlterTable
ALTER TABLE "CrmActivity" ADD COLUMN "accountId" TEXT;

-- AlterTable
ALTER TABLE "CrmConversation" ADD COLUMN "accountId" TEXT;

-- AlterTable
ALTER TABLE "CrmProspectWorkspace" ADD COLUMN "accountId" TEXT;

-- CreateTable
CREATE TABLE "CrmAccount" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "domain" TEXT,
    "relationshipType" TEXT NOT NULL DEFAULT 'PROSPECT',
    "lifecycleStage" TEXT NOT NULL DEFAULT 'DISCOVERY',
    "descriptionMd" TEXT,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "ownerUserId" TEXT,
    "archivedAt" TIMESTAMP(3),
    "archivedByUserId" TEXT,
    "archiveReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmAccount_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CrmAccount_workspaceId_relationshipType_lifecycleStage_idx" ON "CrmAccount"("workspaceId", "relationshipType", "lifecycleStage");

-- CreateIndex
CREATE INDEX "CrmAccount_workspaceId_archivedAt_idx" ON "CrmAccount"("workspaceId", "archivedAt");

-- CreateIndex
CREATE INDEX "CrmAccount_workspaceId_domain_idx" ON "CrmAccount"("workspaceId", "domain");

-- CreateIndex
CREATE UNIQUE INDEX "CrmAccount_workspaceId_slug_key" ON "CrmAccount"("workspaceId", "slug");

-- CreateIndex
CREATE INDEX "CrmContact_accountId_idx" ON "CrmContact"("accountId");

-- CreateIndex
CREATE INDEX "CrmDeal_accountId_idx" ON "CrmDeal"("accountId");

-- CreateIndex
CREATE INDEX "CrmActivity_accountId_idx" ON "CrmActivity"("accountId");

-- CreateIndex
CREATE INDEX "CrmConversation_accountId_idx" ON "CrmConversation"("accountId");

-- CreateIndex
CREATE INDEX "CrmProspectWorkspace_accountId_idx" ON "CrmProspectWorkspace"("accountId");

-- Backfill accounts from existing contact company/domain data.
WITH contact_candidates AS (
    SELECT
        c."id" AS "contactId",
        c."workspaceId",
        c."email",
        NULLIF(BTRIM(c."company"), '') AS "company",
        LOWER(SPLIT_PART(c."email", '@', 2)) AS "emailDomain",
        COALESCE(NULLIF(BTRIM(c."source"), ''), 'backfill') AS "source"
    FROM "CrmContact" c
    WHERE c."accountId" IS NULL
      AND c."archivedAt" IS NULL
      AND c."email" LIKE '%@%'
),
normalized AS (
    SELECT
        cc.*,
        CASE
            WHEN cc."company" IS NOT NULL THEN cc."company"
            WHEN cc."emailDomain" LIKE '%.%'
              AND cc."emailDomain" NOT IN (
                  'aol.com',
                  'gmail.com',
                  'hotmail.com',
                  'icloud.com',
                  'live.com',
                  'me.com',
                  'msn.com',
                  'outlook.com',
                  'proton.me',
                  'protonmail.com',
                  'yahoo.com'
              )
            THEN INITCAP(REPLACE(SPLIT_PART(cc."emailDomain", '.', 1), '-', ' '))
            ELSE NULL
        END AS "accountName",
        CASE
            WHEN cc."emailDomain" LIKE '%.%'
              AND cc."emailDomain" NOT IN (
                  'aol.com',
                  'gmail.com',
                  'hotmail.com',
                  'icloud.com',
                  'live.com',
                  'me.com',
                  'msn.com',
                  'outlook.com',
                  'proton.me',
                  'protonmail.com',
                  'yahoo.com'
              )
            THEN cc."emailDomain"
            ELSE NULL
        END AS "accountDomain"
    FROM contact_candidates cc
),
account_candidates AS (
    SELECT DISTINCT ON ("workspaceId", "slug")
        "workspaceId",
        "accountName",
        "slug",
        "accountDomain",
        "source"
    FROM (
        SELECT
            n."workspaceId",
            n."accountName",
            SUBSTRING(TRIM(BOTH '-' FROM REGEXP_REPLACE(LOWER(COALESCE(n."company", n."accountDomain")), '[^a-z0-9]+', '-', 'g')) FROM 1 FOR 80) AS "slug",
            n."accountDomain",
            n."source"
        FROM normalized n
        WHERE n."accountName" IS NOT NULL
    ) s
    WHERE "slug" <> ''
    ORDER BY "workspaceId", "slug", "accountName"
)
INSERT INTO "CrmAccount" (
    "id",
    "workspaceId",
    "name",
    "slug",
    "domain",
    "relationshipType",
    "lifecycleStage",
    "source",
    "createdAt",
    "updatedAt"
)
SELECT
    LOWER(CONCAT(
        SUBSTRING(MD5(ac."workspaceId" || ':' || ac."slug") FROM 1 FOR 8),
        '-',
        SUBSTRING(MD5(ac."workspaceId" || ':' || ac."slug") FROM 9 FOR 4),
        '-',
        SUBSTRING(MD5(ac."workspaceId" || ':' || ac."slug") FROM 13 FOR 4),
        '-',
        SUBSTRING(MD5(ac."workspaceId" || ':' || ac."slug") FROM 17 FOR 4),
        '-',
        SUBSTRING(MD5(ac."workspaceId" || ':' || ac."slug") FROM 21 FOR 12)
    )),
    ac."workspaceId",
    ac."accountName",
    ac."slug",
    ac."accountDomain",
    'PROSPECT',
    'DISCOVERY',
    ac."source",
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM account_candidates ac
ON CONFLICT ("workspaceId", "slug") DO NOTHING;

WITH contact_candidates AS (
    SELECT
        c."id" AS "contactId",
        c."workspaceId",
        c."email",
        NULLIF(BTRIM(c."company"), '') AS "company",
        LOWER(SPLIT_PART(c."email", '@', 2)) AS "emailDomain"
    FROM "CrmContact" c
    WHERE c."accountId" IS NULL
      AND c."archivedAt" IS NULL
      AND c."email" LIKE '%@%'
),
normalized AS (
    SELECT
        cc.*,
        CASE
            WHEN cc."company" IS NOT NULL THEN cc."company"
            WHEN cc."emailDomain" LIKE '%.%'
              AND cc."emailDomain" NOT IN (
                  'aol.com',
                  'gmail.com',
                  'hotmail.com',
                  'icloud.com',
                  'live.com',
                  'me.com',
                  'msn.com',
                  'outlook.com',
                  'proton.me',
                  'protonmail.com',
                  'yahoo.com'
              )
            THEN INITCAP(REPLACE(SPLIT_PART(cc."emailDomain", '.', 1), '-', ' '))
            ELSE NULL
        END AS "accountName",
        CASE
            WHEN cc."emailDomain" LIKE '%.%'
              AND cc."emailDomain" NOT IN (
                  'aol.com',
                  'gmail.com',
                  'hotmail.com',
                  'icloud.com',
                  'live.com',
                  'me.com',
                  'msn.com',
                  'outlook.com',
                  'proton.me',
                  'protonmail.com',
                  'yahoo.com'
              )
            THEN cc."emailDomain"
            ELSE NULL
        END AS "accountDomain"
    FROM contact_candidates cc
),
contact_account_matches AS (
    SELECT
        n."contactId",
        a."id" AS "accountId"
    FROM (
        SELECT
            n.*,
            SUBSTRING(TRIM(BOTH '-' FROM REGEXP_REPLACE(LOWER(COALESCE(n."company", n."accountDomain")), '[^a-z0-9]+', '-', 'g')) FROM 1 FOR 80) AS "slug"
        FROM normalized n
        WHERE n."accountName" IS NOT NULL
    ) n
    JOIN "CrmAccount" a
      ON a."workspaceId" = n."workspaceId"
     AND a."slug" = n."slug"
)
UPDATE "CrmContact" c
SET "accountId" = cam."accountId"
FROM contact_account_matches cam
WHERE c."id" = cam."contactId"
  AND c."accountId" IS NULL;

UPDATE "CrmDeal" d
SET "accountId" = c."accountId"
FROM "CrmContact" c
WHERE d."contactId" = c."id"
  AND d."accountId" IS NULL
  AND c."accountId" IS NOT NULL;

UPDATE "CrmActivity" a
SET "accountId" = c."accountId"
FROM "CrmContact" c
WHERE a."contactId" = c."id"
  AND a."accountId" IS NULL
  AND c."accountId" IS NOT NULL;

UPDATE "CrmConversation" conv
SET "accountId" = c."accountId"
FROM "CrmContact" c
WHERE conv."contactId" = c."id"
  AND conv."accountId" IS NULL
  AND c."accountId" IS NOT NULL;

UPDATE "CrmProspectWorkspace" pw
SET "accountId" = c."accountId"
FROM "DemoLead" dl
JOIN "CrmContact" c
  ON c."workspaceId" = dl."workspaceId"
 AND c."email" = dl."email"
WHERE pw."demoLeadId" = dl."id"
  AND pw."crmWorkspaceId" = dl."workspaceId"
  AND pw."accountId" IS NULL
  AND c."accountId" IS NOT NULL;

-- AddForeignKey
ALTER TABLE "CrmAccount" ADD CONSTRAINT "CrmAccount_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmContact" ADD CONSTRAINT "CrmContact_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "CrmAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmDeal" ADD CONSTRAINT "CrmDeal_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "CrmAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmActivity" ADD CONSTRAINT "CrmActivity_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "CrmAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmConversation" ADD CONSTRAINT "CrmConversation_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "CrmAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmProspectWorkspace" ADD CONSTRAINT "CrmProspectWorkspace_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "CrmAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
