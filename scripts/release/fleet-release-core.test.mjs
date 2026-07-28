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
    expect(normalizeTargets()).toEqual(["railway-customers", "azure-managed-customers", "azure-selfserve", "ops"]);
    expect(normalizeTargets("default")).toEqual(["railway-customers", "azure-managed-customers", "azure-selfserve", "ops"]);
    expect(normalizeTargets("all")).toEqual(["railway-customers", "azure-managed-customers", "azure-selfserve", "ops", "backup-app"]);
    expect(normalizeTargets("ops,backup-app")).toEqual(["ops", "backup-app"]);
    expect(() => normalizeTargets("demo")).toThrow("Unknown release target");
  });

  it("classifies control-plane rows by provider and URL", () => {
    expect(targetFromControlPlaneRow({
      id: "azure-1",
      label: "Azure",
      cloudProvider: "AZURE",
      url: "https://selfserve.corgtex.com",
    })).toMatchObject({ group: "azure-selfserve", provider: "azure" });
    expect(targetFromControlPlaneRow({
      id: "azure-customer-1",
      label: "Alumipres",
      cloudProvider: "AZURE",
      url: "https://alumipres.corgtex.com",
    })).toMatchObject({ group: "azure-managed-customers", provider: "azure" });
    expect(targetFromControlPlaneRow({
      id: "app-1",
      label: "Backup App",
      url: "https://app.corgtex.com",
    })).toMatchObject({ group: "backup-app", provider: "railway" });
    expect(targetFromControlPlaneRow({
      id: "customer-1",
      label: "Acme",
      url: "https://acme.corgtex.com",
    })).toMatchObject({ group: "railway-customers", provider: "railway" });
  });

  it("formats progressive rings without UI-specific behavior", () => {
    const manifest = buildReleaseManifest({ gitSha: SHA });
    const targets = [
      { id: "acme", label: "Acme", group: "railway-customers", provider: "railway", url: "https://acme.test" },
      { id: "ops", label: "Ops", group: "ops", provider: "railway", url: "https://ops.test" },
    ];
    expect(formatReleasePlan({ manifest, targets, dryRun: true, concurrency: 2 })).toMatchObject({
      dryRun: true,
      concurrency: 2,
      release: { gitSha: SHA },
      rings: [
        { ring: 1, targets: [{ id: "ops", criticality: "blocking", backupOnly: false }] },
        { ring: 2, targets: [{ id: "acme", criticality: "blocking", backupOnly: false }] },
      ],
    });
    expect(filterTargetsByGroups(targets, ["ops"])).toEqual([targets[1]]);
  });

  it("flags provider boundary mismatches before deployment", () => {
    expect(providerBoundaryErrors({
      group: "azure-selfserve",
      provider: "railway",
      url: "https://selfserve.corgtex.com",
    })).toEqual([
      "Target group azure-selfserve requires provider azure, got railway",
      "selfserve.corgtex.com targets must use azure-selfserve group and azure provider",
    ]);
    expect(providerBoundaryErrors({
      group: "railway-customers",
      provider: "railway",
      url: "https://acme.corgtex.com",
    })).toEqual([]);
    expect(providerBoundaryErrors({
      group: "azure-selfserve",
      provider: "azure",
      url: "https://alumipres.corgtex.com",
    })).toEqual(["azure-selfserve targets must use the selfserve.corgtex.com runtime URL"]);
  });
});
