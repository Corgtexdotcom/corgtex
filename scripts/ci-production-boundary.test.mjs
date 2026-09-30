import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { buildObservationSummary, normalizeObservationTargets, runObservationGate } from "./post-deploy-observation-gate.mjs";

const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const recovery = readFileSync(new URL("../.github/workflows/auto-revert.yml", import.meta.url), "utf8");

function job(name) {
  const match = workflow.match(new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z][a-z-]*:|$(?![\\s\\S]))`, "m"));
  if (!match) throw new Error(`Missing CI job ${name}`);
  return match[1];
}

describe("automatic production CI boundary", () => {
  const observationTargets = job("observe-prod").match(/observation_targets=([^\s]+)/)?.[1];

  it("serializes QA fixture writes with fleet and direct Azure production releases", () => {
    for (const name of ["qa-workspaces.yml", "fleet-release.yml", "azure-selfserve-production.yml"]) {
      const source = readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), "utf8");
      expect(source).toMatch(/^concurrency:\n  group: fleet-release\n  cancel-in-progress: false$/m);
    }
  });

  it("observes only selfserve and Ops releases collected by main CI", () => {
    const observe = job("observe-prod");
    const manifests = [...observe.matchAll(/\{ target: "([^"]+)"/g)].map((match) => match[1]);
    expect(manifests).toEqual(["azure-selfserve", "ops"]);
    expect([...normalizeObservationTargets(observationTargets)]).toEqual(manifests);
    expect(observe).toContain('OBSERVATION_REQUIRE_SOURCE: "true"');
    expect(observe).toContain("environment: fleet-release-production");
  });

  function workflowManifest(mode) {
    const script = job("observe-prod").match(/node -e '\n(\s+const targetManifests = [\s\S]*?)\n\s*'/)?.[1];
    expect(script).toBeTruthy();
    return JSON.parse(execFileSync(process.execPath, ["-e", script], { encoding: "utf8", env: {
      PRODUCTION_VALIDATION_TARGET: mode, GITHUB_SHA: "a".repeat(40),
      SELFSERVE_GIT_SHA: "b".repeat(40), APP_GIT_SHA: "a".repeat(40), OPS_GIT_SHA: "c".repeat(40),
    } }));
  }

  it("keeps observation rooted in the accepted selfserve SHA regardless of old configuration", () => {
    expect(workflowManifest("core").gitSha).toBe("b".repeat(40));
    expect(workflowManifest("").gitSha).toBe("b".repeat(40));
  });

  it("runs sequence ACL regression on the existing isolated CI database", () => {
    expect(job("check")).toContain("node --test scripts/selfserve-validation-schema.integration.test.mjs");
    expect(job("check")).toContain("QA_SCHEMA_TEST_DATABASE_URL: ${{ env.DATABASE_URL }}");
  });

  it.each(["corgtex_route_error", "corgtex_route_response"])("blocks accepted selfserve %s, not stale source failures", (event) => {
    const manifest = workflowManifest("selfserve-validation");
    expect(manifest.gitSha).toBe("b".repeat(40));
    expect(manifest.targetManifests.map((entry) => entry.target)).toEqual(["azure-selfserve", "ops"]);
    const failure = (sha) => ({ source: "azure_monitor", provider: "azure", instance_id: "azure-selfserve",
      event, status: "500", route: "/api/example", release_git_sha: sha });
    const summarize = (rows) => buildObservationSummary({ manifest, rows, targets: "azure-selfserve,ops",
      since: new Date("2026-09-13T04:00:00Z") });
    const summary = summarize([failure(manifest.gitSha), failure("a".repeat(40))]);
    expect(summary.status).toBe("blocked");
    expect(summary.blockingFailures.map((row) => row.release_git_sha)).toEqual([manifest.gitSha]);
    expect(summary.advisoryFailures.map((row) => row.release_git_sha)).toEqual(["a".repeat(40)]);
    expect(summarize([failure("a".repeat(40))]).status).toBe("passed");
  });

  it.each([
    [observationTargets, ["ops"]],
    ["backup-app,azure-selfserve,ops", ["backup-app", "ops"]],
  ])("observes only selected providers for %s but retains full-fleet failure", async (targets, expectedServices) => {
    const queriedServices = [];
    const target = (id) => ({ id, label: id, provider: "railway",
      railway: { projectId: "project", environmentId: "production", webServiceId: id } });
    const env = {
      RAILWAY_API_TOKEN: "test-token",
      AZURE_APPLICATIONINSIGHTS_APP_NAME: "test-app",
      AZURE_APPLICATIONINSIGHTS_RESOURCE_GROUP: "test-rg",
      OBSERVATION_REQUIRE_SOURCE: "true",
      FLEET_RELEASE_TARGETS_JSON: JSON.stringify([target("legacy-customer")]),
      FLEET_RELEASE_OPS_TARGET_JSON: JSON.stringify(target("ops")),
      FLEET_RELEASE_BACKUP_APP_TARGET_JSON: JSON.stringify(target("backup-app")),
    };
    const deps = {
      runCommand: () => JSON.stringify({ tables: [{ columns: [], rows: [] }] }),
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(init.body);
        if (body.query.includes("LatestDeployment")) {
          queriedServices.push(body.variables.serviceId);
          const edges = body.variables.serviceId === "legacy-customer" ? []
            : [{ node: { id: `${body.variables.serviceId}-deployment`, status: "SUCCESS" } }];
          return new Response(JSON.stringify({ data: { deployments: { edges } } }));
        }
        return new Response(JSON.stringify({ data: { httpLogs: [] } }));
      },
    };
    const options = { manifest: { gitSha: "a".repeat(40) },
      since: new Date("2026-09-13T04:00:00Z"), env, deps };
    const summary = await runObservationGate({ ...options, targets });
    expect(summary.status).toBe("passed");
    expect(summary.missingRequiredSources).toEqual([]);
    expect(queriedServices.sort()).toEqual(expectedServices);
    await expect(runObservationGate({ ...options, targets: "all" }))
      .rejects.toThrow("No Railway deployment found for legacy-customer");
  });

  it("still blocks main observation when required telemetry is unavailable", async () => {
    const summary = await runObservationGate({
      manifest: { gitSha: "a".repeat(40) },
      since: new Date("2026-09-13T04:00:00Z"),
      targets: observationTargets,
      env: { OBSERVATION_REQUIRE_SOURCE: "true" },
    });
    expect(summary.status).toBe("blocked");
    expect(summary.missingRequiredSources).toEqual(expect.arrayContaining([
      "azure_monitor", "ops: railway or posthog",
    ]));
  });

  it("preserves conservative unknown-provider failures without blocking attributed customer rows", () => {
    const sha = "a".repeat(40);
    const failure = (instance_id) => ({ source: "posthog", provider: "railway",
      event: "corgtex_route_error", release_git_sha: sha, route: "/api/example",
      status: "500", instance_id });
    const summary = buildObservationSummary({
      manifest: { gitSha: sha }, since: new Date("2026-09-13T04:00:00Z"),
      targets: observationTargets,
      rows: [failure("railway-customers/example"), failure("unclassified-runtime"),
        failure("ops"), failure("backup-app")],
    });
    expect(summary.status).toBe("blocked");
    expect(summary.blockingFailures.map((row) => row.instance_id))
      .toEqual(["unclassified-runtime", "ops"]);
    expect(summary.advisoryFailures.map((row) => row.instance_id))
      .toEqual(["railway-customers/example", "backup-app"]);
  });

  it("keeps legacy Core writers, baseline consumption and source reverts out of automatic delivery", () => {
    expect(workflow).not.toMatch(/smoke-prod:|accepted-core-baseline|https:\/\/app\.corgtex\.com|secrets\.PRODUCTION_DATABASE_URL/);
    expect(recovery).not.toMatch(/git revert|contents: write|Open revert PR/);
    expect(job("smoke-selfserve")).toContain("uses: ./.github/workflows/production-validation.yml");
    expect(job("observe-prod")).toContain("post-deploy-observation-gate.mjs");
    expect(job("observe-prod")).toContain("SELFSERVE_VALIDATION_EXPECTED_SHA");
    expect(job("check")).toContain("npx vitest run --project unit --project integration");
  });

  it("retains isolated PostgreSQL migration, integration and seed-fixture checks", () => {
    for (const name of ["check", "db-sync"]) {
      expect(job(name)).toContain("image: pgvector/pgvector:pg16");
      expect(job(name)).toContain("@localhost:5432/");
      expect(job(name)).toContain("npx prisma migrate deploy");
      expect(job(name)).not.toContain("secrets.PRODUCTION_DATABASE_URL");
    }
    expect(job("check")).toContain("npx vitest run --project unit --project integration");
    expect(job("db-sync")).toContain("npm run check:migration-fixtures");
    expect(job("db-sync")).toContain("npm run check:seed-fixtures");
  });
});
