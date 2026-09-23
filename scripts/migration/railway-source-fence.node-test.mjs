import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { createRailwayFenceTransport, RailwaySourceFence } from "./railway-source-fence.mjs";
import { createCutoverJournal, openCutoverCustody } from "./ops-core-custody.mjs";
import { openProviderOperationRecorder } from "./ops-core-provider-operations.mjs";

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const binding = { projectId: id(1), environmentId: id(2), serviceIds: [id(3), id(4)] };
const canonical = (value) => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : value !== null && typeof value === "object" ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`
    : JSON.stringify(value);
const hash = (value) => createHash("sha256").update(canonical(value)).digest("hex");
const source = (image) => ({ image: image ? "example/app:retained" : null, repo: image ? null : "example/retained-repo" });
const deployment = (serviceId, n, status = "SUCCESS", stopped = false) => ({ id: id(n), serviceId,
  projectId: binding.projectId, environmentId: binding.environmentId, status,
  createdAt: "2026-09-22T12:00:00.000Z", updatedAt: "2026-09-22T12:00:00.000Z", deploymentStopped: stopped,
  instances: stopped ? [] : [{ id: id(n + 100), status: "RUNNING" }] });

async function fixture(options = {}) {
  const controller = new AbortController();
  const state = { calls: [], records: [], inRecordedApply: false, mutate: null, onRecord: null,
    staged: { id: id(10), environmentId: binding.environmentId, status: "STAGED", patch: {} },
    config: { services: {
      [id(3)]: { source: { ...source(true), autoUpdates: { type: "patch" } }, deploy: { cronSchedule: "*/5 * * * *" }, variables: { PRIVATE_VALUE: "excluded-config-canary" } },
      [id(4)]: { source: source(false), deploy: {} },
    }, variables: { PRIVATE_VALUE: "excluded-config-canary" } },
    auto: { [id(3)]: false, [id(4)]: true }, pending: [],
    deployments: { [id(3)]: [deployment(id(3), 20)], [id(4)]: [deployment(id(4), 21, "BUILDING")] },
    pages: null, foreignEnvironment: false, foreignService: false, unknownAck: false, mutateOnStop: null,
    extraActive: [], fileCron: null, ackLossOperation: null,
  };
  const envBinding = () => ({ id: state.foreignEnvironment ? id(999) : binding.environmentId, projectId: binding.projectId });
  const transport = async ({ query, variables }) => {
    const operation = /(?:query|mutation) (\w+)/.exec(query)?.[1];
    state.calls.push({ operation, variables: structuredClone(variables), query });
    if (query.startsWith("mutation")) assert.equal(state.inRecordedApply, true, "every mutation must be inside recorded apply");
    let data;
    if (operation === "FenceEnvironment") data = { environment: { ...envBinding(), config: structuredClone(state.config) },
      environmentStagedChanges: structuredClone(state.staged), environmentPendingWork: structuredClone(state.pending) };
    if (operation === "FenceService") {
      const serviceId = variables.serviceId;
      const config = state.config.services[serviceId];
      data = { environment: envBinding(), serviceInstance: { id: id(serviceId === id(3) ? 30 : 31),
        serviceId: state.foreignService ? id(999) : serviceId, environmentId: binding.environmentId,
        service: { id: serviceId, projectId: binding.projectId }, source: source(serviceId === id(3)),
        cronSchedule: config.deploy.cronSchedule ?? null, nextCronRunAt: config.deploy.cronSchedule ? "2026-09-22T12:05:00Z" : null,
        restartPolicyType: "ON_FAILURE", restartPolicyMaxRetries: 10, drainingSeconds: null, overlapSeconds: null,
        resolvedFileConfig: serviceId === id(3) ? null : { deploymentId: id(21), resolvedAt: "2026-09-22T12:00:00Z",
          fileManifest: { deploy: { cronSchedule: state.fileCron }, irrelevant: "excluded-manifest-canary" } },
        activeDeployments: [...state.deployments[serviceId].filter((item) => item.status === "SUCCESS" && !item.deploymentStopped), ...state.extraActive],
      }, serviceInstanceAutoDeployStatus: { enabled: state.auto[serviceId] } };
    }
    if (operation === "FenceDeployments") {
      if (state.pages) data = { environment: envBinding(), deployments: state.pages(variables) };
      else data = { environment: envBinding(), deployments: { edges: state.deployments[variables.serviceId].map((node) => ({ cursor: node.id, node: structuredClone(node) })),
        pageInfo: { hasNextPage: false, endCursor: null } } };
    }
    if (operation === "FenceDeployment") data = { environment: envBinding(),
      deployment: structuredClone(Object.values(state.deployments).flat().find((item) => item.id === variables.id)) };
    if (operation === "FenceAutoDeploy") { state.auto[variables.input.serviceId] = false; data = { serviceInstanceAutoDeployUpdate: { enabled: false } }; }
    if (operation === "FenceStage") { state.staged.patch = structuredClone(variables.input); data = { environmentStageChanges: { id: state.staged.id, environmentId: binding.environmentId } }; }
    if (operation === "FenceCommit") {
      for (const [serviceId, patch] of Object.entries(state.staged.patch.services)) {
        if (patch.source?.autoUpdates) state.config.services[serviceId].source.autoUpdates = patch.source.autoUpdates;
        state.config.services[serviceId].deploy.cronSchedule = null;
      }
      state.staged.patch = {};
      data = { environmentPatchCommitStaged: id(10) };
    }
    if (operation === "FenceCancel" || operation === "FenceStop") {
      const target = Object.values(state.deployments).flat().find((item) => item.id === variables.id);
      target.deploymentStopped = true;
      target.instances = [];
      if (operation === "FenceCancel") target.status = "REMOVED";
      if (state.mutateOnStop) state.mutateOnStop();
      data = { [operation === "FenceCancel" ? "deploymentCancel" : "deploymentStop"]: true };
    }
    if (state.unknownAck && operation === "FenceStop") throw new Error("private unknown acknowledgement");
    if (state.ackLossOperation === operation) throw new Error("private unknown acknowledgement");
    if (state.mutate) state.mutate(data, operation, variables);
    assert.ok(data, `unknown operation ${operation}`);
    return data;
  };
  const runRecordedOperation = async (record) => {
    state.records.push({ kind: record.kind, input: structuredClone(record.input) });
    if (state.onRecord) await state.onRecord(record);
    if ((await record.verify()).complete) return;
    state.inRecordedApply = true;
    try { await record.apply(); } finally { state.inRecordedApply = false; }
    assert.equal((await record.verify()).complete, true);
  };
  const inventory = await new RailwaySourceFence({ binding, transport, runRecordedOperation, signal: controller.signal }).read();
  const expectedSourceLinks = inventory.services.map(({ serviceId, sourceLinkSha256 }) => ({ serviceId, sourceLinkSha256 }));
  state.calls = [];
  const adapter = new RailwaySourceFence({ binding, expectedSourceLinks, transport, runRecordedOperation, signal: controller.signal, ...options });
  const readIntent = async (kind, input) => state.records.some((record) => record.kind === kind && hash(record.input) === hash(input))
    ? { schemaVersion: 1, type: "intent", kind, inputSha256: hash(input) } : null;
  return { adapter, state, controller, transport, runRecordedOperation, expectedSourceLinks, readIntent };
}

const makeFenced = (state) => {
  state.auto[id(4)] = false;
  state.config.services[id(3)].source.autoUpdates.type = "disabled";
  for (const service of Object.values(state.config.services)) service.deploy.cronSchedule = null;
  for (const d of Object.values(state.deployments).flat()) { d.status = "SUCCESS"; d.deploymentStopped = true; d.instances = []; }
};

test("read projects selected policy only and retains source link digests", async () => {
  const f = await fixture();
  f.state.fileCron = "0 1 * * *";
  const result = await f.adapter.read();
  const serialized = JSON.stringify(result);
  for (const excluded of ["excluded-config-canary", "excluded-manifest-canary", "retained-repo", "example/app:retained"]) assert.ok(!serialized.includes(excluded));
  assert.equal(result.services[1].fileConfig.cronSchedule, "0 1 * * *");
  assert.match(result.services[0].sourceLinkSha256, /^[a-f0-9]{64}$/);
  assert.equal(f.state.records.length, 0);
});

test("rejects foreign environment and service response bindings", async () => {
  for (const flag of ["foreignEnvironment", "foreignService"]) {
    const f = await fixture(); f.state[flag] = true;
    await assert.rejects(f.adapter.read(), { code: flag === "foreignEnvironment" ? "RAILWAY_ENVIRONMENT_BINDING_MISMATCH" : "RAILWAY_SERVICE_BINDING_MISMATCH" });
    assert.equal(f.state.records.length, 0);
  }
});

test("rejects a foreign deployment in a supposedly scoped page", async () => {
  const f = await fixture(); f.state.deployments[id(3)][0].projectId = id(999);
  await assert.rejects(f.adapter.read(), { code: "RAILWAY_DEPLOYMENT_BINDING_MISMATCH" });
});

test("fully paginates deployment histories with exact scoped variables", async () => {
  const f = await fixture();
  const second = deployment(id(3), 22, "REMOVED", true);
  f.state.pages = (variables) => ({ edges: [{ cursor: variables.after ? "last" : "next", node: variables.serviceId === id(3)
    ? (variables.after ? second : f.state.deployments[id(3)][0]) : f.state.deployments[id(4)][0] }],
  pageInfo: { hasNextPage: variables.serviceId === id(3) && !variables.after, endCursor: variables.after ? "last" : "next" } });
  const result = await f.adapter.read();
  assert.equal(result.services[0].deployments.length, 2);
  const call = f.state.calls.find((entry) => entry.operation === "FenceDeployments" && entry.variables.after === "next");
  assert.equal(call.variables.projectId, binding.projectId);
  assert.equal(call.variables.environmentId, binding.environmentId);
  assert.match(call.query, /includeDeleted:true/);
});

test("rejects incomplete pagination, duplicate histories and active deployments missing from pages", async () => {
  const limited = await fixture({ maxDeploymentPages: 1 });
  limited.state.pages = () => ({ edges: [{ cursor: "more", node: limited.state.deployments[id(3)][0] }], pageInfo: { hasNextPage: true, endCursor: "more" } });
  await assert.rejects(limited.adapter.read(), { code: "DEPLOYMENT_PAGE_LIMIT" });
  const duplicate = await fixture();
  duplicate.state.deployments[id(3)].push(structuredClone(duplicate.state.deployments[id(3)][0]));
  await assert.rejects(duplicate.adapter.read(), { code: "DEPLOYMENT_INVENTORY_LIMIT" });
  const missing = await fixture(); missing.state.extraActive = [deployment(id(3), 23)];
  await assert.rejects(missing.adapter.read(), { code: "ACTIVE_DEPLOYMENT_NOT_IN_INVENTORY" });
});

test("disables only selected triggers through recorded dedicated/scoped operations", async () => {
  const f = await fixture();
  const sourceConfig = structuredClone(f.state.config.services);
  const result = await f.adapter.disableTriggers();
  assert.ok(result.services.every((service) => !service.autoDeployEnabled && service.cronSchedule === null));
  const mutations = f.state.calls.filter((entry) => entry.query.startsWith("mutation"));
  assert.deepEqual(mutations.map((entry) => entry.operation), ["FenceAutoDeploy", "FenceStage", "FenceCommit"]);
  const stage = mutations.find((entry) => entry.operation === "FenceStage");
  assert.deepEqual(stage.variables.input, { services: {
    [id(3)]: { source: { autoUpdates: { type: "disabled" } }, deploy: { cronSchedule: null } },
    [id(4)]: { deploy: { cronSchedule: null } },
  } });
  assert.match(stage.query, /merge:false/);
  assert.match(mutations.at(-1).query, /skipDeploys:true/);
  assert.equal(f.state.config.services[id(3)].source.image, sourceConfig[id(3)].source.image);
  assert.equal(f.state.config.services[id(4)].source.repo, sourceConfig[id(4)].source.repo);
  assert.ok(!JSON.stringify(f.state.records).includes("excluded-config-canary"));
});

test("rejects preexisting staging before any mutation even if it targets a selected service", async () => {
  const f = await fixture();
  f.state.staged.patch = { services: { [id(3)]: { deploy: { cronSchedule: null } } } };
  await assert.rejects(f.adapter.disableTriggers(), { code: "PREEXISTING_RAILWAY_STAGING" });
  assert.equal(f.state.records.length, 0);
});

test("rejects unrelated staging introduced before commit", async () => {
  const f = await fixture();
  f.state.onRecord = async ({ kind }) => {
    if (kind === "RAILWAY_COMMIT_SOURCE_TRIGGERS") f.state.staged.patch.variables = { UNRELATED: "not-ours" };
  };
  await assert.rejects(f.adapter.disableTriggers(), { code: "RAILWAY_STAGED_PATCH_CHANGED" });
  assert.equal(f.state.calls.some((entry) => entry.operation === "FenceCommit"), false);
});

test("resumes an exact staged patch only with caller-provided durable ownership proof", async () => {
  const f = await fixture();
  f.state.onRecord = async ({ kind }) => {
    if (kind === "RAILWAY_COMMIT_SOURCE_TRIGGERS") throw new Error("synthetic stop before commit");
  };
  await assert.rejects(f.adapter.disableTriggers(), { code: "RAILWAY_OPERATION_REQUIRES_RECONCILIATION" });
  const durable = f.state.records.find((record) => record.kind === "RAILWAY_STAGE_SOURCE_TRIGGERS");
  const mutationCount = () => f.state.calls.filter((entry) => entry.query.startsWith("mutation")).length;
  const before = mutationCount();
  await assert.rejects(f.adapter.disableTriggers(), { code: "PREEXISTING_RAILWAY_STAGING" });
  assert.equal(mutationCount(), before);
  f.state.onRecord = null;
  await f.adapter.disableTriggers({ resumeStagedPatch: { environmentId: binding.environmentId, patchSha256: durable.input.patchSha256 }, readIntent: f.readIntent });
  assert.equal(f.state.calls.filter((entry) => entry.operation === "FenceStage").length, 1);
  assert.equal(f.state.calls.filter((entry) => entry.operation === "FenceCommit").length, 1);
});

test("an applying staged operation is not provider-fence acceptance even with an empty patch", async () => {
  const f = await fixture(); makeFenced(f.state); f.state.staged.status = "APPLYING";
  await assert.rejects(f.adapter.disableTriggers(), { code: "RAILWAY_STAGING_BUSY" });
  const result = await f.adapter.assertFenced();
  assert.equal(result.complete, false);
  assert.ok(result.evidence.blockers.includes("STAGING_NOT_IDLE"));
});

test("fails post-update verification if provider source linkage changes", async () => {
  const f = await fixture();
  f.state.mutate = (_data, operation) => {
    if (operation === "FenceAutoDeploy") f.state.config.services[id(4)].source.repo = "foreign/repo";
  };
  await assert.rejects(f.adapter.disableTriggers(), { code: "RAILWAY_SOURCE_LINK_CHANGED" });
  assert.equal(f.state.calls.some((entry) => entry.operation === "FenceStage"), false);
});

test("cancels pending builds and stops running writers while preserving deployment history", async () => {
  const f = await fixture();
  await f.adapter.disableTriggers();
  const originalIds = Object.values(f.state.deployments).flat().map((d) => d.id);
  const result = await f.adapter.stopWriters();
  assert.equal(result.complete, true);
  assert.equal(result.evidence.providerFence, "VERIFIED");
  assert.equal(result.evidence.databaseFence, "UNPROVEN");
  assert.equal(result.evidence.manualDeployPrevention, "UNPROVEN");
  assert.deepEqual(Object.values(f.state.deployments).flat().map((d) => d.id), originalIds);
  assert.ok(f.state.records.some((record) => record.kind === "RAILWAY_STOP_SOURCE_DEPLOYMENT"));
  assert.ok(f.state.records.some((record) => record.kind === "RAILWAY_CANCEL_SOURCE_DEPLOYMENT"));
  assert.ok(f.state.calls.every((entry) => !/deploymentRemove|serviceInstanceUpdate|serviceDelete/.test(entry.query)));
});

test("unknown stop acknowledgement requires readback and never retries the mutation", async () => {
  const f = await fixture(); await f.adapter.disableTriggers(); f.state.unknownAck = true;
  await assert.rejects(f.adapter.stopWriters(), { code: "RAILWAY_REQUEST_FAILED" });
  assert.equal(f.state.calls.filter((entry) => entry.operation === "FenceStop").length, 1);
  assert.equal(f.state.deployments[id(3)][0].deploymentStopped, true);
});

test("stop readback also rejects changed source linkage", async () => {
  const f = await fixture(); await f.adapter.disableTriggers();
  f.state.mutateOnStop = () => { f.state.config.services[id(3)].source.image = "foreign/image"; };
  await assert.rejects(f.adapter.stopWriters(), { code: "RAILWAY_SOURCE_LINK_CHANGED" });
  assert.equal(f.state.calls.filter((entry) => entry.operation === "FenceStop").length, 1);
});

test("one-shot apply closure prevents recorder-induced mutation replay", async () => {
  const f = await fixture();
  f.state.onRecord = async (record) => {
    if (record.kind === "RAILWAY_DISABLE_AUTODEPLOY") {
      f.state.inRecordedApply = true;
      try { await record.apply(); await record.apply(); } finally { f.state.inRecordedApply = false; }
    }
  };
  await assert.rejects(f.adapter.disableTriggers(), { code: "RAILWAY_MUTATION_REPLAY_FORBIDDEN" });
  assert.equal(f.state.calls.filter((entry) => entry.operation === "FenceAutoDeploy").length, 1);
});

test("fresh final inventory detects a deployment added during stop", async () => {
  const f = await fixture(); await f.adapter.disableTriggers();
  f.state.mutateOnStop = () => {
    if (!f.state.deployments[id(3)].some((d) => d.id === id(25))) f.state.deployments[id(3)].push(deployment(id(3), 25));
  };
  const result = await f.adapter.stopWriters();
  assert.equal(result.complete, false);
  assert.ok(result.evidence.blockers.includes("ACTIVE_DEPLOYMENTS_PRESENT"));
});

test("provider acceptance requires stopped flag, no live instances, no pending queue and no environment work", async () => {
  const f = await fixture(); makeFenced(f.state);
  for (const mutate of [
    () => { f.state.deployments[id(3)][0].deploymentStopped = false; },
    () => { f.state.deployments[id(3)][0].instances = [{ id: id(100), status: "RESTARTING" }]; },
    () => { f.state.deployments[id(3)][0].status = "QUEUED"; },
  ]) {
    makeFenced(f.state); mutate();
    assert.equal((await f.adapter.assertFenced()).complete, false);
  }
  makeFenced(f.state);
  f.state.pending = [{ id: "parent-op", environmentId: binding.environmentId, kind: "patch", status: "applying",
    children: [{ id: "child-op", environmentId: binding.environmentId, kind: "deployment", status: "applying", children: [] }] }];
  const result = await f.adapter.assertFenced();
  assert.ok(result.evidence.blockers.includes("PENDING_ENVIRONMENT_WORK"));
  assert.equal(result.evidence.pendingWork[0].children.length, 1);
});

test("pending operation trees deeper than queried scope fail closed", async () => {
  const f = await fixture();
  const parent = (child) => ({ id: "op", environmentId: binding.environmentId, kind: "patch", status: "applying", children: child ? [child] : [] });
  f.state.pending = [parent(parent(parent(parent(parent(null)))))];
  await assert.rejects(f.adapter.read(), { code: "PENDING_WORK_DEPTH_EXCEEDED" });
});

test("checks AbortSignal before dispatch and after each read", async () => {
  const f = await fixture(); f.controller.abort();
  await assert.rejects(f.adapter.read(), { code: "RAILWAY_FENCE_ABORTED" });
  assert.equal(f.state.calls.length, 0);
  const after = await fixture(); after.state.mutate = () => after.controller.abort();
  await assert.rejects(after.adapter.read(), { code: "RAILWAY_FENCE_ABORTED" });
  assert.equal(after.state.calls.length, 1);
});

test("default transport uses exact endpoint, rejects redirects/errors and bounds private responses", async () => {
  const token = randomBytes(24).toString("hex");
  const signal = new AbortController().signal;
  const request = { query: "query FenceTest { __typename }", variables: {}, signal };
  const transport = createRailwayFenceTransport({ token, fetchImpl: async (url, options) => {
    assert.equal(url, "https://backboard.railway.com/graphql/v2");
    assert.equal(options.redirect, "error");
    return new Response(JSON.stringify({ errors: [{ message: `private ${token}` }] }), { status: 200 });
  } });
  await assert.rejects(transport(request), (error) => error.code === "RAILWAY_GRAPHQL_FAILED" && !error.message.includes(token) && !error.cause);
  const bounded = createRailwayFenceTransport({ token, maxResponseBytes: 8,
    fetchImpl: async () => new Response(JSON.stringify({ data: { privateValue: "oversized" } })) });
  await assert.rejects(bounded(request), { code: "RAILWAY_RESPONSE_LIMIT" });
});

test("inventory can collect a baseline but mutations and acceptance require durable expected source links", async () => {
  const f = await fixture({ expectedSourceLinks: null });
  assert.equal((await f.adapter.read()).services.length, 2);
  for (const run of [() => f.adapter.disableTriggers(), () => f.adapter.stopWriters(), () => f.adapter.assertFenced()]) {
    await assert.rejects(run(), { code: "DURABLE_SOURCE_LINKS_REQUIRED" });
  }
  assert.equal(f.state.records.length, 0);
});

test("reopening cannot learn a changed source image as a new accepted baseline", async () => {
  const f = await fixture();
  const retained = structuredClone(f.expectedSourceLinks);
  makeFenced(f.state);
  f.state.config.services[id(3)].source.image = "foreign/image-after-restart";
  const reopened = new RailwaySourceFence({ binding, expectedSourceLinks: retained, transport: f.transport,
    runRecordedOperation: f.runRecordedOperation, signal: new AbortController().signal });
  for (const run of [() => reopened.assertFenced(), () => reopened.disableTriggers(), () => reopened.stopWriters()]) {
    await assert.rejects(run(), { code: "RAILWAY_SOURCE_LINK_CHANGED" });
  }
  assert.equal(f.state.records.length, 0);
});

test("expected source links use an exact order-independent set with stable operation inputs", async () => {
  const f = await fixture();
  const options = { binding: { ...binding, serviceIds: [...binding.serviceIds].reverse() },
    expectedSourceLinks: [...f.expectedSourceLinks].reverse(), transport: f.transport,
    runRecordedOperation: f.runRecordedOperation, signal: new AbortController().signal };
  const adapter = new RailwaySourceFence(options);
  assert.deepEqual(adapter.binding.serviceIds, binding.serviceIds);
  await adapter.disableTriggers();
  const staged = f.state.records.find((entry) => entry.kind === "RAILWAY_STAGE_SOURCE_TRIGGERS");
  assert.deepEqual(staged.input.links, f.expectedSourceLinks);
  for (const links of [[f.expectedSourceLinks[0]], [f.expectedSourceLinks[0], f.expectedSourceLinks[0]],
    [f.expectedSourceLinks[0], { ...f.expectedSourceLinks[1], serviceId: id(999) }]]) {
    assert.throws(() => new RailwaySourceFence({ ...options, expectedSourceLinks: links }), { code: "INVALID_EXPECTED_SOURCE_LINKS" });
  }
});

function independentMemoryStores() {
  const intentSha256 = "d".repeat(64);
  let text = JSON.stringify(createCutoverJournal({ domain: "core", intentSha256, evidenceSha256: "e".repeat(64) }));
  let etag = 0;
  let lease = null;
  const records = new Map();
  const blob = {
    async acquire() { assert.equal(lease, null); lease = randomUUID(); return lease; },
    async renew(value) { assert.equal(value, lease); },
    async release(value) { assert.equal(value, lease); lease = null; },
    async read(value) { assert.equal(value, lease); return { text, etag }; },
    async write(next, conditions) {
      assert.equal(conditions.lease, lease); assert.equal(conditions.etag, etag);
      text = next; return { etag: ++etag };
    },
  };
  const store = {
    async assertPrivate() {},
    async readOptional(key) { return records.get(key) ?? null; },
    async createOnly(key, value) { assert.equal(records.has(key), false); records.set(key, value); },
  };
  return { blob, store, intentSha256, records };
}

for (const [operation, kind] of [
  ["FenceStage", "RAILWAY_STAGE_SOURCE_TRIGGERS"],
  ["FenceCommit", "RAILWAY_COMMIT_SOURCE_TRIGGERS"],
  ["FenceAutoDeploy", "RAILWAY_DISABLE_AUTODEPLOY"],
  ["FenceStop", "RAILWAY_STOP_SOURCE_DEPLOYMENT"],
  ["FenceCancel", "RAILWAY_CANCEL_SOURCE_DEPLOYMENT"],
]) test(`actual custody/recorder reconciles lost ${operation} acknowledgement without repeating provider effects`, async () => {
  const f = await fixture();
  const persistedLinks = structuredClone(f.expectedSourceLinks);
  const stores = independentMemoryStores();
  // Controller descriptors are retained independently; the recorder stores their digests only.
  const controllerPlan = new Map();
  let custody = await openCutoverCustody(stores.blob, stores.intentSha256);
  await custody.begin("SOURCE_FENCED", "f".repeat(64));
  let recorder;
  let adapter;
  async function bindOwner() {
    recorder = await openProviderOperationRecorder({ custody, store: stores.store, phase: "SOURCE_FENCED", signal: custody.signal });
    const runRecordedOperation = async (descriptor) => {
      controllerPlan.set(descriptor.kind, { kind: descriptor.kind, input: structuredClone(descriptor.input) });
      return recorder.runRecordedOperation({ ...descriptor, apply: async () => {
        f.state.inRecordedApply = true;
        try { return await descriptor.apply(); } finally { f.state.inRecordedApply = false; }
      } });
    };
    adapter = new RailwaySourceFence({ binding: { ...binding, serviceIds: [...binding.serviceIds].reverse() },
      expectedSourceLinks: [...persistedLinks].reverse(), transport: f.transport,
      runRecordedOperation, signal: custody.signal });
  }
  try {
    await bindOwner();
    f.state.ackLossOperation = operation;
    if (operation === "FenceStop" || operation === "FenceCancel") await adapter.disableTriggers();
    await assert.rejects(operation === "FenceStop" || operation === "FenceCancel" ? adapter.stopWriters() : adapter.disableTriggers(),
      { code: "RAILWAY_OPERATION_REQUIRES_RECONCILIATION" });
    assert.equal(f.state.calls.filter((call) => call.operation === operation).length, 1);
    const retainedDescriptor = structuredClone(controllerPlan.get(kind));
    assert.ok(retainedDescriptor);
    await custody.close();
    custody = await openCutoverCustody(stores.blob, stores.intentSha256);
    await bindOwner();
    f.state.ackLossOperation = null;

    // A descriptor with another source/environment binding cannot recover this intent.
    const wrong = structuredClone(retainedDescriptor.input);
    if (wrong.binding) wrong.binding.environmentId = id(999); else wrong.environmentId = id(999);
    assert.equal(await recorder.readIntent(kind, wrong), null);
    const durable = await recorder.readIntent(kind, retainedDescriptor.input);
    assert.equal(durable.kind, kind);
    assert.equal(durable.binding.intentSha256, stores.intentSha256);
    assert.equal(durable.inputSha256, hash(retainedDescriptor.input));

    if (operation === "FenceStage") {
      const resumeStagedPatch = { environmentId: retainedDescriptor.input.binding.environmentId,
        patchSha256: retainedDescriptor.input.patchSha256 };
      await adapter.disableTriggers({ resumeStagedPatch, readIntent: recorder.readIntent });
    } else if (operation === "FenceCommit") {
      assert.deepEqual(f.state.staged.patch, {});
      const resumeCommit = { environmentId: retainedDescriptor.input.binding.environmentId,
        patchSha256: retainedDescriptor.input.patchSha256, stagedPatchId: retainedDescriptor.input.stagedPatchId };
      await adapter.disableTriggers({ resumeCommit, readIntent: recorder.readIntent });
    } else {
      await adapter.reconcileRecordedOperation({ ...retainedDescriptor, readIntent: recorder.readIntent });
      await adapter.disableTriggers();
    }
    const result = await adapter.stopWriters();
    assert.equal(result.complete, true);
    assert.equal((await adapter.assertFenced()).evidence.providerFence, "VERIFIED");
    assert.equal(result.evidence.databaseFence, "UNPROVEN");
    for (const mutation of ["FenceStage", "FenceCommit", "FenceAutoDeploy", "FenceStop", "FenceCancel"]) {
      assert.equal(f.state.calls.filter((call) => call.operation === mutation).length, 1, `${mutation} repeated`);
    }
    const intents = [...stores.records.keys()].filter((key) => key.endsWith("/intent.json"));
    const receipts = [...stores.records.keys()].filter((key) => key.endsWith("/receipt.json"));
    assert.equal(intents.length, 5);
    assert.equal(receipts.length, intents.length, "all inherited intents must have reconciled receipts");
    assert.equal(custody.snapshot().phase, "PREPARED", "provider-only proof cannot complete the whole source-fence phase");
  } finally { await custody.close(); }
});

test("recovery refuses provider-state matches without an actual durable intent or with changed descriptor binding", async () => {
  const f = await fixture(); await f.adapter.disableTriggers();
  const descriptor = f.state.records.find((record) => record.kind === "RAILWAY_DISABLE_AUTODEPLOY");
  const before = f.state.calls.filter((call) => call.query.startsWith("mutation")).length;
  await assert.rejects(f.adapter.reconcileRecordedOperation({ ...descriptor, readIntent: async () => null }),
    { code: "RAILWAY_DURABLE_INTENT_UNPROVEN" });
  await assert.rejects(f.adapter.reconcileRecordedOperation({ ...descriptor,
    input: { ...descriptor.input, sourceLinkSha256: "f".repeat(64) }, readIntent: f.readIntent }),
  { code: "RAILWAY_RECOVERY_BINDING_MISMATCH" });
  assert.equal(f.state.calls.filter((call) => call.query.startsWith("mutation")).length, before);
});
