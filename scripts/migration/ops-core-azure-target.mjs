import { execFile } from "node:child_process";
import { createHash } from "node:crypto";

const ARM = "https://management.azure.com";
const API = Object.freeze({ app: "2024-03-01", postgres: "2025-08-01", redis: "2025-07-01", network: "2024-05-01" });
const GUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.()-]{0,89}$/;
const HOST = /^[a-z0-9][a-z0-9.-]{0,252}$/;
const nameValue = value => typeof value === "string" && NAME.test(value);
const hostValue = value => typeof value === "string" && HOST.test(value);
const MAX_BYTES = 2 * 1024 * 1024;
class TargetError extends Error {
  constructor(code) { super(code); this.name = "OpsCoreAzureTargetError"; this.code = code; }
}
const requireValue = (condition, code) => { if (!condition) throw new TargetError(code); };
export const opsCoreAzureTargetDiagnostic = error => error instanceof TargetError ? error.code : null;
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const keys = (value, expected) => object(value) && Object.keys(value).sort().join() === expected.split(",").sort().join();
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : object(value) ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`
    : JSON.stringify(value);
const hash = value => createHash("sha256").update(canonical(value)).digest("hex");
const sameId = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
const signalCheck = signal => requireValue(!signal.aborted, "AZURE_TARGET_ABORTED");

export function opsCoreSharedStateBackend(value) {
  const backend = value?.sharedStateBackend ?? "redis";
  requireValue(["redis", "postgres"].includes(backend), "AZURE_TARGET_SHARED_STATE_INVALID");
  return backend;
}

function bind(value) {
  const fields = "domain,subscriptionId,resourceGroupName,environmentId,postgres,redis,apps";
  const backend = opsCoreSharedStateBackend(value);
  const postgresState = backend === "postgres";
  requireValue((keys(value, fields) || keys(value, `${fields},sharedStateBackend`))
    && ["ops", "core"].includes(value.domain) && GUID.test(value.subscriptionId)
    && nameValue(value.resourceGroupName)
    && (keys(value.postgres, "resourceId,host,major,privateEndpointId")
      || keys(value.postgres, "resourceId,host,major,privateEndpointId,resourceGroupName")
        && nameValue(value.postgres.resourceGroupName))
    && (postgresState ? value.redis === null : keys(value.redis, "resourceId,databaseId,host,port,privateEndpointId"))
    && keys(value.apps, "web,worker") && nameValue(value.apps.web) && nameValue(value.apps.worker)
    && value.apps.web !== value.apps.worker && value.postgres.major === 18
    && hostValue(value.postgres.host) && value.postgres.host.endsWith(".postgres.database.azure.com")
    && (postgresState || hostValue(value.redis.host) && value.redis.host.endsWith(".redis.azure.net") && value.redis.port === 10000),
  "AZURE_TARGET_BINDING_INVALID");
  function resource(id, type, resourceGroupName = value.resourceGroupName) {
    const stem = `/subscriptions/${value.subscriptionId}/resourceGroups/${resourceGroupName}/providers/${type}/`;
    requireValue(typeof id === "string" && id.toLowerCase().startsWith(stem.toLowerCase())
      && NAME.test(id.slice(stem.length)), "AZURE_TARGET_RESOURCE_BINDING_INVALID");
  }
  resource(value.environmentId, "Microsoft.App/managedEnvironments");
  // Only the server may live outside the hosting group, by explicit binding.
  // Its endpoint stays in the hosting group and is checked against this exact
  // server on every observation. Existing binding hashes remain unchanged.
  resource(value.postgres.resourceId, "Microsoft.DBforPostgreSQL/flexibleServers",
    value.postgres.resourceGroupName ?? value.resourceGroupName);
  resource(value.postgres.privateEndpointId, "Microsoft.Network/privateEndpoints");
  if (!postgresState) {
    resource(value.redis.resourceId, "Microsoft.Cache/redisEnterprise");
    resource(value.redis.privateEndpointId, "Microsoft.Network/privateEndpoints");
    requireValue(sameId(value.redis.databaseId, `${value.redis.resourceId}/databases/default`)
      && !sameId(value.postgres.privateEndpointId, value.redis.privateEndpointId), "AZURE_TARGET_RESOURCE_BINDING_INVALID");
  }
  const result = structuredClone(value);
  Object.freeze(result.postgres); Object.freeze(result.redis); Object.freeze(result.apps);
  return Object.freeze(result);
}
export const opsCoreAzureTargetBindingSha256 = value => hash(bind(value));

function requestUrl(resourceId, apiVersion, nextLink = null) {
  const first = `${ARM}${resourceId}?api-version=${apiVersion}`;
  let url;
  try { url = new URL(nextLink ?? first); } catch { throw new TargetError("AZURE_TARGET_NEXT_LINK_INVALID"); }
  requireValue(url.origin === ARM && !url.username && !url.password && !url.hash
    && sameId(url.pathname, resourceId) && !/%|\\/.test(url.pathname)
    && url.searchParams.getAll("api-version").length === 1
    && url.searchParams.get("api-version") === apiVersion && url.href.length <= 8192,
  "AZURE_TARGET_NEXT_LINK_INVALID");
  return url.href;
}

/** Authenticated ARM GET only. No SDK/CLI error body, token or resource content is
 * logged or included in errors. Redirects and cross-resource pagination are rejected.
 */
export function createAzureTargetArmTransport({ subscriptionId, execFileImpl = execFile, fetchImpl = fetch } = {}) {
  requireValue(GUID.test(subscriptionId) && typeof execFileImpl === "function" && typeof fetchImpl === "function",
    "AZURE_TARGET_TRANSPORT_INVALID");
  return async ({ resourceId, apiVersion, nextLink = null, signal }) => {
    requireValue(signal instanceof AbortSignal && typeof resourceId === "string"
      && resourceId.toLowerCase().startsWith(`/subscriptions/${subscriptionId}/resourcegroups/`.toLowerCase())
      && Object.values(API).includes(apiVersion), "AZURE_TARGET_REQUEST_INVALID");
    const url = requestUrl(resourceId, apiVersion, nextLink);
    const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
    signalCheck(boundedSignal);
    try {
      const stdout = await new Promise((resolve, reject) => {
        execFileImpl("az", ["account", "get-access-token", "--subscription", subscriptionId,
          "--resource", `${ARM}/`, "--output", "json", "--only-show-errors"],
        { encoding: "utf8", timeout: 15_000, maxBuffer: 64 * 1024, signal: boundedSignal, shell: false },
        (error, result) => error ? reject(error) : resolve(result));
      });
      const token = JSON.parse(stdout)?.accessToken;
      requireValue(typeof token === "string" && token.length > 0 && token.length <= 32768,
        "AZURE_TARGET_TOKEN_INVALID");
      const response = await fetchImpl(url, { method: "GET", redirect: "error", signal: boundedSignal,
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
      requireValue(response.body && response.status >= 100 && response.status <= 599,
        "AZURE_TARGET_RESPONSE_INVALID");
      const reader = response.body.getReader();
      const chunks = []; let size = 0;
      try {
        while (true) {
          signalCheck(boundedSignal);
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          requireValue(size <= MAX_BYTES, "AZURE_TARGET_RESPONSE_TOO_LARGE");
          chunks.push(Buffer.from(value));
        }
      } finally { await reader.cancel().catch(() => {}); }
      signalCheck(boundedSignal);
      return { status: response.status, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
    } catch (error) {
      if (error instanceof TargetError) throw error;
      throw new TargetError(boundedSignal.aborted ? "AZURE_TARGET_ABORTED" : "AZURE_TARGET_ARM_READ_FAILED");
    }
  };
}

function identity(body, id, type, expectedName = id.split("/").at(-1)) {
  requireValue(object(body) && sameId(body.id, id) && sameId(body.type, type)
    && sameId(body.name, expectedName) && object(body.properties), "AZURE_TARGET_RESOURCE_CHANGED");
  return body.properties;
}

/** Validates only the declared web/worker runtime. The caller must retain
 * undistributed target credentials, SQL parity and protection against other DB
 * clients; ARM inactivity is not a database-wide write fence or an atomic lock.
 *
 * Official ARM 2024-03-01 revision.active and revision.replicas are required,
 * plus an empty successful replica list for each revision. A replica-list 404
 * is not zero replicas. Both collection types honor nextLink if returned.
 * https://learn.microsoft.com/en-us/rest/api/resource-manager/containerapps/container-apps-revisions/list-revisions?view=rest-resource-manager-containerapps-2024-03-01
 */
export function createOpsCoreAzureTarget({ binding: value, custody, transport, maxPages = 100 } = {}) {
  const binding = bind(value), bindingSha256 = hash(binding);
  requireValue(custody?.signal instanceof AbortSignal && typeof custody.assertOwned === "function"
    && typeof custody.snapshot === "function" && Number.isSafeInteger(maxPages) && maxPages > 0 && maxPages <= 1000,
  "AZURE_TARGET_CUSTODY_REQUIRED");
  const request = transport ?? createAzureTargetArmTransport({ subscriptionId: binding.subscriptionId });
  requireValue(typeof request === "function", "AZURE_TARGET_TRANSPORT_INVALID");
  const appId = name => `/subscriptions/${binding.subscriptionId}/resourceGroups/${binding.resourceGroupName}/providers/Microsoft.App/containerApps/${name}`;

  async function scope(action) {
    function snapshot() {
      try { return structuredClone(custody.snapshot()); }
      catch { throw new TargetError("AZURE_TARGET_CUSTODY_LOST"); }
    }
    const initial = snapshot();
    requireValue(initial.domain === binding.domain && HASH.test(initial.intentSha256), "AZURE_TARGET_CUSTODY_MISMATCH");
    const initialHash = hash(initial);
    const signal = AbortSignal.any([custody.signal, AbortSignal.timeout(120_000)]);
    let reads = 0;
    async function check() {
      signalCheck(signal);
      try { await custody.assertOwned(); } catch { throw new TargetError("AZURE_TARGET_CUSTODY_LOST"); }
      signalCheck(signal);
      requireValue(hash(snapshot()) === initialHash, "AZURE_TARGET_CUSTODY_CHANGED");
    }
    async function get(resourceId, apiVersion, { allowMissing = false, nextLink = null } = {}) {
      await check();
      requireValue(++reads <= 2000, "AZURE_TARGET_READ_LIMIT");
      requestUrl(resourceId, apiVersion, nextLink);
      let response;
      try { response = await request({ resourceId, apiVersion, nextLink, signal }); }
      catch (error) {
        if (error instanceof TargetError) throw error;
        throw new TargetError("AZURE_TARGET_ARM_READ_FAILED");
      }
      await check();
      requireValue(object(response) && object(response.body), "AZURE_TARGET_RESPONSE_INVALID");
      if (allowMissing && response.status === 404 && response.body.error?.code === "ResourceNotFound") return null;
      requireValue(response.status === 200 && !response.body.error, "AZURE_TARGET_ARM_STATUS_UNPROVEN");
      return response.body;
    }
    async function list(resourceId, apiVersion = API.app) {
      const values = [], seen = new Set(); let nextLink = null;
      for (let page = 0; page < maxPages; page++) {
        const url = requestUrl(resourceId, apiVersion, nextLink);
        requireValue(!seen.has(url), "AZURE_TARGET_PAGINATION_CYCLE"); seen.add(url);
        const body = await get(resourceId, apiVersion, { nextLink });
        requireValue(Array.isArray(body.value) && values.length + body.value.length <= 10000,
          "AZURE_TARGET_COLLECTION_INVALID");
        values.push(...body.value);
        if (body.nextLink === undefined || body.nextLink === null || body.nextLink === "") return values;
        requireValue(typeof body.nextLink === "string", "AZURE_TARGET_NEXT_LINK_INVALID");
        nextLink = body.nextLink;
      }
      throw new TargetError("AZURE_TARGET_PAGE_LIMIT");
    }
    await check();
    const result = await action({ get, list, initial });
    await check();
    return result;
  }

  async function endpoint(get, id, targetId, groupId) {
    const properties = identity(await get(id, API.network), id, "Microsoft.Network/privateEndpoints");
    const regular = properties.privateLinkServiceConnections ?? [];
    const manual = properties.manualPrivateLinkServiceConnections ?? [];
    requireValue(properties.provisioningState === "Succeeded" && Array.isArray(regular) && Array.isArray(manual),
      "AZURE_TARGET_PRIVATE_ENDPOINT_UNPROVEN");
    const links = [...regular, ...manual];
    requireValue(links.length === 1 && sameId(links[0]?.properties?.privateLinkServiceId, targetId)
      && canonical(links[0].properties.groupIds) === canonical([groupId])
      && links[0].properties.privateLinkServiceConnectionState?.status === "Approved",
    "AZURE_TARGET_PRIVATE_ENDPOINT_UNPROVEN");
  }

  async function redis(get) {
    const parent = identity(await get(binding.redis.resourceId, API.redis), binding.redis.resourceId, "Microsoft.Cache/redisEnterprise");
    // Redis database GET returns '<cluster>/default', unlike ACA revision names.
    // https://learn.microsoft.com/en-us/rest/api/redis/redisenterprisecache/databases/get?view=rest-redis-redisenterprisecache-2025-07-01
    const database = identity(await get(binding.redis.databaseId, API.redis), binding.redis.databaseId,
      "Microsoft.Cache/redisEnterprise/databases", `${binding.redis.resourceId.split("/").at(-1)}/default`);
    const geo = database.geoReplication;
    const noGeo = geo === undefined || geo === null
      || (keys(geo, "linkedDatabases") && Array.isArray(geo.linkedDatabases) && geo.linkedDatabases.length === 0);
    requireValue(parent.provisioningState === "Succeeded" && parent.hostName === binding.redis.host
      && parent.highAvailability === "Enabled" && parent.minimumTlsVersion === "1.2"
      && parent.publicNetworkAccess === "Disabled" && database.provisioningState === "Succeeded"
      && database.port === binding.redis.port && database.clientProtocol === "Encrypted"
      && database.clusteringPolicy === "EnterpriseCluster" && database.evictionPolicy === "NoEviction" && noGeo,
    "AZURE_TARGET_REDIS_POLICY_CHANGED");
    await endpoint(get, binding.redis.privateEndpointId, binding.redis.resourceId, "redisEnterprise");
    return { clusteringPolicy: "EnterpriseCluster", geoReplication: "Disabled", replicas: "HA", publicAccess: "Disabled" };
  }

  async function app(get, list, name) {
    const id = appId(name);
    const observed = await get(id, API.app, { allowMissing: true });
    if (observed === null) {
      requireValue(await get(id, API.app, { allowMissing: true }) === null, "AZURE_TARGET_APP_CHANGED");
      return { absent: true, revisions: 0, replicas: 0 };
    }
    function appIdentity(body) {
      const p = identity(body, id, "Microsoft.App/containerApps");
      requireValue(p.provisioningState === "Succeeded" && sameId(p.environmentId ?? p.managedEnvironmentId, binding.environmentId)
        && (p.environmentId === undefined || sameId(p.environmentId, binding.environmentId))
        && (p.managedEnvironmentId === undefined || sameId(p.managedEnvironmentId, binding.environmentId)),
      "AZURE_TARGET_APP_CHANGED");
      return { latestRevisionName: p.latestRevisionName ?? null, latestReadyRevisionName: p.latestReadyRevisionName ?? null };
    }
    const initial = appIdentity(observed);
    const revisionPath = `${id}/revisions`;
    async function revisions() {
      const rows = await list(revisionPath), ids = new Set();
      return rows.map(row => {
        requireValue(object(row) && nameValue(row.name) && !ids.has(row.name.toLowerCase()), "AZURE_TARGET_REVISION_INVALID");
        ids.add(row.name.toLowerCase());
        const p = identity(row, `${revisionPath}/${row.name}`, "Microsoft.App/containerApps/revisions");
        requireValue(p.active === false && p.replicas === 0, "AZURE_TARGET_APP_ACTIVE");
        return row.name;
      }).sort();
    }
    const before = await revisions();
    requireValue([initial.latestRevisionName, initial.latestReadyRevisionName].every(name => name === null || before.includes(name)),
      "AZURE_TARGET_REVISION_INVENTORY_INCOMPLETE");
    for (const revision of before) {
      const replicas = await list(`${revisionPath}/${revision}/replicas`);
      requireValue(replicas.length === 0, "AZURE_TARGET_REPLICAS_PRESENT");
    }
    requireValue(canonical(await revisions()) === canonical(before)
      && canonical(appIdentity(await get(id, API.app))) === canonical(initial), "AZURE_TARGET_APP_CHANGED");
    return { absent: false, revisions: before.length, replicas: 0 };
  }

  return Object.freeze({ binding, bindingSha256,
    async assertPostgresPrivate() {
      return scope(async ({ get, list, initial }) => {
        const verify = body => {
          const pg = identity(body, binding.postgres.resourceId, "Microsoft.DBforPostgreSQL/flexibleServers");
          requireValue(pg.state === "Ready" && pg.version === "18" && pg.fullyQualifiedDomainName === binding.postgres.host
            && pg.network?.publicNetworkAccess === "Disabled", "AZURE_TARGET_POSTGRES_PUBLIC_ACCESS_OPEN");
        };
        verify(await get(binding.postgres.resourceId, API.postgres));
        requireValue((await list(`${binding.postgres.resourceId}/firewallRules`, API.postgres)).length === 0,
          "AZURE_TARGET_POSTGRES_FIREWALL_RETAINED");
        await endpoint(get, binding.postgres.privateEndpointId, binding.postgres.resourceId, "postgresqlServer");
        verify(await get(binding.postgres.resourceId, API.postgres));
        return { complete: true, domain: binding.domain, intentSha256: initial.intentSha256,
          targetBindingSha256: bindingSha256, publicNetworkAccess: "Disabled", firewallRules: 0 };
      });
    },
    async assertInactive() {
      return scope(async ({ get, list, initial }) => {
        const environment = identity(await get(binding.environmentId, API.app), binding.environmentId, "Microsoft.App/managedEnvironments");
        requireValue(environment.provisioningState === "Succeeded", "AZURE_TARGET_ENVIRONMENT_UNREADY");
        const pg = identity(await get(binding.postgres.resourceId, API.postgres), binding.postgres.resourceId, "Microsoft.DBforPostgreSQL/flexibleServers");
        requireValue(pg.state === "Ready" && pg.version === "18" && pg.fullyQualifiedDomainName === binding.postgres.host,
          "AZURE_TARGET_POSTGRES_CHANGED");
        await endpoint(get, binding.postgres.privateEndpointId, binding.postgres.resourceId, "postgresqlServer");
        const redisPolicy = opsCoreSharedStateBackend(binding) === "redis" ? await redis(get) : { backend: "postgres" };
        const apps = { web: await app(get, list, binding.apps.web), worker: await app(get, list, binding.apps.worker) };
        return { complete: true, domain: binding.domain, intentSha256: initial.intentSha256,
          targetBindingSha256: bindingSha256, observationSha256: hash({ bindingSha256, redisPolicy, apps }),
          appCount: 2, revisionCount: apps.web.revisions + apps.worker.revisions, replicaCount: 0 };
      });
    },
    async assertEnterpriseBinding({ side, binding: expected } = {}) {
      requireValue(opsCoreSharedStateBackend(binding) === "redis" && side === "target" && expected?.mode === "azure-enterprise-proxy"
        && sameId(expected.resourceId, binding.redis.databaseId) && expected.connection?.host === binding.redis.host
        && expected.connection?.port === binding.redis.port && expected.connection?.database === 0
        && expected.connection?.tls === true, "AZURE_TARGET_REDIS_CALLBACK_BINDING_INVALID");
      return scope(async ({ get }) => {
        await redis(get);
        return { complete: true, resourceId: expected.resourceId, host: binding.redis.host, port: binding.redis.port,
          clusteringPolicy: "EnterpriseCluster", geoReplication: "Disabled" };
      });
    },
  });
}
