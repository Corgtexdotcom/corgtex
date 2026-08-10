ALTER TABLE "CustomerDeployment"
ADD CONSTRAINT "CustomerDeployment_release_lease_eligibility_check" CHECK (
  "releaseLeaseId" IS NULL
  OR (
    "customerAccountId" IS NOT NULL
    AND "deploymentKind" = 'REMOTE_MANAGED'
    AND "cloudProvider" = 'AZURE'
    AND "environment" = 'production'
    AND "deploymentStatus" = 'ACTIVE'
    AND "provisioningStatus" = 'active'
  )
) NOT VALID;

ALTER TABLE "CustomerDeployment"
VALIDATE CONSTRAINT "CustomerDeployment_release_lease_eligibility_check";
