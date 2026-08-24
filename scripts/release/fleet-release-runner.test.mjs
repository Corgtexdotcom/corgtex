import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { azureReleaseVariables, latestRailwayStatus, releaseVariables, runFleetRelease } from "./fleet-release-runner.mjs";
import { MCP_CONNECTOR_DEFAULT_SCOPES } from "./fleet-release-core.mjs";
import { buildFleetReleaseIncident, fleetReleaseSlackPayload } from "./fleet-release-alerts.mjs";
import { assertPostDeployProbeReady, postDeployProbeFailureSummary, sanitizePostDeployProbe } from "./fleet-release-probes.mjs";

const SHA = "c9077ff031e8e672923c84d52eeef862368f3493";
const railwayObservabilityEnv = {
  POSTHOG_ENABLED: "true",
  POSTHOG_PROJECT_TOKEN: "posthog-project-token",
};
const azureObservabilityEnv = {
  APPLICATIONINSIGHTS_CONNECTION_STRING: "InstrumentationKey=00000000-0000-0000-0000-000000000000;IngestionEndpoint=https://example.monitor.azure.com/",
};

function targetJson(overrides = {}) {
  return JSON.stringify([{
    id: "ops",
    deploymentId: null,
    label: "Ops",
    url: "https://ops.corgtex.com",
    group: "ops",
    provider: "railway",
    railway: {
      projectId: "project-1",
      environmentId: "env-1",
      webServiceId: "web-1",
      workerServiceId: "worker-1",
    },
    ...overrides,
  }]);
}

function managedTargetJson(overrides = {}) {
  return JSON.stringify([{
    id: "private-id-sentinel", inventoryKey: "private-key-sentinel", deploymentId: "private-deployment-sentinel",
    label: "Private Label Sentinel", url: "https://private-origin-sentinel.example.test", canonicalOrigin: "https://private-origin-sentinel.example.test",
    group: "managed-customers", provider: "railway",
    railway: { projectId: "private-project-sentinel", environmentId: "private-env-sentinel", webServiceId: "private-web-sentinel", workerServiceId: "private-worker-sentinel" },
    ...overrides,
  }]);
}

function managedControlPlaneRow(overrides = {}) {
  return {
    id: "private-deployment-sentinel", label: "Private Label Sentinel", url: "https://private-origin-sentinel.example.test",
    environment: "production", deploymentKind: "REMOTE_MANAGED", cloudProvider: "RAILWAY",
    deploymentStatus: "ACTIVE", provisioningStatus: "ACTIVE", releaseEligible: true,
    railwayProjectId: "private-project-sentinel", railwayEnvironmentId: "private-env-sentinel", railwayWebServiceId: "private-web-sentinel", railwayWorkerServiceId: "private-worker-sentinel",
    ...overrides,
  };
}

function azureTargetJson(overrides = {}) {
  return JSON.stringify([{
    id: "azure",
    deploymentId: "dep-azure",
    label: "Azure Self-Serve",
    url: "https://selfserve.corgtex.com",
    group: "selfserve",
    provider: "azure",
    azure: {
      resourceGroup: "rg-1",
      acrName: "acr1",
      webAppName: "web-app",
      workerAppName: "worker-app",
    },
    ...overrides,
  }]);
}

function azureProviderStatus(overrides = {}) {
  return {
    deploymentId: "dep-azure",
    provider: { cloudProvider: "AZURE" },
    health: { status: "ok" },
    release: { releaseImageTag: `sha-${SHA}`, releaseDrift: null },
    ...overrides,
  };
}

function selfServeRegistry(overrides = {}) {
  return {
    items: [],
    summary: {
      total: 0,
      activeTrials: 0,
      reviewRequired: 0,
      suspendedTrials: 0,
      failedSmoke: 0,
      smokeCovered: 0,
    },
    ...overrides,
  };
}

function successfulRailwayResponse(body) {
  if (body.query.includes("serviceInstanceDeployV2")) {
    return {
      ok: true,
      json: async () => ({
        data: {
          deploymentId: body.variables.serviceId === "web-1" ? "deploy-web" : "deploy-worker",
        },
      }),
    };
  }
  if (body.query.includes("deployments(")) {
    return {
      ok: true,
      json: async () => ({
        data: {
          deployments: {
            edges: [{
              node: {
                id: body.variables.serviceId === "web-1" ? "deploy-web" : "deploy-worker",
                status: "SUCCESS",
              },
            }],
          },
        },
      }),
    };
  }
  return { ok: true, json: async () => ({ data: {} }) };
}

function healthResponse() {
  return {
    ok: true,
    json: async () => ({
      status: "ok",
      database: "up",
      schema: "ready",
      release: {
        imageTag: `sha-${SHA}`,
        gitSha: SHA,
      },
    }),
  };
}

function azurePublicUrlEntries(origin = "https://selfserve.corgtex.com", overrides = {}) {
  return Object.entries({
    APP_URL: origin,
    NEXT_PUBLIC_APP_URL: origin,
    MEETING_RECORDER_PUBLIC_BASE_URL: origin,
    MCP_PUBLIC_URL: `${origin}/mcp`,
    ...overrides,
  }).map(([name, value]) => ({ name, value, secretRef: null }));
}

function publicJsonResponse(value) { return { ok: true, status: 200, json: async () => value }; }

function oauthChallengeResponse(origin = "https://selfserve.corgtex.com") {
  const scopes = MCP_CONNECTOR_DEFAULT_SCOPES.join(" ");
  return { ok: false, status: 401, headers: { get: () => `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource", scope="${scopes}"` } };
}

function azureReleaseEnv() {
  return {
    FLEET_RELEASE_TARGETS_JSON: azureTargetJson(),
    AZURE_CLIENT_ID: "azure-client",
    AZURE_TENANT_ID: "azure-tenant",
    AZURE_SUBSCRIPTION_ID: "azure-subscription",
    GITHUB_ACTOR: "github-user",
    GITHUB_TOKEN: "github-token",
    CONTROL_PLANE_AGENT_API_KEY: "control-plane-token",
    APPLICATIONINSIGHTS_CONNECTION_STRING: "InstrumentationKey=00000000-0000-0000-0000-000000000000",
    POSTHOG_ENABLED: "true",
    POSTHOG_PROJECT_TOKEN: "posthog-project-token",
    POSTHOG_INSTANCE_ID: "azure-selfserve-production",
  };
}

function successfulAzurePublicResponse(url) {
  const path = new URL(String(url)).pathname;
  const origin = "https://selfserve.corgtex.com";
  const scopes = [...MCP_CONNECTOR_DEFAULT_SCOPES];
  if (path === "/api/health") return healthResponse();
  if (path === "/.well-known/oauth-protected-resource") {
    return publicJsonResponse({ resource: `${origin}/mcp`, authorization_servers: [origin], scopes_supported: scopes });
  }
  if (path === "/.well-known/oauth-authorization-server") {
    return publicJsonResponse({ issuer: origin, authorization_endpoint: `${origin}/api/oauth/authorize`, token_endpoint: `${origin}/api/oauth/token`,
      registration_endpoint: `${origin}/api/oauth/register`, revocation_endpoint: `${origin}/api/oauth/revoke`, scopes_supported: scopes });
  }
  if (path === "/mcp" || path === "/api/mcp") return oauthChallengeResponse(origin);
  throw new Error(`Unexpected Azure public URL: ${url}`);
}

function managedReleaseEnv(overrides = {}) {
  return {
    FLEET_RELEASE_STABLE_GIT_SHA: SHA, FLEET_RELEASE_TARGETS_JSON: managedTargetJson(), FLEET_RELEASE_TARGETS: "managed-customers",
    FLEET_RELEASE_REASON: "synthetic managed guard test", CONTROL_PLANE_AGENT_API_KEY: "control-plane-token",
    RAILWAY_API_TOKEN: "railway-token", GHCR_IMPORT_TOKEN: "ghcr-token", POSTHOG_ENABLED: "true", POSTHOG_PROJECT_TOKEN: "posthog-project-token",
    FLEET_RELEASE_HEALTH_TIMEOUT_MS: "1", FLEET_RELEASE_HEALTH_INTERVAL_MS: "1",
    ...overrides,
  };
}

function controlPlaneResult(value) {
  return {
    ok: true,
    json: async () => ({
      result: {
        content: [{ type: "text", text: JSON.stringify(value) }],
      },
    }),
  };
}

describe("fleet release runner", () => {
  it("resolves latest-stable from the explicit stable release marker", async () => {
    const outputs = {};
    const runCommand = vi.fn();

    const result = await runFleetRelease(["resolve", "--release", "latest-stable"], {
      env: {
        GITHUB_REPOSITORY: "Corgtexdotcom/corgtex",
        FLEET_RELEASE_STABLE_GIT_SHA: SHA,
      },
      runCommand,
      emitGithubOutput: (key, value) => {
        outputs[key] = value;
      },
    });

    expect(runCommand).not.toHaveBeenCalled();
    expect(result.manifest.gitSha).toBe(SHA);
    expect(outputs.git_sha).toBe(SHA);
    expect(JSON.parse(outputs.manifest_json)).toMatchObject({
      gitSha: SHA,
      imageTag: `sha-${SHA}`,
    });
  });

  it("sanitizes post-deploy probe output down to counts and status only", () => {
    const sanitized = sanitizePostDeployProbe({
      deploymentId: "deployment-1",
      status: "ok",
      reads: [{
        key: "actions",
        label: "Actions",
        status: "ok",
        count: 3,
        title: "Customer-private title",
        items: [{ title: "Do not store this" }],
      }],
      recorder: {
        status: "ok",
        provider: "RECALL_AI",
        failureMessage: "Customer-private recorder details",
      },
      supportConnectorReadiness: {
        status: "ready",
        requiredScopes: ["workspace:read", "execution:read", { raw: "drop" }],
        missingScopes: [{ raw: "drop" }],
        checkedAt: "2026-06-24T10:00:00.000Z",
        credentialLabel: "Corgtex Support",
      },
      supportAudit: { status: "completed" },
      raw: "customer content",
    });

    const text = JSON.stringify(sanitized);
    expect(text).not.toContain("Customer-private");
    expect(text).not.toContain("Do not store");
    expect(sanitized.reads[0]).toEqual({
      key: "actions",
      label: "Actions",
      status: "ok",
      count: 3,
    });
    expect(sanitized.recorder).toEqual({
      status: "ok",
      provider: "RECALL_AI",
    });
    expect(sanitized.supportConnectorReadiness).toEqual({
      status: "ready",
      requiredScopes: ["workspace:read", "execution:read"],
      missingScopes: [],
      checkedAt: "2026-06-24T10:00:00.000Z",
    });
  });

  it("blocks post-deploy success when support connector required scopes are missing", () => {
    const probe = sanitizePostDeployProbe({
      status: "degraded",
      reads: [{ key: "actions", status: "ok", count: 1 }],
      recorder: { status: "not_configured" },
      supportConnectorReadiness: {
        status: "missing_scope",
        requiredScopes: ["workspace:read", "execution:read"],
        missingScopes: ["execution:read"],
        checkedAt: "2026-06-24T10:00:00.000Z",
      },
      supportAudit: { status: "completed" },
    });

    expect(postDeployProbeFailureSummary(probe)).toBe("support_connector:MISSING_SUPPORT_SCOPE");
    expect(() => assertPostDeployProbeReady(probe, "Customer A")).toThrow("MISSING_SUPPORT_SCOPE");
  });

  it("keeps recorder insufficient-credit failures visible in probe classification", () => {
    const probe = sanitizePostDeployProbe({
      status: "failed",
      reads: [],
      recorder: {
        status: "failed",
        failureCode: "insufficient_credit_balance",
      },
      supportAudit: { status: "completed" },
    });

    expect(postDeployProbeFailureSummary(probe)).toBe("recorder:insufficient_credit_balance");
    expect(() => assertPostDeployProbeReady(probe, "Customer A")).toThrow("insufficient_credit_balance");
  });

  it("builds Slack alert payloads for failed fleet releases", () => {
    const incident = buildFleetReleaseIncident({
      manifest: { gitSha: SHA, imageTag: `sha-${SHA}` },
      results: [{
        status: "failed",
        target: { label: "Customer A" },
        error: "post-deploy probe failed",
      }],
      stage: "deploy",
    });

    expect(incident.summary).toContain(`sha-${SHA}`);
    expect(incident.summary).toContain("Customer A");
    expect(incident.evidence).toContain("Customer A: post-deploy probe failed");
    expect(fleetReleaseSlackPayload(incident)).toEqual({
      text: expect.stringContaining("Fleet release"),
    });
  });

  it("fails latest-stable resolution without a stable marker", async () => {
    await expect(runFleetRelease(["resolve", "--release", "latest-stable"], {
      env: { GITHUB_REPOSITORY: "Corgtexdotcom/corgtex" },
      runCommand: vi.fn(),
    })).rejects.toThrow("Set FLEET_RELEASE_STABLE_GIT_SHA");
  });

  it("validates dry-run environment wiring before expensive setup", async () => {
    const result = await runFleetRelease([
      "validate-config",
      "--release",
      "latest-stable",
      "--targets",
      "ops,backup-app,azure-selfserve",
      "--dry-run",
    ], {
      env: {
        FLEET_RELEASE_STABLE_GIT_SHA: SHA,
        FLEET_RELEASE_OPS_TARGET_JSON: targetJson(),
        FLEET_RELEASE_BACKUP_APP_TARGET_JSON: targetJson({ id: "backup", group: "backup-app" }),
        FLEET_RELEASE_AZURE_TARGET_JSON: azureTargetJson(),
      },
      runCommand: vi.fn(),
    });

    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it("fails environment validation when latest-stable has no stable marker", async () => {
    await expect(runFleetRelease([
      "validate-config",
      "--release",
      "latest-stable",
      "--targets",
      "ops",
      "--dry-run",
    ], {
      env: {
        FLEET_RELEASE_OPS_TARGET_JSON: targetJson(),
      },
      runCommand: vi.fn(),
    })).rejects.toThrow("FLEET_RELEASE_STABLE_GIT_SHA");
  });

  it("fails environment validation when selected target inventory is missing", async () => {
    await expect(runFleetRelease([
      "validate-config",
      "--release",
      SHA,
      "--targets",
      "ops,backup-app",
      "--dry-run",
    ], {
      env: {
        FLEET_RELEASE_OPS_TARGET_JSON: targetJson(),
      },
      runCommand: vi.fn(),
    })).rejects.toThrow("FLEET_RELEASE_BACKUP_APP_TARGET_JSON");
  });

  it("blocks managed drift before provider calls, snapshots, or raw public serialization", async () => {
    const fetchImpl = vi.fn(async (url, options) => {
      const body = JSON.parse(options?.body ?? "{}");
      if (String(url).includes("/api/control-plane/mcp")) {
        expect(body.params.name).toBe("list_customers");
        return controlPlaneResult([managedControlPlaneRow({ railwayWebServiceId: "other-private-web-sentinel" })]);
      }
      if (String(url).endsWith("/api/health")) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ status: "ok", release: { provider: "railway" } }) };
      }
      throw new Error(`unexpected call ${url}`);
    });
    const outputs = {};

    await expect(runFleetRelease(["deploy", "--release", SHA, "--fail-on-blockers"], {
      env: managedReleaseEnv(),
      fetchImpl,
      sleep: vi.fn(),
      emitGithubOutput: (key, value) => { outputs[key] = value; },
    })).rejects.toThrow("control_plane_resource_mismatch");

    const publicText = JSON.stringify({ outputs });
    expect(publicText).not.toContain("private-origin-sentinel");
    expect(publicText).not.toContain("private-project-sentinel");
    expect(publicText).not.toContain("private-web-sentinel");
    expect(fetchImpl).not.toHaveBeenCalledWith(expect.stringContaining("backboard.railway.com"), expect.anything());
  });

  it("validates raw managed inventory before any external read", async () => {
    const fetchImpl = vi.fn(), runCommand = vi.fn();
    await expect(runFleetRelease(["deploy", "--release", SHA, "--reason", "Validate ordering."], {
      env: managedReleaseEnv({ FLEET_RELEASE_TARGETS_JSON: managedTargetJson({ inventoryRef: "private-customer-ref" }), FLEET_RELEASE_OPS_TARGET_JSON: targetJson() }),
      fetchImpl,
      runCommand,
      sleep: vi.fn(),
    })).rejects.toThrow("managed_inventory_reference_invalid");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("replays a private managed preflight snapshot before writing an opaque observation descriptor", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "fleet-managed-descriptor-"));
    const targetsFile = join(tempDir, "targets.json");
    const railwayCalls = [];
    const fetchImpl = vi.fn(async (url, options) => {
      const body = JSON.parse(options?.body ?? "{}");
      if (String(url).includes("/api/control-plane/mcp")) {
        if (body.params.name === "list_customers") return controlPlaneResult([managedControlPlaneRow()]);
        if (body.params.name === "get_customer_deployment_status") return controlPlaneResult(managedControlPlaneRow());
        if (body.params.name === "record_verified_release") return controlPlaneResult({ recorded: true });
        if (body.params.name === "refresh_fleet_snapshots") return controlPlaneResult({ results: [] });
      }
      if (String(url).endsWith("/api/health")) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ status: "ok", release: { provider: "railway" } }), json: async () => ({ status: "ok", database: "up", schema: "ready", release: { imageTag: `sha-${SHA}`, gitSha: SHA, provider: "railway" } }) };
      }
      if (String(url).includes("backboard.railway.com")) {
        railwayCalls.push(body);
        return successfulRailwayResponse(body);
      }
      throw new Error(`unexpected call ${url}`);
    });

    const preflight = await runFleetRelease(["deploy", "--release", SHA, "--dry-run"], {
      env: managedReleaseEnv({ FLEET_RELEASE_TARGETS_FILE: targetsFile }),
      fetchImpl,
      sleep: vi.fn(),
      emitGithubOutput: vi.fn(),
    });

    expect(preflight.dryRun).toBe(true);
    const privateSnapshot = JSON.parse(readFileSync(targetsFile, "utf8"));
    expect(privateSnapshot).toEqual([expect.objectContaining({ id: "private-id-sentinel", label: "Private Label Sentinel", inventoryKey: "private-key-sentinel", deploymentId: "private-deployment-sentinel", canonicalOrigin: "https://private-origin-sentinel.example.test", inventoryRef: expect.stringMatching(/^managed-inventory-[0-9a-f]{64}$/), railway: expect.objectContaining({ workerServiceId: "private-worker-sentinel" }) })]);

    const promotion = await runFleetRelease(["deploy", "--release", SHA, "--targets", "managed-customers", "--reason", "Promote managed."], {
      env: managedReleaseEnv({ FLEET_RELEASE_TARGETS_FILE: targetsFile, FLEET_RELEASE_POST_DEPLOY_PROBES: "false", GHCR_IMPORT_USERNAME: "github-user" }),
      fetchImpl,
      sleep: vi.fn(),
      emitGithubOutput: vi.fn(),
    });
    expect(promotion.results[0].status).toBe("succeeded");
    expect(railwayCalls.some((call) => call.query.includes("serviceInstanceUpdate"))).toBe(true);
    const descriptor = JSON.parse(readFileSync(targetsFile, "utf8"));
    expect(descriptor).toEqual([expect.objectContaining({ id: expect.stringMatching(/^managed-inventory-[0-9a-f]{64}$/), label: expect.stringMatching(/^managed-inventory-[0-9a-f]{64}$/), inventoryRef: expect.stringMatching(/^managed-inventory-[0-9a-f]{64}$/), provider: "railway", group: "managed-customers", railway: { projectId: "private-project-sentinel", environmentId: "private-env-sentinel", webServiceId: "private-web-sentinel" } })]);
    const descriptorText = JSON.stringify(descriptor);
    expect(descriptorText).not.toContain("private-origin-sentinel");
    expect(descriptorText).not.toContain("private-deployment-sentinel");
    expect(descriptorText).not.toContain("Private Label Sentinel");
    expect(descriptorText).not.toContain("private-worker-sentinel");
  });

  it("requires provider credentials for non-dry-run validation", async () => {
    await expect(runFleetRelease([
      "validate-config",
      "--release",
      SHA,
      "--targets",
      "ops",
    ], {
      env: {
        FLEET_RELEASE_OPS_TARGET_JSON: targetJson(),
      },
      runCommand: vi.fn(),
    })).rejects.toThrow("CONTROL_PLANE_AGENT_API_KEY");
  });

  it("rejects startup seed env during release preflight", async () => {
    await expect(runFleetRelease([
      "validate-config",
      "--release",
      SHA,
      "--targets",
      "ops",
      "--dry-run",
    ], {
      env: {
        FLEET_RELEASE_OPS_TARGET_JSON: targetJson(),
        CORGTEX_AUTO_SEED_JNJ_DEMO: "true",
      },
      runCommand: vi.fn(),
    })).rejects.toThrow("CORGTEX_AUTO_SEED_JNJ_DEMO");

    await expect(runFleetRelease([
      "validate-config",
      "--release",
      SHA,
      "--targets",
      "ops",
      "--dry-run",
    ], {
      env: {
        FLEET_RELEASE_OPS_TARGET_JSON: targetJson(),
        SEED_SCRIPTS: "scripts/seed-jnj-demo.mjs",
      },
      runCommand: vi.fn(),
    })).rejects.toThrow("SEED_SCRIPTS");
  });

  it("forces Railway release services into combined startup without validation seeds", async () => {
    expect(releaseVariables({
      releaseVersion: "main-c9077ff031e",
      imageTag: `sha-${SHA}`,
      gitSha: SHA,
    }, {})).toEqual({
      CORGTEX_RELEASE_VERSION: "main-c9077ff031e",
      CORGTEX_RELEASE_IMAGE_TAG: `sha-${SHA}`,
      CORGTEX_RELEASE_GIT_SHA: SHA,
      CORGTEX_STARTUP_MODE: "combined",
      CORGTEX_AUTO_SEED_JNJ_DEMO: "false",
      CORGTEX_AUTO_SEED_INTERNAL_VALIDATION: "false",
      SEED_SCRIPTS: "",
    });
  });

  it("uses migrate-and-web startup for Azure releases", async () => {
    expect(azureReleaseVariables({
      releaseVersion: "main-c9077ff031e",
      imageTag: `sha-${SHA}`,
      gitSha: SHA,
    }, {})).toEqual({
      CORGTEX_RELEASE_VERSION: "main-c9077ff031e",
      CORGTEX_RELEASE_IMAGE_TAG: `sha-${SHA}`,
      CORGTEX_RELEASE_GIT_SHA: SHA,
      CORGTEX_STARTUP_MODE: "migrate-and-web",
      CORGTEX_AUTO_SEED_JNJ_DEMO: "false",
      CORGTEX_AUTO_SEED_INTERNAL_VALIDATION: "false",
      SEED_SCRIPTS: "",
    });
  });

  it("adds observability variables when release telemetry env is configured", async () => {
    const env = {
      APPLICATIONINSIGHTS_CONNECTION_STRING: "InstrumentationKey=00000000-0000-0000-0000-000000000000;IngestionEndpoint=https://example.monitor.azure.com/",
      POSTHOG_ENABLED: "true",
      POSTHOG_CAPTURE_KILL_SWITCH: "false",
      POSTHOG_PROJECT_TOKEN: "posthog-project-token",
      POSTHOG_API_HOST: "https://us.i.posthog.com",
      POSTHOG_ENVIRONMENT: "production",
      POSTHOG_EVENT_SAMPLE_RATE: "1",
      POSTHOG_CAPTURE_TIMEOUT_MS: "1500",
      POSTHOG_CAPTURE_DEBUG: "false",
      POSTHOG_INSTANCE_ID: "corgtex-production",
    };

    expect(releaseVariables({
      releaseVersion: "main-c9077ff031e",
      imageTag: `sha-${SHA}`,
      gitSha: SHA,
    }, env)).toMatchObject({
      APPLICATIONINSIGHTS_CONNECTION_STRING: env.APPLICATIONINSIGHTS_CONNECTION_STRING,
      POSTHOG_ENABLED: "true",
      POSTHOG_CAPTURE_KILL_SWITCH: "false",
      POSTHOG_PROJECT_TOKEN: "posthog-project-token",
      POSTHOG_API_HOST: "https://us.i.posthog.com",
      POSTHOG_ENVIRONMENT: "production",
      POSTHOG_EVENT_SAMPLE_RATE: "1",
      POSTHOG_CAPTURE_TIMEOUT_MS: "1500",
      POSTHOG_CAPTURE_DEBUG: "false",
      POSTHOG_INSTANCE_ID: "corgtex-production",
    });

    expect(azureReleaseVariables({
      releaseVersion: "main-c9077ff031e",
      imageTag: `sha-${SHA}`,
      gitSha: SHA,
    }, env)).toMatchObject({
      APPLICATIONINSIGHTS_CONNECTION_STRING: "secretref:ai-conn-secret",
      POSTHOG_ENABLED: "true",
      POSTHOG_PROJECT_TOKEN: "secretref:posthog-token",
      POSTHOG_INSTANCE_ID: "corgtex-production",
      CORGTEX_STARTUP_MODE: "migrate-and-web",
    });
  });

  it("canonicalizes accepted PostHog boolean spellings in release variables", async () => {
    const variables = releaseVariables({
      releaseVersion: "main-c9077ff031e",
      imageTag: `sha-${SHA}`,
      gitSha: SHA,
    }, {
      POSTHOG_ENABLED: "yes",
      POSTHOG_CAPTURE_KILL_SWITCH: "on",
      POSTHOG_PROJECT_TOKEN: "posthog-project-token",
      POSTHOG_CAPTURE_DEBUG: "1",
    });

    expect(variables).toMatchObject({
      POSTHOG_ENABLED: "true",
      POSTHOG_CAPTURE_KILL_SWITCH: "true",
      POSTHOG_PROJECT_TOKEN: "posthog-project-token",
      POSTHOG_CAPTURE_DEBUG: "true",
    });
  });

  it("propagates explicit observability disables to provider runtime variables", async () => {
    const env = {
      APPLICATIONINSIGHTS_CONNECTION_STRING: "",
      POSTHOG_ENABLED: "false",
      POSTHOG_PROJECT_TOKEN: "stale-token",
      POSTHOG_INSTANCE_ID: "",
    };

    expect(releaseVariables({
      releaseVersion: "main-c9077ff031e",
      imageTag: `sha-${SHA}`,
      gitSha: SHA,
    }, env)).toMatchObject({
      APPLICATIONINSIGHTS_CONNECTION_STRING: "",
      POSTHOG_ENABLED: "false",
      POSTHOG_CAPTURE_KILL_SWITCH: "true",
      POSTHOG_PROJECT_TOKEN: "",
      POSTHOG_INSTANCE_ID: "",
    });

    expect(releaseVariables({
      releaseVersion: "main-c9077ff031e",
      imageTag: `sha-${SHA}`,
      gitSha: SHA,
    }, { POSTHOG_ENABLED: "true" })).toMatchObject({
      POSTHOG_ENABLED: "false",
      POSTHOG_CAPTURE_KILL_SWITCH: "true",
      POSTHOG_PROJECT_TOKEN: "",
    });
  });

  it("does not treat blank PostHog workflow env as an explicit disable", async () => {
    const variables = releaseVariables({
      releaseVersion: "main-c9077ff031e",
      imageTag: `sha-${SHA}`,
      gitSha: SHA,
    }, {
      POSTHOG_ENABLED: "",
      POSTHOG_PROJECT_TOKEN: "",
    });

    expect(variables).not.toHaveProperty("POSTHOG_ENABLED");
    expect(variables).not.toHaveProperty("POSTHOG_CAPTURE_KILL_SWITCH");
    expect(variables).not.toHaveProperty("POSTHOG_PROJECT_TOKEN");
  });

  it("does not clear PostHog when a token exists without an explicit enable flag", async () => {
    const variables = releaseVariables({
      releaseVersion: "main-c9077ff031e",
      imageTag: `sha-${SHA}`,
      gitSha: SHA,
    }, {
      POSTHOG_PROJECT_TOKEN: "posthog-project-token",
    });

    expect(variables).not.toHaveProperty("POSTHOG_ENABLED");
    expect(variables).not.toHaveProperty("POSTHOG_CAPTURE_KILL_SWITCH");
    expect(variables).not.toHaveProperty("POSTHOG_PROJECT_TOKEN");
  });

  it("clears blank PostHog instance IDs without overwriting customer-scoped IDs", async () => {
    expect(releaseVariables({
      releaseVersion: "main-c9077ff031e",
      imageTag: `sha-${SHA}`,
      gitSha: SHA,
    }, {
      POSTHOG_ENABLED: "true",
      POSTHOG_PROJECT_TOKEN: "posthog-project-token",
      POSTHOG_INSTANCE_ID: "",
    })).toMatchObject({
      POSTHOG_ENABLED: "true",
      POSTHOG_PROJECT_TOKEN: "posthog-project-token",
      POSTHOG_INSTANCE_ID: "",
    });

    const customerVariables = releaseVariables({
      releaseVersion: "main-c9077ff031e",
      imageTag: `sha-${SHA}`,
      gitSha: SHA,
    }, {
      POSTHOG_ENABLED: "true",
      POSTHOG_PROJECT_TOKEN: "posthog-project-token",
      POSTHOG_INSTANCE_ID: "global-fleet-id",
    }, {
      includePostHogInstanceId: false,
    });

    expect(customerVariables).toMatchObject({
      POSTHOG_ENABLED: "true",
      POSTHOG_PROJECT_TOKEN: "posthog-project-token",
    });
    expect(customerVariables).not.toHaveProperty("POSTHOG_INSTANCE_ID");
  });

  it("redacts observability secrets in standalone Azure release dry-run logs", async () => {
    const output = execFileSync(process.execPath, [
      "scripts/azure-selfserve-production-release.mjs",
      "--sha",
      SHA,
      "--dry-run",
      "--skip-build",
      "--resource-group",
      "rg-1",
      "--acr-name",
      "acr1",
      "--web-app-name",
      "web-app",
      "--worker-app-name",
      "worker-app",
      "--app-url",
      "https://selfserve.corgtex.com",
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        APPLICATIONINSIGHTS_CONNECTION_STRING: "InstrumentationKey=00000000-0000-0000-0000-000000000000",
        POSTHOG_ENABLED: "yes",
        POSTHOG_CAPTURE_KILL_SWITCH: "on",
        POSTHOG_PROJECT_TOKEN: "ph-project-secret",
        POSTHOG_CAPTURE_DEBUG: "1",
        POSTHOG_INSTANCE_ID: "",
      },
    });

    expect(output).toContain("APPLICATIONINSIGHTS_CONNECTION_STRING=<redacted>");
    expect(output).toContain("POSTHOG_ENABLED=true");
    expect(output).toContain("POSTHOG_CAPTURE_KILL_SWITCH=true");
    expect(output).toContain("POSTHOG_PROJECT_TOKEN=<redacted>");
    expect(output).toContain("POSTHOG_CAPTURE_DEBUG=true");
    expect(output).toContain("POSTHOG_INSTANCE_ID=");
    expect(output).toContain("ai-conn-secret=<redacted>");
    expect(output).toContain("posthog-token=<redacted>");
    expect(output).not.toContain("InstrumentationKey=00000000-0000-0000-0000-000000000000");
    expect(output).not.toContain("ph-project-secret");
  });

  it("prints a dry-run plan without mutating providers", async () => {
    const outputs = {};
    const runCommand = vi.fn();
    const fetchImpl = vi.fn();

    const result = await runFleetRelease([
      "deploy",
      "--release",
      SHA,
      "--targets",
      "ops",
      "--dry-run",
      "--reason",
      "Validate release plan.",
    ], {
      env: {
        FLEET_RELEASE_TARGETS_JSON: targetJson(),
        RAILWAY_API_TOKEN: "railway-token",
      },
      runCommand,
      fetchImpl,
      sleep: vi.fn(),
      emitGithubOutput: (key, value) => { outputs[key] = value; },
    });

    expect(result.dryRun).toBe(true);
    expect(runCommand).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.targets).toHaveLength(1);
    expect(outputs).toMatchObject({ uses_azure: false, uses_railway: true, observation_targets: "ops" });
  });

  it("defaults dry-run plans to primary targets and excludes backup app", async () => {
    const outputs = {}, targetFile = join(mkdtempSync(join(tmpdir(), "fleet-snapshot-")), "targets.json");
    const result = await runFleetRelease([
      "deploy",
      "--release",
      SHA,
      "--dry-run",
      "--reason",
      "Validate default release plan.",
    ], {
      env: {
        FLEET_RELEASE_TARGETS_JSON: managedTargetJson(),
        FLEET_RELEASE_TARGETS_FILE: targetFile,
        FLEET_RELEASE_OPS_TARGET_JSON: targetJson(),
        FLEET_RELEASE_BACKUP_APP_TARGET_JSON: targetJson({ id: "backup", label: "Backup App", group: "backup-app", url: "https://app.corgtex.com" }),
        FLEET_RELEASE_AZURE_TARGET_JSON: azureTargetJson(),
        CONTROL_PLANE_AGENT_API_KEY: "control-plane-key",
        RAILWAY_API_TOKEN: "railway-token",
        GHCR_IMPORT_USERNAME: "github-user",
        GITHUB_TOKEN: "github-token",
        AZURE_CLIENT_ID: "azure-client",
        AZURE_TENANT_ID: "azure-tenant",
        AZURE_SUBSCRIPTION_ID: "azure-subscription",
      },
      runCommand: vi.fn(),
      fetchImpl: vi.fn(async (url, init) => {
        if (String(url).includes("/api/control-plane/mcp")) {
          const body = JSON.parse(init.body);
          if (body.params.name === "list_customers") return controlPlaneResult([managedControlPlaneRow()]);
          return controlPlaneResult({ id: "dep-azure", environment: "production", deploymentKind: "HOSTED_DEDICATED", cloudProvider: "AZURE", providerResourceGroup: "rg-1", providerWebServiceId: "web-app", providerWorkerServiceId: "worker-app", deploymentStatus: "ACTIVE" });
        }
        return { ok: true, status: 200, text: async () => JSON.stringify({ status: "ok", release: { provider: "railway" } }) };
      }),
      sleep: vi.fn(),
      emitGithubOutput: (key, value) => { outputs[key] = value; },
    });

    expect(result.targets.map((target) => target.group)).toEqual([
      "managed-customers",
      "ops",
      "selfserve",
    ]);
    expect(result.targets.some((target) => target.group === "backup-app")).toBe(false);
    const selectedTargets = JSON.parse(execFileSync("cat", [targetFile], { encoding: "utf8" }));
    expect({ ...outputs, selected_targets: selectedTargets }).toMatchObject({ observation_targets: "railway-customers,azure-selfserve,ops", selected_targets: [expect.objectContaining({ inventoryRef: expect.stringMatching(/^managed-inventory-[0-9a-f]{64}$/) }), expect.objectContaining({ id: "ops" }), expect.objectContaining({ id: "azure" })] });
  });

  it("revalidates frozen targets with bounded concurrency before mutation", async () => { const targetFile = join(mkdtempSync(join(tmpdir(), "fleet-snapshot-")), "targets.json"), runCommand = vi.fn(), outputs = {}, snapshots = Array.from({ length: 9 }, (_, index) => JSON.parse(azureTargetJson({ id: `target-${index}`, deploymentId: `dep-${index}`, label: `Target ${index}`, url: `https://target-${index}.corgtex.com`, azure: { resourceGroup: "rg-1", acrName: "acr1", webAppName: "web-app", workerAppName: "worker-app" } }))[0]);
    let active = 0, peak = 0; writeFileSync(targetFile, JSON.stringify(snapshots)); const broad = await runFleetRelease(["deploy", "--release", SHA, "--dry-run", "--reason", "Revalidate fleet."], {
      env: { FLEET_RELEASE_TARGETS_FILE: targetFile, CONTROL_PLANE_AGENT_API_KEY: "control-plane-key" }, runCommand, sleep: vi.fn(), emitGithubOutput: (key, value) => { outputs[key] = value; },
      fetchImpl: vi.fn(async (_url, init) => { active += 1; peak = Math.max(peak, active); await new Promise((resolve) => setTimeout(resolve, 2)); active -= 1; const deploymentId = JSON.parse(init.body).params.arguments.deploymentId; return controlPlaneResult({ id: deploymentId, environment: "production", deploymentKind: "HOSTED_DEDICATED", cloudProvider: "AZURE", providerResourceGroup: "rg-1", providerWebServiceId: "web-app", providerWorkerServiceId: "worker-app", deploymentStatus: deploymentId === "dep-0" ? "RETIRED" : "ACTIVE" }); }),
    }); expect({ peak, ids: broad.targets.map((target) => target.id), ...outputs }).toMatchObject({ peak: 8, ids: snapshots.slice(1).map((target) => target.id), uses_azure: true, observation_targets: "azure-selfserve" });
    const currentAzure = { id: "dep-azure", environment: "production", deploymentKind: "HOSTED_DEDICATED", cloudProvider: "AZURE", providerResourceGroup: "rg-1", providerWebServiceId: "web-app", providerWorkerServiceId: "worker-app", provisioningStatus: "active" }, env = { FLEET_RELEASE_TARGETS_FILE: targetFile, CONTROL_PLANE_AGENT_API_KEY: "control-plane-key", AZURE_CLIENT_ID: "azure-client", AZURE_TENANT_ID: "azure-tenant", AZURE_SUBSCRIPTION_ID: "azure-subscription", GITHUB_TOKEN: "github-token", ...azureObservabilityEnv }, lifecycleFetch = vi.fn().mockResolvedValueOnce(controlPlaneResult({ ...currentAzure, deploymentStatus: "RETIRED" })), classificationFetch = vi.fn().mockResolvedValueOnce(controlPlaneResult({ ...currentAzure, environment: "production", deploymentKind: "SHARED_WORKSPACE", deploymentStatus: "ACTIVE" })).mockResolvedValueOnce(controlPlaneResult({ ...currentAzure, environment: "production", deploymentKind: "INTERNAL", deploymentStatus: "ACTIVE" }));
    writeFileSync(targetFile, azureTargetJson({ deploymentStatus: "ACTIVE" })); await expect(runFleetRelease(["deploy", "--release", SHA, "--targets", "selfserve", "--reason", "Reject identity drift."], { env, runCommand, fetchImpl: vi.fn(async () => controlPlaneResult({ ...currentAzure, providerWebServiceId: "replacement-web" })), sleep: vi.fn() })).rejects.toThrow("provider or resource identity changed");
    writeFileSync(targetFile, azureTargetJson({ deploymentStatus: "ACTIVE" })); const forced = await runFleetRelease(["deploy", "--release", SHA, "--targets", "selfserve", "--force-after-failure", "true", "--reason", "Reject workload drift."], { env, runCommand, fetchImpl: classificationFetch, sleep: vi.fn(), emitGithubOutput: (key, value) => { outputs[key] = value; } }); expect({ result: forced.results[0], snapshot: JSON.parse(execFileSync("cat", [targetFile], { encoding: "utf8" })), ...outputs }).toMatchObject({ result: { status: "failed", error: expect.stringContaining("workload or environment changed") }, snapshot: [], uses_azure: false, observation_targets: "" }); const providerFetch = vi.fn().mockResolvedValueOnce(controlPlaneResult({ ...currentAzure, deploymentStatus: "ACTIVE" })).mockResolvedValueOnce(controlPlaneResult({ ...currentAzure, deploymentStatus: "ACTIVE" })), providerCommand = vi.fn(() => { throw new Error("provider failed"); }); writeFileSync(targetFile, azureTargetJson({ deploymentStatus: "ACTIVE" })); const postBoundary = await runFleetRelease(["deploy", "--release", SHA, "--targets", "selfserve", "--force-after-failure", "true", "--reason", "Observe provider failure."], { env, runCommand: providerCommand, fetchImpl: providerFetch, sleep: vi.fn(), emitGithubOutput: (key, value) => { outputs[key] = value; } }); expect({ result: postBoundary.results[0], snapshot: JSON.parse(execFileSync("cat", [targetFile], { encoding: "utf8" })), ...outputs }).toMatchObject({ result: { status: "failed", error: "provider failed" }, snapshot: [{ id: "azure" }], uses_azure: true, observation_targets: "azure-selfserve" });
    const lifecycleCommand = vi.fn();
    writeFileSync(targetFile, azureTargetJson({ deploymentStatus: "ACTIVE" })); await expect(runFleetRelease(["deploy", "--release", SHA, "--targets", "selfserve", "--reason", "Reject lifecycle drift."], { env, runCommand: lifecycleCommand, fetchImpl: lifecycleFetch, sleep: vi.fn() })).rejects.toThrow("Target lifecycle status RETIRED"); expect(lifecycleFetch).toHaveBeenCalledTimes(1); expect(lifecycleCommand).not.toHaveBeenCalled();
  });

  it("fails preflight before mutation when provider credentials are missing", async () => {
    const runCommand = vi.fn();
    await expect(runFleetRelease([
      "deploy",
      "--release",
      SHA,
      "--targets",
      "ops",
      "--reason",
      "Deploy release.",
    ], {
      env: {
        FLEET_RELEASE_TARGETS_JSON: targetJson(),
      },
      runCommand,
      fetchImpl: vi.fn(),
      sleep: vi.fn(),
    })).rejects.toThrow("RAILWAY_API_TOKEN is missing");
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("fails telemetry boolean validation before provider mutation", async () => {
    const runCommand = vi.fn();
    const fetchImpl = vi.fn();
    await expect(runFleetRelease([
      "deploy",
      "--release",
      SHA,
      "--targets",
      "ops",
      "--reason",
      "Deploy release.",
    ], {
      env: {
        FLEET_RELEASE_TARGETS_JSON: targetJson(),
        RAILWAY_API_TOKEN: "railway-token",
        GHCR_IMPORT_USERNAME: "github-user",
        GITHUB_TOKEN: "github-token",
        POSTHOG_ENABLED: "truthy",
      },
      runCommand,
      fetchImpl,
      sleep: vi.fn(),
    })).rejects.toThrow("POSTHOG_ENABLED");
    expect(runCommand).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("requires PostHog for non-dry-run Railway release observability", async () => {
    await expect(runFleetRelease([
      "validate-config",
      "--release",
      SHA,
      "--targets",
      "ops",
      "--dry-run",
      "false",
    ], {
      env: {
        FLEET_RELEASE_OPS_TARGET_JSON: targetJson(),
        CONTROL_PLANE_AGENT_API_KEY: "control-plane-key",
        RAILWAY_API_TOKEN: "railway-token",
        GHCR_IMPORT_USERNAME: "github-user",
        GITHUB_TOKEN: "github-token",
      },
      runCommand: vi.fn(),
      fetchImpl: vi.fn(),
      sleep: vi.fn(),
    })).rejects.toThrow("POSTHOG_PROJECT_TOKEN");
  });

  it("rejects enabled PostHog kill switches for non-dry-run Railway observability", async () => {
    await expect(runFleetRelease([
      "validate-config",
      "--release",
      SHA,
      "--targets",
      "ops",
      "--dry-run",
      "false",
    ], {
      env: {
        FLEET_RELEASE_OPS_TARGET_JSON: targetJson(),
        CONTROL_PLANE_AGENT_API_KEY: "control-plane-key",
        RAILWAY_API_TOKEN: "railway-token",
        GHCR_IMPORT_USERNAME: "github-user",
        GITHUB_TOKEN: "github-token",
        POSTHOG_ENABLED: "true",
        POSTHOG_CAPTURE_KILL_SWITCH: "true",
        POSTHOG_PROJECT_TOKEN: "posthog-project-token",
      },
      runCommand: vi.fn(),
      fetchImpl: vi.fn(),
      sleep: vi.fn(),
    })).rejects.toThrow("POSTHOG_CAPTURE_KILL_SWITCH");
  });

  it("trims PostHog tokens during direct Railway deploy preflight", async () => {
    await expect(runFleetRelease([
      "deploy",
      "--release",
      SHA,
      "--targets",
      "ops",
      "--reason",
      "Deploy release.",
    ], {
      env: {
        FLEET_RELEASE_TARGETS_JSON: targetJson(),
        CONTROL_PLANE_AGENT_API_KEY: "control-plane-key",
        RAILWAY_API_TOKEN: "railway-token",
        GHCR_IMPORT_USERNAME: "github-user",
        GITHUB_TOKEN: "github-token",
        POSTHOG_ENABLED: "true",
        POSTHOG_PROJECT_TOKEN: "   ",
      },
      runCommand: vi.fn(),
      fetchImpl: vi.fn(),
      sleep: vi.fn(),
    })).rejects.toThrow("POSTHOG_PROJECT_TOKEN is missing for Railway observability");
  });

  it("requires Application Insights for non-dry-run Azure release observability", async () => {
    await expect(runFleetRelease([
      "validate-config",
      "--release",
      SHA,
      "--targets",
      "azure-selfserve",
      "--dry-run",
      "false",
    ], {
      env: {
        FLEET_RELEASE_AZURE_TARGET_JSON: azureTargetJson(),
        CONTROL_PLANE_AGENT_API_KEY: "control-plane-key",
        GHCR_IMPORT_USERNAME: "github-user",
        GITHUB_TOKEN: "github-token",
        AZURE_CLIENT_ID: "azure-client",
        AZURE_TENANT_ID: "azure-tenant",
        AZURE_SUBSCRIPTION_ID: "azure-subscription",
      },
      runCommand: vi.fn(),
      fetchImpl: vi.fn(),
      sleep: vi.fn(),
    })).rejects.toThrow("APPLICATIONINSIGHTS_CONNECTION_STRING");
  });

  it("trims Application Insights connection strings during direct Azure deploy preflight", async () => {
    await expect(runFleetRelease([
      "deploy",
      "--release",
      SHA,
      "--targets",
      "azure-selfserve",
      "--reason",
      "Deploy release.",
    ], {
      env: {
        FLEET_RELEASE_TARGETS_JSON: azureTargetJson(),
        CONTROL_PLANE_AGENT_API_KEY: "control-plane-key",
        GHCR_IMPORT_USERNAME: "github-user",
        GITHUB_TOKEN: "github-token",
        AZURE_CLIENT_ID: "azure-client",
        AZURE_TENANT_ID: "azure-tenant",
        AZURE_SUBSCRIPTION_ID: "azure-subscription",
        APPLICATIONINSIGHTS_CONNECTION_STRING: "   ",
      },
      runCommand: vi.fn(),
      fetchImpl: vi.fn(),
      sleep: vi.fn(),
    })).rejects.toThrow("APPLICATIONINSIGHTS_CONNECTION_STRING is missing for Azure observability");
  });

  it("requires Railway worker service metadata before mutation", async () => {
    await expect(runFleetRelease([
      "deploy",
      "--release",
      SHA,
      "--targets",
      "ops",
      "--reason",
      "Deploy release.",
    ], {
      env: {
        FLEET_RELEASE_TARGETS_JSON: targetJson({ railway: {
          projectId: "project-1",
          environmentId: "env-1",
          webServiceId: "web-1",
        } }),
        RAILWAY_API_TOKEN: "railway-token",
      },
      runCommand: vi.fn(),
      fetchImpl: vi.fn(),
      sleep: vi.fn(),
    })).rejects.toThrow("Railway workerServiceId is missing");
  });

  it("requires GHCR pull credentials before Railway mutation", async () => {
    await expect(runFleetRelease([
      "deploy",
      "--release",
      SHA,
      "--targets",
      "ops",
      "--reason",
      "Deploy release.",
    ], {
      env: {
        FLEET_RELEASE_TARGETS_JSON: targetJson(),
        RAILWAY_API_TOKEN: "railway-token",
      },
      runCommand: vi.fn(),
      fetchImpl: vi.fn(),
      sleep: vi.fn(),
    })).rejects.toThrow("GHCR import token is missing for Railway image pull");
  });

  it("does not infer provider from workload or URL", async () => {
    const outputs = {}, toolCalls = [];
    const fetchImpl = vi.fn(async (url, options = {}) => {
      if (String(url).includes("backboard.railway.com")) return successfulRailwayResponse(JSON.parse(options.body));
      if (String(url).includes("/api/control-plane/mcp")) {
        const body = JSON.parse(options.body); toolCalls.push(body.params.name);
        if (body.params.name === "record_verified_release") return controlPlaneResult({ recorded: true });
        if (body.params.name === "list_self_serve_customers") return controlPlaneResult(selfServeRegistry());
      }
      return healthResponse();
    });
    const result = await runFleetRelease([
      "deploy",
      "--release",
      SHA,
      "--targets",
      "azure-selfserve",
      "--reason",
      "Validate provider boundary.",
    ], {
      env: {
        FLEET_RELEASE_TARGETS_JSON: targetJson({
          id: "railway-selfserve",
          deploymentId: "dep-azure",
          label: "Railway Self-Serve",
          group: "azure-selfserve",
          provider: "railway",
          url: "https://selfserve.corgtex.com",
        }),
        CONTROL_PLANE_AGENT_API_KEY: "control-plane-key",
        RAILWAY_API_TOKEN: "railway-token",
        GHCR_IMPORT_USERNAME: "github-user",
        GITHUB_TOKEN: "github-token",
        ...railwayObservabilityEnv,
      },
      runCommand: vi.fn(),
      fetchImpl,
      sleep: vi.fn(),
      emitGithubOutput: (key, value) => { outputs[key] = value; },
    });

    expect(result.results[0].status).toBe("succeeded"); expect(outputs).toMatchObject({ uses_azure: false, uses_railway: true, observation_targets: "railway-selfserve" });
    expect(toolCalls).toEqual(["record_verified_release", "list_self_serve_customers"]); expect(result.results[0].result.providerReadiness).toMatchObject({ status: "ok", provider: "railway" });
  });

  it("preflights Azure self-serve without Railway credentials", async () => {
    const outputs = {};
    const result = await runFleetRelease([
      "deploy",
      "--release",
      SHA,
      "--targets",
      "azure-selfserve",
      "--dry-run",
      "--fail-on-blockers",
      "--reason",
      "Validate Azure release plan.",
    ], {
      env: {
        FLEET_RELEASE_TARGETS_JSON: azureTargetJson(),
        CONTROL_PLANE_AGENT_API_KEY: "control-plane-key",
        GHCR_IMPORT_USERNAME: "github-user",
        GITHUB_TOKEN: "github-token",
        AZURE_CLIENT_ID: "azure-client",
        AZURE_TENANT_ID: "azure-tenant",
        AZURE_SUBSCRIPTION_ID: "azure-subscription",
        ...azureObservabilityEnv,
      },
      runCommand: vi.fn(),
      fetchImpl: vi.fn(),
      sleep: vi.fn(),
      emitGithubOutput: (key, value) => { outputs[key] = value; },
    });

    expect(result.blockers).toEqual([]);
    expect(result.targets).toHaveLength(1);
    expect(result.targets[0]).toMatchObject({ group: "selfserve", provider: "azure" }); expect(outputs).toMatchObject({ uses_azure: true, uses_railway: false, observation_targets: "azure-selfserve" });
  });

  it.each(["Railway", "Azure", "mixed"])("keeps validate-config provider-neutral for managed %s inventory", async () => {
    const fetchImpl = vi.fn();
    const result = await runFleetRelease(["validate-config", "--release", SHA, "--targets", "managed-customers", "--dry-run", "false"], {
      env: { CONTROL_PLANE_AGENT_API_KEY: "control-plane-key", GITHUB_TOKEN: "github-token", POSTHOG_ENABLED: "true", POSTHOG_PROJECT_TOKEN: "posthog-token", APPLICATIONINSIGHTS_CONNECTION_STRING: "InstrumentationKey=review" },
      fetchImpl,
    });
    expect(result.ok).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("keeps managed Azure targets non-mutable until PR3", async () => {
    const managedAzure = {
      id: "managed-azure-private-id",
      inventoryKey: "managed-azure-private-key",
      deploymentId: "managed-azure-private-deployment",
      label: "Managed Azure",
      url: "https://managed-azure.example.test",
      canonicalOrigin: "https://managed-azure.example.test",
      group: "managed-customers",
      provider: "azure",
      azure: { resourceGroup: "rg-managed", webAppName: "web-managed", workerAppName: "worker-managed" },
    };
    await expect(runFleetRelease(["deploy", "--release", SHA, "--targets", "managed-customers", "--dry-run", "--fail-on-blockers", "--reason", "Validate managed Azure."], {
      env: { FLEET_RELEASE_TARGETS_JSON: JSON.stringify([managedAzure]), CONTROL_PLANE_AGENT_API_KEY: "control-plane-key", GITHUB_TOKEN: "github-token", AZURE_CLIENT_ID: "azure-client", AZURE_TENANT_ID: "azure-tenant", AZURE_SUBSCRIPTION_ID: "azure-subscription" },
      runCommand: vi.fn(),
      fetchImpl: vi.fn(async (url) => {
        if (String(url).includes("/api/control-plane/mcp")) return controlPlaneResult([{
          id: "managed-azure-private-deployment",
          url: "https://managed-azure.example.test",
          environment: "production",
          deploymentKind: "REMOTE_MANAGED",
          cloudProvider: "AZURE",
          deploymentStatus: "ACTIVE",
          providerResourceGroup: "rg-managed",
          providerWebServiceId: "web-managed",
          providerWorkerServiceId: "worker-managed",
        }]);
        return { ok: true, status: 200, text: async () => JSON.stringify({ status: "ok", release: { provider: "azure" } }) };
      }),
      sleep: vi.fn(),
    })).rejects.toThrow("non-mutable until the generic Azure executor is implemented in PR3");
  });

  it("discovers active replacements, deduplicates self-serve, and blocks retired mutation", async () => {
    const managed = [
      JSON.parse(managedTargetJson({ id: "active", inventoryKey: "active-key", deploymentId: "active", url: "https://active.example.test", canonicalOrigin: "https://active.example.test", railway: { projectId: "project-active", environmentId: "env-active", webServiceId: "web-active", workerServiceId: "worker-active" } }))[0],
      JSON.parse(managedTargetJson({ id: "retired", inventoryKey: "retired-key", deploymentId: "retired", url: "https://retired.example.test", canonicalOrigin: "https://retired.example.test", deploymentStatus: "RETIRED", railway: { projectId: "project-retired", environmentId: "env-retired", webServiceId: "web-retired", workerServiceId: "worker-retired" } }))[0],
    ];
    const rows = [
      managedControlPlaneRow({ id: "active", url: "https://active.example.test", railwayProjectId: "project-active", railwayEnvironmentId: "env-active", railwayWebServiceId: "web-active", railwayWorkerServiceId: "worker-active" }),
      managedControlPlaneRow({ id: "retired", url: "https://retired.example.test", deploymentStatus: "RETIRED", railwayProjectId: "project-retired", railwayEnvironmentId: "env-retired", railwayWebServiceId: "web-retired", railwayWorkerServiceId: "worker-retired" }),
    ];
    const env = { FLEET_RELEASE_TARGETS_JSON: JSON.stringify(managed), FLEET_RELEASE_AZURE_TARGET_JSON: azureTargetJson(), FLEET_RELEASE_OPS_TARGET_JSON: targetJson(), CONTROL_PLANE_AGENT_API_KEY: "control-plane-key", RAILWAY_API_TOKEN: "railway-token", GITHUB_TOKEN: "github-token", ...railwayObservabilityEnv };
    const deps = { env, runCommand: vi.fn(), fetchImpl: vi.fn(async (url) => String(url).includes("/api/control-plane/mcp") ? controlPlaneResult(rows) : { ok: true, status: 200, text: async () => JSON.stringify({ status: "ok", release: { provider: "railway" } }) }), sleep: vi.fn() };
    const broad = await runFleetRelease(["deploy", "--release", SHA, "--targets", "managed-customers,selfserve,ops", "--dry-run", "--reason", "Validate broad selection."], deps);
    expect(broad.targets.map((target) => [target.id, target.group])).toEqual([["active", "managed-customers"], ["ops", "ops"], ["azure", "selfserve"]]);

    await expect(runFleetRelease(["deploy", "--release", SHA, "--targets", "managed-customers", "--dry-run", "--fail-on-blockers", "--reason", "Validate explicit selection."], deps))
      .rejects.toThrow("control_plane_lifecycle_ineligible");
  });

  it("rejects transition inventory that omits provider", async () => {
    await expect(runFleetRelease(["validate-config", "--release", SHA, "--targets", "selfserve", "--dry-run"], {
      env: { FLEET_RELEASE_AZURE_TARGET_JSON: azureTargetJson({ provider: undefined }) }, runCommand: vi.fn(),
    })).rejects.toThrow("must explicitly declare provider");
  });

  it("can make dry-run preflight blockers fatal before image build", async () => {
    await expect(runFleetRelease([
      "deploy",
      "--release",
      SHA,
      "--targets",
      "ops",
      "--dry-run",
      "--fail-on-blockers",
      "--reason",
      "Preflight release.",
    ], {
      env: {
        FLEET_RELEASE_TARGETS_JSON: targetJson(),
      },
      runCommand: vi.fn(),
      fetchImpl: vi.fn(),
      sleep: vi.fn(),
    })).rejects.toThrow("RAILWAY_API_TOKEN is missing");
  });

  it("checks canonical GHCR web and worker images before promotion", async () => {
    const runCommand = vi.fn().mockReturnValue({ stdout: "", stderr: "" });

    const result = await runFleetRelease([
      "check-images",
      "--release",
      SHA,
    ], {
      env: { GITHUB_REPOSITORY: "Corgtexdotcom/corgtex" },
      runCommand,
    });

    expect(result).toMatchObject({
      ok: true,
      images: [
        `ghcr.io/corgtexdotcom/corgtex/web:sha-${SHA}`,
        `ghcr.io/corgtexdotcom/corgtex/worker:sha-${SHA}`,
      ],
    });
    expect(runCommand).toHaveBeenNthCalledWith(1, "docker", [
      "manifest",
      "inspect",
      `ghcr.io/corgtexdotcom/corgtex/web:sha-${SHA}`,
    ]);
    expect(runCommand).toHaveBeenNthCalledWith(2, "docker", [
      "manifest",
      "inspect",
      `ghcr.io/corgtexdotcom/corgtex/worker:sha-${SHA}`,
    ]);
  });

  it("fails clearly when canonical GHCR images are missing", async () => {
    const runCommand = vi.fn()
      .mockReturnValueOnce({ stdout: "", stderr: "" })
      .mockImplementationOnce(() => {
        throw new Error("manifest unknown");
      });

    await expect(runFleetRelease([
      "check-images",
      "--release",
      SHA,
    ], {
      env: { GITHUB_REPOSITORY: "Corgtexdotcom/corgtex" },
      runCommand,
    })).rejects.toThrow("Release Images workflow before fleet promotion");
  });

  it("passes GHCR registry credentials to Railway image updates", async () => {
    const railwayCalls = [];
    const fetchImpl = vi.fn(async (url, options) => {
      if (String(url).includes("/api/control-plane/mcp")) {
        return controlPlaneResult([managedControlPlaneRow({
          id: "customer-deployment",
          url: "https://customer.corgtex.com",
          railwayProjectId: "project-customer",
          railwayEnvironmentId: "env-customer",
          railwayWebServiceId: "web-customer",
          railwayWorkerServiceId: "worker-customer",
        })]);
      }
      if (String(url).includes("backboard.railway.com")) {
        const body = JSON.parse(options.body);
        railwayCalls.push(body);
        if (body.query.includes("serviceInstanceDeployV2")) {
          return {
            ok: true,
            json: async () => ({
              data: {
                deploymentId: body.variables.serviceId === "web-1" ? "deploy-web" : "deploy-worker",
              },
            }),
          };
        }
        if (body.query.includes("deployments(")) {
          return {
            ok: true,
            json: async () => ({
              data: {
                deployments: {
                  edges: [{
                    node: {
                      id: body.variables.serviceId === "web-1" ? "deploy-web" : "deploy-worker",
                      status: "SUCCESS",
                    },
                  }],
                },
              },
            }),
          };
        }
        return { ok: true, json: async () => ({ data: {} }) };
      }
      return {
        ok: true,
        json: async () => ({
          status: "ok",
          database: "up",
          schema: "ready",
          release: {
            imageTag: `sha-${SHA}`,
            gitSha: SHA,
            provider: "railway",
          },
        }),
      };
    });

    const result = await runFleetRelease([
      "deploy",
      "--release",
      SHA,
      "--targets",
      "ops",
      "--reason",
      "Deploy release.",
    ], {
      env: {
        FLEET_RELEASE_TARGETS_JSON: targetJson(),
        RAILWAY_API_TOKEN: "railway-token",
        GHCR_IMPORT_USERNAME: "github-user",
        GITHUB_TOKEN: "github-token",
        APPLICATIONINSIGHTS_CONNECTION_STRING: "InstrumentationKey=00000000-0000-0000-0000-000000000000",
        POSTHOG_ENABLED: "true",
        POSTHOG_PROJECT_TOKEN: "posthog-project-token",
      },
      runCommand: vi.fn(),
      fetchImpl,
      sleep: vi.fn(),
    });

    expect(result.results).toHaveLength(1);
    const updateCalls = railwayCalls.filter((call) => call.query.includes("serviceInstanceUpdate"));
    expect(updateCalls).toHaveLength(2);
    expect(updateCalls[0].variables.input).toMatchObject({
      source: {
        image: `ghcr.io/corgtexdotcom/corgtex/web:sha-${SHA}`,
      },
      registryCredentials: {
        username: "github-user",
        password: "github-token",
      },
    });
    expect(updateCalls[1].variables.input).toMatchObject({
      source: {
        image: `ghcr.io/corgtexdotcom/corgtex/worker:sha-${SHA}`,
      },
      registryCredentials: {
        username: "github-user",
        password: "github-token",
      },
    });
    const variableCalls = railwayCalls.filter((call) => call.query.includes("variableCollectionUpsert"));
    expect(variableCalls).toHaveLength(2);
    for (const call of variableCalls) {
      expect(call.variables.variables).toMatchObject({
        APPLICATIONINSIGHTS_CONNECTION_STRING: "InstrumentationKey=00000000-0000-0000-0000-000000000000",
        POSTHOG_ENABLED: "true",
        POSTHOG_PROJECT_TOKEN: "posthog-project-token",
        POSTHOG_API_HOST: "https://us.i.posthog.com",
        POSTHOG_ENVIRONMENT: "production",
        CORGTEX_RELEASE_IMAGE_TAG: `sha-${SHA}`,
        CORGTEX_RELEASE_GIT_SHA: SHA,
        CORGTEX_AUTO_SEED_INTERNAL_VALIDATION: "false",
      });
    }
    const deployAndWaitCalls = railwayCalls
      .filter((call) => call.query.includes("serviceInstanceDeployV2") || call.query.includes("deployments("))
      .map((call) => `${call.query.includes("serviceInstanceDeployV2") ? "deploy" : "wait"}:${call.variables.serviceId}`);
    expect(deployAndWaitCalls).toEqual([
      "deploy:web-1",
      "wait:web-1",
      "deploy:worker-1",
      "wait:worker-1",
    ]);
  });

  it("preserves customer PostHog instance ids during Railway customer releases", async () => {
    const railwayCalls = [];
    const fetchImpl = vi.fn(async (url, options) => {
      if (String(url).includes("/api/control-plane/mcp")) {
        return controlPlaneResult([managedControlPlaneRow({
          id: "customer-deployment",
          url: "https://customer.corgtex.com",
          railwayProjectId: "project-customer",
          railwayEnvironmentId: "env-customer",
          railwayWebServiceId: "web-customer",
          railwayWorkerServiceId: "worker-customer",
        })]);
      }
      if (String(url).includes("backboard.railway.com")) {
        const body = JSON.parse(options.body);
        railwayCalls.push(body);
        if (body.query.includes("serviceInstanceDeployV2")) {
          return {
            ok: true,
            json: async () => ({
              data: {
                deploymentId: body.variables.serviceId === "web-customer" ? "deploy-web" : "deploy-worker",
              },
            }),
          };
        }
        if (body.query.includes("deployments(")) {
          return {
            ok: true,
            json: async () => ({
              data: {
                deployments: {
                  edges: [{
                    node: {
                      id: body.variables.serviceId === "web-customer" ? "deploy-web" : "deploy-worker",
                      status: "SUCCESS",
                    },
                  }],
                },
              },
            }),
          };
        }
        return { ok: true, json: async () => ({ data: {} }) };
      }
      return {
        ok: true,
        json: async () => ({
          status: "ok",
          database: "up",
          schema: "ready",
          release: {
            imageTag: `sha-${SHA}`,
            gitSha: SHA,
            provider: "railway",
          },
        }),
      };
    });

    await runFleetRelease([
      "deploy",
      "--release",
      SHA,
      "--targets",
      "railway-customers",
      "--force-after-failure",
      "true",
      "--reason",
      "Deploy release.",
    ], {
      env: {
        FLEET_RELEASE_TARGETS_JSON: managedTargetJson({
          id: "customer",
          inventoryKey: "customer-key",
          deploymentId: "customer-deployment",
          label: "Customer",
          url: "https://customer.corgtex.com",
          canonicalOrigin: "https://customer.corgtex.com",
          group: "managed-customers",
          railway: {
            projectId: "project-customer",
            environmentId: "env-customer",
            webServiceId: "web-customer",
            workerServiceId: "worker-customer",
          },
        }),
        CONTROL_PLANE_AGENT_API_KEY: "control-plane-key",
        RAILWAY_API_TOKEN: "railway-token",
        GHCR_IMPORT_USERNAME: "github-user",
        GITHUB_TOKEN: "github-token",
        POSTHOG_ENABLED: "true",
        POSTHOG_PROJECT_TOKEN: "posthog-project-token",
        POSTHOG_INSTANCE_ID: "global-fleet-id",
      },
      runCommand: vi.fn(),
      fetchImpl,
      sleep: vi.fn(),
    });

    const variableCalls = railwayCalls.filter((call) => call.query.includes("variableCollectionUpsert"));
    expect(variableCalls).toHaveLength(2);
    for (const call of variableCalls) {
      expect(call.variables.variables).toMatchObject({
        POSTHOG_ENABLED: "true",
        POSTHOG_PROJECT_TOKEN: "posthog-project-token",
        CORGTEX_RELEASE_IMAGE_TAG: `sha-${SHA}`,
        CORGTEX_RELEASE_GIT_SHA: SHA,
      });
      expect(call.variables.variables).not.toHaveProperty("POSTHOG_INSTANCE_ID");
    }
  });

  it("requires control-plane credentials before verified inventory recording", async () => {
    await expect(runFleetRelease([
      "deploy",
      "--release",
      SHA,
      "--targets",
      "ops",
      "--reason",
      "Deploy release.",
    ], {
      env: {
        FLEET_RELEASE_TARGETS_JSON: targetJson({ deploymentId: "deployment-1" }),
        RAILWAY_API_TOKEN: "railway-token",
      },
      runCommand: vi.fn(),
      fetchImpl: vi.fn(),
      sleep: vi.fn(),
    })).rejects.toThrow("CONTROL_PLANE_AGENT_API_KEY is missing");
  });

  it("runs sanitized post-deploy probes before recording a verified release", async () => {
    const toolCalls = [];
    const fetchImpl = vi.fn(async (url, options = {}) => {
      const href = String(url);
      if (href.includes("backboard.railway.com")) {
        return successfulRailwayResponse(JSON.parse(options.body));
      }
      if (href.includes("/api/control-plane/mcp")) {
        const body = JSON.parse(options.body);
        toolCalls.push(body.params.name);
        if (body.params.name === "run_post_deploy_probe") {
          return controlPlaneResult({
            deploymentId: "deployment-1",
            status: "ok",
            reads: [{ key: "actions", label: "Actions", status: "ok", count: 1 }],
            recorder: { status: "ok", provider: "RECALL_AI", failureCount: 0 },
            supportAudit: { status: "completed" },
          });
        }
        if (body.params.name === "refresh_fleet_snapshots") {
          return controlPlaneResult({
            results: [
              { snapshotKind: "CONTEXT", status: "ok", error: null },
              { snapshotKind: "INTEGRATION", status: "ok", error: null },
            ],
          });
        }
        if (body.params.name === "record_verified_release") {
          return controlPlaneResult({ recorded: true });
        }
      }
      return healthResponse();
    });

    const result = await runFleetRelease([
      "deploy",
      "--release",
      SHA,
      "--targets",
      "ops",
      "--reason",
      "Deploy release.",
    ], {
      env: {
        FLEET_RELEASE_TARGETS_JSON: targetJson({ deploymentId: "deployment-1" }),
        CONTROL_PLANE_AGENT_API_KEY: "control-plane-token",
        RAILWAY_API_TOKEN: "railway-token",
        GHCR_IMPORT_USERNAME: "github-user",
        GITHUB_TOKEN: "github-token",
        ...railwayObservabilityEnv,
      },
      runCommand: vi.fn(),
      fetchImpl,
      sleep: vi.fn(),
    });

    expect(result.results[0].status).toBe("succeeded");
    expect(toolCalls).toEqual([
      "run_post_deploy_probe",
      "refresh_fleet_snapshots",
      "record_verified_release",
    ]);
    expect(result.results[0].result.postDeployProbe).toMatchObject({
      status: "ok",
      sanitized: true,
    });
  });

  it("blocks release success and alerts when a customer-read probe fails after green health", async () => {
    const toolCalls = [];
    const slackPayloads = [];
    const fetchImpl = vi.fn(async (url, options = {}) => {
      const href = String(url);
      if (href.includes("backboard.railway.com")) {
        return successfulRailwayResponse(JSON.parse(options.body));
      }
      if (href === "https://hooks.slack.test/fleet") {
        slackPayloads.push(JSON.parse(options.body));
        return { ok: true, json: async () => ({ ok: true }) };
      }
      if (href.includes("/api/control-plane/mcp")) {
        const body = JSON.parse(options.body);
        toolCalls.push(body.params.name);
        if (body.params.name === "run_post_deploy_probe") {
          return controlPlaneResult({
            deploymentId: "deployment-1",
            status: "failed",
            reads: [{ key: "actions", label: "Actions", status: "failed", errorClass: "REMOTE_AUTH_OR_SCOPE" }],
            recorder: { status: "ok", provider: "RECALL_AI" },
            supportAudit: { status: "completed" },
          });
        }
      }
      return healthResponse();
    });

    await expect(runFleetRelease([
      "deploy",
      "--release",
      SHA,
      "--targets",
      "ops",
      "--reason",
      "Deploy release.",
    ], {
      env: {
        FLEET_RELEASE_TARGETS_JSON: targetJson({ deploymentId: "deployment-1", label: "Customer A" }),
        CONTROL_PLANE_AGENT_API_KEY: "control-plane-token",
        RAILWAY_API_TOKEN: "railway-token",
        GHCR_IMPORT_USERNAME: "github-user",
        GITHUB_TOKEN: "github-token",
        OPS_SLACK_WEBHOOK_URL: "https://hooks.slack.test/fleet",
        ...railwayObservabilityEnv,
      },
      runCommand: vi.fn(),
      fetchImpl,
      sleep: vi.fn(),
    })).rejects.toThrow("Ring 3 failed");

    expect(toolCalls).toEqual(["run_post_deploy_probe"]);
    expect(slackPayloads[0].text).toContain("Customer A");
    expect(slackPayloads[0].text).toContain("Fleet release");
  });

  it("opens a GitHub incident when Slack is not configured", async () => {
    const githubRequests = [];
    const fetchImpl = vi.fn(async (url, options = {}) => {
      const href = String(url);
      if (href.includes("backboard.railway.com")) {
        return successfulRailwayResponse(JSON.parse(options.body));
      }
      if (href === "https://api.github.com/repos/Corgtexdotcom/corgtex/issues?state=open&per_page=100") {
        githubRequests.push({ method: options.method ?? "GET", url: href });
        return { status: 200, text: async () => "[]" };
      }
      if (href === "https://api.github.com/repos/Corgtexdotcom/corgtex/issues") {
        const body = JSON.parse(options.body);
        githubRequests.push({ method: options.method ?? "GET", url: href, body });
        return { status: 201, text: async () => JSON.stringify({ html_url: "https://github.com/Corgtexdotcom/corgtex/issues/999" }) };
      }
      if (href.includes("/api/control-plane/mcp")) {
        const body = JSON.parse(options.body);
        if (body.params.name === "run_post_deploy_probe") {
          return controlPlaneResult({
            deploymentId: "deployment-1",
            status: "failed",
            reads: [{ key: "brain_context", label: "Brain context", status: "failed", errorClass: "REMOTE_AUTH_OR_SCOPE" }],
            recorder: { status: "ok", provider: "RECALL_AI" },
            supportAudit: { status: "completed" },
          });
        }
      }
      return healthResponse();
    });

    await expect(runFleetRelease([
      "deploy",
      "--release",
      SHA,
      "--targets",
      "ops",
      "--reason",
      "Deploy release.",
    ], {
      env: {
        FLEET_RELEASE_TARGETS_JSON: targetJson({ deploymentId: "deployment-1", label: "Customer A" }),
        CONTROL_PLANE_AGENT_API_KEY: "control-plane-token",
        RAILWAY_API_TOKEN: "railway-token",
        GHCR_IMPORT_USERNAME: "github-user",
        GITHUB_REPOSITORY: "Corgtexdotcom/corgtex",
        GITHUB_TOKEN: "github-token",
        ...railwayObservabilityEnv,
      },
      runCommand: vi.fn(),
      fetchImpl,
      sleep: vi.fn(),
    })).rejects.toThrow("Ring 3 failed");

    const createRequest = githubRequests.find((request) => request.method === "POST");
    expect(createRequest.body.title).toContain("P1 fleet-release");
    expect(createRequest.body.title).toContain("Fleet release");
    expect(createRequest.body.body).toContain("Customer A");
    expect(createRequest.body.body).toContain("REMOTE_AUTH_OR_SCOPE");
  });

  it("reports degraded recorder readiness without blocking deployment success", async () => {
    const sanitized = assertPostDeployProbeReady({
      status: "degraded",
      reads: [{ key: "actions", status: "ok", count: 1 }],
      recorder: { status: "degraded", failureCount: 1 },
      supportAudit: { status: "completed" },
    }, "Customer A");

    expect(sanitized.status).toBe("degraded");
    expect(postDeployProbeFailureSummary(sanitized)).toBe("recorder:degraded");
  });

  it("fails Azure preflight before mutation when provider credentials are missing", async () => {
    await expect(runFleetRelease([
      "deploy",
      "--release",
      SHA,
      "--targets",
      "azure-selfserve",
      "--reason",
      "Deploy release.",
    ], {
      env: {
        FLEET_RELEASE_TARGETS_JSON: azureTargetJson(),
        GHCR_IMPORT_TOKEN: "ghcr-token",
      },
      runCommand: vi.fn(),
      fetchImpl: vi.fn(),
      sleep: vi.fn(),
    })).rejects.toThrow("AZURE_CLIENT_ID is missing");
  });

  it("performs no Azure mutation or release recording when the runtime URL preflight fails", async () => {
    const runCommand = vi.fn((command, args) => {
      if (command === "az" && args[0] === "containerapp" && args[1] === "show") {
        return {
          stdout: JSON.stringify(azurePublicUrlEntries("https://selfserve.corgtex.com", {
            MCP_PUBLIC_URL: "https://selfserve.corgtex.com",
          })),
          stderr: "",
        };
      }
      return { stdout: "", stderr: "" };
    });
    const fetchImpl = vi.fn();

    await expect(runFleetRelease([
      "deploy", "--release", SHA, "--targets", "azure-selfserve", "--reason", "Deploy release.",
    ], {
      env: azureReleaseEnv(),
      runCommand,
      fetchImpl,
      sleep: vi.fn(),
    })).rejects.toThrow("Ring 2 failed");

    expect(runCommand.mock.calls.filter(([command, args]) => (
      command === "az" && (args[0] === "acr" || (args[0] === "containerapp" && ["update", "secret"].includes(args[1])))
    ))).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not record a verified Azure release when public OAuth metadata is incorrect", async () => {
    const controlPlaneTools = [];
    const runCommand = vi.fn((command, args) => {
      if (command === "az" && args[0] === "containerapp" && args[1] === "show") {
        if (args[args.indexOf("--query") + 1].includes(".env")) return { stdout: JSON.stringify(azurePublicUrlEntries()), stderr: "" };
        return { stdout: JSON.stringify({ latest: `${args[3]}-revision`, ready: `${args[3]}-revision` }), stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });
    const fetchImpl = vi.fn(async (url, options = {}) => {
      if (String(url).includes("/api/control-plane/mcp")) {
        const body = JSON.parse(options.body);
        controlPlaneTools.push(body.params.name);
        return controlPlaneResult({ recorded: true });
      }
      if (new URL(String(url)).pathname === "/.well-known/oauth-protected-resource") {
        return publicJsonResponse({
          resource: "https://selfserve.corgtex.com",
          authorization_servers: ["https://selfserve.corgtex.com"],
          scopes_supported: [...MCP_CONNECTOR_DEFAULT_SCOPES],
        });
      }
      return successfulAzurePublicResponse(url);
    });

    await expect(runFleetRelease([
      "deploy", "--release", SHA, "--targets", "azure-selfserve", "--reason", "Deploy release.",
    ], {
      env: azureReleaseEnv(),
      runCommand,
      fetchImpl,
      sleep: vi.fn(),
    })).rejects.toThrow("Ring 2 failed");

    expect(controlPlaneTools).not.toContain("record_verified_release");
  });

  it("sets migrate-and-web startup variables during Azure deploys", async () => {
    const toolCalls = [];
    let releaseRecorded = false;
    const abortSignalForTimeout = vi.fn(() => new AbortController().signal);
    const runCommand = vi.fn((command, args) => {
      if (command === "az" && args[0] === "containerapp" && args[1] === "show") {
        if (args[args.indexOf("--query") + 1].includes(".env")) {
          return { stdout: JSON.stringify(azurePublicUrlEntries()), stderr: "" };
        }
        return { stdout: JSON.stringify({ latest: `${args[3]}-revision`, ready: `${args[3]}-revision` }), stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });
    const fetchImpl = vi.fn(async (url, options = {}) => {
      if (String(url).includes("/api/control-plane/mcp")) {
        const body = JSON.parse(options.body);
        toolCalls.push(body.params.name);
        if (body.params.name === "get_azure_provider_status") {
          expect(releaseRecorded).toBe(true);
          return controlPlaneResult(azureProviderStatus({
            health: { status: "degraded" },
            release: { releaseImageTag: "sha-old", releaseDrift: "Release drift: expected sha-old" },
          }));
        }
        if (body.params.name === "list_self_serve_customers") {
          return controlPlaneResult(selfServeRegistry());
        }
        if (body.params.name === "record_verified_release") {
          releaseRecorded = true;
          return controlPlaneResult({
            recorded: true,
            observedRelease: { imageTag: `sha-${SHA}`, gitSha: SHA },
          });
        }
      }
      return successfulAzurePublicResponse(url);
    });

    const result = await runFleetRelease([
      "deploy",
      "--release",
      SHA,
      "--targets",
      "azure-selfserve",
      "--reason",
      "Deploy release.",
    ], {
      env: {
        FLEET_RELEASE_TARGETS_JSON: azureTargetJson(),
        AZURE_CLIENT_ID: "azure-client",
        AZURE_TENANT_ID: "azure-tenant",
        AZURE_SUBSCRIPTION_ID: "azure-subscription",
        GITHUB_ACTOR: "github-user",
        GITHUB_TOKEN: "github-token",
        CONTROL_PLANE_AGENT_API_KEY: "control-plane-token",
        APPLICATIONINSIGHTS_CONNECTION_STRING: "InstrumentationKey=00000000-0000-0000-0000-000000000000",
        POSTHOG_ENABLED: "true",
        POSTHOG_PROJECT_TOKEN: "posthog-project-token",
        POSTHOG_INSTANCE_ID: "azure-selfserve-production",
      },
      runCommand,
      fetchImpl,
      abortSignalForTimeout,
      sleep: vi.fn(),
    });

    expect(result.results).toHaveLength(1);
    expect(abortSignalForTimeout).toHaveBeenCalledTimes(4);
    const updateCalls = runCommand.mock.calls.filter(([command, args]) => (
      command === "az" && args[0] === "containerapp" && args[1] === "update"
    ));
    const secretCalls = runCommand.mock.calls.filter(([command, args]) => (
      command === "az" && args[0] === "containerapp" && args[1] === "secret" && args[2] === "set"
    ));
    expect(secretCalls).toHaveLength(2);
    for (const [, args] of secretCalls) {
      expect(args).toContain("ai-conn-secret=InstrumentationKey=00000000-0000-0000-0000-000000000000");
      expect(args).toContain("posthog-token=posthog-project-token");
    }
    expect(updateCalls).toHaveLength(2);
    expect(updateCalls.map(([, args]) => args[args.indexOf("--image") + 1])).toEqual([`acr1.azurecr.io/corgtex/web:sha-${SHA}`, `acr1.azurecr.io/corgtex/worker:sha-${SHA}`]);
    for (const [, args] of updateCalls) {
      expect(args).toContain("CORGTEX_STARTUP_MODE=migrate-and-web");
      expect(args).toContain("CORGTEX_AUTO_SEED_JNJ_DEMO=false");
      expect(args).toContain("CORGTEX_AUTO_SEED_INTERNAL_VALIDATION=false");
      expect(args).toContain("SEED_SCRIPTS=");
      expect(args).toContain(`CORGTEX_RELEASE_IMAGE_TAG=sha-${SHA}`);
      expect(args).toContain(`CORGTEX_RELEASE_GIT_SHA=${SHA}`);
      expect(args).toContain("APPLICATIONINSIGHTS_CONNECTION_STRING=secretref:ai-conn-secret");
      expect(args).toContain("POSTHOG_PROJECT_TOKEN=secretref:posthog-token");
      expect(args).toContain("POSTHOG_INSTANCE_ID=azure-selfserve-production");
      expect(args).not.toContain("APPLICATIONINSIGHTS_CONNECTION_STRING=InstrumentationKey=00000000-0000-0000-0000-000000000000");
      expect(args).not.toContain("POSTHOG_PROJECT_TOKEN=posthog-project-token");
    }
    expect(toolCalls).toEqual([
      "record_verified_release",
      "get_azure_provider_status",
      "list_self_serve_customers",
    ]);
    expect(result.results[0].result.verifiedRelease).toMatchObject({ recorded: true });
    expect(result.results[0].result.oauthProof).toMatchObject({
      status: "ok",
      resource: "https://selfserve.corgtex.com/mcp",
      challenges: [{ path: "/mcp", status: 401 }, { path: "/api/mcp", status: 401 }],
    });
    expect(result.results[0].result.providerReadiness).toMatchObject({
      status: "ok",
      provider: "azure",
      releaseImageTag: `sha-${SHA}`,
      releaseProofSource: "runtime_health",
      providerStatusLagging: true,
      providerStatusReleaseImageTag: "sha-old",
      providerStatusReleaseDrift: "Release drift: expected sha-old",
    });
  });

  it("redacts fleet Azure observability secrets when command fallback errors render argv", async () => {
    const binDir = mkdtempSync(join(tmpdir(), "corgtex-fake-az-"));
    const fakeAz = join(binDir, "az");
    writeFileSync(fakeAz, [
      "#!/bin/sh",
      "if [ \"$1\" = \"containerapp\" ] && [ \"$2\" = \"secret\" ] && [ \"$3\" = \"set\" ]; then",
      "  exit 1",
      "fi",
      "if [ \"$1\" = \"containerapp\" ] && [ \"$2\" = \"show\" ]; then",
      "  case \" $* \" in",
      "    *\" -o json \"*) printf '%s\\n' '[{\"name\":\"APP_URL\",\"value\":\"https://selfserve.corgtex.com\"},{\"name\":\"NEXT_PUBLIC_APP_URL\",\"value\":\"https://selfserve.corgtex.com\"},{\"name\":\"MEETING_RECORDER_PUBLIC_BASE_URL\",\"value\":\"https://selfserve.corgtex.com\"},{\"name\":\"MCP_PUBLIC_URL\",\"value\":\"https://selfserve.corgtex.com/mcp\"}]'; exit 0 ;;",
      "  esac",
      "  printf 'fake-revision\\n'",
      "  exit 0",
      "fi",
      "exit 0",
      "",
    ].join("\n"));
    chmodSync(fakeAz, 0o755);

    const logs = [];
    const consoleSpy = vi.spyOn(console, "log").mockImplementation((message) => {
      logs.push(String(message));
    });
    try {
      await runFleetRelease([
        "deploy",
        "--release",
        SHA,
        "--targets",
        "azure-selfserve",
        "--reason",
        "Deploy release.",
      ], {
        env: {
          PATH: binDir,
          FLEET_RELEASE_TARGETS_JSON: azureTargetJson(),
          AZURE_CLIENT_ID: "azure-client",
          AZURE_TENANT_ID: "azure-tenant",
          AZURE_SUBSCRIPTION_ID: "azure-subscription",
          GITHUB_ACTOR: "github-user",
          GITHUB_TOKEN: "github-token",
          CONTROL_PLANE_AGENT_API_KEY: "control-plane-token",
          APPLICATIONINSIGHTS_CONNECTION_STRING: "InstrumentationKey=00000000-0000-0000-0000-000000000000",
          POSTHOG_ENABLED: "true",
          POSTHOG_PROJECT_TOKEN: "posthog-project-token",
        },
        fetchImpl: vi.fn(),
        sleep: vi.fn(),
      });
    } catch (error) {
      expect(error instanceof Error ? error.message : String(error)).toContain("Ring 2 failed");
    } finally {
      consoleSpy.mockRestore();
    }

    const output = logs.join("\n");
    expect(output).toContain("ai-conn-secret=<redacted>");
    expect(output).toContain("posthog-token=<redacted>");
    expect(output).not.toContain("InstrumentationKey=00000000-0000-0000-0000-000000000000");
    expect(output).not.toContain("posthog-project-token=posthog-project-token");
  });

  it("does not treat a different Railway deployment status as proof", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          deployments: {
            edges: [
              { node: { id: "newer-deployment", status: "SUCCESS" } },
            ],
          },
        },
      }),
    });

    const status = await latestRailwayStatus({
      railway: { environmentId: "env-1" },
    }, {
      serviceId: "web-1",
      deploymentId: "triggered-deployment",
    }, {
      env: { RAILWAY_API_TOKEN: "railway-token" },
      fetchImpl,
    });

    expect(status).toBe("UNKNOWN");
  });
});
