import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { recoveryAttribution, recoveryIntent, failedCoreSmokeJob } from "./selfserve-validation-recovery.mjs";
import { SELFSERVE_VALIDATION_TARGET as target } from "./lib/selfserve-validation-target.mjs";
import { resolveProductionValidationContext, requiresProductionAppRelease } from "./production-validation-context.mjs";

const mocks = vi.hoisted(() => ({ readFile: vi.fn() }));
vi.mock("node:fs/promises", () => ({ readFile: mocks.readFile, appendFile: vi.fn() }));
const SHA = "a".repeat(40), ACCEPTED = "b".repeat(40), repository = "Corgtexdotcom/corgtex";
const run = (name = "Production Validation") => ({ id: 123, run_attempt: 2, name,
  event: "workflow_dispatch", conclusion: "failure", head_branch: "main", head_sha: SHA,
  head_repository: { full_name: repository } });
const health = () => ({ status: "ok", service: "web", database: "up", schema: "ready", app: "corgtex", auth: "password-session",
  release: { gitSha: SHA, runtime: { gitSha: SHA, evidence: "baked" }, configured: { gitSha: SHA } } });
const workflow = (name) => parse(readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), "utf8"));

describe("fresh baked recovery proof", () => {
  const env = { GITHUB_EVENT_PATH: "event.json", GITHUB_REPOSITORY: repository, SELFSERVE_VALIDATION_ACCEPTED_SHA: ACCEPTED };
  beforeEach(() => {
    const receipt = { schemaVersion: 1, target: target.name, origin: target.origin, workspaceId: target.workspaceId,
      runId: "123", runAttempt: "2", validationKind: "explicit-release", status: "failed", liveFailure: true,
      identityVerified: true, servingSha: SHA, expectedSha: SHA };
    mocks.readFile.mockReset().mockImplementation(async (path) => JSON.stringify(path === "event.json" ? { workflow_run: run() } : receipt));
  });
  it("allows operator guidance only after a fresh valid baked response with no configured drift", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(health())));
    expect(await recoveryIntent(env, fetch)).toMatchObject({ action: "fleet-release", failedSha: SHA, release: ACCEPTED, sourceRevert: false });
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]).toEqual([`${target.origin}/api/health`, expect.objectContaining({
      cache: "no-store", redirect: "error", headers: { "cache-control": "no-cache" },
    })]);
  });
  it.each(["core", "selfserve-validation", ""])("retains immutable selfserve attribution after mode changes to %s", async (mode) => {
    expect(workflow("auto-revert").jobs["selfserve-recovery-attribution"].if).not.toContain("PRODUCTION_VALIDATION_TARGET");
    expect(await recoveryIntent({ ...env, PRODUCTION_VALIDATION_TARGET: mode },
      async () => new Response(JSON.stringify(health()))))
      .toMatchObject({ action: "fleet-release", failedSha: SHA, sourceRevert: false });
  });
  it("attributes without a live request before allowing the protected job", async () => {
    expect(await recoveryAttribution(env)).toMatchObject({ action: "fleet-release", failedSha: SHA });
    const jobs = workflow("auto-revert").jobs;
    expect(jobs["selfserve-recovery-attribution"].environment).toBeUndefined();
    expect(jobs["selfserve-recovery-attribution"].steps.at(-1).run).toContain("--attribute-only");
    expect(jobs["selfserve-fleet-recovery"].needs).toBe("selfserve-recovery-attribution");
    expect(jobs["selfserve-fleet-recovery"].if).toBe("needs.selfserve-recovery-attribution.outputs.action == 'fleet-release'");
  });
  it("manual Core without a selfserve artifact cannot request protected recovery", async () => {
    mocks.readFile.mockImplementation(async (path) => {
      if (path === "event.json") return JSON.stringify({ workflow_run: run() });
      throw Object.assign(new Error("not found"), { code: "ENOENT" });
    });
    const fetch = vi.fn();
    expect(await recoveryAttribution(env)).toEqual({ action: "none", reason: "no-selfserve-outcome" });
    expect(await recoveryIntent(env, fetch)).toMatchObject({ action: "none" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([{ target: "core" }, { runAttempt: "1" }, { liveFailure: false }, { servingSha: ACCEPTED }])("rejects unbound outcomes before protection (%j)", async (overrides) => {
    const original = mocks.readFile.getMockImplementation();
    mocks.readFile.mockImplementation(async (path) => {
      const json = JSON.parse(await original(path));
      return JSON.stringify(path === "event.json" ? json : { ...json, ...overrides });
    });
    await expect(recoveryAttribution(env)).rejects.toThrow("RECOVERY_RELEASE_NOT_ATTRIBUTED");
  });
  it.each([
    ["configured-only", (h) => { delete h.release.runtime; }],
    ["provider fallback", (h) => { h.release.runtime.evidence = "legacy-provider"; }],
    ["different runtime", (h) => { h.release.runtime.gitSha = ACCEPTED; }],
    ["configured drift", (h) => { h.release.configured.gitSha = ACCEPTED; }],
    ["reported drift", (h) => { h.release.drift = { imageTag: true }; }],
    ["bad status", (h) => { h.status = "degraded"; }],
    ["database unavailable", (h) => { h.database = "down"; }],
    ["schema mismatch", (h) => { h.schema = "mismatch"; }],
    ["wrong service", (h) => { h.service = "worker"; }],
    ["missing auth", (h) => { delete h.auth; }],
  ])("rejects %s even with matching effective release.gitSha", async (_name, mutate) => {
    const payload = health(); mutate(payload);
    await expect(recoveryIntent(env, async () => new Response(JSON.stringify(payload))))
      .rejects.toThrow("RECOVERY_SERVING_VERSION_CHANGED_OR_UNKNOWN");
  });
  it("rejects non-success HTTP status even with an otherwise valid body", async () => {
    await expect(recoveryIntent(env, async () => new Response(JSON.stringify(health()), { status: 503 })))
      .rejects.toThrow("RECOVERY_SERVING_VERSION_CHANGED_OR_UNKNOWN");
  });
});

describe("failed-run routing, not current repository mode", () => {
  const event = () => ({ workflow_run: run("CI") });
  const job = () => ({ name: "Production Smoke Test", status: "completed", conclusion: "failure", run_id: 123, run_attempt: 2, head_sha: SHA });
  it.each(["core", "selfserve-validation", ""])("preserves the failed Core attempt after mode changes to %s", (mode) => {
    expect(workflow("auto-revert").jobs.revert.if).not.toContain("vars.PRODUCTION_VALIDATION_TARGET");
    expect(failedCoreSmokeJob({ event: event(), repository, jobs: [job()], currentRepositoryMode: mode })).toBe(true);
  });
  it.each([
    [], [{ name: "Selfserve Validation / Smoke", conclusion: "failure" }],
    [job(), job()], [{ ...job(), conclusion: "skipped" }], [{ ...job(), run_attempt: 1 }],
    [{ ...job(), run_id: 122 }], [{ ...job(), head_sha: ACCEPTED }], [{ ...job(), status: "in_progress" }],
  ].map((jobs) => [jobs]))("never selects absent, selfserve, ambiguous or differently bound jobs (%#)", (jobs) => {
    expect(failedCoreSmokeJob({ event: event(), repository, jobs })).toBe(false);
  });
  it("requires the exact triggering attempt API, not latest jobs or a fuzzy smoke name", () => {
    const step = workflow("auto-revert").jobs.revert.steps.find((s) => s.id === "check");
    expect(step.env.RUN_ATTEMPT).toBe("${{ github.event.workflow_run.run_attempt }}");
    expect(step.run).toContain("/runs/$RUN_ID/attempts/$RUN_ATTEMPT/jobs?per_page=100");
    expect(step.run).toContain("--paginate --slurp");
    expect(step.run).toContain("--core-smoke-failure");
    expect(step.run).not.toContain("grep -qi");
  });
  it("runs the real CLI on paginated immutable jobs after the repository mode switches", () => {
    const directory = mkdtempSync(join(tmpdir(), "selfserve-core-recovery-test-"));
    try {
      const eventPath = join(directory, "event.json"), outputPath = join(directory, "output");
      writeFileSync(eventPath, JSON.stringify(event()));
      execFileSync(process.execPath, [fileURLToPath(new URL("./selfserve-validation-recovery.mjs", import.meta.url)), "--core-smoke-failure"], {
        input: JSON.stringify([{ jobs: [{ ...job(), name: "Unrelated Smoke" }] }, { jobs: [job()] }]),
        env: { GITHUB_REPOSITORY: repository, GITHUB_EVENT_PATH: eventPath, GITHUB_OUTPUT: outputPath,
          PRODUCTION_VALIDATION_TARGET: "selfserve-validation" }, encoding: "utf8",
      });
      expect(readFileSync(outputPath, "utf8")).toBe("trigger=true\n");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it("does not schedule protected recovery for failed CI, schedules, or non-explicit validation", () => {
    const gate = workflow("auto-revert").jobs["selfserve-recovery-attribution"].if;
    expect(gate).toContain("github.event.workflow_run.name == 'Production Validation' &&");
    expect(gate).toContain("&& github.event.workflow_run.event == 'workflow_dispatch' &&");
    expect(gate).toContain("&& github.event.workflow_run.conclusion == 'failure' &&");
    expect(gate).not.toContain("||");
  });
});

describe("target-aware manual URL default", () => {
  const context = (targetInput, baseUrlInput) => resolveProductionValidationContext({ eventName: "workflow_dispatch", event: {},
    githubRef: "refs/heads/main", githubRepository: repository, githubSha: SHA, expectedGitShaInput: SHA,
    targetInput, baseUrlInput });
  it("dispatches with an empty optional input so each target supplies its own origin", () => {
    const input = workflow("production-validation").on.workflow_dispatch.inputs.base_url;
    expect(input.default).toBe("");
    expect(input.required).toBe(false);
    expect(context("core", input.default).base_url).toBe("https://app.corgtex.com");
    expect(context("selfserve-validation", input.default).base_url).toBe(target.origin);
  });
  it("keeps explicit wrong origins fail-closed", () => {
    expect(() => context("selfserve-validation", "https://app.corgtex.com")).toThrow("ORIGIN_MISMATCH");
    expect(() => context("core", target.origin)).toThrow("must be exactly");
  });
  it("keeps these review tests classified as runner-only", () => {
    expect(requiresProductionAppRelease(["scripts/selfserve-validation-recovery.test.mjs"])).toBe(false);
  });
});
