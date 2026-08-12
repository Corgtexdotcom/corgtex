import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildManagedAzureRollbackRecord, managedAzureContractErrors, managedAzureRegistryErrors,
  managedAzureRollbackRecordErrors, normalizeImageDigest, selectManagedAzureTarget,
} from "./azure-release-managed-target.mjs";

const SHA = "c9077ff031e8e672923c84d52eeef862368f3493", OLD = "a".repeat(40), DIGEST = `sha256:${"b".repeat(64)}`;
const target = (overrides = {}) => ({
  deploymentId: "dep-managed", label: "Managed", url: "https://managed.example", provider: "azure", group: "managed-customers", workload: "managed-customers",
  currentRelease: `sha-${OLD}`, azure: { resourceGroup: "rg", acrName: "acr", acrServer: "acr.azurecr.io", webAppName: "web", workerAppName: "worker" }, ...overrides,
});
const options = { release: SHA, expectedCurrentRelease: `sha-${OLD}`, rollbackFile: "/tmp/rollback.json", requireCurrentRelease: true, dryRun: true };

describe("managed Azure release contract", () => {
  it("is pure and composes the workload identity assessor", () => {
    const source = readFileSync(new URL("./azure-release-managed-target.mjs", import.meta.url), "utf8");
    expect(source).toContain("assessAzureReleaseWorkloadIdentity");
    expect(source).not.toMatch(/node:fs|child_process|\bfetch\b/);
  });

  it("requires one exact managed deployment", () => {
    expect(() => selectManagedAzureTarget([target()], null, 0)).toThrow("exactly one explicit");
    expect(() => selectManagedAzureTarget([target()], "missing", 1)).toThrow("resolved to 0 targets");
    expect(() => selectManagedAzureTarget([target(), target({ label: "Duplicate" })], "dep-managed", 1)).toThrow("resolved to 2 targets");
    expect(selectManagedAzureTarget([target()], "dep-managed", 1)).toMatchObject({ deploymentId: "dep-managed" });
  });

  it("names every missing target field and rejects non-SHA releases", () => {
    expect(managedAzureContractErrors(target({ deploymentId: null, url: "http://managed.example", azure: {} }), {})).toEqual(expect.arrayContaining([
      "deploymentId is missing", "url must use HTTPS", "azure.resourceGroup is missing", "azure.acrName is missing", "azure.acrServer is missing",
      "azure.webAppName is missing", "azure.workerAppName is missing", "release must be an explicit full 40-character git SHA",
      "--expected-current-release is required", "FLEET_RELEASE_ROLLBACK_FILE is required",
    ]));
  });

  it("fails closed on release CAS, workflow, observation, and pull identity", () => {
    expect(managedAzureContractErrors(target(), { ...options, release: "latest-stable" })).toContain("release must be an explicit full 40-character git SHA");
    expect(managedAzureContractErrors(target(), { ...options, expectedCurrentRelease: "sha-wrong", dryRun: false })).toEqual(expect.arrayContaining([
      expect.stringContaining("does not match control plane"), "managed Azure mutation requires an audited workflow_dispatch run",
      "tenant-scoped managed Azure observation is not configured for this deployment",
    ]));
    expect(managedAzureRegistryErrors(target(), { web: [{ server: "acr.azurecr.io" }], worker: [] })).toEqual([
      "web Container App registry pull identity is missing", "worker Container App registry entry for azure.acrServer is missing",
    ]);
  });

  it("builds and validates exact rollback records", () => {
    const image = `acr.azurecr.io/corgtex/web@${DIGEST}`;
    const record = buildManagedAzureRollbackRecord(target(), { gitSha: SHA, imageTag: `sha-${SHA}`, releaseVersion: `main-${SHA.slice(0, 12)}` },
      { web: { image, readyRevision: "web-ready" }, worker: { image: image.replace("web", "worker"), readyRevision: "worker-ready" } }, { webDigest: DIGEST, workerDigest: DIGEST }, "2026-08-10T00:00:00.000Z");
    const unsafe = buildManagedAzureRollbackRecord(target(), record.incoming, { ...record.previous, worker: { ...record.previous.worker, image: "acr.azurecr.io/corgtex/worker:mutable" } }, record.incoming, record.capturedAt);
    expect(normalizeImageDigest(DIGEST.toUpperCase())).toBe(DIGEST);
    expect(managedAzureRollbackRecordErrors(record)).toEqual([]);
    expect(unsafe.rollbackDigestPinned).toBe(false); expect(managedAzureRollbackRecordErrors(null)).toEqual(["rollback record must be an object"]);
    expect(managedAzureRollbackRecordErrors({ ...record, previous: { ...record.previous, web: { ...record.previous.web, image: `other.example/corgtex/web@${DIGEST}` } } })).toContain("previous.web.image must be target-registry digest-pinned");
    expect(managedAzureRollbackRecordErrors({ ...record, rollbackDigestPinned: false, previous: { ...record.previous, worker: {} } })).toEqual(expect.arrayContaining([
      "previous.worker.image must be target-registry digest-pinned", "rollbackDigestPinned must be true",
    ]));
  });
});
