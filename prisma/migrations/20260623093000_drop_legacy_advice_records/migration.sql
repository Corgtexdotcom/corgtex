-- Move legacy proposal advice records into the generic deliberation stream
-- before dropping the proposal-only advice record table.
INSERT INTO "DeliberationEntry" (
  "id",
  "workspaceId",
  "parentType",
  "parentId",
  "parentVersion",
  "authorUserId",
  "entryType",
  "bodyMd",
  "createdAt"
)
SELECT
  'legacy-advice-' || ar."id",
  ap."workspaceId",
  'PROPOSAL',
  p."id",
  p."version",
  m."userId",
  CASE
    WHEN ar."type" = 'CONCERN' THEN 'OBJECTION'
    ELSE 'REACTION'
  END,
  ar."bodyMd",
  ar."createdAt"
FROM "AdviceRecord" ar
JOIN "AdviceProcess" ap ON ap."id" = ar."processId"
JOIN "Proposal" p ON p."id" = COALESCE(ap."subjectId", ap."proposalId")
  AND p."workspaceId" = ap."workspaceId"
JOIN "Member" m ON m."id" = ar."memberId"
WHERE COALESCE(ap."subjectType", 'PROPOSAL') = 'PROPOSAL'
ON CONFLICT ("id") DO NOTHING;

DROP TABLE "AdviceRecord";

ALTER TABLE "AdviceProcess"
  DROP COLUMN "advisorySuggestionsJson",
  DROP COLUMN "processLintJson";
