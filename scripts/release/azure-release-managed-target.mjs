import { assessAzureReleaseWorkloadIdentity } from "./azure-release-workload-identity.mjs";

const SHA = /^[0-9a-f]{40}$/i;
const DIGEST = /^sha256:[0-9a-f]{64}$/i;
const text = (value) => typeof value === "string" && value.trim() ? value.trim() : null;

export function isManagedAzureTarget(target) {
  const result = assessAzureReleaseWorkloadIdentity(target);
  return result.status === "ready" && result.identity.group === "managed-customers";
}

export function selectManagedAzureTarget(targets, deploymentId, occurrenceCount = deploymentId ? 1 : 0) {
  const managed = targets.filter(isManagedAzureTarget);
  if (!deploymentId && managed.length === 0) return null;
  if (!deploymentId || occurrenceCount !== 1) throw new Error("Managed Azure requires exactly one explicit --deployment-id.");
  const matches = targets.filter((target) => target.deploymentId === deploymentId);
  if (matches.length !== 1) throw new Error(`--deployment-id ${deploymentId} resolved to ${matches.length} targets; expected exactly one.`);
  if (!isManagedAzureTarget(matches[0])) throw new Error(`--deployment-id ${deploymentId} is not a managed Azure target.`);
  return matches[0];
}

export function releaseShaFromTag(value) {
  const match = /^sha-([0-9a-f]{40})$/i.exec(text(value) ?? "");
  if (!match) throw new Error(`Recorded release must be sha-<40-character git SHA>, got ${value ?? "missing"}.`);
  return match[1].toLowerCase();
}

export function managedAzureContractErrors(target, options = {}) {
  const errors = [];
  const identity = assessAzureReleaseWorkloadIdentity(target);
  if (identity.status !== "ready" || identity.identity.group !== "managed-customers") errors.push(`workload identity is not managed Azure (${identity.blockerCodes.join(",") || identity.identity?.group})`);
  for (const [name, value] of [
    ["deploymentId", target?.deploymentId], ["url", target?.url], ["azure.resourceGroup", target?.azure?.resourceGroup],
    ["azure.acrName", target?.azure?.acrName], ["azure.acrServer", target?.azure?.acrServer],
    ["azure.webAppName", target?.azure?.webAppName], ["azure.workerAppName", target?.azure?.workerAppName],
  ]) if (!text(value)) errors.push(`${name} is missing`);
  if (text(target?.azure?.acrName) && text(target?.azure?.acrServer)?.toLowerCase() !== `${text(target.azure.acrName).toLowerCase()}.azurecr.io`) errors.push("azure.acrName and azure.acrServer do not identify the same registry");
  try { if (new URL(target?.url).protocol !== "https:") errors.push("url must use HTTPS"); } catch { if (text(target?.url)) errors.push("url must be a valid HTTPS URL"); }
  if (!SHA.test(text(options.release) ?? "")) errors.push("release must be an explicit full 40-character git SHA");
  if (!text(options.expectedCurrentRelease)) errors.push("--expected-current-release is required");
  if (!text(options.rollbackFile)) errors.push("FLEET_RELEASE_ROLLBACK_FILE is required");
  if (options.requireCurrentRelease) {
    if (!text(target?.currentRelease)) errors.push("control-plane current release is missing");
    else {
      if (target.currentRelease !== options.expectedCurrentRelease) errors.push(`expected current release ${options.expectedCurrentRelease} does not match control plane ${target.currentRelease}`);
      try { releaseShaFromTag(target.currentRelease); } catch (error) { errors.push(error.message); }
    }
  }
  if (!options.dryRun) {
    if (!options.auditedWorkflow) errors.push("managed Azure mutation requires an audited workflow_dispatch run");
    if (options.observationDeploymentId !== target?.deploymentId) errors.push("tenant-scoped managed Azure observation is not configured for this deployment");
  }
  return [...new Set(errors)];
}

export function managedAzureRegistryErrors(target, registries = {}) {
  const errors = [];
  for (const role of ["web", "worker"]) {
    const rows = Array.isArray(registries[role]) ? registries[role] : [];
    const match = rows.find((row) => text(row?.server)?.toLowerCase() === text(target?.azure?.acrServer)?.toLowerCase());
    if (!match) errors.push(`${role} Container App registry entry for azure.acrServer is missing`);
    else if (!text(match.identity)) errors.push(`${role} Container App registry pull identity is missing`);
  }
  return errors;
}

export function normalizeImageDigest(value) {
  const digest = text(value);
  if (!DIGEST.test(digest ?? "")) throw new Error(`Expected sha256 image digest, got ${value ?? "missing"}.`);
  return digest.toLowerCase();
}

export function digestPinnedImage(value) {
  return typeof value === "string" && /@sha256:[0-9a-f]{64}$/i.test(value);
}

export function buildManagedAzureRollbackRecord(target, manifest, previous, incoming, capturedAt) {
  const rollbackDigestPinned = digestPinnedImage(previous.web.image) && digestPinnedImage(previous.worker.image);
  return {
    schemaVersion: 1, capturedAt, rollbackDigestPinned,
    target: { deploymentId: target.deploymentId, label: target.label, url: target.url, provider: target.provider, group: target.group, workload: target.workload, azure: { ...target.azure } },
    previous: { releaseImageTag: target.currentRelease, releaseVersion: target.currentReleaseVersion ?? null, ...previous },
    incoming: { releaseImageTag: manifest.imageTag, releaseVersion: manifest.releaseVersion, gitSha: manifest.gitSha, webDigest: normalizeImageDigest(incoming.webDigest), workerDigest: normalizeImageDigest(incoming.workerDigest) },
  };
}

export function managedAzureRollbackRecordErrors(record) {
  const errors = [];
  if (!record || typeof record !== "object" || Array.isArray(record)) return ["rollback record must be an object"];
  if (record.schemaVersion !== 1) errors.push("schemaVersion must be 1");
  if (!text(record.capturedAt) || Number.isNaN(Date.parse(record.capturedAt))) errors.push("capturedAt must be an ISO timestamp");
  if (!isManagedAzureTarget(record.target)) errors.push("target must be managed Azure");
  let previousSha = null;
  try { previousSha = releaseShaFromTag(record.previous?.releaseImageTag); } catch (error) { errors.push(error.message); }
  errors.push(...managedAzureContractErrors(record.target, { release: previousSha, expectedCurrentRelease: record.previous?.releaseImageTag, rollbackFile: "record", dryRun: true }));
  if (record.previous?.releaseVersion != null && !text(record.previous.releaseVersion)) errors.push("previous.releaseVersion is invalid");
  try { if (releaseShaFromTag(record.incoming?.releaseImageTag) !== record.incoming?.gitSha) errors.push("incoming gitSha does not match releaseImageTag"); } catch (error) { errors.push(`incoming ${error.message}`); }
  for (const role of ["web", "worker"]) {
    const image = record.previous?.[role]?.image, prefix = `${record.target?.azure?.acrServer}/corgtex/${role}@`;
    if (!digestPinnedImage(image) || !image.toLowerCase().startsWith(prefix.toLowerCase())) errors.push(`previous.${role}.image must be target-registry digest-pinned`);
    if (!text(record.previous?.[role]?.readyRevision)) errors.push(`previous.${role}.readyRevision is missing`);
    try { normalizeImageDigest(record.incoming?.[`${role}Digest`]); } catch (error) { errors.push(`incoming.${role}Digest is invalid`); }
  }
  if (record.rollbackDigestPinned !== true) errors.push("rollbackDigestPinned must be true");
  return [...new Set(errors)];
}
