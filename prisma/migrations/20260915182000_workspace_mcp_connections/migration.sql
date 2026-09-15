ALTER TABLE "McpOAuthAuthorizationCode" ADD COLUMN "supportGrantVersion" INTEGER;
ALTER TABLE "McpOAuthAccessToken" ADD COLUMN "supportGrantVersion" INTEGER;
ALTER TABLE "Event" ADD COLUMN "mcpOrigin" JSONB;
ALTER TABLE "WorkflowJob" ADD COLUMN "mcpOrigin" JSONB;
