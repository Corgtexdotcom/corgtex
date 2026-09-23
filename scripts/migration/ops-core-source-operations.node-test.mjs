import assert from "node:assert/strict";
import { test } from "node:test";
import { createCutoverJournal, openCutoverCustody } from "./ops-core-custody.mjs";
import { openSourceOperations } from "./ops-core-source-operations.mjs";

const id = digit => `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
const operation = { kind: "RAILWAY_DISABLE_AUTODEPLOY", input: { projectId: id("1"), environmentId: id("2"),
  serviceId: id("3"), enabled: false, sourceLinkSha256: "b".repeat(64) } };
async function setup() {
  const records = new Map();
  let state = JSON.stringify(createCutoverJournal({ domain: "core", intentSha256: "a".repeat(64), evidenceSha256: "b".repeat(64) }));
  let etag = 0;
  let lease = false;
  const f = { records, effect: false, failSuffix: null };
  const blob = {
    async acquire() { assert.equal(lease, false); lease = true; return "test-lease"; },
    async renew() { assert.equal(lease, true); },
    async release() { lease = false; },
    async read() { return { text: state, etag }; },
    async write(text, expected) { assert.equal(expected.etag, etag); state = text; return { etag: ++etag }; },
  };
  f.store = {
    async assertPrivate() {},
    async readOptional(key) { return records.get(key) ?? null; },
    async createOnly(key, value) {
      assert.equal(records.has(key), false);
      records.set(key, value);
      if (f.failSuffix && key.endsWith(f.failSuffix)) throw Error("PRIVATE_PROVIDER_OUTPUT");
    },
    async listDescriptors(prefix) { return [...records.keys()].filter(key => key.startsWith(prefix) && key.endsWith("/descriptor.json")).sort(); },
  };
  f.open = async () => {
    f.custody = await openCutoverCustody(blob, "a".repeat(64));
    if (!f.custody.snapshot().pending) await f.custody.begin("SOURCE_FENCED", "c".repeat(64));
    f.operations = await openSourceOperations({ custody: f.custody, store: f.store });
    return f.operations;
  };
  f.close = () => f.custody.close();
  f.callbacks = {
    async apply() { f.effect = true; },
    async verify() { return { complete: f.effect, evidence: { disabled: f.effect } }; },
  };
  await f.open();
  return f;
}

test("descriptor readback precedes intent/effect and survives a lost provider acknowledgement", async () => {
  const f = await setup();
  try {
    await assert.rejects(f.operations.runRecordedOperation({ ...operation, ...f.callbacks, async apply() {
      assert.equal(f.records.size, 2);
      assert.ok([...f.records.keys()].some(key => key.endsWith("/descriptor.json")));
      f.effect = true;
      throw Error("PRIVATE_PROVIDER_OUTPUT");
    } }), /SOURCE_OPERATION_RECONCILE_REQUIRED/);
    await f.close();
    await f.open();
    assert.deepEqual(await f.operations.pendingDescriptors(), [operation]);
    await f.operations.runRecordedOperation({ ...operation, ...f.callbacks, async apply() { assert.fail("must never replay"); } });
    assert.deepEqual(await f.operations.pendingDescriptors(), []);
    const receipt = await f.operations.assertSettled();
    assert.equal(receipt.descriptorCount, 1);
    assert.equal(receipt.completedCount, 1);
  } finally { await f.close(); }
});

test("lost descriptor acknowledgement cannot produce an effect or a falsely pending intent", async () => {
  const f = await setup();
  try {
    f.failSuffix = "descriptor.json";
    await assert.rejects(f.operations.runRecordedOperation({ ...operation, ...f.callbacks }), /SOURCE_OPERATION_RECONCILE_REQUIRED/);
    assert.equal(f.effect, false);
    assert.equal(f.records.size, 1);
    await f.close();
    f.failSuffix = null;
    await f.open();
    assert.deepEqual(await f.operations.pendingDescriptors(), []);
    // No intent existed, so a fresh one-shot dispatch remains possible.
    await f.operations.runRecordedOperation({ ...operation, ...f.callbacks });
    assert.equal(f.effect, true);
    assert.equal((await f.operations.assertSettled()).completedCount, 1);
  } finally { await f.close(); }
});

test("inherited pending intent prevents phase settlement and remains unexecuted", async () => {
  const f = await setup();
  try {
    await assert.rejects(f.operations.runRecordedOperation({ ...operation, ...f.callbacks,
      async apply() { throw Error("transport failed before known effect"); } }), /SOURCE_OPERATION_RECONCILE_REQUIRED/);
    await f.close();
    await f.open();
    await assert.rejects(f.operations.assertSettled(), /SOURCE_OPERATION_RECONCILE_REQUIRED/);
    assert.equal(f.effect, false);
  } finally { await f.close(); }
});

test("credential or arbitrary fields are rejected before any record or effect", async () => {
  const f = await setup();
  try {
    await assert.rejects(f.operations.runRecordedOperation({ ...operation, ...f.callbacks,
      input: { ...operation.input, password: "SYNTHETIC_PRIVATE_VALUE" } }), /SOURCE_OPERATION_RECONCILE_REQUIRED/);
    assert.equal(f.records.size, 0);
    assert.equal(f.effect, false);
  } finally { await f.close(); }
});

test("tampered descriptor or receipt cannot hide an inherited pending operation", async () => {
  for (const target of ["descriptor", "receipt"]) {
    const f = await setup();
    try {
      await f.operations.runRecordedOperation({ ...operation, ...f.callbacks });
      const key = [...f.records.keys()].find(key => key.endsWith(`/${target}.json`));
      const value = JSON.parse(f.records.get(key));
      if (target === "descriptor") value.input.serviceId = id("4");
      else value.intentSha256 = "f".repeat(64);
      f.records.set(key, JSON.stringify(value));
      await assert.rejects(f.operations.pendingDescriptors(), /SOURCE_OPERATION_RECONCILE_REQUIRED/);
    } finally { await f.close(); }
  }
});

test("phase artifacts are create-only and concurrent same-owner effects cannot race", async () => {
  const f = await setup();
  try {
    const value = { phase: "source", binding: operation.input };
    const first = await f.operations.retainPhaseArtifact("phase-plan", value);
    assert.equal(await f.operations.retainPhaseArtifact("phase-plan", value), first);
    const outcomes = await Promise.allSettled([
      f.operations.runRecordedOperation({ ...operation, ...f.callbacks }),
      f.operations.runRecordedOperation({ ...operation, ...f.callbacks }),
    ]);
    assert.equal(outcomes.filter(result => result.status === "fulfilled").length, 1);
    assert.match(outcomes.find(result => result.status === "rejected").reason.message, /SOURCE_OPERATION_CONCURRENT/);
    await assert.rejects(f.operations.retainPhaseArtifact("phase-plan", { ...value, changed: true }), /SOURCE_OPERATION_RECONCILE_REQUIRED/);
  } finally { await f.close(); }
});

test("JSON null or scalar records never turn an already-applied effect into an orphan", async () => {
  for (const target of ["intent", "receipt"]) for (const invalid of [null, false, 0, []]) {
    const f = await setup();
    try {
      if (target === "intent") {
        await assert.rejects(f.operations.runRecordedOperation({ ...operation, ...f.callbacks, async apply() {
          f.effect = true;
          throw Error("lost effect acknowledgement");
        } }), /SOURCE_OPERATION_RECONCILE_REQUIRED/);
        await f.close();
        await f.open();
      } else await f.operations.runRecordedOperation({ ...operation, ...f.callbacks });
      const key = [...f.records.keys()].find(key => key.endsWith(`/${target}.json`));
      f.records.set(key, JSON.stringify(invalid));
      assert.equal(f.effect, true);
      await assert.rejects(f.operations.assertSettled(), /SOURCE_OPERATION_RECONCILE_REQUIRED/);
    } finally { await f.close(); }
  }
});

test("lease loss during an empty descriptor listing cannot report settlement", async () => {
  const f = await setup();
  try {
    f.store.listDescriptors = async () => { await f.custody.close(); return []; };
    await assert.rejects(f.operations.assertSettled(), /SOURCE_OPERATION_RECONCILE_REQUIRED/);
  } finally { await f.close(); }
});
