import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { archiveEvidenceHash as hash } from "./ops-core-archive.mjs";
import { opsCoreAzureTargetBindingSha256 } from "./ops-core-azure-target.mjs";
import { runOpsCoreUpdate, opsCoreUpdateDiagnostic, opsCoreUpdateTransportTarget, assertOpsCoreUpdateImages,
  fetchOpsCoreUpdateWebHealth, validateOpsCoreUpdatePlan } from "./ops-core-update.mjs";
import { openOpsCoreReleaseCustody } from "./ops-core-release-custody.mjs";
import { openProviderOperationRecorder } from "./ops-core-provider-operations.mjs";
import { buildHealthProbeJobDefinition } from "./ops-core-health-job.mjs";
import { canonicalizeManagedAzureContainerAppState, managedAzureConfigurationDigest,
  assertManagedAzureRevisionProjection } from "../release/managed-azure-container-app-transport.mjs";

const subscriptionId = "00000000-0000-4000-8000-000000000001";
const prefix = `/subscriptions/${subscriptionId}/resourceGroups/fixture/providers/`;
const release = character => ({ gitSha: character.repeat(40), imageTag: `sha-${character.repeat(40)}`, version: `1.0.${character.charCodeAt(0)}` });
const images = character => Object.fromEntries(["web", "worker"].map(role => [role, `fixtureacr.azurecr.io/corgtex/${role}@sha256:${character.repeat(64)}`]));
const fixturePlan = () => ({ schemaVersion: 1, domain: "ops", releaseId: randomUUID(), acrName: "fixtureacr",
  target: { domain: "ops", subscriptionId, resourceGroupName: "fixture", environmentId: `${prefix}Microsoft.App/managedEnvironments/fixture`,
    apps: { web: "fixture-web", worker: "fixture-worker" },
    postgres: { resourceId: `${prefix}Microsoft.DBforPostgreSQL/flexibleServers/fixture-pg`, host: "fixture-pg.postgres.database.azure.com", major: 18,
      privateEndpointId: `${prefix}Microsoft.Network/privateEndpoints/pg` },
    redis: { resourceId: `${prefix}Microsoft.Cache/redisEnterprise/fixture-redis`, databaseId: `${prefix}Microsoft.Cache/redisEnterprise/fixture-redis/databases/default`,
      host: "fixture-redis.westus3.redis.azure.net", port: 10000, privateEndpointId: `${prefix}Microsoft.Network/privateEndpoints/redis` } },
  authority: { acceptedMigrationSha256: "a".repeat(64), migrationIntentSha256: "b".repeat(64),
    migrationSourceFenceSha256: "c".repeat(64), compatibilitySha256: "d".repeat(64) },
  baseline: { release: release("a"), images: images("a") }, incoming: { release: release("b"), images: images("b") },
  recovery: { release: release("c"), images: images("c") },
  origins: { web: "https://fixture-web.fixture.westus3.azurecontainerapps.io", worker: "https://fixture-worker.internal.fixture.westus3.azurecontainerapps.io" } });

function runtimeRelease(r, service) {
  return { ...r, service, runtime: { source: "baked", evidence: "baked", gitSha: r.gitSha },
    drift: { gitSha: false, imageTag: false, version: false, details: [] } };
}
function fixture(options = {}) {
  const plan = fixturePlan(), target = opsCoreUpdateTransportTarget(plan), records = new Map(), log = [], apps = {}, revisionState = {};
  const controller = new AbortController(); let finished = null, mode = "apply", probeNumber = 0;
  for (const role of ["web", "worker"]) {
    const name = plan.target.apps[role], suffix = `baseline-${role}`, revision = `${name}--${suffix}`;
    const configuration = { activeRevisionsMode: "Single", ingress: { external: role === "web", fqdn: new URL(plan.origins[role]).hostname, targetPort: role === "web" ? 3000 : 9090,
      traffic: [{ latestRevision: true, weight: 100 }] }, registries: [{ server: "fixtureacr.azurecr.io", identity: "fixture-uami" }], secrets: [{ name: "db", keyVaultUrl: "https://fixture.vault.azure.net/secrets/db/fixture-version", identity: "fixture-uami" }] };
    const template = { revisionSuffix: suffix, containers: [{ name: role, image: plan.baseline.images[role],
      env: [{ name: "CORGTEX_RELEASE_GIT_SHA", value: plan.baseline.release.gitSha }, { name: "CORGTEX_RELEASE_IMAGE_TAG", value: plan.baseline.release.imageTag },
        { name: "CORGTEX_RELEASE_VERSION", value: plan.baseline.release.version }, { name: "DATABASE_URL", secretRef: "db" },
        ...(role === "web" ? [{ name: "CORGTEX_STARTUP_MODE", value: "web" }] : [])], resources: options.resources?.[role] ?? { cpu: 0.5, memory: "1Gi" } }],
      scale: { minReplicas: 1, maxReplicas: 1 } };
    apps[role] = { id: `${prefix}Microsoft.App/containerApps/${name}`, name, type: "Microsoft.App/containerApps", location: "westus3",
      properties: { environmentId: plan.target.environmentId, configuration, template, provisioningState: "Succeeded", latestRevisionName: revision, latestReadyRevisionName: revision } };
    revisionState[role] = new Map([[revision, { revisionName: revision, active: true, replicaCount: 1, kind: "READY", template: structuredClone(template) }]]);
  }
  let custody = { signal: controller.signal, get mode() { return mode; },
    snapshot() { return { domain: plan.domain, intentSha256: hash(plan), phase: finished ? "RELEASE_FINISHED" : "RELEASE_PREPARED",
      pending: finished ? null : { to: "RELEASING", operationId: plan.releaseId } }; },
    async assertOwned() { controller.signal.throwIfAborted(); },
    async finish(result) {
      options.beforeFinish?.(result, f); finished = structuredClone(result); mode = "finished"; log.push("finish");
    },
  };
  const store = { async assertPrivate() {}, async readOptional(key) { return records.get(key) ?? null; },
    async listRecords(prefix) { return [...records.keys()].filter(key => key.startsWith(prefix)).sort(); },
    async createOnly(key, text) { assert.equal(records.has(key), false); records.set(key, text);
      log.push(key.endsWith("phase-plan.json") ? "snapshot" : "record"); options.afterCreate?.(key, JSON.parse(text), f); } };
  function configCheck(input) {
    if (input.exclusiveActivation) assert.equal(managedAzureConfigurationDigest(apps[input.role].properties.configuration),
      input.exclusiveActivation.configurationDigests[input.role], "fixture rejects unowned config drift");
  }
  const transport = {
    async readApp(input) {
      log.push(`readApp:${input.role}`); configCheck(input);
      options.beforeReadApp?.(input, f);
      return canonicalizeManagedAzureContainerAppState(structuredClone(apps[input.role]), input);
    },
    async readExclusiveState(input) {
      options.beforeExclusive?.(input, f);
      configCheck(input); const p = apps[input.role].properties;
      return { mode: p.configuration.activeRevisionsMode, configurationDigest: managedAzureConfigurationDigest(p.configuration),
        location: apps[input.role].location, provisioningState: p.provisioningState,
        latestRevisionName: p.latestRevisionName, latestReadyRevisionName: p.latestReadyRevisionName,
        revisions: [...revisionState[input.role].values()].map(({ revisionName, active, replicaCount }) => ({ revisionName, active, replicaCount })) };
    },
    async readRevisionState(input) {
      const r = revisionState[input.role].get(input.revisionName);
      if (!r) return { kind: "ABSENT" };
      const projection = structuredClone(r.template);
      if (options.omitEphemeralStorage) delete projection.containers[0].resources.ephemeralStorage;
      assertManagedAzureRevisionProjection(input.expectedTemplate, projection, plan.target.apps[input.role], input.revisionName);
      return { kind: r.kind };
    },
    async setRevisionMode(input) {
      configCheck(input); await input.onProgress?.();
      log.push(`mode:${input.role}:${input.mode}`); apps[input.role].properties.configuration.activeRevisionsMode = input.mode;
      options.afterMode?.(input, f);
      return transport.readExclusiveState(input);
    },
    async setRevisionActive(input) {
      assert.equal(input.active, false); await input.onProgress?.();
      log.push(`drain:${input.role}:${input.revisionName}`);
      const revision = revisionState[input.role].get(input.revisionName); assert.ok(revision);
      revision.active = false; revision.replicaCount = 0; options.afterDrain?.(input, f);
      return { terminal: true, succeeded: true, replicaCount: 0 };
    },
    async patchTemplate(input) {
      await input.onProgress?.(); configCheck(input);
      const phase = input.template.revisionSuffix.startsWith("rec-") ? "recovery" : "incoming";
      log.push(`patch:${phase}:${input.role}`);
      options.beforePatch?.(input, f);
      assert.ok([...revisionState[input.role].values()].every(r => !r.active && r.replicaCount === 0), "no live predecessor at patch");
      const p = apps[input.role].properties, revisionName = `${plan.target.apps[input.role]}--${input.template.revisionSuffix}`;
      p.template = structuredClone(input.template); p.latestRevisionName = revisionName; p.latestReadyRevisionName = revisionName;
      revisionState[input.role].set(revisionName, { revisionName, active: true, replicaCount: 1, kind: "READY", template: structuredClone(input.template) });
      options.afterPatch?.(input, f);
      return { terminal: true, succeeded: true };
    },
    async waitForState(input) { return transport.readApp(input); },
  };
  const f = { plan, target, records, log, apps, revisionState, custody, store, transport, controller,
    useCustody(owner) { custody = owner; f.custody = owner; },
    get finished() { return finished; }, reopen() { assert.equal(finished, null); mode = "reconcile"; },
    effects: () => log.filter(item => /^(?:mode:|drain:|patch:)/.test(item)),
    async run(action = "apply") { return runOpsCoreUpdate({ plan, custody, operationStore: store, action, transport,
      async armTransport(input) {
        assert.equal(input.resourceId, apps.web.id); assert.equal(input.apiVersion, "2024-03-01");
        assert.equal(input.signal, custody.signal); log.push("arm:web");
        const response = { status: 200, body: structuredClone(apps.web) };
        options.armRead?.(input, response, f); return response;
      },
      async assertDeploymentAuthority(binding) { options.authority?.(binding, f); return { complete: options.authorityComplete !== false, binding }; },
      async assertImages() { log.push("images"); await options.images?.(f); return { complete: true, imagesSha256: hash({ incoming: plan.incoming.images, recovery: plan.recovery.images }) }; },
      async prepareHealth(input) { log.push(`prepare:${input.phase}`); options.prepare?.(input, f); },
      async webHealth(input) {
        log.push(`health:web:${input.release.gitSha[0]}`);
        const result = { health: { status: 200, body: { status: "ok", app: "corgtex", service: "web", schema: "ready", database: "up",
          release: runtimeRelease(input.release, "web") } } };
        options.webHealth?.(input, result, f); return result;
      },
      async workerHealth(input) {
        log.push(`health:worker:${input.invocationContext}`);
        const r = revisionState.worker.get(input.revisionName); assert.ok(r?.active && r.replicaCount === 1);
        assert.equal(apps.worker.properties.configuration.activeRevisionsMode, "Single");
        const workerTarget = { appId: `${prefix}Microsoft.App/containerApps/${plan.target.apps.worker}`,
          origin: plan.origins.worker, image: plan[input.phase].images.worker, release: input.release };
        const result = { health: { status: 200, body: { status: "ok", phase: "running", lastError: null, tickCount: 1,
          lastSuccessfulTickAt: new Date().toISOString(), release: runtimeRelease(input.release, "worker") } },
          ready: { status: 200, body: { ready: true, phase: "running" } },
          evidence: { mode: "release", invocationContext: input.invocationContext, sourceFenceProvenance: "historical-migration", receiptSha256: hash({ release: input.release, probe: ++probeNumber }),
            requestSha256: hash({ role: "worker", origin: plan.origins.worker, release: input.release,
              appId: workerTarget.appId, revisionName: input.revisionName, invocationContext: input.invocationContext }),
            authoritySha256: hash({ mode: "release", acceptedMigrationSha256: plan.authority.acceptedMigrationSha256,
              releaseId: plan.releaseId, targetSha256: hash(workerTarget), sourceFenceProvenance: "historical-migration" }) } };
        await options.workerHealth?.(input, result, f); return result;
      },
    }); },
  };
  return f;
}
const rejected = (promise, code) => assert.rejects(promise, error => opsCoreUpdateDiagnostic(error) === code);

async function retainBaselineObserver(f, mutate = () => {}) {
  const p = f.plan, h = { worker: { appId: `${prefix}Microsoft.App/containerApps/${p.target.apps.worker}`,
    origin: p.origins.worker, image: p.baseline.images.worker, release: structuredClone(p.baseline.release) },
    jobResourceId: `${prefix}Microsoft.App/jobs/baseline-health`, environmentResourceId: p.target.environmentId,
    infrastructureSubnetId: `${prefix}Microsoft.Network/virtualNetworks/fixture/subnets/apps`,
    workspaceId: "00000000-0000-4000-8000-000000000002", identityResourceId: `${prefix}Microsoft.ManagedIdentity/userAssignedIdentities/probe`,
    image: p.baseline.images.worker, probeSha256: "e".repeat(64), location: "westus3" };
  const context = { domain: p.domain, intentSha256: hash(p), sourceFenceSha256: p.authority.migrationSourceFenceSha256,
    phaseOperationId: p.releaseId, mode: "release", acceptedMigrationSha256: p.authority.acceptedMigrationSha256 };
  const identity = { jobResourceId: h.jobResourceId, imageDigest: h.image.split("@")[1], probeSha256: h.probeSha256 };
  const challenge = { schemaVersion: 2, domain: p.domain, intentSha256: hash(p), sourceFenceSha256: context.sourceFenceSha256,
    targetSha256: hash(h.worker), identity, nonce: "f".repeat(64), issuedAt: Date.now() - 1000, expiresAt: Date.now() + 60000,
    authority: { mode: "release", acceptedMigrationSha256: p.authority.acceptedMigrationSha256, releaseId: p.releaseId,
      targetSha256: hash(h.worker), sourceFenceProvenance: "historical-migration" },
    request: { role: "worker", ...h.worker, revisionName: f.apps.worker.properties.latestRevisionName, invocationContext: "baseline-worker" } };
  delete challenge.request.image;
  const template = buildHealthProbeJobDefinition(h).properties.template;
  template.containers[0].env.push({ name: "CORGTEX_HEALTH_CHALLENGE", value: JSON.stringify(challenge) });
  const record = { kind: "AZURE_HEALTH_PROBE_START", input: { plan: h, context, index: 0, challenge, template } };
  mutate(record);
  const keyPrefix = `operations/${p.domain}/${hash(p)}/${p.releaseId}`;
  const operationKey = hash({ kind: record.kind, inputSha256: hash(record.input) });
  const slotKey = hash({ kind: "AZURE_HEALTH_PROBE_SLOT", inputSha256: hash({ plan: h, context, index: 0 }) });
  await f.store.createOnly(`${keyPrefix}/${slotKey}/descriptor.json`, JSON.stringify(record));
  await f.store.createOnly(`${keyPrefix}/${operationKey}/descriptor.json`, JSON.stringify(record));
  const recorder = await openProviderOperationRecorder({ custody: f.custody, store: f.store, phase: "RELEASING", signal: f.custody.signal });
  await recorder.runRecordedOperation({ ...record, async apply() {}, async verify() { return { complete: true,
    evidence: { executionResourceId: `${h.jobResourceId}/executions/fixture`, challengeSha256: hash(challenge) } }; } });
}

test("forward update drains worker then web, migrates web before worker, returns Single and proves private worker before finish", async () => {
  const f = fixture(); const result = await f.run();
  assert.equal(result.outcome, "UPDATED"); assert.equal(f.finished.outcome, "UPDATED");
  assert.deepEqual(f.effects().map(x => x.startsWith("drain:") ? x.split(":").slice(0, 2).join(":") : x), [
    "mode:web:Multiple", "mode:worker:Multiple", "drain:worker", "drain:web", "patch:incoming:web", "mode:web:Single", "patch:incoming:worker", "mode:worker:Single",
  ]);
  const patchWeb = f.log.indexOf("patch:incoming:web"), patchWorker = f.log.indexOf("patch:incoming:worker");
  assert.ok(f.log.indexOf("health:web:b", patchWeb) < patchWorker);
  assert.ok(f.log.indexOf("health:worker:release-final") < f.log.indexOf("finish"));
  assert.equal(f.apps.web.properties.template.containers[0].env.find(e => e.name === "CORGTEX_STARTUP_MODE").value, "migrate-and-web");
  for (const role of ["web", "worker"]) {
    assert.equal(f.apps[role].properties.template.containers[0].image, f.plan.incoming.images[role]);
    assert.equal([...f.revisionState[role].values()].filter(r => r.active).length, 1);
  }
  assert.ok([...f.records.keys()].some(k => k.endsWith("phase-plan.json")));
});

test("forward update preserves larger per-role allocations with omitted default storage", async () => {
  const resources = { web: { cpu: 1, memory: "2Gi", ephemeralStorage: "4Gi" },
    worker: { cpu: 2, memory: "4Gi", ephemeralStorage: "8Gi" } };
  const f = fixture({ resources, omitEphemeralStorage: true });
  assert.equal((await f.run()).outcome, "UPDATED");
  for (const role of ["web", "worker"]) assert.deepEqual(f.apps[role].properties.template.containers[0].resources, resources[role]);
});

test("authority failure rejects before provider effects", async () => {
  const f = fixture({ authorityComplete: false });
  await rejected(f.run(), "UPDATE_AUTHORITY_UNPROVEN"); assert.deepEqual(f.effects(), []);
});

test("same app name at a foreign ACA suffix cannot provide baseline health or authorize writes", async () => {
  const f = fixture();
  f.plan.origins.web = "https://fixture-web.foreign.westus3.azurecontainerapps.io";
  assert.doesNotThrow(() => validateOpsCoreUpdatePlan(f.plan));
  await rejected(f.run(), "UPDATE_WEB_ORIGIN_UNPROVEN");
  assert.deepEqual(f.effects(), []);
  assert.equal(f.log.some(x => x.startsWith("health:")), false);
  assert.equal(f.finished, null);
});

for (const [label, mutate] of [
  ["foreign app", r => { r.body.id += "-foreign"; }],
  ["foreign environment", r => { r.body.properties.environmentId += "-foreign"; }],
  ["missing hostname", r => { delete r.body.properties.configuration.ingress.fqdn; }],
  ["internal ingress", r => { r.body.properties.configuration.ingress.external = false; }],
  ["unsuccessful ARM read", r => { r.status = 404; }],
]) test(`fresh web routing proof rejects ${label} before health or runtime writes`, async () => {
  const f = fixture({ armRead(input, response) { mutate(response); } });
  await rejected(f.run(), "UPDATE_WEB_ORIGIN_UNPROVEN");
  assert.deepEqual(f.effects(), []);
  assert.equal(f.log.some(x => x.startsWith("health:")), false);
});

test("web routing ARM identity is case insensitive and accepts managedEnvironmentId", async () => {
  const f = fixture({ armRead(input, response) {
    const app = response.body;
    app.id = app.id.toUpperCase(); app.type = app.type.toUpperCase(); app.name = app.name.toUpperCase();
    app.properties.managedEnvironmentId = app.properties.environmentId.toUpperCase(); delete app.properties.environmentId;
  } });
  assert.equal((await f.run()).outcome, "UPDATED");
});

for (const phase of ["baseline", "incoming", "recovery"]) test(`${phase} health hostname drift is rejected by fresh post-probe ARM read`, async () => {
  let lose = phase === "recovery", drifted = false;
  const f = fixture({
    afterPatch() { if (lose) { lose = false; throw Error("lost incoming acknowledgement"); } },
    webHealth(input, response, state) {
      if (input.release.gitSha === state.plan[phase].release.gitSha) {
        state.apps.web.properties.configuration.ingress.fqdn = "fixture-web.foreign.westus3.azurecontainerapps.io";
        drifted = true;
      }
    },
  });
  if (phase === "recovery") { await assert.rejects(f.run()); f.reopen(); }
  await rejected(f.run(phase === "recovery" ? "recover" : "apply"), "UPDATE_WEB_ORIGIN_UNPROVEN");
  assert.equal(drifted, true); assert.equal(f.finished, null);
  if (phase === "baseline") assert.deepEqual(f.effects(), []);
  else assert.equal(f.log.includes(`patch:${phase}:worker`), false);
});

test("pre-worker and final incoming web probes each require fresh routing evidence", async () => {
  for (const probeNumber of [2, 3]) {
    let probes = 0;
    const f = fixture({ webHealth(input, response, state) {
      if (input.release.gitSha === state.plan.incoming.release.gitSha && ++probes === probeNumber) {
        state.apps.web.properties.configuration.ingress.fqdn = "fixture-web.foreign.westus3.azurecontainerapps.io";
      }
    } });
    if (probeNumber === 2) await assert.rejects(f.run(), /PROVIDER_OPERATION_RECONCILE_REQUIRED/);
    else await rejected(f.run(), "UPDATE_WEB_ORIGIN_UNPROVEN");
    assert.equal(probes, probeNumber); assert.equal(f.finished, null);
    assert.equal(f.log.includes("patch:incoming:worker"), probeNumber === 3);
  }
});

test("unchanged reconciliation cannot accept healthy responses at a foreign web origin", async () => {
  const f = fixture(); f.reopen();
  f.plan.origins.web = "https://fixture-web.foreign.westus3.azurecontainerapps.io";
  await rejected(f.run("reconcile"), "UPDATE_WEB_ORIGIN_UNPROVEN");
  assert.deepEqual(f.effects(), []); assert.equal(f.finished, null);
  assert.equal(f.log.some(x => x.startsWith("health:")), false);
});

test("pre-snapshot reconciliation proves unchanged baseline and finishes without runtime writes", async () => {
  const f = fixture(); f.reopen();
  const result = await f.run("reconcile");
  assert.equal(result.outcome, "UNCHANGED"); assert.deepEqual(result.release, f.plan.baseline.release);
  assert.deepEqual(f.effects(), []);
  assert.ok(f.log.includes("health:worker:baseline-worker"));
  assert.equal(f.log.includes("images"), false);
  assert.equal([...f.records.values()].map(JSON.parse).filter(r => r.type === "UPDATE_UNCHANGED_DECISION").length, 1);
});

test("pre-snapshot reconciliation rejects unexplained operation records before probing or writes", async () => {
  const f = fixture(); f.reopen();
  f.records.set(`operations/ops/${hash(f.plan)}/${f.plan.releaseId}/${"d".repeat(64)}/intent.json`, JSON.stringify({ type: "unexplained" }));
  await rejected(f.run("reconcile"), "UPDATE_UNRECORDED_BASELINE_EFFECTS");
  assert.deepEqual(f.effects(), []); assert.equal(f.log.some(x => x.startsWith("health:")), false);
  assert.equal(f.finished, null);
});

for (const stage of ["images", "prepare"]) test(`retained baseline after ${stage} preflight failure reconciles UNCHANGED without runtime writes`, async () => {
  let fail = true;
  const f = fixture({ [stage]() { if (fail) { fail = false; throw Error("preflight unavailable"); } } });
  await assert.rejects(f.run()); assert.ok([...f.records.keys()].some(k => k.endsWith("phase-plan.json")));
  assert.deepEqual(f.effects(), []); f.reopen();
  assert.equal((await f.run("reconcile")).outcome, "UNCHANGED"); assert.deepEqual(f.effects(), []);
  assert.equal(f.log.filter(x => x === "images").length, 1);
  assert.ok(f.log.includes("prepare:baseline"));
});

test("validated retained baseline health descriptors and bound intent/receipt permit unchanged unwind", async () => {
  let fail = true;
  const f = fixture({ async workerHealth(i, r, f) {
    if (fail) { fail = false; await retainBaselineObserver(f); throw Error("baseline observer interrupted after receipt"); }
  } });
  await assert.rejects(f.run()); f.reopen();
  assert.equal((await f.run("reconcile")).outcome, "UNCHANGED"); assert.deepEqual(f.effects(), []);
});

for (const corruption of ["malformed-challenge", "nonbaseline", "orphan-intent", "bound-intent", "descriptor-without-intent"]) test(`${corruption} baseline observer records block unchanged unwind`, async () => {
  let fail = true;
  const f = fixture({ async workerHealth(i, r, f) {
    if (!fail) return; fail = false;
    await retainBaselineObserver(f, record => {
      if (corruption === "malformed-challenge") record.input.challenge.nonce = "invalid";
      if (corruption === "nonbaseline") record.input.plan.worker.image = f.plan.incoming.images.worker;
    });
    if (corruption === "orphan-intent") f.records.set(`operations/ops/${hash(f.plan)}/${f.plan.releaseId}/${"0".repeat(64)}/intent.json`, "{}");
    if (corruption === "bound-intent") {
      const key = [...f.records.keys()].find(k => k.endsWith("/intent.json"));
      const intent = JSON.parse(f.records.get(key)); intent.inputSha256 = "0".repeat(64); f.records.set(key, JSON.stringify(intent));
    }
    if (corruption === "descriptor-without-intent") for (const key of f.records.keys()) {
      if (key.endsWith("/intent.json") || key.endsWith("/receipt.json")) f.records.delete(key);
    }
    throw Error("baseline observer interrupted");
  } });
  await assert.rejects(f.run()); f.reopen(); await assert.rejects(f.run("reconcile"));
  assert.deepEqual(f.effects(), []); assert.equal(f.finished, null);
  assert.equal([...f.records.values()].map(JSON.parse).some(r => r.type === "UPDATE_UNCHANGED_DECISION"), false);
});

test("retained runtime intent cannot be reclassified as unused preflight", async () => {
  let fail = true;
  const f = fixture({ async images(f) {
    if (!fail) return; fail = false;
    const recorder = await openProviderOperationRecorder({ custody: f.custody, store: f.store, phase: "RELEASING", signal: f.custody.signal });
    await recorder.runRecordedOperation({ kind: "UPDATE_MODE", input: { phase: "incoming", role: "web", mode: "Multiple" },
      async apply() { throw Error("unknown mode effect"); }, async verify() { return { complete: false }; } });
  } });
  await assert.rejects(f.run()); f.reopen(); await assert.rejects(f.run("reconcile"));
  assert.deepEqual(f.effects(), []); assert.equal(f.finished, null);
  assert.equal([...f.records.values()].map(JSON.parse).some(r => r.type === "UPDATE_UNCHANGED_DECISION"), false);
});

for (const interruption of ["decision", "baseline-read", "baseline-record", "health"]) test(`interrupted unchanged ${interruption} resumes the same read-only decision`, async () => {
  let interrupt = true;
  const f = fixture({
    afterCreate(key, record) {
      if (interrupt && (interruption === "decision" && record.type === "UPDATE_UNCHANGED_DECISION"
        || interruption === "baseline-record" && key.endsWith("phase-plan.json"))) { interrupt = false; throw Error("lost retained record acknowledgement"); }
    },
    beforeReadApp() { if (interrupt && interruption === "baseline-read") { interrupt = false; throw Error("interrupted baseline read"); } },
    workerHealth(i, r, f) {
      if (interrupt && interruption === "health") {
        interrupt = false;
        f.records.set(`operations/ops/${hash(f.plan)}/${f.plan.releaseId}/${"e".repeat(64)}/intent.json`, JSON.stringify({ type: "health-probe-intent" }));
        throw Error("health interrupted after retained decision");
      }
    },
  });
  f.reopen(); await assert.rejects(f.run("reconcile"));
  assert.equal(interrupt, false); assert.deepEqual(f.effects(), []); f.reopen();
  assert.equal((await f.run("reconcile")).outcome, "UNCHANGED"); assert.deepEqual(f.effects(), []);
  assert.equal([...f.records.values()].map(JSON.parse).filter(r => r.type === "UPDATE_UNCHANGED_DECISION").length, 1);
});

test("baseline drift after interrupted unchanged health cannot be accepted or converted into apply", async () => {
  let interrupt = true;
  const f = fixture({ workerHealth() { if (interrupt) { interrupt = false; throw Error("interrupted health"); } } });
  f.reopen(); await assert.rejects(f.run("reconcile")); f.reopen();
  f.apps.web.properties.template.scale.maxReplicas = 2;
  await rejected(f.run("reconcile"), "UPDATE_UNCHANGED_BASELINE_DRIFT");
  await rejected(f.run("apply"), "UPDATE_RECONCILE_REQUIRED");
  assert.deepEqual(f.effects(), []); assert.equal(f.finished, null);
});

test("configuration drift after retained baseline rejects before provider effects", async () => {
  const f = fixture({ prepare(i, f) { f.apps.worker.properties.configuration.registries[0].identity = "foreign"; } });
  await assert.rejects(f.run()); assert.deepEqual(f.effects(), []);
});

test("foreign active writer after retained baseline rejects before provider effects", async () => {
  const f = fixture({ prepare(i, f) { f.revisionState.worker.set("foreign--worker", { revisionName: "foreign--worker", active: true, replicaCount: 1 }); } });
  await rejected(f.run(), "UPDATE_FOREIGN_WRITER"); assert.deepEqual(f.effects(), []);
});

test("lost committed web PATCH acknowledgement allows read-only inspection but no replay or premature finish", async () => {
  let lose = true;
  const f = fixture({ afterPatch(i) { if (lose) { lose = false; throw Error("lost acknowledgement"); } } });
  await assert.rejects(f.run()); const effects = f.effects(); f.reopen();
  await rejected(f.run("apply"), "UPDATE_RECONCILE_REQUIRED");
  await assert.rejects(f.run("reconcile")); assert.deepEqual(f.effects(), effects); assert.equal(f.finished, null);
});

test("fully updated pair after lost final recording is finished by read-only reconciliation", async () => {
  let lose = true;
  const f = fixture({ beforeFinish() { if (lose) { lose = false; throw Error("lost final acknowledgement"); } } });
  await assert.rejects(f.run()); const effects = f.effects(); f.reopen();
  const result = await f.run("reconcile"); assert.equal(result.outcome, "UPDATED"); assert.deepEqual(f.effects(), effects);
});

test("explicit compatible recovery has separate durable decision and distinct template intents", async () => {
  let lose = true;
  const f = fixture({ afterPatch() { if (lose) { lose = false; throw Error("lost incoming acknowledgement"); } } });
  await assert.rejects(f.run()); f.reopen();
  const result = await f.run("recover"); assert.equal(result.outcome, "RECOVERED");
  assert.equal(f.log.filter(v => v === "patch:incoming:web").length, 1);
  assert.equal(f.log.filter(v => v === "patch:incoming:worker").length, 0);
  assert.equal(f.log.filter(v => v === "patch:recovery:web").length, 1);
  assert.equal(f.log.filter(v => v === "patch:recovery:worker").length, 1);
  const records = [...f.records.values()].map(JSON.parse);
  assert.ok(records.some(r => r.type === "UPDATE_RECOVERY_DECISION"));
  assert.equal(records.filter(r => r.kind === "UPDATE_TEMPLATE" && r.type === "intent").length, 3);
  assert.equal(f.apps.web.properties.template.containers[0].image, f.plan.recovery.images.web);
});

test("absent uncertain forward PATCH blocks recovery before recovery effects or decision", async () => {
  let lose = true;
  const f = fixture({ beforePatch() { if (lose) { lose = false; throw Error("write outcome absent and unknown"); } } });
  await assert.rejects(f.run()); f.reopen(); const effects = f.effects();
  await rejected(f.run("recover"), "UPDATE_FORWARD_EFFECT_UNSETTLED"); assert.deepEqual(f.effects(), effects);
  assert.equal([...f.records.values()].map(JSON.parse).some(r => r.type === "UPDATE_RECOVERY_DECISION"), false);
});

test("provisioning forward PATCH blocks recovery even when candidate identity is known", async () => {
  let lose = true;
  const f = fixture({ afterPatch(i, f) { if (lose) { lose = false;
    f.revisionState[i.role].get(f.apps[i.role].properties.latestRevisionName).kind = "PROVISIONING"; throw Error("still provisioning"); } } });
  await assert.rejects(f.run()); f.reopen(); const effects = f.effects();
  await rejected(f.run("recover"), "UPDATE_FORWARD_EFFECT_UNSETTLED"); assert.deepEqual(f.effects(), effects);
});

test("recovery interrupted after committed recovery web PATCH resumes without replaying either PATCH", async () => {
  let remaining = 2;
  const f = fixture({ afterPatch(i) { if (i.role === "web" && remaining-- > 0) throw Error("lost web acknowledgement"); } });
  await assert.rejects(f.run()); f.reopen();
  await assert.rejects(f.run("recover")); f.reopen();
  assert.equal((await f.run("recover")).outcome, "RECOVERED");
  assert.equal(f.log.filter(x => x === "patch:incoming:web").length, 1);
  assert.equal(f.log.filter(x => x === "patch:recovery:web").length, 1);
  assert.equal(f.log.filter(x => x === "patch:recovery:worker").length, 1);
});

test("recovery interrupted during revision-mode change reconciles that effect before continuing", async () => {
  let loseForward = true, loseRecoveryMode = true;
  const f = fixture({
    afterPatch() { if (loseForward) { loseForward = false; throw Error("lost forward acknowledgement"); } },
    afterMode(i, f) {
      const decision = [...f.records.values()].map(JSON.parse).some(r => r.type === "UPDATE_RECOVERY_DECISION");
      if (decision && loseRecoveryMode) { loseRecoveryMode = false; throw Error("lost recovery mode acknowledgement"); }
    },
  });
  await assert.rejects(f.run()); f.reopen();
  await assert.rejects(f.run("recover")); f.reopen();
  assert.equal((await f.run("recover")).outcome, "RECOVERED");
  // One forward and one recovery write; the uncertain recovery write is never replayed.
  assert.equal(f.log.filter(x => x === "mode:web:Multiple").length, 2);
  assert.equal(f.log.filter(x => x === "patch:recovery:web").length, 1);
});

for (const part of ["requestSha256", "authoritySha256"]) test(`worker health ${part} mismatch prevents completion`, async () => {
  const f = fixture({ workerHealth(i, r) { if (i.invocationContext === "release-final") r.evidence[part] = "f".repeat(64); } });
  await rejected(f.run(), "UPDATE_WORKER_HEALTH_UNPROVEN"); assert.equal(f.finished, null);
});

test("bad final worker evidence leaves release unfinished", async () => {
  const f = fixture({ workerHealth(i, r) { if (i.invocationContext === "release-final") r.evidence.sourceFenceProvenance = "unknown"; } });
  await rejected(f.run(), "UPDATE_WORKER_HEALTH_UNPROVEN"); assert.equal(f.finished, null);
});

test("incoming web schema failure never starts incoming worker", async () => {
  const f = fixture({ webHealth(i, r) { if (i.release.gitSha === f.plan.incoming.release.gitSha) r.health.body.schema = "pending"; } });
  await rejected(f.run(), "UPDATE_WEB_HEALTH_UNPROVEN"); assert.equal(f.log.includes("patch:incoming:worker"), false);
});

for (const field of ["template", "configuration"]) test(`web ${field} drift during fresh pre-worker health blocks worker PATCH`, async () => {
  let incomingChecks = 0;
  const f = fixture({ webHealth(i, response, f) {
    if (i.release.gitSha === f.plan.incoming.release.gitSha && ++incomingChecks === 2) {
      if (field === "template") f.apps.web.properties.template.containers[0].image = f.plan.recovery.images.web;
      else f.apps.web.properties.configuration.registries[0].identity = "foreign";
    }
  } });
  await assert.rejects(f.run());
  assert.equal(incomingChecks, 2);
  assert.equal(f.log.includes("patch:incoming:worker"), false);
  assert.equal(f.finished, null);
});

for (const outcome of ["UPDATED", "UNCHANGED"]) test(`actual custody reconciles retained ${outcome} result after lost result-upload acknowledgement despite fresh health receipts`, async () => {
  const blobs = new Map(); let lease = null, etag = 0, loseResult = true;
  const put = (key, text) => { const row = { text, etag: String(++etag) }; blobs.set(key, row); return row; };
  const store = {
    async assertPrivate() {},
    async ensureLock(key, text) { if (!blobs.has(key)) put(key, text); },
    async acquire() { assert.equal(lease, null); lease = randomUUID(); return lease; },
    async renew(id) { assert.equal(id, lease); },
    async release(id) { assert.equal(id, lease); lease = null; },
    async readOptional(key) { return structuredClone(blobs.get(key) ?? null); },
    async createOnly(key, text) {
      assert.equal(blobs.has(key), false); put(key, text);
      if (loseResult && key.endsWith("/result.json")) { loseResult = false; throw Error("result retained, acknowledgement lost"); }
    },
    async write(key, text, input) { assert.equal(input.leaseId, lease); assert.equal(input.etag, blobs.get(key).etag); return { etag: put(key, text).etag }; },
  };
  const f = fixture(), options = { store, domain: "ops", targetBindingSha256: opsCoreAzureTargetBindingSha256(f.plan.target), plan: f.plan };
  let owner = await openOpsCoreReleaseCustody(options); f.useCustody(owner);
  try {
    if (outcome === "UNCHANGED") { await owner.close(); owner = await openOpsCoreReleaseCustody(options); f.useCustody(owner); }
    await assert.rejects(f.run(outcome === "UNCHANGED" ? "reconcile" : "apply"));
    const effects = f.effects();
    assert.equal(loseResult, false);
    await owner.close(); owner = await openOpsCoreReleaseCustody(options); f.useCustody(owner);
    assert.equal(owner.mode, "reconcile"); const retained = owner.result;
    assert.equal(retained.outcome, outcome);
    const result = await f.run("reconcile");
    assert.equal(owner.mode, "finished"); assert.equal(result.outcome, outcome);
    assert.deepEqual(owner.result, retained);
    assert.deepEqual(f.effects(), effects);
  } finally { await owner.close(); }
});

test("ACR preflight checks immutable incoming and recovery digests with explicit subscription", async () => {
  const p = fixturePlan(), calls = [];
  const result = await assertOpsCoreUpdateImages(p, new AbortController().signal, async (command, args, options) => {
    calls.push(args); assert.equal(command, "az"); assert.equal(options.shell, false);
    assert.ok(args.includes(subscriptionId)); return { stdout: JSON.stringify({ digest: args[args.indexOf("--name") + 1].split("@")[1] }) };
  });
  assert.equal(calls.length, 4); assert.equal(result.imagesSha256, hash({ incoming: p.incoming.images, recovery: p.recovery.images }));
  await rejected(assertOpsCoreUpdateImages(p, new AbortController().signal, async () => ({ stdout: JSON.stringify({ digest: "sha256:" + "f".repeat(64) }) })), "UPDATE_IMAGE_UNPROVEN");
});

test("direct web health refuses redirected, foreign URL and oversized response", async () => {
  const origin = fixturePlan().origins.web, signal = new AbortController().signal;
  const response = (text, url = `${origin}/api/health`, redirected = false) => {
    const r = new Response(text, { status: 200, headers: { "content-type": "application/json" } });
    Object.defineProperties(r, { url: { value: url }, redirected: { value: redirected } }); return r;
  };
  assert.equal((await fetchOpsCoreUpdateWebHealth({ origin, signal }, async () => response('{"status":"ok"}'))).health.body.status, "ok");
  await rejected(fetchOpsCoreUpdateWebHealth({ origin, signal }, async () => response("{}", "https://foreign.invalid/api/health")), "UPDATE_WEB_HEALTH_UNPROVEN");
  await rejected(fetchOpsCoreUpdateWebHealth({ origin, signal }, async () => response("{}", `${origin}/api/health`, true)), "UPDATE_WEB_HEALTH_UNPROVEN");
  await rejected(fetchOpsCoreUpdateWebHealth({ origin, signal }, async () => response(" ".repeat(32769))), "UPDATE_WEB_HEALTH_TOO_LARGE");
});
