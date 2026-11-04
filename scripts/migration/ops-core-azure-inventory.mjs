#!/usr/bin/env node
// ARM metadata only. No data-plane clients, listKeys/listSecrets, or mutation path.
import { mkdirSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createAzureTargetArmTransport, opsCoreAzureTargetDiagnostic } from "./ops-core-azure-target.mjs";
import { OPSCORE_SUBSCRIPTION, OPSCORE_GROUP, OPSCORE_SERVER, OPSCORE_ENVIRONMENT,
  OPSCORE_RESOURCE_BASE as BASE } from "./ops-core-runtime-targets.mjs";

const resource = (type, name, apiVersion, resourceType = type) => Object.freeze({ id: `${BASE}${type}/${name}`, type: resourceType, apiVersion });
export const INTENDED_OPS_TARGETS = Object.freeze({
  postgres: resource("Microsoft.DBforPostgreSQL/flexibleServers", OPSCORE_SERVER, "2025-08-01"),
  environment: resource("Microsoft.App/managedEnvironments", OPSCORE_ENVIRONMENT, "2024-03-01"),
  postgresEndpoint: resource("Microsoft.Network/privateEndpoints", "pe-corgtex-opscore-shared-pg", "2024-05-01"),
  web: resource("Microsoft.App/containerApps", "ca-corgtex-opscore-ops-web", "2024-03-01"),
  worker: resource("Microsoft.App/containerApps", "ca-corgtex-opscore-ops-worker", "2024-03-01"),
  identity: resource("Microsoft.ManagedIdentity/userAssignedIdentities", "id-corgtex-opscore-ops", "2023-01-31"),
  vault: resource("Microsoft.KeyVault/vaults", "kv-corgtexopscore-tipmed", "2023-07-01"),
  storage: resource("Microsoft.Storage/storageAccounts", "ctcorgtexoptipmedtany44y", "2023-05-01"),
  blobService: resource("Microsoft.Storage/storageAccounts", "ctcorgtexoptipmedtany44y/blobServices/default", "2023-05-01", "Microsoft.Storage/storageAccounts/blobServices"),
  objects: resource("Microsoft.Storage/storageAccounts", "ctcorgtexoptipmedtany44y/blobServices/default/containers/objects", "2023-05-01", "Microsoft.Storage/storageAccounts/blobServices/containers"),
});
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const same = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
const pick = (value, allowed) => allowed.includes(value) ? value : null;
const bool = value => typeof value === "boolean" ? value : null;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const state = value => pick(value, ["Succeeded", "Failed", "Canceled", "Updating", "Creating", "Deleting", "Ready", "Stopped", "Starting", "Stopping"]);
const access = value => pick(value, ["Enabled", "Disabled", "SecuredByPerimeter"]);
class InventoryError extends Error { constructor(code) { super(code); this.code = code; } }
const need = (condition, code) => { if (!condition) throw new InventoryError(code); };
const diagnostic = error => error instanceof InventoryError ? error.code : opsCoreAzureTargetDiagnostic(error) ?? "ARM_READ_FAILED";
const imageReference = value => typeof value === "string" && value.length <= 512
  && /^[a-z0-9][a-z0-9.-]*(?::[0-9]{1,5})?\/[a-z0-9][a-z0-9._/-]*(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}|@sha256:[a-f0-9]{64})$/.test(value) ? value : null;
const idMatch = (value, expected) => typeof value === "string" ? same(value, expected) : null;
// Three-valued predicates: a positively observed mismatch fails; missing or
// uninterpretable metadata cannot be promoted to either a match or a mismatch.
const equals = (value, expected) => value === null || value === undefined ? null : value === expected;
const all = values => values.includes(false) ? false : values.some(value => value === null || value === undefined) ? null : true;
const atLeast = (value, minimum) => value === null || value === undefined ? null : value >= minimum;
const oneOf = (value, choices) => value === null || value === undefined ? null : choices.includes(value);
const pinnedContainers = value => !Array.isArray(value) ? null : value.length === 0 ? false : all(value.map(item => item.imageDigestPinned));

function containers(template) {
  need(Array.isArray(template?.containers) && template.containers.length <= 16, "CONTAINER_METADATA_INVALID");
  return template.containers.map(container => {
    need(object(container) && (container.env === undefined || Array.isArray(container.env) && container.env.length <= 256),
      "CONTAINER_METADATA_INVALID");
    const env = container.env ?? [], image = imageReference(container.image);
    return { image, imageDigestPinned: image === null ? null : /@sha256:[a-f0-9]{64}$/.test(image),
      cpu: typeof container.resources?.cpu === "number" && Number.isFinite(container.resources.cpu) ? container.resources.cpu : null,
      memory: typeof container.resources?.memory === "string" && /^\d+(?:\.\d+)?Gi$/.test(container.resources.memory) ? container.resources.memory : null,
      environmentEntryCount: env.length,
      secretReferenceCount: env.filter(entry => typeof entry?.secretRef === "string").length,
      // Names from a fixed allowlist only; never values, secret names/URIs, command or args.
      settingsPresent: Object.fromEntries(["DATABASE_URL", "REDIS_URL", "SHARED_STATE_BACKEND", "RELEASE_SHA"].map(name => [name, env.some(entry => entry?.name === name)])) };
  });
}

function project(key, body) {
  const p = body.properties;
  const common = { provisioningState: state(p.provisioningState) };
  if (key === "postgres") return { ...common, state: state(p.state), major: typeof p.version === "string" && /^[0-9]{1,2}$/.test(p.version) ? p.version : null,
    sku: pick(body.sku?.name, ["Standard_D2ds_v5", "Standard_B2s"]), tier: pick(body.sku?.tier, ["GeneralPurpose", "Burstable"]),
    storageGiB: count(p.storage?.storageSizeGB), backupRetentionDays: count(p.backup?.backupRetentionDays),
    geoRedundantBackup: access(p.backup?.geoRedundantBackup), publicNetworkAccess: access(p.network?.publicNetworkAccess),
    hostMatchesIntended: idMatch(p.fullyQualifiedDomainName, `${OPSCORE_SERVER}.postgres.database.azure.com`) };
  if (key === "environment") return { ...common, vnetIntegrated: typeof p.vnetConfiguration?.infrastructureSubnetId === "string" ? p.vnetConfiguration.infrastructureSubnetId.length > 0 : null,
    internal: bool(p.vnetConfiguration?.internal), publicNetworkAccess: access(p.publicNetworkAccess) };
  if (key === "postgresEndpoint") {
    const regular = p.privateLinkServiceConnections ?? [], manual = p.manualPrivateLinkServiceConnections ?? [];
    need(Array.isArray(regular) && Array.isArray(manual) && regular.length + manual.length <= 16, "ENDPOINT_METADATA_INVALID");
    const hasConnections = Array.isArray(p.privateLinkServiceConnections) || Array.isArray(p.manualPrivateLinkServiceConnections);
    return { ...common, connections: !hasConnections ? null : [...regular, ...manual].map(link => ({
      targetMatchesIntended: idMatch(link?.properties?.privateLinkServiceId, INTENDED_OPS_TARGETS.postgres.id),
      postgresGroup: Array.isArray(link?.properties?.groupIds) ? link.properties.groupIds.length === 1 && link.properties.groupIds[0] === "postgresqlServer" : null,
      status: pick(link?.properties?.privateLinkServiceConnectionState?.status, ["Approved", "Pending", "Rejected", "Disconnected"]),
    })) };
  }
  if (["web", "worker"].includes(key)) return { ...common,
    environmentMatchesIntended: idMatch(p.environmentId ?? p.managedEnvironmentId, INTENDED_OPS_TARGETS.environment.id)
      && (p.environmentId === undefined || same(p.environmentId, INTENDED_OPS_TARGETS.environment.id))
      && (p.managedEnvironmentId === undefined || same(p.managedEnvironmentId, INTENDED_OPS_TARGETS.environment.id)),
    ingressExternal: bool(p.configuration?.ingress?.external),
    minReplicas: count(p.template?.scale?.minReplicas), maxReplicas: count(p.template?.scale?.maxReplicas),
    containers: containers(p.template) };
  if (key === "vault") return { ...common, enableRbacAuthorization: bool(p.enableRbacAuthorization),
    enablePurgeProtection: bool(p.enablePurgeProtection), softDeleteRetentionDays: count(p.softDeleteRetentionInDays),
    publicNetworkAccess: access(p.publicNetworkAccess) };
  if (key === "storage") return { ...common, allowSharedKeyAccess: bool(p.allowSharedKeyAccess),
    allowBlobPublicAccess: bool(p.allowBlobPublicAccess), supportsHttpsTrafficOnly: bool(p.supportsHttpsTrafficOnly),
    minimumTlsVersion: pick(p.minimumTlsVersion, ["TLS1_0", "TLS1_1", "TLS1_2"]), publicNetworkAccess: access(p.publicNetworkAccess) };
  if (key === "blobService") return { isVersioningEnabled: bool(p.isVersioningEnabled),
    blobDeleteRetentionEnabled: bool(p.deleteRetentionPolicy?.enabled), blobDeleteRetentionDays: count(p.deleteRetentionPolicy?.days),
    containerDeleteRetentionEnabled: bool(p.containerDeleteRetentionPolicy?.enabled), containerDeleteRetentionDays: count(p.containerDeleteRetentionPolicy?.days) };
  if (key === "objects") return { publicAccess: pick(p.publicAccess, ["None", "Blob", "Container"]) };
  // No tenant, principal/client identifiers or grants inferred from identity presence.
  return common;
}

function nextUrl(resourceId, apiVersion, nextLink) {
  let url;
  try { url = new URL(nextLink); } catch { throw new InventoryError("PAGINATION_INVALID"); }
  need(url.origin === "https://management.azure.com" && !url.username && !url.password && !url.hash
    && same(url.pathname, resourceId) && !/%|\\/.test(url.pathname) && url.href.length <= 8192
    && url.searchParams.getAll("api-version").length === 1 && url.searchParams.get("api-version") === apiVersion,
  "PAGINATION_INVALID");
  return url.href;
}

export async function collectOpsAzureInventory({ transport = createAzureTargetArmTransport({ subscriptionId: OPSCORE_SUBSCRIPTION }),
  signal = AbortSignal.timeout(5 * 60_000), now = () => new Date().toISOString() } = {}) {
  const startedAt = now(), observed = {}, failures = [];
  let readCount = 0;
  async function get(resourceId, apiVersion, nextLink = null) {
    need(!signal.aborted, "DEADLINE");
    need(++readCount <= 80, "READ_LIMIT");
    const response = await transport({ resourceId, apiVersion, nextLink, signal });
    need(!signal.aborted, "DEADLINE");
    need(object(response) && object(response.body), "ARM_RESPONSE_INVALID");
    return response;
  }
  async function attempt(key, work) {
    try { observed[key] = await work(); }
    catch (error) { observed[key] = { status: "UNKNOWN", code: diagnostic(error) }; failures.push(key); }
  }
  async function list(resourceId, apiVersion) {
    const values = [], seen = new Set(); let nextLink = null;
    for (let page = 0; page < 10; page++) {
      const url = nextLink ?? `https://management.azure.com${resourceId}?api-version=${apiVersion}`;
      need(!seen.has(url), "PAGINATION_CYCLE"); seen.add(url);
      const response = await get(resourceId, apiVersion, nextLink);
      need(response.status === 200 && !response.body.error && Array.isArray(response.body.value), "COLLECTION_UNPROVEN");
      values.push(...response.body.value);
      need(values.length <= 500, "COLLECTION_LIMIT");
      if (response.body.nextLink === undefined || response.body.nextLink === null || response.body.nextLink === "") return values;
      nextLink = nextUrl(resourceId, apiVersion, response.body.nextLink);
    }
    throw new InventoryError("PAGE_LIMIT");
  }
  for (const [key, target] of Object.entries(INTENDED_OPS_TARGETS)) {
    await attempt(key, async () => {
      const response = await get(target.id, target.apiVersion);
      if (response.status === 404 && response.body.error?.code === "ResourceNotFound") return { status: "ABSENT" };
      need(response.status === 200 && !response.body.error, response.status === 401 || response.status === 403 ? "ARM_ACCESS_UNPROVEN" : "ARM_STATUS_UNPROVEN");
      const body = response.body;
      need(same(body.id, target.id) && same(body.type, target.type) && object(body.properties), "RESOURCE_IDENTITY_MISMATCH");
      try { return { status: "PRESENT", id: body.id, metadata: project(key, body) }; }
      catch (error) {
        failures.push(key);
        return { status: "PRESENT", id: body.id, metadata: null, metadataCode: diagnostic(error) };
      }
    });
  }
  if (observed.postgres.status === "ABSENT") observed.firewallRules = { status: "NOT_OBSERVED" };
  else await attempt("firewallRules", async () => ({ status: "OBSERVED", count: (await list(`${INTENDED_OPS_TARGETS.postgres.id}/firewallRules`, "2025-08-01")).length }));
  for (const role of ["web", "worker"]) {
    if (observed[role].status !== "PRESENT") { observed[`${role}Revisions`] = { status: "NOT_OBSERVED" }; continue; }
    await attempt(`${role}Revisions`, async () => {
      const path = `${INTENDED_OPS_TARGETS[role].id}/revisions`, rows = await list(path, "2024-03-01"), seen = new Set();
      return { status: "OBSERVED", revisions: rows.map(row => {
        need(object(row) && typeof row.name === "string" && /^[a-zA-Z0-9][a-zA-Z0-9-]{0,127}$/.test(row.name)
          && !seen.has(row.name.toLowerCase()) && same(row.id, `${path}/${row.name}`)
          && same(row.type, "Microsoft.App/containerApps/revisions") && object(row.properties), "REVISION_IDENTITY_MISMATCH");
        seen.add(row.name.toLowerCase());
        return { id: row.id, active: bool(row.properties.active), replicas: count(row.properties.replicas),
          containers: containers(row.properties.template) };
      }) };
    });
  }
  const checks = [];
  const check = (name, keys, predicate) => {
    const unavailable = keys.some(key => !["PRESENT", "OBSERVED", "ABSENT"].includes(observed[key].status));
    const absent = keys.some(key => observed[key].status === "ABSENT");
    const result = absent ? false : unavailable ? null : predicate();
    checks.push({ name, status: result === null ? "UNKNOWN" : result ? "PASS" : "FAIL" });
  };
  for (const key of Object.keys(INTENDED_OPS_TARGETS)) check(`${key}_present`, [key], () => observed[key].status === "PRESENT");
  const metadata = key => observed[key]?.metadata ?? {};
  check("postgres_private_pg18_backup", ["postgres", "firewallRules"], () => {
    const p = metadata("postgres");
    return all([equals(p.major, "18"), equals(p.hostMatchesIntended, true), equals(p.publicNetworkAccess, "Disabled"),
      equals(p.backupRetentionDays, 14), equals(p.storageGiB, 32), equals(p.sku, "Standard_D2ds_v5"),
      equals(p.tier, "GeneralPurpose"), oneOf(p.state, ["Ready", "Stopped"]), equals(observed.firewallRules.count, 0)]);
  });
  check("postgres_endpoint_approved", ["postgresEndpoint"], () => {
    const p = metadata("postgresEndpoint"), link = p.connections?.[0];
    return all([equals(p.provisioningState, "Succeeded"), equals(p.connections?.length, 1),
      equals(link?.targetMatchesIntended, true), equals(link?.postgresGroup, true), equals(link?.status, "Approved")]);
  });
  check("environment_provisioned", ["environment"], () => all([equals(metadata("environment").provisioningState, "Succeeded"), equals(metadata("environment").vnetIntegrated, true)]));
  for (const role of ["web", "worker"]) check(`${role}_image_metadata`, [role, `${role}Revisions`], () => {
    const p = metadata(role), revisions = observed[`${role}Revisions`].revisions ?? [];
    const active = revisions.some(r => r.active === true) ? true : revisions.some(r => r.active === null) ? null : false;
    return all([equals(p.provisioningState, "Succeeded"), equals(p.environmentMatchesIntended, true), pinnedContainers(p.containers), active,
      ...revisions.map(r => all([r.active === null ? null : true, pinnedContainers(r.containers)]))]);
  });
  check("object_storage_protection", ["storage", "blobService", "objects"], () => {
    const p = metadata("storage"), b = metadata("blobService");
    return all([equals(p.allowSharedKeyAccess, false), equals(p.allowBlobPublicAccess, false), equals(p.supportsHttpsTrafficOnly, true),
      equals(p.minimumTlsVersion, "TLS1_2"), equals(b.isVersioningEnabled, true), equals(b.blobDeleteRetentionEnabled, true),
      atLeast(b.blobDeleteRetentionDays, 14), equals(b.containerDeleteRetentionEnabled, true), atLeast(b.containerDeleteRetentionDays, 14),
      equals(metadata("objects").publicAccess, "None")]);
  });
  check("vault_protection", ["vault"], () => all([equals(metadata("vault").enableRbacAuthorization, true), equals(metadata("vault").enablePurgeProtection, true)]));
  const inventoryComplete = failures.length === 0 && checks.every(item => item.status !== "UNKNOWN");
  return { schemaVersion: 1, status: inventoryComplete ? "INVENTORY_CAPTURED" : "INVENTORY_INCOMPLETE", startedAt, finishedAt: now(),
    scope: { domain: "ops", subscriptionId: OPSCORE_SUBSCRIPTION, resourceGroup: OPSCORE_GROUP, sharedStateBackendIntended: "postgres" },
    intended: INTENDED_OPS_TARGETS, observed, checks, readCount, inventoryComplete,
    armChecksPassed: checks.every(item => item.status === "PASS"), productionAccepted: false, railwayRetirementAccepted: false,
    evidenceGaps: ["Point-in-time ARM metadata is not an atomic snapshot, a writer fence or a frozen migration inventory.",
      "Runtime env values and secret contents were not inspected; Azure-only configuration, secret continuity and effective grants remain unproven.",
      "Image references are ARM declarations, not registry provenance, embedded release SHA, running process identity or health proof.",
      "Private DNS/connectivity, SQL version/extensions/collation/isolation, source ownership/parity, objects and durable jobs remain unproven.",
      "Configured backup retention is not a successful restore/PITR receipt, accepted RTO/RPO, workload/cost qualification or cutover approval.",
      "Scheduler/probe jobs, custody/archive resources, other resource groups and source Railway services are outside this bounded inventory.",
      "Core is retired into selfserve; this route does not provision or activate Core. Keep Railway Ops serving until separate acceptance."],
  };
}

export async function main(args = process.argv.slice(2)) {
  if (!args.length) { console.log(JSON.stringify({ status: "NO_EXECUTION", intended: INTENDED_OPS_TARGETS, mode: "--execute" })); return; }
  need(args.length === 1 && args[0] === "--execute", "INVALID_ARGUMENTS");
  need(process.env.AZURE_SUBSCRIPTION_ID === OPSCORE_SUBSCRIPTION, "SUBSCRIPTION_MISMATCH");
  const receipt = await collectOpsAzureInventory();
  const directory = ".artifacts/azure-ops-inventory";
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(`${directory}/summary.json`, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  console.log(JSON.stringify({ status: receipt.status, inventoryComplete: receipt.inventoryComplete, armChecksPassed: receipt.armChecksPassed,
    productionAccepted: false, receipt: `${directory}/summary.json` }));
  if (!receipt.inventoryComplete) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.log(JSON.stringify({ status: "INVENTORY_FAILED", code: diagnostic(error), rawErrorSuppressed: true })); process.exitCode = 1; });
}
