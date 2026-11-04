// Stable host identity prevents missing protected configuration from downgrading
// this shared database to the historical REMOTE_MANAGED release protocol.
export const SELFSERVE_RELEASE_HOST_ID = "e0d34b24-bd86-4cb2-8ccb-f2f84309ca16";
export const SELFSERVE_RELEASE_ORIGIN = "https://selfserve.corgtex.com";
export const SELFSERVE_RELEASE_PROFILE = "SELF_SERVE_IMPORTER_FENCE_V1";
export function isSelfserveReleaseHost(deploymentId, origin, azureTarget) {
  let canonical;
  try { canonical = new URL(origin).origin; } catch { canonical = null; }
  const knownApp = azureTarget?.resourceGroup?.toLowerCase() === "rg-corgtex-selfserve-production-wus3"
    && [azureTarget.webAppName, azureTarget.workerAppName].some((name) => ["ca-corgtex-ss-prod-web", "ca-corgtex-ss-prod-worker"].includes(typeof name === "string" ? name.toLowerCase() : name));
  return deploymentId === SELFSERVE_RELEASE_HOST_ID || canonical === SELFSERVE_RELEASE_ORIGIN || knownApp;
}
