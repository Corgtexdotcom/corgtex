import { randomUUID } from "node:crypto";
import type { CustomerDeployment } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertManagedAzureTargetBinding, managedAzureTargetDigest, managedAzureTargets, managedAzureMetadataDigest } from "./managed-azure-targets";
const target = { deploymentId: randomUUID(), customerAccountId: randomUUID(), deploymentKind: "HOSTED_DEDICATED" as const,
  origin: "https://client.example.test", subscriptionId: randomUUID(), resourceGroup: "rg-client", webAppName: "client-web", workerAppName: "client-worker",
  acrName: "clientacr", acrServer: "clientacr.azurecr.io", acrResourceGroup: "rg-registry", evidenceSha256: "a".repeat(64), activationPolicy: "EXCLUSIVE" as const,
  releaseApproval: { gitSha: "d".repeat(40), schemaApprovalDigest: "e".repeat(64) },
  recovery: { gitSha: "b".repeat(40), releaseVersion: "recovery-1", schemaCompatibilityApprovalDigest: "c".repeat(64) } };
function row() { return { id: target.deploymentId, customerAccountId: target.customerAccountId, deploymentKind: target.deploymentKind,
  cloudProvider: "AZURE", environment: "production", url: target.origin, providerSubscriptionId: target.subscriptionId,
  providerResourceGroup: target.resourceGroup, providerWebServiceId: target.webAppName, providerWorkerServiceId: target.workerAppName,
  updatedAt: new Date("2026-01-01T00:00:00Z") } as CustomerDeployment; }
function install(value = target) { vi.stubEnv("MANAGED_RELEASE_TARGETS_JSON", JSON.stringify({ schemaVersion: 1, targets: [value] })); }
describe("protected Azure target configuration", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("binds stable deployment/account identity and exact provider target including registry", () => {
    install(); expect(assertManagedAzureTargetBinding(row(), target)).toEqual(target);
    const arm = `/subscriptions/${target.subscriptionId}/resourceGroups/${target.resourceGroup}/providers/Microsoft.App/containerApps/`;
    expect(assertManagedAzureTargetBinding({ ...row(), providerWebServiceId: `${arm}${target.webAppName}` }, target)).toEqual(target);
    for (const change of [{ customerAccountId: randomUUID() }, { deploymentKind: "REMOTE_MANAGED" }, { cloudProvider: "RAILWAY" }, { environment: "staging" },
      { url: "https://other.example.test" }, { providerSubscriptionId: randomUUID() }, { providerWebServiceId: "other-web" }]) {
      expect(() => assertManagedAzureTargetBinding({ ...row(), ...change } as CustomerDeployment, target)).toThrow();
    }
    expect(() => assertManagedAzureTargetBinding(row(), { acrName: "otheracr", acrServer: "otheracr.azurecr.io" })).toThrow();
  });
  it("requires protected hosted configuration without changing unmapped historical remote behavior", () => {
    vi.stubEnv("MANAGED_RELEASE_TARGETS_JSON", "");
    expect(() => assertManagedAzureTargetBinding(row())).toThrow();
    expect(assertManagedAzureTargetBinding({ ...row(), deploymentKind: "REMOTE_MANAGED" })).toBeNull();
  });
  it("rejects malformed configuration, mismatched registry, arbitrary fields and aliases", () => {
    for (const value of ["broken", JSON.stringify({ schemaVersion: 1, targets: [{ ...target, acrServer: "other.azurecr.io" }] }),
      JSON.stringify({ schemaVersion: 1, targets: [{ ...target, releaseEligible: true }] }),
      JSON.stringify({ schemaVersion: 1, targets: [target, { ...target, deploymentId: randomUUID() }] })]) expect(() => managedAzureTargets(value)).toThrow();
  });
  it("binds provider evidence and observed metadata changes into comparison digests", () => {
    expect(managedAzureTargetDigest(target)).not.toBe(managedAzureTargetDigest({ ...target, evidenceSha256: "b".repeat(64) }));
    const account = { id: target.customerAccountId, status: "ACTIVE" as const, managementAuthority: "CORGTEX" as const, primaryDeploymentId: target.deploymentId, updatedAt: new Date() };
    const original = managedAzureMetadataDigest(row(), account);
    expect(managedAzureMetadataDigest({ ...row(), url: "https://changed.example.test" }, account)).not.toBe(original);
    expect(managedAzureMetadataDigest(row(), { ...account, managementAuthority: "SELF_MANAGED" })).not.toBe(original);
  });
});
