import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { reconcileManagedAzureTarget, requireManagedAzureAccountAuthority } from "./managed-azure-targets";

async function fixture() {
  const account = await prisma.customerAccount.create({ data: { slug: randomUUID(), displayName: "Synthetic", status: "ACTIVE" } });
  const row = await prisma.customerDeployment.create({ data: { label: "Synthetic", url: `https://${randomUUID()}.example.test`, customerAccountId: account.id,
    cloudProvider: "RAILWAY", deploymentKind: "HOSTED_DEDICATED", deploymentStatus: "DEGRADED", supportCredentialEnc: "synthetic-preserved-ciphertext",
    providerPostgresServiceId: "preserve-db", providerRedisServiceId: "preserve-redis", releaseLeaseFence: 26 } });
  const target = { deploymentId: row.id, customerAccountId: account.id, deploymentKind: "HOSTED_DEDICATED", origin: `https://${randomUUID()}.example.test`,
    subscriptionId: randomUUID(), resourceGroup: "rg-client", webAppName: "client-web", workerAppName: "client-worker", acrName: "clientacr",
    acrServer: "clientacr.azurecr.io", acrResourceGroup: "rg-registry", evidenceSha256: "a".repeat(64), activationPolicy: "EXCLUSIVE",
    releaseApproval: { gitSha: "d".repeat(40), schemaApprovalDigest: "e".repeat(64) },
    recovery: { gitSha: "b".repeat(40), releaseVersion: "recovery-1", schemaCompatibilityApprovalDigest: "c".repeat(64) } };
  vi.stubEnv("MANAGED_RELEASE_TARGETS_JSON", JSON.stringify({ schemaVersion: 1, targets: [target] }));
  const request = { deploymentId: row.id, execute: false, reason: "Synthetic provider evidence reconciliation" };
  const ready = await reconcileManagedAzureTarget(request);
  return { account, row, target, request: { ...request, execute: true, expectedMetadataDigest: ready.metadataDigest, expectedTargetDigest: ready.targetDigest } };
}
describe("Azure target reconciliation", () => {
  beforeEach(truncateAllTables);
  afterEach(() => vi.unstubAllEnvs());
  it("changes only approved metadata on the same row, preserving status, data bindings, credentials and fence", async () => {
    const { row, target, request } = await fixture();
    const result = await reconcileManagedAzureTarget(request);
    const after = await prisma.customerDeployment.findUniqueOrThrow({ where: { id: row.id } });
    expect(after).toEqual({ ...row, updatedAt: expect.any(Date), url: target.origin, cloudProvider: "AZURE", providerSubscriptionId: target.subscriptionId,
      providerResourceGroup: target.resourceGroup, providerWebServiceId: target.webAppName, providerWorkerServiceId: target.workerAppName });
    expect(result.status).toBe("RECONCILED");
    const events = await prisma.customerDeploymentEvent.findMany({ where: { deploymentId: row.id } });
    expect(events).toHaveLength(1);
    expect(events[0].meta).toMatchObject({ beforeDigest: request.expectedMetadataDigest, afterDigest: result.metadataDigest, evidenceSha256: target.evidenceSha256 });
    expect(JSON.stringify(events)).not.toContain(row.supportCredentialEnc);
  });
  it("allows only one writer against the exact observed metadata version", async () => {
    const { request } = await fixture();
    const results = await Promise.allSettled([reconcileManagedAzureTarget(request), reconcileManagedAzureTarget(request)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(await prisma.customerDeploymentEvent.count()).toBe(1);
  });
  it("rejects a changed account, revoked authority, retained lease, stale digest or target evidence with no repair", async () => {
    const { row, account, target, request } = await fixture();
    await expect(reconcileManagedAzureTarget({ ...request, expectedMetadataDigest: "b".repeat(64) })).rejects.toThrow();
    vi.stubEnv("MANAGED_RELEASE_TARGETS_JSON", JSON.stringify({ schemaVersion: 1, targets: [{ ...target, evidenceSha256: "b".repeat(64) }] }));
    await expect(reconcileManagedAzureTarget(request)).rejects.toThrow();
    for (const data of [{ status: "SUSPENDED" as const }, { status: "ACTIVE" as const, managementAuthority: "SELF_MANAGED" as const }]) {
      await prisma.customerAccount.update({ where: { id: account.id }, data });
      await expect(reconcileManagedAzureTarget(request)).rejects.toThrow();
      await expect(requireManagedAzureAccountAuthority(prisma, row)).rejects.toThrow();
    }
    expect(await prisma.customerDeploymentEvent.count()).toBe(0);
    expect((await prisma.customerDeployment.findUniqueOrThrow({ where: { id: row.id } })).cloudProvider).toBe("RAILWAY");
  });
  it("does not silently alias another stable deployment", async () => {
    const { target, request } = await fixture();
    await prisma.customerDeployment.create({ data: { label: "Other", url: target.origin } });
    await expect(reconcileManagedAzureTarget(request)).rejects.toMatchObject({ code: "MANAGED_RELEASE_TARGET_OVERLAP" });
    expect(await prisma.customerDeploymentEvent.count()).toBe(0);
  });
});
