import assert from "node:assert/strict";
import { test } from "node:test";
import { createAzureTargetArmTransport, createOpsCoreAzureTarget, opsCoreAzureTargetBindingSha256,
  opsCoreAzureTargetDiagnostic } from "./ops-core-azure-target.mjs";

const subscriptionId = "00000000-0000-4000-8000-000000000001";
const prefix = `/subscriptions/${subscriptionId}/resourceGroups/fixture/providers/`;
const appId = name => `${prefix}Microsoft.App/containerApps/${name}`;
const binding = () => ({ domain: "ops", subscriptionId, resourceGroupName: "fixture",
  environmentId: `${prefix}Microsoft.App/managedEnvironments/fixture`,
  postgres: { resourceId: `${prefix}Microsoft.DBforPostgreSQL/flexibleServers/fixture-pg`,
    host: "fixture-pg.postgres.database.azure.com", major: 18,
    privateEndpointId: `${prefix}Microsoft.Network/privateEndpoints/fixture-pg` },
  redis: { resourceId: `${prefix}Microsoft.Cache/redisEnterprise/fixture-redis`,
    databaseId: `${prefix}Microsoft.Cache/redisEnterprise/fixture-redis/databases/default`,
    host: "fixture-redis.westus3.redis.azure.net", port: 10000,
    privateEndpointId: `${prefix}Microsoft.Network/privateEndpoints/fixture-redis` },
  apps: { web: "fixture-web", worker: "fixture-worker" } });
const resource = (id, properties) => ({ id, name: id.includes("/Microsoft.Cache/redisEnterprise/") && id.endsWith("/databases/default")
  ? `${id.split("/").at(-3)}/default` : id.split("/").at(-1),
  type: id.split("/providers/")[1].split("/").filter((_, i) => i === 0 || i % 2 === 1).join("/"), properties });
const missing = () => ({ status: 404, body: { error: { code: "ResourceNotFound", message: "unprinted provider detail" } } });
const revision = (name, props = {}) => resource(`${appId("fixture-web")}/revisions/${name}`, { active: false, replicas: 0, ...props });
const pageUrl = (path, token = "next") => `https://management.azure.com${path}?api-version=2024-03-01&$skiptoken=${token}`;
function fixture({ apps = false, mutate, maxPages = 100, postgresState = false, postgresGroup } = {}) {
  const b = binding(), controller = new AbortController(), calls = [];
  if (postgresGroup) {
    b.postgres.resourceGroupName = postgresGroup;
    b.postgres.resourceId = b.postgres.resourceId.replace("/resourceGroups/fixture/", `/resourceGroups/${postgresGroup}/`);
  }
  const snapshot = { domain: "ops", intentSha256: "a".repeat(64), phase: "PREPARED", pending: null };
  const map = new Map();
  const set = (id, value) => map.set(id, { status: 200, body: value });
  set(b.environmentId, resource(b.environmentId, { provisioningState: "Succeeded" }));
  set(b.postgres.resourceId, resource(b.postgres.resourceId, { state: "Ready", version: "18", fullyQualifiedDomainName: b.postgres.host,
    network: { publicNetworkAccess: "Disabled" } }));
  set(`${b.postgres.resourceId}/firewallRules`, { value: [] });
  set(b.redis.resourceId, resource(b.redis.resourceId, { provisioningState: "Succeeded", hostName: b.redis.host,
    highAvailability: "Enabled", minimumTlsVersion: "1.2", publicNetworkAccess: "Disabled" }));
  set(b.redis.databaseId, resource(b.redis.databaseId, { provisioningState: "Succeeded", port: 10000,
    clientProtocol: "Encrypted", clusteringPolicy: "EnterpriseCluster", evictionPolicy: "NoEviction" }));
  for (const [service, group] of [[b.postgres, "postgresqlServer"], [b.redis, "redisEnterprise"]]) {
    set(service.privateEndpointId, resource(service.privateEndpointId, { provisioningState: "Succeeded",
      privateLinkServiceConnections: [{ properties: { privateLinkServiceId: service.resourceId,
        groupIds: [group], privateLinkServiceConnectionState: { status: "Approved" } } }] }));
  }
  for (const name of Object.values(b.apps)) {
    map.set(appId(name), apps ? { status: 200, body: resource(appId(name), {
      provisioningState: "Succeeded", environmentId: b.environmentId }) } : missing());
    set(`${appId(name)}/revisions`, { value: [] });
  }
  const custody = { signal: controller.signal, snapshot: () => structuredClone(snapshot),
    async assertOwned() { calls.push("custody"); } };
  if (postgresState) { b.sharedStateBackend = "postgres"; b.redis = null; }
  const adapter = createOpsCoreAzureTarget({ binding: b, custody, maxPages,
    async transport(request) {
      calls.push(request);
      const result = structuredClone(map.get(request.nextLink ?? request.resourceId));
      assert.ok(result, `Missing mock for ${request.resourceId}`);
      mutate?.(request, result, snapshot);
      return result;
    } });
  return { b, adapter, map, set, snapshot, calls, controller, custody };
}
const rejects = (promise, code) => assert.rejects(promise, error => opsCoreAzureTargetDiagnostic(error) === code);

test("explicit cross-group PostgreSQL retains exact private endpoint and app custody checks", async () => {
  const f = fixture({ postgresState: true, postgresGroup: "database-custody" });
  assert.equal((await f.adapter.assertInactive()).complete, true);
  assert.equal((await f.adapter.assertPostgresPrivate()).complete, true);
  assert.equal(f.adapter.binding.postgres.resourceGroupName, "database-custody");
  const reads = f.calls.filter(x => typeof x === "object");
  assert.ok(reads.some(x => x.resourceId === f.b.postgres.resourceId));
  assert.ok(reads.some(x => x.resourceId === f.b.postgres.privateEndpointId));
  assert.ok(reads.some(x => x.resourceId === appId(f.b.apps.web)));
  assert.ok(reads.every(x => !x.resourceId.includes("Microsoft.Cache/")));
});

test("cross-group opt-in cannot broaden the subscription, server type, endpoint or environment scope", () => {
  for (const change of [
    b => { delete b.postgres.resourceGroupName; },
    b => { b.postgres.resourceGroupName = "different"; },
    b => { b.postgres.resourceGroupName = ""; },
    b => { b.postgres.resourceGroupName = null; },
    b => { b.postgres.resourceGroupName = "../database-custody"; },
    b => { b.postgres.resourceId = b.postgres.resourceId.replace(subscriptionId, "00000000-0000-4000-8000-000000000002"); },
    b => { b.postgres.resourceId += "/databases/corgtex_ops"; },
    b => { b.postgres.resourceId = b.postgres.resourceId.replace("flexibleServers", "servers"); },
    b => { b.postgres.privateEndpointId = b.postgres.privateEndpointId.replace("/fixture/", "/database-custody/"); },
    b => { b.environmentId = b.environmentId.replace("/fixture/", "/database-custody/"); },
  ]) {
    const b = structuredClone(fixture({ postgresGroup: "database-custody" }).b);
    change(b);
    assert.throws(() => opsCoreAzureTargetBindingSha256(b), /AZURE_TARGET_(RESOURCE_)?BINDING_INVALID/);
  }
});

test("explicit PostgreSQL group participates in the binding hash without changing legacy bindings", () => {
  const legacy = binding(), explicit = structuredClone(legacy);
  explicit.postgres.resourceGroupName = "fixture";
  assert.notEqual(opsCoreAzureTargetBindingSha256(legacy), opsCoreAzureTargetBindingSha256(explicit));
  assert.equal(Object.hasOwn(createOpsCoreAzureTarget({ binding: legacy, custody: fixture().custody }).binding.postgres, "resourceGroupName"), false);
});

test("cross-group PostgreSQL still rejects a wrong endpoint target, FQDN or later-page firewall", async () => {
  for (const [change, code] of [
    [f => { f.map.get(f.b.postgres.privateEndpointId).body.properties.privateLinkServiceConnections[0].properties.privateLinkServiceId = binding().postgres.resourceId; }, "AZURE_TARGET_PRIVATE_ENDPOINT_UNPROVEN"],
    [f => { f.map.get(f.b.postgres.resourceId).body.properties.fullyQualifiedDomainName = "other.postgres.database.azure.com"; }, "AZURE_TARGET_POSTGRES_PUBLIC_ACCESS_OPEN"],
    [f => {
      const path = `${f.b.postgres.resourceId}/firewallRules`;
      const nextLink = pageUrl(path).replace("2024-03-01", "2025-08-01");
      f.set(path, { value: [], nextLink }); f.set(nextLink, { value: [{ name: "still-open" }] });
    }, "AZURE_TARGET_POSTGRES_FIREWALL_RETAINED"],
  ]) {
    const f = fixture({ postgresGroup: "database-custody" }); change(f);
    await rejects(f.adapter.assertPostgresPrivate(), code);
  }
});

test("cross-group PostgreSQL rejects reopened public access on the final read", async () => {
  let reads = 0;
  const f = fixture({ postgresGroup: "database-custody", mutate(q, r) {
    if (q.resourceId.endsWith("/flexibleServers/fixture-pg") && ++reads === 2) r.body.properties.network.publicNetworkAccess = "Enabled";
  } });
  await rejects(f.adapter.assertPostgresPrivate(), "AZURE_TARGET_POSTGRES_PUBLIC_ACCESS_OPEN");
  assert.equal(reads, 2);
});

test("private PostgreSQL proof exhausts firewall pages and rereads identity under custody", async () => {
  const f = fixture(), path = `${f.b.postgres.resourceId}/firewallRules`;
  const nextLink = pageUrl(path).replace("2024-03-01", "2025-08-01");
  f.set(path, { value: [], nextLink }); f.set(nextLink, { value: [], nextLink: null });
  assert.deepEqual(await f.adapter.assertPostgresPrivate(), { complete: true, domain: "ops",
    intentSha256: f.snapshot.intentSha256, targetBindingSha256: opsCoreAzureTargetBindingSha256(f.b),
    publicNetworkAccess: "Disabled", firewallRules: 0 });
  const reads = f.calls.filter(x => typeof x === "object");
  assert.equal(reads.filter(x => x.resourceId === f.b.postgres.resourceId).length, 2);
  assert.equal(reads.filter(x => x.nextLink === nextLink).length, 1);
  assert.equal(reads.at(-1).resourceId, f.b.postgres.resourceId);
  for (let i = 0; i < f.calls.length; i++) if (typeof f.calls[i] === "object") {
    assert.equal(f.calls[i - 1], "custody"); assert.equal(f.calls[i + 1], "custody");
  }
});

for (const [label, change, code] of [
  ["public access enabled", f => { f.map.get(f.b.postgres.resourceId).body.properties.network.publicNetworkAccess = "Enabled"; }, "AZURE_TARGET_POSTGRES_PUBLIC_ACCESS_OPEN"],
  ["missing network", f => { delete f.map.get(f.b.postgres.resourceId).body.properties.network; }, "AZURE_TARGET_POSTGRES_PUBLIC_ACCESS_OPEN"],
  ["missing public access state", f => { delete f.map.get(f.b.postgres.resourceId).body.properties.network.publicNetworkAccess; }, "AZURE_TARGET_POSTGRES_PUBLIC_ACCESS_OPEN"],
  ["foreign PostgreSQL identity", f => { f.map.get(f.b.postgres.resourceId).body.id += "-foreign"; }, "AZURE_TARGET_RESOURCE_CHANGED"],
  ["retained firewall rule", f => { f.set(`${f.b.postgres.resourceId}/firewallRules`, { value: [{ name: "restore-window" }] }); }, "AZURE_TARGET_POSTGRES_FIREWALL_RETAINED"],
  ["missing firewall inventory", f => { f.map.set(`${f.b.postgres.resourceId}/firewallRules`, missing()); }, "AZURE_TARGET_ARM_STATUS_UNPROVEN"],
  ["pending PostgreSQL private endpoint", f => { f.map.get(f.b.postgres.privateEndpointId).body.properties.privateLinkServiceConnections[0].properties.privateLinkServiceConnectionState.status = "Pending"; }, "AZURE_TARGET_PRIVATE_ENDPOINT_UNPROVEN"],
]) test(`private PostgreSQL proof rejects ${label}`, async () => {
  const f = fixture(); change(f); await rejects(f.adapter.assertPostgresPrivate(), code);
});

test("private PostgreSQL proof rejects a firewall rule on a later page", async () => {
  const f = fixture(), path = `${f.b.postgres.resourceId}/firewallRules`;
  const nextLink = pageUrl(path).replace("2024-03-01", "2025-08-01");
  f.set(path, { value: [], nextLink }); f.set(nextLink, { value: [{ name: "restore-window" }] });
  await rejects(f.adapter.assertPostgresPrivate(), "AZURE_TARGET_POSTGRES_FIREWALL_RETAINED");
  assert.ok(f.calls.some(x => x.nextLink === nextLink));
});

for (const [label, change] of [
  ["reopened network", pg => { pg.network.publicNetworkAccess = "Enabled"; }],
  ["changed host", pg => { pg.fullyQualifiedDomainName = "foreign.postgres.database.azure.com"; }],
]) test(`private PostgreSQL final read rejects ${label}`, async () => {
  let reads = 0;
  const f = fixture({ mutate(q, r) {
    if (q.resourceId === binding().postgres.resourceId && ++reads === 2) change(r.body.properties);
  } });
  await rejects(f.adapter.assertPostgresPrivate(), "AZURE_TARGET_POSTGRES_PUBLIC_ACCESS_OPEN");
  assert.equal(reads, 2);
});

test("transfer inactivity remains compatible with an open PostgreSQL restore window", async () => {
  const f = fixture();
  f.map.get(f.b.postgres.resourceId).body.properties.network.publicNetworkAccess = "Enabled";
  f.set(`${f.b.postgres.resourceId}/firewallRules`, { value: [{ name: "restore-window" }] });
  assert.equal((await f.adapter.assertInactive()).complete, true);
  await rejects(f.adapter.assertPostgresPrivate(), "AZURE_TARGET_POSTGRES_PUBLIC_ACCESS_OPEN");
});

test("fresh bound absent-app proof is redacted and each ARM read is enclosed by custody", async () => {
  const f = fixture();
  const result = await f.adapter.assertInactive();
  assert.equal(result.complete, true); assert.equal(result.replicaCount, 0);
  assert.equal(result.targetBindingSha256, opsCoreAzureTargetBindingSha256(f.b));
  assert.match(result.observationSha256, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(result).includes("fixture"), false);
  for (let i = 0; i < f.calls.length; i++) if (typeof f.calls[i] === "object") {
    assert.equal(f.calls[i - 1], "custody"); assert.equal(f.calls[i + 1], "custody");
  }
  assert.equal(f.calls.filter(x => x.resourceId === appId(f.b.apps.web)).length, 2);
  f.b.apps.web = "changed";
  assert.equal(f.adapter.binding.apps.web, "fixture-web");
  assert.throws(() => { f.adapter.binding.redis.port = 1; }, TypeError);
});

test("fully paginated stopped revisions require successful empty replica lists and stable re-read", async () => {
  const f = fixture({ apps: true }), path = `${appId(f.b.apps.web)}/revisions`;
  f.set(path, { value: [revision("web--a")], nextLink: pageUrl(path) });
  f.set(pageUrl(path), { value: [revision("web--b")], nextLink: null });
  for (const name of ["web--a", "web--b"]) f.set(`${path}/${name}/replicas`, { value: [] });
  const result = await f.adapter.assertInactive();
  assert.equal(result.revisionCount, 2);
  assert.equal(f.calls.filter(x => x.nextLink === pageUrl(path)).length, 2);
});

for (const [label, change, code] of [
  ["wrong PG host", f => { f.map.get(f.b.postgres.resourceId).body.properties.fullyQualifiedDomainName = "foreign"; }, "AZURE_TARGET_POSTGRES_CHANGED"],
  ["wrong PG version", f => { f.map.get(f.b.postgres.resourceId).body.properties.version = "17"; }, "AZURE_TARGET_POSTGRES_CHANGED"],
  ["PG updating", f => { f.map.get(f.b.postgres.resourceId).body.properties.state = "Updating"; }, "AZURE_TARGET_POSTGRES_CHANGED"],
  ["environment updating", f => { f.map.get(f.b.environmentId).body.properties.provisioningState = "Updating"; }, "AZURE_TARGET_ENVIRONMENT_UNREADY"],
  ["foreign resource", f => { f.map.get(f.b.environmentId).body.id += "-foreign"; }, "AZURE_TARGET_RESOURCE_CHANGED"],
  ["wrong resource type", f => { f.map.get(f.b.environmentId).body.type = "Microsoft.App/containerApps"; }, "AZURE_TARGET_RESOURCE_CHANGED"],
  ["Redis public", f => { f.map.get(f.b.redis.resourceId).body.properties.publicNetworkAccess = "Enabled"; }, "AZURE_TARGET_REDIS_POLICY_CHANGED"],
  ["Redis no HA", f => { f.map.get(f.b.redis.resourceId).body.properties.highAvailability = "Disabled"; }, "AZURE_TARGET_REDIS_POLICY_CHANGED"],
  ["Redis old TLS", f => { f.map.get(f.b.redis.resourceId).body.properties.minimumTlsVersion = "1.1"; }, "AZURE_TARGET_REDIS_POLICY_CHANGED"],
  ["Redis OSSCluster", f => { f.map.get(f.b.redis.databaseId).body.properties.clusteringPolicy = "OSSCluster"; }, "AZURE_TARGET_REDIS_POLICY_CHANGED"],
  ["Redis plaintext", f => { f.map.get(f.b.redis.databaseId).body.properties.clientProtocol = "Plaintext"; }, "AZURE_TARGET_REDIS_POLICY_CHANGED"],
  ["Redis eviction", f => { f.map.get(f.b.redis.databaseId).body.properties.evictionPolicy = "AllKeysLRU"; }, "AZURE_TARGET_REDIS_POLICY_CHANGED"],
  ["Redis port drift", f => { f.map.get(f.b.redis.databaseId).body.properties.port = 6379; }, "AZURE_TARGET_REDIS_POLICY_CHANGED"],
  ["Redis geo", f => { f.map.get(f.b.redis.databaseId).body.properties.geoReplication = { linkedDatabases: [{ id: "foreign" }] }; }, "AZURE_TARGET_REDIS_POLICY_CHANGED"],
  ["Redis geo group", f => { f.map.get(f.b.redis.databaseId).body.properties.geoReplication = { groupNickname: "future", linkedDatabases: [] }; }, "AZURE_TARGET_REDIS_POLICY_CHANGED"],
  ["pending endpoint", f => { f.map.get(f.b.redis.privateEndpointId).body.properties.privateLinkServiceConnections[0].properties.privateLinkServiceConnectionState.status = "Pending"; }, "AZURE_TARGET_PRIVATE_ENDPOINT_UNPROVEN"],
  ["foreign endpoint target", f => { f.map.get(f.b.postgres.privateEndpointId).body.properties.privateLinkServiceConnections[0].properties.privateLinkServiceId = f.b.redis.resourceId; }, "AZURE_TARGET_PRIVATE_ENDPOINT_UNPROVEN"],
  ["foreign app environment", f => { f.map.get(appId(f.b.apps.web)).body.properties.environmentId += "-foreign"; }, "AZURE_TARGET_APP_CHANGED"],
  ["active revision with zero pods", f => { f.set(`${appId(f.b.apps.web)}/revisions`, { value: [revision("web--a", { active: true })] }); }, "AZURE_TARGET_APP_ACTIVE"],
  ["inactive revision with pods", f => { f.set(`${appId(f.b.apps.web)}/revisions`, { value: [revision("web--a", { replicas: 1 })] }); }, "AZURE_TARGET_APP_ACTIVE"],
  ["missing replica count", f => { const r = revision("web--a"); delete r.properties.replicas; f.set(`${appId(f.b.apps.web)}/revisions`, { value: [r] }); }, "AZURE_TARGET_APP_ACTIVE"],
  ["unlisted latest revision", f => { f.map.get(appId(f.b.apps.web)).body.properties.latestRevisionName = "not-listed"; }, "AZURE_TARGET_REVISION_INVENTORY_INCOMPLETE"],
  ["missing collection", f => { f.set(`${appId(f.b.apps.web)}/revisions`, {}); }, "AZURE_TARGET_COLLECTION_INVALID"],
]) test(`rejects ${label}`, async () => {
  const f = fixture({ apps: true }); change(f); await rejects(f.adapter.assertInactive(), code);
});

for (const status of [401, 403, 429, 500]) test(`HTTP ${status} cannot prove app absence`, async () => {
  const f = fixture(); f.map.set(appId(f.b.apps.web), { status, body: missing().body });
  await rejects(f.adapter.assertInactive(), "AZURE_TARGET_ARM_STATUS_UNPROVEN");
});
test("only exact ResourceNotFound 404 proves absence", async () => {
  const f = fixture(); f.map.get(appId(f.b.apps.web)).body.error.code = "ResourceGroupNotFound";
  await rejects(f.adapter.assertInactive(), "AZURE_TARGET_ARM_STATUS_UNPROVEN");
});
test("app appearing between absence reads invalidates proof", async () => {
  let count = 0;
  const f = fixture({ mutate: (r, result) => {
    if (r.resourceId === appId("fixture-web") && ++count === 2) {
      result.status = 200; result.body = resource(r.resourceId, {});
    }
  } });
  await rejects(f.adapter.assertInactive(), "AZURE_TARGET_APP_CHANGED");
});
test("replica pages are followed and a second-page replica blocks", async () => {
  const f = fixture({ apps: true }), path = `${appId(f.b.apps.web)}/revisions`, replicas = `${path}/web--a/replicas`;
  f.set(path, { value: [revision("web--a")] });
  f.set(replicas, { value: [], nextLink: pageUrl(replicas) });
  f.set(pageUrl(replicas), { value: [{ name: "retained-pod" }] });
  await rejects(f.adapter.assertInactive(), "AZURE_TARGET_REPLICAS_PRESENT");
});
test("replica-list 404 is not zero replicas", async () => {
  const f = fixture({ apps: true }), path = `${appId(f.b.apps.web)}/revisions`;
  f.set(path, { value: [revision("web--a")] }); f.map.set(`${path}/web--a/replicas`, missing());
  await rejects(f.adapter.assertInactive(), "AZURE_TARGET_ARM_STATUS_UNPROVEN");
});
for (const [label, link] of [
  ["foreign origin", "https://example.com/steal?api-version=2024-03-01"],
  ["foreign resource", pageUrl(`${appId("foreign")}/revisions`)],
  ["changed API", pageUrl(`${appId("fixture-web")}/revisions`).replace("2024-03-01", "2025-07-01")],
]) test(`rejects pagination ${label}`, async () => {
  const f = fixture({ apps: true }); f.set(`${appId(f.b.apps.web)}/revisions`, { value: [], nextLink: link });
  await rejects(f.adapter.assertInactive(), "AZURE_TARGET_NEXT_LINK_INVALID");
});
test("pagination cycles and limits fail closed", async () => {
  const f = fixture({ apps: true }), path = `${appId(f.b.apps.web)}/revisions`;
  f.set(path, { value: [], nextLink: pageUrl(path) }); f.set(pageUrl(path), { value: [], nextLink: pageUrl(path) });
  await rejects(f.adapter.assertInactive(), "AZURE_TARGET_PAGINATION_CYCLE");
  const g = fixture({ apps: true, maxPages: 1 }); g.set(path, { value: [], nextLink: pageUrl(path) });
  await rejects(g.adapter.assertInactive(), "AZURE_TARGET_PAGE_LIMIT");
});
test("custody change after a successful read blocks and abort prevents reads", async () => {
  const f = fixture({ mutate: (_, __, snapshot) => { snapshot.phase = "TARGET_ACTIVATING"; } });
  await rejects(f.adapter.assertInactive(), "AZURE_TARGET_CUSTODY_CHANGED");
  const g = fixture(); g.controller.abort(); await rejects(g.adapter.assertInactive(), "AZURE_TARGET_ABORTED");
  assert.equal(g.calls.length, 0);
});
test("enterprise callback freshly binds exact target only", async () => {
  const f = fixture(), gate = { mode: "azure-enterprise-proxy", resourceId: f.b.redis.databaseId,
    connection: { host: f.b.redis.host, port: 10000, database: 0, tls: true } };
  assert.deepEqual(await f.adapter.assertEnterpriseBinding({ side: "target", binding: gate }), {
    complete: true, resourceId: gate.resourceId, host: gate.connection.host, port: 10000,
    clusteringPolicy: "EnterpriseCluster", geoReplication: "Disabled" });
  await rejects(f.adapter.assertEnterpriseBinding({ side: "source", binding: gate }), "AZURE_TARGET_REDIS_CALLBACK_BINDING_INVALID");
  f.map.get(f.b.redis.databaseId).body.properties.clusteringPolicy = "OSSCluster";
  await rejects(f.adapter.assertEnterpriseBinding({ side: "target", binding: gate }), "AZURE_TARGET_REDIS_POLICY_CHANGED");
});
test("Redis child GET uses the official cluster/default name in both guard methods", async () => {
  const f = fixture();
  assert.equal(f.map.get(f.b.redis.databaseId).body.name, "fixture-redis/default");
  assert.equal((await f.adapter.assertInactive()).complete, true);
  const gate = { mode: "azure-enterprise-proxy", resourceId: f.b.redis.databaseId,
    connection: { host: f.b.redis.host, port: 10000, database: 0, tls: true } };
  assert.equal((await f.adapter.assertEnterpriseBinding({ side: "target", binding: gate })).complete, true);
});
test("Redis child name validation still rejects wrong name, ID and type in both guard methods", async () => {
  for (const mutation of [row => { row.name = "default"; }, row => { row.name = "foreign/default"; },
    row => { row.id = row.id.replace("fixture-redis/", "foreign/"); },
    row => { row.type = "Microsoft.Cache/redisEnterprise"; }]) {
    const f = fixture(); mutation(f.map.get(f.b.redis.databaseId).body);
    const gate = { mode: "azure-enterprise-proxy", resourceId: f.b.redis.databaseId,
      connection: { host: f.b.redis.host, port: 10000, database: 0, tls: true } };
    await rejects(f.adapter.assertInactive(), "AZURE_TARGET_RESOURCE_CHANGED");
    await rejects(f.adapter.assertEnterpriseBinding({ side: "target", binding: gate }), "AZURE_TARGET_RESOURCE_CHANGED");
  }
});
test("binding cannot escape its subscription, group or declared child resource", () => {
  for (const mutate of [b => { b.environmentId += "/foreign"; }, b => { b.redis.databaseId += "2"; },
    b => { b.postgres.resourceId = b.postgres.resourceId.replace("fixture/providers", "foreign/providers"); },
    b => { b.apps.web = undefined; }, b => { b.redis.host = undefined; }]) {
    const b = binding(); mutate(b); assert.throws(() => opsCoreAzureTargetBindingSha256(b), error => opsCoreAzureTargetDiagnostic(error) !== null);
  }
});

test("real transport is authenticated GET only with fixed az argv, abort and redacted failures", async () => {
  const controller = new AbortController(), calls = [];
  const transport = createAzureTargetArmTransport({ subscriptionId,
    execFileImpl(command, args, options, callback) {
      calls.push({ command, args, options }); callback(null, JSON.stringify({ accessToken: "fixture-token" }));
    }, async fetchImpl(url, options) {
      calls.push({ url, options }); return new Response(JSON.stringify({ id: "safe" }), { status: 200 });
    } });
  const request = { resourceId: binding().environmentId, apiVersion: "2024-03-01", signal: controller.signal };
  assert.deepEqual(await transport(request), { status: 200, body: { id: "safe" } });
  assert.equal(calls[0].command, "az"); assert.equal(calls[0].options.shell, false);
  assert.deepEqual(calls[0].args.slice(0, 4), ["account", "get-access-token", "--subscription", subscriptionId]);
  assert.equal(calls[1].options.method, "GET"); assert.equal(calls[1].options.redirect, "error");
  assert.equal(calls[1].options.headers.Authorization, "Bearer fixture-token");
  const broken = createAzureTargetArmTransport({ subscriptionId,
    execFileImpl(_, __, ___, callback) { callback(new Error("credential detail must not escape")); } });
  await rejects(broken(request), "AZURE_TARGET_ARM_READ_FAILED");
  await rejects(transport({ ...request, nextLink: "https://example.com/" }), "AZURE_TARGET_NEXT_LINK_INVALID");
});


test("explicit PostgreSQL shared state preserves inactive/private proofs without Redis reads", async () => {
  const f = fixture({ postgresState: true });
  assert.equal((await f.adapter.assertInactive()).complete, true);
  assert.equal((await f.adapter.assertPostgresPrivate()).complete, true);
  assert.equal(f.calls.some(call => typeof call === "object" && /redis/i.test(call.resourceId)), false);
  assert.throws(() => opsCoreAzureTargetBindingSha256({ ...f.b, sharedStateBackend: "automatic" }), /SHARED_STATE_INVALID/);
  assert.throws(() => opsCoreAzureTargetBindingSha256({ ...f.b, redis: binding().redis }), /BINDING_INVALID/);
  const legacy = binding();
  assert.notEqual(opsCoreAzureTargetBindingSha256(legacy), opsCoreAzureTargetBindingSha256(f.b));
  assert.throws(() => opsCoreAzureTargetBindingSha256({ ...legacy, redis: null }), /BINDING_INVALID/);
});
