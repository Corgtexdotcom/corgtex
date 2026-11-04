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

export async function queryOpsPublicHealth({ fetchImpl = fetch, timeoutMs = 30_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(OPS_HEALTH_URL, {
      method: "GET",
      redirect: "error",
      headers: { Accept: "application/json", "Cache-Control": "no-cache" },
      signal: controller.signal,
    });
    const mediaType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
    if (mediaType !== "application/json") throw new Error("Ops public health requires application/json");
    return opsHealthEvidence(response, await response.json());
  } finally {
    clearTimeout(timer);
  }
}
