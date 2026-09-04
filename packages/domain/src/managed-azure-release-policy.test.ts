import { afterEach, describe, expect, it, vi } from "vitest";
import { managedAzureReleaseDeployment, managedAzureReleaseEligible, selectedManagedAzurePrimaryIds } from "./managed-azure-release-policy";

const id = "123e4567-e89b-42d3-a456-426614174001";
const other = "123e4567-e89b-42d3-a456-426614174002";
const hosted = { id, customerAccountId: "account", deploymentKind: "HOSTED_DEDICATED", cloudProvider: "AZURE", environment: "production", deploymentStatus: "ACTIVE", provisioningStatus: "active" };
afterEach(() => vi.unstubAllEnvs());

describe("managed Azure release admission", () => {
  it("admits selected hosted IDs from Ops configuration only, preserving real classification", () => {
    vi.stubEnv("MANAGED_RELEASE_PRIMARY_DEPLOYMENT_IDS", `${id}, ${other}`);
    expect(managedAzureReleaseEligible(hosted)).toBe(true);
    expect(managedAzureReleaseDeployment(hosted, "ACTIVE_CLIENT_PRIMARY")).toMatchObject({ deploymentKind: "HOSTED_DEDICATED", group: "hosted-dedicated", workload: "hosted-dedicated", releaseEligible: true });
    vi.stubEnv("MANAGED_RELEASE_PRIMARY_DEPLOYMENT_IDS", other);
    expect(managedAzureReleaseEligible({ ...hosted, releaseEligible: true } as typeof hosted)).toBe(false);
  });
  it.each(["", "latest", `${id},`, `${id},bad`, `${id},${id}`, "x".repeat(3701)])("rejects malformed selection atomically: %s", (selection) => {
    vi.stubEnv("MANAGED_RELEASE_PRIMARY_DEPLOYMENT_IDS", selection);
    expect(selectedManagedAzurePrimaryIds()).toEqual([]);
    expect(managedAzureReleaseEligible(hosted)).toBe(false);
    expect(managedAzureReleaseEligible({ ...hosted, deploymentKind: "REMOTE_MANAGED" })).toBe(true);
  });
  it.each([
    { customerAccountId: null }, { deploymentKind: "SHARED_WORKSPACE" }, { cloudProvider: "RAILWAY" },
    { environment: "staging" }, { deploymentStatus: "SUSPENDED" }, { provisioningStatus: "draft" },
  ])("rejects non-authoritative/inactive target %j", (change) => {
    vi.stubEnv("MANAGED_RELEASE_PRIMARY_DEPLOYMENT_IDS", id);
    expect(managedAzureReleaseEligible({ ...hosted, ...change })).toBe(false);
  });
  it("keeps canary selection separate and does not grant primary execution", () => {
    vi.stubEnv("MANAGED_RELEASE_PRIMARY_DEPLOYMENT_IDS", "");
    vi.stubEnv("MANAGED_RELEASE_CANARY_PREFLIGHT_DEPLOYMENT_ID", id);
    expect(managedAzureReleaseEligible(hosted, "ACTIVE_CLIENT_CANARY")).toBe(true);
    expect(managedAzureReleaseEligible(hosted)).toBe(false);
    expect(managedAzureReleaseDeployment(hosted, "ACTIVE_CLIENT_CANARY")).toMatchObject({ releaseEligible: false, workload: "active-client-canary" });
    expect(managedAzureReleaseEligible({ ...hosted, id: other }, "ACTIVE_CLIENT_CANARY")).toBe(false);
    expect(managedAzureReleaseEligible(hosted, "forged-class")).toBe(false);
  });
});
