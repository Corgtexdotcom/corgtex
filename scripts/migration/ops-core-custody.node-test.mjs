import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  CUTOVER_PHASES, createCutoverJournal, openCutoverCustody, sourceRecoveryAllowed,
} from "./ops-core-custody.mjs";

const intent = "a".repeat(64);
const evidence = "b".repeat(64);
function store() {
  let text = JSON.stringify(createCutoverJournal({ domain: "ops", intentSha256: intent, evidenceSha256: evidence }));
  let etag = 0;
  let lease = null;
  const api = {
    failAcknowledgement: false, failRenewal: false,
    get journal() { return JSON.parse(text); },
    async acquire() { assert.equal(lease, null); lease = crypto.randomUUID(); return lease; },
    async renew(value) { assert.equal(value, lease); if (api.failRenewal) throw Error("provider secret"); },
    async release(value) { assert.equal(value, lease); lease = null; },
    async read(value) { assert.equal(value, lease); return { text, etag }; },
    async write(next, conditions) {
      assert.equal(conditions.lease, lease);
      assert.equal(conditions.etag, etag);
      text = next;
      etag++;
      if (api.failAcknowledgement) throw Error("provider secret");
      return { etag };
    },
  };
  return api;
}

test("one cloud lease owns the journal and phases cannot skip the source fence", async () => {
  const blob = store();
  const owner = await openCutoverCustody(blob, intent);
  try {
    await assert.rejects(openCutoverCustody(blob, intent), /CUTOVER_ALREADY_OWNED_OR_UNAVAILABLE/);
    await assert.rejects(owner.begin("RESTORED", evidence), /CUTOVER_PHASE_ORDER_INVALID/);
    assert.equal(blob.journal.phase, "PREPARED");
    const operation = await owner.begin("SOURCE_FENCED", evidence);
    await assert.rejects(owner.begin("SOURCE_FENCED", evidence), /CUTOVER_PENDING_RECONCILIATION_REQUIRED/);
    await assert.rejects(owner.complete("wrong", evidence), /CUTOVER_COMPLETION_MISMATCH/);
    await owner.complete(operation.operationId, evidence);
    assert.equal(owner.snapshot().phase, "SOURCE_FENCED");
  } finally { await owner.close(); }
});

test("lost acknowledgement leaves a durable pending operation and forbids replay", async () => {
  const blob = store();
  const owner = await openCutoverCustody(blob, intent);
  blob.failAcknowledgement = true;
  await assert.rejects(owner.begin("SOURCE_FENCED", evidence), /CUTOVER_WRITE_RECONCILE/);
  assert.equal(blob.journal.pending.to, "SOURCE_FENCED");
  await assert.rejects(owner.complete(blob.journal.pending.operationId, evidence), /CUTOVER_RECONCILIATION_REQUIRED/);
  await owner.close();
  blob.failAcknowledgement = false;
  const recovery = await openCutoverCustody(blob, intent);
  try {
    await assert.rejects(recovery.begin("SOURCE_FENCED", evidence), /CUTOVER_PENDING_RECONCILIATION_REQUIRED/);
    // A recovery caller supplies evidence after reconciling the actual fence.
    await recovery.complete(recovery.snapshot().pending.operationId, evidence);
    assert.equal(recovery.snapshot().phase, "SOURCE_FENCED");
  } finally { await recovery.close(); }
});

test("destination-write boundary is persisted before activation and never cleared", async () => {
  const blob = store();
  const owner = await openCutoverCustody(blob, intent);
  try {
    for (const phase of CUTOVER_PHASES.slice(1)) {
      const before = owner.snapshot();
      const operation = await owner.begin(phase, evidence);
      if (phase === "TARGET_ACTIVATING") {
        assert.equal(sourceRecoveryAllowed(before), true);
        assert.equal(sourceRecoveryAllowed(blob.journal), false);
        assert.equal(blob.journal.phase, "VERIFIED");
      }
      await owner.complete(operation.operationId, evidence);
    }
    assert.equal(sourceRecoveryAllowed(owner.snapshot()), false);
    await assert.rejects(owner.begin("PREPARED", evidence), /CUTOVER_PHASE_ORDER_INVALID/);
  } finally { await owner.close(); }
});

test("lease loss aborts the provider signal and prevents subsequent writes", async () => {
  const blob = store();
  const owner = await openCutoverCustody(blob, intent, { renewIntervalMs: 5 });
  try {
    blob.failRenewal = true;
    await delay(25);
    assert.equal(owner.signal.aborted, true);
    await assert.rejects(owner.begin("SOURCE_FENCED", evidence), /CUTOVER_LEASE_LOST/);
    assert.equal(blob.journal.sequence, 0);
  } finally { await owner.close(); }
});

test("another source/target intent cannot open the existing journal", async () => {
  const blob = store();
  await assert.rejects(openCutoverCustody(blob, "c".repeat(64)), /CUTOVER_READ_RECONCILE/);
  // A failed initialization must release its lease.
  const owner = await openCutoverCustody(blob, intent);
  await owner.close();
});

test("concurrent operations by the same owner cannot race a shared ETag", async () => {
  const owner = await openCutoverCustody(store(), intent);
  try {
    const results = await Promise.allSettled([
      owner.begin("SOURCE_FENCED", evidence), owner.begin("SOURCE_FENCED", evidence),
    ]);
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    assert.match(results.find(result => result.status === "rejected").reason.message, /CUTOVER_CONCURRENT_OPERATION/);
  } finally { await owner.close(); }
});
