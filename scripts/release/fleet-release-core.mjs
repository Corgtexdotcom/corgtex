export const TARGET_GROUPS = Object.freeze([
  "managed-customers",
  "selfserve",
  "ops",
  "backup-app",
]);

export const DEFAULT_TARGET_GROUPS = Object.freeze([
  "managed-customers",
  "selfserve",
  "ops",
]);

const TARGET_GROUP_ALIASES = Object.freeze({
  "railway-customers": "managed-customers",
  "azure-selfserve": "selfserve",
});

const SUPPORTED_PROVIDERS = new Set(["azure", "railway"]);
const INELIGIBLE_STATUSES = new Set(["DRAFT", "PROVISIONING", "BOOTSTRAPPING", "READ_ONLY_PENDING_FINALIZE", "ARCHIVED", "ROLLBACK_RETAINED", "RETIRED", "SUSPENDED"]);
const MANAGED_INVENTORY_REF_PREFIX = "managed-inventory";

export const TERMINAL_RAILWAY_FAILURES = new Set([
  "CRASHED",
  "FAILED",
  "REMOVED",
  "SKIPPED",
]);

export const AZURE_PUBLIC_URL_VARIABLES = Object.freeze(["APP_URL", "NEXT_PUBLIC_APP_URL", "MEETING_RECORDER_PUBLIC_BASE_URL", "MCP_PUBLIC_URL"]);

// Keep aligned with packages/domain/src/mcp-connector.ts.
export const MCP_CONNECTOR_DEFAULT_SCOPES = Object.freeze("workspace:read brain:read governance:read context-graph:read proposals:read proposals:write actions:read actions:write tensions:read goals:read members:read meetings:read circles:read tools:read conversations:write".split(" "));

export function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(`Invalid boolean value: ${value}`);
}

export function parsePositiveInteger(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Expected a positive integer, got: ${value}`);
  }
  return parsed;
}

export function parseKeyValueArgs(argv) {
  const parsed = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      parsed._.push(arg);
      continue;
    }
    const key = arg.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = "true";
      continue;
    }
    parsed[key] = next;
    index += 1;
  }
  return parsed;
}

export function normalizeReleaseInput(value = "latest-stable") {
  const release = String(value || "latest-stable").trim();
  if (!release || release === "latest") return "latest-stable";
  if (release === "latest-stable") return release;
  return normalizeGitSha(release);
}

export function normalizeGitSha(value) {
  const sha = String(value || "").trim();
  if (!/^[0-9a-f]{40}$/i.test(sha)) {
    throw new Error(`Release must be latest-stable or a full 40-character git SHA, got: ${value || "<empty>"}`);
  }
  return sha.toLowerCase();
}

export function releaseVersionForSha(gitSha) {
  return `main-${normalizeGitSha(gitSha).slice(0, 12)}`;
}

export function imageTagForSha(gitSha) {
  return `sha-${normalizeGitSha(gitSha)}`;
}

export function normalizeTargets(value = "default") {
  const raw = String(value || "default").trim();
  if (!raw || raw === "default") return [...DEFAULT_TARGET_GROUPS];
  if (raw === "all") return [...TARGET_GROUPS];
  const selected = raw.split(",").map((part) => normalizeTargetGroup(part)).filter(Boolean);
  const invalid = selected.filter((target) => !TARGET_GROUPS.includes(target));
  if (invalid.length > 0) {
    throw new Error(`Unknown release target group(s): ${invalid.join(", ")}. Allowed: default, all, ${TARGET_GROUPS.join(", ")}`);
  }
  return [...new Set(selected)];
}

export function normalizeTargetGroup(value) { const group = String(value ?? "").trim().toLowerCase(); return TARGET_GROUP_ALIASES[group] ?? group; }

export function targetSelectionDeprecations(value) { const selected = String(value ?? "").split(",").map((part) => part.trim()).filter(Boolean); return selected.filter((group) => TARGET_GROUP_ALIASES[group]).map((group) => `${group} is deprecated; use ${TARGET_GROUP_ALIASES[group]} and declare provider per target`); }

export function buildReleaseManifest({
  gitSha,
  repository = "Corgtexdotcom/corgtex",
  ghcrRepository = repository,
  acrServer = "acrcorgtexssstgwus3.azurecr.io",
  sourceWorkflowRunId = null,
  stabilityStatus = "candidate",
  webDigest = null,
  workerDigest = null,
  ghcrWebImage = null,
  ghcrWorkerImage = null,
  acrWebImage = null,
  acrWorkerImage = null,
  createdAt = null,
} = {}) {
  const normalizedSha = normalizeGitSha(gitSha);
  const imageTag = imageTagForSha(normalizedSha);
  const ghcrBase = `ghcr.io/${String(ghcrRepository).toLowerCase()}`;
  return {
    gitSha: normalizedSha,
    releaseVersion: releaseVersionForSha(normalizedSha),
    imageTag,
    ghcrWebImage: ghcrWebImage ?? `${ghcrBase}/web:${imageTag}`,
    ghcrWorkerImage: ghcrWorkerImage ?? `${ghcrBase}/worker:${imageTag}`,
    acrWebImage: acrWebImage ?? `${acrServer}/corgtex/web:${imageTag}`,
    acrWorkerImage: acrWorkerImage ?? `${acrServer}/corgtex/worker:${imageTag}`,
    webDigest,
    workerDigest,
    sourceWorkflowRunId,
    stabilityStatus,
    createdAt: createdAt ?? new Date().toISOString(),
  };
}

export function parseManifestJson(raw) {
  if (!raw) return null;
  const parsed = JSON.parse(raw);
  return buildReleaseManifest({
    ...parsed,
    repository: parsed.repository,
    gitSha: parsed.gitSha,
    sourceWorkflowRunId: parsed.sourceWorkflowRunId ?? null,
    stabilityStatus: parsed.stabilityStatus ?? "candidate",
    webDigest: parsed.webDigest ?? null,
    workerDigest: parsed.workerDigest ?? null,
    ghcrWebImage: parsed.ghcrWebImage ?? null,
    ghcrWorkerImage: parsed.ghcrWorkerImage ?? null,
    acrWebImage: parsed.acrWebImage ?? null,
    acrWorkerImage: parsed.acrWorkerImage ?? null,
    createdAt: parsed.createdAt ?? null,
  });
}

export function healthProofErrors(health, manifest) {
  const errors = [];
  if (!health || typeof health !== "object") {
    return ["Health payload missing"];
  }
  if (health.status !== "ok") errors.push(`status=${health.status ?? "missing"}`);
  if (health.database !== "up") errors.push(`database=${health.database ?? "missing"}`);
  if (health.schema !== "ready") errors.push(`schema=${health.schema ?? "missing"}`);
  if (health.release?.imageTag !== manifest.imageTag) {
    errors.push(`release.imageTag=${health.release?.imageTag ?? "missing"}`);
  }
  if (health.release?.gitSha !== manifest.gitSha) {
    errors.push(`release.gitSha=${health.release?.gitSha ?? "missing"}`);
  }
  return errors;
}

export function assertHealthProof(health, manifest, label = "deployment") {
  const errors = healthProofErrors(health, manifest);
  if (errors.length > 0) {
    throw new Error(`${label} health proof failed: ${errors.join("; ")}`);
  }
  return true;
}

export function azurePublicUrlContract(targetUrl) {
  const url = new URL(targetUrl);
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error(`Azure target URL must be a public HTTPS origin: ${targetUrl}`);
  }
  const origin = url.origin;
  return { APP_URL: origin, NEXT_PUBLIC_APP_URL: origin, MEETING_RECORDER_PUBLIC_BASE_URL: origin, MCP_PUBLIC_URL: `${origin}/mcp` };
}

export function azureRuntimeContractErrors(targetUrl, entries) {
  const expected = azurePublicUrlContract(targetUrl);
  const rows = new Map((Array.isArray(entries) ? entries : []).map((entry) => [entry?.name, entry]));
  const errors = [];
  for (const name of AZURE_PUBLIC_URL_VARIABLES) {
    const entry = rows.get(name);
    if (!entry) {
      errors.push(`${name} is missing`);
      continue;
    }
    if (entry.secretRef || String(entry.value ?? "").startsWith("secretref:")) {
      errors.push(`${name} must not be secret-backed`);
      continue;
    }
    const actual = String(entry.value ?? "").trim();
    if (!actual) {
      errors.push(`${name} has no public value`);
    } else if (actual !== expected[name]) {
      errors.push(`${name}=${actual}; expected ${expected[name]}`);
    }
  }
  return errors;
}

export function mcpOAuthProofErrors(targetUrl, proof) {
  const contract = azurePublicUrlContract(targetUrl);
  const origin = contract.APP_URL;
  const resource = contract.MCP_PUBLIC_URL;
  const protectedResource = proof?.protectedResource ?? {};
  const authorizationServer = proof?.authorizationServer ?? {};
  const errors = [];

  if (protectedResource.resource !== resource) errors.push(`resource=${protectedResource.resource ?? "missing"}; expected ${resource}`);
  if (!sameValues(protectedResource.authorization_servers, [origin])) errors.push("authorization_servers do not match the target origin");
  if (authorizationServer.issuer !== origin) errors.push(`issuer=${authorizationServer.issuer ?? "missing"}; expected ${origin}`);
  for (const [name, path] of Object.entries({
    authorization_endpoint: "/api/oauth/authorize",
    token_endpoint: "/api/oauth/token",
    registration_endpoint: "/api/oauth/register",
    revocation_endpoint: "/api/oauth/revoke",
  })) {
    const expected = `${origin}${path}`;
    if (authorizationServer[name] !== expected) errors.push(`${name}=${authorizationServer[name] ?? "missing"}; expected ${expected}`);
  }

  const resourceScopes = protectedResource.scopes_supported;
  const serverScopes = authorizationServer.scopes_supported;
  if (!sameValues(resourceScopes, serverScopes)) errors.push("protected-resource and authorization-server scopes do not agree");
  if (!sameValues(resourceScopes, MCP_CONNECTOR_DEFAULT_SCOPES)) errors.push("protected-resource scopes do not match canonical MCP defaults");

  for (const challenge of proof?.challenges ?? []) {
    const label = challenge.path ?? "MCP endpoint";
    const header = String(challenge.header ?? "");
    const bearer = bearerChallengeParameters(header);
    if (challenge.status !== 401) errors.push(`${label} unauthenticated status=${challenge.status ?? "missing"}; expected 401`);
    if (bearer === null) errors.push(`${label} challenge must use Bearer authentication`);
    if (challengeParameter(bearer, "resource_metadata") !== `${origin}/.well-known/oauth-protected-resource`) {
      errors.push(`${label} resource_metadata challenge does not match the target origin`);
    }
    const challengeScopes = challengeParameter(bearer, "scope")?.split(/\s+/).filter(Boolean) ?? [];
    if (!sameValues(challengeScopes, resourceScopes)) errors.push(`${label} challenge scopes do not agree with protected-resource metadata`);
  }
  return errors;
}

function sameValues(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) return false;
  return [...new Set(left)].sort().join("\n") === [...new Set(right)].sort().join("\n");
}

function challengeParameter(header, name) {
  return String(header ?? "").match(new RegExp(`(?:^|[,\\s])${name}="([^"]*)"`, "i"))?.[1] ?? null;
}

function bearerChallengeParameters(header) {
  const segments = String(header).match(/(?:[^,"]|"(?:\\.|[^"\\])*")+/g)?.map((part) => part.trim()).filter(Boolean) ?? [];
  let bearer = null;
  let active = false;
  for (const segment of segments) {
    const start = segment.match(/^([!#$%&'*+\-.^_`|~\w]+)(?:\s+|$)(.*)$/);
    if (start) [active, bearer] = [start[1].toLowerCase() === "bearer", start[1].toLowerCase() === "bearer" ? start[2] : bearer];
    else if (active) bearer += `,${segment}`;
  }
  return bearer;
}

export function targetRing(target) {
  const explicit = Number(target.ring);
  if (Number.isInteger(explicit) && explicit > 0) return explicit;
  return target.group === "ops" ? 3 : 2;
}

export function groupTargetsByRing(targets) {
  const rings = new Map();
  for (const target of targets) {
    const ring = targetRing(target);
    const current = rings.get(ring) ?? [];
    current.push(target);
    rings.set(ring, current);
  }
  return [...rings.entries()]
    .sort(([left], [right]) => left - right)
    .map(([ring, ringTargets]) => ({ ring, targets: ringTargets }));
}

export function formatReleasePlan({ manifest, targets, dryRun, concurrency, deprecations = [] }) {
  return {
    dryRun,
    concurrency,
    release: {
      gitSha: manifest.gitSha,
      releaseVersion: manifest.releaseVersion,
      imageTag: manifest.imageTag,
      stabilityStatus: manifest.stabilityStatus,
    },
    deprecations,
    rings: groupTargetsByRing(targets).map(({ ring, targets: ringTargets }) => ({
      ring,
      targets: ringTargets.map((target) => ({
        id: publicTargetId(target),
        label: publicTargetLabel(target),
        group: target.group,
        workload: target.workload ?? target.group,
        provider: target.provider,
        criticality: targetCriticality(target),
        backupOnly: target.group === "backup-app",
        url: target.inventoryRef ? null : target.url,
        resourceTarget: target.inventoryRef ? null : providerResourceTarget(target),
        blockers: target.blockers ?? [],
      })),
    })),
  };
}

export function normalizeManagedInventoryOrigin(value) {
  let url;
  try {
    url = new URL(String(value ?? ""));
  } catch {
    throw new Error("managed_inventory_origin_invalid");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("managed_inventory_origin_invalid");
  }
  return url.origin.toLowerCase();
}

export function managedInventoryDigest(value) {
  const input = String(value ?? "");
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function publicTargetId(target) {
  return target.inventoryRef ?? target.id;
}

export function publicTargetLabel(target) {
  return target.inventoryRef ?? target.label;
}

export function buildManagedInventoryBlockerTarget(entry, blockers = []) {
  const inventoryRef = entry.inventoryRef ?? `${MANAGED_INVENTORY_REF_PREFIX}-${managedInventoryDigest(entry.inventoryKey ?? entry.deploymentId ?? entry.canonicalOrigin ?? "")}`;
  return {
    id: inventoryRef,
    label: inventoryRef,
    inventoryRef,
    group: "managed-customers",
    workload: "managed-customers",
    provider: entry.provider ?? null,
    blockers,
  };
}

export function validateManagedInventoryTargets(targets) {
  const entries = [];
  const blockers = [];
  const seenKeys = new Map();
  const seenOrigins = new Map();
  const seenDeploymentIds = new Map();

  for (const target of targets) {
    const inventoryKey = String(target.inventoryKey ?? "").trim();
    const inventoryRef = `${MANAGED_INVENTORY_REF_PREFIX}-${managedInventoryDigest(inventoryKey || target.deploymentId || target.url || target.id)}`;
    const entryBlockers = [];
    if (!inventoryKey) entryBlockers.push("managed_inventory_key_missing");
    if (inventoryKey && seenKeys.has(inventoryKey)) entryBlockers.push("managed_inventory_key_duplicate");
    if (!SUPPORTED_PROVIDERS.has(target.provider)) entryBlockers.push("managed_inventory_provider_invalid");
    let canonicalOrigin = null;
    try {
      canonicalOrigin = normalizeManagedInventoryOrigin(target.canonicalOrigin ?? target.url);
    } catch {
      entryBlockers.push("managed_inventory_origin_invalid");
    }
    const deploymentId = String(target.deploymentId ?? "").trim();
    if (!deploymentId) entryBlockers.push("managed_inventory_deployment_id_missing");
    if (deploymentId && seenDeploymentIds.has(deploymentId)) entryBlockers.push("managed_inventory_deployment_id_duplicate");
    if (canonicalOrigin && seenOrigins.has(canonicalOrigin)) entryBlockers.push("managed_inventory_origin_duplicate");
    const resourceBlockers = providerResourceAssertionErrors(target);
    entryBlockers.push(...resourceBlockers);

    const entry = {
      target,
      inventoryKey,
      inventoryRef,
      canonicalOrigin,
      deploymentId,
      provider: target.provider,
    };
    entries.push(entry);
    if (inventoryKey) seenKeys.set(inventoryKey, entry);
    if (deploymentId) seenDeploymentIds.set(deploymentId, entry);
    if (canonicalOrigin) seenOrigins.set(canonicalOrigin, entry);
    if (entryBlockers.length > 0) blockers.push({ target: buildManagedInventoryBlockerTarget(entry, [...new Set(entryBlockers)]), blockers: [...new Set(entryBlockers)] });
  }

  return { ok: blockers.length === 0, entries, blockers };
}

export function reconcileManagedInventoryTargets({ inventoryTargets, controlPlaneTargets, healthProofs }) {
  const validation = validateManagedInventoryTargets(inventoryTargets);
  const blockers = [...validation.blockers];
  const reconciled = [];
  const controlPlaneByDeploymentId = groupBy(controlPlaneTargets, (target) => String(target.deploymentId ?? "").trim());
  const controlPlaneByOrigin = groupBy(controlPlaneTargets, (target) => {
    try {
      return target.url ? normalizeManagedInventoryOrigin(target.url) : "";
    } catch {
      return "";
    }
  });

  for (const entry of validation.entries) {
    if (blockers.some((item) => item.target.inventoryRef === entry.inventoryRef)) continue;
    const matchesByDeploymentId = controlPlaneByDeploymentId.get(entry.deploymentId) ?? [];
    const candidates = matchesByDeploymentId.length > 0 ? matchesByDeploymentId : controlPlaneByOrigin.get(entry.canonicalOrigin) ?? [];
    const entryBlockers = [];
    if (candidates.length === 0) entryBlockers.push("control_plane_row_missing");
    if (candidates.length > 1) entryBlockers.push("control_plane_row_ambiguous");
    const controlPlane = candidates.length === 1 ? candidates[0] : null;
    if (controlPlane) {
      const controlPlaneOrigin = safeManagedOrigin(controlPlane.url);
      if (controlPlaneOrigin !== entry.canonicalOrigin) entryBlockers.push("control_plane_origin_mismatch");
      if (controlPlane.provider !== entry.provider) entryBlockers.push("control_plane_provider_mismatch");
      if (mutationIdentityForProvider(controlPlane) !== mutationIdentityForProvider(entry.target)) entryBlockers.push("control_plane_resource_mismatch");
      if (targetEligibilityErrors(controlPlane).length > 0) entryBlockers.push("control_plane_lifecycle_ineligible");
    }
    const health = healthProofs.get(entry.inventoryRef);
    if (!health) {
      entryBlockers.push("health_provider_missing");
    } else if (health.provider !== entry.provider) {
      entryBlockers.push("provider_inventory_conflict");
    }
    if (entryBlockers.length > 0) {
      blockers.push({ target: buildManagedInventoryBlockerTarget(entry, [...new Set(entryBlockers)]), blockers: [...new Set(entryBlockers)] });
      continue;
    }
    reconciled.push({
      ...entry.target,
      id: entry.target.id ?? entry.deploymentId,
      deploymentId: entry.deploymentId,
      url: entry.canonicalOrigin,
      inventoryRef: entry.inventoryRef,
      controlPlaneDeploymentId: controlPlane.deploymentId ?? controlPlane.id,
      deploymentStatus: controlPlane.deploymentStatus ?? entry.target.deploymentStatus,
      provisioningStatus: controlPlane.provisioningStatus ?? entry.target.provisioningStatus,
      releaseEligible: controlPlane.releaseEligible ?? entry.target.releaseEligible,
    });
  }

  return {
    ok: blockers.length === 0,
    targets: blockers.length === 0 ? reconciled : [],
    blockers,
    digest: managedInventoryDigest(validation.entries.map((entry) => entry.inventoryRef).sort().join(",")),
  };
}

export function targetCriticality(target) {
  return target.group === "backup-app" ? "backup-only" : "blocking";
}

export function providerBoundaryErrors(target) {
  const errors = [];
  if (!SUPPORTED_PROVIDERS.has(target.provider)) {
    errors.push(`Target provider must explicitly be azure or railway, got ${target.provider || "missing"}`);
  }
  if (target.group === "ops" && targetRing(target) !== 3) {
    errors.push("Ops targets must remain in final release ring 3");
  }
  if (target.group !== "ops" && targetRing(target) >= 3) {
    errors.push("Only Ops targets may use the final release ring");
  }
  return errors;
}

export function targetFromControlPlaneRow(row) {
  const cloudProvider = String(row.cloudProvider ?? row.provider?.cloudProvider ?? row.provider ?? "").toUpperCase();
  const label = row.label ?? row.customerName ?? row.name ?? row.customerSlug ?? row.id;
  const url = row.url ?? row.runtimeUrl ?? row.supportBaseUrl;
  const provider = cloudProvider === "AZURE" ? "azure" : cloudProvider === "RAILWAY" ? "railway" : null;
  const workload = normalizeTargetGroup(row.workload ?? (row.deploymentKind === "INTERNAL" ? "backup-app" : "managed-customers"));
  return {
    id: row.id ?? row.deploymentId ?? label,
    deploymentId: row.id ?? row.deploymentId ?? null,
    label,
    url,
    group: workload,
    workload,
    provider,
    deploymentStatus: row.deploymentStatus ?? null,
    provisioningStatus: row.provisioningStatus ?? null,
    releaseEligible: row.releaseEligible !== false,
    railway: {
      projectId: row.railwayProjectId ?? row.providerProjectId ?? null,
      environmentId: row.railwayEnvironmentId ?? row.providerEnvironmentId ?? null,
      webServiceId: row.railwayWebServiceId ?? row.providerWebServiceId ?? null,
      workerServiceId: row.railwayWorkerServiceId ?? row.providerWorkerServiceId ?? null,
    },
    azure: {
      resourceGroup: row.providerResourceGroup ?? row.azureResourceGroup ?? null,
      webAppName: row.providerWebServiceId ?? row.azureWebAppName ?? null,
      workerAppName: row.providerWorkerServiceId ?? row.azureWorkerAppName ?? null,
    },
  };
}

export function filterTargetsByGroups(targets, groups, options = {}) {
  const selected = new Set(groups);
  return targets.filter((target) => selected.has(target.group) && (options.excludeIneligible !== true || targetEligibilityErrors(target).length === 0));
}

export function targetEligibilityErrors(target) {
  const statuses = [target.deploymentStatus, target.provisioningStatus, target.status].map((value) => String(value ?? "").trim().toUpperCase()).filter(Boolean);
  const errors = statuses.filter((status) => INELIGIBLE_STATUSES.has(status)).map((status) => `Target lifecycle status ${status} is not release-eligible`);
  if (target.releaseEligible === false) errors.push("Target explicitly sets releaseEligible=false");
  return [...new Set(errors)];
}

function providerResourceTarget(target) {
  if (target.provider === "azure") return { resourceGroup: target.azure?.resourceGroup ?? null, acrName: target.azure?.acrName ?? null, webAppName: target.azure?.webAppName ?? null, workerAppName: target.azure?.workerAppName ?? null };
  if (target.provider === "railway") return { projectId: target.railway?.projectId ?? null, environmentId: target.railway?.environmentId ?? null, webServiceId: target.railway?.webServiceId ?? null, workerServiceId: target.railway?.workerServiceId ?? null };
  return null;
}

function providerResourceAssertionErrors(target) {
  if (target.provider === "azure") {
    return ["resourceGroup", "webAppName", "workerAppName"].filter((key) => !target.azure?.[key]).map((key) => `managed_inventory_azure_${key}_missing`);
  }
  if (target.provider === "railway") {
    return ["projectId", "environmentId", "webServiceId", "workerServiceId"].filter((key) => !target.railway?.[key]).map((key) => `managed_inventory_railway_${key}_missing`);
  }
  return [];
}

function mutationIdentityForProvider(target) {
  if (target.provider === "azure") return JSON.stringify(["azure", target.azure?.resourceGroup ?? null, target.azure?.webAppName ?? null, target.azure?.workerAppName ?? null]);
  if (target.provider === "railway") return JSON.stringify(["railway", target.railway?.projectId ?? null, target.railway?.environmentId ?? null, target.railway?.webServiceId ?? null, target.railway?.workerServiceId ?? null]);
  return JSON.stringify([target.provider ?? null]);
}

function safeManagedOrigin(value) {
  try {
    return normalizeManagedInventoryOrigin(value);
  } catch {
    return null;
  }
}

function groupBy(items, keyFor) {
  const groups = new Map();
  for (const item of items) {
    const key = keyFor(item);
    if (!key) continue;
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  return groups;
}
