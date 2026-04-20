ALTER TABLE "ApprovalPolicy"
ADD COLUMN "decisionWindowHours" INTEGER NOT NULL DEFAULT 72;

ALTER TABLE "ApprovalFlow"
ADD COLUMN "minApproverCount" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN "closesAt" TIMESTAMP(3);

CREATE INDEX "ApprovalFlow_status_closesAt_idx" ON "ApprovalFlow"("status", "closesAt");

UPDATE "ApprovalPolicy"
SET
  "mode" = 'CONSENT',
  "quorumPercent" = 0,
  "minApproverCount" = 1,
  "decisionWindowHours" = 72
WHERE "subjectType" = 'PROPOSAL';

UPDATE "ApprovalFlow" AS flow
SET
  "minApproverCount" = policy."minApproverCount",
  "closesAt" = CASE
    WHEN flow."mode" = 'CONSENT' AND flow."openedAt" IS NOT NULL
      THEN flow."openedAt" + make_interval(hours => policy."decisionWindowHours")
    ELSE NULL
  END
FROM "ApprovalPolicy" AS policy
WHERE policy."workspaceId" = flow."workspaceId"
  AND policy."subjectType" = flow."subjectType";
