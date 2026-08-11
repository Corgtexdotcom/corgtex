CREATE TYPE "ConstitutionSourceKind" AS ENUM ('PROPOSAL', 'TENSION'); CREATE TABLE "ConstitutionSourceReference" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "constitutionId" TEXT NOT NULL,
    "pointKey" TEXT NOT NULL,
    "pointOrder" INTEGER NOT NULL,
    "sourceOrder" INTEGER NOT NULL,
    "policyCorpusId" TEXT NOT NULL,
    "sourceKind" "ConstitutionSourceKind" NOT NULL,
    "proposalId" TEXT,
    "tensionId" TEXT,
    "labelSnapshot" TEXT NOT NULL,
    "acceptedAtSnapshot" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ConstitutionSourceReference_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ConstitutionSource_point_contract_check" CHECK ("pointOrder" BETWEEN 1 AND 10 AND
        "sourceOrder" >= 1 AND "pointKey" = 'point-' || "pointOrder"::TEXT),
    CONSTRAINT "ConstitutionSource_target_check" CHECK (
        ("sourceKind" = 'PROPOSAL' AND "proposalId" IS NOT NULL AND "tensionId" IS NULL) OR
        ("sourceKind" = 'TENSION' AND "proposalId" IS NULL AND "tensionId" IS NOT NULL)
    ),
    CONSTRAINT "ConstitutionSource_label_check" CHECK (LENGTH(BTRIM("labelSnapshot")) > 0)
);
CREATE INDEX "ConstitutionSource_workspace_constitution_order_idx" ON "ConstitutionSourceReference"("workspaceId", "constitutionId", "pointOrder", "sourceOrder");
CREATE INDEX "ConstitutionSource_policy_idx" ON "ConstitutionSourceReference"("policyCorpusId");
CREATE INDEX "ConstitutionSource_proposal_idx" ON "ConstitutionSourceReference"("proposalId");
CREATE INDEX "ConstitutionSource_tension_idx" ON "ConstitutionSourceReference"("tensionId");
CREATE UNIQUE INDEX "ConstitutionSource_constitution_point_source_key" ON "ConstitutionSourceReference"("constitutionId", "pointOrder", "sourceOrder");
CREATE UNIQUE INDEX "ConstitutionSource_point_policy_proposal_key" ON "ConstitutionSourceReference"("constitutionId", "pointOrder", "policyCorpusId", "proposalId") WHERE "sourceKind" = 'PROPOSAL';
CREATE UNIQUE INDEX "ConstitutionSource_point_policy_tension_key" ON "ConstitutionSourceReference"("constitutionId", "pointOrder", "policyCorpusId", "tensionId") WHERE "sourceKind" = 'TENSION';
CREATE UNIQUE INDEX "Constitution_id_workspaceId_key" ON "Constitution"("id", "workspaceId");
ALTER TABLE "ConstitutionSourceReference" ADD CONSTRAINT "ConstitutionSourceReference_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConstitutionSourceReference" ADD CONSTRAINT "ConstitutionSourceReference_constitutionId_workspaceId_fkey" FOREIGN KEY ("constitutionId", "workspaceId") REFERENCES "Constitution"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE FUNCTION "validateConstitutionSourceReference"() RETURNS TRIGGER AS $$
DECLARE
  "policyProposalId" TEXT;
  "policyProposalIsPrivate" BOOLEAN;
  "policyProposalPublishedAt" TIMESTAMP(3);
BEGIN
  SELECT pc."proposalId", p."isPrivate", p."publishedAt"
    INTO "policyProposalId", "policyProposalIsPrivate", "policyProposalPublishedAt"
    FROM "PolicyCorpus" AS pc
    JOIN "Proposal" AS p ON p."id" = pc."proposalId" AND p."workspaceId" = NEW."workspaceId"
    WHERE pc."id" = NEW."policyCorpusId" AND pc."workspaceId" = NEW."workspaceId"
    FOR SHARE OF pc, p;
  IF NOT FOUND OR "policyProposalIsPrivate" OR "policyProposalPublishedAt" IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503',
      MESSAGE = 'Invalid Constitution policy source reference.',
      CONSTRAINT = 'ConstitutionSourceReference_policy_source_check';
  END IF;
  IF NEW."sourceKind" = 'PROPOSAL' THEN
    IF NEW."proposalId" IS DISTINCT FROM "policyProposalId" THEN
      RAISE EXCEPTION USING
        ERRCODE = '23503',
        MESSAGE = 'Invalid Constitution proposal source reference.',
        CONSTRAINT = 'ConstitutionSourceReference_proposal_source_check';
    END IF;
  ELSE
    PERFORM 1 FROM "Tension" AS t
      WHERE t."id" = NEW."tensionId" AND t."workspaceId" = NEW."workspaceId"
        AND t."proposalId" = "policyProposalId"
        AND NOT t."isPrivate" AND t."publishedAt" IS NOT NULL AND t."archivedAt" IS NULL
        FOR SHARE OF t;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = '23503',
        MESSAGE = 'Invalid Constitution tension source reference.',
        CONSTRAINT = 'ConstitutionSourceReference_tension_source_check';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "ConstitutionSourceReference_source_check" BEFORE INSERT OR UPDATE OF "workspaceId", "policyCorpusId", "sourceKind", "proposalId", "tensionId"
  ON "ConstitutionSourceReference" FOR EACH ROW EXECUTE FUNCTION "validateConstitutionSourceReference"();
