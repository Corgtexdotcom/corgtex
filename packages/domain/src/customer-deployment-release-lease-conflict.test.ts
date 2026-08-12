import { describe, expect, it } from "vitest";
import { AppError } from "./errors";
import * as conflictBoundary from "./customer-deployment-release-lease-conflict";

function captureConflict() {
  try {
    conflictBoundary.throwCustomerDeploymentReleaseLeaseConflict();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    return error as AppError;
  }
  throw new Error("Expected the conflict boundary to throw.");
}

describe("customer deployment release lease conflict boundary", () => {
  it("throws the fixed data-free application conflict", () => {
    const error = captureConflict();

    expect(error).toMatchObject({
      status: 409,
      code: "CUSTOMER_DEPLOYMENT_RELEASE_LEASE_CONFLICT",
      message: "Customer deployment has a retained managed-release lease.",
    });
    expect(Object.prototype.hasOwnProperty.call(error, "cause")).toBe(false);
  });

  it("creates fresh equivalent errors without shared mutable state", () => {
    const first = captureConflict();
    first.status = 418;
    first.code = "MUTATED";
    first.message = "mutated";

    const second = captureConflict();
    expect(second).not.toBe(first);
    expect(second).toMatchObject({
      status: 409,
      code: "CUSTOMER_DEPLOYMENT_RELEASE_LEASE_CONFLICT",
      message: "Customer deployment has a retained managed-release lease.",
    });
  });

  it("exposes only one zero-argument runtime function from its module", () => {
    expect(Object.keys(conflictBoundary)).toEqual([
      "throwCustomerDeploymentReleaseLeaseConflict",
    ]);
    expect(conflictBoundary.throwCustomerDeploymentReleaseLeaseConflict).toHaveLength(0);
  });

  it("remains absent from the domain package barrel", async () => {
    const domain = await import("./index");

    expect("throwCustomerDeploymentReleaseLeaseConflict" in domain).toBe(false);
  });
});
