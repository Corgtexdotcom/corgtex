import { spawn } from "node:child_process";

const FAILURE_CODE = "SOURCE_CONTAINER_START_FAILED";
const STDERR_TAIL_BYTES = 4096;
const STDERR_HARD_LIMIT_BYTES = 1024 * 1024;

function safeStderrCategory(stderr, spawnFailed) {
  if (spawnFailed) return "SPAWN_FAILED";
  if (/toomanyrequests|unauthenticated pull rate limit/i.test(stderr)) {
    return "DOCKER_HUB_RATE_LIMIT";
  }
  if (/context deadline exceeded|client\.timeout exceeded|i\/o timeout|tls handshake timeout/i.test(stderr)) {
    return "COMMAND_TIMEOUT";
  }
  if (/manifest unknown|manifest.*not found/i.test(stderr)) {
    return "MANIFEST_UNAVAILABLE";
  }
  if (/no space left on device/i.test(stderr)) {
    return "NO_SPACE";
  }
  if (/port is already allocated|address already in use/i.test(stderr)) {
    return "PORT_CONFLICT";
  }
  if (/cannot connect to the docker daemon|is the docker daemon running/i.test(stderr)) {
    return "DAEMON_UNAVAILABLE";
  }
  return "UNKNOWN_REDACTED";
}

function stderrCollector(command) {
  let tail = Buffer.alloc(0);
  let totalBytes = 0;

  return {
    append(chunk) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += bytes.length;
      tail = Buffer.concat([tail, bytes.subarray(-STDERR_TAIL_BYTES)]).subarray(-STDERR_TAIL_BYTES);
      return totalBytes;
    },
    summary(exitStatus, spawnFailed = false) {
      return {
        event: "docker_source_container_start_failed",
        error: FAILURE_CODE,
        command: command === "run" ? "RUN" : "OTHER",
        category: safeStderrCategory(tail.toString("utf8"), spawnFailed),
        exitStatus: Number.isInteger(exitStatus) && exitStatus >= 0 && exitStatus <= 255 ? exitStatus : null,
      };
    },
  };
}

function reportDiagnostic(summary) {
  process.stderr.write(`${JSON.stringify(summary)}\n`);
}

export function runDockerSourceStart(args, { spawnCommand = spawn, report = reportDiagnostic } = {}) {
  const diagnostic = stderrCollector(args[0]);
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnCommand("docker", args, { stdio: ["ignore", "ignore", "pipe"] });
    } catch {
      report(diagnostic.summary(null, true));
      reject(Object.assign(new Error(FAILURE_CODE), { code: FAILURE_CODE }));
      return;
    }

    let settled = false;
    let killedForExcessiveStderr = false;
    const fail = (exitStatus, spawnFailed = false) => {
      if (settled) return;
      settled = true;
      report(diagnostic.summary(exitStatus, spawnFailed));
      reject(Object.assign(new Error(FAILURE_CODE), { code: FAILURE_CODE }));
    };

    child.stderr.on("data", (chunk) => {
      if (diagnostic.append(chunk) > STDERR_HARD_LIMIT_BYTES && !killedForExcessiveStderr) {
        killedForExcessiveStderr = true;
        child.kill("SIGKILL");
      }
    });
    child.on("error", () => fail(null, true));
    child.on("close", (exitStatus) => {
      if (settled) return;
      if (exitStatus === 0) {
        settled = true;
        resolve();
      } else {
        fail(exitStatus);
      }
    });
  });
}
