import { describe, expect, it, vi } from "vitest";

import { azureReleaseVariables, latestRailwayStatus, releaseVariables, runFleetRelease } from "./fleet-release-runner.mjs";

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
    deploymentId: null,
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
    const runCommand = vi.fn((command, args) => {
      if (command === "az" && args[0] === "containerapp" && args[1] === "show") {
        return { stdout: `${args[3]}-revision\n`, stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });
    const fetchImpl = vi.fn(async () => ({
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
    }));

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
