-- Preserve existing invalid policy bytes and fail closed for operator repair.
-- Never reinterpret NULL as an empty allowlist or change a restriction here.
BEGIN;
LOCK TABLE "ExternalDataSource", "InformationCategoryPolicy" IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "ExternalDataSource" WHERE "allowedRoleIds" IS NULL OR "allowedCircleIds" IS NULL)
    OR EXISTS (SELECT 1 FROM "InformationCategoryPolicy" WHERE "allowedRoleIds" IS NULL OR "allowedCircleIds" IS NULL) THEN
    RAISE EXCEPTION 'SQL_POLICY_ARRAY_REPAIR_REQUIRED: existing NULL allowlists are preserved; repair under explicit policy authority before retrying migration';
  END IF;
END $$;
ALTER TABLE "ExternalDataSource"
  ALTER COLUMN "allowedRoleIds" SET NOT NULL,
  ALTER COLUMN "allowedCircleIds" SET NOT NULL;
ALTER TABLE "InformationCategoryPolicy"
  ALTER COLUMN "allowedRoleIds" SET NOT NULL,
  ALTER COLUMN "allowedCircleIds" SET NOT NULL;
COMMIT;
