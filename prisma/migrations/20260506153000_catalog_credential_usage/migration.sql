-- Attribute model usage to catalog-issued API keys so per-key limits can be enforced.
ALTER TABLE "ModelUsage" ADD COLUMN "agentCredentialId" TEXT;

CREATE INDEX "ModelUsage_workspaceId_agentCredentialId_createdAt_idx"
ON "ModelUsage"("workspaceId", "agentCredentialId", "createdAt");

ALTER TABLE "ModelUsage"
ADD CONSTRAINT "ModelUsage_agentCredentialId_fkey"
FOREIGN KEY ("agentCredentialId") REFERENCES "AgentCredential"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
