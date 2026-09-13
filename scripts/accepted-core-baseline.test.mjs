import { mkdtemp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { BASELINE_CONFIG, BASELINE_WORKFLOW, BASELINE_SMOKE_STEP, sha256, identityHash, validatePin, readPin, validateEvidence,
  validateReceipt, validateProvenance, resolveBaseline, verifyLedger, databaseIdentity, assertProviderBinding,
  verifyProvider, validateAuthProvenance, checkBaseline, preparedSchemaEngine, verifiedSmokeChecks, baselineSmokeEvidence } from "./accepted-core-baseline.mjs";
import { resolveProductionValidationContext } from "./production-validation-context.mjs";

const SOURCE = "a".repeat(40), VERIFIER = "b".repeat(40), CANDIDATE = "c".repeat(40);
const HASH = "d".repeat(64), REPOSITORY = "Corgtexdotcom/corgtex";
const ids = Array.from({ length: 6 }, (_, index) => `00000000-0000-0000-0000-${String(index + 1).padStart(12, "0")}`);
const now = Date.parse("2026-01-02T00:00:00Z");
const origin = "https://app.corgtex.com";

function fixture() {
  const target = { id: "backup-app", origin, provider: "railway", projectId: ids[0], environmentId: ids[1],
    webServiceId: ids[2], workerServiceId: ids[3], databaseIdentitySha256: databaseIdentity("postgresql://user:password@db.example/core") };
  const evidence = { target, sourceSha: SOURCE,
    images: { web: { deploymentId: ids[4], digest: `sha256:${HASH}` }, worker: { deploymentId: ids[5], digest: `sha256:${"e".repeat(64)}` } },
    buildProof: { kind: "direct-container-build-readback", evidenceSha256: HASH, observedAt: "2026-01-01T10:00:00Z",
      roles: { web: { deploymentId: ids[4], sourceSha: SOURCE }, worker: { deploymentId: ids[5], sourceSha: SOURCE } } },
    authProof: { kind: "protected-review-retained-core-auth", runId: 10, runAttempt: 1, jobId: 20, stepNumber: 14,
      workflowSha: VERIFIER, evidenceSha256: HASH, origin, observedAt: "2026-01-01T10:00:00Z",
      checks: { health: true, releaseMetadata: true, loginPage: true, login: true, session: true, rootFlow: true } },
  };
  const receipt = { schemaVersion: 1, kind: "accepted-core-baseline", accepted: true, evidence,
    schema: { manifestSha256: HASH, datamodelSha256: HASH, exactLedgerMatch: true, supportedSchemaMatch: true },
    acceptance: { repository: REPOSITORY, workflowPath: BASELINE_WORKFLOW, workflowSha: VERIFIER,
      runId: 100, runAttempt: 2, acceptedAt: "2026-01-01T11:05:00Z", evidenceSha256: identityHash(evidence) } };
  const bytes = Buffer.from(JSON.stringify(receipt, null, 2) + "\n");
  const pin = { schemaVersion: 1, target: "backup-app", targetSha256: identityHash(target), sourceSha: SOURCE,
    verifierSha: VERIFIER, receiptSha256: sha256(bytes), run: { id: 100, attempt: 2, workflowId: 30, workflowSha: VERIFIER },
    artifact: { id: 200, name: "accepted-core-baseline-100-2", sha256: HASH } };
  const run = { id: 100, run_attempt: 2, workflow_id: 30, path: BASELINE_WORKFLOW, head_sha: VERIFIER, head_branch: "main",
    event: "workflow_dispatch", status: "completed", conclusion: "success", repository: { full_name: REPOSITORY, id: 1 },
    head_repository: { full_name: REPOSITORY, id: 1 }, run_started_at: "2026-01-01T11:00:00Z", updated_at: "2026-01-01T11:10:00Z" };
  const artifact = { id: 200, name: pin.artifact.name, expired: false, digest: `sha256:${HASH}`,
    created_at: "2026-01-01T11:06:00Z", expires_at: "2026-04-01T00:00:00Z",
    workflow_run: { id: 100, head_sha: VERIFIER, head_branch: "main", head_repository_id: 1, repository_id: 1 } };
  return { target, evidence, receipt, bytes, pin, provenance: { run, attempt: structuredClone(run),
    workflow: { id: 30, path: BASELINE_WORKFLOW, state: "active" }, artifact,
    artifacts: { total_count: 1, artifacts: [{ id: artifact.id, name: artifact.name }] } } };
}

describe("accepted Core baseline trust", () => {
  it("is disabled only for absent config; invalid supplied configuration fails closed", async () => {
    const directory = await mkdtemp(join(tmpdir(), "core-baseline-test-"));
    try {
      const path = join(directory, "pin.json");
      expect(await readPin(path)).toBeNull();
      for (const value of ["", "null", "{}", '{"enabled":false}', JSON.stringify({ ...fixture().pin, artifact: { name: "latest" } })]) {
        await writeFile(path, value);
        await expect(readPin(path)).rejects.toThrow();
      }
      await writeFile(path, JSON.stringify(fixture().pin));
      expect(await readPin(path)).toEqual(fixture().pin);
      const api = vi.fn();
      expect(await resolveBaseline(null, { api })).toBeNull();
      expect(api).not.toHaveBeenCalled();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("resolves only the exact pinned run attempt and artifact contents", async () => {
    const f = fixture();
    const responses = [f.provenance.run, f.provenance.attempt, f.provenance.workflow, f.provenance.artifact, f.provenance.artifacts];
    const api = vi.fn(async () => responses.shift());
    const download = vi.fn(async () => f.bytes);
    expect(await resolveBaseline(f.pin, { api, download, now })).toEqual(f.receipt);
    expect(api.mock.calls.map(([path]) => path)).toEqual(["actions/runs/100", "actions/runs/100/attempts/2",
      "actions/workflows/30", "actions/artifacts/200", "actions/runs/100/artifacts?per_page=100"]);
    expect(download).toHaveBeenCalledExactlyOnceWith(f.pin);
  });

  it.each([
    ["fork", (p) => { p.run.head_repository.full_name = "other/fork"; }],
    ["repository", (p) => { p.run.repository.full_name = "other/repo"; }],
    ["branch", (p) => { p.run.head_branch = "candidate"; }],
    ["event", (p) => { p.run.event = "push"; }],
    ["conclusion", (p) => { p.run.conclusion = "failure"; }],
    ["pending", (p) => { p.run.status = "in_progress"; }],
    ["workflow ID", (p) => { p.run.workflow_id = 99; }],
    ["workflow path", (p) => { p.workflow.path = ".github/workflows/production-validation.yml"; }],
    ["Fleet Release producer", (p) => { p.run.path = ".github/workflows/fleet-release.yml"; }],
    ["workflow source SHA", (p) => { p.run.head_sha = CANDIDATE; }],
    ["rerun", (p) => { p.run.run_attempt = 3; }],
    ["attempt mismatch", (p) => { p.attempt.run_attempt = 1; }],
    ["artifact run", (p) => { p.artifact.workflow_run.id = 101; }],
    ["artifact fork", (p) => { p.artifact.workflow_run.head_repository_id = 2; }],
    ["artifact SHA", (p) => { p.artifact.workflow_run.head_sha = CANDIDATE; }],
    ["expired", (p) => { p.artifact.expired = true; }],
    ["expiry time", (p) => { p.artifact.expires_at = "2025-01-01T00:00:00Z"; }],
    ["archive hash", (p) => { p.artifact.digest = `sha256:${"0".repeat(64)}`; }],
    ["old attempt artifact", (p) => { p.artifact.created_at = "2026-01-01T09:00:00Z"; }],
    ["artifact name", (p) => { p.artifact.name = "accepted-core-baseline"; }],
    ["ambiguous artifacts", (p) => { p.artifacts.artifacts.push({ id: 201, name: p.artifact.name }); p.artifacts.total_count++; }],
    ["unbounded list", (p) => { p.artifacts.total_count = 101; }],
  ])("rejects %s before downloading untrusted bytes", async (_name, mutate) => {
    const f = fixture();
    mutate(f.provenance);
    const responses = [f.provenance.run, f.provenance.attempt, f.provenance.workflow, f.provenance.artifact, f.provenance.artifacts];
    const download = vi.fn();
    await expect(resolveBaseline(f.pin, { api: async () => responses.shift(), download, now })).rejects.toThrow(/CORE_BASELINE_/);
    expect(download).not.toHaveBeenCalled();
  });

  it("does not trust artifact self-claims when receipt bytes differ", async () => {
    const f = fixture();
    const responses = [f.provenance.run, f.provenance.attempt, f.provenance.workflow, f.provenance.artifact, f.provenance.artifacts];
    await expect(resolveBaseline(f.pin, { api: async () => responses.shift(), download: async () => Buffer.from("{}"), now }))
      .rejects.toThrow("RECEIPT_HASH_MISMATCH");
  });

  it("preserves exact verified receipt bytes for pinned-verifier rechecking", async () => {
    const f = fixture();
    const responses = [f.provenance.run, f.provenance.attempt, f.provenance.workflow, f.provenance.artifact, f.provenance.artifacts];
    const bytes = Buffer.from(JSON.stringify(f.receipt));
    const persist = vi.fn();
    await resolveBaseline({ ...f.pin, receiptSha256: sha256(bytes) }, { api: async () => responses.shift(), download: async () => bytes, persist, now });
    expect(persist).toHaveBeenCalledExactlyOnceWith(bytes);
  });

  it.each([
    ["not accepted", (r) => { r.accepted = false; }],
    ["target", (r) => { r.evidence.target.id = "ops"; }],
    ["origin", (r) => { r.evidence.target.origin = "https://other.example"; }],
    ["provider target", (r) => { r.evidence.target.projectId = ids[5]; }],
    ["source", (r) => { r.evidence.sourceSha = CANDIDATE; }],
    ["worker build", (r) => { r.evidence.buildProof.roles.worker.sourceSha = CANDIDATE; }],
    ["worker deployment", (r) => { r.evidence.images.worker.deploymentId = ids[0]; }],
    ["mutable image", (r) => { r.evidence.images.web.digest = "latest"; }],
    ["schema identity", (r) => { r.schema.manifestSha256 = ""; }],
    ["checksum variance", (r) => { r.schema.exactLedgerMatch = false; }],
    ["supported schema", (r) => { r.schema.supportedSchemaMatch = false; }],
    ["auth checks", (r) => { r.evidence.authProof.checks.login = false; }],
    ["unexpected credential field", (r) => { r.evidence.token = "fixture-never-log"; }],
    ["acceptance run", (r) => { r.acceptance.runId = 101; }],
  ])("rejects receipt %s even if an artifact contains those claims", (_name, mutate) => {
    const f = fixture();
    mutate(f.receipt);
    expect(() => validateReceipt(f.receipt, f.pin)).toThrow(/CORE_BASELINE_/);
  });

  it("independently pins verifier, accepted source and target hashes", () => {
    const f = fixture();
    expect(() => validatePin({ ...f.pin, verifierSha: SOURCE })).toThrow();
    expect(() => validateReceipt(f.receipt, { ...f.pin, sourceSha: CANDIDATE })).toThrow();
    expect(() => validateReceipt(f.receipt, { ...f.pin, targetSha256: "f".repeat(64) })).toThrow();
    expect(() => validateProvenance(f.pin, f.provenance, now)).not.toThrow();
  });

  it.each(["pull_request", "pull_request_target", "workflow_dispatch"])("forbids bootstrap on candidate/fork context %s", (event) => {
    expect(() => execFileSync(process.execPath, ["scripts/accepted-core-baseline.mjs", "prepare"], {
      env: { PATH: process.env.PATH, GITHUB_REPOSITORY: event === "workflow_dispatch" ? "other/fork" : REPOSITORY,
        GITHUB_REF: "refs/heads/candidate", GITHUB_EVENT_NAME: event }, stdio: "pipe",
    })).toThrow();
  });
});

describe("baseline operational checks", () => {
  const manifest = { migrations: [{ name: "001_example", checksum: HASH }] };
  const row = () => ({ migration_name: "001_example", checksum: HASH, finished_at: "done", rolled_back_at: null });
  it("keeps a known original-Git checksum variance strictly nonaccepted", () => {
    expect(() => verifyLedger(manifest, [row()])).not.toThrow();
    for (const rows of [[], [row(), row()], [{ ...row(), finished_at: null }], [{ ...row(), rolled_back_at: "rolled-back" }],
      [{ ...row(), migration_name: "unexpected" }], [{ ...row(), checksum: "original-git-checksum" }]]) {
      expect(() => verifyLedger(manifest, rows)).toThrow("LEDGER_NOT_EXACT");
    }
  });

  it("hashes database identity without credentials but distinguishes database targets", () => {
    expect(databaseIdentity("postgres://new-user:new-password@db.example:5432/core"))
      .toBe(databaseIdentity("postgresql://user:password@db.example/core"));
    expect(databaseIdentity("postgresql://user:password@db.example/other"))
      .not.toBe(databaseIdentity("postgresql://user:password@db.example/core"));
    expect(() => databaseIdentity("postgresql://user:password@db.example/core?schema=other")).toThrow("DATABASE_SCHEMA_UNSUPPORTED");
  });

  it("requires a prepared executable schema engine rather than bootstrapping in the credentialed step", async () => {
    const directory = await mkdtemp(join(tmpdir(), "core-engine-test-"));
    try {
      const engines = join(directory, "node_modules/@prisma/engines");
      await mkdir(engines, { recursive: true });
      await expect(preparedSchemaEngine(directory)).rejects.toThrow("PRISMA_ENGINE_NOT_PREPARED");
      const path = join(engines, "schema-engine-test");
      await writeFile(path, "fixture executable", { mode: 0o700 });
      expect(await preparedSchemaEngine(directory)).toBe(path);
      await writeFile(join(engines, "schema-engine-other"), "ambiguous executable", { mode: 0o700 });
      await expect(preparedSchemaEngine(directory)).rejects.toThrow("PRISMA_ENGINE_NOT_PREPARED");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  const provider = (evidence, role) => ({ instance: { activeDeployments: [{ id: evidence.images[role].deploymentId, status: "SUCCESS" }],
    latestDeployment: { id: evidence.images[role].deploymentId, status: "SUCCESS" } },
    deployments: { edges: [{ node: { id: evidence.images[role].deploymentId, status: "SUCCESS", meta: { imageDigest: evidence.images[role].digest } } }] } });
  it("uses bounded existing Railway scoped deployment and active-instance queries, never mutations or variables", async () => {
    const f = fixture();
    const fetchImpl = vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      expect(body.query).toContain("deployments(first: 1, input: { projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId })");
      expect(body.query).toContain("activeDeployments { id status }");
      expect(body.query).not.toMatch(/mutation|variables\(|environment\(/);
      expect(body.variables.projectId).toBe(f.target.projectId);
      expect(body.variables.environmentId).toBe(f.target.environmentId);
      const role = body.variables.serviceId === f.target.webServiceId ? "web" : "worker";
      return new Response(JSON.stringify({ data: provider(f.evidence, role) }));
    });
    const env = { RAILWAY_API_TOKEN: "fixture-only", FLEET_RELEASE_BACKUP_APP_TARGET_JSON: JSON.stringify({ provider: "railway", url: origin,
      railway: { projectId: ids[0], environmentId: ids[1], webServiceId: ids[2], workerServiceId: ids[3] } }) };
    await verifyProvider(f.evidence, env, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await expect(verifyProvider(f.evidence, { ...env, FLEET_RELEASE_BACKUP_APP_TARGET_JSON: "{}" }, fetchImpl)).rejects.toThrow("CONFIGURED_TARGET_MISMATCH");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each(["digest", "deployment", "active", "latest"])("rejects provider %s drift rather than using health SHA as identity", (field) => {
    const f = fixture(), data = provider(f.evidence, "web");
    if (field === "digest") data.deployments.edges[0].node.meta.imageDigest = `sha256:${"f".repeat(64)}`;
    if (field === "deployment") data.deployments.edges[0].node.id = ids[5];
    if (field === "active") data.instance.activeDeployments.push({ id: ids[5], status: "SUCCESS" });
    if (field === "latest") data.instance.latestDeployment.status = "DEPLOYING";
    expect(() => assertProviderBinding(f.evidence, "web", data)).toThrow("PROVIDER_DRIFT");
  });

  function auth() {
    const run = { id: 10, run_attempt: 1, status: "completed", conclusion: "success", event: "push", path: ".github/workflows/ci.yml",
      head_branch: "main", head_sha: VERIFIER, head_repository: { full_name: REPOSITORY }, repository: { full_name: REPOSITORY } };
    const job = { id: 20, run_id: 10, run_attempt: 1, conclusion: "success", name: "Production Smoke Test", head_sha: VERIFIER,
      steps: [{ number: 14, conclusion: "success", name: `Run node scripts/railway-smoke.mjs ${origin} *** ***`,
        started_at: "2026-01-01T09:59:00Z", completed_at: "2026-01-01T10:01:00Z" }] };
    return { run, job };
  }
  it("requires retained protected-review proof plus the actual successful Core auth step", () => {
    const f = fixture(), { run, job } = auth();
    expect(() => validateEvidence(f.evidence)).not.toThrow();
    expect(() => validateAuthProvenance(f.evidence, run, job)).not.toThrow();
  });

  it("accepts fractional smoke time only within the final GitHub API second", () => {
    const f = fixture(), { run, job } = auth();
    job.steps[0].started_at = "2026-01-01T13:59:10Z";
    job.steps[0].completed_at = "2026-01-01T13:59:12Z";
    for (const at of ["13:59:12.237Z", "13:59:12.999Z"]) {
      f.evidence.authProof.observedAt = `2026-01-01T${at}`;
      expect(() => validateAuthProvenance(f.evidence, run, job)).not.toThrow();
    }
    for (const at of ["13:59:09.999Z", "13:59:13.000Z"]) {
      f.evidence.authProof.observedAt = `2026-01-01T${at}`;
      expect(() => validateAuthProvenance(f.evidence, run, job)).toThrow("AUTH_PROVENANCE_INVALID");
    }
    job.steps[0].completed_at = "2026-01-01T13:59:12.237Z";
    f.evidence.authProof.observedAt = "2026-01-01T13:59:12.238Z";
    expect(() => validateAuthProvenance(f.evidence, run, job)).toThrow("AUTH_PROVENANCE_INVALID");
  });

  function renewal() {
    const f = fixture(), { run, job } = auth();
    const proof = baselineSmokeEvidence(f.evidence, f.pin, { GITHUB_SHA: VERIFIER, GITHUB_RUN_ID: "10", GITHUB_RUN_ATTEMPT: "1",
      GITHUB_JOB: "smoke-prod", ADMIN_PASSWORD: "do-not-copy-to-proof" }, "2026-01-01T10:00:00.237Z");
    f.evidence.authProof = { ...f.evidence.authProof, kind: "protected-review-retained-baseline-auth",
      baseline: proof.baseline, evidenceSha256: sha256(JSON.stringify(proof)), observedAt: proof.observedAt };
    job.steps[0].name = BASELINE_SMOKE_STEP;
    return { ...f, run, job, proof };
  }

  it("supports protected renewal from the specifically bound baseline smoke step without legacy output", () => {
    const f = renewal();
    expect(() => validateAuthProvenance(f.evidence, f.run, f.job, f.pin)).not.toThrow();
    expect(f.proof).toMatchObject({ kind: "core-baseline-auth-smoke-success", runId: 10, runAttempt: 1,
      origin, workflowSha: VERIFIER, job: "smoke-prod", stepName: BASELINE_SMOKE_STEP,
      baseline: { sourceSha: SOURCE, verifierSha: VERIFIER, receiptSha256: f.pin.receiptSha256 } });
    expect(JSON.stringify(f.proof)).not.toContain("do-not-copy-to-proof");
    expect(f.proof).not.toHaveProperty("accepted");
  });

  it.each(["source", "target", "images", "verifier", "receipt", "step", "job", "attempt", "config"])("rejects renewal %s mismatch", (field) => {
    const f = renewal();
    if (field === "source") f.evidence.authProof.baseline.sourceSha = CANDIDATE;
    if (field === "target") f.evidence.authProof.baseline.targetSha256 = "0".repeat(64);
    if (field === "images") f.evidence.authProof.baseline.imagesSha256 = "0".repeat(64);
    if (field === "verifier") f.evidence.authProof.baseline.verifierSha = CANDIDATE;
    if (field === "receipt") f.evidence.authProof.baseline.receiptSha256 = "0".repeat(64);
    if (field === "step") f.job.steps[0].name = "Some other successful baseline job";
    if (field === "job") f.job.name = "Build";
    if (field === "attempt") f.job.run_attempt++;
    if (field === "config") f.pin = null;
    expect(() => validateAuthProvenance(f.evidence, f.run, f.job, f.pin)).toThrow(/CORE_BASELINE_/);
  });

  it("retains only complete fixed auth success checks, not raw child output", () => {
    const messages = ["/api/health reports the Corgtex fingerprint", "/api/health release configured metadata matches runtime metadata",
      "/login serves the Corgtex login page", "/api/auth/login accepted the seeded admin credentials",
      "/api/session resolves the logged-in actor and workspaces", "/ resolves into the authenticated workspace flow"];
    const stdout = messages.map((message) => `OK   ${message}`).join("\n");
    expect(verifiedSmokeChecks(`${stdout}\nprivate-child-text`)).toEqual(fixture().evidence.authProof.checks);
    for (const missing of messages) {
      expect(() => verifiedSmokeChecks(messages.filter((message) => message !== missing).map((message) => `OK   ${message}`).join("\n")))
        .toThrow("AUTH_SMOKE_PROOF_INCOMPLETE");
    }
  });
  it.each(["job", "step", "target", "time", "attempt", "fork"])("rejects wrong auth %s", (field) => {
    const { evidence } = fixture(), { run, job } = auth();
    if (field === "job") job.name = "Build";
    if (field === "step") job.steps[0].number = 13;
    if (field === "target") job.steps[0].name = "Run node scripts/railway-smoke.mjs https://ops.example *** ***";
    if (field === "time") job.steps[0].completed_at = "2026-01-01T09:00:00Z";
    if (field === "attempt") job.run_attempt = 2;
    if (field === "fork") run.head_repository.full_name = "other/fork";
    expect(() => validateAuthProvenance(evidence, run, job)).toThrow("AUTH_PROVENANCE_INVALID");
  });

  it.each([true, false])("brackets baseline checks with provider readback, bootstrap=%s", async (bootstrap) => {
    const f = fixture(), calls = [];
    const deps = { provider: async () => { calls.push("provider"); }, database: async (_e, dir, expected) => {
      expect(dir).toBe("accepted-source"); expect(expected).toBe(f.receipt.schema); calls.push("database"); return f.receipt.schema;
    }, retainedAuth: async () => { calls.push("retained-auth"); }, smoke: async () => { calls.push("auth-smoke"); } };
    await checkBaseline(f.evidence, { sourceDir: "accepted-source", expectedSchema: f.receipt.schema, bootstrap, deps });
    expect(calls).toEqual(["provider", "database", bootstrap ? "retained-auth" : "auth-smoke", "provider"]);
  });
  it("never reaches acceptance or auth writes after checksum variance or ambiguous provider readback", async () => {
    const f = fixture(), smoke = vi.fn(), retainedAuth = vi.fn();
    const deps = { provider: vi.fn(), database: async () => ({ ...f.receipt.schema, exactLedgerMatch: false }), smoke, retainedAuth };
    await expect(checkBaseline(f.evidence, { sourceDir: "accepted-source", bootstrap: true, deps })).rejects.toThrow("SCHEMA_NOT_ACCEPTED");
    expect(smoke).not.toHaveBeenCalled(); expect(retainedAuth).not.toHaveBeenCalled();
    expect(deps.provider).toHaveBeenCalledTimes(1);
    deps.database = async () => f.receipt.schema;
    deps.provider.mockRejectedValueOnce(new Error("provider-ambiguous"));
    await expect(checkBaseline(f.evidence, { sourceDir: "accepted-source", deps })).rejects.toThrow("provider-ambiguous");
    expect(smoke).not.toHaveBeenCalled();
  });
});

describe("source CI versus explicit rollout", () => {
  const context = (overrides = {}) => resolveProductionValidationContext({ eventName: "workflow_run", githubRef: "refs/heads/main",
    githubSha: CANDIDATE, githubRepository: REPOSITORY,
    event: { workflow_run: { head_sha: CANDIDATE, conclusion: "success", event: "push", head_branch: "main", head_repository: { full_name: REPOSITORY } } },
    changedFiles: ["packages/domain/src/runtime.ts", "prisma/migrations/new/migration.sql"], ...overrides });
  it("retains exact candidate release policy when no baseline is configured", () => {
    expect(context()).toMatchObject({ enabled: "true", expected_git_sha: CANDIDATE });
  });
  it.each(["workflow_run", "schedule"])("does not import candidate fixtures into accepted Core on %s", (eventName) => {
    expect(context({ eventName, acceptedBaseline: fixture().receipt })).toMatchObject({ enabled: "false", expected_git_sha: "",
      validation_mode: "accepted-baseline-ci-only", crm_smoke: "false", source_intake_smoke: "false", briefing_fixture_smoke: "false" });
  });
  it("does not change explicit Production Validation SHA or gates", () => {
    const input = { eventName: "workflow_dispatch", expectedGitShaInput: CANDIDATE };
    expect(context({ ...input, acceptedBaseline: fixture().receipt })).toEqual(context(input));
    expect(context(input)).toMatchObject({ enabled: "true", expected_git_sha: CANDIDATE, telemetry_release_smoke: "true" });
  });

  it.each([null, "{}", JSON.stringify(fixture().pin)])("attributes recovery using the failed source commit, config=%s", async (config) => {
    const directory = await mkdtemp(join(tmpdir(), "core-recovery-test-"));
    try {
      const git = (...args) => execFileSync("git", args, { cwd: directory, encoding: "utf8", stdio: "pipe" });
      git("init", "-q");
      await writeFile(join(directory, "README.md"), "synthetic fixture\n");
      if (config !== null) {
        await mkdir(join(directory, ".github"));
        await writeFile(join(directory, BASELINE_CONFIG), config);
      }
      git("add", ".");
      git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture");
      const sha = git("rev-parse", "HEAD").trim();
      // Mutating the working copy cannot change attribution of the failed SHA.
      if (config !== null) await rm(join(directory, BASELINE_CONFIG));
      const outputPath = join(directory, "output");
      execFileSync(process.execPath, [resolve("scripts/accepted-core-baseline.mjs"), "recovery-policy"], { cwd: directory,
        env: { PATH: process.env.PATH, FAILED_SHA: sha, GITHUB_OUTPUT: outputPath }, stdio: "pipe" });
      expect(await readFile(outputPath, "utf8")).toBe(`automatic_revert_allowed=${config === null ? "true" : "false"}\n`);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it("wires main-only protected consumption, accepted-source preparation, and unchanged rollout workflows", async () => {
    const ci = await readFile(".github/workflows/ci.yml", "utf8");
    const bootstrap = await readFile(BASELINE_WORKFLOW, "utf8");
    const recovery = await readFile(".github/workflows/auto-revert.yml", "utf8");
    const smoke = ci.slice(ci.indexOf("  smoke-prod:"), ci.indexOf("  observe-prod:"));
    expect(smoke).toContain("github.event_name == 'push' && github.repository == 'Corgtexdotcom/corgtex'");
    expect(smoke).toContain("environment: fleet-release-production");
    expect(smoke).toContain("ref: ${{ steps.baseline.outputs.verifier_sha }}");
    expect(smoke).toContain("ref: ${{ steps.baseline.outputs.source_sha }}");
    expect(smoke).toContain("node .baseline/verifier/scripts/accepted-core-baseline.mjs check");
    expect(smoke).toContain(`name: ${BASELINE_SMOKE_STEP}`);
    expect(smoke).toContain("name: core-baseline-smoke-${{ github.run_id }}-${{ github.run_attempt }}");
    expect(smoke).toContain("path: .artifacts/core-baseline/auth-smoke.json");
    expect(smoke.indexOf("migrate diff --from-schema-datamodel")).toBeLessThan(smoke.indexOf("Verify accepted Core provider"));
    expect(bootstrap).toContain("--from-schema-datamodel prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --exit-code");
    expect(bootstrap).not.toMatch(/ADMIN_PASSWORD|runtime:write|deploymentId:|release-fleet\.mjs|migrate deploy/);
    expect(bootstrap).toContain("accepted-core-baseline-${{ github.run_id }}-${{ github.run_attempt }}");
    expect(recovery).toContain("steps.baseline-policy.outputs.automatic_revert_allowed == 'true'");
    expect(recovery.indexOf("recovery-policy")).toBeLessThan(recovery.indexOf("git revert"));
    expect(ci).toContain("test \"$app_git_sha\" = \"$ACCEPTED_CORE_SOURCE_SHA\"");
    expect(ci).toContain(".baseline/verifier/scripts/post-deploy-observation-gate.mjs");
    const validation = await readFile(".github/workflows/production-validation.yml", "utf8");
    expect(validation).toContain("must run from the same revision expected in production");
    const fleet = await readFile(".github/workflows/fleet-release.yml", "utf8");
    expect(fleet).not.toContain("accepted-core-baseline");
  });
});
