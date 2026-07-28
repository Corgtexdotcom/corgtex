-- Clean-break Finance v2 migration.
-- Customer backups were captured in CORGTEX-OPS before applying this migration.

DELETE FROM "WorkspaceFeatureFlag"
WHERE "flag" IN (
  'FINANCE_PROJECTS',
  'FINANCE_SLICING_PIE',
  'PRACTICE_PROJECTS',
  'SLICING_PIE'
);

DELETE FROM "WorkspaceModuleAccessRequest"
WHERE "moduleKey" = 'practice-ledger';

DELETE FROM "WorkspaceModuleGrant"
WHERE "moduleKey" = 'practice-ledger';

DELETE FROM "GoalLink"
WHERE "source" IN ('practice-finance', 'practice-ledger')
  OR "entityType" ILIKE 'Practice%';

DELETE FROM "CommunicationEntityLink"
WHERE "entityType" ILIKE 'Practice%';

DELETE FROM "WorkItemEvidence"
WHERE "entityType" ILIKE 'Practice%';

DELETE FROM "WorkspaceExternalResourceAttachment"
WHERE "entityType" ILIKE 'Practice%';

DELETE FROM "AuditLog"
WHERE "entityType" ILIKE 'Practice%';

DELETE FROM "WorkItemVersion"
WHERE "entityType" ILIKE 'Practice%';

DELETE FROM "WorkspaceArchiveRecord"
WHERE "entityType" ILIKE 'Practice%';

DELETE FROM "WorkspacePermalink"
WHERE "entityType" ILIKE 'Practice%';

DELETE FROM "AppDefinition"
WHERE "appKey" = 'practice-ledger';

DELETE FROM "CatalogItem"
WHERE "sourceId" = 'practice-ledger'
  OR "slug" = 'practice-ledger'
  OR "title" = 'Practice Ledger';

DROP TABLE IF EXISTS "PracticeContributionEntry" CASCADE;
DROP TABLE IF EXISTS "PracticeEntryReview" CASCADE;
DROP TABLE IF EXISTS "PracticeExpense" CASCADE;
DROP TABLE IF EXISTS "PracticeTimeEntry" CASCADE;
DROP TABLE IF EXISTS "PracticePaymentBatch" CASCADE;
DROP TABLE IF EXISTS "PracticeSourceDocument" CASCADE;
DROP TABLE IF EXISTS "PracticeProjectAssignment" CASCADE;
DROP TABLE IF EXISTS "PracticePurchaseOrder" CASCADE;
DROP TABLE IF EXISTS "PracticeProjectLine" CASCADE;
DROP TABLE IF EXISTS "PracticeProject" CASCADE;
DROP TABLE IF EXISTS "PracticeConsultant" CASCADE;
DROP TABLE IF EXISTS "PracticeBillingCode" CASCADE;
DROP TABLE IF EXISTS "PracticeClient" CASCADE;

DROP TYPE IF EXISTS "PracticeEntryReviewStatus";
DROP TYPE IF EXISTS "PracticeEntryReviewTarget";
DROP TYPE IF EXISTS "PracticeSourceDocumentStatus";
DROP TYPE IF EXISTS "PracticeSourceDocumentType";
DROP TYPE IF EXISTS "PracticeEntryStatus";
DROP TYPE IF EXISTS "PracticeProjectLineKind";
DROP TYPE IF EXISTS "PracticeClientStatus";
DROP TYPE IF EXISTS "PracticeContributionCashStatus";
DROP TYPE IF EXISTS "PracticeContributionPaymentChoice";
DROP TYPE IF EXISTS "PracticeContributionType";
DROP TYPE IF EXISTS "PracticeProjectStatus";
