import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, writeFile, readFile, mkdtemp, rm, chmod, rename } from "node:fs/promises";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { fullReleaseSha, requireValidation, SELFSERVE_VALIDATION_TARGET } from "./lib/selfserve-validation-target.mjs";
import { loadValidationMatrices, evaluateValidationMatrices } from "./production-validation-outcome-gate.mjs";
import { migrationManifest } from "./accepted-core-baseline.mjs";
import { catalogBinding, assertExpectedCatalog } from "./lib/selfserve-schema-catalog.mjs";

export function isolatedInputs(env) {
  const expectedSha = fullReleaseSha(env.SELFSERVE_VALIDATION_EXPECTED_SHA);
  const images = Object.fromEntries(["WEB", "BROWSER", "PG"].map((role) => {
    const image = env[`SELFSERVE_ISOLATED_${role}_IMAGE`];
    requireValidation(typeof image === "string" && /^[a-z0-9][a-z0-9./:_-]+@sha256:[a-f0-9]{64}$/.test(image),
      `ISOLATED_IMMUTABLE_${role}_IMAGE_REQUIRED`);
    return [role, image];
  }));
  requireValidation(!env.DATABASE_URL && !env.PRODUCTION_DATABASE_URL && !env.SELFSERVE_SCHEMA_AUDITOR_URL
    && !env.ADMIN_PASSWORD && !env.SELFSERVE_VALIDATION_PASSWORD, "ISOLATED_PRODUCTION_CREDENTIALS_FORBIDDEN");
  return { expectedSha, images };
}

export function requireFullIsolatedMatrix(matrices, script) {
  requireValidation(evaluateValidationMatrices(matrices).status === "passed" && matrices.length === 1
    && matrices[0].run.metadata?.script === script.replace(/\.mjs$/, "")
    && matrices[0].run.results.length > 0 && matrices[0].run.results.every((result) => result.result === "pass"),
  "ISOLATED_FULL_MATRIX_REQUIRED");
}

export function stageIsolatedImages(env, command = execFileSync, now = Date.now) {
  const { expectedSha, images } = isolatedInputs(env);
  const deadline = now() + 8 * 60_000;
  const staged = [];
  for (const [role, image] of Object.entries(images)) {
    const inspect = () => command("docker", ["image", "inspect", image, "--format", "{{.Id}}"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5000 });
    let cached = true;
    try { inspect(); } catch { cached = false; }
    if (!cached) {
      requireValidation(now() < deadline, "ISOLATED_PREPARATION_DEADLINE");
      try {
        command("docker", ["pull", image], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
          timeout: Math.max(1, deadline - now()), maxBuffer: 16 * 1024 * 1024 });
      } catch (error) {
        const message = String(error.stderr || "");
        const category = /authentication required|unauthorized|denied|forbidden/i.test(message) ? "AUTH_REQUIRED"
          : /no matching manifest|unsupported platform/i.test(message) ? "PLATFORM_UNAVAILABLE"
          : error.code === "ETIMEDOUT" ? "DEADLINE" : "PULL_FAILED";
        throw new Error(`ISOLATED_PREPARATION_${role}_${category}`);
      }
      inspect();
    }
    staged.push({ role, image, cached });
  }
  return { schemaVersion: 1, expectedSha, status: "staged", images: staged, runtimeStarted: false };
}

export function ghcrPreparationInputs(env) {
  const { images } = isolatedInputs(env);
  requireValidation(env.GITHUB_REPOSITORY?.toLowerCase() === "corgtexdotcom/corgtex", "ISOLATED_GHCR_REPOSITORY_REQUIRED");
  requireValidation(/^ghcr\.io\/corgtexdotcom\/corgtex\/web@sha256:[a-f0-9]{64}$/.test(images.WEB)
    && /^mcr\.microsoft\.com\/playwright@sha256:[a-f0-9]{64}$/.test(images.BROWSER)
    && /^(?:docker\.io\/)?pgvector\/pgvector@sha256:[a-f0-9]{64}$/.test(images.PG), "ISOLATED_GHCR_IMAGE_ALLOWLIST_REQUIRED");
  requireValidation(typeof env.SELFSERVE_IMAGE_READ_TOKEN === "string" && env.SELFSERVE_IMAGE_READ_TOKEN.length > 0
    && !/\s/.test(env.SELFSERVE_IMAGE_READ_TOKEN)
    && /^[A-Za-z0-9][A-Za-z0-9-]*(?:\[bot\])?$/.test(env.SELFSERVE_IMAGE_READ_ACTOR || ""), "ISOLATED_GHCR_TOKEN_REQUIRED");
}

export async function withGhcrReadAuth(env, action, command = execFileSync) {
  ghcrPreparationInputs(env);
  const directory = await mkdtemp(join(tmpdir(), "selfserve-ghcr-read-"));
  const childEnv = { ...env, DOCKER_CONFIG: directory };
  for (const key of ["SELFSERVE_IMAGE_READ_TOKEN", "SELFSERVE_IMAGE_READ_ACTOR", "GITHUB_TOKEN", "GH_TOKEN"]) delete childEnv[key];
  const deadline = Date.now() + 8 * 60_000;
  const bounded = (binary, args, options = {}) => {
    requireValidation(Date.now() < deadline, "ISOLATED_PREPARATION_DEADLINE");
    return command(binary, args, { ...options, env: childEnv, timeout: Math.max(1, Math.min(options.timeout || 30000, deadline - Date.now())) });
  };
  try {
    await chmod(directory, 0o700);
    try {
      bounded("docker", ["login", "ghcr.io", "--username", env.SELFSERVE_IMAGE_READ_ACTOR, "--password-stdin"],
        { input: `${env.SELFSERVE_IMAGE_READ_TOKEN}\n`, stdio: ["pipe", "pipe", "pipe"], encoding: "utf8" });
    } catch { throw new Error("ISOLATED_GHCR_AUTH_REQUIRED"); }
    return await action(bounded);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export async function prepareIsolatedValidation(env = process.env) {
  const output = resolve(env.SELFSERVE_VALIDATION_OUT_DIR || ".artifacts/selfserve-isolated");
  await mkdir(output, { recursive: true });
  try {
    const ghcr = Boolean(env.SELFSERVE_IMAGE_READ_TOKEN) || env.GITHUB_ACTIONS === "true";
    const receipt = ghcr
      ? { ...await withGhcrReadAuth(env, (command) => stageIsolatedImages(env, command)), registryAuth: "ephemeral-github-token", authCleanup: "completed" }
      : stageIsolatedImages(env);
    await writeFile(join(output, "preparation.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  } catch (error) {
    await writeFile(join(output, "preparation.json"), `${JSON.stringify({ schemaVersion: 1,
      status: "blocked", runtimeStarted: false,
      error: /^ISOLATED_[A-Z_]+$/.test(error.message) ? error.message : "ISOLATED_PREPARATION_FAILED" }, null, 2)}\n`);
    throw error;
  }
}

export async function runIsolatedValidation(env = process.env) {
  requireValidation(!env.SELFSERVE_IMAGE_READ_TOKEN && !env.GITHUB_TOKEN && !env.GH_TOKEN, "ISOLATED_REGISTRY_TOKEN_FORBIDDEN");
  const { expectedSha, images } = isolatedInputs(env);
  const source = resolve(env.SELFSERVE_VALIDATION_SOURCE_DIR || ".accepted-source");
  const scripts = resolve("scripts");
  const output = resolve(env.SELFSERVE_VALIDATION_OUT_DIR || ".artifacts/selfserve-isolated");
  const binding = { expectedSha, manifest: migrationManifest(source), runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT };
  catalogBinding(binding);
  const scope = `selfserve-validation-${randomBytes(6).toString("hex")}`;
  const label = `corgtex.validation.scope=${scope}`;
  const names = ["identity", "pg", "init", "web", "relay", "runner"].map((suffix) => `${scope}-${suffix}`);
  const [identity, pg, init, web, relay, runner] = names;
  const docker = (args, options = {}) => execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5000, ...options });
  requireValidation(execFileSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).trim() === expectedSha
    && !execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: source, encoding: "utf8" }).trim(),
    "ISOLATED_SOURCE_SHA_MISMATCH");
  // Preparation is a separate bounded phase. Runtime never pulls or builds.
  const platforms = {};
  for (const [role, image] of Object.entries(images)) {
    try { platforms[role] = docker(["image", "inspect", image, "--format", "{{.Os}}/{{.Architecture}}"]).trim(); }
    catch { throw new Error(`ISOLATED_CACHED_${role}_IMAGE_UNAVAILABLE`); }
  }
  await mkdir(output, { recursive: true });
  await writeFile(join(output, "catalog-source.json"), JSON.stringify({ manifest: binding.manifest }));
  const password = randomBytes(24).toString("hex");
  const db = `postgresql://synthetic:${password}@fixture-pg:5432/selfserve_validation_synthetic?schema=public`;
  const envArgs = (values) => Object.entries(values).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
  const fixtureEnv = { DATABASE_URL: db, SELFSERVE_ISOLATED_FIXTURE: "true", ISOLATED_VALIDATION_PASSWORD: password,
    SESSION_COOKIE_SECRET: randomBytes(32).toString("hex"), RESEND_API_KEY: "", NODE_ENV: "production",
    NEXT_PUBLIC_SITE_URL: "https://fixture-web:3443", APP_URL: "https://fixture-web:3443" };
  const resources = ["--cpus=1", "--memory=1g", "--memory-swap=1g", "--label", label, "--pull=never"];
  let child;
  let expired = false;
  const requestedDeadline = env.SELFSERVE_ISOLATED_DEADLINE ? Date.parse(env.SELFSERVE_ISOLATED_DEADLINE) : Infinity;
  const deadline = Math.min(Date.now() + 27 * 60_000, requestedDeadline);
  requireValidation(Number.isFinite(deadline) && deadline > Date.now(), "ISOLATED_DEADLINE");
  const ownership = { scope, label, containers: names, network: scope, platforms,
    deadline: new Date(deadline).toISOString(), cleanupDeadline: new Date(deadline + 3 * 60_000).toISOString() };
  await writeFile(join(output, "ownership.json"), `${JSON.stringify(ownership, null, 2)}\n`);
  console.log(JSON.stringify(ownership));
  const sanitize = (value) => String(value).replaceAll(password, "[synthetic-redacted]")
    .replaceAll(fixtureEnv.SESSION_COOKIE_SECRET, "[synthetic-redacted]");
  let tlsDirectory;
  function cleanup() {
    child?.kill("SIGTERM");
    for (const name of names) {
      try {
        if (docker(["inspect", name, "--format", '{{index .Config.Labels "corgtex.validation.scope"}}']).trim() === scope) {
          docker(["rm", "-fv", name]);
        }
      } catch { /* Absent owned container. Final readback below is authoritative. */ }
    }
    try {
      if (docker(["network", "inspect", scope, "--format", '{{index .Labels "corgtex.validation.scope"}}']).trim() === scope) {
        docker(["network", "rm", scope]);
      }
    } catch { /* Read back owned resources after cleanup. */ }
  }
  const timer = setTimeout(() => { expired = true; cleanup(); }, Math.max(1, deadline - Date.now()));
  const onSignal = () => { expired = true; cleanup(); };
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);
  let commandNumber = 0;
  const run = (args) => new Promise((resolveRun, reject) => {
    requireValidation(!expired && Date.now() < deadline, "ISOLATED_DEADLINE");
    child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    const number = ++commandNumber;
    let log = "";
    const capture = (chunk) => { log = (log + String(chunk)).slice(-2 * 1024 * 1024); };
    child.stdout.on("data", capture); child.stderr.on("data", capture);
    child.once("error", reject);
    child.once("exit", async (code) => {
      child = undefined;
      try {
        await writeFile(join(output, `command-${number}.log`), sanitize(log));
        code === 0 ? resolveRun() : reject(new Error(`ISOLATED_COMMAND_FAILED:${code}`));
      } catch (error) { reject(error); }
    });
  });
  let completed = false;
  try {
    docker(["create", "--name", identity, "--network", "none", "--platform", platforms.WEB, ...resources, images.WEB]);
    docker(["cp", `${identity}:/app/release-build.json`, join(output, "release-build.json")]);
    const build = JSON.parse(await readFile(join(output, "release-build.json"), "utf8"));
    requireValidation(build.schemaVersion === 1 && build.role === "web" && build.gitSha === expectedSha, "ISOLATED_IMAGE_SHA_MISMATCH");
    tlsDirectory = await mkdtemp(join(tmpdir(), "selfserve-fixture-tls-"));
    const cert = join(tlsDirectory, "cert.pem");
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
      "-keyout", join(tlsDirectory, "key.pem"), "-out", cert, "-subj", "/CN=fixture-web",
      "-addext", "subjectAltName=DNS:fixture-web"], { stdio: "ignore", timeout: 15000 });
    const publicKey = execFileSync("openssl", ["x509", "-pubkey", "-noout", "-in", cert]);
    const der = execFileSync("openssl", ["pkey", "-pubin", "-outform", "DER"], { input: publicKey });
    const pin = createHash("sha256").update(der).digest("base64");
    docker(["network", "create", "--internal", "--label", label, scope]);
    const internal = docker(["network", "inspect", scope, "--format", "{{.Internal}}"]).trim() === "true";
    requireValidation(internal, "ISOLATED_NETWORK_REQUIRED");
    await writeFile(join(output, "network.json"), `${JSON.stringify({ scope, internal, publishedPorts: [] })}\n`);
    docker(["run", "-d", "--name", pg, "--network", scope, "--network-alias", "fixture-pg", "--platform", platforms.PG, ...resources,
      "--tmpfs", "/var/lib/postgresql:size=512m", "--tmpfs", "/var/lib/postgresql/data:size=512m",
      ...envArgs({ POSTGRES_DB: "selfserve_validation_synthetic", POSTGRES_USER: "synthetic", POSTGRES_PASSWORD: password }), images.PG]);
    let ready = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      try { docker(["exec", pg, "pg_isready", "-U", "synthetic", "-d", "selfserve_validation_synthetic"]); ready = true; break; } catch {}
      await new Promise((done) => setTimeout(done, 1000));
    }
    requireValidation(ready, "ISOLATED_PG_NOT_READY");
    await run(["run", "--name", init, "--network", scope, "--platform", platforms.WEB, ...resources, ...envArgs(fixtureEnv),
      ...envArgs({ SELFSERVE_VALIDATION_EXPECTED_SHA: expectedSha, GITHUB_RUN_ID: String(env.GITHUB_RUN_ID), GITHUB_RUN_ATTEMPT: String(env.GITHUB_RUN_ATTEMPT) }),
      "-v", `${scripts}/selfserve-validation-fixture.mjs:/app/scripts/selfserve-validation-fixture.mjs:ro`,
      "-v", `${scripts}:/app/validation-scripts:ro`, "-v", `${output}:/proof`,
      "--entrypoint", "sh", images.WEB, "-ec", "node node_modules/prisma/build/index.js migrate deploy && node validation-scripts/selfserve-validation-catalog-fixture.mjs && node --import tsx scripts/selfserve-validation-fixture.mjs"]);
    docker(["run", "-d", "--name", web, "--network", scope, "--network-alias", "fixture-app", "--platform", platforms.WEB, ...resources,
      ...envArgs(fixtureEnv), "--entrypoint", "node", images.WEB,
      "node_modules/next/dist/bin/next", "start", "apps/web", "-p", "3000", "-H", "0.0.0.0"]);
    docker(["run", "-d", "--name", relay, "--network", scope, "--network-alias", "fixture-web", "--platform", platforms.WEB, ...resources,
      "-e", "SELFSERVE_ISOLATED_FIXTURE=true", "-v", `${tlsDirectory}:/fixture-tls:ro`,
      "-v", `${scripts}/selfserve-validation-relay.mjs:/app/scripts/selfserve-validation-relay.mjs:ro`,
      "--entrypoint", "node", images.WEB, "scripts/selfserve-validation-relay.mjs"]);
    for (const [lane, script, prefix] of [
      ["source-intake-isolated", "source-intake-production-smoke.mjs", "SOURCE_INTAKE_SMOKE"],
      ["briefing-fixture-isolated", "briefing-fixture-production-smoke.mjs", "BRIEFING_FIXTURE_SMOKE"],
    ]) {
      const laneOutput = join(output, lane);
      await mkdir(laneOutput, { recursive: true });
      await run(["run", "--rm", "--name", runner, "--network", scope, "--platform", platforms.BROWSER, ...resources,
        ...envArgs({ ...fixtureEnv, [`${prefix}_EMAIL`]: "validation@synthetic.invalid", [`${prefix}_PASSWORD`]: password,
          [`${prefix}_EXPECTED_GIT_SHA`]: expectedSha, [`${prefix}_WORKSPACE_SLUG`]: "corgtex-validation",
          NODE_EXTRA_CA_CERTS: "/fixture-tls/cert.pem", SELFSERVE_ISOLATED_TLS_SPKI: pin }),
        "-v", `${source}:/app:ro`, "-v", `${laneOutput}:/proof`, "-v", `${tlsDirectory}:/fixture-tls:ro`,
        "-v", `${scripts}/selfserve-validation-browser.mjs:/fixture-browser.mjs:ro`,
        "-w", "/app", "--entrypoint", "sh", images.BROWSER, "-ec",
        `node scripts/wait-health.mjs https://fixture-web:3443/api/health && node --import tsx --import /fixture-browser.mjs scripts/${script} https://fixture-web:3443 /proof`]);
      const matrices = await loadValidationMatrices(laneOutput);
      requireFullIsolatedMatrix(matrices, script);
      await writeFile(join(output, `${lane}.receipt.json`), JSON.stringify({ schemaVersion: 1, target: SELFSERVE_VALIDATION_TARGET.name,
        lane, scope: "isolated-synthetic", gitSha: expectedSha, runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT,
        status: "passed", cleanup: "pending" }));
    }
    completed = true;
  } finally {
    clearTimeout(timer);
    process.removeListener("SIGTERM", onSignal); process.removeListener("SIGINT", onSignal);
    try { await writeFile(join(output, "web.log"), sanitize(docker(["logs", web], { maxBuffer: 2 * 1024 * 1024 }))); } catch {}
    const states = [];
    for (const name of names) {
      try {
        const state = JSON.parse(docker(["inspect", name, "--format",
          '{"memory":{{.HostConfig.Memory}},"nanoCpus":{{.HostConfig.NanoCpus}},"oomKilled":{{.State.OOMKilled}},"exitCode":{{.State.ExitCode}},"ports":{{json .HostConfig.PortBindings}}}']));
        states.push({ name, ...state });
      } catch {}
    }
    try { await writeFile(join(output, "container-states.json"), `${JSON.stringify(states, null, 2)}\n`); }
    catch { /* Evidence IO must not prevent owned-resource cleanup. */ }
    cleanup();
    if (tlsDirectory) await rm(tlsDirectory, { recursive: true, force: true });
    const remaining = docker(["ps", "-aq", "--filter", `label=${label}`]).trim();
    const networks = docker(["network", "ls", "-q", "--filter", `label=${label}`]).trim();
    requireValidation(!remaining && !networks, "ISOLATED_CLEANUP_FAILED");
    await writeFile(join(output, "cleanup.json"), JSON.stringify({ scope, containers: names, remaining: [], expired }));
  }
  requireValidation(completed && !expired, "ISOLATED_VALIDATION_INCOMPLETE");
  await finalizeIsolatedCatalog(output, binding);
  for (const lane of ["source-intake-isolated", "briefing-fixture-isolated"]) {
    const file = join(output, `${lane}.receipt.json`);
    const receipt = JSON.parse(await readFile(file, "utf8"));
    await writeFile(file, `${JSON.stringify({ ...receipt, cleanup: "completed" }, null, 2)}\n`);
  }
}

export async function finalizeIsolatedCatalog(output, binding) {
  const catalogFile = join(output, "expected-catalog.json");
  const catalog = JSON.parse(await readFile(catalogFile, "utf8"));
  const completedCatalog = { ...catalog, cleanup: "completed" };
  assertExpectedCatalog(completedCatalog, binding);
  // The container owns the original file on Linux; replace it in the runner-owned directory.
  const temporary = join(output, `.expected-catalog-${randomBytes(6).toString("hex")}.json`);
  try {
    await writeFile(temporary, `${JSON.stringify(completedCatalog)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporary, catalogFile);
  } finally {
    await rm(temporary, { force: true });
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const action = process.argv[2] === "--prepare" ? prepareIsolatedValidation : runIsolatedValidation;
  action().catch((error) => {
    console.error(/^ISOLATED_[A-Z_]+(?::\d+)?$/.test(error.message) ? error.message : "ISOLATED_EXECUTION_FAILED");
    console.error("Requires staged digest-pinned web/PG/browser images and matching source/dependencies/browser binaries. Preparation uses existing registry access only; runtime never pulls/builds or falls back.");
    process.exitCode = 1;
  });
}
