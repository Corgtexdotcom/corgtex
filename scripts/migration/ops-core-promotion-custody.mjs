import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { archiveEvidenceHash } from "./ops-core-archive.mjs";
import { postgresPromotionDurableRecord } from "./ops-core-postgres-promotion.mjs";

class PromotionCustodyError extends Error {}
const fail = code => { throw new PromotionCustodyError(code); };
const same = (left, right) => archiveEvidenceHash(left) === archiveEvidenceHash(right);
const LIMIT = 64 * 1024;

/** Actual independent-storage/local-cleanup-marker callbacks for database
 * promotion. The caller begins VERIFIED with the promotion intent hash, then
 * passes these callbacks to applyPostgresPromotion. The phase stays pending
 * until the controller has also verified objects, Redis and target bindings.
 * Fence callbacks may be throwing void assertions, true, or structured
 * affirmative receipts with complete:true. All other results are rejected.
 * Partial persistence is retained for explicit reconciliation, never replayed.
 */
export async function openPostgresPromotionCustody({ custody, store, stateFile, intent,
  assertSourceFenced, assertTargetInactive }) {
  let uncertain = false;
  let busy = false;
  let initial;
  let expected;
  const affirmative = value => value === undefined || value === true
    || (value !== null && typeof value === "object" && !Array.isArray(value) && value.complete === true);
  const snapshotCheck = () => {
    const current = custody.snapshot();
    if (current.domain !== intent.domain || current.intentSha256 !== initial.intentSha256
      || current.phase !== "RESTORED" || current.pending?.to !== "VERIFIED"
      || current.pending.operationId !== initial.pending.operationId
      || current.pending.intentSha256 !== intent.sha256 || current.destinationMayHaveWritten
      || !same(current, initial)) fail("PROMOTION_CUSTODY_BINDING_CHANGED");
  };
  const check = async () => {
    if (uncertain) fail("PROMOTION_CUSTODY_RECONCILIATION_REQUIRED");
    custody.signal.throwIfAborted();
    await custody.assertOwned();
    custody.signal.throwIfAborted();
    snapshotCheck();
    if (!affirmative(await assertSourceFenced())) fail("PROMOTION_FENCE_UNPROVEN");
    custody.signal.throwIfAborted(); snapshotCheck();
    if (!affirmative(await assertTargetInactive())) fail("PROMOTION_FENCE_UNPROVEN");
    custody.signal.throwIfAborted(); snapshotCheck();
    custody.signal.throwIfAborted();
    await custody.assertOwned();
    custody.signal.throwIfAborted();
    snapshotCheck();
  };
  const guarded = async action => {
    if (busy) fail("PROMOTION_CUSTODY_CONCURRENT");
    busy = true;
    try { await check(); const result = await action(); await check(); return result; }
    catch (error) {
      uncertain = true;
      throw error instanceof PromotionCustodyError ? error : new PromotionCustodyError("PROMOTION_CUSTODY_RECONCILIATION_REQUIRED");
    } finally { busy = false; }
  };
  try {
    expected = postgresPromotionDurableRecord(intent);
    initial = custody.snapshot();
    if (typeof stateFile !== "string" || !stateFile.startsWith("/")
      || typeof assertSourceFenced !== "function" || typeof assertTargetInactive !== "function"
      || initial.domain !== intent.domain || initial.phase !== "RESTORED"
      || initial.pending?.to !== "VERIFIED" || initial.pending.intentSha256 !== intent.sha256) fail("PROMOTION_CUSTODY_INTENT_INVALID");
    await check();
    await store.assertPrivate();
  } catch (error) {
    throw error instanceof PromotionCustodyError ? error : new PromotionCustodyError("PROMOTION_CUSTODY_INTENT_INVALID");
  }
  const prefix = `operations/${initial.domain}/${initial.intentSha256}/${initial.pending.operationId}/`;
  const original = { schemaVersion: "1.0.0", scratchName: intent.scratchName,
    targetRef: expected.cleanupState.targetRef, phase: "CREATED" };
  async function local(action) {
    const file = await open(stateFile, constants.O_RDWR | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) || stat.size > LIMIT) fail("PROMOTION_CLEANUP_MARKER_INVALID");
      const current = JSON.parse(await file.readFile("utf8"));
      return await action(file, current);
    } finally { await file.close(); }
  }
  async function readRemote(name) {
    await check();
    const text = await store.readOptional(`${prefix}${name}.json`, custody.signal);
    await check();
    if (text === null) return null;
    if (typeof text !== "string" || Buffer.byteLength(text) > LIMIT) fail("PROMOTION_CUSTODY_RECORD_INVALID");
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) fail("PROMOTION_CUSTODY_RECORD_INVALID");
    return value;
  }
  async function retain(name, value) {
    const existing = await readRemote(name);
    if (existing !== null) {
      if (!same(existing, value)) fail("PROMOTION_CUSTODY_RECORD_MISMATCH");
      return;
    }
    const text = JSON.stringify(value);
    if (Buffer.byteLength(text) > LIMIT) fail("PROMOTION_CUSTODY_RECORD_INVALID");
    await store.assertPrivate(); await check();
    await store.createOnly(`${prefix}${name}.json`, text, custody.signal);
    await check();
    if (!same(await readRemote(name), value)) fail("PROMOTION_CUSTODY_READBACK_MISMATCH");
  }
  async function readOperationIntent() {
    const record = await readRemote("promotion-intent");
    return local(async (_file, current) => {
      if (record === null) {
        if (!same(current, original)) fail("PROMOTION_CLEANUP_MARKER_UNOWNED");
        return null;
      }
      if (!same(record, expected) || !same(current, expected.cleanupState)) fail("PROMOTION_CUSTODY_PARTIAL_PERSISTENCE");
      return record;
    });
  }
  return {
    signal: custody.signal,
    lease: { assertHeld: () => guarded(async () => true) },
    assertTargetInactive: () => guarded(async () => true),
    readOperationIntent: () => guarded(readOperationIntent),
    persistOperationIntent: record => guarded(async () => {
      if (!same(record, expected)) fail("PROMOTION_CUSTODY_RECORD_MISMATCH");
      // Check the bound original before retaining intent, then inspect the same
      // opened inode again before replacing the cleanup authorization marker.
      await local(async (_file, current) => {
        if (!same(current, original)) fail("PROMOTION_CLEANUP_MARKER_UNOWNED");
      });
      await retain("promotion-intent", expected);
      await local(async (file, current) => {
        if (!same(current, original)) fail("PROMOTION_CLEANUP_MARKER_UNOWNED");
        await check();
        const text = `${JSON.stringify(expected.cleanupState)}\n`;
        await file.truncate(0);
        await file.write(text, 0, "utf8");
        await file.sync();
      });
      if (!same(await readOperationIntent(), expected)) fail("PROMOTION_CUSTODY_READBACK_MISMATCH");
    }),
    recordResult: result => guarded(async () => {
      if (result?.status !== "PROMOTED" || result.intentSha256 !== intent.sha256
        || result.scratchOid !== intent.scratchOid || result.targetIdentity !== intent.targetIdentity
        || result.connectionCount !== 0 || result.custodyVerified !== true || result.targetInactiveVerified !== true) {
        fail("PROMOTION_RESULT_UNPROVEN");
      }
      if (!same(await readOperationIntent(), expected)) fail("PROMOTION_CUSTODY_READBACK_MISMATCH");
      const record = { schemaVersion: 1, intentSha256: intent.sha256, scratchOid: intent.scratchOid,
        targetIdentity: intent.targetIdentity, status: "PROMOTED", connectionCount: 0 };
      await retain("promotion-receipt", record);
      return { record, sha256: archiveEvidenceHash(record) };
    }),
  };
}
