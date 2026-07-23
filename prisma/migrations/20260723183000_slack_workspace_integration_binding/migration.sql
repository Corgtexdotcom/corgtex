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
-- If a workspace has more than one historical Slack install, keep the active/latest one
-- as the normal reconnect target and let application guards reject future team moves.
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
    md5("workspaceId" || ':SLACK:' || "externalWorkspaceId"),
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

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceIntegrationBinding_workspaceId_provider_key" ON "WorkspaceIntegrationBinding"("workspaceId", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceIntegrationBinding_provider_externalWorkspaceId_key" ON "WorkspaceIntegrationBinding"("provider", "externalWorkspaceId");

-- CreateIndex
CREATE INDEX "WorkspaceIntegrationBinding_workspaceId_idx" ON "WorkspaceIntegrationBinding"("workspaceId");

-- AddForeignKey
ALTER TABLE "WorkspaceIntegrationBinding" ADD CONSTRAINT "WorkspaceIntegrationBinding_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
