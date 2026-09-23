import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { mkdtemp, rm, writeFile, readFile, stat, chmod, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { archiveEvidenceHash as hash } from "./ops-core-archive.mjs";
import { CUTOVER_PHASES } from "./ops-core-custody.mjs";
import { opsCoreAzureTargetBindingSha256 } from "./ops-core-azure-target.mjs";
import { validateUpdateEnvelope, readPrivateUpdateEnvelope, assertUpdateAzureIdentity, assertRetainedUpdateAuthority,
  executeOpsCoreUpdate, downloadUpdateEnvelope } from "./run-ops-core-update.mjs";

const subscriptionId = "00000000-0000-4000-8000-000000000001", tenantId = "00000000-0000-4000-8000-000000000002";
const principalName = "00000000-0000-4000-8000-000000000003";
const stem = `/subscriptions/${subscriptionId}/resourceGroups/fixture/providers/`;
const custodyUrl = "https://fixturecustody.blob.core.windows.net/release-custody";
function fixture() {
  const target = { domain: "ops", subscriptionId, resourceGroupName: "fixture", environmentId: `${stem}Microsoft.App/managedEnvironments/fixture`,
    apps: { web: "fixture-web", worker: "fixture-worker" },
    postgres: { resourceId: `${stem}Microsoft.DBforPostgreSQL/flexibleServers/fixture-pg`, host: "fixture-pg.postgres.database.azure.com", major: 18,
      privateEndpointId: `${stem}Microsoft.Network/privateEndpoints/pg` },
    redis: { resourceId: `${stem}Microsoft.Cache/redisEnterprise/fixture-redis`, databaseId: `${stem}Microsoft.Cache/redisEnterprise/fixture-redis/databases/default`,
      host: "fixture-redis.westus3.redis.azure.net", port: 10000, privateEndpointId: `${stem}Microsoft.Network/privateEndpoints/redis` } };
  const triple = c => ({ release: { gitSha: c.repeat(40), imageTag: `sha-${c.repeat(40)}`, version: `1.0.${c.charCodeAt(0)}` },
    images: Object.fromEntries(["web", "worker"].map(role => [role, `fixtureacr.azurecr.io/corgtex/${role}@sha256:${c.repeat(64)}`])) });
  const plan = { schemaVersion: 1, domain: "ops", releaseId: randomUUID(), target, acrName: "fixtureacr", authority: {},
    baseline: triple("a"), incoming: triple("b"), recovery: triple("c"), origins: {
      web: "https://fixture-web.fixture.westus3.azurecontainerapps.io", worker: "https://fixture-worker.internal.fixture.westus3.azurecontainerapps.io" } };
  const common = { environmentResourceId: target.environmentId, infrastructureSubnetId: `${stem}Microsoft.Network/virtualNetworks/fixture/subnets/apps`,
    workspaceId: "00000000-0000-4000-8000-000000000004", identityResourceId: `${stem}Microsoft.ManagedIdentity/userAssignedIdentities/probe`, location: "westus3" };
  const envelope = { schemaVersion: 1, plan, operator: { custodyContainerUrl: custodyUrl, azureIdentity: { subscriptionId, tenantId, principalName } },
    health: Object.fromEntries(["baseline", "incoming", "recovery"].map(phase => [phase, { ...common,
      jobResourceId: `${stem}Microsoft.App/jobs/probe-${phase}`, image: `fixtureacr.azurecr.io/corgtex/worker@sha256:${"d".repeat(64)}`, probeSha256: "e".repeat(64),
      worker: { appId: `${stem}Microsoft.App/containerApps/fixture-worker`, origin: plan.origins.worker,
        image: plan[phase].images.worker, release: structuredClone(plan[phase].release) } }])) };
  const migration = { domain: "ops", azure: structuredClone(target), activation: { acrServer: "fixtureacr.azurecr.io" }, health: common,
    operator: { custodyContainerUrl: custodyUrl, targetObjectContainerUrl: "https://fixtureobjects.blob.core.windows.net/runtime-objects" } };
  const journal = { schemaVersion: 1, domain: "ops", intentSha256: hash(migration), phase: "ACCEPTED", sequence: 2 * (CUTOVER_PHASES.length - 1),
    destinationMayHaveWritten: true, pending: null, history: CUTOVER_PHASES.map(phase => ({ phase, evidenceSha256: hash({ phase }) })) };
  const proof = { schemaVersion: 1, domain: "ops", targetBindingSha256: opsCoreAzureTargetBindingSha256(target),
    baseline: structuredClone(plan.baseline), incoming: structuredClone(plan.incoming), recovery: structuredClone(plan.recovery), compatibleRecovery: true };
  const blobs = new Map(), log = [], state = { public: false, loseEnvelopeUpload: false };
  const put = (key, value) => blobs.set(key, JSON.stringify(value));
  function refreshMigration() {
    journal.intentSha256 = hash(migration); plan.authority.migrationIntentSha256 = journal.intentSha256;
    plan.authority.acceptedMigrationSha256 = hash(journal);
    plan.authority.migrationSourceFenceSha256 = journal.history.find(x => x.phase === "SOURCE_FENCED").evidenceSha256;
    put(`plans/ops/${hash(migration)}.json`, migration); put("cutovers/ops.json", journal);
  }
  function refreshProof() { plan.authority.compatibilitySha256 = hash(proof); put(`compatible-release-proofs/${hash(proof)}.json`, proof); }
  refreshMigration(); refreshProof();
  const container = { async getAccessPolicy() { log.push("private"); return { blobPublicAccess: state.public ? "blob" : undefined }; },
    getBlockBlobClient(key) { return {
      async download() {
        log.push(`read:${key}`); const text = blobs.get(key);
        if (text === undefined) throw Object.assign(Error("not found"), { statusCode: 404, code: "BlobNotFound" });
        return { contentLength: Buffer.byteLength(text), readableStreamBody: Readable.from([Buffer.from(text)]) };
      },
      async upload(text, bytes, options) {
        log.push(`upload:${key}`); assert.equal(options.conditions.ifNoneMatch, "*"); assert.equal(bytes, Buffer.byteLength(text));
        assert.equal(blobs.has(key), false); blobs.set(key, text);
        if (state.loseEnvelopeUpload && key.startsWith("update-envelopes/")) {
          state.loseEnvelopeUpload = false; throw Error("lost immutable envelope acknowledgement");
        }
      },
    }; },
  };
  let closed = 0, owned = 0;
  const controller = new AbortController();
  const custody = { signal: controller.signal, mode: "apply", result: null,
    async assertOwned() { owned++; controller.signal.throwIfAborted(); }, async close() { closed++; } };
  const f = { envelope, plan, migration, journal, proof, blobs, log, state, put, refreshMigration, refreshProof, container, custody, controller,
    get closed() { return closed; }, get owned() { return owned; },
    env: { OPS_CORE_CUSTODY_CONTAINER_URL: custodyUrl, AZURE_SUBSCRIPTION_ID: subscriptionId, AZURE_TENANT_ID: tenantId, AZURE_CLIENT_ID: principalName },
    binding: () => ({ domain: plan.domain, intentSha256: hash(plan), releaseId: plan.releaseId,
      targetBindingSha256: opsCoreAzureTargetBindingSha256(plan.target), ...plan.authority }),
    dependencies: { async identityCheck(expected) { assert.deepEqual(expected, envelope.operator.azureIdentity); log.push("identity"); },
      containerFactory(url) { assert.equal(url, custodyUrl); log.push("container"); return container; },
      async openCustody(input) { assert.deepEqual(input.plan, plan); assert.equal(input.container, container); log.push("custody"); return custody; },
      healthFactory() { return { async prepare() {}, async probeHealth() { return { health: "fixture" }; } }; },
      async runUpdate() { return { complete: true, outcome: "UPDATED" }; } },
  };
  return f;
}
const rejects = (promise, message) => assert.rejects(promise, error => error.message === message);
async function directory(t) { const path = await mkdtemp(join(tmpdir(), "ops-core-update-cli-")); t.after(() => rm(path, { recursive: true })); return path; }

test("envelope validation binds each health phase to exact release and three distinct probe jobs", () => {
  const f = fixture(); assert.deepEqual(validateUpdateEnvelope(f.envelope), f.envelope);
  for (const mutate of [e => { e.health.incoming.worker.release = e.plan.baseline.release; },
    e => { e.health.recovery.worker.image = e.plan.incoming.images.worker; },
    e => { e.health.incoming.jobResourceId = e.health.baseline.jobResourceId; },
    e => { e.operator.azureIdentity.subscriptionId = tenantId; },
    e => { e.operator.custodyContainerUrl += "?sig=forbidden"; }]) {
    const e = structuredClone(f.envelope); mutate(e); assert.throws(() => validateUpdateEnvelope(e));
  }
});

test("Azure identity mismatch is detected before constructing any Blob client", async () => {
  const f = fixture(); let clients = 0;
  await rejects(executeOpsCoreUpdate("apply", f.envelope, { identityCheck: expected => assertUpdateAzureIdentity(expected,
    async (command, args, options) => {
      assert.equal(command, "az"); assert.equal(options.shell, false);
      return { stdout: JSON.stringify({ id: subscriptionId, tenantId, state: "Enabled", user: { name: "wrong-principal" } }) };
    }), containerFactory() { clients++; throw Error("must not construct"); } }), "UPDATE_AZURE_IDENTITY_MISMATCH");
  assert.equal(clients, 0);
  for (const field of ["id", "tenantId", "state"]) await rejects(assertUpdateAzureIdentity(f.envelope.operator.azureIdentity,
    async () => ({ stdout: JSON.stringify({ id: subscriptionId, tenantId, state: "Enabled", user: { name: principalName }, [field]: "foreign" }) })), "UPDATE_AZURE_IDENTITY_MISMATCH");
});

test("retained authority requires actual ACCEPTED journal, historical source fence and private container", async () => {
  const f = fixture(); await assertRetainedUpdateAuthority(f.envelope, f.container);
  f.state.public = true; await rejects(assertRetainedUpdateAuthority(f.envelope, f.container), "UPDATE_CUSTODY_PUBLIC"); f.state.public = false;
  f.journal.phase = "ROUTED"; f.journal.history.pop(); f.journal.sequence -= 2; f.refreshMigration();
  await rejects(assertRetainedUpdateAuthority(f.envelope, f.container), "UPDATE_MIGRATION_NOT_ACCEPTED");
  const g = fixture(); g.plan.authority.migrationSourceFenceSha256 = "f".repeat(64);
  await rejects(assertRetainedUpdateAuthority(g.envelope, g.container), "UPDATE_MIGRATION_NOT_ACCEPTED");
});

test("retained global migration plan cannot change target, custody or probe infrastructure", async () => {
  for (const mutate of [f => { f.migration.azure.environmentId += "-foreign"; },
    f => { f.migration.operator.targetObjectContainerUrl = custodyUrl; },
    f => { f.migration.activation.acrServer = "foreign.azurecr.io"; },
    f => { f.migration.operator.custodyContainerUrl = "https://foreign.blob.core.windows.net/custody"; },
    f => { f.envelope.health.incoming.infrastructureSubnetId += "-foreign"; }]) {
    const f = fixture(); mutate(f); f.refreshMigration();
    await assert.rejects(assertRetainedUpdateAuthority(f.envelope, f.container));
  }
});

test("compatibility proof must bind complete baseline, incoming and recovery images and target", async () => {
  for (const mutate of [f => { f.proof.compatibleRecovery = false; }, f => { f.proof.targetBindingSha256 = "f".repeat(64); },
    f => { f.proof.recovery.images.web = f.plan.incoming.images.web; }, f => { f.proof.baseline.release.version = "foreign"; }]) {
    const f = fixture(); mutate(f); f.refreshProof();
    await rejects(assertRetainedUpdateAuthority(f.envelope, f.container), "UPDATE_COMPATIBILITY_UNPROVEN");
  }
});

test("execute cannot substitute a fake approved record for retained authority", async () => {
  const f = fixture(); f.blobs.delete("cutovers/ops.json");
  await rejects(executeOpsCoreUpdate("apply", f.envelope, { ...f.dependencies,
    assertRetainedUpdateAuthority: async () => ({ complete: true }) }), "UPDATE_AUTHORITY_READ_FAILED");
  assert.equal(f.log.includes("custody"), false);
});

test("lost immutable envelope acknowledgement never opens custody or retries the write implicitly", async () => {
  const f = fixture(); f.state.loseEnvelopeUpload = true;
  await assert.rejects(executeOpsCoreUpdate("apply", f.envelope, f.dependencies));
  assert.equal(f.log.includes("custody"), false);
  assert.equal(f.log.filter(x => x.startsWith("upload:")).length, 1);
  f.custody.mode = "finished"; f.custody.result = { complete: true, outcome: "UPDATED" };
  assert.equal((await executeOpsCoreUpdate("reconcile", f.envelope, f.dependencies)).status, "RETAINED_RESULT");
  assert.equal(f.log.filter(x => x.startsWith("upload:")).length, 1);
  const changed = structuredClone(f.envelope); changed.health.incoming.probeSha256 = "f".repeat(64);
  await rejects(executeOpsCoreUpdate("reconcile", changed, f.dependencies), "UPDATE_ENVELOPE_CHANGED");
});

test("finished owner returns historical result without claiming fresh acceptance or starting health", async () => {
  const f = fixture(); f.custody.mode = "finished"; f.custody.result = { complete: true, outcome: "RECOVERED" };
  const result = await executeOpsCoreUpdate("reconcile", f.envelope, { ...f.dependencies,
    healthFactory() { assert.fail("finished owner must not create health dispatcher"); }, runUpdate() { assert.fail("must not rerun controller"); } });
  assert.equal(result.status, "RETAINED_RESULT"); assert.equal(result.freshAcceptance, false);
  assert.equal(result.resultSha256, hash(f.custody.result)); assert.equal(f.closed, 1);
});

test("pending retained result still invokes controller with live ownership and exact health phase bridge", async () => {
  const f = fixture(), factories = new Map(), probes = [], prepared = [];
  f.custody.mode = "reconcile"; f.custody.result = { complete: true, outcome: "UPDATED" };
  const result = await executeOpsCoreUpdate("reconcile", f.envelope, { ...f.dependencies,
    healthFactory(options) {
      const phase = Object.keys(f.envelope.health).find(p => f.envelope.health[p].jobResourceId === options.plan.jobResourceId);
      factories.set(phase, options); assert.equal(options.mode, "release"); assert.equal(options.custody, f.custody);
      return { async prepare() { prepared.push(phase); }, async probeHealth(request) { probes.push({ phase, request }); return { actualReceipt: phase }; } };
    },
    async runUpdate(options) {
      assert.equal(options.action, "reconcile"); assert.equal(options.custody.result.outcome, "UPDATED");
      assert.deepEqual(await options.assertDeploymentAuthority(f.binding()), { complete: true, binding: f.binding() });
      await options.prepareHealth({ phase: "incoming" });
      assert.deepEqual(prepared, ["baseline", "incoming", "recovery"]);
      prepared.length = 0;
      await options.prepareHealth({ phase: "baseline" });
      assert.deepEqual(prepared, ["baseline"]);
      const h = f.envelope.health.recovery, authority = factories.get("recovery");
      const requested = { domain: "ops", intentSha256: hash(f.plan), releaseId: f.plan.releaseId, targetSha256: hash(h.worker),
        acceptedMigrationSha256: f.plan.authority.acceptedMigrationSha256, migrationSourceFenceSha256: f.plan.authority.migrationSourceFenceSha256 };
      assert.deepEqual(await authority.assertDeploymentAuthority(requested), { complete: true, ...requested });
      await rejects(authority.assertDeploymentAuthority({ ...requested, targetSha256: "f".repeat(64) }), "UPDATE_HEALTH_AUTHORITY_MISMATCH");
      assert.deepEqual(await options.workerHealth({ phase: "recovery", invocationContext: "recovery-final", revisionName: "fixture-worker--recovery", signal: f.custody.signal }), { actualReceipt: "recovery" });
      assert.deepEqual(probes[0].request, { role: "worker", ...h.worker, revisionName: "fixture-worker--recovery", invocationContext: "recovery-final", signal: f.custody.signal });
      await rejects(options.workerHealth({ phase: "foreign" }), "UPDATE_HEALTH_PHASE_INVALID");
      return { complete: true, outcome: "UPDATED" };
    } });
  assert.equal(result.freshAcceptance, true); assert.ok(f.owned > 0); assert.equal(f.closed, 1);
});

test("controller authority rechecks retained envelope and current custody instead of trusting initial preflight", async () => {
  for (const change of ["envelope", "journal", "lease"]) {
    const f = fixture();
    await assert.rejects(executeOpsCoreUpdate("apply", f.envelope, { ...f.dependencies, async runUpdate(options) {
      if (change === "lease") f.controller.abort();
      if (change === "journal") f.blobs.delete("cutovers/ops.json");
      if (change === "envelope") f.put(`update-envelopes/ops/${f.plan.releaseId}.json`, { changed: true });
      return options.assertDeploymentAuthority(f.binding());
    } }));
    assert.equal(f.closed, 1);
  }
});

test("download uses exact preset identity, private custody and content hash, producing exclusive 0600 file", async t => {
  const f = fixture(), dir = await directory(t), output = join(dir, "envelope.json"), sha256 = hash(f.envelope);
  f.put(`update-plans/ops/${sha256}.json`, f.envelope);
  const input = { domain: "ops", sha256, output, env: f.env, containerFactory: f.dependencies.containerFactory, identityCheck: f.dependencies.identityCheck };
  await downloadUpdateEnvelope(input);
  assert.equal((await stat(output)).mode & 0o777, 0o600);
  assert.deepEqual(await readPrivateUpdateEnvelope(output), f.envelope);
  const before = await readFile(output, "utf8"); await assert.rejects(downloadUpdateEnvelope(input), error => error.code === "EEXIST");
  assert.equal(await readFile(output, "utf8"), before);
});

test("download rejects mismatched domain, content hash, custody URL and principal without creating output", async t => {
  const dir = await directory(t);
  for (const kind of ["domain", "hash", "url", "principal", "public"]) {
    const f = fixture(), sha256 = hash(f.envelope), e = structuredClone(f.envelope);
    let domain = "ops", expectedHash = sha256;
    if (kind === "domain") domain = "core";
    if (kind === "hash") expectedHash = "f".repeat(64);
    if (kind === "url") e.operator.custodyContainerUrl = "https://foreign.blob.core.windows.net/custody";
    if (kind === "principal") e.operator.azureIdentity.principalName = tenantId;
    if (kind === "public") f.state.public = true;
    if (["url", "principal"].includes(kind)) expectedHash = hash(e);
    f.put(`update-plans/${domain}/${expectedHash}.json`, e);
    const output = join(dir, `${kind}.json`);
    await assert.rejects(downloadUpdateEnvelope({ domain, sha256: expectedHash, output, env: f.env,
      identityCheck: f.dependencies.identityCheck, containerFactory: f.dependencies.containerFactory }));
    await assert.rejects(stat(output), error => error.code === "ENOENT");
  }
});

test("private envelope input refuses group-readable files and symlinks", async t => {
  const f = fixture(), dir = await directory(t), path = join(dir, "envelope.json"), link = join(dir, "link.json");
  await writeFile(path, JSON.stringify(f.envelope), { mode: 0o600 });
  await chmod(path, 0o640); await rejects(readPrivateUpdateEnvelope(path), "UPDATE_INPUT_NOT_PRIVATE");
  await chmod(path, 0o600); await symlink(path, link); await rejects(readPrivateUpdateEnvelope(link), "UPDATE_INPUT_INVALID");
  assert.deepEqual(await readPrivateUpdateEnvelope(path), f.envelope);
});
