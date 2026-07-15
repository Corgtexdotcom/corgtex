UPDATE "Proposal" AS p
SET "ownerMemberId" = m.id
FROM "Member" AS m
JOIN "User" AS u ON u.id = m."userId"
WHERE p."ownerMemberId" IS NULL
  AND p."archivedAt" IS NULL
  AND p.status IN ('DRAFT', 'OPEN')
  AND m."workspaceId" = p."workspaceId"
  AND m."userId" = p."authorUserId"
  AND m."isActive" = true
  AND m.kind = 'HUMAN'
  AND lower(u.email) NOT LIKE 'system+%'
  AND lower(u.email) NOT LIKE 'support+%'
  AND lower(coalesce(u."displayName", '')) <> 'corgtex support';
