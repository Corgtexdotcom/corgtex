#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SOURCE_PINS, verifyBundle, check } from "./synthetic-ops-source.mjs";
import { save, cleanupLocal, dockerTools } from "./bootstrap-synthetic-ops.mjs";
import { SyntheticSubprocesses } from "./synthetic-subprocess.mjs";

const worker = fileURLToPath(new URL("./synthetic-ops-worker.mjs", import.meta.url));
const temporaryPath = id => resolve(tmpdir(), `corgtex-synthetic-local-${id}`);
const code = error => /^[A-Z][A-Z0-9_]+$/u.test(error?.code ?? "") ? error.code : "LOCAL_PREPARATION_FAILED";

export function localPreparationEnvironment(temp, env = process.env) {
  // Native local Docker CLI only: no remote daemon/context, provider config,
  // tokens, inherited Node options, or mounted Docker socket inside fixtures.
  return { PATH: env.PATH, HOME: resolve(temp, "home"), TMPDIR: temp };
}

export async function cleanupPreparation(directory, env = process.env, supervisor = new SyntheticSubprocesses()) {
  const intentPath = resolve(directory, "local-intent.json");
  if (!existsSync(intentPath)) return { status: "LOCAL_NOT_STARTED" };
  const intent = JSON.parse(readFileSync(intentPath, "utf8"));
  check(/^[a-f0-9-]{36}$/u.test(intent.id) && intent.temp === temporaryPath(intent.id)
    && (!existsSync(intent.temp) || !lstatSync(intent.temp).isSymbolicLink()), "LOCAL_CLEANUP_OWNER_UNPROVEN");
  try {
    const ownerPath = resolve(directory, "local-owner.json");
    if (existsSync(ownerPath)) {
      await cleanupLocal(dockerTools(supervisor, Date.now() + 90000, localPreparationEnvironment(intent.temp, env)), JSON.parse(readFileSync(ownerPath, "utf8")));
    }
  } finally { supervisor.stop(); rmSync(intent.temp, { recursive: true, force: true }); }
  const result = { status: "LOCAL_CLEANED", providerEffects: 0 };
  writeFileSync(resolve(directory, "local-cleanup.json"), JSON.stringify(result) + "\n", { mode: 0o600 });
  return result;
}

export async function prepareLocal(bundle, directory, env = process.env, supervisor = new SyntheticSubprocesses()) {
  check(process.platform === "linux" && process.arch === "arm64", "SOURCE_BOOTSTRAP_REQUIRES_LINUX_ARM64");
  verifyBundle(bundle);
  directory = resolve(directory);
  mkdirSync(directory, { mode: 0o700 });
  const id = randomUUID(), temp = temporaryPath(id), startedAt = Date.now();
  // Claim the private directory exclusively before recording cleanup authority.
  mkdirSync(temp, { mode: 0o700 });
  try { save(resolve(directory, "local-intent.json"), { id, temp, startedAt, workDeadline: startedAt + 600000, cleanupDeadline: startedAt + 720000 }); }
  catch (error) { rmSync(temp, { recursive: true, force: true }); throw error; }
  let failure, ready, head, cleaned;
  const interrupted = () => { failure ??= { code: "LOCAL_PREPARATION_INTERRUPTED" }; supervisor.stop(); };
  process.on("SIGTERM", interrupted); process.on("SIGINT", interrupted);
  try {
    mkdirSync(resolve(temp, "home"), { mode: 0o700 });
    const childEnv = localPreparationEnvironment(temp, env);
    head = await supervisor.run("git", ["rev-parse", "HEAD"], { deadline: startedAt + 10000, env: childEnv });
    check(/^[a-f0-9]{40}$/u.test(head), "LOCAL_SOURCE_HEAD_INVALID");
    const input = resolve(temp, "source-input.json");
    save(input, { bundle: resolve(bundle), directory: temp, evidenceDirectory: directory, deadline: startedAt + 600000 });
    await supervisor.run(process.execPath, [worker, "source", input], { deadline: startedAt + 600000, env: childEnv });
    ready = JSON.parse(readFileSync(resolve(temp, "source-ready.json"), "utf8"));
    check(ready.status === "SYNTHETIC_SOURCE_PREPARED" && JSON.stringify(ready.pins) === JSON.stringify(SOURCE_PINS)
      && ready.clientTransport?.status === "LOCAL_CLIENT_TRANSPORT_PASS" && ready.tlsVerified && ready.disconnected
      && ready.noDefaultRoute && ready.comparison?.observationsEqual && ready.comparison?.indexesValid, "LOCAL_PREPARATION_UNPROVEN");
    save(resolve(directory, "source-ready.json"), ready);
  } catch (error) { failure ??= error; }
  finally {
    supervisor.stop();
    try { cleaned = await cleanupPreparation(directory, env); } catch (error) { failure ??= error; }
    process.removeListener("SIGTERM", interrupted); process.removeListener("SIGINT", interrupted);
  }
  // This is the only CI-uploadable output. Full owner/source receipts stay local.
  const summary = { status: failure ? "LOCAL_PREPARATION_FAILED" : "LOCAL_PREPARATION_PASS", sourceHead: head ?? null,
    failure: failure ? code(failure) : null, inputPins: SOURCE_PINS, runtime: ready?.runtime ?? null,
    sourceComparison: ready ? { observationsEqual: ready.comparison.observationsEqual, indexesValid: ready.comparison.indexesValid,
      scope: "48-string representative synthetic corpus only", zeroDivergenceRequired: true } : null,
    clientTransport: ready ? { status: ready.clientTransport.status, tlsVerified: ready.tlsVerified,
      disconnected: ready.disconnected, noDefaultRoute: ready.noDefaultRoute } : "NOT_RUN",
    cleanup: cleaned?.status ?? "UNPROVEN", providerEffects: 0, azureComparison: "NOT_RUN", productionAccepted: false };
  save(resolve(directory, "public-summary.json"), summary);
  check(!failure, code(failure));
  return summary;
}

export async function main(args = process.argv.slice(2)) {
  if (args.length === 2 && args[0] === "cleanup") return cleanupPreparation(resolve(args[1]));
  check(args.length === 3 && args[0] === "prepare", "LOCAL_PREPARATION_ARGS_INVALID");
  return prepareLocal(resolve(args[1]), resolve(args[2]));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().then(result => {
  console.log(JSON.stringify({ status: result.status, azureComparison: "NOT_RUN" }));
}).catch(error => { console.log(JSON.stringify({ status: "LOCAL_PREPARATION_FAILED", code: code(error) })); process.exitCode = 1; });
