import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { inspectAcceptedRecoveryImage, reserveGithubDeployment, trustedRecoveryContext, recoveryTls, assertRecoveryControlPlane, waitForRecoveredWeb, DEPLOY_STEP } from "./core-recovery-runner.mjs";

describe("accepted recovery registry identity", () => {
  const root = `sha256:${"a".repeat(64)}`;
  const child = `sha256:${"b".repeat(64)}`;
  const descriptor = digest => ({ digest, platform: { os: "linux", architecture: "amd64" } });
  function fixture(index = true) {
    const manifest = { ...(index ? { schemaVersion: 2 } : {}), digest: root, size: 900,
      mediaType: index ? "application/vnd.oci.image.index.v1+json" : "application/vnd.oci.image.manifest.v1+json",
      ...(index ? { manifests: [descriptor(child)] } : {}) };
    const platforms = [{ Descriptor: descriptor(index ? child : root) }];
    return { manifest, platforms, execute: vi.fn(args => JSON.stringify(args[0] === "buildx" ? manifest : platforms)) };
  }
  it("keeps an accepted image index distinct from its amd64 platform digest", () => {
    const x = fixture();
    expect(inspectAcceptedRecoveryImage("web", root, x.execute)).toMatchObject({
      image: `ghcr.io/corgtexdotcom/corgtex/web@${root}`, acceptedDigest: root, platformManifestDigest: child,
    });
    expect(x.execute.mock.calls.every(([args]) => args.at(-1) === `ghcr.io/corgtexdotcom/corgtex/web@${root}`)).toBe(true);
  });
  it("accepts a single amd64 manifest only when root and platform digests agree", () => {
    const x = fixture(false);
    expect(inspectAcceptedRecoveryImage("worker", root, x.execute).platformManifestDigest).toBe(root);
    x.platforms[0].Descriptor.digest = child;
    expect(() => inspectAcceptedRecoveryImage("worker", root, x.execute)).toThrow("MANIFEST_PLATFORM");
  });
  it("rejects a wrong root even if its platform is correct", () => {
    const x = fixture(); x.manifest.digest = child;
    expect(() => inspectAcceptedRecoveryImage("web", root, x.execute)).toThrow("BASELINE_REGISTRY_DIGEST");
  });
  it("rejects an ambiguous or mismatched index child", () => {
    const x = fixture(); x.manifest.manifests.push(descriptor(child));
    expect(() => inspectAcceptedRecoveryImage("web", root, x.execute)).toThrow("INDEX_PLATFORM");
    x.manifest.manifests = [descriptor(root)];
    expect(() => inspectAcceptedRecoveryImage("web", root, x.execute)).toThrow("INDEX_PLATFORM");
    x.platforms[0].Descriptor.platform.architecture = "arm64";
    expect(() => inspectAcceptedRecoveryImage("web", root, x.execute)).toThrow("REGISTRY_PLATFORM");
  });
  it("does not expose registry errors or accept arbitrary roles and references", () => {
    const execute = vi.fn(() => { throw new Error("private registry credential detail"); });
    expect(() => inspectAcceptedRecoveryImage("web", root, execute)).toThrow("CORE_RECOVERY_REGISTRY_READ_UNVERIFIED");
    expect(() => inspectAcceptedRecoveryImage("other", root, execute)).toThrow("REGISTRY_BINDING");
    expect(() => inspectAcceptedRecoveryImage("web", "tag", execute)).toThrow("REGISTRY_BINDING");
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

const REPO = "Corgtexdotcom/corgtex";
const env = { GITHUB_REPOSITORY: REPO, GITHUB_REF: "refs/heads/main", GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_WORKFLOW_REF: `${REPO}/.github/workflows/core-recovery.yml@refs/heads/main`, GITHUB_SHA: "a".repeat(40),
  GITHUB_RUN_ID: "20", GITHUB_RUN_ATTEMPT: "1" };
const intent = { failedRunId: 36757068293, sourceSha: "d".repeat(40), stagedStateSha256: "e".repeat(64) };
const run = (id = 20) => ({ id, run_attempt: 1, path: ".github/workflows/core-recovery.yml", head_branch: "main",
  head_sha: env.GITHUB_SHA, event: "workflow_dispatch", repository: { full_name: REPO }, head_repository: { full_name: REPO } });
const jobs = (id = 20, conclusion = null) => ({ total_count: 1, jobs: [{ name: "Recover existing Core", run_id: id, run_attempt: 1,
  steps: [{ name: DEPLOY_STEP, status: id === 20 ? "in_progress" : "completed", conclusion, started_at: "2026-09-30T19:00:00Z" }] }] });
function apiFor(runs, records) {
  return vi.fn(async path => path.includes("/runs?") ? { total_count: runs.length, workflow_runs: runs } : records[path.match(/runs\/(\d+)\//)[1]]);
}

describe("protected Core recovery admission", () => {
  it.each(["pull_request", "push", "workflow_run"])("rejects %s credentialed execution", event => {
    expect(() => trustedRecoveryContext({ ...env, GITHUB_EVENT_NAME: event })).toThrow("PROTECTED_MAIN_REQUIRED");
  });
  it("rejects a branch or repository substitution", () => {
    expect(() => trustedRecoveryContext({ ...env, GITHUB_REF: "refs/heads/test" })).toThrow();
    expect(() => trustedRecoveryContext({ ...env, GITHUB_REPOSITORY: "other/fork" })).toThrow();
  });
  it("uses the persisted current job step as a durable once-per-incident barrier", async () => {
    const api = apiFor([run()], { 20: jobs() });
    expect(await reserveGithubDeployment(intent, { env, api })).toEqual({ reserved: true, intent, githubRunId: 20, githubRunAttempt: 1 });
  });
  it.each(["failure", "success", "cancelled", null])("rejects a previous started submission even with conclusion %s", async conclusion => {
    const api = apiFor([run(), run(19)], { 20: jobs(), 19: jobs(19, conclusion) });
    await expect(reserveGithubDeployment(intent, { env, api })).rejects.toThrow("PRIOR_DEPLOYMENT_RECONCILIATION_REQUIRED");
  });
  it("rejects a workflow rerun before consulting provider or history", async () => {
    const api = vi.fn();
    await expect(reserveGithubDeployment(intent, { env: { ...env, GITHUB_RUN_ATTEMPT: "2" }, api })).rejects.toThrow("RECONCILIATION_REQUIRED");
    expect(api).not.toHaveBeenCalled();
  });
  it("allows earlier dry runs whose deploy step was skipped", async () => {
    expect((await reserveGithubDeployment(intent, { env,
      api: apiFor([run(), run(19)], { 20: jobs(), 19: jobs(19, "skipped") }) })).reserved).toBe(true);
  });
  it("does not infer a durable reservation from missing current job metadata", async () => {
    await expect(reserveGithubDeployment(intent, { env, api: apiFor([], {}) })).rejects.toThrow("DURABLE_INTENT_NOT_VISIBLE");
  });
  it("rejects incomplete or untrusted history", async () => {
    await expect(reserveGithubDeployment(intent, { env, api: async () => ({ total_count: 101, workflow_runs: [] }) })).rejects.toThrow("HISTORY_UNBOUNDED");
    const foreign = run(); foreign.head_repository.full_name = "other/fork";
    await expect(reserveGithubDeployment(intent, { env, api: apiFor([foreign], {}) })).rejects.toThrow("HISTORY_UNTRUSTED");
  });
  it("requires unchanged INTERNAL Core classification and no other lease", () => {
    const target = { origin: "https://app.corgtex.com", projectId: "p", environmentId: "e", webServiceId: "w", workerServiceId: "k" };
    const request = { controlPlaneDeploymentId: "core" };
    const configured = { provider: "railway", url: target.origin, railway: target };
    const body = { deployments: [{ id: "core", url: target.origin, cloudProvider: "RAILWAY", deploymentKind: "INTERNAL", environment: "internal" }] };
    expect(() => assertRecoveryControlPlane(body, request, target, configured)).not.toThrow();
    body.deployments.push({ id: "other", releaseLeaseId: "owned" });
    expect(() => assertRecoveryControlPlane(body, request, target, configured)).toThrow("RELEASE_LEASE_PRESENT");
    body.deployments.pop(); body.deployments[0].deploymentKind = "SHARED_WORKSPACE";
    expect(() => assertRecoveryControlPlane(body, request, target, configured)).toThrow("CORE_CLASSIFICATION");
  });
  it("uses a public pinned CA, leaf hash, and independent localhost identity verification", async () => {
    const request = JSON.parse(await readFile(".github/core-recovery-incident.json", "utf8"));
    const options = recoveryTls(request);
    expect(options.rejectUnauthorized).toBe(true);
    expect(options.ca).not.toContain("PRIVATE KEY");
    expect(options.checkServerIdentity("proxy.example", { raw: Buffer.from("wrong-leaf") }).message).toContain("LEAF_BINDING");
    const bytes = Buffer.from("fixture-leaf");
    request.sourceTls.leafSha256 = createHash("sha256").update(bytes).digest("hex");
    const pinned = recoveryTls(request);
    expect(pinned.checkServerIdentity("proxy.example", { raw: bytes, subject: { CN: "unrelated.example" } }).code).toBe("ERR_TLS_CERT_ALTNAME_INVALID");
    request.sourceTls.caSha256 = "0".repeat(64);
    expect(() => recoveryTls(request)).toThrow("CA_BINDING");
  });
  it("keeps credentials out of install steps and shares protected Fleet exclusion", async () => {
    const workflow = await readFile(".github/workflows/core-recovery.yml", "utf8");
    expect(workflow).toContain("group: fleet-release");
    expect(workflow).toContain("environment: fleet-release-production");
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).toContain(`- name: ${DEPLOY_STEP}`);
    expect(workflow).toContain("default: true");
    const install = workflow.slice(workflow.indexOf("# Dependency installation"), workflow.indexOf("- name: Authenticate"));
    expect(install).not.toContain("secrets.");
    expect(workflow).not.toContain("migrate deploy");
    expect(workflow).not.toContain("db push");
  });
});


describe("recovered provider and application readiness", () => {
  const runtime = { sourceSha: "a".repeat(40), target: { origin: "https://app.corgtex.com" },
    images: { web: { deploymentId: "00000000-0000-0000-0000-000000000001", digest: `sha256:${"b".repeat(64)}` } } };
  const settings = { CORGTEX_RELEASE_GIT_SHA: runtime.sourceSha, CORGTEX_RELEASE_IMAGE_TAG: `sha-${runtime.sourceSha}`, CORGTEX_RELEASE_VERSION: "main-aaaaaaaaaaaa" };
  const deployment = () => ({ deployment: { id: runtime.images.web.deploymentId, status: "SUCCESS", meta: { imageDigest: runtime.images.web.digest } } });
  const health = () => ({ database: "up", schema: "ready", release: { gitSha: runtime.sourceSha,
    imageTag: settings.CORGTEX_RELEASE_IMAGE_TAG, version: settings.CORGTEX_RELEASE_VERSION,
    drift: { gitSha: false, imageTag: false, version: false } } });
  function clock() { let time = 0; return { now: () => time, sleep: vi.fn(async ms => { time += ms; }) }; }

  it("waits through provider SUCCESS and transient public502 until application readiness", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce({ ok: false, status: 502 })
      .mockResolvedValueOnce({ ok: true, json: async () => health() });
    const query = vi.fn(async () => deployment()); const time = clock();
    await waitForRecoveredWeb(runtime, settings, { query, fetchImpl, ...time });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(query).toHaveBeenCalledTimes(2);
    expect(time.sleep).toHaveBeenCalledTimes(1);
  });
  it("waits for schema readiness within the same bounded window", async () => {
    const pending = health(); pending.schema = "not_ready";
    const fetchImpl = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => pending })
      .mockResolvedValueOnce({ ok: true, json: async () => health() });
    await waitForRecoveredWeb(runtime, settings, { query: async () => deployment(), fetchImpl, ...clock() });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it("rejects a terminal provider failure immediately", async () => {
    const failed = deployment(); failed.deployment.status = "CRASHED"; const fetchImpl = vi.fn();
    await expect(waitForRecoveredWeb(runtime, settings, { query: async () => failed, fetchImpl, ...clock() })).rejects.toThrow("RECOVERED_DEPLOYMENT_FAILED");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("rejects wrong provider digest without accepting apparently healthy release metadata", async () => {
    const wrong = deployment(); wrong.deployment.meta.imageDigest = `sha256:${"c".repeat(64)}`; const fetchImpl = vi.fn();
    await expect(waitForRecoveredWeb(runtime, settings, { query: async () => wrong, fetchImpl, ...clock() })).rejects.toThrow("RECOVERED_DIGEST");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("rejects public release drift without retrying it as startup", async () => {
    const wrong = health(); wrong.release.gitSha = "c".repeat(40); const time = clock();
    await expect(waitForRecoveredWeb(runtime, settings, { query: async () => deployment(), fetchImpl: async () => ({ ok: true, json: async () => wrong }), ...time })).rejects.toThrow("RECOVERED_HEALTH_IDENTITY");
    expect(time.sleep).not.toHaveBeenCalled();
  });
  it("does not turn a permanently unavailable application into success", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 502 }));
    await expect(waitForRecoveredWeb(runtime, settings, { query: async () => deployment(), fetchImpl, ...clock(), timeoutMs: 20000 })).rejects.toThrow("RECOVERY_DEPLOYMENT_TIMEOUT");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
