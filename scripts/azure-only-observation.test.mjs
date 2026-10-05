import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { azureOnlyObservationManifest } from "./azure-only-observation-manifest.mjs";
import { runObservationGate } from "./post-deploy-observation-gate.mjs";

const SHA = "8c56008ab7cad48f55d3bbf96c761cdadd1b15e7";
const health = {
  status: "ok",
  service: "web",
  database: "up",
  schema: "ready",
  app: "corgtex",
  auth: "password-session",
  release: {
    gitSha: SHA,
    imageTag: `sha-${SHA}`,
    version: "main-8c56008ab7ca",
    configured: { gitSha: SHA },
    runtime: { gitSha: SHA, evidence: "baked" },
  },
};

describe("Azure-only observation", () => {
  it("pins its single-target manifest to a healthy baked production release", () => {
    expect(azureOnlyObservationManifest(health, SHA)).toEqual({
      gitSha: SHA,
      targetManifests: [{
        target: "azure-selfserve",
        gitSha: SHA,
        imageTag: `sha-${SHA}`,
        releaseVersion: "main-8c56008ab7ca",
      }],
    });
    expect(() => azureOnlyObservationManifest(health, "a".repeat(40))).toThrow();
    expect(() => azureOnlyObservationManifest({
      ...health,
      release: { ...health.release, runtime: { gitSha: SHA, evidence: "configured" } },
    }, SHA)).toThrow(/baked runtime/);
  });

  it("queries Azure Monitor only and never publishes advisories", async () => {
    const runCommand = vi.fn((command, args) => {
      expect(command).toBe("az");
      expect(args.slice(0, 3)).toEqual(["monitor", "app-insights", "query"]);
      return JSON.stringify({ tables: [{ columns: [], rows: [] }] });
    });
    const fetchImpl = vi.fn(() => { throw new Error("Unexpected provider request"); });
    const summary = await runObservationGate({
      env: {
        AZURE_APPLICATIONINSIGHTS_APP_NAME: "app-insights",
        AZURE_APPLICATIONINSIGHTS_RESOURCE_GROUP: "production-rg",
        OBSERVATION_REQUIRE_SOURCE: "true",
      },
      manifest: azureOnlyObservationManifest(health, SHA),
      targets: "azure-selfserve",
      since: new Date("2026-10-05T01:00:00Z"),
      until: new Date("2026-10-05T01:20:00Z"),
      deps: { runCommand, fetchImpl },
    });

    expect(summary.status).toBe("passed");
    expect(summary.missingRequiredSources).toEqual([]);
    expect(summary.sourceChecks).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "azure_monitor", status: "queried" }),
      expect.objectContaining({ source: "posthog", status: "skipped" }),
    ]));
    expect(summary.advisoryPublish).toEqual({ attempted: false, status: "skipped" });
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("keeps the protected manual workflow limited to Azure reads", () => {
    const workflow = readFileSync(new URL("../.github/workflows/azure-selfserve-observation.yml", import.meta.url), "utf8");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("environment: fleet-release-production");
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).toContain("--targets azure-selfserve");
    expect(workflow).toContain("OBSERVATION_REQUIRE_SOURCE: \"true\"");
    expect([...workflow.matchAll(/secrets\.([A-Z_]+)/g)].map((match) => match[1])).toEqual([
      "AZURE_CLIENT_ID",
      "AZURE_TENANT_ID",
      "AZURE_SUBSCRIPTION_ID",
    ]);
    expect([...workflow.matchAll(/^\s*(?:-\s*)?uses: (.+)$/gm)].map((match) => match[1])).toEqual([
      "actions/checkout@v5",
      "actions/setup-node@v5",
      "azure/login@v2",
      "actions/upload-artifact@v4",
    ]);
    expect(workflow).not.toMatch(/POSTHOG_|RAILWAY_|ops\.corgtex\.com|--publish-advisories|issues: write/);
    expect(workflow).not.toMatch(/curl[^\n]*-X\s+(POST|PUT|PATCH|DELETE)|\baz\s+(containerapp|deployment|acr)\b/);
  });
});
