import assert from "node:assert/strict";
import test from "node:test";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { archiveEvidenceHash as hash } from "./ops-core-archive.mjs";
import { redisGateBindingSha256 } from "./ops-core-redis-gate.mjs";
import { verifyRuntimeRedisObservation, assertOpsCoreSourceRedisBound } from "./ops-core-source-redis.mjs";
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const source = () => ({ mode: "standalone", resourceId: null, server: { version: "7.0.0", runId: "a".repeat(40) },
  connection: { host: "public-proxy.example", port: 12345, database: 3, username: "runtime", tls: true } });
function runtimeFixture() {
  const binding = source(), credentials = { password: randomBytes(32).toString("base64"), tlsCa: null }, nonce = randomBytes(32).toString("hex");
  const context = { intentSha256: "b".repeat(64), role: "web", serviceId: id(1), deploymentId: id(2), instanceId: id(3) };
  const observed = { server: { version: binding.server.version, runIdSha256: createHash("sha256").update(binding.server.runId).digest("hex") },
    database: 3, username: "runtime", tls: false, endpointSha256: hash(["private.railway.internal", 6379]),
    credentialProof: createHmac("sha256", credentials.password).update(JSON.stringify([nonce, context.intentSha256,
      context.role, context.serviceId, context.deploymentId, context.instanceId])).digest("hex") };
  return { binding, credentials, nonce, context, observed };
}

test("actual server identity permits private/public endpoint aliases without persisting credentials or HMAC", () => {
  const f = runtimeFixture(), proof = verifyRuntimeRedisObservation(f);
  assert.equal(proof.bindingSha256, redisGateBindingSha256(f.binding));
  assert.equal(proof.database, 3); assert.equal(proof.credentialMatched, true);
  assert.equal(JSON.stringify(proof).includes(f.credentials.password), false);
  assert.equal(JSON.stringify(proof).includes(f.observed.credentialProof), false);
});
for (const [field, change] of [
  ["run ID/restarted server", f => { f.observed.server.runIdSha256 = "f".repeat(64); }],
  ["database", f => { f.observed.database = 0; }],
  ["ACL username", f => { f.observed.username = "default"; }],
  ["password", f => { f.credentials.password = "different-synthetic-value"; }],
  ["nonce", f => { f.nonce = "f".repeat(64); }],
  ["instance", f => { f.context.instanceId = id(99); }],
]) test(`rejects different runtime ${field}`, () => { const f = runtimeFixture(); change(f); assert.throws(() => verifyRuntimeRedisObservation(f), /SOURCE_REDIS_/); });

function fenceFixture(change = () => {}) {
  const runtime = runtimeFixture(), binding = runtime.binding;
  const healthPlan = { services: ["web", "worker"].map((role, index) => ({ role, serviceId: id(index + 10), deploymentId: id(index + 20) })) };
  const writerBinding = { projectId: id(1), environmentId: id(2), serviceIds: [id(10), id(11)] };
  const plan = { schemaVersion: 2, domain: "core", sharedState: { backend: "postgres", sourceRedis: binding },
    source: { health: healthPlan, writers: { binding: writerBinding } } };
  const intentSha256 = hash(plan);
  const writers = { binding: writerBinding, services: healthPlan.services.map(s => ({ serviceId: s.serviceId, activeDeploymentIds: [s.deploymentId] })) };
  const healthBody = { schemaVersion: 1, type: "OPS_CORE_SOURCE_HEALTH", complete: true, stage: "baseline", domain: "core", intentSha256,
    sourceHealthBindingSha256: hash(healthPlan), writerBaselineSha256: hash(writers),
    services: healthPlan.services.map(service => ({ ...service, projectId: id(1), environmentId: id(2), redis: verifyRuntimeRedisObservation(runtime) })) };
  change(healthBody);
  const health = { ...healthBody, evidenceSha256: hash(healthBody) };
  const phasePlan = { domain: "core", intentSha256, source: plan.source, recoveryBaseline: { health, writers } };
  const evidence = { domain: "core", intentSha256, sourceRuntimeRedisBaselineSha256: hash(health) }, evidenceSha256 = hash(evidence);
  const journal = { domain: "core", intentSha256, phase: "RESTORED", destinationMayHaveWritten: false,
    history: [{ phase: "SOURCE_FENCED", operationId: id(55), evidenceSha256 }] };
  const controller = new AbortController(), calls = [];
  const options = { plan, custody: { signal: controller.signal, snapshot: () => structuredClone(journal), async assertOwned() {} },
    operationStore: { async assertPrivate() {}, async readOptional(key) { return JSON.stringify(key.endsWith("/phase-plan.json") ? phasePlan : evidence); } },
    async assertSourceFenced() { return { complete: true, domain: "core", intentSha256, sourceFenceSha256: evidenceSha256 }; },
    railway: { async transport(request) { calls.push(request); const pinned = healthPlan.services.find(s => s.deploymentId === request.variables.deploymentId);
      return { environment: { id: id(2), projectId: id(1) }, deployment: { id: pinned.deploymentId, serviceId: pinned.serviceId,
        projectId: id(1), environmentId: id(2), deploymentStopped: true, status: "SUCCESS", instances: [{ id: id(33), status: "STOPPED" }] } }; } },
  };
  return { options, calls, journal, controller, phasePlan, evidence };
}

test("fresh stopped deployment readbacks bind both runtime observations to immutable fence evidence", async () => {
  const f = fenceFixture(), proof = await assertOpsCoreSourceRedisBound(f.options);
  assert.equal(proof.complete, true); assert.equal(proof.services.length, 2); assert.equal(f.calls.length, 2);
  assert.equal(f.calls.every(c => c.query.startsWith("query SourceRedisDeployment")), true);
  assert.equal(proof.sourceFenceSha256, hash(f.evidence));
});
test("a different empty Redis run ID or database cannot replace the actual runtime baseline", async () => {
  for (const change of [body => { body.services[0].redis.server.runIdSha256 = "f".repeat(64); },
    body => { body.services[1].redis.database = 0; }, body => { body.services[0].redis.bindingSha256 = "f".repeat(64); }]) {
    const f = fenceFixture(change);
    await assert.rejects(assertOpsCoreSourceRedisBound(f.options), /SOURCE_REDIS_RUNTIME_BINDING_MISMATCH/);
  }
});
test("missing baseline, runtime replacement, fence loss and abort fail closed", async () => {
  const missing = fenceFixture(); missing.options.operationStore.readOptional = async () => null;
  await assert.rejects(assertOpsCoreSourceRedisBound(missing.options), /BASELINE_MISSING/);
  const changed = fenceFixture(); const transport = changed.options.railway.transport;
  changed.options.railway.transport = async request => { const r = await transport(request); r.deployment.id = id(99); return r; };
  await assert.rejects(assertOpsCoreSourceRedisBound(changed.options), /DEPLOYMENT_NOT_FENCED/);
  const lost = fenceFixture(); lost.options.assertSourceFenced = async () => ({ complete: false });
  await assert.rejects(assertOpsCoreSourceRedisBound(lost.options), /FENCE_CHANGED/);
  const aborted = fenceFixture(); aborted.controller.abort();
  await assert.rejects(assertOpsCoreSourceRedisBound(aborted.options), /SOURCE_REDIS_/);
});
