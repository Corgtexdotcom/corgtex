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
CREATE UNIQUE INDEX "PolicyCorpus_id_workspaceId_key" ON "PolicyCorpus"("id", "workspaceId");
CREATE UNIQUE INDEX "Proposal_id_workspaceId_key" ON "Proposal"("id", "workspaceId");
CREATE UNIQUE INDEX "Tension_id_workspaceId_key" ON "Tension"("id", "workspaceId");
ALTER TABLE "ConstitutionSourceReference" ADD CONSTRAINT "ConstitutionSourceReference_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConstitutionSourceReference" ADD CONSTRAINT "ConstitutionSourceReference_constitutionId_workspaceId_fkey" FOREIGN KEY ("constitutionId", "workspaceId") REFERENCES "Constitution"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConstitutionSourceReference" ADD CONSTRAINT "ConstitutionSourceReference_policyCorpusId_workspaceId_fkey" FOREIGN KEY ("policyCorpusId", "workspaceId") REFERENCES "PolicyCorpus"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ConstitutionSourceReference" ADD CONSTRAINT "ConstitutionSourceReference_proposalId_workspaceId_fkey" FOREIGN KEY ("proposalId", "workspaceId") REFERENCES "Proposal"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ConstitutionSourceReference" ADD CONSTRAINT "ConstitutionSourceReference_tensionId_workspaceId_fkey" FOREIGN KEY ("tensionId", "workspaceId") REFERENCES "Tension"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
