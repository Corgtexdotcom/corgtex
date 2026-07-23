-- CreateTable
CREATE TABLE "WorkspaceIntegrationBinding" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "provider" "CommunicationProvider" NOT NULL,
    "externalWorkspaceId" TEXT NOT NULL,
    "externalOrgId" TEXT,
    "externalTeamName" TEXT,
    "appId" TEXT,
    "installedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkspaceIntegrationBinding_pkey" PRIMARY KEY ("id")
);

-- Backfill one durable Slack team binding per Corgtex workspace from existing installs.
-- If a workspace has more than one historical Slack install, keep the active/latest
-- one as the normal reconnect target and disconnect any other active Slack installs.
INSERT INTO "WorkspaceIntegrationBinding" (
    "id",
    "workspaceId",
    "provider",
    "externalWorkspaceId",
    "externalOrgId",
    "externalTeamName",
    "appId",
    "installedByUserId",
    "createdAt",
    "updatedAt"
)
SELECT
    gen_random_uuid()::text,
    "workspaceId",
    "provider",
    "externalWorkspaceId",
    "externalOrgId",
    "externalTeamName",
    "appId",
    "installedByUserId",
    "installedAt",
    CURRENT_TIMESTAMP
FROM (
    SELECT
        ci.*,
        ROW_NUMBER() OVER (
            PARTITION BY ci."workspaceId", ci."provider"
            ORDER BY
                CASE WHEN ci."status" = 'ACTIVE' THEN 0 ELSE 1 END,
                ci."updatedAt" DESC,
                ci."createdAt" DESC,
                ci."id" ASC
        ) AS rn
    FROM "CommunicationInstallation" ci
    WHERE ci."provider" = 'SLACK'
) ranked
WHERE ranked.rn = 1
ON CONFLICT DO NOTHING;

UPDATE "CommunicationInstallation" ci
SET
    "status" = 'DISCONNECTED',
    "botTokenEnc" = NULL,
    "disconnectedAt" = CURRENT_TIMESTAMP,
    "lastError" = 'Disconnected during Slack tenant binding backfill because another Slack team was selected as the workspace binding.',
    "updatedAt" = CURRENT_TIMESTAMP
FROM "WorkspaceIntegrationBinding" binding
WHERE ci."workspaceId" = binding."workspaceId"
  AND ci."provider" = 'SLACK'
  AND binding."provider" = 'SLACK'
  AND ci."externalWorkspaceId" <> binding."externalWorkspaceId"
  AND ci."status" = 'ACTIVE';

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceIntegrationBinding_workspaceId_provider_key" ON "WorkspaceIntegrationBinding"("workspaceId", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceIntegrationBinding_provider_externalWorkspaceId_key" ON "WorkspaceIntegrationBinding"("provider", "externalWorkspaceId");

-- CreateIndex
CREATE INDEX "WorkspaceIntegrationBinding_workspaceId_idx" ON "WorkspaceIntegrationBinding"("workspaceId");

-- AddForeignKey
ALTER TABLE "WorkspaceIntegrationBinding" ADD CONSTRAINT "WorkspaceIntegrationBinding_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
