import { parseBoolean } from "./fleet-release-core.mjs";

const READ_PROBE_KEYS = new Set(["key", "label", "status", "count", "counts", "statuses", "errorClass"]);
const RECORDER_KEYS = new Set([
  "key",
  "label",
  "status",
  "configured",
  "entitlementEnabled",
  "vendorReadiness",
  "provider",
  "failureCount",
  "lastSmokeStatus",
  "failureCode",
]);

function pickAllowed(record, allowedKeys) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return {};
  return Object.fromEntries(
    Object.entries(record).filter(([key]) => allowedKeys.has(key)),
  );
}

function sanitizeReadProbe(probe) {
  return pickAllowed(probe, READ_PROBE_KEYS);
}

export function sanitizePostDeployProbe(probe) {
  return {
    deploymentId: typeof probe?.deploymentId === "string" ? probe.deploymentId : null,
    releaseImageTag: typeof probe?.releaseImageTag === "string" ? probe.releaseImageTag : null,
    releaseVersion: typeof probe?.releaseVersion === "string" ? probe.releaseVersion : null,
    observedAt: typeof probe?.observedAt === "string" ? probe.observedAt : null,
    status: typeof probe?.status === "string" ? probe.status : "unknown",
    sanitized: true,
    reads: Array.isArray(probe?.reads) ? probe.reads.map(sanitizeReadProbe) : [],
    recorder: pickAllowed(probe?.recorder, RECORDER_KEYS),
    supportAudit: {
      status: typeof probe?.supportAudit?.status === "string" ? probe.supportAudit.status : "unknown",
      errorClass: typeof probe?.supportAudit?.errorClass === "string" ? probe.supportAudit.errorClass : null,
    },
  };
}

export function postDeployProbeFailureSummary(probe) {
  const sanitized = sanitizePostDeployProbe(probe);
  const failedRead = sanitized.reads.find((item) => item.status === "failed");
  if (failedRead) return `${failedRead.key}:${failedRead.errorClass ?? "failed"}`;
  if (sanitized.recorder.status && sanitized.recorder.status !== "ok") {
    return `recorder:${sanitized.recorder.failureCode ?? sanitized.recorder.status}`;
  }
  if (sanitized.supportAudit.status && !["completed", "skipped"].includes(sanitized.supportAudit.status)) {
    return `support_audit:${sanitized.supportAudit.errorClass ?? sanitized.supportAudit.status}`;
  }
  return sanitized.status;
}

export function assertPostDeployProbeReady(probe, targetLabel = "deployment") {
  const sanitized = sanitizePostDeployProbe(probe);
  if (sanitized.status === "ok") return sanitized;
  throw new Error(`${targetLabel} post-deploy probe ${sanitized.status}: ${postDeployProbeFailureSummary(sanitized)}`);
}

export function shouldRunPostDeployProbe(target, env = process.env) {
  if (!target.deploymentId) return false;
  return parseBoolean(env.FLEET_RELEASE_POST_DEPLOY_PROBES, true);
}

export async function runPostDeployProbe(target, manifest, reason, deps, callControlPlaneTool) {
  if (!shouldRunPostDeployProbe(target, deps.env ?? process.env)) {
    return { status: "skipped", reason: target.deploymentId ? "disabled" : "deployment_id_missing" };
  }

  const env = deps.env ?? process.env;
  const probe = await callControlPlaneTool("run_post_deploy_probe", {
    deploymentId: target.deploymentId,
    releaseImageTag: manifest.imageTag,
    releaseVersion: manifest.releaseVersion,
    reason,
    requireRemoteSupportAudit: parseBoolean(env.FLEET_RELEASE_REQUIRE_REMOTE_SUPPORT_AUDIT, false),
  }, deps);
  const sanitized = sanitizePostDeployProbe(probe);
  assertPostDeployProbeReady(sanitized, target.label);
  return sanitized;
}
