import assert from "node:assert/strict";
import { test } from "node:test";
import { createOpsCoreActivation, createOpsCoreActivationArmTransport, opsCoreActivationDiagnostic } from "./ops-core-activation.mjs";

const subscription = "00000000-0000-4000-8000-000000000001";
const prefix = `/subscriptions/${subscription}/resourceGroups/fixture/providers/`;
const id = (type, name) => `${prefix}${type}/${name}`;
const resource = (resourceId, properties) => ({ id: resourceId, name: resourceId.split("/").at(-1),
  type: resourceId.split("/providers/")[1].split("/").filter((_, i) => i === 0 || i % 2 === 1).join("/"), properties });
const missing = () => ({ status: 404, body: { error: { code: "ResourceNotFound" } } });
function fixture({ mutateRead, health, mutatePlan, source, put } = {}) {
  const target = { domain: "ops", subscriptionId: subscription, resourceGroupName: "fixture",
    environmentId: id("Microsoft.App/managedEnvironments", "fixture"),
    postgres: { resourceId: id("Microsoft.DBforPostgreSQL/flexibleServers", "fixture-pg"), host: "fixture-pg.postgres.database.azure.com",
      major: 18, privateEndpointId: id("Microsoft.Network/privateEndpoints", "pg") },
    redis: { resourceId: id("Microsoft.Cache/redisEnterprise", "fixture-redis"), databaseId: id("Microsoft.Cache/redisEnterprise", "fixture-redis/databases/default"),
      host: "fixture-redis.westus3.redis.azure.net", port: 10000, privateEndpointId: id("Microsoft.Network/privateEndpoints", "redis") },
    apps: { web: "fixture-web", worker: "fixture-worker" } };
  const identity = id("Microsoft.ManagedIdentity/userAssignedIdentities", "fixture");
  const release = { gitSha: "a".repeat(40), imageTag: `sha-${"a".repeat(40)}`, version: "1.2.3" };
  const plan = { schemaVersion: 1, target, location: "westus3", managedIdentityId: identity,
    managedIdentityClientId: "00000000-0000-4000-8000-000000000002", runtimeVaultUri: "https://fixture.vault.azure.net/",
    acrServer: "fixtureacr.azurecr.io", release, roles: Object.fromEntries(["web", "worker"].map(role => [role, {
      image: `fixtureacr.azurecr.io/corgtex/${role}@sha256:${"b".repeat(64)}`,
      env: [{ name: "DATABASE_URL", secretRef: "db" }, { name: "REDIS_URL", secretRef: "redis" }],
      secrets: ["db", "redis"].map(name => ({ name, keyVaultUrl: `https://fixture.vault.azure.net/secrets/${name}/${"c".repeat(32)}`, identity })),
    }])) };
  mutatePlan?.(plan);
  let clock = 0;
  const controller = new AbortController(), log = [], map = new Map(), records = new Map();
  const journal = { domain: "ops", intentSha256: "d".repeat(64), phase: "VERIFIED", pending: null, destinationMayHaveWritten: false, history: [] };
  const custody = { signal: controller.signal, snapshot: () => structuredClone(journal),
    async assertOwned() { controller.signal.throwIfAborted(); },
    async begin(phase, hash) { log.push(`begin:${phase}`); assert.equal(journal.pending, null);
      journal.pending = { to: phase, operationId: "00000000-0000-4000-8000-000000000003", intentSha256: hash };
      if (phase === "TARGET_ACTIVATING") journal.destinationMayHaveWritten = true;
      return structuredClone(journal.pending); },
    async complete(operationId, evidenceSha256) { assert.equal(operationId, journal.pending.operationId);
      journal.history.push({ phase: journal.pending.to, operationId, intentSha256: journal.pending.intentSha256, evidenceSha256 });
      journal.phase = journal.pending.to; journal.pending = null; log.push(`complete:${journal.phase}`); },
  };
  const set = (key, body) => map.set(key, { status: 200, body });
  set(target.environmentId, resource(target.environmentId, { provisioningState: "Succeeded", defaultDomain: "fixture.westus3.azurecontainerapps.io" }));
  set(target.postgres.resourceId, resource(target.postgres.resourceId, { state: "Ready", version: "18", fullyQualifiedDomainName: target.postgres.host,
    network: { publicNetworkAccess: "Disabled" } }));
  set(`${target.postgres.resourceId}/firewallRules`, { value: [] });
  set(target.redis.resourceId, resource(target.redis.resourceId, { provisioningState: "Succeeded", hostName: target.redis.host,
    highAvailability: "Enabled", minimumTlsVersion: "1.2", publicNetworkAccess: "Disabled" }));
  const database = resource(target.redis.databaseId, { provisioningState: "Succeeded", port: 10000, clientProtocol: "Encrypted",
    clusteringPolicy: "EnterpriseCluster", evictionPolicy: "NoEviction" }); database.name = "fixture-redis/default";
  set(target.redis.databaseId, database);
  for (const [service, group] of [[target.postgres, "postgresqlServer"], [target.redis, "redisEnterprise"]]) set(service.privateEndpointId,
    resource(service.privateEndpointId, { provisioningState: "Succeeded", privateLinkServiceConnections: [{ properties: {
      privateLinkServiceId: service.resourceId, groupIds: [group], privateLinkServiceConnectionState: { status: "Approved" } } }] }));
  const appId = role => id("Microsoft.App/containerApps", target.apps[role]);
  for (const role of ["web", "worker"]) map.set(appId(role), missing());
  const transport = async request => {
    const role = ["web", "worker"].find(r => appId(r) === request.resourceId);
    if (request.method === "PUT") {
      log.push(`put:${role}`); assert.equal(journal.destinationMayHaveWritten, true); assert.equal(journal.pending.to, "TARGET_ACTIVATING");
      const body = structuredClone(request.body), name = target.apps[role], revisionName = `${name}--${body.properties.template.revisionSuffix}`;
      Object.assign(body, { id: request.resourceId, name, type: "Microsoft.App/containerApps" });
      body.identity.userAssignedIdentities[identity].clientId = plan.managedIdentityClientId;
      Object.assign(body.properties, { provisioningState: "Succeeded", latestRevisionName: revisionName, latestReadyRevisionName: revisionName });
      body.properties.configuration.ingress.fqdn = `${name}.${role === "worker" ? "internal." : ""}fixture.westus3.azurecontainerapps.io`;
      set(request.resourceId, body);
      const revId = `${request.resourceId}/revisions/${revisionName}`;
      set(`${request.resourceId}/revisions`, { value: [resource(revId, { active: true, provisioningState: "Provisioned",
        runningState: "Running", healthState: "Healthy", template: structuredClone(body.properties.template) })] });
      set(`${revId}/replicas`, { value: [resource(`${revId}/replicas/fixture`, { runningState: "Running", containers: [{ name: role, ready: true }] })] });
      if (put) return put({ role, request, body, journal, log, map });
      return { status: 202, body: {} };
    }
    const r = structuredClone(map.get(request.nextLink ?? request.resourceId));
    assert.ok(r, `missing fixture ${request.resourceId}`);
    mutateRead?.(request, r, { journal, map, log, controller }); return r;
  };
  const options = { plan, custody, armTransport: transport, timeoutMs: 20000, now: () => clock,
    wait: async ms => { clock += ms; }, operationStore: { async assertPrivate() {}, async readOptional(key) { return records.get(key) ?? null; },
      async createOnly(key, text) { assert.equal(records.has(key), false); records.set(key, text); } },
    async assertSourceFenced(input) { log.push(`source:${journal.destinationMayHaveWritten}`);
      if (source) return source(input, { journal, log });
      return { complete: true, domain: "ops", intentSha256: journal.intentSha256 }; },
    async healthProbe(input) {
      log.push(`health:${input.role}`);
      const result = { health: { status: 200, body: input.role === "web"
        ? { status: "ok", service: "web", database: "up", schema: "ready", app: "corgtex", release }
        : { status: "ok", phase: "running", release } }, evidence: { receiptSha256: "e".repeat(64) } };
      health?.(input, result, { journal, log, map }); return result;
    } };
  return { plan, custody, journal, log, map, records, options, appId, controller, set };
}
const rejects = (promise, code) => assert.rejects(promise, error => opsCoreActivationDiagnostic(error) === code);

for (const [label, change] of [
  ["public restore window", f => { f.map.get(f.plan.target.postgres.resourceId).body.properties.network.publicNetworkAccess = "Enabled"; }],
  ["missing network proof", f => { delete f.map.get(f.plan.target.postgres.resourceId).body.properties.network; }],
  ["retained restore firewall", f => { f.set(`${f.plan.target.postgres.resourceId}/firewallRules`, { value: [{ name: "restore-window" }] }); }],
]) test(`activation rejects ${label} before phase boundary or app writes`, async () => {
  const f = fixture(); change(f);
  await rejects(createOpsCoreActivation(f.options).activate(), "ACTIVATION_RECONCILIATION_REQUIRED");
  assert.equal(f.journal.destinationMayHaveWritten, false);
  assert.equal(f.journal.phase, "VERIFIED"); assert.equal(f.journal.pending, null);
  assert.equal(f.log.some(x => x.startsWith("put:") || x.startsWith("begin:")), false);
  assert.equal(f.records.size, 0);
});

test("PostgreSQL reopening after the durable boundary blocks the first app PUT", async () => {
  const f = fixture({ source(input, { journal }) {
    if (journal.destinationMayHaveWritten) f.map.get(f.plan.target.postgres.resourceId).body.properties.network.publicNetworkAccess = "Enabled";
    return { complete: true, domain: "ops", intentSha256: journal.intentSha256 };
  } });
  await rejects(createOpsCoreActivation(f.options).activate(), "ACTIVATION_RECONCILIATION_REQUIRED");
  assert.equal(f.journal.pending.to, "TARGET_ACTIVATING");
  assert.equal(f.log.some(x => x.startsWith("put:")), false);
});

for (const [context, expectedWrites] of [["web-before-worker", ["put:web"]],
  ["worker-final", ["put:web", "put:worker"]]]) test(`PostgreSQL reopening during ${context} prevents further activation`, async () => {
  let reopened = false;
  const f = fixture({ health(input, result, { map }) {
    if (input.invocationContext === context) {
      map.get(f.plan.target.postgres.resourceId).body.properties.network.publicNetworkAccess = "Enabled";
      reopened = true;
    }
  } });
  await rejects(createOpsCoreActivation(f.options).activate(), "ACTIVATION_RECONCILIATION_REQUIRED");
  assert.equal(reopened, true);
  assert.deepEqual(f.log.filter(x => x.startsWith("put:")), expectedWrites);
  assert.equal(f.journal.phase, "VERIFIED"); assert.equal(f.journal.pending.to, "TARGET_ACTIVATING");
  assert.equal(f.log.includes("complete:TARGET_ACTIVATING"), false);
  assert.equal(f.log.includes("begin:TARGET_ACTIVE"), false);
});

test("bootstrap records write boundary then verifies web before worker, fresh final pair, and TARGET_ACTIVE", async () => {
  const f = fixture(), activation = createOpsCoreActivation(f.options);
  const result = await activation.activate();
  assert.equal(result.phase, "TARGET_ACTIVE"); assert.equal(f.journal.pending, null);
  assert.ok(f.log.indexOf("begin:TARGET_ACTIVATING") < f.log.indexOf("put:web"));
  assert.ok(f.log.indexOf("health:web") < f.log.indexOf("put:worker"));
  assert.equal(f.log.filter(x => x === "health:web").length, 3);
  assert.equal(f.log.filter(x => x === "health:worker").length, 2);
  assert.ok(f.log.includes("source:true"));
  const web = f.map.get(f.appId("web")).body, worker = f.map.get(f.appId("worker")).body;
  assert.deepEqual(web.properties.template.containers[0].env.find(e => e.name === "CORGTEX_STARTUP_MODE"), { name: "CORGTEX_STARTUP_MODE", value: "migrate-and-web" });
  assert.equal(worker.properties.configuration.ingress.external, false);
  assert.equal([...f.records.keys()].filter(k => k.endsWith("receipt.json")).length, 2);
  assert.equal(JSON.stringify(result).includes("fixture"), false);
  await rejects(activation.activate(), "ACTIVATION_ALREADY_ATTEMPTED");
});

for (const [name, mutatePlan] of [
  ["unversioned secret", p => { p.roles.web.secrets[0].keyVaultUrl = "https://fixture.vault.azure.net/secrets/db"; }],
  ["foreign vault", p => { p.roles.web.secrets[0].keyVaultUrl = p.roles.web.secrets[0].keyVaultUrl.replace("fixture.vault", "foreign.vault"); }],
  ["foreign secret identity", p => { p.roles.web.secrets[0].identity += "-foreign"; }],
  ["mutable image", p => { p.roles.web.image = "fixtureacr.azurecr.io/corgtex/web:latest"; }],
  ["seed startup", p => { p.roles.web.env.push({ name: "CORGTEX_STARTUP_MODE", value: "combined" }); }],
  ["plaintext database", p => { p.roles.web.env[0] = { name: "DATABASE_URL", value: "private" }; }],
]) test(`plan rejects ${name} before effects`, () => {
  const f = fixture({ mutatePlan }); assert.throws(() => createOpsCoreActivation(f.options)); assert.deepEqual(f.log, []);
});

test("runtime projection may include exact generated values without duplicate env entries", async () => {
  const f = fixture({ mutatePlan(p) { p.roles.web.env.push({ name: "CORGTEX_STARTUP_MODE", value: "migrate-and-web" }); } });
  await createOpsCoreActivation(f.options).activate();
  assert.equal(f.map.get(f.appId("web")).body.properties.template.containers[0].env.filter(e => e.name === "CORGTEX_STARTUP_MODE").length, 1);
});

test("waits for incomplete ARM provisioning projections before exact ready validation", async () => {
  let incomplete = true;
  const f = fixture({ mutateRead(q, r, f) {
    if (incomplete && q.resourceId.endsWith("/fixture-web") && f.log.includes("put:web")) {
      incomplete = false; r.body.properties = { provisioningState: "InProgress" };
    }
  } });
  assert.equal((await createOpsCoreActivation(f.options).activate()).phase, "TARGET_ACTIVE");
  assert.equal(incomplete, false);
});

test("ARM identity casing and secret order do not invalidate exact resource binding", async () => {
  const f = fixture({ mutateRead(q, r) {
    if (r.body?.identity?.userAssignedIdentities) {
      r.body.id = r.body.id.toUpperCase();
      r.body.location = r.body.location.toUpperCase();
      const entries = Object.entries(r.body.identity.userAssignedIdentities);
      r.body.identity.userAssignedIdentities = Object.fromEntries(entries.map(([k, v]) => [k.toUpperCase(), v]));
      r.body.properties.configuration.registries[0].identity = r.body.properties.configuration.registries[0].identity.toUpperCase();
      r.body.properties.configuration.registries[0].username = null;
      r.body.properties.configuration.registries[0].passwordSecretRef = null;
      for (const s of r.body.properties.configuration.secrets) { s.value = null; s.identity = s.identity.toUpperCase(); }
      r.body.properties.configuration.secrets.reverse();
    }
  } });
  assert.equal((await createOpsCoreActivation(f.options).activate()).phase, "TARGET_ACTIVE");
});

test("ARM location display names and materialized probe default preserve bootstrap identity", async () => {
  const f = fixture({ mutateRead(q, r) {
    if (r.body?.identity?.userAssignedIdentities) {
      r.body.location = "West US 3";
      for (const probe of r.body.properties.template.containers[0].probes) probe.successThreshold = 1;
    }
  } });
  assert.equal((await createOpsCoreActivation(f.options).activate()).phase, "TARGET_ACTIVE");
});

test("immutable revision may omit only the documented successThreshold default", async () => {
  const f = fixture({ mutateRead(q, r) {
    if (q.resourceId.endsWith("/revisions")) for (const revision of r.body?.value ?? []) {
      for (const probe of revision.properties.template.containers[0].probes) delete probe.successThreshold;
    }
  } });
  assert.equal((await createOpsCoreActivation(f.options).activate()).phase, "TARGET_ACTIVE");
});

test("health callbacks distinguish every activation invocation context", async () => {
  const contexts = [];
  const f = fixture({ health(i) { contexts.push(i.invocationContext); } });
  await createOpsCoreActivation(f.options).activate();
  assert.deepEqual(contexts, ["web-after-create", "web-before-worker", "worker-after-create", "web-final", "worker-final"]);
});

test("a stopped existing app is not overwritten by bootstrap", async () => {
  const f = fixture();
  f.set(f.appId("web"), resource(f.appId("web"), { environmentId: f.plan.target.environmentId, provisioningState: "Succeeded" }));
  f.set(`${f.appId("web")}/revisions`, { value: [] });
  await rejects(createOpsCoreActivation(f.options).activate(), "ACTIVATION_APP_NOT_ABSENT");
  assert.equal(f.journal.destinationMayHaveWritten, false);
});

for (const [name, change] of [
  ["not verified", f => { f.journal.phase = "RESTORED"; }],
  ["inherited pending", f => { f.journal.pending = { to: "TARGET_ACTIVATING" }; }],
  ["destination already wrote", f => { f.journal.destinationMayHaveWritten = true; }],
]) test(`refuses ${name} without writes`, async () => {
  const f = fixture(); change(f);
  await rejects(createOpsCoreActivation(f.options).activate(), "ACTIVATION_PHASE_INVALID");
  assert.equal(f.log.some(x => x.startsWith("put:")), false);
});

test("source fence must be freshly proven before target write boundary", async () => {
  const f = fixture({ source: () => ({ complete: false }) });
  await rejects(createOpsCoreActivation(f.options).activate(), "ACTIVATION_SOURCE_UNPROVEN");
  assert.equal(f.journal.destinationMayHaveWritten, false);
});

test("lost PUT acknowledgement leaves durable pending state and cannot replay", async () => {
  const f = fixture({ put() { throw Error("sensitive provider response"); } });
  await rejects(createOpsCoreActivation(f.options).activate(), "ACTIVATION_RECONCILIATION_REQUIRED");
  assert.equal(f.journal.pending.to, "TARGET_ACTIVATING");
  assert.equal([...f.records.keys()].filter(k => k.endsWith("intent.json")).length, 1);
  await rejects(createOpsCoreActivation(f.options).activate(), "ACTIVATION_PHASE_INVALID");
  assert.deepEqual(f.log.filter(x => x.startsWith("put:")), ["put:web"]);
});

for (const [name, health] of [
  ["web schema pending", (i, r) => { if (i.role === "web") r.health.body.schema = "pending"; }],
  ["web wrong SHA", (i, r) => { if (i.role === "web") r.health.body.release = { ...i.release, gitSha: "f".repeat(40) }; }],
  ["web becomes unhealthy before worker", (i, r, f) => { if (i.role === "web" && f.log.filter(x => x === "health:web").length > 1) r.health.status = 503; }],
]) test(`${name} prevents worker creation`, async () => {
  const f = fixture({ health }); await assert.rejects(createOpsCoreActivation(f.options).activate());
  assert.equal(f.log.includes("put:worker"), false); assert.equal(f.journal.pending.to, "TARGET_ACTIVATING");
});

test("worker starting is not accepted even when /health is ok", async () => {
  const f = fixture({ health(i, r) { if (i.role === "worker") r.health.body.phase = "starting"; } });
  await assert.rejects(createOpsCoreActivation(f.options).activate());
  assert.equal(f.log.includes("put:worker"), true); assert.equal(f.journal.phase, "VERIFIED");
});

test("source-only observer remains required after the target write boundary", async () => {
  const f = fixture({ source(input, f) { return { complete: !f.journal.destinationMayHaveWritten, ...input }; } });
  await rejects(createOpsCoreActivation(f.options).activate(), "ACTIVATION_SOURCE_UNPROVEN");
  assert.equal(f.log.some(x => x.startsWith("put:")), false);
  assert.equal(f.journal.destinationMayHaveWritten, true);
});

test("web revision drift during health check blocks worker and completion", async () => {
  const f = fixture({ health(i, r, f) {
    if (i.role === "web") f.map.get(i.appId).body.properties.latestRevisionName += "-foreign";
  } });
  await assert.rejects(createOpsCoreActivation(f.options).activate());
  assert.equal(f.log.includes("put:worker"), false);
});

for (const [name, mutateRead] of [
  ["foreign environment", (q, r) => { if (q.method !== "PUT" && r.body?.name === "fixture-web" && r.body?.properties?.template) r.body.properties.environmentId += "-foreign"; }],
  ["extra revision", (q, r) => { if (q.resourceId.endsWith("/revisions") && r.body?.value?.length) r.body.value.push(structuredClone(r.body.value[0])); }],
  ["extra replica", (q, r) => { if (q.resourceId.endsWith("/replicas") && r.body?.value?.length) r.body.value.push(structuredClone(r.body.value[0])); }],
  ["foreign pagination", (q, r) => { if (q.resourceId.endsWith("/revisions") && r.body?.value?.length) r.body.nextLink = "https://foreign.invalid/path"; }],
  ["lease lost", (q, r, f) => { if (f.log.includes("put:web")) f.controller.abort(); }],
  ["nondefault probe threshold", (q, r) => { if (r.body?.properties?.template) r.body.properties.template.containers[0].probes[0].successThreshold = 2; }],
  ["command drift", (q, r) => { if (r.body?.properties?.template) r.body.properties.template.containers[0].command = ["other"]; }],
  ["scale drift", (q, r) => { if (r.body?.properties?.template) r.body.properties.template.scale.maxReplicas = 2; }],
]) test(`${name} stops activation before worker`, async () => {
  const f = fixture({ mutateRead }); await assert.rejects(createOpsCoreActivation(f.options).activate());
  assert.equal(f.log.includes("put:worker"), false);
});

test("default transport uses explicit subscription, authenticated bounded GET/PUT, and redacts uncertain failures", async () => {
  const calls = [];
  const transport = createOpsCoreActivationArmTransport({ subscriptionId: subscription,
    async execFileImpl(command, args) { calls.push([command, args]); return { stdout: "fixture-auth" }; },
    async fetchImpl(url, options) { calls.push([url.toString(), options.method]); assert.equal(options.headers.Authorization, "Bearer fixture-auth");
      return new Response(JSON.stringify({ safe: true }), { status: 200 }); } });
  const q = { resourceId: id("Microsoft.App/containerApps", "fixture-web"), signal: new AbortController().signal };
  assert.deepEqual(await transport(q), { status: 200, body: { safe: true } });
  await transport({ ...q, method: "PUT", body: { location: "westus3" } });
  assert.ok(calls[0][1].includes(subscription));
  await rejects(transport({ ...q, nextLink: "https://foreign.invalid/x" }), "ACTIVATION_REQUEST_INVALID");
  const failTransport = createOpsCoreActivationArmTransport({ subscriptionId: subscription,
    async execFileImpl() { throw Error("sensitive-provider-output"); } });
  await rejects(failTransport(q), "ACTIVATION_ARM_UNCERTAIN");
});


test("lost web acknowledgement reconciles without PUT and exposes only unattempted worker continuation", async () => {
  let failed = false;
  const f = fixture({ put({ role }) { if (role === "web" && !failed) { failed = true; throw Error("lost acknowledgement"); }
    return { status: 202, body: {} }; } });
  await assert.rejects(createOpsCoreActivation(f.options).activate());
  const result = await createOpsCoreActivation(f.options).reconcile();
  assert.equal(result.status, "CONTINUATION_AVAILABLE"); assert.equal(result.role, "worker");
  assert.deepEqual(f.log.filter(x => x.startsWith("put:")), ["put:web"]);
  await createOpsCoreActivation(f.options).resume();
  assert.equal(f.journal.phase, "TARGET_ACTIVE");
  assert.deepEqual(f.log.filter(x => x.startsWith("put:")), ["put:web", "put:worker"]);
});
test("inherited app intent with absent target never replays its PUT", async () => {
  const f = fixture({ put() { throw Error("lost acknowledgement"); } });
  await assert.rejects(createOpsCoreActivation(f.options).activate());
  f.map.set(f.appId("web"), missing());
  await assert.rejects(createOpsCoreActivation(f.options).reconcile());
  await assert.rejects(createOpsCoreActivation(f.options).resume());
  assert.deepEqual(f.log.filter(x => x.startsWith("put:")), ["put:web"]);
});
test("lost worker acknowledgement seals both app receipts and activation without another PUT", async () => {
  const f = fixture({ put({ role }) { if (role === "worker") throw Error("lost acknowledgement"); return {status:202,body:{}}; } });
  await assert.rejects(createOpsCoreActivation(f.options).activate());
  await createOpsCoreActivation(f.options).reconcile();
  assert.equal(f.journal.phase, "TARGET_ACTIVE");
  assert.deepEqual(f.log.filter(x => x.startsWith("put:")), ["put:web", "put:worker"]);
});
for (const committed of [false,true]) test(`activation completion lost acknowledgement (${committed}) resumes journal only`, async () => {
  const f = fixture(), complete = f.custody.complete;
  let lost = false;
  f.custody.complete = async (...args) => {
    if (!lost && f.journal.pending.to === "TARGET_ACTIVATING") {
      lost = true; if (committed) await complete(...args); throw Error("lost acknowledgement");
    }
    return complete(...args);
  };
  await assert.rejects(createOpsCoreActivation(f.options).activate());
  await createOpsCoreActivation(f.options).reconcile();
  assert.equal(f.journal.phase, "TARGET_ACTIVE");
  assert.deepEqual(f.log.filter(x => x.startsWith("put:")), ["put:web", "put:worker"]);
});
test("phase-plan acknowledgement loss is read back without repeated app effects", async () => {
  const f = fixture(), create = f.options.operationStore.createOnly;
  let lost = false;
  f.options.operationStore.createOnly = async (key,text) => { await create(key,text);
    if (!lost && key.endsWith("/phase-plan.json")) { lost = true; throw Error("lost acknowledgement"); } };
  await assert.rejects(createOpsCoreActivation(f.options).activate());
  const reconciled = await createOpsCoreActivation(f.options).reconcile();
  assert.equal(reconciled.nextAction, "resume-activate");
  assert.equal(f.log.some(x => x.startsWith("put:")), false);
  await createOpsCoreActivation(f.options).resume(); assert.equal(f.journal.phase,"TARGET_ACTIVE");
});
test("post-activation observer checks exact pair and only explicitly bound custom domains", async () => {
  const f = fixture(); await createOpsCoreActivation(f.options).activate();
  f.map.get(f.appId("web")).body.properties.configuration.ingress.customDomains = [
    {name:"ops.corgtex.com",bindingType:"SniEnabled",certificateId:"/fixture/certificate"}];
  const result = await createOpsCoreActivation(f.options).observe({customDomains:["ops.corgtex.com"]});
  assert.equal(result.complete,true); assert.equal(result.intentSha256,f.journal.intentSha256);
  assert.deepEqual(f.log.filter(x => x.startsWith("put:")), ["put:web", "put:worker"]);
  await assert.rejects(createOpsCoreActivation(f.options).observe({customDomains:["app.corgtex.com"]}));
});
