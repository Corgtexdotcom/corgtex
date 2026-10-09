const KNOWN_COMMANDS = new Set(["run", "port", "exec", "logs", "inspect", "stop", "ps"]);
const STDERR_TAIL_CHARS = 4096;

function stderrCategory(stderr) {
  if (/toomanyrequests|unauthenticated pull rate limit|429 too many requests/iu.test(stderr)) return "REGISTRY_RATE_LIMIT";
  if (/context deadline exceeded|client\.timeout exceeded|i\/o timeout|tls handshake timeout/iu.test(stderr)) return "COMMAND_TIMEOUT";
  if (/manifest unknown|manifest.*not found/iu.test(stderr)) return "MANIFEST_UNAVAILABLE";
  if (/no space left on device/iu.test(stderr)) return "DISK_FULL";
  if (/port is already allocated|address already in use/iu.test(stderr)) return "PORT_CONFLICT";
  if (/cannot connect to the docker daemon|is the docker daemon running/iu.test(stderr)) return "DAEMON_UNAVAILABLE";
  if (/oci runtime create failed|failed to create shim task/iu.test(stderr)) return "RUNTIME_START_FAILED";
  return "UNKNOWN_REDACTED";
}

export function safeDockerFixtureFailure(command, result) {
  const operation = KNOWN_COMMANDS.has(command) ? command.toUpperCase() : "OTHER";
  if (result?.error) {
    const spawnCategory = result.error.code === "ENOENT" ? "SPAWN_NOT_FOUND"
      : result.error.code === "ETIMEDOUT" ? "SPAWN_TIMEOUT" : "SPAWN_FAILED";
    return `LOCAL_DOCKER_${operation}_${spawnCategory}`;
  }

  const status = Number.isInteger(result?.status) && result.status >= 0 && result.status <= 255
    ? `EXIT_${result.status}` : "NO_EXIT";
  const stderr = Buffer.isBuffer(result?.stderr) ? result.stderr.toString("utf8") : String(result?.stderr ?? "");
  return `LOCAL_DOCKER_${operation}_${status}_${stderrCategory(stderr.slice(-STDERR_TAIL_CHARS))}`;
}
