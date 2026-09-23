import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { archiveEvidenceHash } from "./ops-core-archive.mjs";
import { createCutoverJournal, openCutoverCustody } from "./ops-core-custody.mjs";
import { postgresPromotionDurableRecord } from "./ops-core-postgres-promotion.mjs";
import { openPostgresPromotionCustody } from "./ops-core-promotion-custody.mjs";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "ops-core-promotion-"));
  const stateFile = join(directory, "scratch-state.json");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const body = { schemaVersion: "1.0.0", operationId: randomUUID(), domain: "core",
    expectedConnection: { host: "target.local", port: 5432, database: "postgres", user: "target_admin" },
    scratchName: "corgtex_rehearsal_10_1_core", scratchOid: "16401", permanentName: "corgtex_core",
    targetIdentity: "target-fixture", parityEvidenceSha256: "a".repeat(64) };
  const intent = { ...body, sha256: archiveEvidenceHash(body) };
  const record = postgresPromotionDurableRecord(intent);
  const original = { schemaVersion: "1.0.0", scratchName: intent.scratchName, targetRef: record.cleanupState.targetRef, phase: "MIGRATION_RETAINED", scratchOid: intent.scratchOid };
  await writeFile(stateFile, JSON.stringify(original), { mode: 0o600 });
  let journal = JSON.stringify(createCutoverJournal({ domain: "core", intentSha256: "b".repeat(64), evidenceSha256: "c".repeat(64) }));
  let etag = 0;
  let lease;
  const blob = {
    async acquire() { assert.equal(lease, undefined); lease = randomUUID(); return lease; },
    async renew(value) { assert.equal(value, lease); },
    async release(value) { assert.equal(value, lease); lease = undefined; },
    async read() { return { text: journal, etag }; },
    async write(text, expected) { assert.equal(expected.etag, etag); journal = text; return { etag: ++etag }; },
  };
  let custody = await openCutoverCustody(blob, "b".repeat(64));
  t.after(() => custody.close());
  for (const phase of ["SOURCE_FENCED", "CAPTURED", "RESTORED"]) {
    const op = await custody.begin(phase, "d".repeat(64)); await custody.complete(op.operationId, "e".repeat(64));
  }
  await custody.begin("VERIFIED", intent.sha256);
  const values = new Map();
  let source = true;
  let target = true;
  const state = { beforeCreate: async () => {}, afterCreate: async () => {}, afterTargetCheck: async () => {} };
  const store = {
    async assertPrivate() {},
    async readOptional(key) { return values.get(key) ?? null; },
    async createOnly(key, text) {
      await state.beforeCreate(key, text); assert.equal(values.has(key), false); values.set(key, text); await state.afterCreate(key, text);
    },
  };
  const openAdapter = () => openPostgresPromotionCustody({ custody, store, stateFile, intent,
    assertSourceFenced: async () => source, assertTargetInactive: async () => { await state.afterTargetCheck(); return target; } });
  return { stateFile, original, record, intent, values, state, openAdapter,
    get custody() { return custody; },
    setSource(value) { source = value; }, setTarget(value) { target = value; },
    async reopen() { await custody.close(); custody = await openCutoverCustody(blob, "b".repeat(64)); return openAdapter(); },
    result: { status: "PROMOTED", intentSha256: intent.sha256, scratchOid: intent.scratchOid,
      targetIdentity: intent.targetIdentity, connectionCount: 0, custodyVerified: true, targetInactiveVerified: true },
  };
}

test("independent intent precedes marker, survives reopening and retains stable promotion receipt", async t => {
  const f = await fixture(t);
  f.state.beforeCreate = async key => {
    if (key.endsWith("promotion-intent.json")) assert.deepEqual(JSON.parse(await readFile(f.stateFile)), f.original);
  };
  const adapter = await f.openAdapter();
  assert.equal(await adapter.readOperationIntent(), null);
  await adapter.persistOperationIntent(f.record);
  assert.deepEqual(JSON.parse(await readFile(f.stateFile)), f.record.cleanupState);
  assert.deepEqual(await adapter.readOperationIntent(), f.record);
  const reopened = await f.reopen();
  assert.deepEqual(await reopened.readOperationIntent(), f.record);
  const first = await reopened.recordResult(f.result);
  assert.deepEqual(await reopened.recordResult({ ...f.result, renameAttempted: false }), first);
  assert.equal(f.values.size, 2);
  assert.equal(f.custody.snapshot().phase, "RESTORED", "promotion alone cannot complete all target verification");
});

test("lost independent intent acknowledgement leaves original marker and requires reconciliation", async t => {
  const f = await fixture(t);
  f.state.afterCreate = async () => { throw new Error("secret provider response"); };
  const adapter = await f.openAdapter();
  await assert.rejects(adapter.persistOperationIntent(f.record), /^Error: PROMOTION_CUSTODY_RECONCILIATION_REQUIRED$/);
  assert.deepEqual(JSON.parse(await readFile(f.stateFile)), f.original);
  f.state.afterCreate = async () => {};
  const reopened = await f.reopen();
  await assert.rejects(reopened.readOperationIntent(), /PROMOTION_CUSTODY_PARTIAL_PERSISTENCE/);
  assert.equal(f.values.size, 1);
});

test("lost receipt acknowledgement reopens with the same receipt and no overwrite", async t => {
  const f = await fixture(t);
  const adapter = await f.openAdapter(); await adapter.persistOperationIntent(f.record);
  f.state.afterCreate = async key => { if (key.endsWith("promotion-receipt.json")) throw new Error("lost acknowledgement"); };
  await assert.rejects(adapter.recordResult(f.result));
  f.state.afterCreate = async () => { assert.fail("must not write again"); };
  await (await f.reopen()).recordResult(f.result);
  assert.equal(f.values.size, 2);
});

test("changed cleanup target cannot acquire promotion authorization", async t => {
  const f = await fixture(t); const adapter = await f.openAdapter();
  await writeFile(f.stateFile, JSON.stringify({ ...f.original, scratchName: "unrelated" }), { mode: 0o600 });
  await assert.rejects(adapter.persistOperationIntent(f.record), /PROMOTION_CLEANUP_MARKER_UNOWNED/);
  assert.equal(f.values.size, 0);
});

test("symbolic cleanup marker is rejected before durable intent", async t => {
  const f = await fixture(t); const adapter = await f.openAdapter();
  const real = `${f.stateFile}.original`; await writeFile(real, JSON.stringify(f.original), { mode: 0o600 });
  await rm(f.stateFile); await symlink(real, f.stateFile);
  await assert.rejects(adapter.persistOperationIntent(f.record), /PROMOTION_CUSTODY_RECONCILIATION_REQUIRED/);
  assert.equal(f.values.size, 0);
});

test("source fence or target inactivity loss prevents marker and durable writes", async t => {
  for (const side of ["source", "target"]) {
    const f = await fixture(t); const adapter = await f.openAdapter();
    if (side === "source") f.setSource(false); else f.setTarget(false);
    await assert.rejects(adapter.persistOperationIntent(f.record), /PROMOTION_FENCE_UNPROVEN/);
    assert.equal(f.values.size, 0);
  }
});

test("an indeterminate promotion result cannot create an acceptance receipt", async t => {
  const f = await fixture(t); const adapter = await f.openAdapter(); await adapter.persistOperationIntent(f.record);
  await assert.rejects(adapter.recordResult({ ...f.result, status: "INDETERMINATE" }), /PROMOTION_RESULT_UNPROVEN/);
  assert.equal(f.values.size, 1);
});

test("structured incomplete or missing affirmative receipts cannot authorize promotion", async t => {
  for (const value of [{ complete: false }, {}, null, 0]) {
    for (const side of ["source", "target"]) {
      const f = await fixture(t);
      if (side === "source") f.setSource(value); else f.setTarget(value);
      await assert.rejects(f.openAdapter(), /PROMOTION_FENCE_UNPROVEN/);
      assert.equal(f.values.size, 0);
    }
  }
  const f = await fixture(t);
  f.setSource({ complete: true }); f.setTarget({ complete: true });
  assert.equal(await (await f.openAdapter()).lease.assertHeld(), true);
});

test("a callback crossing the write boundary cannot return stale final authorization", async t => {
  const f = await fixture(t); const adapter = await f.openAdapter();
  let count = 0;
  f.state.afterTargetCheck = async () => {
    if (++count !== 2) return;
    await f.custody.complete(f.custody.snapshot().pending.operationId, "e".repeat(64));
    const active = await f.custody.begin("TARGET_ACTIVATING", "f".repeat(64));
    await f.custody.complete(active.operationId, "e".repeat(64));
  };
  await assert.rejects(adapter.lease.assertHeld(), /PROMOTION_CUSTODY_BINDING_CHANGED/);
  assert.equal(f.custody.snapshot().destinationMayHaveWritten, true);
  assert.equal(f.values.size, 0);
});


test("legacy name-only cleanup marker and foreign scratch OID cannot authorize migration promotion", async t => {
  for (const change of [value=>{value.phase="CREATED";delete value.scratchOid;},value=>{value.scratchOid="16402";}]) {
    const f=await fixture(t), marker=structuredClone(f.original);change(marker);
    await writeFile(f.stateFile,JSON.stringify(marker),{mode:0o600});
    const adapter=await f.openAdapter();
    await assert.rejects(adapter.readOperationIntent(),/PROMOTION_CLEANUP_MARKER_UNOWNED/);
    assert.equal(f.values.size,0);
  }
});
