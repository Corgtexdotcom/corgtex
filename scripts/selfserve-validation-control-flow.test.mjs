import { spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { parse } from "yaml";
import { validationRunTarget, selfserveReadRequestAllowed, SELFSERVE_VALIDATION_TARGET as target } from "./lib/selfserve-validation-target.mjs";
import { navigationFailureKind } from "./selfserve-validation-navigation.mjs";
import { buildObservationSummary } from "./post-deploy-observation-gate.mjs";

const ci = parse(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"));
const validation = parse(readFileSync(new URL("../.github/workflows/production-validation.yml", import.meta.url), "utf8"));
const SHA = "b".repeat(40), SOURCE = "a".repeat(40);
const health = () => ({ status: "ok", service: "web", database: "up", schema: "ready", app: "corgtex", auth: "password-session",
  release: { gitSha: SHA, configured: { gitSha: SHA }, runtime: { gitSha: SHA, evidence: "baked" } } });

describe("one pinned target through the entire automatic validation chain", () => {
  it("passes the pinned selection into the reusable context and checks its returned target", () => {
    expect(ci.jobs["smoke-selfserve"].with.validation_target).toBe("${{ needs.smoke-target.outputs.target }}");
    expect(validation.on.workflow_call.inputs.validation_target.required).toBe(true);
    expect(validation.on.workflow_call.outputs.target.value).toBe("${{ jobs.validation-context.outputs.target }}");
    expect(ci.jobs["smoke-mode-gate"].steps[0].env.TARGET).toBe("${{ needs.smoke-target.outputs.target }}");
    expect(ci.jobs["observe-prod"].env.PRODUCTION_VALIDATION_TARGET).toBe("${{ needs.smoke-mode-gate.outputs.selected_target }}");
    expect(ci.jobs["smoke-mode-gate"].outputs.selected_target).toBe("${{ steps.mode.outputs.selected_target }}");
    expect(validationRunTarget({ eventName: "push", pinnedTarget: target.name, configuredTarget: "core" })).toBe(target.name);
    expect(() => validationRunTarget({ eventName: "push", configuredTarget: target.name })).toThrow("PINNED_TARGET_REQUIRED");
    expect(validationRunTarget({ eventName: "workflow_dispatch", configuredTarget: "core" })).toBe("core");
  });
  it.each([
    ["core", "success", "skipped", "", "", 0],
    [target.name, "skipped", "success", "true", target.name, 0],
    [target.name, "success", "success", "true", target.name, 1],
    [target.name, "skipped", "success", "true", "core", 1],
    [target.name, "skipped", "success", "true", "", 1],
    ["", "success", "skipped", "", "", 1],
    ["core", "skipped", "success", "true", target.name, 1],
  ])("executes the gate for %s/%s/%s (bound result %s/%s)", (mode, core, selfserve, proof, returned, status) => {
    const directory = mkdtempSync(join(tmpdir(), "validation-mode-"));
    try {
      const output = join(directory, "output");
      const result = spawnSync("bash", ["-c", ci.jobs["smoke-mode-gate"].steps[0].run], { encoding: "utf8", env: {
        PATH: process.env.PATH, TARGET: mode, CORE_RESULT: core, SELFSERVE_RESULT: selfserve,
        SELFSERVE_PROOF: proof, SELFSERVE_TARGET: returned, GITHUB_OUTPUT: output,
      } });
      expect(result.status).toBe(status);
      if (status === 0) expect(readFileSync(output, "utf8")).toBe(`selected_target=${mode}\n`);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it("shares the exact non-cancelling parity lock with Core", () => {
    const core = Object.values(validation.jobs).find((job) => job.concurrency?.group === "production-validation-work-item-parity-corgtex-validation" && job !== validation.jobs["selfserve-parity"]);
    expect(core).toBeTruthy();
    expect(validation.jobs["selfserve-parity"].concurrency).toEqual(core.concurrency);
    expect(core.concurrency["cancel-in-progress"]).toBe(false);
  });
});

describe("executed observation shell requires fresh baked health before manifest", () => {
  const script = ci.jobs["observe-prod"].steps.find((step) => step.name === "Run post-deploy observation gate").run;
  function observe(payload, mode = target.name, httpFailure = false) {
    // Only network/provider boundaries are stubbed. Run the actual shell, Node
    // health validator and manifest; never invoke curl or an observation provider.
    return spawnSync("bash", ["-c", `
      curl() { printf "%s" "$HEALTH"; ${httpFailure ? "return 22" : "return 0"}; }
      node() {
        if [[ "$1" == "scripts/post-deploy-observation-gate.mjs" ]]; then printf "%s\\n" "$@";
        else command node "$@"; fi
      }
      ${script}`], { encoding: "utf8", env: { PATH: process.env.PATH, HEALTH: JSON.stringify(payload),
      PRODUCTION_VALIDATION_TARGET: mode, SELFSERVE_VALIDATION_EXPECTED_SHA: SHA, ACCEPTED_CORE_BASELINE: "false",
      GITHUB_SHA: SOURCE, OBSERVATION_SINCE: "2026-09-16T00:00:00Z" } });
  }
  it("observes accepted baked runtime, not undeployed source, after the fresh health read", () => {
    expect(script).toContain('curl_args+=(-H "Cache-Control: no-cache")');
    const result = observe(health());
    expect(result.status, result.stderr).toBe(0);
    const manifest = JSON.parse(result.stdout.split("\n").find((line) => line.startsWith('{"gitSha"')));
    expect(manifest.gitSha).toBe(SHA);
    const summary = buildObservationSummary({ manifest, targets: "azure-selfserve,ops", since: new Date(), rows: [SHA, SOURCE].map((sha) => ({
      source: "azure_monitor", provider: "azure", instance_id: "azure-selfserve", event: "corgtex_route_error", status: "500", release_git_sha: sha,
    })) });
    expect(summary.blockingFailures.map((row) => row.release_git_sha)).toEqual([SHA]);
    expect(summary.advisoryFailures.map((row) => row.release_git_sha)).toEqual([SOURCE]);
  });
  it.each([
    ["configured-only", (h) => { delete h.release.runtime; }],
    ["provider fallback", (h) => { h.release.runtime.evidence = "legacy-provider"; }],
    ["runtime replaced", (h) => { h.release.runtime.gitSha = SOURCE; }],
    ["configured drift", (h) => { h.release.configured.gitSha = SOURCE; }],
    ["reported drift", (h) => { h.release.drift = { version: true }; }],
    ["unhealthy", (h) => { h.database = "down"; }],
  ])("stops before observation for %s", (_name, mutate) => {
    const payload = health(); mutate(payload);
    const result = observe(payload);
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("--manifest-json");
  });
  it("fails transport before observation and preserves Core legacy health semantics", () => {
    expect(observe(health(), target.name, true).status).not.toBe(0);
    const payload = health(); delete payload.release.runtime;
    const core = observe(payload, "core");
    expect(core.status, core.stderr).toBe(0);
    expect(core.stdout).toContain(`"gitSha":"${SOURCE}"`);
  });
});

describe("hydration assets and conservative navigation failure attribution", () => {
  // Public asset paths retained from runtime-4's synthetic briefing HTML.
  it.each(["layout-d21f42df678e56f4", "error-336738149b9676d3", "page-32a2abc36e398153"])("allows the retained encoded Next %s chunk", (file) => {
    const url = `${target.origin}/_next/static/chunks/app/%5Blocale%5D/workspaces/%5BworkspaceId%5D/${file}.js?dpl=1fe0d6f4b362cb5a9989e6bd98d58d8d0e41316e`;
    expect(selfserveReadRequestAllowed(url)).toBe(true);
    expect(selfserveReadRequestAllowed(url, "HEAD")).toBe(true);
    expect(selfserveReadRequestAllowed(url, "POST")).toBe(false);
    expect(selfserveReadRequestAllowed(url.replace(target.origin, "https://other.invalid"))).toBe(false);
  });
  it("retains both page and API cross-workspace denial", () => {
    for (const path of ["/en/workspaces/other", "/api/workspaces/other/support-access",
      "/_next/static/chunks%2f..%2f..%2f..%2fapi/workspaces/other"]) {
      expect(selfserveReadRequestAllowed(`${target.origin}${path}`)).toBe(false);
    }
  });
  it.each([false, true])("executes the navigation wrapper with fresh report=%s; stale or capture-only failure stays unattributed", (fresh) => {
    const directory = mkdtempSync(join(tmpdir(), "validation-navigation-"));
    const route = `/workspaces/${target.workspaceId}/meetings`;
    const row = { name: "desktop-meetings", route, status: 500 };
    const report = { baseUrl: target.origin, routeResults: [row], findings: [{ ...row, route: `${target.origin}/en${route}` }] };
    try {
      const script = `
        import { mkdirSync, writeFileSync } from "node:fs";
        import { runSelfserveNavigation } from ${JSON.stringify(new URL("./selfserve-validation-navigation.mjs", import.meta.url).href)};
        mkdirSync(".artifacts/selfserve-validation/navigation", { recursive: true });
        writeFileSync(".artifacts/selfserve-validation/live.receipt.json", JSON.stringify({ status: "passed", identityVerified: true }));
        const reportPath = ".artifacts/selfserve-validation/navigation/qa-results.json";
        const report = ${JSON.stringify(report)};
        writeFileSync(reportPath, JSON.stringify(report));
        await runSelfserveNavigation(() => {
          if (${fresh}) writeFileSync(reportPath, JSON.stringify(report));
          throw new Error("Network.getResponseBody no data");
        });
      `;
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: directory, encoding: "utf8", env: {} });
      expect(result.status).toBe(1);
      const receipt = JSON.parse(readFileSync(join(directory, ".artifacts/selfserve-validation/live.receipt.json"), "utf8"));
      expect(receipt.navigationPassed).toBe(false);
      expect(receipt.failureKind).toBe(fresh ? "confirmed-route" : "infrastructure-unattributed");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it("requires matching confirmed HTTP findings, not browser timeout/body capture/console failures", () => {
    const route = `/workspaces/${target.workspaceId}/meetings`;
    const row = { name: "desktop-meetings", route, status: 500 };
    const report = { baseUrl: target.origin, routeResults: [row], findings: [{ ...row, route: `${target.origin}/en${route}` }] };
    expect(navigationFailureKind(report)).toBe("confirmed-route");
    for (const value of [null, {}, { ...report, baseUrl: "https://other.invalid" }, { ...report, routeResults: [] },
      { ...report, findings: [{ ...report.findings[0], status: "navigation-failed", error: "Network.getResponseBody no data" }] },
      { ...report, findings: [], consoleErrors: ["timeout"] }]) {
      expect(navigationFailureKind(value)).toBe("infrastructure-unattributed");
    }
  });
});
