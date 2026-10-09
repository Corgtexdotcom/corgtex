import { spawn } from "node:child_process";

const FAILURE_CODE = "SOURCE_CONTAINER_START_FAILED";
const STDERR_TAIL_BYTES = 4096;
const STDERR_HARD_LIMIT_BYTES = 1024 * 1024;

function safeStderrSummary(stderr, spawnFailed) {
  if (spawnFailed) return ["SPAWN_FAILED", "Docker command could not start"];
  if (/toomanyrequests|unauthenticated pull rate limit/i.test(stderr)) {
    return ["DOCKER_HUB_RATE_LIMIT", "Docker Hub unauthenticated pull rate limit"];
  }
  if (/context deadline exceeded|client\.timeout exceeded|i\/o timeout|tls handshake timeout/i.test(stderr)) {
    return ["REGISTRY_TIMEOUT", "Container registry request timed out"];
  }
  if (/manifest unknown|manifest.*not found/i.test(stderr)) {
    return ["MANIFEST_UNAVAILABLE", "Pinned image manifest unavailable"];
  }
  if (/no space left on device/i.test(stderr)) {
    return ["NO_SPACE", "Docker host has no space left"];
  }
  if (/port is already allocated|address already in use/i.test(stderr)) {
    return ["PORT_CONFLICT", "Docker host port is already in use"];
  }
  if (/cannot connect to the docker daemon|is the docker daemon running/i.test(stderr)) {
    return ["DAEMON_UNAVAILABLE", "Docker daemon is unavailable"];
  }
  return ["UNKNOWN_REDACTED", "Docker stderr withheld because it could contain private values"];
}

function stderrCollector() {
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
      const [stderrCategory, stderrExcerpt] = safeStderrSummary(tail.toString("utf8"), spawnFailed);
      return {
        event: "docker_source_container_start_failed",
        error: FAILURE_CODE,
        stderrCategory,
        stderrExcerpt,
        stderrBytes: totalBytes,
        stderrTruncated: totalBytes > STDERR_TAIL_BYTES,
        exitStatus: Number.isInteger(exitStatus) ? exitStatus : null,
      };
    },
  };
}

function reportDiagnostic(summary) {
  process.stderr.write(`${JSON.stringify(summary)}\n`);
}

export function runDockerSourceStart(args, { spawnCommand = spawn, report = reportDiagnostic } = {}) {
  const diagnostic = stderrCollector();
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
