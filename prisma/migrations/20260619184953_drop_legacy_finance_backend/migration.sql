/*
  Warnings:

  - You are about to drop the `LedgerAccount` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `LedgerEntry` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `SpendComment` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `SpendProposalLink` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `SpendRequest` table. If the table is not empty, all the data it contains will be lost.

*/
-- Archive legacy finance state before dropping the old Spend/Accounts backend.
WITH impacted_workspaces AS (
  SELECT w.id
  FROM "Workspace" w
  WHERE EXISTS (SELECT 1 FROM "SpendRequest" sr WHERE sr."workspaceId" = w.id)
     OR EXISTS (SELECT 1 FROM "LedgerAccount" la WHERE la."workspaceId" = w.id)
     OR EXISTS (SELECT 1 FROM "LedgerEntry" le WHERE le."workspaceId" = w.id)
     OR EXISTS (
       SELECT 1
       FROM "SpendComment" sc
       INNER JOIN "SpendRequest" sr ON sr.id = sc."spendId"
       WHERE sr."workspaceId" = w.id
     )
), legacy_archive AS (
  SELECT
    w.id AS "workspaceId",
    jsonb_build_object(
      'version', 1,
      'generatedAt', now(),
      'source', '20260619184953_drop_legacy_finance_backend',
      'workspace', to_jsonb(w),
      'counts', jsonb_build_object(
        'ledgerAccounts', (SELECT COUNT(*) FROM "LedgerAccount" la WHERE la."workspaceId" = w.id),
        'ledgerEntries', (SELECT COUNT(*) FROM "LedgerEntry" le WHERE le."workspaceId" = w.id),
        'spendRequests', (SELECT COUNT(*) FROM "SpendRequest" sr WHERE sr."workspaceId" = w.id),
        'spendProposalLinks', (
          SELECT COUNT(*)
          FROM "SpendProposalLink" spl
          INNER JOIN "SpendRequest" sr ON sr.id = spl."spendId"
          WHERE sr."workspaceId" = w.id
        ),
        'spendComments', (
          SELECT COUNT(*)
          FROM "SpendComment" sc
          INNER JOIN "SpendRequest" sr ON sr.id = sc."spendId"
          WHERE sr."workspaceId" = w.id
        ),
        'approvalFlows', (SELECT COUNT(*) FROM "ApprovalFlow" af WHERE af."workspaceId" = w.id AND af."subjectType" = 'SPEND'),
        'approvalDecisions', (
          SELECT COUNT(*)
          FROM "ApprovalDecision" ad
          INNER JOIN "ApprovalFlow" af ON af.id = ad."flowId"
          WHERE af."workspaceId" = w.id AND af."subjectType" = 'SPEND'
        ),
        'objections', (
          SELECT COUNT(*)
          FROM "Objection" o
          INNER JOIN "ApprovalFlow" af ON af.id = o."flowId"
          WHERE af."workspaceId" = w.id AND af."subjectType" = 'SPEND'
        ),
        'deliberationEntries', (SELECT COUNT(*) FROM "DeliberationEntry" de WHERE de."workspaceId" = w.id AND de."parentType" = 'SPEND'),
        'workItemVersions', (SELECT COUNT(*) FROM "WorkItemVersion" wiv WHERE wiv."workspaceId" = w.id AND wiv."entityType" IN ('SpendRequest', 'SPEND', 'SPEND_REQUEST')),
        'workspaceArchiveRecords', (SELECT COUNT(*) FROM "WorkspaceArchiveRecord" war WHERE war."workspaceId" = w.id AND war."entityType" IN ('SpendRequest', 'SPEND', 'LedgerAccount', 'LedgerEntry')),
        'events', (SELECT COUNT(*) FROM "Event" e WHERE e."workspaceId" = w.id AND (e."type" LIKE 'spend.%' OR e."aggregateType" IN ('SpendRequest', 'SPEND', 'LedgerAccount', 'LedgerEntry'))),
        'workflowJobs', (
          SELECT COUNT(*)
          FROM "WorkflowJob" wj
          WHERE wj."workspaceId" = w.id
            AND (
              wj."type" IN ('agent.finance-reconciliation-prep', 'agent.spend-submission')
              OR wj."eventId" IN (
                SELECT e.id
                FROM "Event" e
                WHERE e."workspaceId" = w.id
                  AND (e."type" LIKE 'spend.%' OR e."aggregateType" IN ('SpendRequest', 'SPEND', 'LedgerAccount', 'LedgerEntry'))
              )
            )
        ),
        'notifications', (SELECT COUNT(*) FROM "Notification" n WHERE n."workspaceId" = w.id AND (n."type" LIKE 'spend.%' OR n."entityType" IN ('SpendRequest', 'SPEND', 'LedgerAccount', 'LedgerEntry')))
      ),
      'tables', jsonb_build_object(
        'ledgerAccounts', COALESCE((SELECT jsonb_agg(to_jsonb(la) ORDER BY la."createdAt", la.id) FROM "LedgerAccount" la WHERE la."workspaceId" = w.id), '[]'::jsonb),
        'ledgerEntries', COALESCE((SELECT jsonb_agg(to_jsonb(le) ORDER BY le."createdAt", le.id) FROM "LedgerEntry" le WHERE le."workspaceId" = w.id), '[]'::jsonb),
        'spendRequests', COALESCE((SELECT jsonb_agg(to_jsonb(sr) ORDER BY sr."createdAt", sr.id) FROM "SpendRequest" sr WHERE sr."workspaceId" = w.id), '[]'::jsonb),
        'spendProposalLinks', COALESCE((
          SELECT jsonb_agg(to_jsonb(spl) ORDER BY spl.id)
          FROM "SpendProposalLink" spl
          INNER JOIN "SpendRequest" sr ON sr.id = spl."spendId"
          WHERE sr."workspaceId" = w.id
        ), '[]'::jsonb),
        'spendComments', COALESCE((
          SELECT jsonb_agg(to_jsonb(sc) ORDER BY sc."createdAt", sc.id)
          FROM "SpendComment" sc
          INNER JOIN "SpendRequest" sr ON sr.id = sc."spendId"
          WHERE sr."workspaceId" = w.id
        ), '[]'::jsonb),
        'approvalFlows', COALESCE((SELECT jsonb_agg(to_jsonb(af) ORDER BY af."createdAt", af.id) FROM "ApprovalFlow" af WHERE af."workspaceId" = w.id AND af."subjectType" = 'SPEND'), '[]'::jsonb),
        'approvalDecisions', COALESCE((
          SELECT jsonb_agg(to_jsonb(ad) ORDER BY ad."createdAt", ad.id)
          FROM "ApprovalDecision" ad
          INNER JOIN "ApprovalFlow" af ON af.id = ad."flowId"
          WHERE af."workspaceId" = w.id AND af."subjectType" = 'SPEND'
        ), '[]'::jsonb),
        'objections', COALESCE((
          SELECT jsonb_agg(to_jsonb(o) ORDER BY o."createdAt", o.id)
          FROM "Objection" o
          INNER JOIN "ApprovalFlow" af ON af.id = o."flowId"
          WHERE af."workspaceId" = w.id AND af."subjectType" = 'SPEND'
        ), '[]'::jsonb),
        'deliberationEntries', COALESCE((SELECT jsonb_agg(to_jsonb(de) ORDER BY de."createdAt", de.id) FROM "DeliberationEntry" de WHERE de."workspaceId" = w.id AND de."parentType" = 'SPEND'), '[]'::jsonb),
        'workItemVersions', COALESCE((SELECT jsonb_agg(to_jsonb(wiv) ORDER BY wiv."createdAt", wiv.id) FROM "WorkItemVersion" wiv WHERE wiv."workspaceId" = w.id AND wiv."entityType" IN ('SpendRequest', 'SPEND', 'SPEND_REQUEST')), '[]'::jsonb),
        'workspaceArchiveRecords', COALESCE((SELECT jsonb_agg(to_jsonb(war) ORDER BY war."archivedAt", war.id) FROM "WorkspaceArchiveRecord" war WHERE war."workspaceId" = w.id AND war."entityType" IN ('SpendRequest', 'SPEND', 'LedgerAccount', 'LedgerEntry')), '[]'::jsonb),
        'events', COALESCE((SELECT jsonb_agg(to_jsonb(e) ORDER BY e."createdAt", e.id) FROM "Event" e WHERE e."workspaceId" = w.id AND (e."type" LIKE 'spend.%' OR e."aggregateType" IN ('SpendRequest', 'SPEND', 'LedgerAccount', 'LedgerEntry'))), '[]'::jsonb),
        'workflowJobs', COALESCE((
          SELECT jsonb_agg(to_jsonb(wj) ORDER BY wj."createdAt", wj.id)
          FROM "WorkflowJob" wj
          WHERE wj."workspaceId" = w.id
            AND (
              wj."type" IN ('agent.finance-reconciliation-prep', 'agent.spend-submission')
              OR wj."eventId" IN (
                SELECT e.id
                FROM "Event" e
                WHERE e."workspaceId" = w.id
                  AND (e."type" LIKE 'spend.%' OR e."aggregateType" IN ('SpendRequest', 'SPEND', 'LedgerAccount', 'LedgerEntry'))
              )
            )
        ), '[]'::jsonb),
        'notifications', COALESCE((SELECT jsonb_agg(to_jsonb(n) ORDER BY n."createdAt", n.id) FROM "Notification" n WHERE n."workspaceId" = w.id AND (n."type" LIKE 'spend.%' OR n."entityType" IN ('SpendRequest', 'SPEND', 'LedgerAccount', 'LedgerEntry'))), '[]'::jsonb)
      )
    ) AS "previousState"
  FROM impacted_workspaces iw
  INNER JOIN "Workspace" w ON w.id = iw.id
)
INSERT INTO "WorkspaceArchiveRecord" (
  id,
  "workspaceId",
  "entityType",
  "entityId",
  "entityLabel",
  "previousState",
  "archiveReason",
  "archivedByLabel",
  "archivedAt",
  "createdAt",
  "updatedAt"
)
SELECT
  'legacy-finance-archive-v1-' || "workspaceId",
  "workspaceId",
  'LegacyFinanceArchive',
  'legacy-finance-archive-v1',
  'Legacy finance archive',
  "previousState",
  'Practice Ledger finance replacement',
  'system:legacy-finance-cleanup',
  now(),
  now(),
  now()
FROM legacy_archive
ON CONFLICT (id) DO NOTHING;

-- Remove old support rows that only existed for the legacy Spend/Accounts backend.
DELETE FROM "Notification" WHERE "type" LIKE 'spend.%' OR "entityType" IN ('SpendRequest', 'SPEND', 'LedgerAccount', 'LedgerEntry');
DELETE FROM "NotificationPreference" WHERE "notifType" LIKE 'spend.%';
DELETE FROM "WorkflowJob"
WHERE "type" IN ('agent.finance-reconciliation-prep', 'agent.spend-submission')
   OR "eventId" IN (
     SELECT id FROM "Event"
     WHERE "type" LIKE 'spend.%' OR "aggregateType" IN ('SpendRequest', 'SPEND', 'LedgerAccount', 'LedgerEntry')
   );
DELETE FROM "Event" WHERE "type" LIKE 'spend.%' OR "aggregateType" IN ('SpendRequest', 'SPEND', 'LedgerAccount', 'LedgerEntry');
DELETE FROM "ApprovalDecision" WHERE "flowId" IN (SELECT id FROM "ApprovalFlow" WHERE "subjectType" = 'SPEND');
DELETE FROM "Objection" WHERE "flowId" IN (SELECT id FROM "ApprovalFlow" WHERE "subjectType" = 'SPEND');
DELETE FROM "ApprovalFlow" WHERE "subjectType" = 'SPEND';
DELETE FROM "ApprovalPolicy" WHERE "subjectType" = 'SPEND';
DELETE FROM "DeliberationEntry" WHERE "parentType" = 'SPEND';
DELETE FROM "WorkItemVersion" WHERE "entityType" IN ('SpendRequest', 'SPEND', 'SPEND_REQUEST');
DELETE FROM "WorkspaceArchiveRecord" WHERE "entityType" IN ('SpendRequest', 'SPEND', 'LedgerAccount', 'LedgerEntry');

-- DropForeignKey
ALTER TABLE "LedgerAccount" DROP CONSTRAINT "LedgerAccount_workspaceId_fkey";

-- DropForeignKey
ALTER TABLE "LedgerEntry" DROP CONSTRAINT "LedgerEntry_accountId_fkey";

-- DropForeignKey
ALTER TABLE "LedgerEntry" DROP CONSTRAINT "LedgerEntry_workspaceId_fkey";

-- DropForeignKey
ALTER TABLE "SpendComment" DROP CONSTRAINT "SpendComment_authorUserId_fkey";

-- DropForeignKey
ALTER TABLE "SpendComment" DROP CONSTRAINT "SpendComment_spendId_fkey";

-- DropForeignKey
ALTER TABLE "SpendProposalLink" DROP CONSTRAINT "SpendProposalLink_proposalId_fkey";

-- DropForeignKey
ALTER TABLE "SpendProposalLink" DROP CONSTRAINT "SpendProposalLink_spendId_fkey";

-- DropForeignKey
ALTER TABLE "SpendRequest" DROP CONSTRAINT "SpendRequest_ledgerAccountId_fkey";

-- DropForeignKey
ALTER TABLE "SpendRequest" DROP CONSTRAINT "SpendRequest_requesterUserId_fkey";

-- DropForeignKey
ALTER TABLE "SpendRequest" DROP CONSTRAINT "SpendRequest_workspaceId_fkey";

-- DropTable
DROP TABLE "SpendComment";

-- DropTable
DROP TABLE "SpendProposalLink";

-- DropTable
DROP TABLE "SpendRequest";

-- DropTable
DROP TABLE "LedgerEntry";

-- DropTable
DROP TABLE "LedgerAccount";

-- DropEnum
DROP TYPE "SpendReconciliationStatus";

-- DropEnum
DROP TYPE "SpendResolutionOutcome";

-- DropEnum
DROP TYPE "SpendStatus";
