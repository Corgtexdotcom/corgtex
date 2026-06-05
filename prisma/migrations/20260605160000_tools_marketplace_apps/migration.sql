-- Extend the Tools catalog into a workspace-scoped app marketplace.

CREATE TYPE "AppCategory" AS ENUM (
  'FINANCE',
  'KNOWLEDGE',
  'COMMUNICATION',
  'AI',
  'OPERATIONS',
  'GOVERNANCE',
  'DATA',
  'OTHER'
);

CREATE TYPE "AppVisibility" AS ENUM (
  'PUBLIC_MARKETPLACE',
  'UNLISTED',
  'WORKSPACE_PRIVATE',
  'CORGTEX_MANAGED'
);

CREATE TYPE "AppHostingMode" AS ENUM (
  'EXTERNAL_URL',
  'CORGTEX_MANAGED_EXTERNAL',
  'CORGTEX_HOSTED_STATIC',
  'CORGTEX_HOSTED_CONTAINER',
  'MCP_SERVER'
);

CREATE TYPE "AppIntegrationDepth" AS ENUM (
  'CATALOG_ONLY',
  'LAUNCHABLE',
  'MCP_ACTIONABLE',
  'KNOWLEDGE_SYNCED',
  'WORKFLOW_NATIVE'
);

CREATE TYPE "AppInstallationStatus" AS ENUM (
  'REQUESTED',
  'APPROVED',
  'INSTALLED',
  'NEEDS_SETUP',
  'UNHEALTHY',
  'DISABLED'
);

ALTER TYPE "CatalogSourceType" ADD VALUE 'MARKETPLACE_APP';

ALTER TABLE "CatalogItem"
  ADD COLUMN "appCategory" "AppCategory" NOT NULL DEFAULT 'OTHER',
  ADD COLUMN "appVisibility" "AppVisibility" NOT NULL DEFAULT 'WORKSPACE_PRIVATE',
  ADD COLUMN "hostingMode" "AppHostingMode" NOT NULL DEFAULT 'EXTERNAL_URL',
  ADD COLUMN "integrationDepth" "AppIntegrationDepth" NOT NULL DEFAULT 'CATALOG_ONLY',
  ADD COLUMN "installationStatus" "AppInstallationStatus" NOT NULL DEFAULT 'INSTALLED',
  ADD COLUMN "supportUrl" TEXT,
  ADD COLUMN "appMcpUrl" TEXT,
  ADD COLUMN "dataClassification" TEXT DEFAULT 'INTERNAL',
  ADD COLUMN "proofUrl" TEXT,
  ADD COLUMN "reviewUrl" TEXT,
  ADD COLUMN "manifestJson" JSONB,
  ADD COLUMN "capabilitiesJson" JSONB;

CREATE INDEX "CatalogItem_workspaceId_appCategory_installationStatus_idx"
  ON "CatalogItem"("workspaceId", "appCategory", "installationStatus");
