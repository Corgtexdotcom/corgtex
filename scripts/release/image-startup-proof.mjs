import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PG16_INDEX } from "../ci-pgvector-image.mjs";

const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const OUTPUT = ".artifacts/image-startup-proof";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const requireProof = (condition, code) => { if (!condition) throw new Error(code); };
const pause = (ms) => new Promise((done) => setTimeout(done, ms));

export function proofInputs(env) {
  requireProof(SHA.test(env.IMAGE_PROOF_SOURCE_SHA || "") && SHA.test(env.IMAGE_PROOF_SCHEMA_SHA || ""), "IMAGE_PROOF_SHA_REQUIRED");
  requireProof(DIGEST.test(env.IMAGE_PROOF_WEB_DIGEST || "") && DIGEST.test(env.IMAGE_PROOF_WORKER_DIGEST || ""), "IMAGE_PROOF_DIGEST_REQUIRED");
  requireProof(!env.DATABASE_URL && !env.PRODUCTION_DATABASE_URL && !env.SELFSERVE_SCHEMA_AUDITOR_URL
    && !env.CONTROL_PLANE_AGENT_API_KEY && !env.SELFSERVE_VALIDATION_PASSWORD, "IMAGE_PROOF_PRODUCTION_CREDENTIALS_FORBIDDEN");
  return { sourceSha: env.IMAGE_PROOF_SOURCE_SHA, schemaSha: env.IMAGE_PROOF_SCHEMA_SHA,
    images: { web: `ghcr.io/corgtexdotcom/corgtex/web@${env.IMAGE_PROOF_WEB_DIGEST}`,
      worker: `ghcr.io/corgtexdotcom/corgtex/worker@${env.IMAGE_PROOF_WORKER_DIGEST}`,
      db: `pgvector/pgvector@${PG16_INDEX}` } };
}

export async function schemaManifest(directory) {
  const entries = await readdir(join(directory, "migrations"), { withFileTypes: true });
  const migrations = await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => ({
    name: entry.name, checksum: hash(await readFile(join(directory, "migrations", entry.name, "migration.sql"))),
  })));
  migrations.sort((a, b) => a.name.localeCompare(b.name));
  return { schemaSha256: hash(await readFile(join(directory, "schema.prisma"))), migrations };
}

export function verifyIdentity(value, role, sourceSha, expectedSchema) {
  requireProof(value?.identity?.schemaVersion === 1 && value.identity.role === role && value.identity.gitSha === sourceSha,
    "IMAGE_PROOF_BAKED_IDENTITY_MISMATCH");
  requireProof(JSON.stringify(value.schema) === JSON.stringify(expectedSchema), "IMAGE_PROOF_CANDIDATE_SCHEMA_MISMATCH");
}

export function healthyRole(value, role, sourceSha, now = Date.now()) {
  const release = value?.release;
  if (value?.status !== "ok" || release?.runtime?.gitSha !== sourceSha || release.runtime.evidence !== "baked"
    || release.configured?.gitSha !== sourceSha || release.drift?.gitSha !== false
    || release.drift?.imageTag !== false || release.drift?.version !== false) return false;
  if (role === "web") return value.database === "up" && value.schema === "ready";
  const last = Date.parse(value.lastSuccessfulTickAt);
  return value.phase === "running" && value.tickCount > 0 && value.lastError === null
    && Number.isFinite(last) && now - last >= 0 && now - last < 60_000;
}

// Child processes receive only Docker's local transport configuration. Runtime
// containers receive an explicit synthetic environment, never the runner's.
function dockerEnvironment(env, dockerConfig) {
  requireProof(!env.DOCKER_HOST || env.DOCKER_HOST.startsWith("unix://"), "IMAGE_PROOF_LOCAL_DOCKER_REQUIRED");
  return { PATH: env.PATH, HOME: env.HOME, ...(env.TMPDIR ? { TMPDIR: env.TMPDIR } : {}),
    ...(dockerConfig ? { DOCKER_CONFIG: dockerConfig } : {}) };
}

export async function prepareImages(env = process.env) {
  const input = proofInputs(env);
  requireProof(env.GITHUB_REPOSITORY?.toLowerCase() === "corgtexdotcom/corgtex"
    && /^[A-Za-z0-9][A-Za-z0-9-]*(?:\[bot\])?$/.test(env.IMAGE_PROOF_READ_ACTOR || "")
    && typeof env.IMAGE_PROOF_READ_TOKEN === "string" && env.IMAGE_PROOF_READ_TOKEN.length > 0
    && !/\s/.test(env.IMAGE_PROOF_READ_TOKEN), "IMAGE_PROOF_EXISTING_PACKAGE_READ_REQUIRED");
  dockerEnvironment(env);
  const auth = await mkdtemp(join(tmpdir(), "corgtex-proof-auth-"));
  const childEnv = dockerEnvironment(env, auth);
  const run = (args, options = {}) => execFileSync("docker", args, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
    timeout: 180_000, maxBuffer: 8 * 1024 * 1024, env: childEnv, ...options });
  try {
    await chmod(auth, 0o700);
    run(["login", "ghcr.io", "--username", env.IMAGE_PROOF_READ_ACTOR, "--password-stdin"],
      { input: `${env.IMAGE_PROOF_READ_TOKEN}\n`, timeout: 30_000 });
    for (const image of Object.values(input.images)) run(["pull", image]);
  } finally { await rm(auth, { recursive: true, force: true }); }
  return { ...input, status: "staged", authCleanup: "completed", runtimeStarted: false };
}

const imageEvidence = `const fs=require('node:fs'),crypto=require('node:crypto');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const migrations=fs.readdirSync('/app/prisma/migrations',{withFileTypes:true}).filter(e=>e.isDirectory()).map(e=>({name:e.name,checksum:hash(fs.readFileSync('/app/prisma/migrations/'+e.name+'/migration.sql'))})).sort((a,b)=>a.name.localeCompare(b.name));
console.log(JSON.stringify({identity:JSON.parse(fs.readFileSync('/app/release-build.json','utf8')),schema:{schemaSha256:hash(fs.readFileSync('/app/prisma/schema.prisma')),migrations}}));`;

export async function runProof(env = process.env) {
  const input = proofInputs(env);
  requireProof(!env.IMAGE_PROOF_READ_TOKEN && !env.GITHUB_TOKEN && !env.GH_TOKEN, "IMAGE_PROOF_RUNTIME_TOKEN_FORBIDDEN");
  const expectedSchema = await schemaManifest(resolve(".candidate-schema/prisma"));
  requireProof(expectedSchema.migrations.length > 0, "IMAGE_PROOF_SCHEMA_EMPTY");
  const owner = randomBytes(10).toString("hex"), prefix = `corgtex-image-proof-${owner}`;
  const network = `${prefix}-net`, containers = [];
  dockerEnvironment(env);
  const emptyAuth = await mkdtemp(join(tmpdir(), "corgtex-proof-runtime-"));
  const childEnv = dockerEnvironment(env, emptyAuth);
  const deadline = Date.now() + 8 * 60_000;
  let stage = "IDENTITY", networkAttempted = false;
  const run = (args, options = {}) => execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    timeout: Math.max(1, Math.min(60_000, deadline - Date.now())), maxBuffer: 4 * 1024 * 1024, env: childEnv, ...options });
  const receipt = { schemaVersion: 1, ...input, status: "failed", stage,
    schemaSha256: expectedSchema.schemaSha256, migrationCount: expectedSchema.migrations.length,
    isolation: "internal-network;synthetic-only;normal-entrypoints;no-published-ports-or-host-mounts", roles: {} };
  try {
    for (const role of ["web", "worker"]) {
      const config = JSON.parse(run(["image", "inspect", input.images[role]]))[0];
      const expectedCmd = role === "web" ? ["sh", "/app/deploy/entrypoint.sh"] : ["node", "/app/scripts/start-worker.mjs"];
      requireProof(config.RepoDigests?.includes(input.images[role])
        && (!config.Config.Entrypoint?.length || JSON.stringify(config.Config.Entrypoint) === '["docker-entrypoint.sh"]')
        && JSON.stringify(config.Config.Cmd) === JSON.stringify(expectedCmd), "IMAGE_PROOF_NORMAL_COMMAND_MISMATCH");
      const probe = `${prefix}-${role}-identity`;
      containers.push(probe);
      const evidence = JSON.parse(run(["run", "--rm", "--name", probe, "--label", `corgtex.image-proof=${owner}`,
        "--pull=never", "--network", "none", "--entrypoint", "node", input.images[role], "-e", imageEvidence]));
      verifyIdentity(evidence, role, input.sourceSha, expectedSchema);
      receipt.roles[role] = { image: input.images[role], configId: config.Id, bakedSha: input.sourceSha,
        normalEntrypoint: config.Config.Entrypoint, normalCommand: expectedCmd };
    }
    stage = "DATABASE";
    networkAttempted = true;
    run(["network", "create", "--internal", "--label", `corgtex.image-proof=${owner}`, network]);
    const db = `${prefix}-db`, password = randomBytes(24).toString("hex");
    containers.push(db);
    run(["run", "-d", "--pull=never", "--name", db, "--label", `corgtex.image-proof=${owner}`, "--network", network,
      "--network-alias", "proof-db", "--memory", "768m", "--tmpfs", "/var/lib/postgresql/data",
      "-e", `POSTGRES_PASSWORD=${password}`, "-e", "POSTGRES_DB=corgtex_image_proof", input.images.db]);
    const waitFor = async (check) => {
      while (Date.now() < deadline) {
        try { if (check()) return; } catch { /* bounded readiness polling */ }
        await pause(1000);
      }
      throw new Error("IMAGE_PROOF_READINESS_DEADLINE");
    };
    await waitFor(() => { run(["exec", db, "pg_isready", "-U", "postgres", "-d", "corgtex_image_proof"]); return true; });
    const runtime = { DATABASE_URL: `postgresql://postgres:${password}@proof-db:5432/corgtex_image_proof`,
      SESSION_COOKIE_SECRET: randomBytes(32).toString("hex"), ENCRYPTION_KEY: randomBytes(32).toString("hex"),
      MODEL_PROVIDER: "fake", SHARED_STATE_BACKEND: "postgres", CORGTEX_STARTUP_MODE: "web",
      CORGTEX_RELEASE_GIT_SHA: input.sourceSha, CORGTEX_RELEASE_IMAGE_TAG: `sha-${input.sourceSha}`,
      CORGTEX_RELEASE_VERSION: `main-${input.sourceSha.slice(0, 12)}` };
    const environment = Object.entries(runtime).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
    stage = "MIGRATIONS";
    const migration = `${prefix}-migrations`;
    containers.push(migration);
    run(["run", "--rm", "--name", migration, "--label", `corgtex.image-proof=${owner}`,
      "--pull=never", "--network", network, ...environment, "--entrypoint", "node", input.images.web,
      "/app/node_modules/prisma/build/index.js", "migrate", "deploy"], { timeout: 180_000 });
    const ledger = JSON.parse(run(["exec", db, "psql", "-U", "postgres", "-d", "corgtex_image_proof", "-tAc",
      "SELECT coalesce(json_agg(t ORDER BY name),'[]') FROM (SELECT migration_name AS name,checksum FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) t"]));
    requireProof(JSON.stringify(ledger) === JSON.stringify(expectedSchema.migrations), "IMAGE_PROOF_MIGRATION_LEDGER_MISMATCH");
    receipt.migrationLedgerSha256 = hash(JSON.stringify(ledger));
    stage = "STARTUP";
    for (const role of ["web", "worker"]) {
      const name = `${prefix}-${role}`;
      containers.push(name);
      run(["run", "-d", "--pull=never", "--name", name, "--label", `corgtex.image-proof=${owner}`, "--network", network,
        "--memory", "1536m", ...environment, input.images[role]]);
      const url = role === "web" ? "http://127.0.0.1:3000/api/health" : "http://127.0.0.1:9090/health";
      let health;
      await waitFor(() => {
        health = JSON.parse(run(["exec", name, "node", "-e", `fetch('${url}').then(async r=>{if(!r.ok)process.exit(1);console.log(await r.text())}).catch(()=>process.exit(1))`]));
        return healthyRole(health, role, input.sourceSha);
      });
      receipt.roles[role].health = { status: health.status, release: health.release,
        ...(role === "web" ? { database: health.database, schema: health.schema }
          : { phase: health.phase, tickCount: health.tickCount, lastSuccessfulTickAt: health.lastSuccessfulTickAt, lastError: health.lastError }) };
    }
    requireProof(["web", "worker"].every((role) => run(["inspect", "--format", "{{.State.Running}}", `${prefix}-${role}`]).trim() === "true"),
      "IMAGE_PROOF_PAIR_NOT_RUNNING");
    receipt.status = "passed";
    receipt.completedAt = new Date().toISOString();
  } catch (error) {
    receipt.error = /^IMAGE_PROOF_[A-Z_]+$/.test(error.message) ? error.message : "IMAGE_PROOF_STAGE_FAILED";
    throw Object.assign(new Error(receipt.error), { receipt });
  } finally {
    receipt.stage = stage;
    // Only names created for this random ownership label are eligible for removal.
    let cleaned = true;
    const cleanup = (args) => run(args, { timeout: 15_000 });
    for (const name of containers.reverse()) {
      try {
        if (!cleanup(["ps", "-aq", "--filter", `name=^/${name}$`]).trim()) continue;
        const label = cleanup(["inspect", "--format", '{{index .Config.Labels "corgtex.image-proof"}}', name]);
        requireProof(label.trim() === owner, "IMAGE_PROOF_CLEANUP_OWNERSHIP");
        cleanup(["rm", "-f", "-v", name]);
      } catch { cleaned = false; }
    }
    if (networkAttempted) {
      try {
        if (cleanup(["network", "ls", "-q", "--filter", `name=^${network}$`]).trim()) {
          const label = cleanup(["network", "inspect", "--format", '{{index .Labels "corgtex.image-proof"}}', network]);
          requireProof(label.trim() === owner, "IMAGE_PROOF_CLEANUP_OWNERSHIP");
          cleanup(["network", "rm", network]);
        }
      } catch { cleaned = false; }
    }
    try { await rm(emptyAuth, { recursive: true, force: true }); } catch { cleaned = false; }
    receipt.cleanup = cleaned ? "completed" : "incomplete";
    if (!cleaned) { receipt.status = "failed"; receipt.error = "IMAGE_PROOF_CLEANUP_INCOMPLETE"; }
    await mkdir(OUTPUT, { recursive: true });
    await writeFile(join(OUTPUT, "startup.json"), `${JSON.stringify(receipt, null, 2)}\n`);
    requireProof(cleaned, "IMAGE_PROOF_CLEANUP_INCOMPLETE");
  }
  return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.includes("--prepare")) {
      const receipt = await prepareImages();
      await mkdir(OUTPUT, { recursive: true });
      await writeFile(join(OUTPUT, "preparation.json"), `${JSON.stringify(receipt, null, 2)}\n`);
    } else await runProof();
  } catch (error) {
    await mkdir(OUTPUT, { recursive: true });
    await writeFile(join(OUTPUT, "failure.json"), JSON.stringify({ status: "blocked",
      error: /^IMAGE_PROOF_[A-Z_]+$/.test(error.message) ? error.message : "IMAGE_PROOF_STAGE_FAILED" }) + "\n");
    process.exitCode = 1;
  }
}
