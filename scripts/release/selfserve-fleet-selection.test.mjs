import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { buildWorkflowInputs } from "../release-fleet.mjs";
import { runFleetRelease } from "./fleet-release-runner.mjs";

const SHA = "a".repeat(40);
const target = {
  id: "synthetic-selfserve", deploymentId: "synthetic-selfserve-deployment",
  label: "Synthetic Selfserve", group: "selfserve", provider: "azure",
  url: "https://synthetic-selfserve.example.test",
  azure: { resourceGroup: "synthetic-rg", acrName: "syntheticacr", webAppName: "synthetic-web", workerAppName: "synthetic-worker" },
};
const providerTarget = (id) => JSON.stringify({ id, group: id, provider: "railway", url: `https://${id}.example.test`,
  railway: { projectId: "synthetic-project", environmentId: "synthetic-env", webServiceId: "synthetic-web", workerServiceId: "synthetic-worker" } });
function dependencies(extra = {}) {
  return {
    env: {
      FLEET_RELEASE_TARGETS_JSON: JSON.stringify([target]),
      FLEET_RELEASE_AZURE_TARGET_JSON: JSON.stringify({ ...target, group: "azure-selfserve" }),
      CONTROL_PLANE_AGENT_API_KEY: "synthetic-control-plane-key",
      AZURE_CLIENT_ID: "synthetic-client", AZURE_TENANT_ID: "synthetic-tenant", AZURE_SUBSCRIPTION_ID: "synthetic-subscription",
      GITHUB_TOKEN: "synthetic-github-token", ...extra,
    },
    fetchImpl: vi.fn(async () => { throw new Error("Unexpected provider/discovery read"); }),
    runCommand: vi.fn(() => { throw new Error("Unexpected external command"); }),
  };
}
const planArgs = (selection = "selfserve", extra = []) => ["deploy", "--release", SHA, "--targets", selection,
  "--dry-run", "true", "--fail-on-blockers", "true", "--reason", "Synthetic offline selection test", ...extra];

describe("selfserve-only fleet configuration", () => {
  it("aligns both workflow defaults with the CLI without dispatching a workflow", () => {
    expect(buildWorkflowInputs(["--reason", "Synthetic selection"]).targets).toBe("selfserve");
    for (const name of ["fleet-release.yml", "fleet-release-preflight.yml"]) {
      const workflow = parse(readFileSync(new URL(`../../.github/workflows/${name}`, import.meta.url), "utf8"));
      expect(workflow.on.workflow_dispatch.inputs.targets.default).toBe("selfserve");
      expect(workflow.jobs[ name === "fleet-release.yml" ? "release" : "preflight" ].environment).toBe("fleet-release-production");
    }
  });

  it.each([true, false])("deduplicates selfserve and suppresses discovery with legacy Ops/backup variables present=%s", async (legacyPresent) => {
    const deps = dependencies(legacyPresent ? {
      FLEET_RELEASE_OPS_TARGET_JSON: providerTarget("ops"),
      FLEET_RELEASE_BACKUP_APP_TARGET_JSON: providerTarget("backup-app"),
    } : {});
    await expect(runFleetRelease(["validate-config", "--release", SHA, "--targets", "selfserve", "--dry-run", "true"], deps)).resolves.toMatchObject({ ok: true, targetGroups: ["selfserve"] });
    const result = await runFleetRelease(planArgs(), deps);
    expect(result.targets).toHaveLength(1);
    expect(result.targets[0]).toMatchObject({ deploymentId: target.deploymentId, provider: "azure", group: "selfserve" });
    expect(result.blockers).toEqual([]);
    expect(deps.fetchImpl).not.toHaveBeenCalled();
    expect(deps.runCommand).not.toHaveBeenCalled();
  });

  it("does not rediscover missing dedicated targets when they are selected explicitly", async () => {
    const deps = dependencies();
    await expect(runFleetRelease(planArgs("managed-customers"), deps)).rejects.toThrow("No release targets matched");
    await expect(runFleetRelease(planArgs("selfserve", ["--target-id", "synthetic-obsolete-deployment"]), deps))
      .rejects.toThrow("No release target matched deployment ID");
    expect(deps.fetchImpl).not.toHaveBeenCalled();
    expect(deps.runCommand).not.toHaveBeenCalled();
  });

  it("retains the existing validator requirement for the legacy-named Azure target variable", async () => {
    const deps = dependencies();
    delete deps.env.FLEET_RELEASE_AZURE_TARGET_JSON;
    await expect(runFleetRelease(["validate-config", "--release", SHA, "--targets", "selfserve", "--dry-run", "true"], deps))
      .rejects.toThrow("FLEET_RELEASE_AZURE_TARGET_JSON");
    expect(deps.fetchImpl).not.toHaveBeenCalled();
  });

  it("does not mistake the general inventory for an override of additive Ops and backup inventory", async () => {
    const deps = dependencies({ FLEET_RELEASE_OPS_TARGET_JSON: providerTarget("ops"), FLEET_RELEASE_BACKUP_APP_TARGET_JSON: providerTarget("backup-app") });
    // Pure planning only: the legacy broad override still sees other variables.
    const args = planArgs("all");
    args.splice(args.indexOf("--fail-on-blockers"), 2);
    const result = await runFleetRelease(args, deps);
    expect(result.targets.map((t) => t.group).sort()).toEqual(["backup-app", "ops", "selfserve"]);
    expect(deps.fetchImpl).not.toHaveBeenCalled();
    expect(deps.runCommand).not.toHaveBeenCalled();
  });
});
