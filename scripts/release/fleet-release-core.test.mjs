import { describe, expect, it } from "vitest";

import {
  assertHealthProof,
  buildReleaseManifest,
  filterTargetsByGroups,
  formatReleasePlan,
  healthProofErrors,
  imageTagForSha,
  normalizeReleaseInput,
  normalizeTargets,
  providerBoundaryErrors,
  releaseVersionForSha,
  targetEligibilityErrors,
  targetFromControlPlaneRow,
} from "./fleet-release-core.mjs";

const SHA = "c9077ff031e8e672923c84d52eeef862368f3493";

describe("fleet release core", () => {
  it("normalizes release input without treating latest as raw main", () => {
    expect(normalizeReleaseInput()).toBe("latest-stable");
    expect(normalizeReleaseInput("latest")).toBe("latest-stable");
    expect(normalizeReleaseInput(SHA.toUpperCase())).toBe(SHA);
    expect(() => normalizeReleaseInput("main")).toThrow("latest-stable or a full 40-character git SHA");
  });

  it("uses one deterministic version and image tag shape", () => {
    expect(releaseVersionForSha(SHA)).toBe("main-c9077ff031e8");
    expect(imageTagForSha(SHA)).toBe(`sha-${SHA}`);
  });

  it("builds a canonical release manifest from a SHA", () => {
    expect(buildReleaseManifest({ gitSha: SHA, sourceWorkflowRunId: "run-1" })).toMatchObject({
      gitSha: SHA,
      releaseVersion: "main-c9077ff031e8",
      imageTag: `sha-${SHA}`,
      ghcrWebImage: `ghcr.io/corgtexdotcom/corgtex/web:sha-${SHA}`,
      ghcrWorkerImage: `ghcr.io/corgtexdotcom/corgtex/worker:sha-${SHA}`,
      acrWebImage: `acrcorgtexssstgwus3.azurecr.io/corgtex/web:sha-${SHA}`,
      acrWorkerImage: `acrcorgtexssstgwus3.azurecr.io/corgtex/worker:sha-${SHA}`,
      stabilityStatus: "candidate",
      sourceWorkflowRunId: "run-1",
    });
  });

  it("requires strict health proof before release recording", () => {
    const manifest = buildReleaseManifest({ gitSha: SHA });
    const healthy = {
      status: "ok",
      database: "up",
      schema: "ready",
      release: {
        imageTag: manifest.imageTag,
        gitSha: manifest.gitSha,
      },
    };
    expect(assertHealthProof(healthy, manifest, "app")).toBe(true);
    expect(healthProofErrors({
      ...healthy,
      release: { imageTag: "old", gitSha: manifest.gitSha },
    }, manifest)).toEqual(["release.imageTag=old"]);
  });

  it("expands and validates target groups", () => {
    expect(normalizeTargets()).toEqual(["managed-customers", "selfserve", "ops"]);
    expect(normalizeTargets("default")).toEqual(["managed-customers", "selfserve", "ops"]);
    expect(normalizeTargets("all")).toEqual(["managed-customers", "selfserve", "ops", "backup-app"]);
    expect(normalizeTargets("railway-customers,azure-selfserve")).toEqual(["managed-customers", "selfserve"]);
    expect(normalizeTargets("ops,backup-app")).toEqual(["ops", "backup-app"]);
    expect(() => normalizeTargets("demo")).toThrow("Unknown release target");
  });

  it("uses control-plane provider metadata without hostname classification", () => {
    expect(targetFromControlPlaneRow({
      id: "azure-1",
      label: "Azure",
      cloudProvider: "AZURE",
      url: "https://app.corgtex.com",
      providerResourceGroup: "rg-customer",
    })).toMatchObject({ group: "managed-customers", provider: "azure", azure: { resourceGroup: "rg-customer" } });
    expect(targetFromControlPlaneRow({
      id: "customer-1",
      label: "Acme",
      cloudProvider: "RAILWAY",
      url: "https://selfserve.corgtex.com",
    })).toMatchObject({ group: "managed-customers", provider: "railway" });
  });

  it("formats progressive rings without UI-specific behavior", () => {
    const manifest = buildReleaseManifest({ gitSha: SHA });
    const targets = [
      { id: "acme", label: "Acme", group: "managed-customers", provider: "railway", url: "https://acme.test" },
      { id: "ops", label: "Ops", group: "ops", provider: "railway", url: "https://ops.test" },
    ];
    expect(formatReleasePlan({ manifest, targets, dryRun: true, concurrency: 2 })).toMatchObject({
      dryRun: true,
      concurrency: 2,
      release: { gitSha: SHA },
      rings: [
        { ring: 2, targets: [{ id: "acme", criticality: "blocking", backupOnly: false }] },
        { ring: 3, targets: [{ id: "ops", criticality: "blocking", backupOnly: false }] },
      ],
    });
    expect(filterTargetsByGroups(targets, ["ops"])).toEqual([targets[1]]);
  });

  it("flags provider boundary mismatches before deployment", () => {
    expect(providerBoundaryErrors({ group: "selfserve", url: "https://selfserve.corgtex.com" }))
      .toEqual(["Target provider must explicitly be azure or railway, got missing"]);
    expect(providerBoundaryErrors({
      group: "managed-customers",
      provider: "railway",
      url: "https://selfserve.corgtex.com",
    })).toEqual([]);
  });

  it("excludes ineligible targets only for broad selections", () => {
    const active = { id: "active", group: "managed-customers", provider: "railway" };
    const retired = { id: "retired", group: "managed-customers", provider: "railway", deploymentStatus: "RETIRED" }, draft = { id: "draft", group: "managed-customers", provider: "railway", deploymentStatus: "DRAFT" };
    const optedOut = { id: "opted-out", group: "managed-customers", provider: "azure", releaseEligible: false };
    expect(filterTargetsByGroups([active, retired, draft, optedOut], ["managed-customers"], { excludeIneligible: true })).toEqual([active]);
    expect(filterTargetsByGroups([active, retired, draft], ["managed-customers"])).toEqual([active, retired, draft]);
    expect(targetEligibilityErrors(optedOut)).toEqual(["Target explicitly sets releaseEligible=false"]);
  });
});
