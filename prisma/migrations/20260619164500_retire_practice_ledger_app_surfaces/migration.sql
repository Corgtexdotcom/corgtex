-- Retire the legacy Practice Ledger app-runtime override path now that
-- /finance renders the native Practice Ledger dashboard.
--
-- This intentionally preserves rows for audit/history while preventing stale
-- app definitions, installations, sessions, surface assignments, or catalog
-- cards from replacing the native Finance surface.

UPDATE "AppSurfaceAssignment" AS asa
SET
  "enabled" = false,
  "reasonMd" = CASE
    WHEN asa."reasonMd" IS NULL OR asa."reasonMd" = ''
      THEN 'Retired Practice Ledger app-runtime override; Finance is native Practice Ledger.'
    ELSE asa."reasonMd" || E'\n\nRetired Practice Ledger app-runtime override; Finance is native Practice Ledger.'
  END,
  "updatedAt" = now()
FROM "AppInstallation" AS ai
JOIN "AppDefinition" AS ad ON ad.id = ai."appDefinitionId"
WHERE
  asa."appInstallationId" = ai.id
  AND ad."appKey" = 'practice-ledger'
  AND asa."enabled" = true;

UPDATE "AppSession" AS aps
SET
  "revokedAt" = COALESCE(aps."revokedAt", now())
FROM "AppInstallation" AS ai
JOIN "AppDefinition" AS ad ON ad.id = ai."appDefinitionId"
WHERE
  aps."appInstallationId" = ai.id
  AND ad."appKey" = 'practice-ledger'
  AND aps."revokedAt" IS NULL;

UPDATE "AppRuntime" AS ar
SET
  "status" = 'DISABLED',
  "lastHealthStatus" = 'retired',
  "lastHealthError" = 'Practice Ledger app runtime retired; Finance is native Practice Ledger.',
  "updatedAt" = now()
FROM "AppDefinition" AS ad
WHERE
  ar."appDefinitionId" = ad.id
  AND ad."appKey" = 'practice-ledger'
  AND ar."status" <> 'DISABLED';

UPDATE "AppInstallation" AS ai
SET
  "status" = 'DISABLED',
  "lastHealthStatus" = 'retired',
  "lastHealthError" = 'Practice Ledger app installation retired; Finance is native Practice Ledger.',
  "updatedAt" = now()
FROM "AppDefinition" AS ad
WHERE
  ai."appDefinitionId" = ad.id
  AND ad."appKey" = 'practice-ledger'
  AND ai."status" <> 'DISABLED';

UPDATE "AppDefinition"
SET
  "status" = 'DISABLED',
  "updatedAt" = now()
WHERE
  "appKey" = 'practice-ledger'
  AND "status" <> 'DISABLED';

UPDATE "CatalogItem"
SET
  "status" = 'ARCHIVED',
  "accessMode" = 'DISABLED',
  "installationStatus" = 'DISABLED',
  "archivedAt" = COALESCE("archivedAt", now()),
  "archiveReason" = COALESCE(
    "archiveReason",
    'Practice Ledger marketplace app retired; Finance is native Practice Ledger.'
  ),
  "updatedAt" = now()
WHERE
  "sourceType" = 'MARKETPLACE_APP'
  AND "sourceId" = 'practice-ledger';
