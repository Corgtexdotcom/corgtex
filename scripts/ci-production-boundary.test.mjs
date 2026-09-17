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

  it("observes exactly the three live release targets collected by main CI", () => {
    const observe = job("observe-prod");
    const manifests = [...observe.matchAll(/\{ target: "([^"]+)"/g)].map((match) => match[1]);
    expect(manifests).toEqual(["backup-app", "azure-selfserve", "ops"]);
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

  it("keeps Core observation rooted in the source SHA", () => {
    expect(workflowManifest("core").gitSha).toBe("a".repeat(40));
    expect(workflowManifest("").gitSha).toBe("a".repeat(40));
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
    [observationTargets, ["backup-app", "ops"]],
    ["azure-selfserve,ops", ["ops"]],
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
      "azure_monitor", "backup-app: railway or posthog", "ops: railway or posthog",
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
      .toEqual(["unclassified-runtime", "ops", "backup-app"]);
    expect(summary.advisoryFailures.map((row) => row.instance_id))
      .toEqual(["railway-customers/example"]);
  });

  it("verifies bundled migrations after the exact-release wait without bootstrap or ingestion writes", () => {
    const smoke = job("smoke-prod");
    expect(smoke).toContain('import { verifyMigrations } from "./scripts/start-web.mjs"; await verifyMigrations();');
    const releaseWait = smoke.indexOf("node scripts/railway-smoke.mjs");
    for (const check of ["await verifyMigrations()", "node scripts/check-migration-health.mjs"]) {
      expect(smoke.indexOf(check)).toBeGreaterThan(releaseWait);
      expect(smoke.indexOf(check)).toBeLessThan(smoke.indexOf("id: smoke-proof"));
    }
    expect(smoke).toContain("DATABASE_URL: ${{ secrets.PRODUCTION_DATABASE_URL }}");
    expect(smoke).not.toMatch(/release:db|release-db\.mjs|prisma\s+migrate\s+deploy|prisma\s+db\s+seed|npm run seed|migrate-and-seed|ingestion-guidance-smoke\.mjs|check:(?:migration|seed)-fixtures/);
    expect(smoke).not.toMatch(/run:.*(?:node scripts\/start-web\.mjs|\.main\(\))/);
  });

  it("retains authenticated smoke, exact-release proof and observation", () => {
    const smoke = job("smoke-prod");
    expect(smoke).toContain("- check\n      - db-sync\n      - build");
    expect(smoke).toContain("node scripts/check-migration-health.mjs");
    expect(smoke).toContain("node scripts/self-serve-production-readiness.mjs");
    expect(smoke).toContain("node scripts/railway-smoke.mjs https://app.corgtex.com ${{ secrets.ADMIN_EMAIL }} ${{ secrets.ADMIN_PASSWORD }}");
    expect(smoke).toContain("CORGTEX_SKIP_RELEASE_MATCH: ${{ steps.app-release.outputs.skip_release_match }}");
    expect(smoke).toContain('node scripts/production-validation-context.mjs --classify-app-release --output="$GITHUB_OUTPUT"');
    expect(smoke).toContain("id: smoke-proof");
    expect(job("observe-prod")).toContain("- smoke-prod");
    expect(job("observe-prod")).toContain("post-deploy-observation-gate.mjs");
  });

  it("shares the classifier and full push-range evidence across CI, recovery and production validation", () => {
    const smoke = job("smoke-prod");
    const classify = 'node scripts/production-validation-context.mjs --classify-app-release --output="$GITHUB_OUTPUT"';
    expect(smoke).toContain(classify);
    expect(smoke).toContain("RELEASE_CONTEXT_BEFORE: ${{ github.event.before }}");
    expect(smoke).toContain("RELEASE_CONTEXT_AFTER: ${{ github.sha }}");
    expect(smoke).toContain("name: production-app-release-context");
    expect(recovery).toContain(classify);
    expect(recovery).toContain("run-id: ${{ github.event.workflow_run.id }}");
    expect(recovery).toContain("PRODUCTION_VALIDATION_CI_RELEASE_CONTEXT_PATH: .artifacts/ci-release-context/release-context.json");
    expect(recovery).toContain("RELEASE_CONTEXT_AFTER: ${{ steps.merge.outputs.sha }}");
    for (const consumer of [smoke, recovery]) {
      expect(consumer).not.toContain('case "$path"');
      expect(consumer).not.toContain("git diff --name-only");
      expect(consumer).not.toContain("git rev-parse \"${SHA}^1\"");
    }
    const validation = readFileSync(new URL("../.github/workflows/production-validation.yml", import.meta.url), "utf8");
    expect(validation).toContain("PRODUCTION_VALIDATION_CI_RELEASE_CONTEXT_PATH: .artifacts/ci-release-context/release-context.json");
    expect(validation).toContain('node scripts/production-validation-context.mjs --output="$GITHUB_OUTPUT"');
  });

  it("keeps recovery health, authentication, database, schema and exact-version conditions", () => {
    expect(recovery).toContain("REQUIRES_APP_RELEASE: ${{ steps.app-release.outputs.requires_app_release }}");
    expect(recovery).toContain('const requiresAppRelease = process.argv[3] !== "false";');
    expect(recovery).toContain("!requiresAppRelease || releaseGitSha === sha || releaseImageTag === sha");
    for (const condition of ['json?.status === "ok"', 'json?.service === "web"', 'json?.database === "up"',
      'json?.schema === "ready"', 'json?.app === "corgtex"', 'json?.auth === "password-session"']) {
      expect(recovery).toContain(condition);
    }
    expect(recovery).toContain("process.exit(healthOk && releaseMatches ? 0 : 1)");
    expect(job("check")).toContain("npx vitest run --project unit --project integration");
    const config = readFileSync(new URL("../vitest.config.mts", import.meta.url), "utf8");
    expect(config).toContain('"scripts/**/*.test.mjs"');
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
