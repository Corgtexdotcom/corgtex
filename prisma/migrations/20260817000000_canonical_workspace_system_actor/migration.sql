BEGIN;

LOCK TABLE
  "Workspace",
  "User",
  "UserSsoIdentity",
  "OAuthConnection",
  "ExternalMcpConnection",
  "Member",
  "Session",
  "PasswordResetToken",
  "OAuthAuthorizationCode",
  "OAuthAccessToken",
  "McpOAuthAuthorizationCode",
  "McpOAuthAccessToken",
  "AppSession",
  "ApprovalPolicy"
IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "Workspace" AS workspace
    WHERE workspace."slug" = ''
      OR workspace."slug" <> regexp_replace(lower(btrim(workspace."slug")), '[^a-z0-9-]', '-', 'g')
  ) THEN
    RAISE EXCEPTION
      USING ERRCODE = '23514', MESSAGE = 'CANONICAL_WORKSPACE_SLUG_INVALID';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "Workspace" AS workspace
    GROUP BY 'system+' || regexp_replace(lower(btrim(workspace."slug")), '[^a-z0-9-]', '-', 'g') || '@corgtex.local'
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION
      USING ERRCODE = '23514', MESSAGE = 'CANONICAL_SYSTEM_ACTOR_COLLISION';
  END IF;

  IF EXISTS (
    WITH expected AS (
      SELECT
        workspace."id" AS "workspaceId",
        'system+' || workspace."slug" || '@corgtex.local' AS email
      FROM "Workspace" AS workspace
    )
    SELECT 1
    FROM expected
    JOIN "User" AS candidate ON lower(candidate."email") = expected.email
    WHERE candidate."email" <> expected.email
      OR candidate."globalRole" <> 'USER'
      OR EXISTS (
        SELECT 1
        FROM "UserSsoIdentity" AS identity
        WHERE identity."userId" = candidate."id"
      )
      OR EXISTS (
        SELECT 1
        FROM "OAuthConnection" AS connection
        WHERE connection."userId" = candidate."id"
      )
      OR EXISTS (
        SELECT 1
        FROM "ExternalMcpConnection" AS connection
        WHERE connection."userId" = candidate."id"
      )
      OR (
        SELECT count(*)
        FROM "Member" AS membership
        WHERE membership."userId" = candidate."id"
      ) <> 1
      OR NOT EXISTS (
        SELECT 1
        FROM "Member" AS membership
        WHERE membership."userId" = candidate."id"
          AND membership."workspaceId" = expected."workspaceId"
          AND membership."kind" = 'SYSTEM'
          AND membership."mergedAt" IS NULL
          AND membership."mergedIntoMemberId" IS NULL
      )
  ) THEN
    RAISE EXCEPTION
      USING ERRCODE = '23514', MESSAGE = 'CANONICAL_SYSTEM_ACTOR_COLLISION';
  END IF;
END;
$$;

INSERT INTO "User" (
  "id",
  "email",
  "displayName",
  "passwordHash",
  "createdAt",
  "updatedAt"
)
SELECT
  gen_random_uuid()::text,
  'system+' || workspace."slug" || '@corgtex.local',
  workspace."name" || ' System',
  'disabled$canonical-workspace-system-actor-v1',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "Workspace" AS workspace
WHERE NOT EXISTS (
  SELECT 1
  FROM "User" AS candidate
  WHERE lower(candidate."email") = 'system+' || workspace."slug" || '@corgtex.local'
);

UPDATE "User" AS canonical_user
SET
  "passwordHash" = 'disabled$canonical-workspace-system-actor-v1',
  "updatedAt" = CURRENT_TIMESTAMP
FROM "Workspace" AS workspace
WHERE canonical_user."email" = 'system+' || workspace."slug" || '@corgtex.local'
  AND canonical_user."passwordHash" <> 'disabled$canonical-workspace-system-actor-v1';

DELETE FROM "Session" AS session
USING "Workspace" AS workspace, "User" AS canonical_user
WHERE canonical_user."email" = 'system+' || workspace."slug" || '@corgtex.local'
  AND session."userId" = canonical_user."id";

UPDATE "PasswordResetToken" AS token
SET "usedAt" = CURRENT_TIMESTAMP
FROM "Workspace" AS workspace, "User" AS canonical_user
WHERE canonical_user."email" = 'system+' || workspace."slug" || '@corgtex.local'
  AND token."userId" = canonical_user."id"
  AND token."usedAt" IS NULL;

UPDATE "OAuthAuthorizationCode" AS code
SET "usedAt" = CURRENT_TIMESTAMP
FROM "Workspace" AS workspace, "User" AS canonical_user
WHERE canonical_user."email" = 'system+' || workspace."slug" || '@corgtex.local'
  AND code."userId" = canonical_user."id"
  AND code."usedAt" IS NULL;

UPDATE "OAuthAccessToken" AS token
SET "revokedAt" = CURRENT_TIMESTAMP
FROM "Workspace" AS workspace, "User" AS canonical_user
WHERE canonical_user."email" = 'system+' || workspace."slug" || '@corgtex.local'
  AND token."userId" = canonical_user."id"
  AND token."revokedAt" IS NULL;

UPDATE "McpOAuthAuthorizationCode" AS code
SET "usedAt" = CURRENT_TIMESTAMP
FROM "Workspace" AS workspace, "User" AS canonical_user
WHERE canonical_user."email" = 'system+' || workspace."slug" || '@corgtex.local'
  AND code."userId" = canonical_user."id"
  AND code."usedAt" IS NULL;

UPDATE "McpOAuthAccessToken" AS token
SET "revokedAt" = CURRENT_TIMESTAMP
FROM "Workspace" AS workspace, "User" AS canonical_user
WHERE canonical_user."email" = 'system+' || workspace."slug" || '@corgtex.local'
  AND token."userId" = canonical_user."id"
  AND token."revokedAt" IS NULL;

UPDATE "AppSession" AS session
SET "revokedAt" = CURRENT_TIMESTAMP
FROM "Workspace" AS workspace, "User" AS canonical_user
WHERE canonical_user."email" = 'system+' || workspace."slug" || '@corgtex.local'
  AND session."actorUserId" = canonical_user."id"
  AND session."revokedAt" IS NULL;

INSERT INTO "Member" (
  "id",
  "workspaceId",
  "userId",
  "role",
  "kind",
  "isActive",
  "joinedAt"
)
SELECT
  gen_random_uuid()::text,
  workspace."id",
  canonical_user."id",
  'ADMIN',
  'SYSTEM',
  true,
  CURRENT_TIMESTAMP
FROM "Workspace" AS workspace
JOIN "User" AS canonical_user
  ON canonical_user."email" = 'system+' || workspace."slug" || '@corgtex.local'
ON CONFLICT ("workspaceId", "userId") DO UPDATE
SET
  "role" = 'ADMIN',
  "kind" = 'SYSTEM',
  "isActive" = true;

INSERT INTO "ApprovalPolicy" (
  "id",
  "workspaceId",
  "subjectType",
  "mode",
  "quorumPercent",
  "minApproverCount",
  "decisionWindowHours",
  "requireProposalLink",
  "createdAt",
  "updatedAt"
)
SELECT
  gen_random_uuid()::text,
  workspace."id",
  'PROPOSAL',
  'CONSENT',
  0,
  1,
  72,
  false,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "Workspace" AS workspace
ON CONFLICT ("workspaceId", "subjectType") DO NOTHING;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "Workspace" AS workspace
    LEFT JOIN "User" AS canonical_user
      ON canonical_user."email" = 'system+' || workspace."slug" || '@corgtex.local'
      AND canonical_user."globalRole" = 'USER'
    LEFT JOIN "Member" AS membership
      ON membership."workspaceId" = workspace."id"
      AND membership."userId" = canonical_user."id"
      AND membership."role" = 'ADMIN'
      AND membership."kind" = 'SYSTEM'
      AND membership."isActive" = true
      AND membership."mergedAt" IS NULL
      AND membership."mergedIntoMemberId" IS NULL
    LEFT JOIN "ApprovalPolicy" AS policy
      ON policy."workspaceId" = workspace."id"
      AND policy."subjectType" = 'PROPOSAL'
    WHERE canonical_user."id" IS NULL
      OR membership."id" IS NULL
      OR policy."id" IS NULL
      OR canonical_user."passwordHash" <> 'disabled$canonical-workspace-system-actor-v1'
      OR EXISTS (
        SELECT 1
        FROM "UserSsoIdentity" AS identity
        WHERE identity."userId" = canonical_user."id"
      )
      OR EXISTS (
        SELECT 1
        FROM "OAuthConnection" AS connection
        WHERE connection."userId" = canonical_user."id"
      )
      OR EXISTS (
        SELECT 1
        FROM "ExternalMcpConnection" AS connection
        WHERE connection."userId" = canonical_user."id"
      )
      OR (
        SELECT count(*)
        FROM "Member" AS all_memberships
        WHERE all_memberships."userId" = canonical_user."id"
      ) <> 1
      OR EXISTS (
        SELECT 1 FROM "Session" AS session
        WHERE session."userId" = canonical_user."id"
      )
      OR EXISTS (
        SELECT 1 FROM "PasswordResetToken" AS token
        WHERE token."userId" = canonical_user."id" AND token."usedAt" IS NULL
      )
      OR EXISTS (
        SELECT 1 FROM "OAuthAuthorizationCode" AS code
        WHERE code."userId" = canonical_user."id" AND code."usedAt" IS NULL
      )
      OR EXISTS (
        SELECT 1 FROM "OAuthAccessToken" AS token
        WHERE token."userId" = canonical_user."id" AND token."revokedAt" IS NULL
      )
      OR EXISTS (
        SELECT 1 FROM "McpOAuthAuthorizationCode" AS code
        WHERE code."userId" = canonical_user."id" AND code."usedAt" IS NULL
      )
      OR EXISTS (
        SELECT 1 FROM "McpOAuthAccessToken" AS token
        WHERE token."userId" = canonical_user."id" AND token."revokedAt" IS NULL
      )
      OR EXISTS (
        SELECT 1 FROM "AppSession" AS session
        WHERE session."actorUserId" = canonical_user."id" AND session."revokedAt" IS NULL
      )
  ) THEN
    RAISE EXCEPTION
      USING ERRCODE = '23514', MESSAGE = 'CANONICAL_SYSTEM_ACTOR_POSTCONDITION_FAILED';
  END IF;
END;
$$;

COMMIT;
