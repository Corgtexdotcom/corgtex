import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  buildObservationSummary,
  normalizeObservationTargets,
  observationTargetsForRow,
  parseAzureMonitorRows,
  parsePostHogRows,
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

  it("fails closed when production requires observation sources and none are configured", async () => {
    await expect(runObservationGate({
      manifest,
      since: new Date("2026-07-16T05:52:00.000Z"),
      env: {
        OBSERVATION_REQUIRE_SOURCE: "true",
      },
      deps: {
        onSourceNote: vi.fn(),
      },
    })).rejects.toThrow("No observation query source configured");
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
