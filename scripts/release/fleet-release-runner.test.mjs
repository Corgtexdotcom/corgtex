import { describe, expect, it, vi } from "vitest";

import { azureReleaseVariables, latestRailwayStatus, releaseVariables, runFleetRelease } from "./fleet-release-runner.mjs";
import { buildFleetReleaseIncident, fleetReleaseSlackPayload } from "./fleet-release-alerts.mjs";
import { assertPostDeployProbeReady, postDeployProbeFailureSummary, sanitizePostDeployProbe } from "./fleet-release-probes.mjs";

const SHA = "c9077ff031e8e672923c84d52eeef862368f3493";

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

function azureTargetJson(overrides = {}) {
  return JSON.stringify([{
    id: "azure",
    deploymentId: "dep-azure",
    label: "Azure Self-Serve",
    url: "https://selfserve.corgtex.com",
    group: "azure-selfserve",
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

  it("forces Railway release services into combined startup", async () => {
    expect(releaseVariables({
      releaseVersion: "main-c9077ff031e",
      imageTag: `sha-${SHA}`,
      gitSha: SHA,
    })).toEqual({
      CORGTEX_RELEASE_VERSION: "main-c9077ff031e",
      CORGTEX_RELEASE_IMAGE_TAG: `sha-${SHA}`,
      CORGTEX_RELEASE_GIT_SHA: SHA,
      CORGTEX_STARTUP_MODE: "combined",
      CORGTEX_AUTO_SEED_JNJ_DEMO: "false",
      SEED_SCRIPTS: "",
    });
  });

  it("uses migrate-and-web startup for Azure releases", async () => {
    expect(azureReleaseVariables({
      releaseVersion: "main-c9077ff031e",
      imageTag: `sha-${SHA}`,
      gitSha: SHA,
    })).toEqual({
      CORGTEX_RELEASE_VERSION: "main-c9077ff031e",
      CORGTEX_RELEASE_IMAGE_TAG: `sha-${SHA}`,
      CORGTEX_RELEASE_GIT_SHA: SHA,
      CORGTEX_STARTUP_MODE: "migrate-and-web",
      CORGTEX_AUTO_SEED_JNJ_DEMO: "false",
      SEED_SCRIPTS: "",
    });
  });

  it("prints a dry-run plan without mutating providers", async () => {
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
    });

    expect(result.dryRun).toBe(true);
    expect(runCommand).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.targets).toHaveLength(1);
  });

  it("defaults dry-run plans to primary targets and excludes backup app", async () => {
    const result = await runFleetRelease([
      "deploy",
      "--release",
      SHA,
      "--dry-run",
      "--reason",
      "Validate default release plan.",
    ], {
      env: {
        FLEET_RELEASE_TARGETS_JSON: JSON.stringify([{
          id: "customer",
          deploymentId: null,
          label: "Customer",
          url: "https://customer.corgtex.com",
          group: "railway-customers",
          provider: "railway",
          railway: {
            projectId: "project-customer",
            environmentId: "env-customer",
            webServiceId: "web-customer",
            workerServiceId: "worker-customer",
          },
        }]),
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
      fetchImpl: vi.fn(),
      sleep: vi.fn(),
    });

    expect(result.targets.map((target) => target.group)).toEqual([
      "railway-customers",
      "ops",
      "azure-selfserve",
    ]);
    expect(result.targets.some((target) => target.group === "backup-app")).toBe(false);
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

  it("blocks mismatched provider and URL combinations before mutation", async () => {
    await expect(runFleetRelease([
      "deploy",
      "--release",
      SHA,
      "--targets",
      "azure-selfserve",
      "--dry-run",
      "--fail-on-blockers",
      "--reason",
      "Validate provider boundary.",
    ], {
      env: {
        FLEET_RELEASE_TARGETS_JSON: targetJson({
          id: "bad-azure",
          deploymentId: "dep-azure",
          label: "Bad Azure",
          group: "azure-selfserve",
          provider: "railway",
          url: "https://selfserve.corgtex.com",
        }),
        CONTROL_PLANE_AGENT_API_KEY: "control-plane-key",
        RAILWAY_API_TOKEN: "railway-token",
        GHCR_IMPORT_USERNAME: "github-user",
        GITHUB_TOKEN: "github-token",
        AZURE_CLIENT_ID: "azure-client",
        AZURE_TENANT_ID: "azure-tenant",
        AZURE_SUBSCRIPTION_ID: "azure-subscription",
      },
      runCommand: vi.fn(),
      fetchImpl: vi.fn(),
      sleep: vi.fn(),
    })).rejects.toThrow("requires provider azure");
  });

  it("preflights Azure self-serve without Railway credentials", async () => {
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
      },
      runCommand: vi.fn(),
      fetchImpl: vi.fn(),
      sleep: vi.fn(),
    });

    expect(result.blockers).toEqual([]);
    expect(result.targets).toHaveLength(1);
    expect(result.targets[0]).toMatchObject({ group: "azure-selfserve", provider: "azure" });
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
      },
      runCommand: vi.fn(),
      fetchImpl,
      sleep: vi.fn(),
    })).rejects.toThrow("Ring 1 failed");

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
      },
      runCommand: vi.fn(),
      fetchImpl,
      sleep: vi.fn(),
    })).rejects.toThrow("Ring 1 failed");

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

  it("sets migrate-and-web startup variables during Azure deploys", async () => {
    const toolCalls = [];
    const runCommand = vi.fn((command, args) => {
      if (command === "az" && args[0] === "containerapp" && args[1] === "show") {
        return { stdout: `${args[3]}-revision\n`, stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });
    const fetchImpl = vi.fn(async (url, options = {}) => {
      if (String(url).includes("/api/control-plane/mcp")) {
        const body = JSON.parse(options.body);
        toolCalls.push(body.params.name);
        if (body.params.name === "get_azure_provider_status") {
          return controlPlaneResult(azureProviderStatus());
        }
        if (body.params.name === "list_self_serve_customers") {
          return controlPlaneResult(selfServeRegistry());
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
      },
      runCommand,
      fetchImpl,
      sleep: vi.fn(),
    });

    expect(result.results).toHaveLength(1);
    const updateCalls = runCommand.mock.calls.filter(([command, args]) => (
      command === "az" && args[0] === "containerapp" && args[1] === "update"
    ));
    expect(updateCalls).toHaveLength(2);
    for (const [, args] of updateCalls) {
      expect(args).toContain("CORGTEX_STARTUP_MODE=migrate-and-web");
      expect(args).toContain("CORGTEX_AUTO_SEED_JNJ_DEMO=false");
      expect(args).toContain("SEED_SCRIPTS=");
      expect(args).toContain(`CORGTEX_RELEASE_IMAGE_TAG=sha-${SHA}`);
      expect(args).toContain(`CORGTEX_RELEASE_GIT_SHA=${SHA}`);
    }
    expect(toolCalls).toEqual([
      "get_azure_provider_status",
      "list_self_serve_customers",
      "record_verified_release",
    ]);
    expect(result.results[0].result.providerReadiness).toMatchObject({
      status: "ok",
      provider: "azure",
      releaseImageTag: `sha-${SHA}`,
    });
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
