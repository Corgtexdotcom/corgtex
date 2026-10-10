import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { healthReleaseValidationMismatch } from "./release-health-validation.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
export const MOBILE_SHELL_SOURCE_PATH = "apps/web/app/[locale]/workspaces/[workspaceId]/MobileWorkspaceShell.tsx";

// Bind each contract to inspected immutable source, rather than assuming that
// every descendant build keeps its storage behavior. Unchanged source can be
// reused by newer releases; a new blob requires inspection before QA can pass.
export const INSPECTED_MOBILE_MODE_SOURCES = Object.freeze({
  bd5d6d6a52443da19938aca6a999dd0da69b332f: Object.freeze({
    contract: "legacy-global-v1",
    inspectedGitSha: "eb423aca0618638cf7cd742dcb84397c492ba09b",
  }),
  f1e7c033043897dc1d140bb84d0d3fba4641293c: Object.freeze({
    contract: "workspace-scoped-v1",
    inspectedGitSha: "ead142faeb44931c07475c63131d068cbf3454a1",
  }),
});

export async function readMobileShellSourceBlob(gitSha, cwd = repoRoot) {
  if (!/^[a-f0-9]{40}$/.test(gitSha ?? "")) throw new Error("Mobile smoke requires a full serving Git SHA.");
  // The hosted verifier checkout is shallow. Its trusted `.accepted-source`
  // checkout contains full accepted-release history; local scheduled sweeps
  // usually resolve in the main checkout without needing the fallback.
  for (const root of [cwd, path.join(cwd, ".accepted-source")]) {
    try {
      const options = { cwd: root, timeout: 5000, maxBuffer: 4096 };
      const commit = await execFileAsync("git", ["rev-parse", "--verify", `${gitSha}^{commit}`], options);
      if (commit.stdout.trim() !== gitSha) continue;
      const blob = await execFileAsync("git", ["rev-parse", "--verify", `${gitSha}:${MOBILE_SHELL_SOURCE_PATH}`], options);
      const sourceBlobSha = blob.stdout.trim();
      if (/^[a-f0-9]{40}$/.test(sourceBlobSha)) return sourceBlobSha;
    } catch {
      // Try the other known checkout before treating the source as unknown.
    }
  }
  throw new Error(`MOBILE_MODE_BUILD_UNKNOWN: local Git source is unavailable for serving commit ${gitSha}.`);
}

export async function resolveMobileModeBuild(health, {
  readSourceBlob = readMobileShellSourceBlob,
  expectedGitSha = null,
} = {}) {
  const gitSha = /^[a-f0-9]{40}$/.test(health?.release?.gitSha ?? "") ? health.release.gitSha : null;
  const evidence = { gitSha, sourceBlobSha: null, contract: null, inspectedGitSha: null };
  try {
    const release = health?.release;
    if (health?.status !== "ok" || !gitSha || release?.runtime?.gitSha !== gitSha
      || release.runtime.source !== "baked" || release.runtime.evidence !== "baked"
      || release.configured?.gitSha !== gitSha
      || !["gitSha", "imageTag", "version"].every((key) => release.drift?.[key] === false)) {
      throw new Error("MOBILE_MODE_BUILD_UNVERIFIED: health must identify a matching full baked serving SHA with no release drift.");
    }
    const mismatch = healthReleaseValidationMismatch(health, expectedGitSha, { requireConfiguredMatch: true });
    if (mismatch) throw new Error(mismatch);

    evidence.sourceBlobSha = await readSourceBlob(gitSha);
    const inspected = INSPECTED_MOBILE_MODE_SOURCES[evidence.sourceBlobSha];
    if (!inspected) throw new Error(`MOBILE_MODE_BUILD_UNKNOWN: uninspected mobile shell source ${evidence.sourceBlobSha}.`);
    return { ...evidence, ...inspected };
  } catch (error) {
    throw Object.assign(new Error(error instanceof Error ? error.message : String(error)), { mobileModeBuild: evidence });
  }
}

export async function inspectMobileModeBuild(baseUrl, { fetchImpl = fetch, ...options } = {}) {
  const response = await fetchImpl(new URL("/api/health", baseUrl), {
    signal: AbortSignal.timeout(5000),
    headers: { "user-agent": "corgtex-client-readiness/1.0" },
  });
  if (!response.ok) throw new Error(`Mobile smoke /api/health failed with HTTP ${response.status}.`);
  return resolveMobileModeBuild(await response.json(), options);
}

export function assertUnchangedMobileModeBuild(initial, final) {
  if (!initial || !final || initial.gitSha !== final.gitSha || initial.sourceBlobSha !== final.sourceBlobSha
    || initial.contract !== final.contract) {
    throw new Error("MOBILE_MODE_BUILD_CHANGED: serving release changed during client readiness QA; rerun on one verified build.");
  }
}

export function mobileModeStorageKey(build, workspacePath) {
  const workspaceId = workspacePath.match(/\/workspaces\/([^/?#]+)/)?.[1];
  if (!workspaceId) throw new Error("Mobile mode verification requires a workspace path.");
  if (build?.contract === "legacy-global-v1") return "corgtex.mobileMode";
  if (build?.contract === "workspace-scoped-v1") return `corgtex.mobileMode.${workspaceId}`;
  throw new Error("MOBILE_MODE_BUILD_UNKNOWN: storage verification requires an inspected build contract.");
}
