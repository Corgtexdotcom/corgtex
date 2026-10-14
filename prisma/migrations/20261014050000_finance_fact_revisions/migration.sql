CREATE TABLE "FinanceReportFactRevision" (
  "id" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "factId" TEXT NOT NULL,
  "factVersion" INTEGER NOT NULL, "reportId" TEXT NOT NULL, "accountPath" TEXT[],
  "kind" "FinanceReportFactKind" NOT NULL, "periodStart" DATE NOT NULL, "periodEnd" DATE NOT NULL,
  "amountCents" INTEGER NOT NULL, "dimensions" JSONB, "semanticKey" VARCHAR(64) NOT NULL,
  "sourceBatchId" TEXT NOT NULL, "sourceCandidateId" TEXT NOT NULL, "appliedByUserId" TEXT NOT NULL,
  "approvedByUserId" TEXT NOT NULL, "approvedAt" TIMESTAMP(3) NOT NULL, "candidateVersion" INTEGER NOT NULL,
  "valueHash" VARCHAR(64) NOT NULL, "recipeJson" JSONB NOT NULL, "recipeHash" VARCHAR(64) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FinanceReportFactRevision_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "FinanceReportFactRevision_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "FinanceReportFactRevision_versions" CHECK ("factVersion" > 0 AND "candidateVersion" > 0)
);
CREATE UNIQUE INDEX "FinanceReportFactRevision_workspaceId_factId_factVersion_key" ON "FinanceReportFactRevision"("workspaceId", "factId", "factVersion");
CREATE INDEX "FinanceReportFactRevision_workspaceId_semanticKey_idx" ON "FinanceReportFactRevision"("workspaceId", "semanticKey");
CREATE INDEX "FinanceReportFactRevision_workspaceId_reportId_idx" ON "FinanceReportFactRevision"("workspaceId", "reportId");
ALTER TABLE "FinanceImportCandidate" ADD COLUMN "currentFactRevisionId" TEXT;
ALTER TABLE "FinanceImportApplication" ADD COLUMN "beforeRevisionId" TEXT, ADD COLUMN "afterRevisionId" TEXT;
CREATE FUNCTION pun68_finance_revision_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Immutable Finance value evidence cannot be updated'; END; $$;
CREATE TRIGGER "pun68_finance_revision_immutable" BEFORE UPDATE ON "FinanceReportFactRevision"
  FOR EACH ROW EXECUTE FUNCTION pun68_finance_revision_immutable();
CREATE TRIGGER "pun68_permission_FinanceReportFactRevision" AFTER INSERT OR DELETE OR UPDATE ON "FinanceReportFactRevision"
  FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('FinanceReportFactRevision', '["workspaceId","factId","reportId","sourceBatchId","sourceCandidateId"]');
-- Canonical parent rebinds advance the existing Fact epoch, but do not revoke
-- independent immutable revisions. Removal/recreation/kind/tenant changes do.
CREATE TRIGGER "pun68_permission_FinanceReportFactLifecycle" AFTER INSERT OR DELETE OR UPDATE ON "FinanceReportFact"
  FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('FinanceReportFactLifecycle', '["workspaceId","kind"]');
-- ARCHIVED withholds every descendant; restoring ACTIVE never resets old proof.
DROP TRIGGER "pun68_permission_FinanceReport" ON "FinanceReport";
CREATE TRIGGER "pun68_permission_FinanceReport" AFTER INSERT OR DELETE OR UPDATE ON "FinanceReport"
  FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('FinanceReport', '["workspaceId","sourceBatchId","status"]');
DROP TRIGGER "pun68_permission_FinanceImportApplication" ON "FinanceImportApplication";
CREATE TRIGGER "pun68_permission_FinanceImportApplication" AFTER INSERT OR DELETE OR UPDATE ON "FinanceImportApplication"
  FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('FinanceImportApplication', '["workspaceId","batchId","candidateId","beforeRevisionId","afterRevisionId"]');
