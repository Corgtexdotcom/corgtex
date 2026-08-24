import { describe, expect, it } from "vitest";

import {
  assertHealthProof,
  azureRuntimeContractErrors,
  buildReleaseManifest,
  filterTargetsByGroups,
  formatReleasePlan,
  healthProofErrors,
  imageTagForSha,
  managedInventoryRefForTarget,
  MCP_CONNECTOR_DEFAULT_SCOPES,
  mcpOAuthProofErrors,
  normalizeReleaseInput,
  reconcileManagedInventoryTargets,
  normalizeTargets,
  providerBoundaryErrors,
  releaseVersionForSha,
  targetEligibilityErrors,
  targetFromControlPlaneRow,
  validateManagedInventoryTargets,
} from "./fleet-release-core.mjs";

const SHA = "c9077ff031e8e672923c84d52eeef862368f3493";

function publicUrlEntries(origin, overrides = {}) {
  return Object.entries({
    APP_URL: origin,
    NEXT_PUBLIC_APP_URL: origin,
    MEETING_RECORDER_PUBLIC_BASE_URL: origin,
    MCP_PUBLIC_URL: `${origin}/mcp`,
    ...overrides,
  }).map(([name, value]) => ({ name, value, secretRef: null }));
}

function oauthProof(origin, overrides = {}) {
  const scopes = [...MCP_CONNECTOR_DEFAULT_SCOPES];
  return {
    protectedResource: {
      resource: `${origin}/mcp`,
      authorization_servers: [origin],
      scopes_supported: scopes,
    },
    authorizationServer: {
      issuer: origin,
      authorization_endpoint: `${origin}/api/oauth/authorize`,
      token_endpoint: `${origin}/api/oauth/token`,
      registration_endpoint: `${origin}/api/oauth/register`,
      revocation_endpoint: `${origin}/api/oauth/revoke`,
      scopes_supported: scopes,
    },
    challenges: ["/mcp", "/api/mcp"].map((path) => ({
      path,
      status: 401,
      header: `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource", scope="${scopes.join(" ")}"`,
    })),
    ...overrides,
  };
}

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

  it.each(["https://customer-a.example.test", "https://selfserve.corgtex.com"])("accepts canonical Azure public URLs for %s", (origin) => {
    expect(azureRuntimeContractErrors(origin, publicUrlEntries(origin))).toEqual([]);
  });

  it("rejects origin-only, missing, cross-customer, and secret-backed Azure public URLs", () => {
    const origin = "https://customer-a.example.test";
    expect(azureRuntimeContractErrors(origin, publicUrlEntries(origin, { MCP_PUBLIC_URL: origin }))).toContain(
      `MCP_PUBLIC_URL=${origin}; expected ${origin}/mcp`,
    );
    expect(azureRuntimeContractErrors(origin, publicUrlEntries(origin).filter(({ name }) => name !== "APP_URL"))).toContain("APP_URL is missing");
    expect(azureRuntimeContractErrors(origin, publicUrlEntries(origin, { NEXT_PUBLIC_APP_URL: "https://customer-b.example.test" }))).toContain(
      "NEXT_PUBLIC_APP_URL=https://customer-b.example.test; expected https://customer-a.example.test",
    );
    const secretBacked = publicUrlEntries(origin).map((entry) => (
      entry.name === "MEETING_RECORDER_PUBLIC_BASE_URL" ? { ...entry, value: null, secretRef: "public-url" } : entry
    ));
    expect(azureRuntimeContractErrors(origin, secretBacked)).toContain("MEETING_RECORDER_PUBLIC_BASE_URL must not be secret-backed");
  });

  it("requires public MCP OAuth metadata and challenges to agree", () => {
    const origin = "https://customer-a.example.test";
    expect(mcpOAuthProofErrors(origin, oauthProof(origin))).toEqual([]);
    expect(mcpOAuthProofErrors(origin, oauthProof(origin, {
      protectedResource: {
        ...oauthProof(origin).protectedResource,
        resource: origin,
        scopes_supported: ["workspace:read"],
      },
      challenges: oauthProof(origin).challenges.map((challenge) => ({ ...challenge, header: challenge.header.replace("Bearer", "Basic") })),
    }))).toEqual(expect.arrayContaining([
      `resource=${origin}; expected ${origin}/mcp`,
      "/mcp challenge must use Bearer authentication",
      "protected-resource and authorization-server scopes do not agree",
      "protected-resource scopes do not match canonical MCP defaults",
      "/mcp challenge scopes do not agree with protected-resource metadata",
    ]));
    const mixed = oauthProof(origin);
    mixed.challenges[0].header = `Bearer realm="mcp", Basic resource_metadata="${origin}/.well-known/oauth-protected-resource", scope="${MCP_CONNECTOR_DEFAULT_SCOPES.join(" ")}"`;
    expect(mcpOAuthProofErrors(origin, mixed)).toEqual(expect.arrayContaining([
      "/mcp resource_metadata challenge does not match the target origin", "/mcp challenge scopes do not agree with protected-resource metadata",
    ]));
    const wrongRevoke = oauthProof(origin);
    wrongRevoke.authorizationServer.revocation_endpoint = origin;
    expect(mcpOAuthProofErrors(origin, wrongRevoke)).toContain(`revocation_endpoint=${origin}; expected ${origin}/api/oauth/revoke`);
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
      deploymentKind: "HOSTED_DEDICATED",
      providerResourceGroup: "rg-customer",
    })).toMatchObject({ group: "selfserve", provider: "azure", azure: { resourceGroup: "rg-customer" } });
    expect(targetFromControlPlaneRow({
      id: "customer-1",
      label: "Acme",
      cloudProvider: "RAILWAY",
      url: "https://selfserve.corgtex.com",
      deploymentKind: "REMOTE_MANAGED",
    })).toMatchObject({ group: "managed-customers", provider: "railway" });
    expect(targetFromControlPlaneRow({ id: "backup", deploymentKind: "INTERNAL", cloudProvider: "RAILWAY" })).toMatchObject({ group: "backup-app", provider: "railway" });
  });

  it("validates managed inventory before dedupe or authority lookup", () => {
    const target = {
      inventoryKey: "customer-a",
      deploymentId: "dep-a",
      label: "Private Customer",
      url: "https://customer-a.example.test",
      group: "managed-customers",
      provider: "railway",
      railway: { projectId: "project-a", environmentId: "env-a", webServiceId: "web-a", workerServiceId: "worker-a" },
    };
    const result = validateManagedInventoryTargets([
      target,
      { ...target, label: "Duplicate Customer" },
    ]);
    expect(result.ok).toBe(false);
    expect(result.blockers[0].target.label).toMatch(/^managed-inventory-[0-9a-f]{64}$/);
    expect(JSON.stringify(result.blockers)).not.toContain("Private Customer");
    expect(result.blockers.flatMap((item) => item.blockers)).toEqual(expect.arrayContaining([
      "managed_inventory_key_duplicate",
      "managed_inventory_deployment_id_duplicate",
      "managed_inventory_origin_duplicate",
      "managed_inventory_resource_identity_duplicate",
    ]));
    expect(validateManagedInventoryTargets([{ ...target, inventoryRef: "private-customer-ref" }]).blockers[0].blockers).toContain("managed_inventory_reference_invalid");
  });

  it("reconciles managed inventory only on exact deployment, origin, resource, lifecycle, and health agreement", () => {
    const inventory = {
      inventoryKey: "customer-a",
      deploymentId: "dep-a",
      label: "Private Customer",
      url: "https://customer-a.example.test",
      canonicalOrigin: "https://customer-a.example.test",
      group: "managed-customers",
      provider: "railway",
      railway: { projectId: "project-a", environmentId: "env-a", webServiceId: "web-a", workerServiceId: "worker-a" },
    };
    const controlPlane = targetFromControlPlaneRow({
      id: "dep-a",
      label: "Private Customer",
      url: "https://customer-a.example.test",
      environment: "production",
      deploymentKind: "REMOTE_MANAGED",
      cloudProvider: "RAILWAY",
      deploymentStatus: "ACTIVE",
      provisioningStatus: "ACTIVE",
      releaseEligible: true,
      railwayProjectId: "project-a",
      railwayEnvironmentId: "env-a",
      railwayWebServiceId: "web-a",
      railwayWorkerServiceId: "worker-a",
    });
    const result = reconcileManagedInventoryTargets({
      inventoryTargets: [{ ...inventory, inventoryRef: managedInventoryRefForTarget(inventory) }],
      controlPlaneTargets: [controlPlane],
      healthProofs: new Map([["customer-a", { provider: "railway" }]]),
    });
    expect(result.ok).toBe(true);
    expect(result.targets[0]).toMatchObject({
      inventoryRef: expect.stringMatching(/^managed-inventory-[0-9a-f]{64}$/),
      environment: "production",
      deploymentKind: "REMOTE_MANAGED",
      releaseEligible: true,
    });

    const drift = reconcileManagedInventoryTargets({
      inventoryTargets: [{ ...inventory, inventoryRef: managedInventoryRefForTarget(inventory) }],
      controlPlaneTargets: [{ ...controlPlane, railway: { ...controlPlane.railway, webServiceId: "other-web" } }],
      healthProofs: new Map([["customer-a", { provider: "railway" }]]),
    });
    expect(drift.ok).toBe(false);
    expect(drift.blockers[0].blockers).toContain("control_plane_resource_mismatch");
    expect(JSON.stringify(drift)).not.toContain("customer-a.example.test");
  });

  it("preserves configured managed opt-out even when the control plane is active", () => {
    const inventory = {
      inventoryKey: "customer-a",
      deploymentId: "dep-a",
      label: "Private Customer",
      url: "https://customer-a.example.test",
      group: "managed-customers",
      provider: "railway",
      deploymentStatus: "SUSPENDED",
      releaseEligible: false,
      railway: { projectId: "project-a", environmentId: "env-a", webServiceId: "web-a", workerServiceId: "worker-a" },
    };
    const result = reconcileManagedInventoryTargets({
      inventoryTargets: [{ ...inventory, inventoryRef: managedInventoryRefForTarget(inventory) }],
      controlPlaneTargets: [targetFromControlPlaneRow({
        id: "dep-a",
        url: "https://customer-a.example.test",
        environment: "production",
        deploymentKind: "REMOTE_MANAGED",
        cloudProvider: "RAILWAY",
        deploymentStatus: "ACTIVE",
        provisioningStatus: "ACTIVE",
        releaseEligible: true,
        railwayProjectId: "project-a",
        railwayEnvironmentId: "env-a",
        railwayWebServiceId: "web-a",
        railwayWorkerServiceId: "worker-a",
      })],
      healthProofs: new Map([["customer-a", { provider: "railway" }]]),
    });
    expect(result.ok).toBe(true);
    expect(targetEligibilityErrors(result.targets[0])).toEqual(expect.arrayContaining([
      "Target lifecycle status SUSPENDED is not release-eligible",
      "Target explicitly sets releaseEligible=false",
    ]));
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
    const retired = { id: "retired", group: "managed-customers", provider: "railway", deploymentStatus: "RETIRED" }, draft = { id: "draft", group: "managed-customers", provider: "railway", deploymentStatus: "DRAFT" }, cutoverSource = { id: "source", group: "managed-customers", provider: "railway", deploymentStatus: "ACTIVE", provisioningStatus: "read_only_pending_finalize" };
    const optedOut = { id: "opted-out", group: "managed-customers", provider: "azure", releaseEligible: false };
    expect(filterTargetsByGroups([active, retired, draft, cutoverSource, optedOut], ["managed-customers"], { excludeIneligible: true })).toEqual([active]);
    expect(filterTargetsByGroups([active, retired, draft, cutoverSource], ["managed-customers"])).toEqual([active, retired, draft, cutoverSource]);
    expect(targetEligibilityErrors(optedOut)).toEqual(["Target explicitly sets releaseEligible=false"]); expect(targetEligibilityErrors(cutoverSource)).toEqual(["Target lifecycle status READ_ONLY_PENDING_FINALIZE is not release-eligible"]);
  });
});
