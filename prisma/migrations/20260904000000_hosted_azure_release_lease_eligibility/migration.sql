BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
ALTER TABLE "CustomerDeployment" DROP CONSTRAINT "CustomerDeployment_release_lease_eligibility_check";
ALTER TABLE "CustomerDeployment"
ADD CONSTRAINT "CustomerDeployment_release_lease_eligibility_check" CHECK (
  "releaseLeaseId" IS NULL
  OR (
    "customerAccountId" IS NOT NULL
    AND "deploymentKind" IN ('REMOTE_MANAGED', 'HOSTED_DEDICATED')
    AND "cloudProvider" = 'AZURE'
    AND "environment" = 'production'
    AND "deploymentStatus" = 'ACTIVE'
    AND "provisioningStatus" = 'active'
  )
) NOT VALID;

ALTER TABLE "CustomerDeployment"
VALIDATE CONSTRAINT "CustomerDeployment_release_lease_eligibility_check";

COMMIT;
