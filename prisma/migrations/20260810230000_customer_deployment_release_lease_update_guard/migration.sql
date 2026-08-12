CREATE FUNCTION public.customer_deployment_release_lease_update_guard_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  excluded_columns text[] := ARRAY[
    'releaseLeaseFence', 'releaseLeaseId', 'releaseLeaseTokenHash',
    'releaseLeaseOwner', 'releaseLeaseExpectedImageTag',
    'releaseLeaseIncomingImageTag', 'releaseLeaseIncomingVersion',
    'releaseLeasePhase', 'releaseLeaseAcquiredAt',
    'releaseLeaseHeartbeatAt', 'releaseLeaseExpiresAt',
    'releaseLeaseRollbackRecord', 'releaseLeaseRecoveryEvidence',
    'releaseLeaseError', 'updatedAt'
  ];
  non_lease_changed boolean;
  invalid_transition boolean;
BEGIN
  IF OLD."releaseLeaseId" IS NULL THEN
    RETURN NEW;
  END IF;

  non_lease_changed :=
    (to_jsonb(NEW) - excluded_columns)
    IS DISTINCT FROM (to_jsonb(OLD) - excluded_columns);

  IF NEW."releaseLeaseId" IS NULL THEN
    invalid_transition :=
      NEW."releaseLeaseFence" IS DISTINCT FROM OLD."releaseLeaseFence"
      OR non_lease_changed;
  ELSE
    invalid_transition :=
      ROW(
        NEW."releaseLeaseFence", NEW."releaseLeaseId", NEW."releaseLeaseTokenHash",
        NEW."releaseLeaseOwner", NEW."releaseLeaseExpectedImageTag",
        NEW."releaseLeaseIncomingImageTag", NEW."releaseLeaseIncomingVersion",
        NEW."releaseLeasePhase", NEW."releaseLeaseAcquiredAt",
        NEW."releaseLeaseHeartbeatAt", NEW."releaseLeaseExpiresAt",
        NEW."releaseLeaseRollbackRecord", NEW."releaseLeaseRecoveryEvidence",
        NEW."releaseLeaseError"
      ) IS NOT DISTINCT FROM ROW(
        OLD."releaseLeaseFence", OLD."releaseLeaseId", OLD."releaseLeaseTokenHash",
        OLD."releaseLeaseOwner", OLD."releaseLeaseExpectedImageTag",
        OLD."releaseLeaseIncomingImageTag", OLD."releaseLeaseIncomingVersion",
        OLD."releaseLeasePhase", OLD."releaseLeaseAcquiredAt",
        OLD."releaseLeaseHeartbeatAt", OLD."releaseLeaseExpiresAt",
        OLD."releaseLeaseRollbackRecord", OLD."releaseLeaseRecoveryEvidence",
        OLD."releaseLeaseError"
      )
      OR non_lease_changed;
  END IF;

  IF invalid_transition THEN
    RAISE EXCEPTION
      USING
        ERRCODE = '23514',
        CONSTRAINT = 'CustomerDeployment_release_lease_update_guard',
        MESSAGE = 'MANAGED_RELEASE_LEASE_UPDATE_CONFLICT';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "CustomerDeployment_release_lease_update_guard"
BEFORE UPDATE ON public."CustomerDeployment"
FOR EACH ROW
EXECUTE FUNCTION public.customer_deployment_release_lease_update_guard_v1();

ALTER TABLE public."CustomerDeployment"
ENABLE ALWAYS TRIGGER "CustomerDeployment_release_lease_update_guard";
