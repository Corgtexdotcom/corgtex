export function healthReleaseMismatch(health, expectedGitSha) {
  if (!expectedGitSha) return null;

  const actualGitSha = typeof health?.release?.gitSha === "string" ? health.release.gitSha : null;
  if (actualGitSha === expectedGitSha) return null;

  return `/api/health release.gitSha ${actualGitSha ?? "missing"} did not match expected ${expectedGitSha}`;
}

export function releaseDriftSummary(release) {
  const drift = release?.drift;
  if (!drift?.gitSha && !drift?.imageTag && !drift?.version) return null;

  const details = Array.isArray(drift.details)
    ? drift.details.filter((detail) => typeof detail === "string" && detail.trim().length > 0)
    : [];
  return details.length > 0
    ? details.join("; ")
    : `release metadata drift: gitSha=${Boolean(drift.gitSha)}, imageTag=${Boolean(drift.imageTag)}, version=${Boolean(drift.version)}`;
}

export function healthConfiguredReleaseDrift(health, expectedGitSha = null) {
  const release = health?.release;
  if (!release || typeof release !== "object") return null;

  const driftSummary = releaseDriftSummary(release);
  if (driftSummary) {
    return `/api/health release configured/runtime drift: ${driftSummary}`;
  }

  const configuredGitSha = typeof release.configured?.gitSha === "string" ? release.configured.gitSha : null;
  const runtimeGitSha = typeof release.runtime?.gitSha === "string" ? release.runtime.gitSha : null;
  const actualGitSha = typeof release.gitSha === "string" ? release.gitSha : null;
  const comparisonGitSha = expectedGitSha ?? runtimeGitSha ?? actualGitSha;

  if (configuredGitSha && comparisonGitSha && configuredGitSha !== comparisonGitSha) {
    return `/api/health release configured.gitSha ${configuredGitSha} did not match runtime git SHA ${comparisonGitSha}`;
  }

  return null;
}

export function healthReleaseValidationMismatch(health, expectedGitSha, { requireConfiguredMatch = false } = {}) {
  return healthReleaseMismatch(health, expectedGitSha)
    ?? (requireConfiguredMatch ? healthConfiguredReleaseDrift(health, expectedGitSha) : null);
}
