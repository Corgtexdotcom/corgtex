import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { OPS_HEALTH_URL, opsHealthEvidence, queryOpsPublicHealth } from "./ops-public-health.mjs";
import { runObservationGate } from "./post-deploy-observation-gate.mjs";

const SHA = "a".repeat(40);
const health = {
  status: "ok", service: "web", database: "up", schema: "ready",
  app: "corgtex", auth: "password-session",
  release: { gitSha: SHA, configured: { gitSha: SHA }, runtime: { gitSha: null, source: "missing" } },
};
const response = (payload = health, status = 200, contentType = "application/json; charset=utf-8") =>
  new Response(JSON.stringify(payload), { status, headers: { "content-type": contentType } });

const options = (fetchImpl, env = {}) => ({
  targets: "azure-selfserve,ops", manifest: { gitSha: "b".repeat(40) },
  since: new Date("2026-11-04T00:00:00Z"),
  env: { OPS_OBSERVATION_PUBLIC_HEALTH: "true", OBSERVATION_REQUIRE_SOURCE: "true",
    AZURE_APPLICATIONINSIGHTS_APP_NAME: "test", AZURE_APPLICATIONINSIGHTS_RESOURCE_GROUP: "test", ...env },
  deps: { fetchImpl, runCommand: () => JSON.stringify({ tables: [{ columns: [], rows: [] }] }) },
});

describe("main Ops public health observation", () => {
  it.each([undefined, "dead-token"])("uses one credential-free GET with token=%s and stale Railway metadata", async (token) => {
    const fetchImpl = vi.fn(async (url, init) => {
      expect(url).toBe(OPS_HEALTH_URL);
      expect(init.method).toBe("GET");
      expect(init.redirect).toBe("error");
      expect(init.headers).toEqual({ Accept: "application/json", "Cache-Control": "no-cache" });
      expect(init.body).toBeUndefined();
      return response();
    });
    const summary = await runObservationGate(options(fetchImpl, {
      RAILWAY_API_TOKEN: token,
      FLEET_RELEASE_OPS_TARGET_JSON: "malformed unused provider metadata",
    }));
    expect(summary.status).toBe("passed");
    expect(summary.missingRequiredSources).toEqual([]);
    expect(summary.sourceChecks).toContainEqual(expect.objectContaining({ source: "ops_health", status: "queried",
      reason: expect.stringContaining("baked runtime SHA=unproven") }));
    expect(summary.advisoryPublish).toEqual({ attempted: false, status: "skipped" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("checks an Ops-only selection without falling back to default Railway targets", async () => {
    const fetchImpl = vi.fn(async () => response());
    const summary = await runObservationGate({ ...options(fetchImpl, { RAILWAY_API_TOKEN: "dead-token" }), targets: "ops" });
    expect(summary.status).toBe("passed");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["HTTP failure", () => response(health, 503)],
    ["database down", () => response({ ...health, database: "down" })],
    ["schema unready", () => response({ ...health, schema: "unready" })],
    ["wrong application", () => response({ ...health, app: "other" })],
    ["null JSON", () => response(null)],
    ["empty JSON", () => response({})],
    ["array JSON", () => response([])],
    ["HTML", () => new Response("<html>ok</html>", { headers: { "content-type": "text/html" } })],
    ["missing media type", () => new Response(JSON.stringify(health))],
    ["malformed JSON", () => new Response("{", { headers: { "content-type": "application/json" } })],
    ["network failure", () => { throw new Error("network unavailable"); }],
  ])("fails closed on %s even when PostHog is configured", async (_name, makeResponse) => {
    await expect(runObservationGate(options(async () => makeResponse(), {
      POSTHOG_PROJECT_ID: "test", POSTHOG_PERSONAL_API_KEY: "test",
    }))).rejects.toThrow();
  });

  it("bounds a stalled fetch and body read with the same abort signal", async () => {
    for (const stalledBody of [false, true]) {
      const fetchImpl = async (_url, { signal }) => {
        const stalled = () => new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("timed out")), { once: true });
        });
        return stalledBody ? { headers: new Headers({ "content-type": "application/json" }), json: stalled } : stalled();
      };
      await expect(queryOpsPublicHealth({ fetchImpl, timeoutMs: 10 })).rejects.toThrow("timed out");
    }
  });

  it("distinguishes configured, legacy and baked identity without requiring a deployment", () => {
    expect(opsHealthEvidence({ ok: true }, health).reason).toContain(`configured SHA=${SHA}; baked runtime SHA=unproven`);
    expect(opsHealthEvidence({ ok: true }, { ...health, release: undefined }).reason).toContain("configured SHA=missing; baked runtime SHA=unproven");
    for (const evidence of [undefined, "legacy_provider", "baked"]) {
      const result = opsHealthEvidence({ ok: true }, { ...health,
        release: { ...health.release, runtime: { gitSha: SHA, evidence } } });
      expect(result.reason).toContain(`baked runtime SHA=${evidence === "baked" ? SHA : "unproven"}`);
    }
  });

  it("does not permit public health as exact deployment evidence", async () => {
    const fetchImpl = vi.fn();
    await expect(runObservationGate(options(fetchImpl, { FLEET_RELEASE_TARGET_ID: "ops-release" })))
      .rejects.toThrow("cannot prove an exact deployment");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("retains the mandatory Azure source and checks only selected Ops", async () => {
    const config = options(async () => response());
    delete config.env.AZURE_APPLICATIONINSIGHTS_APP_NAME;
    const summary = await runObservationGate(config);
    expect(summary.status).toBe("blocked");
    expect(summary.missingRequiredSources).toEqual(["azure_monitor"]);
    const fetchImpl = vi.fn();
    await runObservationGate({ ...options(fetchImpl), targets: "azure-selfserve" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("opts in only main CI, removes Railway credentials, and propagates initial health failures", () => {
    const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
    const observation = workflow.slice(workflow.indexOf("  observe-prod:"));
    expect(observation).toContain('OPS_OBSERVATION_PUBLIC_HEALTH: "true"');
    expect(observation).not.toMatch(/RAILWAY_API_TOKEN|FLEET_RELEASE_OPS_TARGET_JSON|FLEET_RELEASE_TARGETS_JSON/);
    expect(observation).toContain('ops_release="$(read_health_release "https://ops.corgtex.com/api/health")"');
    expect(observation).toContain('console.log(health?.release?.gitSha ?? "")');
    expect(observation).not.toContain("--publish-advisories");
    for (const filename of ["fleet-release.yml", "azure-selfserve-production.yml"]) {
      const release = readFileSync(new URL(`../.github/workflows/${filename}`, import.meta.url), "utf8");
      expect(release).not.toContain("OPS_OBSERVATION_PUBLIC_HEALTH");
    }
  });
});
