INSERT INTO "DeliberationEntry" (
  "id",
  "workspaceId",
  "parentType",
  "parentId",
  "parentVersion",
  "authorUserId",
  "entryType",
  "bodyMd",
  "resolvedAt",
  "resolvedNote",
  "createdAt"
)
SELECT
  'legacy-proposal-reaction-' || pr."id",
  p."workspaceId",
  'PROPOSAL',
  pr."proposalId",
  p."version",
  pr."userId",
  CASE
    WHEN pr."reaction" = 'OBJECTION' THEN 'OBJECTION'
    ELSE 'REACTION'
  END,
  COALESCE(NULLIF(BTRIM(pr."bodyMd"), ''), pr."reaction"),
  pr."resolvedAt",
  pr."resolvedNote",
  pr."createdAt"
FROM "ProposalReaction" pr
JOIN "Proposal" p ON p."id" = pr."proposalId";

DROP TABLE "ProposalReaction";
