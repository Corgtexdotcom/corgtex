ALTER TABLE "AgentCredential" ADD COLUMN "supportGrantVersion" INTEGER;
ALTER TABLE "AppSession" ADD COLUMN "supportGrantVersion" INTEGER;
ALTER TABLE "OAuthAuthorizationCode" ADD COLUMN "supportGrantVersion" INTEGER;
ALTER TABLE "OAuthAccessToken" ADD COLUMN "supportGrantVersion" INTEGER;
ALTER TABLE "McpOAuthAuthorizationCode" ADD COLUMN "supportGrantVersion" INTEGER;
ALTER TABLE "McpOAuthAccessToken" ADD COLUMN "supportGrantVersion" INTEGER;

UPDATE "AppSession" SET "revokedAt" = CURRENT_TIMESTAMP
WHERE "actorUserId" IN (SELECT "supportUserId" FROM "SelfServeSupportSession") AND "revokedAt" IS NULL;
