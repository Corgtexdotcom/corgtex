import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { openOpsCoreReleaseCustody, opsCoreReleaseCustodyDiagnostic, azureOpsCoreReleaseStore } from "./ops-core-release-custody.mjs";
import { openProviderOperationRecorder } from "./ops-core-provider-operations.mjs";

function memory() {
  const blobs = new Map(), leases = new Map(), log = [];
  let etag = 0;
  const write = (key, text) => { const row = { text, etag: String(++etag) }; blobs.set(key, row); return row; };
  const state = { blobs, leases, log, failRenew: false, loseWrite: false, loseCreate: false, beforeCreate: null };
  const store = {
    async assertPrivate() { log.push("private"); if (state.public) throw Error("private-detail"); },
    async ensureLock(key, text) { log.push("ensure"); if (!blobs.has(key)) write(key, text); },
    async readOptional(key, signal, leaseId) {
      signal?.throwIfAborted();
      if (leaseId) assert.equal(leases.get(key), leaseId);
      return structuredClone(blobs.get(key) ?? null);
    },
    async createOnly(key, text) {
      state.beforeCreate?.(key, text); log.push(`create:${key}`);
      assert.equal(blobs.has(key), false); write(key, text);
      if (state.loseCreate) { state.loseCreate = false; throw Error("private lost acknowledgement"); }
    },
    async acquire(key, seconds) {
      assert.equal(seconds, 60); if (leases.has(key)) throw Error("lease held private");
      const leaseId = randomUUID(); leases.set(key, leaseId); log.push("acquire"); return leaseId;
    },
    async renew(leaseId) { if (state.failRenew || ![...leases.values()].includes(leaseId)) throw Error("lost private lease"); },
    async release(leaseId) {
      for (const [key, value] of leases) if (value === leaseId) { leases.delete(key); log.push("release"); return; }
      throw Error("unknown lease");
    },
    async write(key, text, options) {
      assert.equal(leases.get(key), options.leaseId); assert.equal(blobs.get(key).etag, options.etag);
      log.push(`write:${JSON.parse(text).current.status}`); const row = write(key, text);
      if (state.loseWrite) { state.loseWrite = false; throw Error("private lost acknowledgement"); }
      return { etag: row.etag };
    },
  };
  return { ...state, state, store };
}
const plan = () => ({ releaseId: randomUUID(), release: { gitSha: "a".repeat(40), version: "1.2.3" }, target: "fixture" });
const input = (f, p = plan()) => ({ store: f.store, domain: "ops", targetBindingSha256: "b".repeat(64), plan: p });
const complete = () => ({ complete: true, outcome: "released", evidenceSha256: "c".repeat(64) });
const rejected = (value, code) => assert.rejects(value, error => opsCoreReleaseCustodyDiagnostic(error) === code);

test("stable domain lease serializes different releases and target hashes", async () => {
  const f = memory(), options = input(f), first = await openOpsCoreReleaseCustody(options);
  try {
    assert.equal(first.mode, "apply");
    await rejected(openOpsCoreReleaseCustody(input(f)), "RELEASE_OPEN_UNCERTAIN");
    await rejected(openOpsCoreReleaseCustody({ ...input(f), targetBindingSha256: "d".repeat(64) }), "RELEASE_OPEN_UNCERTAIN");
    assert.equal(f.leases.size, 1); await first.assertOwned();
  } finally { await first.close(); }
  await rejected(openOpsCoreReleaseCustody(input(f)), "RELEASE_PRIOR_UNFINISHED");
  await rejected(openOpsCoreReleaseCustody({ ...options, targetBindingSha256: "d".repeat(64) }), "RELEASE_OWNER_BINDING_MISMATCH");
});

test("same unfinished release reopens read-only reconciliation and binds exact immutable plan", async () => {
  const f = memory(), options = input(f), owner = await openOpsCoreReleaseCustody(options);
  const expected = owner.snapshot(); await owner.close();
  await rejected(openOpsCoreReleaseCustody({ ...options, plan: { ...options.plan, target: "foreign" } }), "RELEASE_PLAN_MISMATCH");
  const reopened = await openOpsCoreReleaseCustody(options);
  try {
    assert.equal(reopened.mode, "reconcile");
    assert.deepEqual(reopened.snapshot(), { ...expected, mode: "reconcile" });
    assert.equal(reopened.snapshot().phase, "RELEASE_PREPARED");
    assert.deepEqual(reopened.snapshot().pending, { to: "RELEASING", operationId: options.plan.releaseId });
  } finally { await reopened.close(); }
});

test("immutable result is retained before finished pointer, then a unique new release can start", async () => {
  const f = memory(), options = input(f), owner = await openOpsCoreReleaseCustody(options);
  const result = complete();
  const finished = await owner.finish(result);
  assert.equal(owner.mode, "finished"); assert.deepEqual(owner.result, result); assert.equal(owner.snapshot().pending, null);
  const resultWrite = f.log.findIndex(x => x.endsWith("/result.json"));
  assert.ok(resultWrite > 0 && resultWrite < f.log.indexOf("write:finished"));
  assert.match(finished.resultSha256, /^[a-f0-9]{64}$/);
  await owner.close();
  const again = await openOpsCoreReleaseCustody(options);
  assert.equal(again.mode, "finished"); assert.deepEqual(again.result, result);
  assert.deepEqual(await again.finish(result), finished); await again.close();
  const next = await openOpsCoreReleaseCustody(input(f));
  assert.equal(next.mode, "apply"); assert.equal(next.lockPath, owner.lockPath); await next.close();
  assert.equal([...f.blobs.keys()].some(k => k.includes("cutover")), false);
});

test("failure between pending pointer and immutable plan cannot be bypassed", async () => {
  const f = memory(), options = input(f);
  f.state.beforeCreate = key => { if (key.endsWith("/plan.json")) throw Error("private offline"); };
  await rejected(openOpsCoreReleaseCustody(options), "RELEASE_OPEN_UNCERTAIN");
  await rejected(openOpsCoreReleaseCustody(input(f)), "RELEASE_PRIOR_UNFINISHED");
  f.state.beforeCreate = null;
  const owner = await openOpsCoreReleaseCustody(options);
  assert.equal(owner.mode, "reconcile");
  assert.ok(f.blobs.has(`release-custody/ops/releases/${options.plan.releaseId}/plan.json`)); await owner.close();
});

test("lost start pointer acknowledgement stops owner and next open is reconciliation", async () => {
  const f = memory(), options = input(f); f.state.loseWrite = true;
  await rejected(openOpsCoreReleaseCustody(options), "RELEASE_OPEN_UNCERTAIN");
  const owner = await openOpsCoreReleaseCustody(options);
  assert.equal(owner.mode, "reconcile"); await owner.close();
});

test("lost immutable result acknowledgement retains exact result for explicit finish", async () => {
  const f = memory(), options = input(f), owner = await openOpsCoreReleaseCustody(options), result = complete();
  f.state.loseCreate = true;
  await rejected(owner.finish(result), "RELEASE_FINISH_UNCERTAIN");
  assert.equal(owner.signal.aborted, true); await rejected(owner.assertOwned(), "RELEASE_LEASE_LOST"); await owner.close();
  const again = await openOpsCoreReleaseCustody(options);
  assert.equal(again.mode, "reconcile"); assert.deepEqual(again.result, result);
  await again.finish(result); assert.equal(again.mode, "finished"); await again.close();
});

test("lost finish pointer acknowledgement reopens finished without replay", async () => {
  const f = memory(), options = input(f), owner = await openOpsCoreReleaseCustody(options), result = complete();
  f.state.loseWrite = true;
  await rejected(owner.finish(result), "RELEASE_FINISH_UNCERTAIN"); await owner.close();
  const again = await openOpsCoreReleaseCustody(options);
  assert.equal(again.mode, "finished"); assert.deepEqual(again.result, result); await again.close();
});

test("finished immutable result cannot be silently changed", async () => {
  const f = memory(), owner = await openOpsCoreReleaseCustody(input(f));
  await owner.finish(complete());
  await rejected(owner.finish({ ...complete(), outcome: "other" }), "RELEASE_RESULT_MISMATCH"); await owner.close();
});

test("missing prior completion evidence blocks a different release", async () => {
  const f = memory(), options = input(f), owner = await openOpsCoreReleaseCustody(options);
  await owner.finish(complete()); await owner.close();
  f.blobs.delete(`release-custody/ops/releases/${options.plan.releaseId}/result.json`);
  await rejected(openOpsCoreReleaseCustody(input(f)), "RELEASE_PREVIOUS_EVIDENCE_MISSING");
});

test("old release IDs cannot be reused after another release finishes", async () => {
  const f = memory(), options = input(f);
  for (const o of [options, input(f)]) {
    const owner = await openOpsCoreReleaseCustody(o); await owner.finish(complete()); await owner.close();
  }
  await rejected(openOpsCoreReleaseCustody(options), "RELEASE_ID_REUSED");
});

test("lease renewal loss aborts ownership and does not clear unfinished pointer", async () => {
  const f = memory(), options = { ...input(f), renewIntervalMs: 1 }, owner = await openOpsCoreReleaseCustody(options);
  f.state.failRenew = true; await sleep(15);
  assert.equal(owner.signal.aborted, true);
  await rejected(owner.finish(complete()), "RELEASE_LEASE_LOST");
  await owner.close(); f.state.failRenew = false;
  await rejected(openOpsCoreReleaseCustody(input(f)), "RELEASE_PRIOR_UNFINISHED");
});

test("ETag and pointer drift are detected before provider writes", async () => {
  const f = memory(), owner = await openOpsCoreReleaseCustody(input(f));
  f.blobs.get(owner.lockPath).etag = "foreign";
  await rejected(owner.assertOwned(), "RELEASE_POINTER_CHANGED"); assert.equal(owner.signal.aborted, true); await owner.close();
});

test("public container and invalid plan stop before release writes; errors stay redacted", async () => {
  const f = memory(); f.state.public = true;
  await rejected(openOpsCoreReleaseCustody(input(f)), "RELEASE_OPEN_UNCERTAIN"); assert.equal(f.blobs.size, 0);
  await rejected(openOpsCoreReleaseCustody({ ...input(f), plan: { releaseId: "invalid" } }), "RELEASE_PLAN_INVALID");
  await rejected(openOpsCoreReleaseCustody({ ...input(f), plan: { releaseId: randomUUID(), unsupported: undefined } }), "RELEASE_RECORD_INVALID");
});

test("existing provider operation recorder binds to release ownership and reconciles inherited intents", async () => {
  const f = memory(), options = input(f), records = new Map(); let effects = 0;
  const operationStore = { async assertPrivate() {}, async readOptional(key) { return records.get(key) ?? null; },
    async createOnly(key, text) { assert.equal(records.has(key), false); records.set(key, text); } };
  let owner = await openOpsCoreReleaseCustody(options);
  let recorder = await openProviderOperationRecorder({ custody: owner, store: operationStore, phase: "RELEASING", signal: owner.signal });
  const action = { kind: "release.web", input: { imageSha256: "e".repeat(64) }, async apply() { effects++; throw Error("lost acknowledgement"); },
    async verify() { return { complete: true, evidence: { readbackSha256: "f".repeat(64) } }; } };
  await assert.rejects(recorder.runRecordedOperation(action)); await owner.close();
  owner = await openOpsCoreReleaseCustody(options); assert.equal(owner.mode, "reconcile");
  recorder = await openProviderOperationRecorder({ custody: owner, store: operationStore, phase: "RELEASING", signal: owner.signal });
  assert.equal((await recorder.runRecordedOperation(action)).reconciled, true); assert.equal(effects, 1);
  await owner.finish(complete()); await owner.close();
});

test("SDK adapter refuses foreign paths and anonymous access", async () => {
  const adapter = azureOpsCoreReleaseStore({ getBlockBlobClient() { throw Error("should not get here"); },
    async getAccessPolicy() { return { blobPublicAccess: "blob" }; } });
  await rejected(adapter.assertPrivate(), "RELEASE_STORE_NOT_PRIVATE");
  await rejected(adapter.readOptional("cutover/owner.json"), "RELEASE_STORE_READ_UNCERTAIN");
});
