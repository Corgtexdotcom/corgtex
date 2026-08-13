CREATE FUNCTION public.customer_deployment_release_lease_delete_guard_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."releaseLeaseId" IS NOT NULL THEN
    RAISE EXCEPTION
      USING
        ERRCODE = '23514',
        CONSTRAINT = 'CustomerDeployment_release_lease_delete_guard',
        MESSAGE = 'MANAGED_RELEASE_LEASE_DELETE_CONFLICT';
  END IF;

  RETURN OLD;
END;
$$;

CREATE TRIGGER "CustomerDeployment_release_lease_delete_guard"
BEFORE DELETE ON public."CustomerDeployment"
FOR EACH ROW
EXECUTE FUNCTION public.customer_deployment_release_lease_delete_guard_v1();

ALTER TABLE public."CustomerDeployment"
ENABLE ALWAYS TRIGGER "CustomerDeployment_release_lease_delete_guard";
