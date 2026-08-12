import { AppError } from "./errors";

export function throwCustomerDeploymentReleaseLeaseConflict(): never {
  throw new AppError(
    409,
    "CUSTOMER_DEPLOYMENT_RELEASE_LEASE_CONFLICT",
    "Customer deployment has a retained managed-release lease.",
  );
}
