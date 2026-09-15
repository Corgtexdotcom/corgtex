import { spawn } from "node:child_process";
import { ProbeError } from "./probe-ops-azure-target.mjs";

const killGroup = (pid, signal) => {
  try { process.kill(-pid, signal); } catch (e) { if (e.code !== "ESRCH") throw e; }
};

// The restore runner has intentionally unbounded SQL timeouts. Its synthetic
// invocation therefore runs in an owned process group, not a Promise.race alone.
export class SyntheticSubprocesses {
  constructor() { this.active = new Set(); this.stopped = false; }
  run(command, args, { deadline, env, input, maxBytes = 1048576, cwd } = {}) {
    if (this.stopped) return Promise.reject(new ProbeError("CHILD_INTERRUPTED"));
    if (!Number.isSafeInteger(deadline) || deadline <= Date.now()) return Promise.reject(new ProbeError("CHILD_DEADLINE"));
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { detached: true, env, cwd, stdio: ["pipe", "pipe", "pipe"] });
      let failure, bytes = 0, output = "", hardTimer;
      const stop = (code, force = false) => {
        failure ??= code;
        if (!child.pid) return;
        killGroup(child.pid, force ? "SIGKILL" : "SIGTERM");
        hardTimer ??= setTimeout(() => killGroup(child.pid, "SIGKILL"), 500);
      };
      this.active.add(stop);
      const timer = setTimeout(() => stop("CHILD_DEADLINE"), Math.max(1, deadline - Date.now()));
      child.stdout.on("data", chunk => {
        bytes += chunk.length;
        if (bytes > maxBytes) stop("CHILD_OUTPUT_LIMIT");
        else output += chunk.toString();
      });
      child.stderr.on("data", chunk => { bytes += chunk.length; if (bytes > maxBytes) stop("CHILD_OUTPUT_LIMIT"); });
      child.stdin.on("error", () => {});
      child.stdin.end(input);
      child.on("error", () => { failure ??= "CHILD_SPAWN_FAILED"; });
      child.on("close", code => {
        clearTimeout(timer); clearTimeout(hardTimer); this.active.delete(stop);
        // A child can exit while its descendants are still alive with closed pipes.
        if (child.pid) killGroup(child.pid, "SIGKILL");
        if (failure || code !== 0) reject(new ProbeError(failure ?? "CHILD_FAILED"));
        else resolve(output.trim());
      });
    });
  }
  stop(force = false) { this.stopped = true; for (const stop of this.active) stop("CHILD_INTERRUPTED", force); }
}

export const supervisedExecFile = supervisor => (command, args, options, callback) => {
  supervisor.run(command, args, { deadline: Date.now() + options.timeout, env: options.env, maxBytes: options.maxBuffer })
    .then(stdout => callback(null, stdout), error => callback(error, ""));
};

export function localToolEnvironment(env = process.env) {
  return Object.fromEntries(["PATH", "HOME", "TMPDIR", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "AZURE_CONFIG_DIR"]
    .filter(key => env[key] !== undefined).map(key => [key, env[key]]));
}
