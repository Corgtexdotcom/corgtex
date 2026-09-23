import assert from "node:assert/strict";
import { test } from "node:test";
import { Readable } from "node:stream";
import { openProviderOperationRecorder, azureProviderOperationStore,
  providerOperationDiagnostic } from "./ops-core-provider-operations.mjs";

function fixture() {
  const records = new Map();
  const abort = new AbortController();
  const journal = { domain: "core", intentSha256: "a".repeat(64),
    pending: { to: "SOURCE_FENCED", operationId: "11111111-1111-4111-8111-111111111111" } };
  const state = { records, journal, failWrite: null, failRead: false, owned: true, writes: 0, effects: 0,
    complete: false, private: true };
  const custody = { snapshot: () => structuredClone(journal), async assertOwned() {
    if (!state.owned) throw Error("PRIVATE_PROVIDER_CREDENTIAL");
  } };
  const store = {
    async assertPrivate() { if (!state.private) throw Error("PRIVATE_PROVIDER_CREDENTIAL"); },
    async readOptional(key) { if (state.failRead) throw Error("PRIVATE_PROVIDER_CREDENTIAL"); return records.get(key) ?? null; },
    async createOnly(key, text) {
      assert.equal(records.has(key), false);
      records.set(key, text);
      state.writes++;
      state.afterWrite?.(key);
      if (state.failWrite && key.endsWith(state.failWrite)) throw Error("PRIVATE_PROVIDER_CREDENTIAL");
    },
  };
  state.open = () => openProviderOperationRecorder({ custody, store, phase: "SOURCE_FENCED", signal: abort.signal });
  state.operation = { kind: "RAILWAY_STAGE_SOURCE_TRIGGERS", input: { environmentId: "safe-id", patchSha256: "b".repeat(64) },
    async apply() { state.effects++; state.complete = true; },
    async verify() { return { complete: state.complete, evidence: { stopped: state.complete } }; } };
  state.abort = () => abort.abort(Error("PRIVATE_ABORT_REASON"));
  return state;
}

test("intent is read back before one effect; receipt follows verified state", async () => {
  const f = fixture();
  const original = f.operation.apply;
  f.operation.apply = async () => {
    assert.equal(f.records.size, 1);
    assert.equal(JSON.parse([...f.records.values()][0]).type, "intent");
    await original();
  };
  const recorder = await f.open();
  const receipt = await recorder.runRecordedOperation(f.operation);
  assert.equal(receipt.reconciled, false);
  assert.equal(f.effects, 1);
  assert.equal(f.records.size, 2);
  const intent = await recorder.readIntent(f.operation.kind, f.operation.input);
  assert.equal(intent.operationId, receipt.operationId);
  assert.equal([...f.records.values()].some(text => text.includes("safe-id")), false);
  const replay = await recorder.runRecordedOperation(f.operation);
  assert.equal(replay.reconciled, true);
  assert.equal(f.effects, 1);
  assert.equal(f.writes, 2);
});

test("lost intent acknowledgement never dispatches, including after reopen", async () => {
  const f = fixture();
  f.failWrite = "intent.json";
  const first = await f.open();
  await assert.rejects(first.runRecordedOperation(f.operation), /PROVIDER_OPERATION_RECONCILE_REQUIRED/);
  assert.equal(f.effects, 0);
  await assert.rejects(first.readIntent(f.operation.kind, f.operation.input), /PROVIDER_OWNER_RECONCILE_REQUIRED/);
  f.failWrite = null;
  const next = await f.open();
  await assert.rejects(next.runRecordedOperation(f.operation), /PROVIDER_PENDING_RECONCILIATION_REQUIRED/);
  assert.equal(f.effects, 0);
});

test("provider lost acknowledgement reconciles actual effect without dispatching again", async () => {
  const f = fixture();
  f.operation.apply = async () => { f.effects++; f.complete = true; throw Error("PRIVATE_PROVIDER_CREDENTIAL"); };
  await assert.rejects((await f.open()).runRecordedOperation(f.operation), /PROVIDER_OPERATION_RECONCILE_REQUIRED/);
  assert.equal(f.records.size, 1);
  assert.equal((await (await f.open()).runRecordedOperation(f.operation)).reconciled, true);
  assert.equal(f.effects, 1);
  assert.equal(f.records.size, 2);
});

test("lost receipt acknowledgement and subsequent completed-state drift never replay", async () => {
  const f = fixture();
  f.failWrite = "receipt.json";
  await assert.rejects((await f.open()).runRecordedOperation(f.operation), /PROVIDER_OPERATION_RECONCILE_REQUIRED/);
  f.failWrite = null;
  await (await f.open()).runRecordedOperation(f.operation);
  f.complete = false;
  await assert.rejects((await f.open()).runRecordedOperation(f.operation), /PROVIDER_COMPLETED_STATE_DRIFT/);
  assert.equal(f.effects, 1);
  assert.equal(f.writes, 2);
});

test("custody failure prevents effect and provider error text is redacted", async () => {
  const f = fixture();
  const recorder = await f.open();
  f.owned = false;
  const error = await recorder.runRecordedOperation(f.operation).catch(error => error);
  assert.equal(providerOperationDiagnostic(error), "PROVIDER_OPERATION_RECONCILE_REQUIRED");
  assert.equal(providerOperationDiagnostic(Error("PRIVATE_PROVIDER_CREDENTIAL")), null);
  assert.equal(f.effects, 0);
  assert.equal(f.records.size, 0);
});

test("custody lost after intent upload prevents the subsequent provider effect", async () => {
  const f = fixture();
  const recorder = await f.open();
  f.afterWrite = () => { f.owned = false; };
  await assert.rejects(recorder.runRecordedOperation(f.operation), /PROVIDER_OPERATION_RECONCILE_REQUIRED/);
  assert.equal(f.records.size, 1);
  assert.equal(f.effects, 0);
  f.owned = true;
  f.afterWrite = null;
  await assert.rejects((await f.open()).runRecordedOperation(f.operation), /PROVIDER_PENDING_RECONCILIATION_REQUIRED/);
  assert.equal(f.effects, 0);
});

test("abort and changed phase reject further operations", async () => {
  for (const change of [f => f.abort(), f => { f.journal.pending.operationId = "22222222-2222-4222-8222-222222222222"; }]) {
    const f = fixture();
    const recorder = await f.open();
    change(f);
    await assert.rejects(recorder.runRecordedOperation(f.operation), /PROVIDER_(OPERATION_RECONCILE_REQUIRED|PHASE_CHANGED)/);
    assert.equal(f.effects, 0);
  }
});

test("tampered durable binding is rejected before reconciliation", async () => {
  const f = fixture();
  await (await f.open()).runRecordedOperation(f.operation);
  const key = [...f.records.keys()].find(key => key.endsWith("intent.json"));
  const record = JSON.parse(f.records.get(key));
  record.binding.domain = "ops";
  f.records.set(key, JSON.stringify(record));
  await assert.rejects((await f.open()).runRecordedOperation(f.operation), /PROVIDER_INTENT_MISMATCH/);
  assert.equal(f.effects, 1);
});

test("concurrent callbacks cannot dispatch two provider effects", async () => {
  const f = fixture();
  const recorder = await f.open();
  const results = await Promise.allSettled([recorder.runRecordedOperation(f.operation), recorder.runRecordedOperation(f.operation)]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.match(results.find(result => result.status === "rejected").reason.message, /PROVIDER_CONCURRENT_OPERATION/);
  assert.equal(f.effects, 1);
});

test("unprivate storage and malformed input cannot dispatch or retain values", async () => {
  const f = fixture();
  f.private = false;
  await assert.rejects(f.open(), /PROVIDER_OPERATION_RECONCILE_REQUIRED/);
  f.private = true;
  const recorder = await f.open();
  await assert.rejects(recorder.runRecordedOperation({ ...f.operation, input: { invalid: undefined } }), /PROVIDER_RECORD_INVALID/);
  assert.equal(f.effects, 0);
  assert.equal(f.records.size, 0);
});

test("Azure adapter only treats BlobNotFound as absence and always uses create-only writes", async () => {
  const key = `operations/core/${"a".repeat(64)}/11111111-1111-4111-8111-111111111111/${"b".repeat(64)}/intent.json`;
  const signal = new AbortController().signal;
  let error = { statusCode: 404, code: "BlobNotFound" };
  const calls = [];
  const store = azureProviderOperationStore({
    async getAccessPolicy() { return {}; },
    getBlockBlobClient(value) {
      assert.equal(value, key);
      return {
        async download() { if (error) throw error; return { contentLength: 2, readableStreamBody: Readable.from(["{}"]) }; },
        async upload(...args) { calls.push(args); },
      };
    },
  });
  assert.equal(await store.readOptional(key, signal), null);
  error = { statusCode: 404, code: "ContainerNotFound" };
  await assert.rejects(store.readOptional(key, signal), /PROVIDER_STORE_READ_FAILED/);
  error = null;
  assert.equal(await store.readOptional(key, signal), "{}");
  await store.createOnly(key, "{}", signal);
  assert.deepEqual(calls[0][2].conditions, { ifNoneMatch: "*" });
  await assert.rejects(store.readOptional("../elsewhere", signal), /PROVIDER_STORE_READ_FAILED/);
});
