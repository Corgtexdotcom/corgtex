import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { formatReleaseNormalizationLog, normalizeRuntimeReleaseEnv } from "./lib/release-env.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const signalExitCodes = new Map([
  ["SIGINT", 130],
  ["SIGTERM", 143],
  ["SIGABRT", 134],
]);

export function runWorker(commandInfo = workerCommand(), deps = {}) {
  const spawnFn = deps.spawnFn ?? spawn;
  const processObj = deps.processObj ?? process;
  const forwardedSignals = new Set();
  const child = spawnFn(commandInfo.command, commandInfo.args, {
    stdio: "inherit",
    cwd: commandInfo.cwd,
    env: processObj.env,
  });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    processObj.once(signal, () => {
      forwardedSignals.add(signal);
      child.kill(signal);
    });
  }

  child.on("error", (error) => {
    console.error("[start-worker] Failed to start worker:", error.message);
    processObj.exit(1);
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      if (forwardedSignals.has(signal)) {
        console.log(`[start-worker] Worker exited after forwarded ${signal}.`);
        processObj.exit(0);
        return;
      }
      console.error(`[start-worker] Worker exited after unexpected ${signal}.`);
      processObj.exit(signalExitCodes.get(signal) ?? 1);
      return;
    }
    processObj.exit(code ?? 0);
  });
}

export function workerCommand(root = rootDir) {
  return {
    command: process.execPath,
    args: [
      path.join(root, "node_modules", "tsx", "dist", "cli.mjs"),
      path.join(root, "apps", "worker", "src", "index.ts"),
    ],
    cwd: root,
  };
}

export function main() {
  console.log("[start-worker] === Production Worker Startup Sequence ===");
  console.log(formatReleaseNormalizationLog(normalizeRuntimeReleaseEnv()));
  runWorker();
}

const invokedScriptUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;

if (import.meta.url === invokedScriptUrl) {
  try {
    main();
  } catch (error) {
    console.error("[start-worker] Startup sequence failed:", error.message);
    process.exit(1);
  }
}
