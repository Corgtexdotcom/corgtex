-- Close role state only for the exact retired member/workspace recorded by support.
UPDATE "RoleHolderHistory" AS h
SET "endedAt" = CURRENT_TIMESTAMP
FROM "Member" AS m
WHERE h."memberId" = m.id AND h."workspaceId" = m."workspaceId"
  AND h."endedAt" IS NULL AND m."isActive" = false
  AND EXISTS (SELECT 1 FROM "SelfServeSupportSession" AS s
    WHERE s."supportMemberId" = m.id AND s."supportUserId" = m."userId"
      AND s."workspaceId" = m."workspaceId");

UPDATE "RoleOnboardingSession" AS o
SET status = 'DISMISSED', "dismissedAt" = CURRENT_TIMESTAMP,
  "updatedAt" = CURRENT_TIMESTAMP
FROM "Member" AS m
WHERE o."memberId" = m.id AND o."workspaceId" = m."workspaceId"
  AND o.status IN ('PENDING', 'ACTIVE') AND m."isActive" = false
  AND EXISTS (SELECT 1 FROM "SelfServeSupportSession" AS s
    WHERE s."supportMemberId" = m.id AND s."supportUserId" = m."userId"
      AND s."workspaceId" = m."workspaceId");

DELETE FROM "RoleAssignment" AS a
USING "Member" AS m, "Role" AS r, "Circle" AS c
WHERE a."memberId" = m.id AND a."roleId" = r.id AND r."circleId" = c.id
  AND c."workspaceId" = m."workspaceId" AND m."isActive" = false
  AND EXISTS (SELECT 1 FROM "SelfServeSupportSession" AS s
    WHERE s."supportMemberId" = m.id AND s."supportUserId" = m."userId"
      AND s."workspaceId" = m."workspaceId");
