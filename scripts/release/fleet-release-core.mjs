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

export function observationTargetsFor(targets) { const selected = new Set(targets.map((target) => target.provider === "azure" ? (target.group === "managed-customers" ? "azure-managed" : "azure-selfserve") : target.provider === "railway" ? (target.group === "selfserve" ? "railway-selfserve" : (["ops", "backup-app"].includes(target.group) ? target.group : "railway-customers")) : null).filter(Boolean)); return ["railway-customers", "railway-selfserve", "azure-managed", "azure-selfserve", "ops", "backup-app"].filter((target) => selected.has(target)); }

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
        id: target.id,
        label: target.label,
        group: target.group,
        workload: target.workload ?? target.group,
        provider: target.provider,
        criticality: targetCriticality(target),
        backupOnly: target.group === "backup-app",
        url: target.url,
        resourceTarget: providerResourceTarget(target),
        blockers: target.blockers ?? [],
      })),
    })),
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
    currentRelease: row.releaseImageTag ?? row.release?.current?.releaseImageTag ?? null,
    currentReleaseVersion: row.releaseVersion ?? row.release?.current?.releaseVersion ?? null,
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
