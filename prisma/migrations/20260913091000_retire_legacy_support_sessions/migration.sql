-- Only generated impersonation identities recorded by the legacy support flow.
-- Preserve the historical support-session records for audit.
UPDATE "User" SET "isSupportAccount" = true
WHERE id IN (SELECT "supportUserId" FROM "SelfServeSupportSession");

UPDATE "Member" SET "isActive" = false
WHERE "userId" IN (SELECT "supportUserId" FROM "SelfServeSupportSession");

DELETE FROM "Session"
WHERE "userId" IN (SELECT "supportUserId" FROM "SelfServeSupportSession");

UPDATE "AgentCredential" SET "isActive" = false
WHERE "createdByUserId" IN (SELECT "supportUserId" FROM "SelfServeSupportSession");

UPDATE "McpOAuthAccessToken" SET "revokedAt" = CURRENT_TIMESTAMP
WHERE "userId" IN (SELECT "supportUserId" FROM "SelfServeSupportSession") AND "revokedAt" IS NULL;

UPDATE "OAuthAccessToken" SET "revokedAt" = CURRENT_TIMESTAMP
WHERE "userId" IN (SELECT "supportUserId" FROM "SelfServeSupportSession") AND "revokedAt" IS NULL;

DELETE FROM "McpOAuthAuthorizationCode"
WHERE "userId" IN (SELECT "supportUserId" FROM "SelfServeSupportSession");

DELETE FROM "OAuthAuthorizationCode"
WHERE "userId" IN (SELECT "supportUserId" FROM "SelfServeSupportSession");
