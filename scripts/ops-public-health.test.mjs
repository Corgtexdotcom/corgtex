import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { OPS_HEALTH_URL, opsHealthEvidence, opsReleaseLines, queryOpsPublicHealth, readOpsPublicHealth } from "./ops-public-health.mjs";
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
        return stalledBody ? { ok: true, headers: new Headers({ "content-type": "application/json" }), json: stalled } : stalled();
      };
      await expect(queryOpsPublicHealth({ fetchImpl, timeoutMs: 10, sleepImpl: async () => {} })).rejects.toThrow("timed out");
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
    expect(observation).toContain('ops_release="$(node scripts/ops-public-health.mjs)"');
    expect(opsReleaseLines({})).toBe("\n\n");
    expect(observation).not.toContain("--publish-advisories");
    for (const filename of ["fleet-release.yml", "azure-selfserve-production.yml"]) {
      const release = readFileSync(new URL(`../.github/workflows/${filename}`, import.meta.url), "utf8");
      expect(release).not.toContain("OPS_OBSERVATION_PUBLIC_HEALTH");
    }
  });
});


describe("bounded transient Ops health retries", () => {
  it.each(["network", 408, 429, 500, 502, 503, 504])("recovers after transient %s using the same credential-free endpoint", async (failure) => {
    const fetchImpl = vi.fn().mockImplementationOnce(async () => {
      if (failure === "network") throw new TypeError("connection reset");
      return response({}, failure);
    }).mockResolvedValueOnce(response());
    const sleepImpl = vi.fn(async () => {});
    const result = await readOpsPublicHealth({ fetchImpl, sleepImpl });
    expect(result.health).toEqual(health);
    expect(result.evidence.status).toBe("queried");
    expect(sleepImpl.mock.calls).toEqual([[500]]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    for (const [url, init] of fetchImpl.mock.calls) {
      expect(url).toBe(OPS_HEALTH_URL);
      expect(init).toMatchObject({ method: "GET", redirect: "error", headers: { Accept: "application/json", "Cache-Control": "no-cache" } });
      expect(init.body).toBeUndefined();
    }
    expect(fetchImpl.mock.calls[0][1].signal).not.toBe(fetchImpl.mock.calls[1][1].signal);
  });

  it.each(["network", 503])("fails after exactly three persistent %s failures", async (failure) => {
    const fetchImpl = vi.fn(async () => {
      if (failure === "network") throw new TypeError("connection reset");
      return response({}, failure);
    });
    const sleepImpl = vi.fn(async () => {});
    await expect(queryOpsPublicHealth({ fetchImpl, sleepImpl })).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleepImpl.mock.calls).toEqual([[500], [1000]]);
  });

  it.each([
    ["HTTP 401", () => response({}, 401)],
    ["HTTP 403", () => response({}, 403)],
    ["HTTP 404", () => response({}, 404)],
    ["bad JSON", () => new Response("{", { headers: { "content-type": "application/json" } })],
    ["wrong media type", () => response(health, 200, "text/html")],
    ["unhealthy fingerprint", () => response({ ...health, database: "down" })],
    ["null payload", () => response(null)],
  ])("does not retry %s or substitute a later healthy response", async (_label, makeResponse) => {
    const fetchImpl = vi.fn().mockImplementationOnce(async () => makeResponse()).mockResolvedValueOnce(response());
    const sleepImpl = vi.fn(async () => {});
    await expect(queryOpsPublicHealth({ fetchImpl, sleepImpl })).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleepImpl).not.toHaveBeenCalled();
  });

  it("retains transient HTTP classification when failed-body cleanup rejects", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce({ ok: false, status: 503,
      body: { cancel: async () => { throw new TypeError("socket closed"); } },
    }).mockResolvedValueOnce(response());
    await expect(queryOpsPublicHealth({ fetchImpl, sleepImpl: async () => {} })).resolves.toMatchObject({ status: "queried" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("retries interrupted body transport but not JSON syntax", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce({ ok: true,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => { throw new TypeError("socket terminated"); },
    }).mockResolvedValueOnce(response());
    await expect(queryOpsPublicHealth({ fetchImpl, sleepImpl: async () => {} })).resolves.toMatchObject({ status: "queried" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("enforces the default 16.5 second worst-case budget through body consumption", async () => {
    vi.useFakeTimers();
    try {
      for (const stalledBody of [false, true]) {
        const signals = [];
        const fetchImpl = vi.fn(async (_url, { signal }) => {
          signals.push(signal);
          const stall = () => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("timed out")), { once: true }));
          return stalledBody ? { ok: true, headers: new Headers({ "content-type": "application/json" }), json: stall } : stall();
        });
        const started = Date.now();
        const result = queryOpsPublicHealth({ fetchImpl }).catch((error) => error);
        await vi.advanceTimersByTimeAsync(16_500);
        expect((await result).message).toBe("timed out");
        expect(Date.now() - started).toBe(16_500);
        expect(fetchImpl).toHaveBeenCalledTimes(3);
        expect(new Set(signals).size).toBe(3);
        expect(signals.every((signal) => signal.aborted)).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
      }
    } finally { vi.useRealTimers(); }
  });

  it("clears timers after successful recovery and reports only actual release labels", async () => {
    const result = await readOpsPublicHealth({ fetchImpl: async () => response() });
    expect(opsReleaseLines(result.health)).toBe(`${SHA}\n\n`);
    expect(opsReleaseLines({})).toBe("\n\n");
    expect(result.evidence.reason).toContain("baked runtime SHA=unproven");
  });

  it.each([true, false])("workflow metadata CLI propagates recovered=%s without manufacturing identity", (recover) => {
    const preloader = `let calls = 0; globalThis.fetch = async () => { calls++; if (${recover} && calls === 1) throw new TypeError("reset"); return new Response(JSON.stringify(${JSON.stringify(recover ? health : { ...health, database: "down" })}), {headers:{"content-type":"application/json"}}); }; process.on("exit", () => console.error("fetch calls="+calls));`;
    const preloadUrl = `data:text/javascript,${encodeURIComponent(preloader)}`;
    const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
    const assignment = workflow.match(/^\s*(ops_release="\$\(node scripts\/ops-public-health\.mjs\)")$/m)?.[1];
    expect(assignment).toBeTruthy();
    const result = spawnSync("bash", ["-e", "-c", `${assignment}\nprintf '%s' "$ops_release"`], {
      encoding: "utf8", env: { ...process.env, NODE_OPTIONS: `--import=${preloadUrl}` },
    });
    expect(result.status).toBe(recover ? 0 : 1);
    expect(result.stderr).toContain(`fetch calls=${recover ? 2 : 1}`);
    expect(result.stdout).toBe(recover ? SHA : "");
  });
});
