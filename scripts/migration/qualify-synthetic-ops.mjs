#!/usr/bin/env node
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Azure, SUBSCRIPTION, GROUP, SERVER, validateEnvironment, validateIntent, validateServer, validateRules, prepare, qualify, cleanup, recoveryEvidence, readIntent, intentComputeSku } from "./qualify-ops-azure-target.mjs";
import { HOST, RESOURCE, connectionConfig, captureWhenReady } from "./probe-ops-azure-target.mjs";
import { targetDatabaseConfigFromEnv } from "./run-postgres-restore-rehearsal.mjs";
import { validatePostgresRestoreRehearsal } from "./validate-postgres-restore-rehearsal.mjs";
import { SOURCE_PINS, verifyBundle, hash, check } from "./synthetic-ops-source.mjs";
import { LABEL, save, inspectSource, relay, dockerTools, cleanupLocal, clientTransport } from "./bootstrap-synthetic-ops.mjs";
import { SyntheticSubprocesses, supervisedExecFile, localToolEnvironment } from "./synthetic-subprocess.mjs";

const worker = fileURLToPath(new URL("./synthetic-ops-worker.mjs", import.meta.url));
const phases = ["1", "2", "corpus"];
export const scratchName = (i, phase) => `corgtex_rehearsal_syn_${i.runId}_${i.runAttempt}_${phase}`;
export function syntheticIntent(lifecycle) {
  return { schemaVersion: "1.0.0", kind: "ops-synthetic-qualification", lifecycle, pins: SOURCE_PINS,
    scratch: phases.map(phase => ({ phase, name: scratchName(lifecycle, phase) })),
    sourceRuntime: "180006/en_US.utf8/libc/2.41/vector0.8.2", targetRuntime: "180006/en_US.utf8/libc/2.38/vector0.8.2",
    productionAccepted: false };
}
export function validateSyntheticIntent(value, runId, attempt) {
  validateIntent(value?.lifecycle, runId, attempt);
  check(JSON.stringify(value) === JSON.stringify(syntheticIntent(value.lifecycle)) && value.scratch.every(s => s.name.length <= 63), "SYNTHETIC_INTENT_MISMATCH");
  return value;
}
export function validateScratchState(state, name) {
  check(state?.schemaVersion === "1.0.0" && state.scratchName === name
    && ["ABSENCE_VERIFIED", "CREATED"].includes(state.phase)
    && state.targetRef === `sha256:${hash(`${HOST}\0${name}`).slice(0, 16)}`, "DATABASE_OWNERSHIP_UNPROVEN");
}
export function validatePrivateTemp(env, directory) {
  check(typeof env.RUNNER_TEMP === "string" && env.RUNNER_TEMP.startsWith("/")
    && env.SYNTHETIC_TEMP_DIR === resolve(env.RUNNER_TEMP, `synthetic-ops-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`), "PRIVATE_TEMP_REQUIRED");
  const temp = resolve(env.SYNTHETIC_TEMP_DIR);
  check(temp !== directory && !temp.startsWith(directory + "/") && (!existsSync(temp) || !lstatSync(temp).isSymbolicLink()), "PRIVATE_TEMP_REQUIRED");
  return temp;
}

// Recovery reuses the existing rehearsal's exact ARM database deletion operation;
// it never starts compute or grants a new runner IP merely to obtain SQL access.
export class ScratchRecovery {
  constructor(supervisor, api, deadline, env) { Object.assign(this, { supervisor, api, deadline, env }); }
  async command(args) {
    return JSON.parse(await this.supervisor.run("az", [...args, "--subscription", SUBSCRIPTION, "--output", "json", "--only-show-errors"],
      { deadline: this.deadline, env: { ...localToolEnvironment(this.env), AZURE_CORE_COLLECT_TELEMETRY: "no" } }) || "null");
  }
  async matching(name) {
    const databases = await this.command(["postgres", "flexible-server", "db", "list", "--resource-group", GROUP, "--server-name", SERVER]);
    check(Array.isArray(databases) && databases.length < 1000, "DATABASE_INVENTORY_INVALID");
    const matches = databases.filter(d => d.name?.split("/").at(-1) === name);
    check(matches.length <= 1 && matches.every(d => d.id?.toLowerCase() === `${RESOURCE}/databases/${name}`.toLowerCase()
      && d.type?.toLowerCase() === "microsoft.dbforpostgresql/flexibleservers/databases"), "DATABASE_IDENTITY_MISMATCH");
    return matches.length === 1;
  }
  async drop(name, state) {
    await this.api.identity(); await this.api.boundary();
    if (await this.matching(name)) {
      validateScratchState(state, name);
      try { await this.command(["postgres", "flexible-server", "db", "delete", "--ids", `${RESOURCE}/databases/${name}`, "--yes"]); }
      catch { /* Never replay an ambiguous deletion; absence readback is required. */ }
    }
    check(!(await this.matching(name)), "SCRATCH_CLEANUP_UNPROVEN");
    return { scratchDatabase: { nameRef: `sha256:${hash(name).slice(0, 16)}`, dropped: true } };
  }
}

export async function recoverScratchDatabases(intent, directory, recovery) {
  const results = [];
  for (const { phase, name } of intent.scratch) {
    const file = `${directory}/${phase}/state.json`;
    const result = await recovery.drop(name, existsSync(file) ? readIntent(file) : null);
    results.push({ phase, ...result });
  }
  return results;
}
export async function completeSyntheticCleanup({ local, preflight = async () => {}, databases, lifecycle }) {
  let failure, scratch, stopped;
  try { await local(); } catch (e) { failure = e; }
  // Local ownership does not depend on provider availability. A failed provider
  // preflight remains the original error and authorizes no database/STOP action.
  await preflight();
  try { scratch = await databases(); } catch (e) { failure ??= e; }
  // Scratch/runner failure is not permission to leave the owned paid lifecycle up.
  try { stopped = await lifecycle(); } catch (e) { failure ??= e; }
  if (failure) throw failure;
  return { ...stopped, scratch };
}
async function invoke(supervisor, mode, config, temp, deadline, env = localToolEnvironment()) {
  const path = `${temp}/child-${mode}-${config.scratchName ?? "source"}.json`;
  save(path, config);
  try { return await supervisor.run(process.execPath, [worker, mode, path], { deadline, env }); }
  finally { rmSync(path, { force: true }); }
}
export async function runSyntheticPasses(intent, execute, clean, record) {
  for (const { phase, name } of intent.scratch) {
    check(Date.now() < intent.lifecycle.workDeadline, "SYNTHETIC_WORK_DEADLINE");
    let failure = null;
    try { await execute(phase, name); } catch (e) { failure = e.code ?? "SYNTHETIC_PASS_FAILED"; }
    // A failed restore may leave a created database and daemon-owned clients.
    // Cleanup must finish before another pass can acquire a scratch database.
    await clean(phase, name);
    await record(phase, { status: failure ? "FAILED" : "CAPTURED", failure, productionAccepted: false });
  }
}

export async function main(args = process.argv.slice(2), env = process.env) {
  check(args.length === 2 && ["bootstrap", "prepare", "run", "cleanup", "recover", "finalize"].includes(args[0]), "SYNTHETIC_ARGS_INVALID");
  const [mode, output] = args, recovering = mode === "recover";
  validateEnvironment(env, recovering);
  check(!env.SOURCE_DATABASE_URL && !env.SOURCE_TLS_ROOT_CERT && !env.CORE_SOURCE_DATABASE_URL && !env.OPS_SOURCE_DATABASE_URL, "PRODUCTION_SOURCE_INPUT_FORBIDDEN");
  const directory = resolve(output), temp = recovering ? null : validatePrivateTemp(env, directory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!recovering && mode !== "finalize") mkdirSync(temp, { recursive: true, mode: 0o700 });
  const supervisor = new SyntheticSubprocesses(), api = new Azure(env, { execute: supervisedExecFile(supervisor) });
  const onSignal = () => {
    supervisor.stop(); process.exitCode = 1;
    // Let the source worker terminate its own tool groups before this owner exits.
    setTimeout(() => process.exit(1), 1000).unref();
  };
  process.once("SIGTERM", onSignal); process.once("SIGINT", onSignal);
  const bundle = env.SYNTHETIC_BUNDLE_DIR && resolve(env.SYNTHETIC_BUNDLE_DIR);
  const intentPath = `${directory}/synthetic-intent.json`;
  try {
    if (mode === "bootstrap") {
      check(bundle, "SYNTHETIC_BUNDLE_REQUIRED"); verifyBundle(bundle);
      await invoke(supervisor, "source", { bundle, directory: temp, evidenceDirectory: directory, deadline: Date.now() + 600000 }, temp, Date.now() + 600000);
      save(`${directory}/source-ready.json`, JSON.parse(readFileSync(`${temp}/source-ready.json`, "utf8")));
      return;
    }
    if (mode === "prepare") {
      await connectionConfig(env);
      verifyBundle(bundle);
      const ready = JSON.parse(readFileSync(`${directory}/source-ready.json`, "utf8"));
      check(ready.status === "SYNTHETIC_SOURCE_PREPARED" && JSON.stringify(ready.pins) === JSON.stringify(SOURCE_PINS), "SYNTHETIC_SOURCE_NOT_PREPARED");
      await inspectSource(dockerTools(supervisor, Date.now() + 60000), ready.owned);
      const lifecycle = await prepare(api, { runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT, ipv4: env.QUALIFY_RUNNER_IPV4 });
      save(intentPath, validateSyntheticIntent(syntheticIntent(lifecycle), env.GITHUB_RUN_ID, env.GITHUB_RUN_ATTEMPT));
      return;
    }
    if (mode === "cleanup" && !existsSync(`${directory}/start-attempt.json`)) {
      try { if (existsSync(`${directory}/local-owner.json`)) await cleanupLocal(dockerTools(supervisor, Date.now() + 60000), readIntent(`${directory}/local-owner.json`)); }
      finally { rmSync(temp, { recursive: true, force: true }); }
      save(`${directory}/cleanup.json`, { status: "START_NOT_ATTEMPTED", providerEffects: 0 }); return;
    }
    const intent = validateSyntheticIntent(readIntent(intentPath), recovering ? env.RECOVERY_RUN_ID : env.GITHUB_RUN_ID, recovering ? env.RECOVERY_RUN_ATTEMPT : env.GITHUB_RUN_ATTEMPT);
    const i = intent.lifecycle;
    if (mode === "run") {
      check(!existsSync(`${directory}/cleanup.json`), "EXECUTION_ALREADY_CLEANED");
      verifyBundle(bundle);
      const owned = JSON.parse(readFileSync(`${directory}/source-ready.json`, "utf8")).owned;
      const docker = dockerTools(supervisor, i.workDeadline), { address } = await inspectSource(docker, owned);
      const sourceBridge = await relay("127.0.0.1", address, 5432);
      let transport;
      try {
        transport = await clientTransport({ supervisor, deadline: i.workDeadline, directory: temp, owned, target: "azure", env });
        const ca = readFileSync(`${temp}/tls/ca.crt`, "utf8");
        const targetAdminConfig = { ...targetDatabaseConfigFromEnv(env, "postgres"), dockerPort: transport.port };
        const sourceConfig = { host: "127.0.0.1", port: sourceBridge.port, dockerHost: owned.container, dockerPort: 5432,
          user: "fixture_reader", password: "synthetic-local-only", database: "source", sslmode: "require", sourceTlsRootCert: ca };
        const childEnv = transport.env;
        const { default: pg } = await import("pg");
        const config = await connectionConfig(env);
        await qualify(api, i, async () => {
          const metadata = await captureWhenReady(() => new pg.Client(config), { deadline: i.workDeadline });
          const settings = metadata.metadata.settings[0];
          check(settings.version === 180006 && settings.provider === "c" && settings.collation === "en_US.utf8"
            && settings.ctype === "en_US.utf8" && settings.recorded === "2.38" && settings.actual === "2.38"
            && metadata.comparison.vector082Available && metadata.comparison.vectorAllowlisted, "SYNTHETIC_TARGET_METADATA_DRIFT");
          save(`${directory}/metadata.json`, metadata);
          const configs = new Map();
          await runSyntheticPasses(intent, async (phase, name) => {
            const artifactDir = `${directory}/${phase}`; mkdirSync(artifactDir, { recursive: true, mode: 0o700 });
            const cfg = { bundle, sourceConfig, targetAdminConfig, scratchName: name, artifactDir,
              tempDir: `${temp}/pass-${phase}`, stateFile: `${artifactDir}/state.json`, dockerNetwork: owned.network };
            configs.set(phase, cfg);
            await invoke(supervisor, phase === "corpus" ? "corpus" : "restore", cfg, temp, Math.min(i.workDeadline, Date.now() + 600000), childEnv);
          }, async phase => {
            // Docker daemon containers outlive a killed Docker CLI. Remove only
            // this run's clients before invoking unchanged SQL cleanup.
            const cleanupDocker = dockerTools(supervisor, i.deadline);
            const clients = (await cleanupDocker(["ps", "-aq", "--filter", `label=${LABEL}=${owned.id}`])).split(/\s+/u).filter(Boolean);
            for (const id of clients) {
              const [c] = JSON.parse(await cleanupDocker(["inspect", id]));
              if (c.Name === `/${owned.container}`) continue;
              check(c.Config.Labels?.[LABEL] === owned.id, "CLIENT_CLEANUP_OWNER_MISMATCH");
              await cleanupDocker(["rm", "-f", "-v", id]);
            }
            await invoke(supervisor, "cleanup", configs.get(phase), temp, Math.min(i.deadline, Date.now() + 120000));
          }, (phase, result) => save(`${directory}/${phase}/result.json`, result));
        }, () => save(`${directory}/start-attempt.json`, { runId: i.runId, runAttempt: i.runAttempt }));
      } finally { await sourceBridge.close(); if (transport) await transport.close(); }
      return;
    }
    if (mode === "finalize") {
      const cleaned = readIntent(`${directory}/cleanup.json`);
      check(cleaned.withinWindow && cleaned.firewallAbsent && cleaned.serverStopped, "SYNTHETIC_CLEANUP_UNPROVEN");
      const results = [];
      for (const phase of ["1", "2"]) {
        try {
          check(readIntent(`${directory}/${phase}/result.json`).status === "CAPTURED", "SYNTHETIC_PASS_FAILED");
          const evidence = JSON.parse(readFileSync(`${directory}/${phase}/postgres-restore-evidence.json`, "utf8"));
          const proof = validatePostgresRestoreRehearsal(evidence, { ...readIntent(`${directory}/${phase}/database-cleanup.json`),
            firewallRule: { nameRef: `sha256:${hash(i.firewallName).slice(0, 16)}`, deleted: cleaned.firewallAbsent },
            credentials: readIntent(`${directory}/${phase}/runner-cleanup.json`).credentials });
          results.push({ phase, proof });
        } catch (e) { results.push({ phase, failure: e.code ?? "VALIDATION_UNPROVEN" }); }
      }
      const corpus = existsSync(`${directory}/corpus/corpus.json`) ? JSON.parse(readFileSync(`${directory}/corpus/corpus.json`, "utf8")) : null;
      const passed = results.every(r => r.proof) && corpus?.comparison.observationsEqual && corpus?.comparison.indexesValid;
      save(`${directory}/comparison.json`, { status: passed ? "SYNTHETIC_COMPARISON_PASS" : "SYNTHETIC_COMPARISON_FAILED", results,
        corpus: corpus?.comparison ?? "NOT_RUN", productionAccepted: false, schemaGuardWaived: false });
      check(passed, "SYNTHETIC_COMPARISON_FAILED"); return;
    }
    check(!existsSync(`${directory}/cleanup.json`), "EXECUTION_ALREADY_CLEANED");
    if (recovering) await recoveryEvidence(i, env, directory, fetch, "synthetic");
    api.deadline = recovering ? Date.now() + 900000 : Math.max(i.deadline, Date.now() + 60000);
    const cleaned = await completeSyntheticCleanup({
      local: async () => {
        if (!recovering) {
          try { if (existsSync(`${directory}/local-owner.json`)) await cleanupLocal(dockerTools(supervisor, Date.now() + 60000), readIntent(`${directory}/local-owner.json`)); }
          finally { rmSync(temp, { recursive: true, force: true }); }
        }
      },
      preflight: async () => {
        await api.identity(); await api.boundary(); validateServer(await api.server(), true, intentComputeSku(i)); validateRules(await api.rules(), i);
      },
      databases: () => recoverScratchDatabases(intent, directory, new ScratchRecovery(supervisor, api, Math.min(api.deadline, Date.now() + 300000), env)),
      lifecycle: async () => {
        if (existsSync(`${directory}/lifecycle-cleanup.json`)) {
          const prior = readIntent(`${directory}/lifecycle-cleanup.json`);
          check(prior.runId === i.runId && prior.runAttempt === i.runAttempt && prior.deadline === i.deadline && prior.resource === RESOURCE
            && prior.serverStopped && prior.firewallAbsent && validateServer(await api.server(), false, intentComputeSku(i)).state === "Stopped", "LIFECYCLE_RECEIPT_MISMATCH");
          validateRules(await api.rules(), i, true); return prior;
        }
        if (recovering) api.verifyRecovery = () => recoveryEvidence(i, env, directory, fetch, "synthetic");
        const result = await cleanup(api, i, undefined, recovering);
        save(`${directory}/lifecycle-cleanup.json`, result); return result;
      },
    });
    save(`${directory}/cleanup.json`, { ...cleaned, status: "SYNTHETIC_QUALIFICATION_CLEANED", withinWindow: Date.now() <= i.deadline });
    check(Date.now() <= i.deadline, "ABSOLUTE_WINDOW_BREACHED");
  } finally { supervisor.stop(); process.removeListener("SIGTERM", onSignal); process.removeListener("SIGINT", onSignal); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(e => {
  console.log(JSON.stringify({ status: "SYNTHETIC_QUALIFICATION_FAILED", code: /^[A-Z][A-Z0-9_]+$/u.test(e.code ?? "") ? e.code : "SYNTHETIC_OPERATION_FAILED", productionAccepted: false })); process.exitCode = 1;
});
