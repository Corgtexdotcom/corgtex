import { readReleaseBuildIdentity } from "../../packages/shared/src/release-build-node.mjs";

function optional(env, name) {
  const value = env[name]?.trim();
  return value && value.length > 0 ? value : null;
}

export function releaseVersionForGitSha(gitSha) {
  return `main-${gitSha.slice(0, 12)}`;
}

export function runtimeReleaseGitSha(env = process.env) {
  const railway = optional(env, "RAILWAY_GIT_COMMIT_SHA");
  if (railway) return { gitSha: railway, source: "railway" };

  const vercel = optional(env, "VERCEL_GIT_COMMIT_SHA");
  if (vercel) return { gitSha: vercel, source: "vercel" };

  const github = optional(env, "GITHUB_SHA");
  if (github) return { gitSha: github, source: "github" };

  return { gitSha: null, source: "missing" };
}

export function formatRuntimeReleaseLog(role, env = process.env) {
  const baked = readReleaseBuildIdentity(role);
  const runtime = baked ? { gitSha: baked.gitSha, source: "baked" } : runtimeReleaseGitSha(env);
  const configured = {
    gitSha: optional(env, "CORGTEX_RELEASE_GIT_SHA"),
    imageTag: optional(env, "CORGTEX_RELEASE_IMAGE_TAG"),
    version: optional(env, "CORGTEX_RELEASE_VERSION"),
  };
  const sha = runtime.gitSha;
  return `[release-env] ${JSON.stringify({
    runtime: { ...runtime, evidence: baked ? "baked" : sha ? "legacy_provider" : "unavailable" },
    configured,
    drift: {
      gitSha: Boolean(sha && configured.gitSha && configured.gitSha !== sha),
      imageTag: Boolean(sha && configured.imageTag && ![sha, `sha-${sha}`].includes(configured.imageTag)),
      version: Boolean(sha && configured.version?.startsWith("main-") && configured.version !== releaseVersionForGitSha(sha)),
    },
  })}`;
}

export function normalizeRuntimeReleaseEnv(env = process.env) {
  const runtime = runtimeReleaseGitSha(env);
  if (!runtime.gitSha) {
    return {
      normalized: false,
      source: runtime.source,
      gitSha: null,
      version: null,
      imageTag: null,
      changed: [],
    };
  }

  const configuredVersion = optional(env, "CORGTEX_RELEASE_VERSION");
  const version = configuredVersion && !configuredVersion.startsWith("main-")
    ? configuredVersion
    : releaseVersionForGitSha(runtime.gitSha);
  const desired = {
    CORGTEX_RELEASE_GIT_SHA: runtime.gitSha,
    CORGTEX_RELEASE_IMAGE_TAG: `sha-${runtime.gitSha}`,
    CORGTEX_RELEASE_VERSION: version,
  };
  const changed = [];

  for (const [name, value] of Object.entries(desired)) {
    if (env[name] !== value) {
      changed.push(name);
      env[name] = value;
    }
  }

  return {
    normalized: true,
    source: runtime.source,
    gitSha: runtime.gitSha,
    version: desired.CORGTEX_RELEASE_VERSION,
    imageTag: desired.CORGTEX_RELEASE_IMAGE_TAG,
    changed,
  };
}

export function formatReleaseNormalizationLog(result) {
  if (!result.normalized) {
    return "[release-env] No runtime release git SHA available; keeping configured release metadata.";
  }
  if (result.changed.length === 0) {
    return `[release-env] Release metadata already aligned from ${result.source}:${result.gitSha.slice(0, 12)}.`;
  }
  return `[release-env] Aligned ${result.changed.join(", ")} from ${result.source}:${result.gitSha.slice(0, 12)}.`;
}
