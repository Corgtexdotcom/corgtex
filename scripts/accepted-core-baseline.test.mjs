import { mkdtemp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { BASELINE_CONFIG, BASELINE_WORKFLOW, BASELINE_SMOKE_STEP, sha256, identityHash, validatePin, readPin, validateEvidence,
  validateReceipt, validateProvenance, resolveBaseline, verifyLedger, CORE_HISTORICAL_LEDGER, databaseIdentity, assertProviderBinding,
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
  it("rejects arbitrary checksum variance and malformed ledgers", () => {
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

describe("explicit Core historical ledger disposition", () => {
  const policy = CORE_HISTORICAL_LEDGER;
  // Captured from exact d0 Git SQL bytes; collection must work in shallow CI.
  // Keep the complete manifest so verifyLedger recomputes its real pinned hash.
  const migrationFixture = [
    { name: "20260402190000_init", checksum: "44357ee37379cf81ca931e3c20bb3b1ea92faf0602a4a50ca716ac3a66cef8a8" },
    { name: "20260402203000_approval_foundations", checksum: "d3365297f79415f4ad398c72e54e3d42fb7ea2760e375af0750f2b0ef41f1827" },
    { name: "20260402230000_business_workflow_finance_parity", checksum: "6a70fc692f80b30bc78340681bc3e46b4ee5356b8712cdbc1081ec9aea3b4f3d" },
    { name: "20260403101500_model_gateway_and_retrieval", checksum: "52f9bde5d258aa011f7bcb5039db213095c1286f04af7b784b9b98ce11838e5f" },
    { name: "20260403113000_agent_runtime_v1", checksum: "427c968a97e970e13bdd127a8ad9abd29f2d5feeb3516681f635ed2fd7f6b125" },
    { name: "20260404170500_notifications", checksum: "7e843a20e477aed1374fd6aaeda761f6aa7bb93f994dd0cdee6e5d50ddfce582" },
    { name: "20260404171500_conversations_and_memory", checksum: "60b8cc86bbd3790a3e4a108a2393b873b922e8b39e281ed1f2b0f20290e70858" },
    { name: "20260406241000_phase3_governance_catch_up", checksum: "9e4f340d50fad201ece8dd908b53db05bb8bf9401531685b3614a48648aeeabc" },
    { name: "20260406245500_phase4_webhooks", checksum: "79f4d761098209f946ca2f6578b01ae8aabb189c39d97b51bdbfdcc1db6130f2" },
    { name: "20260408030000_brain_data_layer", checksum: "40c8077025c7217e25a1d6da458900e1054ece05c88014472f06b0589653b1f3" },
    { name: "20260408221500_add_event_knowledge_source_type", checksum: "938c754e14db96ab5b34cf72b1b0e3a86f41546a3b3cdbe69f621014a0975cbf" },
    { name: "20260409032643_add_oauth_connections", checksum: "e6db4f93f25896457c305bf829a42b0c3e3c3db8a138f16fd899f0ec6daf01c2" },
    { name: "20260409034000_prepare_pgvector", checksum: "e73d930269f0f2a635798cdadcad733ef22fa48a226c24dba297d6164462da6e" },
    { name: "20260412232811_sync_pending_schema", checksum: "3b444e606c062181a863b56d55fe768fdbf4c53f119a5b05f2fe76f746941af3" },
    { name: "20260412234500_advice_process_schema_sync", checksum: "9169fa5519a39a20cd45e0ef02e030ac2f85ebc8d1ce1a7033b58e72d22461cd" },
    { name: "20260415154926_add_o2_primitives", checksum: "b35ed36d6e3b6bfd69f5c524ebe9a5af2d7c4cd0cde76ea9b20bc25b0b0136ff" },
    { name: "20260415224916_add_demo_lead", checksum: "ed6113e0080845e32612e2ddc2ff1071e1412ba4246fc2b2d3f3650f0c697c2c" },
    { name: "20260416025124_add_digest_and_conversation_types", checksum: "c131e1b627d0b6de68f0877443e5f1839f974bff534020cf1aa24d4d9874571f" },
    { name: "20260416202706_add_crm_models", checksum: "2ee6ce42bd42559c90f000ce5fd8f7066f6153f5e51fe507be20f1b318446f32" },
    { name: "20260418060614_add_agent_config", checksum: "0040711bb09c8346f9c6621b3e58bf19fafd1ddbb3d17552554e0daf63bcc7bc" },
    { name: "20260419005718_phase1_foundation_sso_and_budget", checksum: "340aa8be45298023d048d02c8959161c39a73c66ad98d3bb2609a086be6deca3" },
    { name: "20260419010500_add_oauth_server_models", checksum: "0096fbc25cde8fd16c385d4af98d3c72f035962adecb6f12e45d84760ea0059e" },
    { name: "20260419041729_add_sensitivity_label", checksum: "1ba24728495c812de6d50aaf85b2cd918feb5c8669fdbb236f72740087a9aae2" },
    { name: "20260419041832_add_external_data_source", checksum: "7ad45519777c0d4662f8c3648539c4a89d4c244a2ffd76f468d31c443d725fee" },
    { name: "20260419222031_add_spend_comments_and_objected_status", checksum: "40d5f9fd4fe4d2eb3a0bfb8da14e3ccb44c2e8bcd19afe29a9d5e09bb4123604" },
    { name: "20260421185444_add_workspace_feature_flags", checksum: "82f151aee01f25f7ce4aa357bbfaa98dfd9d50542198ff25b270c9edf484f024" },
    { name: "20260421214131_refine_proposal_governance", checksum: "3706ae32a24e12f692bda664e1a0280ee4c4df3d50c21631ec1cdce48833a92e" },
    { name: "20260421224945_add_meeting_insights", checksum: "8f4141e834e3810a2f175a87fbf1350620337057b82b70738517116281a8ef41" },
    { name: "20260421225310_add_meeting_insights", checksum: "82e2d525897408ab358b4667204140fdbbaacb26c71e2d06ef1484df1f334fc7" },
    { name: "20260422044306_add_goals_system", checksum: "e8b9a38d49a5055bf2b31391777ecee5c225fafe1a7ac0cd192434e493cb5dcd" },
    { name: "20260422170600_agent_identity", checksum: "0583880d41704552d8fff7cb4f92069d5261076dee23f429e9adfee09d446679" },
    { name: "20260423190148_add_deliberation_entry", checksum: "bac58e1e2dec5196f3642a76152ed2c85038c216c7c028ff5fa5e92bed07e504" },
    { name: "20260425010645_agent_governance_policy_feedback", checksum: "4bfe4294aab8225b254fbadcf569fde3c4cec6fff554a16ce4878d66ebebfe0d" },
    { name: "20260425011405_add_global_operator_role", checksum: "2b47e161aefa34ef44832d381fcf4a476ee9505fc162bde43e3e94bdb3718acd" },
    { name: "20260425070227_perf_indexes", checksum: "c47cb827bdc819a66269c12d30c5c2cdbdc954dc0e08dd65af25f1c8538771da" },
    { name: "20260425160000_add_workspace_archival", checksum: "dbabec8997d4d1a6e1f3c8838a3c7aa95dcef9b1a3ba13033f9ec70de15ebe88" },
    { name: "20260425233000_simple_lifecycle_deliberation", checksum: "e13040d3af9ec3de26934a835565f3410b9408805cc0011cabc12dbf3da24583" },
    { name: "20260426090000_add_communication_platform_foundation", checksum: "1cb55690a9ee345a8db20da05a17a1268a17bdb1569968f684f88f5349cb3285" },
    { name: "20260427120000_member_management_invite_requests", checksum: "e12bc1f33c1de07ddae31a0441d61e7c16aa9d6eabe191cf05e1a94951defffd" },
    { name: "20260427153000_mcp_connector_oauth", checksum: "733fd51a58c0139c1200840053e2298b25c3e5ec90f5411dc92f83178cb0a07b" },
    { name: "20260427194405_add_user_profile_and_notification_prefs", checksum: "114504ab9b45c899f5c3dee38e7ba41c8d0db4f4cf0c78f45f67d7068353fd38" },
    { name: "20260427201906_add_instance_registry", checksum: "968557161729db9a922e4073f550fac5ccae24fb777057644b5bdcd2e5204c12" },
    { name: "20260428000000_add_crm_qualification_conversation_provisioning", checksum: "ecd5981b8bb14e353c3f0e78dc9c096e37883be84d2f4d0a88b3ada7d956b5e0" },
    { name: "20260428165000_procurement_setup_schema_sync", checksum: "cd1d773ac98e9396a112f7d6c057dafe65469294b6740300c755490b125145a7" },
    { name: "20260428170000_hosted_control_plane", checksum: "e26d7b947dec5d76db5c0e55abefb05986d2238653e7f60e33136fd9ac83c52d" },
    { name: "20260429120000_ops_control_plane_support", checksum: "65b94fb6cd2adfb4532e2eae136c4cd07554d78dd63c66a20096091f6f4b30cd" },
    { name: "20260429153000_add_tension_raised_by", checksum: "5b09d2fe7b6bbe0f98e1700ad447525689285f5c31d705429cd0bbded8efd26a" },
    { name: "20260429170000_meeting_facilitation_loop", checksum: "234f885bd2f4eac844fd392a075179e5d71ea67a0ce2a958842645d8ec817736" },
    { name: "20260429183000_workspace_tool_links", checksum: "964e29238a74866b2fc0a75516d82e3560403d62bade409160a15d868120434c" },
    { name: "20260429212328_build_artifacts", checksum: "1fdfeb607470d5edb721f758fe0f4181810b0e1fd3047d40307d335fc0609c22" },
    { name: "20260430120000_meeting_transcript_intake", checksum: "4be62514d3fe98b0b0e45d185bfff2f4cd04823f7dfe6d756cd893a9bb74f78e" },
    { name: "20260430135520_add_demo_lead_followup", checksum: "34bd010312c3db8f6667ab7e70112adc20050d5447a43872a7cd63f79454f8db" },
    { name: "20260430170000_procurement_instant_trials", checksum: "e3aa3a14a6a50a2c77db4f48f5a446afbf14082fdfde18097c9d66dfef317c01" },
    { name: "20260430231756_newspaper_email_cadence", checksum: "0075f9870510b585460621cd2ba2b059298f5f60b7146b24c9912c86d4705a91" },
    { name: "20260501090000_slack_context_brain", checksum: "26cd4a6f26809ae0d0dcdaa8767f96ab1c73bc1bd4d088f032a55e815435fbb6" },
    { name: "20260501190128_newspaper_delivery_observability", checksum: "786d89b47aeeacea8a10b4e3bfb933c3fb812771ab4bd4285b650b1d22649f32" },
    { name: "20260504143000_control_plane_managed_workspace", checksum: "366fb14f482039c16a013e547ed5c2910d17951e7b11e5a251928d97920f55e2" },
    { name: "20260504180000_add_ingestion_guidance", checksum: "075c4260743628cc5f0e7464f484c8491d3a342d64e0c16fefb64212e0fb8475" },
    { name: "20260504193215_enterprise_meeting_recorders", checksum: "1e9f9974b6027bfba9479b8805318349e1a379119bb4cb8a6e747c0e243990ee" },
    { name: "20260504213000_product_analytics_events", checksum: "29607086b4abe360eda83a0ded4355cc405bd5b60abb9812df17e9c6a2bad1e9" },
    { name: "20260505120000_customer_control_plane_foundation", checksum: "34a415178b2b9656e84420f22faac16e5447e8dd7acdfb83e09a35f8b6a70751" },
    { name: "20260506043000_control_plane_enterprise_ops", checksum: "eb2d0050d317f257d07a13a29d71005784647a7e63750e64f5d690f6e9d92b9c" },
    { name: "20260506120000_rename_customer_deployments", checksum: "913fdeba8d73c9d4c4d1522ae7ddf4dbe15ac1595f5f06770b6282a362619e23" },
    { name: "20260506143000_tools_catalog_foundation", checksum: "7e7ee3162130c2536b76ff53122fc371ce4c87d19f8137df6d751c8172f7a175" },
    { name: "20260506153000_catalog_credential_usage", checksum: "2a82fb7023898df4a7dadb412791ed3aed358789cc1e9a78732a6ae0bb71e13c" },
    { name: "20260512180000_enterprise_recorder_calendar", checksum: "7eb6eb3af9c0e77d2841c40ba58c7b40c0adea583564646419cfe314d02fe43f" },
    { name: "20260514100000_meeting_contextual_intelligence", checksum: "9595d47019a4bfe284592d7dc132a82c0c31dd27716b872b3bd727fe2cbf188e" },
    { name: "20260515035553_meeting_block_intelligence", checksum: "d3194a78407e02e143db393204c7e00ffdf68a5df766bc89e34d6ee829889daf" },
    { name: "20260519181749_member_profile_links", checksum: "939199a612e903a4ef1ec2e4847c1520bc44f098df57d4bcf0b635678ee495e6" },
    { name: "20260519190000_external_mcp_connections", checksum: "a96bf1f2a8be03ef51c9e735f7e12444ec2e8cda5a6624d682fbf7f2c97bb50a" },
    { name: "20260519193000_slack_meeting_action_review", checksum: "9a6a4fc837b892ea045ba1e751891d04e0c2e6746a1695f824615d1e353f1591" },
    { name: "20260523000020_context_graph_foundation", checksum: "faa09b0ebf10ee9acc9c5982ff1ca7400c218462abde2f8263f93c08fbfb35f6" },
    { name: "20260524120000_self_serve_trial_billing", checksum: "95ba472eab4c9046c7ac821ecbea58bbb21129728d1987fde9550158b81680ea" },
    { name: "20260525182555_user_workspace_onboarding_state", checksum: "a4e32240d50a99d1bf5a418050e5636600783f062b18a3ce9c886561445b6071" },
    { name: "20260527002317_meeting_transcript_sources", checksum: "890535912557e2aa2abcb3bde998b880ab47b516a2162a0f128712e6014af7ce" },
    { name: "20260602162110_ai_workspaces_foundation", checksum: "837e9ea35086a685799e4c06cd30165cf20fe33346ac82573b05c58721176295" },
    { name: "20260602163007_role_history_onboarding", checksum: "6dff4760eda2c65ac860c25eb0193aaff8c22e1f24fda81f34159702616db0ba" },
    { name: "20260602183000_execution_plumbing", checksum: "e5419fe0bf0997c0bb80c509db92559aa867ab7347a5f412773873c251f223d2" },
    { name: "20260603171100_versioned_author_edits", checksum: "2512b468b5f225114d8c41c2f5ab255ccdeab0126dff69ad49a668473cd2eb2d" },
    { name: "20260604120000_self_serve_ops_upgrade", checksum: "a4d5dade096cfcdc228d8fb038abf4f30e18da2fc053643efe97b0b46ae0edc9" },
    { name: "20260604190000_client_migration_runs", checksum: "fb0b5db3a3563210a619dcead2d95b956f5ae6d7a1d9483770c8c0291f499ae1" },
    { name: "20260605160000_tools_marketplace_apps", checksum: "fd51980749df4db72d9b65ab1173b52998010a3a8932add7432b8eb5842367b8" },
    { name: "20260606183000_add_tension_resolved_at", checksum: "f778add189145d2c02fdbf15334f4c995ec8532ff3149be538ae6d68245160aa" },
    { name: "20260607220939_enterprise_custom_tools", checksum: "df8d5585a650d9459c745294a60be097d2108b6dcb64f72468697ab6109d49e4" },
    { name: "20260608041000_app_release_runtime_scope", checksum: "647bfd970164cfbbafd80ff659e2a3ac8c5c216b556faddae1e0f4a9bfab9434" },
    { name: "20260608103000_add_copilot_ai_workspace_provider", checksum: "a1a39af9094434f2b671cde40346df3626df7f2526abc5d26648a65e13d3136e" },
    { name: "20260609120000_company_understanding_foundation", checksum: "852a72da0581d39c3590c42a529aa1ed9ab6cbaa29bb0b098b30f93bebe3467b" },
    { name: "20260609194507_add_customer_deployment_cloud_provider", checksum: "64e6c6f4e05fe45970d399e097f970005f3fccbc87ecb7af7261e52cee6f61a8" },
    { name: "20260610165000_work_item_evidence", checksum: "ca12740b7cd7d16c869c3310ae12b8a4dc3f7e414c5e14a69e2dc8243016829b" },
    { name: "20260611025959_add_work_item_priority", checksum: "e31621d8c3e91b7d7521e2e9ba0f35a8bca6e9ae3a0782939a3ca76052f0b68c" },
    { name: "20260615033314_add_workspace_module_grant", checksum: "ec8dd4807715b0400203afe09ad0f675630da2dc3533e21ea3d810492eb64240" },
    { name: "20260615185018_add_workspace_module_access_request", checksum: "7be51cccb8ffc5ee95639b2c807ea5840ecb3b8f490ec1eab816fb8e3563e808" },
    { name: "20260616173000_add_practice_project", checksum: "5a900f47ccfe9e75796f86a7c7fb968c4e994dcdbb2788d0f00f1d5521dce7e6" },
    { name: "20260617120000_drop_legacy_proposal_reactions", checksum: "614cdf040b15f381255592683128686d90904182721ca117ba43975dd1927e26" },
    { name: "20260617170000_crm_account_foundation", checksum: "0b62d8fe2deee1142bba4daf95103654b6eb91260c1b94faf2e0c2c1e56531c2" },
    { name: "20260618015346_crm_deal_stage_transitions", checksum: "f07671773d66790e6d2c69a6420e145c72e97c381105a5e8f88e3be37a31e044" },
    { name: "20260618023706_crm_activity_reminders", checksum: "3b60406bc2a96f4e56e3288f8c9568ad3b40e491f0cbb5663c2bc7b80f8898db" },
    { name: "20260618032242_crm_communication_suggestions", checksum: "2f3fb61fcd18fc0561eb3b4751da6fa46dcc4f27f40b1ce1376fcfb15e608611" },
    { name: "20260618042933_crm_communication_execution_writeback", checksum: "575f3b10f3a24662fb5fff4d2b189700faa94f1cac369c0e2d352371d6c840aa" },
    { name: "20260618052000_crm_information_gathering", checksum: "5ab3718f13d37abac051e5987f971538eec44bbaf7648c1599d04ce8689774c6" },
    { name: "20260618060000_crm_finance_bridge", checksum: "ad5f2cb2f14017bc8844fb8a699c254dffee85da9240a15854b87c42b599f4ae" },
    { name: "20260619164500_retire_practice_ledger_app_surfaces", checksum: "8af656574cf44ea6520793c8b24b3950e9e64f7ba886397678daedcc835ca484" },
    { name: "20260619184953_drop_legacy_finance_backend", checksum: "d3db2ee382c18fcb5e02493858a49483fe96f74ede64cbc344aa89b39f3184c7" },
    { name: "20260622232915_generic_advice_foundation", checksum: "6d9517d606977bdf020b1b199ae8ad2558d5dc1791a4335829f19fc86025bc3b" },
    { name: "20260623004755_advice_process_optional_proposal", checksum: "3b277d94b5107fe062a80b5167524c0c5932e67ab410a3c6b024951b1a84ebac" },
    { name: "20260623093000_drop_legacy_advice_records", checksum: "4c074ce1f0ff98fad5304da98be2f80b9fab6f87cf4e6b4a7ca825bf5707b49f" },
    { name: "20260623173000_workspace_permalinks", checksum: "3426e3c9fcafccfea9e2ed99378f08b2dcd6f4fa55aae7af44cfe91b4abb7608" },
    { name: "20260626043000_email_delivery_tracking", checksum: "daa4c555854e62e631641c769899fb48ee5f96d3a76c32a3e1ea51dce1af6ef9" },
    { name: "20260628170000_box_external_resources", checksum: "70b9077220f1145c3b96eacee74251c41ca65fef123d6b9e65e2addeaeeff076" },
    { name: "20260629190000_external_resource_mentions", checksum: "625fa81512cda20e5d3006835488995d26ee58b3e3b562b6570f5fe9a6b6f1a1" },
    { name: "20260630230331_external_content_sources", checksum: "6b34851f81f7af17d29436c726175f311f25f4dc767223889527184e99cccc8c" },
    { name: "20260708180000_meeting_transcript_processing_progress", checksum: "27f7dbd5d9e6a276fd4d173dfedf1dae2e554b00bfaf23284424b64370ffe1d6" },
    { name: "20260710190511_member_kind_classification", checksum: "97bee8eacb0f711497d9f56d649a7bef7d75126460d275c50ac6bb7fcf8b4391" },
    { name: "20260710201000_member_alias_merge", checksum: "c6dfde8976de86de2cceaa052dbd2b2c2ea83a8b568f4d9e6d4a46c7410ccd24" },
    { name: "20260711012542_role_assignment_expiry", checksum: "91c9b3b7db466a236b2f8c736d9ea9b9d9c88f986ad22e25a78097e284e79ed8" },
    { name: "20260711172641_newspaper_editions", checksum: "004e65bec36f34bc8c086ae5d3c2a2d67d9e2c1f28320ca82dbb8c7aeb9dda9f" },
    { name: "20260711195657_add_meeting_audio_assets", checksum: "dcf7b641b3e40c8dd987613bb324d85fb24d085b68bbcf6213f8d6bb9961fadd" },
    { name: "20260714204248_proposal_owner_member", checksum: "b843259746a9bbf9b36784643511901e71a296fe45fff4e62e1d0e74f421fd30" },
    { name: "20260715120000_workspace_briefings", checksum: "3bcd2086defbbf2db987f8cb88789cd87f5003b6a91db2b845534d4ef4a05ac4" },
    { name: "20260715170000_meeting_series_recorder_url", checksum: "450ac53c719d2c6dd757bd5f8686d78641e47d1d79c663f6a50862ca9c2e9aa8" },
    { name: "20260715183000_backfill_proposal_owner_members", checksum: "385a0851b23397da66fde398ded99451b9cfe9a65b834dea2ce93bb7ffd9ad4a" },
    { name: "20260716084654_crm_pending_operations", checksum: "d3701c444c4ffe09a324375f82e401930d393288629a7ed1e5b7d8e317236f5d" },
    { name: "20260716120000_practice_ledger_slicing_pie_refactor", checksum: "6ce1a5155ef218fe11c7164465881076e9596c021a9d1f06d230d7ca16a983e1" },
    { name: "20260716190000_native_practice_ledger_foundation", checksum: "742b554788848c200d79298cacccb0ef19a2f5551dafb8fde26adc59d7f2c7d1" },
    { name: "20260717220000_notification_delivery_state", checksum: "291fc7c9c6f99117b032d0415938ab29f5a82eb509bd2d2e6f446cc1ffa417df" },
    { name: "20260722222841_action_checklist_items", checksum: "9a40b01e542ea016fa06192f09f1656399c378341c898d3133ceaab736d490d1" },
    { name: "20260723183000_slack_workspace_integration_binding", checksum: "73ae571ad202ff639390ddfd446b0f2fe07a3a8903bf701477e791a8e28a4e1f" },
    { name: "20260724190738_goal_private_drafts", checksum: "fc728bbc1a86a31c1cc7ec963c9b666a41ec30760edf04bdf2526605c95a993d" },
    { name: "20260727183000_finance_contribution_submitter_peer_review", checksum: "8b88b079ad0733d9f0c3cefd3fce08c79c637ac7d80ae49335f7ea38d431ba11" },
    { name: "20260728070000_drop_legacy_finance", checksum: "a72b3dcc1ec0073d61b708612ef5e017f6cde447de8e3431ba464d65abd1b4ee" },
    { name: "20260728201822_finance_v2_foundation", checksum: "a412be32222d42b57512a5a858ffdb54cecbd32b2558ae52f7b71dc766824e5c" },
    { name: "20260730152134_finance_reported_actuals_foundation", checksum: "53035c59ea21bea1a790b45d8163c416d609826fd34d7cf8d20ded2d77e5da70" },
    { name: "20260730162229_finance_import_review_records", checksum: "0ecfe668d7d36b867d12d8b088e0c5b127e7b09ff77fd00976918189a74add22" },
    { name: "20260730174253_finance_import_application_profiles", checksum: "8e38a16e74e15134d65d2c76f60017238bc4f1b2e0319342921b5a01522aa932" },
    { name: "20260730193953_knowledge_access_domains", checksum: "5b7f7002fcdf80dde3c67902d1f9eca7cf8be35c7848a46b05326489f8149307" },
    { name: "20260730224338_knowledge_chunk_access_domains", checksum: "3e2356eaf94539ed2721adfb391694d66e908775f037741fb254cbe5896f3151" },
    { name: "20260802012653_finance_import_interpretation_state", checksum: "8df3fed1d440ae44b811dc6023b52aac1834dc35020e5dd23bb45d2e9bfb42ae" },
    { name: "20260807170302_provider_cutovers", checksum: "536002b60bd856506cd3e1bd8c5c3a36103de659bc55244458a4353692c9c857" },
    { name: "20260810190000_customer_deployment_release_lease", checksum: "e99658685051db40b56bf60942f55e18c2431915c18f5cf6cc13dca73e9ec3e2" },
    { name: "20260810200000_customer_deployment_release_lease_eligibility", checksum: "0b3e273d4aaf592caa1b7c6e61a704a720ec12b6d44e046c68cf6ae344894d3d" },
    { name: "20260810210000_customer_deployment_release_lease_delete_guard", checksum: "830d7990ad69491f0d9d74c8eddf8425008a47eb953c260f1005d7c3c358e080" },
    { name: "20260810220000_communication_entity_link_claim_key", checksum: "65304f4763fcdf0c20cf2b546001345d8326dc8bafbbcbb5f8f5aaff43d2c1b6" },
    { name: "20260810224717_constitution_source_references", checksum: "e8ab208898b6d0542ebd0e04ef8f4b73718f76c87907db591f56a9201f23bef6" },
    { name: "20260810230000_customer_deployment_release_lease_update_guard", checksum: "d48ea291cf987665edac5841989a11281bf9f2bc9efe17c0f2144f851b881817" },
    { name: "20260811180152_crm_activity_archive", checksum: "5f016482f07b6b553a4840b89ea7d7a924350532d47f32ba95657299e0d3e01f" },
    { name: "20260813200000_tenant_purge_run_ledger", checksum: "5518ec7df1557698d2d97f10de4aa4c9d6679bfbf2999f74cc2423c4887f41c6" },
    { name: "20260904000000_hosted_azure_release_lease_eligibility", checksum: "15d674b92dc6e67ec86ec14a3008528f4360aac298b5f68ed2b2cb179a06ec88" },
  ];
  function historical() {
    const migrations = structuredClone(migrationFixture);
    const manifest = { migrations, manifestSha256: identityHash(migrations),
      datamodelSha256: "af7ad71cad045dcb2c41358fbf5e13160e2e77b220208b70420fadbd7e21ac03" };
    const rows = migrations.map((item) => ({ migration_name: item.name,
      checksum: item.name === policy.migration ? policy.appliedChecksum : item.checksum,
      finished_at: "done", rolled_back_at: null }));
    return { manifest, rows };
  }
  const audited = historical();
  it("binds the complete audited manifest and records non-exact acceptance without historical data certification", () => {
    expect(migrationFixture).toHaveLength(147);
    expect(audited.manifest.manifestSha256).toBe("a5d5fa95e7569cf05113b57d8917135fff171633e144ea453924202771b00fed");
    expect(policy.appliedChecksum).toBe("570ac368fa8994eb9c6ff751eb40172bfb03aeabc511d7d063de0fe93925caa1");
    expect(migrationFixture.find((item) => item.name === policy.migration).checksum)
      .toBe("614cdf040b15f381255592683128686d90904182721ca117ba43975dd1927e26");
    expect(verifyLedger(audited.manifest, audited.rows, policy.sourceSha)).toEqual({ exactLedgerMatch: false, historicalLedgerException: policy });
  });
  it.each(["source", "manifest", "datamodel", "sql", "name", "checksum", "second", "missing", "duplicate", "unfinished", "rolledback"])("rejects %s drift", (kind) => {
    const { manifest, rows } = structuredClone(audited);
    let source = policy.sourceSha;
    const row = rows.find((item) => item.migration_name === policy.migration);
    if (kind === "source") source = SOURCE;
    if (kind === "manifest") manifest.manifestSha256 = HASH;
    if (kind === "datamodel") manifest.datamodelSha256 = HASH;
    if (kind === "sql") manifest.migrations[0].checksum = HASH;
    if (kind === "name") row.migration_name = "other";
    if (kind === "checksum") row.checksum = HASH;
    if (kind === "second") rows[0].checksum = HASH;
    if (kind === "missing") rows.pop();
    if (kind === "duplicate") rows.push({ ...row });
    if (kind === "unfinished") row.finished_at = null;
    if (kind === "rolledback") rows.push({ ...row, rolled_back_at: "done" });
    expect(() => verifyLedger(manifest, rows, source)).toThrow("LEDGER_NOT_EXACT");
  });
  function accepted() {
    const f = fixture();
    f.evidence.sourceSha = policy.sourceSha;
    for (const role of ["web", "worker"]) f.evidence.buildProof.roles[role].sourceSha = policy.sourceSha;
    f.pin.sourceSha = policy.sourceSha;
    f.receipt.acceptance.evidenceSha256 = identityHash(f.evidence);
    f.receipt.schema = { manifestSha256: policy.manifestSha256, datamodelSha256: policy.datamodelSha256,
      ...verifyLedger(audited.manifest, audited.rows, policy.sourceSha), supportedSchemaMatch: true };
    return f;
  }
  it("accepts only the exact exception receipt and preserves provider/auth bracketing", async () => {
    const f = accepted(), calls = [];
    expect(validateReceipt(f.receipt, f.pin)).toBe(f.receipt);
    await checkBaseline(f.evidence, { expectedSchema: f.receipt.schema, bootstrap: true, deps: {
      provider: async () => calls.push("provider"), database: async () => f.receipt.schema,
      retainedAuth: async () => calls.push("auth"),
    } });
    expect(calls).toEqual(["provider", "auth", "provider"]);
    await expect(checkBaseline(f.evidence, { expectedSchema: f.receipt.schema, deps: {
      provider: async () => {}, database: async () => ({ manifestSha256: policy.manifestSha256,
        datamodelSha256: policy.datamodelSha256, exactLedgerMatch: true, supportedSchemaMatch: true }),
    } })).rejects.toThrow("SOURCE_SCHEMA_MISMATCH");
  });
  it.each(["marker", "source", "schema", "exact", "certification"])("rejects altered receipt %s", (kind) => {
    const f = accepted();
    if (kind === "marker") delete f.receipt.schema.historicalLedgerException;
    if (kind === "source") f.evidence.sourceSha = SOURCE;
    if (kind === "schema") f.receipt.schema.supportedSchemaMatch = false;
    if (kind === "exact") f.receipt.schema.exactLedgerMatch = true;
    if (kind === "certification") f.receipt.schema.historicalLedgerException.historicalRowCorrectnessCertified = true;
    expect(() => validateReceipt(f.receipt, f.pin)).toThrow();
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
