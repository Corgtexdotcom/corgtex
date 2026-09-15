#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, writeFile, mkdir, mkdtemp, rm, readdir, access } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

export const BASELINE_CONFIG = ".github/accepted-core-baseline.json";
export const BASELINE_WORKFLOW = ".github/workflows/accepted-core-baseline.yml";
export const BASELINE_SMOKE_STEP = "Verify accepted Core provider, health, auth and schema using pinned verifier and source";
const REPOSITORY = "Corgtexdotcom/corgtex";
const ORIGIN = "https://app.corgtex.com";
const SHA = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const ROLES = ["web", "worker"];
const ARTIFACT_DIR = ".artifacts/core-baseline";
// Explicit historical disposition, not an input-controlled checksum allowlist.
export const CORE_HISTORICAL_LEDGER = Object.freeze({
  sourceSha: "d0a3896ef917b50f2fec2d797908f29aa026a058",
  manifestSha256: "a5d5fa95e7569cf05113b57d8917135fff171633e144ea453924202771b00fed",
  datamodelSha256: "af7ad71cad045dcb2c41358fbf5e13160e2e77b220208b70420fadbd7e21ac03",
  migration: "20260617120000_drop_legacy_proposal_reactions",
  sourceChecksum: "614cdf040b15f381255592683128686d90904182721ca117ba43975dd1927e26",
  appliedChecksum: "570ac368fa8994eb9c6ff751eb40172bfb03aeabc511d7d063de0fe93925caa1",
  historicalRowCorrectnessCertified: false,
});
const fail = (code) => { throw new Error(`CORE_BASELINE_${code}`); };
const requireThat = (condition, code) => { if (!condition) fail(code); };
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const canonical = (value) => JSON.stringify(value, (_, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
export const identityHash = (value) => sha256(canonical(value));
const integer = (value) => Number.isSafeInteger(value) && value > 0;
const date = (value) => typeof value === "string" && Number.isFinite(Date.parse(value));

function keys(value, expected) {
  requireThat(value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join(",") === [...expected].sort().join(","), "INVALID_FIELDS");
}

export function validatePin(pin) {
  keys(pin, ["schemaVersion", "target", "targetSha256", "sourceSha", "verifierSha", "receiptSha256", "run", "artifact"]);
  keys(pin.run, ["id", "attempt", "workflowId", "workflowSha"]);
  keys(pin.artifact, ["id", "name", "sha256"]);
  requireThat(pin.schemaVersion === 1 && pin.target === "backup-app" && HASH.test(pin.targetSha256)
    && SHA.test(pin.sourceSha) && SHA.test(pin.verifierSha) && HASH.test(pin.receiptSha256)
    && integer(pin.run.id) && integer(pin.run.attempt) && integer(pin.run.workflowId)
    && pin.run.workflowSha === pin.verifierSha && integer(pin.artifact.id) && HASH.test(pin.artifact.sha256)
    && pin.artifact.name === `accepted-core-baseline-${pin.run.id}-${pin.run.attempt}`, "INVALID_PIN");
  return pin;
}

export async function readPin(path = BASELINE_CONFIG) {
  let bytes;
  try { bytes = await readFile(path, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  requireThat(bytes.length <= 8192, "PIN_TOO_LARGE");
  return validatePin(JSON.parse(bytes));
}

export function validateTarget(target) {
  keys(target, ["id", "origin", "provider", "projectId", "environmentId", "webServiceId", "workerServiceId", "databaseIdentitySha256"]);
  requireThat(target.id === "backup-app" && target.origin === ORIGIN && target.provider === "railway"
    && [target.projectId, target.environmentId, target.webServiceId, target.workerServiceId].every((id) => UUID.test(id))
    && target.webServiceId !== target.workerServiceId && HASH.test(target.databaseIdentitySha256), "TARGET_INVALID");
}

export function validateEvidence(input) {
  keys(input, ["target", "sourceSha", "images", "buildProof", "authProof"]);
  validateTarget(input.target);
  requireThat(SHA.test(input.sourceSha), "SOURCE_INVALID");
  keys(input.images, ROLES);
  keys(input.buildProof, ["kind", "evidenceSha256", "observedAt", "roles"]);
  keys(input.buildProof.roles, ROLES);
  requireThat(input.buildProof.kind === "direct-container-build-readback" && HASH.test(input.buildProof.evidenceSha256)
    && date(input.buildProof.observedAt), "BUILD_PROOF_INVALID");
  for (const role of ROLES) {
    keys(input.images[role], ["deploymentId", "digest"]);
    keys(input.buildProof.roles[role], ["deploymentId", "sourceSha"]);
    requireThat(UUID.test(input.images[role].deploymentId) && /^sha256:[a-f0-9]{64}$/.test(input.images[role].digest)
      && input.buildProof.roles[role].sourceSha === input.sourceSha
      && input.buildProof.roles[role].deploymentId === input.images[role].deploymentId, "BUILD_IMAGE_BINDING_INVALID");
  }
  const baselineAuth = input.authProof?.kind === "protected-review-retained-baseline-auth";
  keys(input.authProof, ["kind", "runId", "runAttempt", "jobId", "stepNumber", "workflowSha", "evidenceSha256", "observedAt", "origin", "checks",
    ...(baselineAuth ? ["baseline"] : [])]);
  requireThat([input.authProof.runId, input.authProof.runAttempt, input.authProof.jobId].every(integer)
    && (baselineAuth || input.authProof.kind === "protected-review-retained-core-auth") && integer(input.authProof.stepNumber)
    && SHA.test(input.authProof.workflowSha)
    && HASH.test(input.authProof.evidenceSha256) && date(input.authProof.observedAt)
    && input.authProof.origin === input.target.origin, "AUTH_PROOF_INVALID");
  keys(input.authProof.checks, ["health", "releaseMetadata", "loginPage", "login", "session", "rootFlow"]);
  requireThat(Object.values(input.authProof.checks).every((value) => value === true), "AUTH_PROOF_INCOMPLETE");
  if (baselineAuth) {
    const baseline = input.authProof.baseline;
    keys(baseline, ["sourceSha", "targetSha256", "imagesSha256", "verifierSha", "receiptSha256"]);
    requireThat(baseline.sourceSha === input.sourceSha && baseline.targetSha256 === identityHash(input.target)
      && baseline.imagesSha256 === identityHash(input.images) && SHA.test(baseline.verifierSha)
      && HASH.test(baseline.receiptSha256), "AUTH_BASELINE_BINDING_INVALID");
  }
  return input;
}

export function validateReceipt(receipt, pin) {
  keys(receipt, ["schemaVersion", "kind", "accepted", "evidence", "schema", "acceptance"]);
  requireThat(receipt.schemaVersion === 1 && receipt.kind === "accepted-core-baseline" && receipt.accepted === true, "NOT_ACCEPTED");
  validateEvidence(receipt.evidence);
  validateSchemaAcceptance(receipt.schema, receipt.evidence.sourceSha);
  keys(receipt.acceptance, ["repository", "workflowPath", "workflowSha", "runId", "runAttempt", "acceptedAt", "evidenceSha256"]);
  const acceptance = receipt.acceptance;
  requireThat(acceptance.repository === REPOSITORY && acceptance.workflowPath === BASELINE_WORKFLOW
    && acceptance.workflowSha === pin.verifierSha && acceptance.runId === pin.run.id && acceptance.runAttempt === pin.run.attempt
    && date(acceptance.acceptedAt) && acceptance.evidenceSha256 === identityHash(receipt.evidence)
    && receipt.evidence.sourceSha === pin.sourceSha && identityHash(receipt.evidence.target) === pin.targetSha256, "RECEIPT_BINDING_INVALID");
  return receipt;
}

export function validateProvenance(pin, { run, attempt, workflow, artifact, artifacts }, now = Date.now()) {
  validatePin(pin);
  for (const record of [run, attempt]) {
    requireThat(record?.id === pin.run.id && record.run_attempt === pin.run.attempt && record.workflow_id === pin.run.workflowId
      && record.path === BASELINE_WORKFLOW && record.head_sha === pin.verifierSha && record.head_branch === "main"
      && record.event === "workflow_dispatch" && record.status === "completed" && record.conclusion === "success"
      && record.repository?.full_name === REPOSITORY && record.head_repository?.full_name === REPOSITORY, "UNTRUSTED_PRODUCER");
  }
  requireThat(workflow?.id === pin.run.workflowId && workflow.path === BASELINE_WORKFLOW && workflow.state === "active", "WORKFLOW_MISMATCH");
  requireThat(artifact?.id === pin.artifact.id && artifact.name === pin.artifact.name && artifact.expired === false
    && artifact.digest === `sha256:${pin.artifact.sha256}` && date(artifact.expires_at) && Date.parse(artifact.expires_at) > now
    && artifact.workflow_run?.id === pin.run.id && artifact.workflow_run?.head_sha === pin.verifierSha
    && artifact.workflow_run?.head_branch === "main" && artifact.workflow_run?.head_repository_id === run.head_repository.id
    && artifact.workflow_run?.repository_id === run.repository.id
    && date(artifact.created_at) && date(attempt.run_started_at) && date(attempt.updated_at)
    && Date.parse(artifact.created_at) >= Date.parse(attempt.run_started_at)
    && Date.parse(artifact.created_at) <= Date.parse(attempt.updated_at), "ARTIFACT_BINDING_INVALID");
  // A rerun invalidates the pin. Never guess which attempt produced a same-name artifact.
  requireThat(artifacts?.total_count <= 100 && Array.isArray(artifacts.artifacts)
    && artifacts.artifacts.filter((item) => item.name === pin.artifact.name).length === 1
    && artifacts.artifacts.some((item) => item.id === pin.artifact.id && item.name === pin.artifact.name), "ARTIFACT_AMBIGUOUS");
}

async function githubJson(path, env = process.env, fetchImpl = fetch) {
  requireThat(env.GITHUB_TOKEN && env.GITHUB_REPOSITORY === REPOSITORY, "GITHUB_READ_CONTEXT_REQUIRED");
  const response = await fetchImpl(`https://api.github.com/repos/${REPOSITORY}/${path}`, {
    headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: "application/vnd.github+json" },
    redirect: "error", signal: AbortSignal.timeout(30_000),
  });
  requireThat(response.ok, "GITHUB_READ_FAILED");
  return response.json();
}

async function downloadReceipt(pin, env = process.env) {
  const response = await fetch(`https://api.github.com/repos/${REPOSITORY}/actions/artifacts/${pin.artifact.id}/zip`, {
    headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}` }, redirect: "manual", signal: AbortSignal.timeout(30_000),
  });
  requireThat(response.status === 302, "ARTIFACT_DOWNLOAD_FAILED");
  const location = new URL(response.headers.get("location"));
  requireThat(location.protocol === "https:" && !location.username && !location.password, "ARTIFACT_REDIRECT_INVALID");
  // Do not forward the GitHub credential to artifact storage.
  const archive = await fetch(location, { redirect: "error", signal: AbortSignal.timeout(30_000) });
  requireThat(archive.ok, "ARTIFACT_DOWNLOAD_FAILED");
  const chunks = [];
  let size = 0;
  for await (const chunk of archive.body) {
    size += chunk.length;
    requireThat(size <= 1_000_000, "ARTIFACT_TOO_LARGE");
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  requireThat(sha256(bytes) === pin.artifact.sha256, "ARTIFACT_HASH_MISMATCH");
  const directory = await mkdtemp(join(tmpdir(), "core-baseline-"));
  try {
    const path = join(directory, "receipt.zip");
    await writeFile(path, bytes, { mode: 0o600 });
    const names = execFileSync("unzip", ["-Z1", path], { encoding: "utf8", maxBuffer: 4096 }).trim();
    requireThat(names === "receipt.json", "ARTIFACT_CONTENTS_INVALID");
    return execFileSync("unzip", ["-p", path, "receipt.json"], { maxBuffer: 64_000 });
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export async function resolveBaseline(pin, { api = githubJson, download = downloadReceipt, persist, now = Date.now() } = {}) {
  if (pin === null) return null;
  validatePin(pin);
  const run = await api(`actions/runs/${pin.run.id}`);
  const attempt = await api(`actions/runs/${pin.run.id}/attempts/${pin.run.attempt}`);
  const workflow = await api(`actions/workflows/${pin.run.workflowId}`);
  const artifact = await api(`actions/artifacts/${pin.artifact.id}`);
  const artifacts = await api(`actions/runs/${pin.run.id}/artifacts?per_page=100`);
  validateProvenance(pin, { run, attempt, workflow, artifact, artifacts }, now);
  const bytes = await download(pin);
  requireThat(bytes.length <= 64_000 && sha256(bytes) === pin.receiptSha256, "RECEIPT_HASH_MISMATCH");
  const receipt = validateReceipt(JSON.parse(bytes.toString("utf8")), pin);
  requireThat(Date.parse(receipt.acceptance.acceptedAt) >= Date.parse(attempt.run_started_at)
    && Date.parse(receipt.acceptance.acceptedAt) <= Date.parse(artifact.created_at), "ACCEPTANCE_TIME_INVALID");
  if (persist) await persist(bytes);
  return receipt;
}

export function migrationManifest(sourceDir) {
  const git = (args) => execFileSync("git", args, { cwd: sourceDir, maxBuffer: 8_000_000 });
  const paths = git(["ls-tree", "-r", "--name-only", "HEAD", "--", "prisma/migrations"]).toString().trim().split("\n")
    .filter((path) => /^prisma\/migrations\/[^/]+\/migration\.sql$/.test(path)).sort();
  requireThat(paths.length > 0 && paths.length <= 10000, "SOURCE_MIGRATIONS_INVALID");
  const migrations = paths.map((path) => ({ name: path.split("/")[2], checksum: sha256(git(["show", `HEAD:${path}`])) }));
  return { migrations, manifestSha256: identityHash(migrations), datamodelSha256: sha256(git(["show", "HEAD:prisma/schema.prisma"])) };
}

function historicalSource(manifest, sourceSha) {
  return sourceSha === CORE_HISTORICAL_LEDGER.sourceSha
    && manifest.manifestSha256 === CORE_HISTORICAL_LEDGER.manifestSha256
    && manifest.datamodelSha256 === CORE_HISTORICAL_LEDGER.datamodelSha256;
}

function validateSchemaAcceptance(schema, sourceSha) {
  keys(schema, ["manifestSha256", "datamodelSha256", "exactLedgerMatch", "supportedSchemaMatch",
    ...(Object.hasOwn(schema, "historicalLedgerException") ? ["historicalLedgerException"] : [])]);
  const historical = schema.exactLedgerMatch === false && historicalSource(schema, sourceSha)
    && canonical(schema.historicalLedgerException) === canonical(CORE_HISTORICAL_LEDGER);
  requireThat(HASH.test(schema.manifestSha256) && HASH.test(schema.datamodelSha256)
    && schema.supportedSchemaMatch === true
    && (historical || (schema.exactLedgerMatch === true && !Object.hasOwn(schema, "historicalLedgerException"))), "SCHEMA_NOT_ACCEPTED");
}

export function verifyLedger(manifest, rows, sourceSha) {
  requireThat(Array.isArray(rows) && rows.length <= 10000, "LEDGER_UNBOUNDED");
  const applied = rows.filter((row) => row.finished_at != null && row.rolled_back_at == null);
  requireThat(rows.every((row) => row.finished_at != null || row.rolled_back_at != null)
    && applied.length === manifest.migrations.length && new Set(applied.map((row) => row.migration_name)).size === applied.length,
  "LEDGER_NOT_EXACT");
  const checksums = new Map(applied.map((row) => [row.migration_name, row.checksum]));
  const mismatches = manifest.migrations.filter((item) => checksums.get(item.name) !== item.checksum);
  if (mismatches.length === 0) return { exactLedgerMatch: true };
  const exception = CORE_HISTORICAL_LEDGER;
  requireThat(historicalSource(manifest, sourceSha) && identityHash(manifest.migrations) === exception.manifestSha256
    && rows.length === applied.length && mismatches.length === 1
    && mismatches[0].name === exception.migration && mismatches[0].checksum === exception.sourceChecksum
    && checksums.get(exception.migration) === exception.appliedChecksum, "LEDGER_NOT_EXACT");
  return { exactLedgerMatch: false, historicalLedgerException: { ...exception } };
}

export function databaseIdentity(url) {
  const parsed = new URL(url);
  requireThat(["postgres:", "postgresql:"].includes(parsed.protocol) && parsed.pathname.length > 1, "DATABASE_URL_INVALID");
  requireThat((parsed.searchParams.get("schema") || "public") === "public", "DATABASE_SCHEMA_UNSUPPORTED");
  return identityHash({ host: parsed.hostname, port: parsed.port || "5432", database: parsed.pathname.slice(1), schema: "public" });
}

function verifySource(sourceDir, expectedSha) {
  const actual = execFileSync("git", ["rev-parse", "HEAD"], { cwd: sourceDir, encoding: "utf8" }).trim();
  requireThat(actual === expectedSha, "SOURCE_CHECKOUT_MISMATCH");
  requireThat(execFileSync("git", ["diff", "--name-only", "HEAD", "--", "prisma", "scripts", "package.json", "package-lock.json"],
    { cwd: sourceDir, encoding: "utf8" }).trim() === "", "SOURCE_CHECKOUT_DIRTY");
}

export function assertProviderBinding(evidence, role, data) {
  const expected = evidence.images[role];
  const active = data?.instance?.activeDeployments;
  const latest = data?.instance?.latestDeployment;
  const nodes = data?.deployments?.edges?.map((edge) => edge.node);
  requireThat(Array.isArray(active) && active.length === 1
    && active[0].id === expected.deploymentId && active[0].status === "SUCCESS"
    && latest?.id === expected.deploymentId && latest.status === "SUCCESS" && nodes?.length === 1
    && nodes[0].id === expected.deploymentId && nodes[0].status === "SUCCESS"
    && nodes[0].meta?.imageDigest === expected.digest, "PROVIDER_DRIFT");
}

export async function verifyProvider(evidence, env = process.env, fetchImpl = fetch) {
  const configured = JSON.parse(env.FLEET_RELEASE_BACKUP_APP_TARGET_JSON || "null");
  requireThat(configured?.provider === "railway" && configured.url === evidence.target.origin
    && ["projectId", "environmentId", "webServiceId", "workerServiceId"].every((key) => configured.railway?.[key] === evidence.target[key]), "CONFIGURED_TARGET_MISMATCH");
  requireThat(env.RAILWAY_API_TOKEN, "PROVIDER_READ_CREDENTIAL_REQUIRED");
  for (const role of ROLES) {
    const response = await fetchImpl("https://backboard.railway.com/graphql/v2", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.RAILWAY_API_TOKEN}` },
      signal: AbortSignal.timeout(30_000), redirect: "error",
      body: JSON.stringify({ query: `query CoreBaseline($projectId: String!, $environmentId: String!, $serviceId: String!) {
        instance: serviceInstance(environmentId: $environmentId, serviceId: $serviceId) {
          latestDeployment { id status } activeDeployments { id status }
        }
        deployments(first: 1, input: { projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId }) {
          edges { node { id status meta } }
        }
      }`, variables: { projectId: evidence.target.projectId, environmentId: evidence.target.environmentId, serviceId: evidence.target[`${role}ServiceId`] } }),
    });
    requireThat(response.ok, "PROVIDER_READ_FAILED");
    const payload = await response.json();
    requireThat(!payload.errors, "PROVIDER_READ_FAILED");
    assertProviderBinding(evidence, role, payload.data);
  }
}

export function validateAuthProvenance(evidence, authRun, job, baselinePin = null) {
  validateEvidence(evidence);
  const proof = evidence.authProof;
  const step = job.steps?.find((item) => item.number === proof.stepNumber);
  const baselineAuth = proof.kind === "protected-review-retained-baseline-auth";
  if (baselineAuth) {
    validatePin(baselinePin);
    requireThat(baselinePin.sourceSha === proof.baseline.sourceSha && baselinePin.targetSha256 === proof.baseline.targetSha256
      && baselinePin.verifierSha === proof.baseline.verifierSha && baselinePin.receiptSha256 === proof.baseline.receiptSha256,
    "AUTH_BASELINE_BINDING_INVALID");
  }
  // GitHub job timestamps normally have whole-second precision. Accept that
  // final second, not an extra second after a fractional-precision timestamp.
  const endPrecisionMs = /:\d{2}Z$/.test(step?.completed_at ?? "") ? 1000 : 1;
  requireThat(authRun.id === proof.runId && authRun.run_attempt === proof.runAttempt && authRun.conclusion === "success"
    && authRun.status === "completed" && authRun.event === "push" && authRun.path === ".github/workflows/ci.yml" && authRun.head_branch === "main"
    && authRun.head_repository?.full_name === REPOSITORY && authRun.repository?.full_name === REPOSITORY
    && authRun.head_sha === proof.workflowSha && job.run_id === proof.runId && job.run_attempt === proof.runAttempt
    && job.id === proof.jobId && job.name === "Production Smoke Test" && job.conclusion === "success" && job.head_sha === proof.workflowSha
    && step?.conclusion === "success" && (baselineAuth ? step.name === BASELINE_SMOKE_STEP
      : step.name.startsWith(`Run node scripts/railway-smoke.mjs ${ORIGIN} `))
    && Date.parse(proof.observedAt) >= Date.parse(step.started_at)
    && Date.parse(proof.observedAt) < Date.parse(step.completed_at) + endPrecisionMs, "AUTH_PROVENANCE_INVALID");
}

async function verifyRetainedAuth(evidence, env = process.env) {
  const proof = evidence.authProof;
  const run = await githubJson(`actions/runs/${proof.runId}/attempts/${proof.runAttempt}`, env);
  const job = await githubJson(`actions/jobs/${proof.jobId}`, env);
  let pin = null;
  if (proof.kind === "protected-review-retained-baseline-auth") {
    const file = await githubJson(`contents/${BASELINE_CONFIG}?ref=${proof.workflowSha}`, env);
    requireThat(file.encoding === "base64" && file.size <= 8192 && file.path === BASELINE_CONFIG, "AUTH_BASELINE_CONFIG_INVALID");
    pin = JSON.parse(Buffer.from(file.content, "base64").toString("utf8"));
  }
  validateAuthProvenance(evidence, run, job, pin);
  for (const observedAt of [proof.observedAt, evidence.buildProof.observedAt]) {
    requireThat(Date.now() - Date.parse(observedAt) >= 0 && Date.now() - Date.parse(observedAt) <= 86400000, "BOOTSTRAP_EVIDENCE_STALE");
  }
}

export async function checkBaseline(evidence, { sourceDir, expectedSchema, bootstrap = false, env = process.env, deps = {} }) {
  const provider = deps.provider ?? verifyProvider;
  await provider(evidence, env);
  const schema = await (deps.database ?? verifyDatabase)(evidence, sourceDir, expectedSchema, env);
  validateSchemaAcceptance(schema, evidence.sourceSha);
  if (expectedSchema) requireThat(canonical(schema) === canonical(expectedSchema), "SOURCE_SCHEMA_MISMATCH");
  if (bootstrap) await (deps.retainedAuth ?? verifyRetainedAuth)(evidence, env);
  else await (deps.smoke ?? smoke)(evidence, sourceDir, env);
  await provider(evidence, env);
  return schema;
}

async function verifyDatabase(evidence, sourceDir, expectedSchema, env = process.env) {
  verifySource(sourceDir, evidence.sourceSha);
  const schemaEngine = await preparedSchemaEngine(sourceDir);
  const manifest = migrationManifest(sourceDir);
  if (expectedSchema) requireThat(expectedSchema.manifestSha256 === manifest.manifestSha256
    && expectedSchema.datamodelSha256 === manifest.datamodelSha256, "SOURCE_SCHEMA_MISMATCH");
  requireThat(databaseIdentity(env.DATABASE_URL) === evidence.target.databaseIdentitySha256, "DATABASE_TARGET_MISMATCH");
  const url = new URL(env.DATABASE_URL);
  url.searchParams.set("options", "-c default_transaction_read_only=on -c statement_timeout=5000 -c lock_timeout=1000");
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: url.toString(), connectionTimeoutMillis: 10000 });
  let ledger;
  try {
    await client.connect();
    await client.query("BEGIN READ ONLY");
    const settings = await client.query("SELECT current_database() AS database, current_schema() AS schema, current_setting('default_transaction_read_only') AS default_read_only, current_setting('transaction_read_only') AS read_only");
    requireThat(settings.rows[0]?.database === decodeURIComponent(url.pathname.slice(1)) && settings.rows[0]?.schema === "public"
      && settings.rows[0]?.default_read_only === "on" && settings.rows[0]?.read_only === "on", "DATABASE_READ_GUARD_FAILED");
    const rows = await client.query("SELECT migration_name, checksum, finished_at, rolled_back_at FROM _prisma_migrations ORDER BY migration_name LIMIT 10001");
    ledger = verifyLedger(manifest, rows.rows, evidence.sourceSha);
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    await client.end();
  }
  // Use the accepted datamodel and its installed Prisma, never candidate models.
  execFileSync(join(sourceDir, "node_modules/.bin/prisma"), ["migrate", "diff", "--from-schema-datasource", "prisma/schema.prisma",
    "--to-schema-datamodel", "prisma/schema.prisma", "--exit-code"], {
    cwd: sourceDir, timeout: 60000, maxBuffer: 64000, stdio: "pipe", env: { PATH: env.PATH, HOME: env.HOME, DATABASE_URL: url.toString(),
      PRISMA_SCHEMA_ENGINE_BINARY: schemaEngine, CHECKPOINT_DISABLE: "1", PRISMA_HIDE_UPDATE_MESSAGE: "1",
      // Engines must already exist. A missing secondary dependency must fail,
      // not trigger external engine downloads in a credentialed step.
      PRISMA_ENGINES_MIRROR: "http://127.0.0.1:9" },
  });
  return { manifestSha256: manifest.manifestSha256, datamodelSha256: manifest.datamodelSha256,
    ...ledger, supportedSchemaMatch: true };
}

export async function preparedSchemaEngine(sourceDir) {
  const directory = join(sourceDir, "node_modules/@prisma/engines");
  const files = (await readdir(directory, { withFileTypes: true })).filter((entry) => entry.isFile()
    && entry.name.startsWith("schema-engine-") && !/\.(sha256|gz|zip)$/.test(entry.name));
  requireThat(files.length === 1, "PRISMA_ENGINE_NOT_PREPARED");
  const path = join(directory, files[0].name);
  await access(path, constants.X_OK);
  return path;
}

async function smoke(evidence, sourceDir, env = process.env) {
  verifySource(sourceDir, evidence.sourceSha);
  requireThat(env.ADMIN_EMAIL && env.ADMIN_PASSWORD, "AUTH_CREDENTIALS_REQUIRED");
  // Older accepted smoke scripts take positional credentials. Populate argv only
  // inside the child, not in the OS command line or shell, and suppress raw output.
  const stdout = execFileSync(process.execPath, ["--input-type=module", "-e", `
    import { pathToFileURL } from "node:url";
    process.argv = [process.execPath, "scripts/railway-smoke.mjs", process.env.APP_URL, process.env.ADMIN_EMAIL, process.env.ADMIN_PASSWORD];
    await import(pathToFileURL(process.cwd() + "/scripts/railway-smoke.mjs"));
  `], { cwd: sourceDir, timeout: 180000, maxBuffer: 128000, stdio: "pipe", env: { PATH: env.PATH,
    ADMIN_EMAIL: env.ADMIN_EMAIL, ADMIN_PASSWORD: env.ADMIN_PASSWORD, GITHUB_SHA: evidence.sourceSha,
    APP_URL: evidence.target.origin, CORGTEX_EXPECTED_RELEASE_GIT_SHA: evidence.sourceSha,
    CORGTEX_SKIP_RELEASE_MATCH: "false", CORGTEX_RELEASE_MATCH_TIMEOUT_MS: "60000" } });
  verifiedSmokeChecks(stdout.toString("utf8"));
}

export function verifiedSmokeChecks(stdout) {
  const messages = {
    health: "/api/health reports the Corgtex fingerprint",
    releaseMetadata: "/api/health release configured metadata matches runtime metadata",
    loginPage: "/login serves the Corgtex login page",
    login: "/api/auth/login accepted the seeded admin credentials",
    session: "/api/session resolves the logged-in actor and workspaces",
    rootFlow: "/ resolves into the authenticated workspace flow",
  };
  const lines = new Set(stdout.split(/\r?\n/).filter((line) => /^OK\s+/.test(line)).map((line) => line.replace(/^OK\s+/, "")));
  requireThat(Object.values(messages).every((message) => lines.has(message)), "AUTH_SMOKE_PROOF_INCOMPLETE");
  return Object.fromEntries(Object.keys(messages).map((key) => [key, true]));
}

export function baselineSmokeEvidence(evidence, pin, env = process.env, observedAt = new Date().toISOString()) {
  validateEvidence(evidence);
  validatePin(pin);
  requireThat(pin.sourceSha === evidence.sourceSha && pin.targetSha256 === identityHash(evidence.target), "AUTH_BASELINE_BINDING_INVALID");
  requireThat(SHA.test(env.GITHUB_SHA) && integer(Number(env.GITHUB_RUN_ID)) && integer(Number(env.GITHUB_RUN_ATTEMPT))
    && env.GITHUB_JOB === "smoke-prod", "AUTH_SMOKE_RUN_INVALID");
  return { schemaVersion: 1, kind: "core-baseline-auth-smoke-success", repository: REPOSITORY,
    runId: Number(env.GITHUB_RUN_ID), runAttempt: Number(env.GITHUB_RUN_ATTEMPT), workflowSha: env.GITHUB_SHA,
    job: "smoke-prod", stepName: BASELINE_SMOKE_STEP, origin: evidence.target.origin, observedAt,
    baseline: { sourceSha: evidence.sourceSha, targetSha256: identityHash(evidence.target), imagesSha256: identityHash(evidence.images),
      verifierSha: pin.verifierSha, receiptSha256: pin.receiptSha256 },
    checks: { health: true, releaseMetadata: true, loginPage: true, login: true, session: true, rootFlow: true } };
}

async function output(values) {
  const lines = Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n") + "\n";
  if (process.env.GITHUB_OUTPUT) await writeFile(process.env.GITHUB_OUTPUT, lines, { flag: "a" });
}

function trustedMain(env = process.env) {
  requireThat(env.GITHUB_REPOSITORY === REPOSITORY && env.GITHUB_REF === "refs/heads/main"
    && ["push", "workflow_dispatch", "workflow_run", "schedule"].includes(env.GITHUB_EVENT_NAME), "TRUSTED_MAIN_REQUIRED");
}

function ancestor(sha) {
  requireThat(SHA.test(sha), "SOURCE_INVALID");
  execFileSync("git", ["merge-base", "--is-ancestor", sha, "HEAD"], { stdio: "pipe" });
}

export async function main(mode = process.argv[2]) {
  if (mode === "recovery-policy") {
    const sha = process.env.FAILED_SHA;
    requireThat(SHA.test(sha), "FAILED_SHA_INVALID");
    // Absence alone preserves legacy recovery. Presence (even invalid content)
    // cannot authorize reverting a source candidate never deployed to Core.
    const paths = execFileSync("git", ["ls-tree", "--name-only", sha, "--", BASELINE_CONFIG], { encoding: "utf8" }).trim();
    await output({ automatic_revert_allowed: paths ? "false" : "true" });
    if (paths) {
      const message = "Core baseline failure requires deployed-target reconciliation; source auto-revert attribution is unavailable. Inspect the failed baseline check and provider state; explicit rollout recovery remains unchanged.\n";
      console.log(message.trim());
      if (process.env.GITHUB_STEP_SUMMARY) await writeFile(process.env.GITHUB_STEP_SUMMARY, message, { flag: "a" });
    }
    return;
  }
  trustedMain();
  if (mode === "resolve") {
    const pin = await readPin();
    if (!pin) { await output({ enabled: "false" }); return; }
    ancestor(pin.verifierSha);
    ancestor(pin.sourceSha);
    await resolveBaseline(pin, { persist: async (bytes) => {
      await mkdir(ARTIFACT_DIR, { recursive: true });
      await writeFile(join(ARTIFACT_DIR, "receipt.json"), bytes, { mode: 0o600 });
    } });
    await output({ enabled: "true", source_sha: pin.sourceSha, verifier_sha: pin.verifierSha, receipt_sha256: pin.receiptSha256 });
    return;
  }
  if (mode === "prepare") {
    requireThat(process.env.GITHUB_EVENT_NAME === "workflow_dispatch"
      && process.env.GITHUB_WORKFLOW_REF === `${REPOSITORY}/${BASELINE_WORKFLOW}@refs/heads/main`, "BOOTSTRAP_WORKFLOW_REQUIRED");
    const raw = process.env.BASELINE_EVIDENCE_JSON || "";
    requireThat(raw.length <= 32000, "EVIDENCE_TOO_LARGE");
    const evidence = validateEvidence(JSON.parse(raw));
    ancestor(evidence.sourceSha);
    await mkdir(ARTIFACT_DIR, { recursive: true });
    await writeFile(join(ARTIFACT_DIR, "request.json"), JSON.stringify(evidence), { mode: 0o600 });
    await output({ source_sha: evidence.sourceSha });
    return;
  }
  const sourceDir = resolve(".baseline/source");
  let receipt = null;
  let pin = null;
  if (mode !== "bootstrap") {
    pin = await readPin();
    requireThat(pin, "PIN_REQUIRED");
    const verifierDir = fileURLToPath(new URL("..", import.meta.url));
    verifySource(verifierDir, pin.verifierSha);
    const bytes = await readFile(join(ARTIFACT_DIR, "receipt.json"));
    requireThat(sha256(bytes) === pin.receiptSha256, "RECEIPT_HASH_MISMATCH");
    receipt = validateReceipt(JSON.parse(bytes.toString("utf8")), pin);
  }
  const evidence = receipt?.evidence ?? validateEvidence(JSON.parse(await readFile(join(ARTIFACT_DIR, "request.json"), "utf8")));
  if (mode === "provider") { await verifyProvider(evidence); return; }
  requireThat(mode === "check" || mode === "bootstrap", "MODE_INVALID");
  if (mode === "bootstrap") {
    requireThat(process.env.GITHUB_EVENT_NAME === "workflow_dispatch"
      && process.env.GITHUB_WORKFLOW_REF === `${REPOSITORY}/${BASELINE_WORKFLOW}@refs/heads/main`, "BOOTSTRAP_WORKFLOW_REQUIRED");
    verifySource(fileURLToPath(new URL("..", import.meta.url)), process.env.GITHUB_SHA);
  }
  const schema = await checkBaseline(evidence, { sourceDir, expectedSchema: receipt?.schema, bootstrap: mode === "bootstrap" });
  if (mode === "check") {
    const bytes = JSON.stringify(baselineSmokeEvidence(evidence, pin), null, 2) + "\n";
    await writeFile(join(ARTIFACT_DIR, "auth-smoke.json"), bytes, { mode: 0o600 });
    console.log(`Core baseline sanitized authentication evidence SHA256: ${sha256(bytes)}`);
  }
  if (mode === "bootstrap") {
    const accepted = { schemaVersion: 1, kind: "accepted-core-baseline", accepted: true, evidence, schema,
      acceptance: { repository: REPOSITORY, workflowPath: BASELINE_WORKFLOW, workflowSha: process.env.GITHUB_SHA,
        runId: Number(process.env.GITHUB_RUN_ID), runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT),
        acceptedAt: new Date().toISOString(), evidenceSha256: identityHash(evidence) } };
    await mkdir(join(ARTIFACT_DIR, "accepted"), { recursive: true });
    const bytes = JSON.stringify(accepted, null, 2) + "\n";
    await writeFile(join(ARTIFACT_DIR, "accepted/receipt.json"), bytes, { mode: 0o600 });
    await output({ receipt_sha256: sha256(bytes), target_sha256: identityHash(evidence.target) });
  }
  console.log("Core baseline provider, accepted-source schema and authentication evidence verified; no candidate promotion claimed.");
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(async (error) => {
    // Provider, database, child-process and URL errors may contain credentials.
    const code = /^CORE_BASELINE_[A-Z_]+$/.test(error.message) ? error.message : "CORE_BASELINE_UNVERIFIED";
    if (process.argv[2] === "bootstrap") {
      await mkdir(ARTIFACT_DIR, { recursive: true });
      await writeFile(join(ARTIFACT_DIR, "diagnostic.json"), JSON.stringify({ accepted: false, code }), { mode: 0o600 });
    }
    console.error(code);
    process.exitCode = 1;
  });
}
