import { readFileSync } from "node:fs";
import { mkdtemp, writeFile, rm, stat, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { parse } from "yaml";
import {
  SELFSERVE_VALIDATION_TARGET as target, SELFSERVE_REQUIRED_EVIDENCE, assertSelfserveSession,
  assertSelfserveEvidence, validationTarget, selfserveExpectedRelease, selfserveReadRequestAllowed,
  selfserveRecoveryAttribution,
} from "./lib/selfserve-validation-target.mjs";
import { openSelfserveValidationSession } from "./selfserve-validation-smoke.mjs";
import { resolveProductionValidationContext, requiresProductionAppRelease } from "./production-validation-context.mjs";
import { isolatedInputs, requireFullIsolatedMatrix, stageIsolatedImages, ghcrPreparationInputs, withGhcrReadAuth, runIsolatedValidation } from "./selfserve-validation-isolated.mjs";
import { selfserveOutcome } from "./selfserve-validation-outcome.mjs";
import { schemaAuditConnection, schemaAuditPrismaConnection, AUDITOR_PRIVILEGES_SQL } from "./selfserve-validation-schema.mjs";
import { databaseIdentity } from "./accepted-core-baseline.mjs";
import { SelfserveParitySmoke, parityRequestAllowed } from "./selfserve-validation-parity.mjs";

const SHA = "a".repeat(40), MAIN = "b".repeat(40);
const session = () => ({ actor: { kind: "user", user: { id: target.ownerUserId, globalRole: "USER" } },
  workspaces: [{ id: target.workspaceId, slug: target.workspaceSlug }] });
const health = () => ({ status: "ok", service: "web", database: "up", schema: "ready", app: "corgtex", auth: "password-session",
  release: { gitSha: SHA, runtime: { gitSha: SHA, evidence: "baked" }, configured: { gitSha: SHA } } });
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
function transport(overrides = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const path = new URL(url).pathname;
    calls.push({ path, method: init.method || "GET", redirect: init.redirect });
    if (overrides[path]) return overrides[path](init);
    if (path === "/api/health") return json(health());
    if (path === "/login") return new Response("Welcome to Corgtex");
    if (path === "/api/auth/login") return json({}, 200, { "set-cookie": "synthetic-session=fake; HttpOnly; Secure" });
    if (path === "/api/auth/logout") return json({});
    if (path === "/api/session") return json(session());
    if (path.endsWith("/support-access")) return json([]);
    if (path === "/") return new Response(null, { status: 307, headers: { location: `/en/workspaces/${target.workspaceId}` } });
    if (path === `/en/workspaces/${target.workspaceId}`) return new Response("Synthetic workspace");
    throw new Error("Unexpected request");
  };
  return { calls, fetchImpl };
}
const loginOptions = { origin: target.origin, expectedSha: SHA, email: "synthetic@example.invalid", password: "synthetic-only" };

describe("closed selfserve target HTTP integration (in-memory transport, no live calls)", () => {
  it("reuses health/login/session/owner/root navigation and logs out without tenant writes", async () => {
    const t = transport();
    const authenticated = await openSelfserveValidationSession({ ...loginOptions, ...t });
    expect(authenticated).toMatchObject({ identityVerified: true, servingSha: SHA });
    await authenticated.close();
    expect(t.calls.map((item) => item.path)).toEqual(["/api/health", "/login", "/api/auth/login", "/api/session",
      `/api/workspaces/${target.workspaceId}/support-access`, "/", `/en/workspaces/${target.workspaceId}`, "/api/auth/logout"]);
    expect(t.calls.filter((item) => item.method !== "GET").map((item) => item.path)).toEqual(["/api/auth/login", "/api/auth/logout"]);
    expect(t.calls.every((item) => item.redirect === "manual")).toBe(true);
  });
  it.each(["https://app.corgtex.com", `${target.origin}/`, `https://user@selfserve.corgtex.com`, "http://selfserve.corgtex.com"])
    ("rejects wrong origin %s before login", async (origin) => {
      const t = transport();
      await expect(openSelfserveValidationSession({ ...loginOptions, ...t, origin })).rejects.toThrow("ORIGIN_MISMATCH");
      expect(t.calls).toHaveLength(0);
    });
  it.each(["", "a".repeat(7), "0".repeat(40), MAIN])("rejects missing, abbreviated or wrong SHA %s before authentication", async (expectedSha) => {
    const t = transport();
    await expect(openSelfserveValidationSession({ ...loginOptions, ...t, expectedSha })).rejects.toThrow();
    expect(t.calls.some((item) => item.path === "/api/auth/login")).toBe(false);
  });
  it.each([
    (s) => { s.actor.user.id = "different-user"; },
    (s) => { s.actor.user.globalRole = "OPERATOR"; },
    (s) => { s.actor.kind = "agent"; },
    (s) => { s.workspaces.push({ id: "other", slug: "other" }); },
    (s) => { s.workspaces[0].id = "other"; },
    (s) => { s.workspaces[0].slug = "other"; },
  ])("rejects wrong identity/workspace before tenant navigation and revokes its session", async (mutate) => {
    const value = session(); mutate(value);
    const t = transport({ "/api/session": () => json(value) });
    await expect(openSelfserveValidationSession({ ...loginOptions, ...t })).rejects.toThrow(/MISMATCH/);
    expect(t.calls.at(-1).path).toBe("/api/auth/logout");
    expect(t.calls.some((item) => item.path.includes("/workspaces/") || item.path === "/")).toBe(false);
  });
  it("requires active HUMAN ADMIN owner proof from the normal support GET", async () => {
    const t = transport({ [`/api/workspaces/${target.workspaceId}/support-access`]: () => json({}, 403) });
    await expect(openSelfserveValidationSession({ ...loginOptions, ...t })).rejects.toThrow("OWNER_MISMATCH");
    expect(t.calls.some((item) => item.path === "/")).toBe(false);
  });
  it("never forwards a session to an external redirect", async () => {
    const t = transport({ "/": () => new Response(null, { status: 307, headers: { location: "https://example.invalid" } }) });
    await expect(openSelfserveValidationSession({ ...loginOptions, ...t })).rejects.toThrow("REDIRECT_FORBIDDEN");
    expect(t.calls.at(-1).path).toBe("/api/auth/logout");
  });
  it("retains identity/version attribution when the subsequent root render fails", async () => {
    const t = transport({ "/": () => new Response("synthetic render failure", { status: 500 }) });
    const proofs = [];
    await expect(openSelfserveValidationSession({ ...loginOptions, ...t, onVerified: (proof) => proofs.push(proof) })).rejects.toThrow("PAGE_FAILED");
    expect(proofs).toEqual([{ servingSha: SHA, identityVerified: true }]);
    expect(t.calls.at(-1).path).toBe("/api/auth/logout");
  });
  it("rejects configured-only health identity and release drift", async () => {
    for (const mutation of [(h) => { delete h.release.runtime; }, (h) => { h.release.configured.gitSha = MAIN; }]) {
      const payload = health(); mutation(payload);
      const t = transport({ "/api/health": () => json(payload) });
      await expect(openSelfserveValidationSession({ ...loginOptions, ...t })).rejects.toThrow("SHA_MISMATCH");
      expect(t.calls).toHaveLength(1);
    }
  });
  it("has no ADMIN credential fallback", async () => {
    const t = transport();
    await expect(openSelfserveValidationSession({ ...loginOptions, ...t, email: "", password: "" })).rejects.toThrow("DEDICATED_CREDENTIALS");
    expect(t.calls).toHaveLength(0);
  });
  it("browser transport denies external calls, workspace changes and mutations", () => {
    expect(selfserveReadRequestAllowed(`${target.origin}/en/workspaces/${target.workspaceId}`)).toBe(true);
    for (const [url, method] of [["https://app.corgtex.com/", "GET"], [`${target.origin}/api/workspaces/other`, "GET"],
      [`${target.origin}/api/conversations`, "POST"], [`${target.origin}/bad%zz`, "GET"]]) {
      expect(selfserveReadRequestAllowed(url, method)).toBe(false);
    }
    expect(() => assertSelfserveSession(session())).not.toThrow();
  });
});

describe("mode, accepted release and required artifacts", () => {
  const context = (overrides = {}) => resolveProductionValidationContext({ eventName: "push", event: {}, githubRef: "refs/heads/main",
    githubRepository: "Corgtexdotcom/corgtex", githubSha: MAIN, targetInput: target.name, acceptedSelfserveSha: SHA, ...overrides });
  it("leaves absent configuration on Core and rejects unknown targets", () => {
    expect(validationTarget()).toBe("core");
    expect(() => validationTarget("selfserve")).toThrow("UNKNOWN");
  });
  it("does not demand unrelated Core promotion for runner-only validation changes", () => {
    const files = [".github/workflows/ci.yml", ".github/workflows/production-validation.yml", ".github/workflows/auto-revert.yml",
      "scripts/ci-production-boundary.test.mjs", "scripts/production-validation-context.mjs", "scripts/client-readiness-smoke.mjs",
      "scripts/work-item-parity-production-smoke.mjs", "scripts/lib/selfserve-validation-target.mjs",
      ...["fixture", "isolated", "navigation", "outcome", "parity", "recovery", "schema", "smoke"].map((name) => `scripts/selfserve-validation-${name}.mjs`),
      "scripts/selfserve-validation.test.mjs"];
    expect(requiresProductionAppRelease(files)).toBe(false);
    expect(requiresProductionAppRelease([...files, "apps/web/app/api/health/route.ts"])).toBe(true);
  });
  it("main pushes prove accepted serving, never undeployed main", () => {
    expect(context()).toMatchObject({ expected_git_sha: SHA, base_url: target.origin, validation_mode: "accepted-serving",
      crm_smoke: "false", source_intake_smoke: "false", briefing_fixture_smoke: "false", work_item_parity_smoke: "false", recorder_readiness_smoke: "false" });
    expect(() => context({ acceptedSelfserveSha: "" })).toThrow("SHA_REQUIRED");
  });
  it("requires an explicit exact version on manual release validation", () => {
    expect(() => context({ eventName: "workflow_dispatch" })).toThrow("SHA_REQUIRED");
    expect(context({ eventName: "workflow_dispatch", expectedGitShaInput: MAIN }).expected_git_sha).toBe(MAIN);
    expect(selfserveExpectedRelease({ eventName: "push", expectedSha: MAIN, acceptedSha: SHA })).toBe(SHA);
  });
  it("rejects untrusted refs/repositories and a Core origin in selfserve mode", () => {
    for (const overrides of [{ githubRef: "refs/heads/feature" }, { githubRepository: "fork/repo" }, { baseUrlInput: "https://app.corgtex.com" }]) {
      expect(() => context(overrides)).toThrow();
    }
  });
  it("does not auto-enable model mutations, parity or external recorders", () => {
    expect(context({ selfserveParityInput: "true" }).selfserve_parity_smoke).toBe("false");
    expect(context({ eventName: "workflow_dispatch", expectedGitShaInput: SHA, selfserveParityInput: "true" }).selfserve_parity_smoke).toBe("true");
    expect(() => context({ selfserveCrmInput: "true" })).toThrow("fixed synthetic account");
    expect(context().recorder_readiness_smoke).toBe("false");
  });
  const receipts = () => SELFSERVE_REQUIRED_EVIDENCE.map((lane) => ({ schemaVersion: 1, lane, target: target.name,
    gitSha: SHA, runId: "123", runAttempt: "2", scope: lane.endsWith("-isolated") ? "isolated-synthetic" : "live-read-only",
    status: "passed", cleanup: "completed", navigationPassed: true, identityVerified: true, servingSha: SHA,
    origin: target.origin, workspaceId: target.workspaceId, ownerUserId: target.ownerUserId,
    exactLedgerMatch: true, supportedSchemaMatch: true, manifestSha256: "c".repeat(64), datamodelSha256: "d".repeat(64),
    catalogAlgorithm: "SELFSERVE_PUBLIC_PG16_V1", expectedCatalogSha256: "e".repeat(64), actualCatalogSha256: "e".repeat(64) }));
  const binding = { expectedSha: SHA, runId: "123", runAttempt: "2" };
  it("requires every named live/schema/isolated artifact, not any one passing matrix", () => {
    expect(() => assertSelfserveEvidence(receipts(), binding)).not.toThrow();
    for (let index = 0; index < 4; index++) expect(() => assertSelfserveEvidence(receipts().filter((_, i) => i !== index), binding)).toThrow("MISSING");
    expect(() => assertSelfserveEvidence([...receipts(), receipts()[0]], binding)).toThrow("DUPLICATE");
  });
  it.each(["gitSha", "runId", "runAttempt", "scope", "status", "cleanup"])("rejects stale/wrong %s in otherwise good evidence", (key) => {
    const data = receipts(); data[2][key] = "wrong";
    expect(() => assertSelfserveEvidence(data, binding)).toThrow();
  });
  it("does not accept a missing navigation check", () => {
    const data = receipts(); delete data[0].navigationPassed;
    expect(() => assertSelfserveEvidence(data, binding)).toThrow("NAVIGATION");
  });
  it("does not accept weak schema proof or another named identity in a passing artifact", () => {
    for (const [index, key, value] of [[1, "actualCatalogSha256", "f".repeat(64)], [1, "catalogAlgorithm", undefined], [1, "exactLedgerMatch", false], [1, "manifestSha256", ""], [0, "ownerUserId", "other"], [0, "origin", "https://app.corgtex.com"]]) {
      const data = receipts(); data[index][key] = value;
      expect(() => assertSelfserveEvidence(data, binding)).toThrow();
    }
  });
});

describe("release recovery attribution", () => {
  const event = () => ({ workflow_run: { id: 123, run_attempt: 2, name: "Production Validation", event: "workflow_dispatch",
    conclusion: "failure", head_branch: "main", head_repository: { full_name: "Corgtexdotcom/corgtex" } } });
  const receipt = () => ({ schemaVersion: 1, target: target.name, origin: target.origin, workspaceId: target.workspaceId,
    runId: "123", runAttempt: "2", validationKind: "explicit-release", status: "failed", liveFailure: true,
    identityVerified: true, servingSha: MAIN, expectedSha: MAIN });
  const input = () => ({ event: event(), receipt: receipt(), acceptedSha: SHA, repository: "Corgtexdotcom/corgtex" });
  it("routes only the attributed failed target to existing fleet recovery", () => {
    expect(selfserveRecoveryAttribution(input())).toEqual({ action: "fleet-release", target: "azure-selfserve", failedSha: MAIN, release: SHA, sourceRevert: false });
  });
  it("never source-reverts or deploys for undeployed CI failure", () => {
    const value = input(); value.event.workflow_run.name = "CI"; value.receipt = null;
    expect(selfserveRecoveryAttribution(value).action).toBe("none");
  });
  it.each([
    (v) => { v.event.workflow_run.event = "schedule"; },
    (v) => { v.event.workflow_run.head_branch = "feature"; },
    (v) => { v.event.workflow_run.head_repository.full_name = "fork/repo"; },
    (v) => { v.receipt.runAttempt = "1"; },
    (v) => { v.receipt.origin = "https://app.corgtex.com"; },
    (v) => { v.receipt.identityVerified = false; },
    (v) => { v.receipt.servingSha = SHA; },
    (v) => { v.receipt.liveFailure = false; },
    (v) => { v.acceptedSha = MAIN; },
  ])("refuses untrusted, unattributed or non-live failures", (mutate) => {
    const value = input(); mutate(value);
    expect(() => selfserveRecoveryAttribution(value)).toThrow();
  });
});

describe("outcome attribution binding", () => {
  const live = () => ({ schemaVersion: 1, lane: "selfserve-live-read-only", target: target.name,
    origin: target.origin, workspaceId: target.workspaceId, ownerUserId: target.ownerUserId,
    gitSha: MAIN, runId: "123", runAttempt: "2", scope: "live-read-only", status: "failed",
    identityVerified: true, servingSha: MAIN, cleanup: "completed", failureKind: "confirmed-route" });
  async function outcome(receipts) {
    const directory = await mkdtemp(join(tmpdir(), "selfserve-outcome-test-"));
    try {
      for (const [index, receipt] of receipts.entries()) await writeFile(join(directory, `${index}.receipt.json`), JSON.stringify(receipt));
      return await selfserveOutcome({ SELFSERVE_VALIDATION_COLLECTED_DIR: directory, SELFSERVE_VALIDATION_OUT_DIR: directory,
        SELFSERVE_VALIDATION_EXPECTED_SHA: MAIN, GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "2",
        GITHUB_EVENT_NAME: "workflow_dispatch", SELFSERVE_LIVE_RESULT: "failure", SELFSERVE_ISOLATED_RESULT: "success" });
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
  it.each(["schemaVersion", "target", "origin", "workspaceId", "ownerUserId", "gitSha", "runId", "runAttempt", "scope"])
    ("never promotes a failed receipt with wrong %s into this run", async (key) => {
      const report = await outcome([{ ...live(), [key]: "wrong" }]);
      expect(report.status).toBe("failed");
      expect(report.identityVerified).toBe(false);
      expect(report.servingSha).toBeUndefined();
      expect(report.liveFailure).toBe(false);
    });
  it("rejects duplicate live evidence even when only one receipt binds to this attempt", async () => {
    for (const duplicate of [live(), { ...live(), runAttempt: "1" }]) {
      const report = await outcome([live(), duplicate]);
      expect(report.identityVerified).toBe(false);
      expect(report.servingSha).toBeUndefined();
      expect(report.liveFailure).toBe(false);
    }
  });
  it("preserves a unique bound failed live lane for operator recovery, without requiring passed status", async () => {
    const report = await outcome([live()]);
    expect(report).toMatchObject({ status: "failed", identityVerified: true, servingSha: MAIN, liveFailure: true,
      expectedSha: MAIN, runId: "123", runAttempt: "2", validationKind: "explicit-release" });
    expect(selfserveRecoveryAttribution({ repository: "Corgtexdotcom/corgtex", acceptedSha: SHA, receipt: report,
      event: { workflow_run: { id: 123, run_attempt: 2, name: "Production Validation", event: "workflow_dispatch",
        conclusion: "failure", head_branch: "main", head_repository: { full_name: "Corgtexdotcom/corgtex" } } } }).action).toBe("fleet-release");
  });
  it.each([undefined, "infrastructure-unattributed", "timeout", "tooling"])("never attributes harness failure %s to the live release", async (failureKind) => {
    expect(await outcome([{ ...live(), failureKind }])).toMatchObject({ liveFailure: false, failureKind: "infrastructure-unattributed" });
  });
});

describe("workflow and fixture secret isolation", () => {
  const workflow = (name) => parse(readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), "utf8"));
  const ci = workflow("ci"), validation = workflow("production-validation"), recovery = workflow("auto-revert");
  it("preserves Core job identity/defaults and keeps new mode opt-in", () => {
    expect(ci.jobs["smoke-prod"].name).toBe("Production Smoke Test");
    expect(ci.jobs["smoke-prod"].if).toContain("needs.smoke-target.outputs.target == 'core'");
    expect(ci.jobs["smoke-selfserve"].if).toContain("needs.smoke-target.outputs.target == 'selfserve-validation'");
    expect(recovery.jobs.revert.if).not.toContain("vars.PRODUCTION_VALIDATION_TARGET");
  });
  it("exposes only dedicated credentials to reusable selfserve validation, no broad DB/ADMIN fallback", () => {
    expect(Object.keys(ci.jobs["smoke-selfserve"].secrets).sort()).toEqual(["SELFSERVE_SCHEMA_AUDITOR_URL", "SELFSERVE_VALIDATION_EMAIL", "SELFSERVE_VALIDATION_PASSWORD"]);
    const live = JSON.stringify(validation.jobs["selfserve-live"]);
    expect(live).not.toMatch(/secrets\.(?:ADMIN_|PRODUCTION_DATABASE_URL|PRODUCTION_VALIDATION_ADMIN_)/);
    expect(live).toContain("selfserve-validation-schema.mjs");
    expect(live).toContain("selfserve-validation-navigation.mjs");
  });
  it("isolated full helpers have no production environment or credentials and cannot share their DB with live", () => {
    const isolated = validation.jobs["selfserve-isolated"];
    expect(isolated.environment).toBeUndefined();
    expect(JSON.stringify(isolated).match(/secrets\.[A-Za-z_]+/g)).toEqual(["secrets.GITHUB_TOKEN"]);
    expect(isolated.permissions).toEqual({ contents: "read", packages: "read" });
    expect(ci.jobs["smoke-selfserve"].permissions.packages).toBe("read");
    expect(isolated.env.SELFSERVE_IMAGE_READ_TOKEN).toBeUndefined();
    const tokenSteps = isolated.steps.filter((step) => step.env?.SELFSERVE_IMAGE_READ_TOKEN);
    expect(tokenSteps).toHaveLength(1);
    expect(tokenSteps[0].run).toContain("--prepare");
    const runner = readFileSync(new URL("./selfserve-validation-isolated.mjs", import.meta.url), "utf8");
    for (const fragment of ["--internal", "--pull=never", "--cpus=1", "--memory=1g", "source-intake-production-smoke.mjs", "briefing-fixture-production-smoke.mjs", "ISOLATED_CLEANUP_FAILED"]) expect(runner).toContain(fragment);
    expect(runner).not.toMatch(/--publish|--network=host/);
  });
  it.each([
    ["selfserve-validation-browser.mjs", {}, "ISOLATED_TLS_PIN_REQUIRED"],
    ["selfserve-validation-browser.mjs", { SELFSERVE_ISOLATED_FIXTURE: "true", SELFSERVE_ISOLATED_TLS_SPKI: "invalid" }, "ISOLATED_TLS_PIN_REQUIRED"],
    ["selfserve-validation-relay.mjs", {}, "ISOLATED_FIXTURE_REQUIRED"],
  ])("refuses unguarded fixture TLS adapter %s", (script, env, error) => {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL(script, import.meta.url))], { env, encoding: "utf8", timeout: 5000 });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(error);
  });
  it("pins browser trust to the ephemeral key and blocks non-fixture requests without changing assertions", () => {
    const adapter = readFileSync(new URL("./selfserve-validation-browser.mjs", import.meta.url), "utf8");
    expect(adapter).toContain("--ignore-certificate-errors-spki-list=${pin}");
    expect(adapter).not.toContain("ignoreHTTPSErrors");
    expect(adapter).toContain('origin === "https://fixture-web:3443"');
    expect(adapter).toContain('route.abort("blockedbyclient")');
    const fixture = readFileSync(new URL("./selfserve-validation-fixture.mjs", import.meta.url), "utf8");
    expect(fixture).toContain('from "../packages/domain/src/onboarding.ts"');
    expect(fixture).not.toContain('tourVersion: "v2"');
  });
  it("requires outcome uploads and the selected complete job, while preserving Ops observation", () => {
    expect(validation.jobs["selfserve-outcome"].needs).toEqual(["validation-context", "selfserve-live", "selfserve-isolated", "selfserve-parity"]);
    expect(validation.jobs["selfserve-outcome"].steps.at(-1).with["if-no-files-found"]).toBe("error");
    expect(ci.jobs["smoke-mode-gate"].steps[0].run).toContain('test "$SELFSERVE_PROOF" = true');
    const observation = JSON.stringify(ci.jobs["observe-prod"]);
    expect(observation).toContain("observation_targets=azure-selfserve,ops");
    expect(observation).toContain("observation_targets=backup-app,azure-selfserve,ops");
  });
  it("uses existing protected fleet workflow, not a source revert or direct provider update", () => {
    const job = JSON.stringify(recovery.jobs["selfserve-fleet-recovery"]);
    expect(job).toContain("fleet-release.yml");
    expect(job).toContain("-f targets=selfserve");
    expect(job).not.toMatch(/git revert|az containerapp|RAILWAY_API_TOKEN/);
  });
  it("requires exact cached images and refuses a leaked production credential", () => {
    const env = { SELFSERVE_VALIDATION_EXPECTED_SHA: SHA, ...Object.fromEntries(["WEB", "PG", "BROWSER"].map((key) => [`SELFSERVE_ISOLATED_${key}_IMAGE`, `example.invalid/test@sha256:${"c".repeat(64)}`])) };
    expect(isolatedInputs(env).expectedSha).toBe(SHA);
    expect(() => isolatedInputs({ ...env, SELFSERVE_ISOLATED_WEB_IMAGE: "web:latest" })).toThrow("IMMUTABLE");
    expect(() => isolatedInputs({ ...env, DATABASE_URL: "not-allowed" })).toThrow("CREDENTIALS_FORBIDDEN");
  });
  it("stages immutable images before the runtime step on fresh hosted runners", () => {
    const steps = validation.jobs["selfserve-isolated"].steps;
    const prepare = steps.findIndex((step) => step.run?.endsWith("selfserve-validation-isolated.mjs --prepare"));
    const runtime = steps.findIndex((step) => step.run?.endsWith("selfserve-validation-isolated.mjs"));
    expect(prepare).toBeGreaterThan(-1);
    expect(runtime).toBeGreaterThan(prepare);
    expect(steps[prepare]["timeout-minutes"]).toBe(10);
    expect(steps[runtime]["timeout-minutes"]).toBe(30);
  });
  const stagingEnv = { SELFSERVE_VALIDATION_EXPECTED_SHA: SHA,
    ...Object.fromEntries(["WEB", "PG", "BROWSER"].map((role) =>
      [`SELFSERVE_ISOLATED_${role}_IMAGE`, `example.invalid/${role.toLowerCase()}@sha256:${"c".repeat(64)}`])) };
  it("reuses cached images without any pull, container or network creation", () => {
    const calls = [];
    const result = stageIsolatedImages(stagingEnv, (command, args) => { calls.push([command, ...args]); return "cached"; });
    expect(result.images.every((image) => image.cached)).toBe(true);
    expect(result.runtimeStarted).toBe(false);
    expect(calls).toHaveLength(3);
    expect(calls.every((call) => call[1] === "image" && call[2] === "inspect")).toBe(true);
  });
  it("pulls missing exact digests once and verifies each staged image", () => {
    const cached = new Set(), pulls = [];
    const result = stageIsolatedImages(stagingEnv, (_command, args, options) => {
      expect(options.timeout).toBeLessThanOrEqual(8 * 60_000);
      if (args[0] === "pull") { pulls.push(args[1]); cached.add(args[1]); return ""; }
      if (!cached.has(args[2])) throw new Error("missing");
      return "cached";
    });
    expect(pulls).toEqual(result.images.map((image) => image.image));
    expect(result.images.every((image) => !image.cached)).toBe(true);
  });
  it.each([
    ["authentication required sensitive text", "AUTH_REQUIRED"],
    ["no matching manifest", "PLATFORM_UNAVAILABLE"],
    ["connection refused", "PULL_FAILED"],
  ])("fails preparation without retry or login: %s", (stderr, category) => {
    let pulls = 0;
    expect(() => stageIsolatedImages(stagingEnv, (_command, args) => {
      if (args[0] === "pull") { pulls++; throw Object.assign(new Error("private"), { stderr }); }
      throw new Error("missing");
    })).toThrow(`ISOLATED_PREPARATION_WEB_${category}`);
    expect(pulls).toBe(1);
  });
  it("does not start a pull after the preparation deadline", () => {
    let clock = 0;
    expect(() => stageIsolatedImages(stagingEnv, () => { throw new Error("missing"); }, () => clock++ * 9 * 60_000))
      .toThrow("ISOLATED_PREPARATION_DEADLINE");
  });
  const ghcrEnv = { ...stagingEnv, GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "Corgtexdotcom/corgtex",
    SELFSERVE_ISOLATED_WEB_IMAGE: `ghcr.io/corgtexdotcom/corgtex/web@sha256:${"c".repeat(64)}`,
    SELFSERVE_ISOLATED_BROWSER_IMAGE: `mcr.microsoft.com/playwright@sha256:${"d".repeat(64)}`,
    SELFSERVE_ISOLATED_PG_IMAGE: `pgvector/pgvector@sha256:${"e".repeat(64)}`,
    SELFSERVE_IMAGE_READ_ACTOR: "Corgtex-builder", SELFSERVE_IMAGE_READ_TOKEN: "synthetic-read-token",
    GITHUB_TOKEN: "synthetic-ambient-token", DOCKER_CONFIG: "/untouched-default-config" };
  it("allows only the canonical repo and pinned web/public dependency images before GHCR authentication", () => {
    expect(() => ghcrPreparationInputs(ghcrEnv)).not.toThrow();
    for (const changes of [{ GITHUB_REPOSITORY: "fork/repo" }, { SELFSERVE_IMAGE_READ_TOKEN: "" },
      { SELFSERVE_ISOLATED_WEB_IMAGE: ghcrEnv.SELFSERVE_ISOLATED_WEB_IMAGE.replace("/corgtex/web", "/other/web") },
      { SELFSERVE_ISOLATED_BROWSER_IMAGE: ghcrEnv.SELFSERVE_ISOLATED_WEB_IMAGE }]) {
      expect(() => ghcrPreparationInputs({ ...ghcrEnv, ...changes })).toThrow("ISOLATED_GHCR_");
    }
  });
  it("passes the short-lived token only to login stdin and removes 0700 Docker auth after staging", async () => {
    const calls = [];
    let directory;
    const receipt = await withGhcrReadAuth(ghcrEnv, async (command) => {
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
      return stageIsolatedImages(ghcrEnv, command);
    }, (binary, args, options) => {
      calls.push({ binary, args, options });
      directory = options.env.DOCKER_CONFIG;
      expect(directory).not.toBe(ghcrEnv.DOCKER_CONFIG);
      expect(options.env.SELFSERVE_IMAGE_READ_TOKEN).toBeUndefined();
      expect(options.env.GITHUB_TOKEN).toBeUndefined();
      expect(args.join(" ")).not.toContain(ghcrEnv.SELFSERVE_IMAGE_READ_TOKEN);
      return "cached";
    });
    expect(calls[0].args).toEqual(["login", "ghcr.io", "--username", "Corgtex-builder", "--password-stdin"]);
    expect(calls[0].options.input).toBe("synthetic-read-token\n");
    expect(calls.slice(1).every((call) => call.options.input === undefined)).toBe(true);
    expect(receipt.status).toBe("staged");
    await expect(access(directory)).rejects.toMatchObject({ code: "ENOENT" });
    expect(ghcrEnv.DOCKER_CONFIG).toBe("/untouched-default-config");
  });
  it.each(["login", "pull"])("removes ephemeral auth on %s failure without retry or credential output", async (failure) => {
    let directory, loginCount = 0;
    const pending = withGhcrReadAuth(ghcrEnv, () => { throw new Error("ISOLATED_PREPARATION_WEB_AUTH_REQUIRED"); }, (_binary, args, options) => {
      directory = options.env.DOCKER_CONFIG;
      if (args[0] === "login") loginCount++;
      if (failure === "login") throw new Error("synthetic-read-token private diagnostic");
    });
    await expect(pending).rejects.toThrow(failure === "login" ? "ISOLATED_GHCR_AUTH_REQUIRED" : "ISOLATED_PREPARATION_WEB_AUTH_REQUIRED");
    expect(loginCount).toBe(1);
    await expect(access(directory)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it.each(["SELFSERVE_IMAGE_READ_TOKEN", "GITHUB_TOKEN", "GH_TOKEN"])("refuses leaked registry token %s before any fixture runtime", async (key) => {
    await expect(runIsolatedValidation({ [key]: "synthetic" })).rejects.toThrow("ISOLATED_REGISTRY_TOKEN_FORBIDDEN");
  });
  it("requires the full isolated helper's passing matrix, never not-applicable or an empty receipt", () => {
    const script = "source-intake-production-smoke.mjs";
    const matrix = (result) => [{ filePath: "synthetic.matrix.json", run: { metadata: { script: "source-intake-production-smoke" },
      runId: "synthetic", status: result, results: [{ result, method: "source-intake-production-smoke" }], cleanupActions: [], blockers: [] } }];
    expect(() => requireFullIsolatedMatrix(matrix("pass"), script)).not.toThrow();
    for (const result of ["not production-applicable", "partial", "blocked"]) {
      expect(() => requireFullIsolatedMatrix(matrix(result), script)).toThrow("FULL_MATRIX_REQUIRED");
    }
    const empty = matrix("pass"); empty[0].run.results = [];
    expect(() => requireFullIsolatedMatrix(empty, script)).toThrow("FULL_MATRIX_REQUIRED");
  });
  it("requires verified TLS, a pinned database, and a non-writer schema auditor", () => {
    const url = "postgresql://auditor:synthetic@db.example.invalid/fixture?sslmode=verify-full";
    const env = { SELFSERVE_SCHEMA_AUDITOR_URL: url, SELFSERVE_DATABASE_IDENTITY_SHA256: databaseIdentity(url) };
    expect(schemaAuditConnection(env).searchParams.get("options")).toContain("default_transaction_read_only=on");
    expect(() => schemaAuditConnection({ ...env, DATABASE_URL: url })).toThrow("WRITER_ENV");
    expect(() => schemaAuditConnection({ ...env, SELFSERVE_SCHEMA_AUDITOR_URL: url.replace("verify-full", "require") })).toThrow("TLS");
    expect(() => schemaAuditConnection({ ...env, SELFSERVE_DATABASE_IDENTITY_SHA256: "a".repeat(64) })).toThrow("IDENTITY");
    expect(() => schemaAuditConnection({ ...env, SELFSERVE_SCHEMA_AUDITOR_URL: `${url}&sslmode=disable` })).toThrow("DUPLICATE");
    const prismaUrl = schemaAuditPrismaConnection(schemaAuditConnection(env));
    expect(prismaUrl.searchParams.get("sslmode")).toBe("require");
    expect(prismaUrl.searchParams.get("sslaccept")).toBe("strict");
    expect(AUDITOR_PRIVILEGES_SQL).toContain("pg_has_role");
    expect(AUDITOR_PRIVILEGES_SQL).toContain("INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER");
  });
  it("rejects column-only INSERT/UPDATE without treating column SELECT as a write", () => {
    expect(AUDITOR_PRIVILEGES_SQL).toContain("OR has_any_column_privilege(r.oid, c.oid, 'INSERT,UPDATE')");
    expect(AUDITOR_PRIVILEGES_SQL).not.toMatch(/has_any_column_privilege\([^)]*SELECT/);
  });
  it("checks sequence writes and ownership for reachable roles across non-system schemas, not SELECT", () => {
    expect(AUDITOR_PRIVILEGES_SQL).toContain("pg_has_role(current_user, r.oid, 'MEMBER')");
    expect(AUDITOR_PRIVILEGES_SQL).toContain("left(n.nspname, 3) <> 'pg_' AND n.nspname <> 'information_schema' AND c.relkind = 'S'");
    expect(AUDITOR_PRIVILEGES_SQL).toContain("left(n.nspname, 3) <> 'pg_' AND n.nspname <> 'information_schema' AND c.relkind IN");
    expect(AUDITOR_PRIVILEGES_SQL).not.toContain("NOT LIKE 'pg_%'");
    expect(AUDITOR_PRIVILEGES_SQL).toContain("c.relowner = r.oid OR has_sequence_privilege(r.oid, c.oid, 'USAGE,UPDATE')");
    expect(AUDITOR_PRIVILEGES_SQL).not.toMatch(/has_sequence_privilege\([^)]*SELECT/);
  });
});

describe("explicit internal-only parity guard", () => {
  const env = { GITHUB_EVENT_NAME: "workflow_dispatch", SELFSERVE_PARITY_ENABLED: "true", SELFSERVE_VALIDATION_EXPECTED_SHA: SHA,
    SELFSERVE_VALIDATION_EMAIL: "synthetic@example.invalid", SELFSERVE_VALIDATION_PASSWORD: "synthetic-only" };
  it("requires explicit dispatch, not an inherited legacy default", () => {
    expect(() => new SelfserveParitySmoke({ ...env, GITHUB_EVENT_NAME: "push" })).toThrow("EXPLICIT_DISPATCH");
    expect(() => new SelfserveParitySmoke({ ...env, SELFSERVE_PARITY_ENABLED: "false" })).toThrow("EXPLICIT_DISPATCH");
  });
  it("uses the named owner preflight before any token issuance", async () => {
    const wrong = session(); wrong.actor.user.id = "wrong";
    const t = transport({ "/api/session": () => json(wrong) });
    const smoke = new SelfserveParitySmoke(env, t.fetchImpl);
    await expect(smoke.login()).rejects.toThrow("IDENTITY_MISMATCH");
    expect(smoke.credentialId).toBeNull();
    expect(t.calls.at(-1).path).toBe("/api/auth/logout");
  });
  it("limits REST writes to internal work items and scoped credential issuance/revocation", () => {
    const prefix = `${target.origin}/api/workspaces/${target.workspaceId}`;
    expect(parityRequestAllowed(`${prefix}/actions`, { method: "POST" })).toBe(true);
    expect(parityRequestAllowed(`${prefix}/agent-credentials/token-id/revoke`, { method: "POST" })).toBe(true);
    for (const path of ["members", "members/user-id", "support-access", "webhooks", "settings", "crm/accounts"]) {
      expect(parityRequestAllowed(`${prefix}/${path}`, { method: "POST" })).toBe(false);
    }
    expect(parityRequestAllowed(`${target.origin}/api/workspaces/other/actions`, { method: "POST" })).toBe(false);
  });
});
