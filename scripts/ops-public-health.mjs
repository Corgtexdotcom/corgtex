import { pathToFileURL } from "node:url";
import { healthPayloadMismatch } from "./railway-smoke.mjs";

export const OPS_HEALTH_URL = "https://ops.corgtex.com/api/health";

// Health proves present availability, not an error-free observation window or
// deployment identity. Configured release metadata is never baked runtime proof.
export function opsHealthEvidence(response, health) {
  const mismatch = healthPayloadMismatch(response, health);
  if (mismatch) throw new Error(`Ops public health failed: ${mismatch}`);
  const configuredGitSha = health?.release?.configured?.gitSha ?? null;
  const runtimeGitSha = health?.release?.runtime?.gitSha ?? null;
  const baked = health?.release?.runtime?.evidence === "baked"
    && typeof runtimeGitSha === "string" && /^[a-f0-9]{40}$/.test(runtimeGitSha);
  return {
    source: "ops_health",
    group: "ops",
    status: "queried",
    reason: `Public HTTPS health passed (point-in-time availability only); configured SHA=${configuredGitSha ?? "missing"}; baked runtime SHA=${baked ? runtimeGitSha : "unproven"}`,
  };
}

class TransientHealthError extends Error {}

async function readAttempt(fetchImpl, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response;
    try {
      response = await fetchImpl(OPS_HEALTH_URL, {
        method: "GET",
        redirect: "error",
        headers: { Accept: "application/json", "Cache-Control": "no-cache" },
        signal: controller.signal,
      });
    } catch (error) {
      throw new TransientHealthError(error.message, { cause: error });
    }
    if (!response.ok) {
      const ErrorType = [408, 429].includes(response.status) || response.status >= 500
        ? TransientHealthError : Error;
      // Dispose of failed responses before retrying; do not parse an error page
      // as application health or carry its connection into the next attempt.
      try { await response.body?.cancel(); } catch { /* Retain the HTTP failure classification. */ }
      throw new ErrorType(`Ops public health returned HTTP ${response.status}`);
    }
    const mediaType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
    if (mediaType !== "application/json") throw new Error("Ops public health requires application/json");
    let health;
    try {
      health = await response.json();
    } catch (error) {
      if (!controller.signal.aborted && error instanceof SyntaxError) throw error;
      throw new TransientHealthError(error.message, { cause: error });
    }
    return { health, evidence: opsHealthEvidence(response, health) };
  } finally {
    clearTimeout(timer);
  }
}

// Three attempts, each bounded through body parsing, with 0.5s/1s backoff:
// at most 16.5s of network waits and backoff. Invalid application evidence and
// permanent HTTP failures remain immediate failures, never successful fallback.
export async function readOpsPublicHealth({
  fetchImpl = fetch,
  timeoutMs = 5_000,
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const delays = [500, 1_000];
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await readAttempt(fetchImpl, timeoutMs);
    } catch (error) {
      if (!(error instanceof TransientHealthError) || attempt === delays.length) throw error;
      await sleepImpl(delays[attempt]);
    }
  }
}

export async function queryOpsPublicHealth(options = {}) {
  return (await readOpsPublicHealth(options)).evidence;
}

export function opsReleaseLines(health) {
  // These are reported labels, not baked identity. Never replace missing Ops
  // metadata with the CI commit or synthesize tags for a running older image.
  return [health?.release?.gitSha ?? "", health?.release?.imageTag ?? "", health?.release?.version ?? ""].join("\n");
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  readOpsPublicHealth().then(({ health, evidence }) => {
    console.error(evidence.reason);
    console.log(opsReleaseLines(health));
  }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
