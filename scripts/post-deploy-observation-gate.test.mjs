import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  buildObservationSummary,
  normalizeObservationTargets,
  observationTargetsForRow,
  parseAzureMonitorRows,
  parsePostHogRows,
  parseRailwayHttpLogRows,
  queryAzureMonitorRows,
  runObservationGate,
} from "./post-deploy-observation-gate.mjs";

const SHA = "8c56008ab7cad48f55d3bbf96c761cdadd1b15e7";
const manifest = {
  gitSha: SHA,
  imageTag: `sha-${SHA}`,
  releaseVersion: "main-8c56008ab7ca",
};

describe("post-deploy observation gate", () => {
  it("runs as a CLI from paths containing spaces", () => {
    const scriptPath = fileURLToPath(new URL("./post-deploy-observation-gate.mjs", import.meta.url));
    const output = execFileSync(process.execPath, [
      scriptPath,
      "--release-git-sha",
      SHA,
      "--release-image-tag",
      `sha-${SHA}`,
      "--window-minutes",
      "1",
    ], {
      encoding: "utf8",
      env: { ...process.env, AZURE_APPLICATIONINSIGHTS_APP_NAME: "", AZURE_APPLICATIONINSIGHTS_RESOURCE_GROUP: "" },
    });
    expect(JSON.parse(output).status).toBe("passed");
  });

  it("reports missing required observation sources without failing the CLI", () => {
    const scriptPath = fileURLToPath(new URL("./post-deploy-observation-gate.mjs", import.meta.url));
    const output = execFileSync(process.execPath, [
      scriptPath,
      "--release-git-sha",
      SHA,
      "--release-image-tag",
      `sha-${SHA}`,
      "--window-minutes",
      "1",
    ], {
      encoding: "utf8",
      env: {
        ...process.env,
        AZURE_APPLICATIONINSIGHTS_APP_NAME: "",
        AZURE_APPLICATIONINSIGHTS_RESOURCE_GROUP: "",
        OBSERVATION_REQUIRE_SOURCE: "true",
      },
    });
    const summary = JSON.parse(output);
    expect(summary.status).toBe("blocked");
    expect(summary.blockerReason).toContain("missing_observation_sources");
    expect(summary.missingRequiredSources).toContain("azure_monitor");
  });

  it("preserves explicit manifest aliases over runtime defaults", () => {
    const scriptPath = fileURLToPath(new URL("./post-deploy-observation-gate.mjs", import.meta.url));
    const explicitSha = "1111111111111111111111111111111111111111";
    const runtimeSha = "2222222222222222222222222222222222222222";
    const output = execFileSync(process.execPath, [
      scriptPath,
      "--manifest-json",
      JSON.stringify({ release_git_sha: explicitSha }),
      "--window-minutes",
      "1",
    ], {
      encoding: "utf8",
      env: {
        ...process.env,
        AZURE_APPLICATIONINSIGHTS_APP_NAME: "",
        AZURE_APPLICATIONINSIGHTS_RESOURCE_GROUP: "",
        GITHUB_SHA: runtimeSha,
      },
    });

    expect(JSON.parse(output).release.gitSha).toBe(explicitSha);
  });

  it("preserves target-only manifest JSON without runtime defaults", () => {
    const scriptPath = fileURLToPath(new URL("./post-deploy-observation-gate.mjs", import.meta.url));
    const runtimeSha = "2222222222222222222222222222222222222222";
    const output = execFileSync(process.execPath, [
      scriptPath,
      "--manifest-json",
      JSON.stringify({ targetManifests: [{ target: "backup-app", gitSha: runtimeSha }] }),
      "--window-minutes",
      "1",
    ], {
      encoding: "utf8",
      env: {
        ...process.env,
        AZURE_APPLICATIONINSIGHTS_APP_NAME: "",
        AZURE_APPLICATIONINSIGHTS_RESOURCE_GROUP: "",
        GITHUB_SHA: runtimeSha,
      },
    });

    expect(JSON.parse(output).release.gitSha).toBeNull();
  });

  it("blocks release-correlated route failures", () => {
    const summary = buildObservationSummary({
      manifest,
      since: new Date("2026-07-16T05:52:00.000Z"),
      rows: [{
        source: "azure_monitor",
        name: "corgtex_route_error",
        instance_id: "tenant-a",
        provider: "railway",
        release_git_sha: SHA,
        release_image_tag: `sha-${SHA}`,
        route: "/api/meetings/upload",
        status: "500",
        code: "INTERNAL_SERVER_ERROR",
        events: 2,
        first_seen: "2026-07-16T05:54:00.000Z",
      }],
    });

    expect(summary.status).toBe("blocked");
    expect(summary.blockingFailures).toHaveLength(1);
    expect(summary.advisoryIncidents).toHaveLength(0);
  });

  it("routes unrelated production failures to advisory incidents without blocking", () => {
    const summary = buildObservationSummary({
      manifest,
      since: new Date("2026-07-16T05:52:00.000Z"),
      rows: [{
        source: "posthog",
        event: "corgtex_server_action_error",
        instance_id: "backup-app",
        provider: "railway",
        release_git_sha: "older-sha",
        action: "saveSettings",
        code: "ACTION_FAILED",
        count: 1,
        lastSeen: "2026-07-16T05:55:00.000Z",
        source_url: "https://us.posthog.com/project/452941",
      }],
    });

    expect(summary.status).toBe("passed");
    expect(summary.blockingFailures).toHaveLength(0);
    expect(summary.advisoryFailures).toHaveLength(1);
    expect(summary.advisoryIncidents[0].recommendedAction).toContain("follow-up");
    expect(JSON.stringify(summary.advisoryIncidents[0])).toContain("older-sha");
  });

  it("does not identify a runtime release by stale configured image tag or version", () => {
    const currentSha = "80e365cf2bcfd0b01a5cfdf0656a0c4fbfc7b4ba";
    const oldSha = "ea3fc329fe1df04d739a0abf7cb37d9c21282697";
    const summary = buildObservationSummary({
      manifest: {
        gitSha: currentSha,
        imageTag: oldSha,
        releaseVersion: `main-${oldSha.slice(0, 12)}`,
      },
      since: new Date("2026-07-16T13:05:05.000Z"),
      rows: [{
        source: "azure_monitor",
        event: "corgtex_worker_error",
        instance_id: "corgtex",
        provider: "railway",
        release_git_sha: oldSha,
        release_image_tag: oldSha,
        release_version: `main-${oldSha.slice(0, 12)}`,
        surface: "worker",
        action: "tick",
        code: "WORKER_TICK_ERROR",
        events: 1,
      }],
    });

    expect(summary.status).toBe("passed");
    expect(summary.blockingFailures).toHaveLength(0);
    expect(summary.advisoryFailures).toHaveLength(1);
  });

  it("prefers observed runtime SHA over observed configured image tag", () => {
    const currentSha = "80e365cf2bcfd0b01a5cfdf0656a0c4fbfc7b4ba";
    const oldSha = "ea3fc329fe1df04d739a0abf7cb37d9c21282697";
    const summary = buildObservationSummary({
      manifest: {
        gitSha: currentSha,
        imageTag: `sha-${currentSha}`,
        releaseVersion: `main-${currentSha.slice(0, 12)}`,
      },
      since: new Date("2026-07-16T13:05:05.000Z"),
      rows: [{
        source: "azure_monitor",
        event: "corgtex_worker_error",
        instance_id: "corgtex",
        provider: "railway",
        release_git_sha: oldSha,
        release_image_tag: `sha-${currentSha}`,
        release_version: `main-${currentSha.slice(0, 12)}`,
        surface: "worker",
        action: "tick",
        code: "WORKER_TICK_ERROR",
        events: 1,
      }],
    });

    expect(summary.status).toBe("passed");
    expect(summary.blockingFailures).toHaveLength(0);
    expect(summary.advisoryFailures).toHaveLength(1);
  });

  it("keeps date-style versions subordinate to observed runtime SHA", () => {
    const currentSha = "80e365cf2bcfd0b01a5cfdf0656a0c4fbfc7b4ba";
    const oldSha = "ea3fc329fe1df04d739a0abf7cb37d9c21282697";
    const summary = buildObservationSummary({
      manifest: {
        gitSha: currentSha,
        releaseVersion: "main-2026-07-16",
      },
      since: new Date("2026-07-16T13:05:05.000Z"),
      rows: [{
        source: "azure_monitor",
        event: "corgtex_worker_error",
        instance_id: "corgtex",
        provider: "railway",
        release_git_sha: oldSha,
        release_version: "main-2026-07-16",
        surface: "worker",
        action: "tick",
        code: "WORKER_TICK_ERROR",
        events: 1,
      }],
    });

    expect(summary.status).toBe("passed");
    expect(summary.blockingFailures).toHaveLength(0);
    expect(summary.advisoryFailures).toHaveLength(1);
  });

  it("passes a clean observation window", () => {
    const summary = buildObservationSummary({
      manifest,
      since: new Date("2026-07-16T05:52:00.000Z"),
      rows: [{
        source: "azure_monitor",
        name: "corgtex_route_error",
        instance_id: "tenant-a",
        release_git_sha: SHA,
        route: "/api/auth/login",
        status: "400",
        code: "VALIDATION_ERROR",
        events: 3,
      }],
    });

    expect(summary.status).toBe("passed");
    expect(summary.blockingFailures).toHaveLength(0);
    expect(summary.advisoryFailures).toHaveLength(0);
  });

  it("keeps release-correlated blockers even when older failures are noisy", () => {
    const olderRows = Array.from({ length: 150 }, (_, index) => ({
      source: "posthog",
      event: "corgtex_route_error",
      instance_id: `older-${index}`,
      release_git_sha: `older-sha-${index}`,
      route: "/api/noisy",
      status: "500",
      events: 10_000 - index,
    }));

    const summary = buildObservationSummary({
      manifest,
      since: new Date("2026-07-16T05:52:00.000Z"),
      rows: [
        ...olderRows,
        {
          source: "posthog",
          event: "corgtex_route_error",
          instance_id: "current",
          release_git_sha: SHA,
          route: "/api/current-release",
          status: "500",
          events: 1,
        },
      ],
    });

    expect(summary.status).toBe("blocked");
    expect(summary.blockingFailures).toHaveLength(1);
    expect(summary.blockingFailures[0].route).toBe("/api/current-release");
  });

  it("keeps same-release failures from unselected targets advisory-only", () => {
    const summary = buildObservationSummary({
      manifest,
      since: new Date("2026-07-16T05:52:00.000Z"),
      targets: "railway-customers",
      rows: [
        {
          source: "posthog",
          event: "corgtex_render_error",
          instance_id: "azure-selfserve-production",
          provider: "azure",
          release_git_sha: SHA,
          route: "/workspaces/example",
          events: 1,
        },
        {
          source: "posthog",
          event: "corgtex_route_error",
          instance_id: "customer-a",
          provider: "railway",
          release_git_sha: SHA,
          route: "/api/workspaces/ws/meetings/transcript",
          status: "500",
          events: 1,
        },
      ],
    });

    expect(summary.status).toBe("blocked");
    expect(summary.blockingFailures).toHaveLength(1);
    expect(summary.blockingFailures[0].instance_id).toBe("customer-a");
    expect(summary.advisoryFailures).toHaveLength(1);
    expect(summary.advisoryFailures[0].instance_id).toBe("azure-selfserve-production");
  });

  it("keeps unknown Railway rows blocking for selected Railway-backed targets", () => {
    const summary = buildObservationSummary({
      manifest,
      since: new Date("2026-07-16T05:52:00.000Z"),
      targets: "ops",
      rows: [{
        source: "posthog",
        event: "corgtex_route_error",
        instance_id: "railway-runtime-without-target-metadata",
        provider: "railway",
        release_git_sha: SHA,
        route: "/api/current-release",
        status: "500",
        events: 1,
      }],
    });

    expect(summary.status).toBe("blocked");
    expect(summary.blockingFailures).toHaveLength(1);
    expect(summary.blockingFailures[0].instance_id).toBe("railway-runtime-without-target-metadata");
  });

  it("keeps selfserve observation matching provider-qualified", () => {
    expect([...normalizeObservationTargets("railway-selfserve")]).toEqual(["railway-selfserve"]);
    expect(observationTargetsForRow({ provider: "railway", surface: "selfserve" })).toEqual(["railway-selfserve"]);
    expect(observationTargetsForRow({ surface: "selfserve" })).toEqual(["azure-selfserve", "railway-selfserve"]);
  });

  it("does not block Azure-only gates on unknown Railway target rows", () => {
    const summary = buildObservationSummary({
      manifest,
      since: new Date("2026-07-16T05:52:00.000Z"),
      targets: "azure-selfserve",
      rows: [{
        source: "posthog",
        event: "corgtex_route_error",
        instance_id: "railway-runtime-without-target-metadata",
        provider: "railway",
        release_git_sha: SHA,
        route: "/api/current-release",
        status: "500",
        events: 1,
      }],
    });

    expect(summary.status).toBe("passed");
    expect(summary.blockingFailures).toHaveLength(0);
    expect(summary.advisoryFailures).toHaveLength(1);
  });

  it("treats main production smoke as all production targets", () => {
    const summary = buildObservationSummary({
      manifest,
      since: new Date("2026-07-16T05:52:00.000Z"),
      targets: "main-production-smoke",
      rows: [{
        source: "azure_monitor",
        event: "corgtex_render_error",
        instance_id: "azure-selfserve-production",
        provider: "azure",
        release_git_sha: SHA,
        route: "/workspaces/example",
        events: 1,
      }],
    });

    expect(summary.status).toBe("blocked");
    expect(summary.blockingFailures).toHaveLength(1);
    expect(normalizeObservationTargets("main-production-smoke")).toBeNull();
    expect(observationTargetsForRow(summary.blockingFailures[0])).toEqual(["azure-selfserve"]);
  });

  it("matches target-specific live releases in one production observation window", () => {
    const summary = buildObservationSummary({
      manifest: {
        targetManifests: [
          { target: "backup-app", gitSha: "app-sha" },
          { target: "azure-selfserve", gitSha: "selfserve-sha" },
          { target: "ops", gitSha: "ops-sha" },
        ],
      },
      since: new Date("2026-07-16T05:52:00.000Z"),
      targets: "main-production-smoke",
      rows: [
        {
          source: "posthog",
          event: "corgtex_route_error",
          instance_id: "backup-app",
          provider: "railway",
          release_git_sha: "app-sha",
          route: "https://app.corgtex.com/api/current-release",
          status: "500",
          events: 1,
        },
        {
          source: "posthog",
          event: "corgtex_render_error",
          instance_id: "azure-selfserve-production",
          provider: "azure",
          release_git_sha: "selfserve-sha",
          route: "/workspaces/example",
          events: 1,
        },
        {
          source: "posthog",
          event: "corgtex_route_error",
          instance_id: "older-runtime",
          provider: "railway",
          release_git_sha: "older-sha",
          route: "/api/older",
          status: "500",
          events: 1,
        },
      ],
    });

    expect(summary.status).toBe("blocked");
    expect(summary.blockingFailures).toHaveLength(2);
    expect(summary.advisoryFailures).toHaveLength(1);
    expect(summary.targetReleases.map((release) => release.target)).toEqual(["backup-app", "azure-selfserve", "ops"]);
  });

  it("keeps older live target releases advisory when a primary pushed release is known", () => {
    const currentSha = "80e365cf2bcfd0b01a5cfdf0656a0c4fbfc7b4ba";
    const oldSha = "ea3fc329fe1df04d739a0abf7cb37d9c21282697";
    const summary = buildObservationSummary({
      manifest: {
        gitSha: currentSha,
        targetManifests: [
          {
            target: "backup-app",
            gitSha: currentSha,
            imageTag: `sha-${oldSha}`,
            releaseVersion: `main-${oldSha.slice(0, 12)}`,
          },
          {
            target: "ops",
            gitSha: oldSha,
            imageTag: `sha-${oldSha}`,
            releaseVersion: `main-${oldSha.slice(0, 12)}`,
          },
        ],
      },
      since: new Date("2026-07-16T13:05:05.000Z"),
      targets: "main-production-smoke",
      rows: [
        {
          source: "azure_monitor",
          event: "corgtex_worker_error",
          instance_id: "corgtex",
          provider: "railway",
          release_git_sha: oldSha,
          release_image_tag: `sha-${oldSha}`,
          release_version: `main-${oldSha.slice(0, 12)}`,
          surface: "worker",
          action: "tick",
          code: "WORKER_TICK_ERROR",
          events: 1,
        },
        {
          source: "railway",
          event: "corgtex_route_error",
          instance_id: "backup-app",
          provider: "railway",
          release_git_sha: currentSha,
          route: "https://app.corgtex.com/api/current-release",
          status: "500",
          events: 1,
        },
      ],
    });

    expect(summary.status).toBe("blocked");
    expect(summary.blockingFailures).toHaveLength(1);
    expect(summary.blockingFailures[0].release_git_sha).toBe(currentSha);
    expect(summary.advisoryFailures).toHaveLength(1);
    expect(summary.advisoryFailures[0].release_git_sha).toBe(oldSha);
    expect(summary.targetReleases).toEqual([
      expect.objectContaining({ target: "backup-app", currentRelease: true }),
      expect.objectContaining({ target: "ops", currentRelease: false }),
    ]);
  });

  it("parses Azure Monitor table rows into observation rows", () => {
    const rows = parseAzureMonitorRows({
      tables: [{
        columns: [
          { name: "name" },
          { name: "instance_id" },
          { name: "release_git_sha" },
          { name: "route" },
          { name: "status" },
          { name: "events" },
        ],
        rows: [[
          "corgtex_render_error",
          "selfserve",
          SHA,
          "/workspaces/1",
          "",
          1,
        ]],
      }],
    }, {
      AZURE_APPLICATIONINSIGHTS_APP_NAME: "appi-corgtex-ss-prod",
      AZURE_APPLICATIONINSIGHTS_RESOURCE_GROUP: "rg-corgtex-selfserve-production-wus3",
    });

    expect(rows[0]).toMatchObject({
      source: "azure_monitor",
      name: "corgtex_render_error",
      instance_id: "selfserve",
      release_git_sha: SHA,
      events: 1,
    });
  });

  it("queries PostHog with a read token and parses returned rows", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      columns: ["name", "instance_id", "release_git_sha", "route", "status", "events"],
      results: [[
        "corgtex_route_error",
        "tenant-a",
        SHA,
        "/api/upload",
        "500",
        1,
      ]],
    }), { status: 200 }));

    const summary = await runObservationGate({
      manifest,
      since: new Date("2026-07-16T05:52:00.000Z"),
      env: {
        POSTHOG_PROJECT_ID: "452941",
        POSTHOG_PERSONAL_API_KEY: "phx_test",
        POSTHOG_API_HOST: "https://us.i.posthog.com",
        POSTHOG_ENVIRONMENT: "production",
      },
      deps: { fetchImpl },
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://us.posthog.com/api/projects/452941/query/",
      expect.objectContaining({ method: "POST" }),
    );
    const requestBody = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(requestBody.query.query).toContain("properties['environment'] = 'production'");
    expect(requestBody.query.query).toContain("toDateTime64('2026-07-16 05:52:00.000', 3, 'UTC')");
    expect(requestBody.query.query).not.toContain("LIMIT 100");
    expect(summary.status).toBe("blocked");
  });

  it("supports PostHog-only fail-closed production observation", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      columns: ["name", "instance_id", "release_git_sha", "route", "status", "events"],
      results: [],
    }), { status: 200 }));

    const summary = await runObservationGate({
      manifest,
      since: new Date("2026-07-16T05:52:00.000Z"),
      targets: "railway-customers",
      env: {
        POSTHOG_PROJECT_ID: "452941",
        POSTHOG_PERSONAL_API_KEY: "phx_test",
        POSTHOG_API_HOST: "https://us.i.posthog.com",
        POSTHOG_ENVIRONMENT: "production",
        OBSERVATION_REQUIRE_SOURCE: "true",
      },
      deps: { fetchImpl, onSourceNote: vi.fn() },
    });

    expect(summary.status).toBe("passed");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("accepts Railway as the required source for Railway targets when PostHog query credentials are absent", async () => {
    const runCommand = vi.fn(() => JSON.stringify({
      tables: [{
        columns: [{ name: "name" }],
        rows: [],
      }],
    }));
    const fetchImpl = vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.query.includes("LatestDeployment")) {
        return new Response(JSON.stringify({
          data: {
            deployments: {
              edges: [{ node: { id: "railway-deployment-1", status: "SUCCESS", createdAt: "2026-07-16T05:50:00.000Z" } }],
            },
          },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        data: {
          httpLogs: [],
        },
      }), { status: 200 });
    });

    const summary = await runObservationGate({
      manifest,
      since: new Date("2026-07-16T05:52:00.000Z"),
      targets: "railway-customers,azure-selfserve",
      env: {
        AZURE_APPLICATIONINSIGHTS_APP_NAME: "appi-corgtex-ss-prod",
        AZURE_APPLICATIONINSIGHTS_RESOURCE_GROUP: "rg-corgtex-selfserve-production-wus3",
        OBSERVATION_ENVIRONMENT: "production",
        OBSERVATION_REQUIRE_SOURCE: "true",
        RAILWAY_API_TOKEN: "railway-token",
        FLEET_RELEASE_TARGETS_JSON: JSON.stringify([{
          id: "customer-a",
          label: "Customer A",
          provider: "railway",
          railway: {
            projectId: "project-a",
            environmentId: "environment-a",
            webServiceId: "web-a",
          },
        }]),
      },
      deps: { runCommand, fetchImpl, onSourceNote: vi.fn() },
    });

    expect(summary.status).toBe("passed");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(summary.sourceChecks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: "azure_monitor",
        status: "queried",
        rowCount: 0,
      }),
      expect.objectContaining({
        source: "railway",
        group: "railway-customers",
        status: "queried",
        rowCount: 0,
        targetCount: 1,
      }),
      expect.objectContaining({
        source: "posthog",
        status: "skipped",
      }),
    ]));
  });

  it("accepts array-form ops Railway target metadata", async () => {
    const fetchImpl = vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.query.includes("LatestDeployment")) {
        return new Response(JSON.stringify({
          data: {
            deployments: {
              edges: [{ node: { id: "ops-deployment-1", status: "SUCCESS", createdAt: "2026-07-16T05:50:00.000Z" } }],
            },
          },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: { httpLogs: [] } }), { status: 200 });
    });

    const summary = await runObservationGate({
      manifest,
      since: new Date("2026-07-16T05:52:00.000Z"),
      targets: "ops",
      env: {
        RAILWAY_API_TOKEN: "railway-token",
        FLEET_RELEASE_OPS_TARGET_JSON: JSON.stringify([{
          label: "Ops",
          provider: "railway",
          railway: {
            projectId: "project-ops",
            environmentId: "environment-ops",
            webServiceId: "web-ops",
          },
        }]),
        OBSERVATION_REQUIRE_SOURCE: "true",
      },
      deps: { fetchImpl, onSourceNote: vi.fn() },
    });

    expect(summary.status).toBe("passed");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("observes Railway selfserve without requiring Azure Monitor", async () => {
    const fetchImpl = vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.query.includes("LatestDeployment")) {
        return new Response(JSON.stringify({ data: { deployments: { edges: [{ node: { id: "selfserve-deployment", status: "SUCCESS" } }] } } }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: { httpLogs: [] } }), { status: 200 });
    });
    const summary = await runObservationGate({
      manifest,
      since: new Date("2026-07-16T05:52:00.000Z"),
      targets: "railway-selfserve",
      env: {
        RAILWAY_API_TOKEN: "railway-token",
        OBSERVATION_REQUIRE_SOURCE: "true",
        FLEET_RELEASE_AZURE_TARGET_JSON: JSON.stringify([{ id: "selfserve", provider: "railway", railway: { environmentId: "environment-selfserve", webServiceId: "web-selfserve" } }]),
      },
      deps: { fetchImpl, onSourceNote: vi.fn() },
    });
    expect(summary.status).toBe("passed");
    expect(summary.missingRequiredSources).toEqual([]);
    expect(summary.sourceChecks).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "railway", group: "railway-selfserve", targetCount: 1 }),
    ]));
  });

  it("reports missing Railway coverage for every selected Railway target group", async () => {
    const fetchImpl = vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.query.includes("LatestDeployment")) {
        return new Response(JSON.stringify({
          data: {
            deployments: {
              edges: [{ node: { id: "ops-deployment-1", status: "SUCCESS", createdAt: "2026-07-16T05:50:00.000Z" } }],
            },
          },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: { httpLogs: [] } }), { status: 200 });
    });

    const summary = await runObservationGate({
      manifest,
      since: new Date("2026-07-16T05:52:00.000Z"),
      targets: "railway-customers,ops",
      env: {
        RAILWAY_API_TOKEN: "railway-token",
        FLEET_RELEASE_OPS_TARGET_JSON: JSON.stringify([{
          label: "Ops",
          provider: "railway",
          railway: {
            projectId: "project-ops",
            environmentId: "environment-ops",
            webServiceId: "web-ops",
          },
        }]),
        OBSERVATION_REQUIRE_SOURCE: "true",
      },
      deps: { fetchImpl, onSourceNote: vi.fn() },
    });

    expect(summary.status).toBe("blocked");
    expect(summary.blockingFailures).toHaveLength(0);
    expect(summary.missingRequiredSources).toEqual(["railway-customers: railway or posthog"]);
    expect(summary.sourceChecks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: "observation_requirements",
        status: "blocked",
        reason: expect.stringContaining("railway-customers: railway or posthog"),
      }),
    ]));
  });

  it("allows PostHog to satisfy the required source when Railway errors", async () => {
    const onSourceNote = vi.fn();
    const fetchImpl = vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      if (typeof body.query === "string" && body.query.includes("LatestDeployment")) {
        return new Response(JSON.stringify({
          errors: [{ message: "Railway logs unavailable" }],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        columns: ["name", "instance_id", "release_git_sha", "route", "status", "events"],
        results: [],
      }), { status: 200 });
    });

    const summary = await runObservationGate({
      manifest,
      since: new Date("2026-07-16T05:52:00.000Z"),
      targets: "railway-customers",
      env: {
        POSTHOG_PROJECT_ID: "452941",
        POSTHOG_PERSONAL_API_KEY: "phx_test",
        RAILWAY_API_TOKEN: "railway-token",
        FLEET_RELEASE_TARGETS_JSON: JSON.stringify([{
          id: "customer-a",
          label: "Customer A",
          provider: "railway",
          railway: {
            projectId: "project-a",
            environmentId: "environment-a",
            webServiceId: "web-a",
          },
        }]),
        OBSERVATION_REQUIRE_SOURCE: "true",
      },
      deps: { fetchImpl, onSourceNote },
    });

    expect(summary.status).toBe("passed");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(onSourceNote).toHaveBeenCalledWith(expect.objectContaining({
      source: "railway",
      status: "failed",
      reason: "Railway logs unavailable",
    }));
  });

  it("reports missing Railway or PostHog when observation includes Railway targets", async () => {
    const runCommand = vi.fn(() => JSON.stringify({
      tables: [{
        columns: [{ name: "name" }],
        rows: [],
      }],
    }));

    const summary = await runObservationGate({
      manifest,
      since: new Date("2026-07-16T05:52:00.000Z"),
      targets: "railway-customers,azure-selfserve",
      env: {
        AZURE_APPLICATIONINSIGHTS_APP_NAME: "appi-corgtex-ss-prod",
        AZURE_APPLICATIONINSIGHTS_RESOURCE_GROUP: "rg-corgtex-ss-prod",
        OBSERVATION_ENVIRONMENT: "production",
        OBSERVATION_REQUIRE_SOURCE: "true",
        FLEET_RELEASE_TARGETS_JSON: JSON.stringify([{
          id: "customer-a",
          label: "Customer A",
          provider: "railway",
          railway: {
            projectId: "project-a",
            environmentId: "environment-a",
            webServiceId: "web-a",
          },
        }]),
      },
      deps: { runCommand, onSourceNote: vi.fn() },
    });

    expect(summary.status).toBe("blocked");
    expect(summary.blockingFailures).toHaveLength(0);
    expect(summary.missingRequiredSources).toEqual(["railway-customers: railway or posthog"]);
  });

  it("blocks current-release Railway HTTP 5xx logs", async () => {
    const fetchImpl = vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.query.includes("LatestDeployment")) {
        return new Response(JSON.stringify({
          data: {
            deployments: {
              edges: [{ node: { id: "railway-deployment-1", status: "SUCCESS", createdAt: "2026-07-16T05:50:00.000Z" } }],
            },
          },
        }), { status: 200 });
      }
      expect(body.variables).toMatchObject({
        deploymentId: "railway-deployment-1",
        filter: "@httpStatus:500..599",
        limit: 100,
      });
      expect(body.variables).not.toHaveProperty("beforeLimit");
      expect(body.variables).not.toHaveProperty("beforeDate");
      expect(body.query).toContain("limit: $limit");
      expect(body.query).not.toContain("beforeLimit");
      return new Response(JSON.stringify({
        data: {
          httpLogs: [{
            timestamp: "2026-07-16T05:55:00.000Z",
            path: "/api/meetings/upload",
            httpStatus: 500,
            responseDetails: "upstream_reset",
          }],
        },
      }), { status: 200 });
    });

    const summary = await runObservationGate({
      manifest,
      since: new Date("2026-07-16T05:52:00.000Z"),
      targets: "railway-customers",
      env: {
        RAILWAY_API_TOKEN: "railway-token",
        FLEET_RELEASE_TARGETS_JSON: JSON.stringify([{
          id: "customer-a",
          label: "Customer A",
          provider: "railway",
          railway: {
            projectId: "project-a",
            environmentId: "environment-a",
            webServiceId: "web-a",
          },
        }]),
        OBSERVATION_REQUIRE_SOURCE: "true",
      },
      deps: { fetchImpl, onSourceNote: vi.fn() },
    });

    expect(summary.status).toBe("blocked");
    expect(summary.blockingFailures).toHaveLength(1);
    expect(summary.blockingFailures[0]).toMatchObject({
      source: "railway",
      instance_id: "customer-a",
      release_git_sha: SHA,
      route: "/api/meetings/upload",
      status: 500,
    });
  });

  it("parses Railway HTTP 5xx logs without treating 4xx as blocking failures", () => {
    const rows = parseRailwayHttpLogRows([
      {
        timestamp: "2026-07-16T05:55:00.000Z",
        path: "/api/current",
        httpStatus: "503",
        responseDetails: "service_unavailable",
      },
      {
        timestamp: "2026-07-16T05:55:01.000Z",
        path: "/api/user-input",
        httpStatus: "409",
      },
    ], {
      target: {
        id: "ops",
        group: "ops",
      },
      deployment: { id: "railway-deployment-1" },
      manifest,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source: "railway",
      provider: "railway",
      release_git_sha: SHA,
      surface: "ops",
      route: "/api/current",
      status: 503,
      code: "service_unavailable",
    });
  });

  it("falls back to the PostHog query key when the personal key is blank", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      columns: ["name", "instance_id", "release_git_sha", "route", "status", "events"],
      results: [],
    }), { status: 200 }));

    await runObservationGate({
      manifest,
      since: new Date("2026-07-16T05:52:00.000Z"),
      targets: "railway-customers",
      env: {
        POSTHOG_PROJECT_ID: "452941",
        POSTHOG_PERSONAL_API_KEY: " ",
        POSTHOG_QUERY_API_KEY: "phx_query",
        POSTHOG_API_HOST: "https://us.i.posthog.com",
        POSTHOG_ENVIRONMENT: "production",
        OBSERVATION_REQUIRE_SOURCE: "true",
      },
      deps: { fetchImpl, onSourceNote: vi.fn() },
    });

    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe("Bearer phx_query");
  });

  it("queries Azure Monitor with the requested observation window", async () => {
    const since = new Date("2026-07-16T05:52:00.000Z");
    const until = new Date("2026-07-16T06:52:00.000Z");
    const runCommand = vi.fn(() => JSON.stringify({
      tables: [{
        columns: [{ name: "name" }],
        rows: [],
      }],
    }));

    await queryAzureMonitorRows({
      since,
      until,
      env: {
        AZURE_APPLICATIONINSIGHTS_APP_NAME: "appi-corgtex-ss-prod",
        AZURE_APPLICATIONINSIGHTS_RESOURCE_GROUP: "rg-corgtex-selfserve-production-wus3",
        OBSERVATION_ENVIRONMENT: "production",
      },
      deps: { runCommand },
    });

    const args = runCommand.mock.calls[0][1];
    expect(args).toContain("--start-time");
    expect(args[args.indexOf("--start-time") + 1]).toBe(since.toISOString());
    expect(args).toContain("--end-time");
    expect(args[args.indexOf("--end-time") + 1]).toBe(until.toISOString());
    const query = args[args.indexOf("--analytics-query") + 1];
    expect(query).toContain("customDimensions.environment");
    expect(query).toContain("production");
    expect(query).not.toContain("take 100");
  });

  it("returns a blocked summary when production requires observation sources and none are configured", async () => {
    const summary = await runObservationGate({
      manifest,
      since: new Date("2026-07-16T05:52:00.000Z"),
      env: {
        OBSERVATION_REQUIRE_SOURCE: "true",
      },
      deps: {
        onSourceNote: vi.fn(),
      },
    });

    expect(summary.status).toBe("blocked");
    expect(summary.blockerReason).toBe(
      "missing_observation_sources: azure_monitor, railway-customers: railway or posthog, ops: railway or posthog, backup-app: railway or posthog",
    );
    expect(summary.sourceChecks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: "observation_requirements",
        status: "blocked",
      }),
    ]));
  });

  it("does not fail a passing gate when advisory publishing fails", async () => {
    const summary = await runObservationGate({
      manifest,
      since: new Date("2026-07-16T05:52:00.000Z"),
      rows: [{
        source: "posthog",
        event: "corgtex_server_action_error",
        instance_id: "backup-app",
        release_git_sha: "older-sha",
        action: "saveSettings",
        code: "ACTION_FAILED",
      }],
      publishAdvisories: true,
      deps: {
        spawnSync: vi.fn(() => ({ status: 1 })),
      },
    });

    expect(summary.status).toBe("passed");
    expect(summary.advisoryPublish).toMatchObject({
      attempted: true,
      status: "failed",
    });
  });

  it("parses PostHog rows without exposing full properties blobs", () => {
    const rows = parsePostHogRows({
      columns: ["name", "instance_id", "release_git_sha", "route", "status", "events"],
      results: [[
        "corgtex_route_error",
        "tenant-a",
        SHA,
        "/api/upload",
        "500",
        1,
      ]],
    }, {
      POSTHOG_PROJECT_ID: "452941",
      POSTHOG_QUERY_API_HOST: "https://us.posthog.com",
    });

    expect(rows[0]).toEqual(expect.objectContaining({
      source: "posthog",
      source_url: "https://us.posthog.com/project/452941",
      name: "corgtex_route_error",
      events: 1,
    }));
    expect(JSON.stringify(rows[0])).not.toContain("properties");
  });
});
