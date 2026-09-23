import { createHash, randomUUID } from "node:crypto";

const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const LIMIT = 256 * 1024;
class ReleaseCustodyError extends Error {}
const fail = code => { throw new ReleaseCustodyError(code); };
export const opsCoreReleaseCustodyDiagnostic = error => error instanceof ReleaseCustodyError ? error.message : null;
function canonical(value, seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean"
    || typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (!value || typeof value !== "object" || seen.has(value)
    || !Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) fail("RELEASE_RECORD_INVALID");
  seen.add(value);
  const text = Array.isArray(value) ? `[${value.map(item => canonical(item, seen)).join(",")}]`
    : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key], seen)}`).join(",")}}`;
  seen.delete(value); return text;
}
function encoded(value) {
  const text = canonical(value);
  if (Buffer.byteLength(text) > LIMIT) fail("RELEASE_RECORD_TOO_LARGE");
  return text;
}
const sha = text => createHash("sha256").update(text).digest("hex");
const hash = value => sha(encoded(value));
function parsed(text) {
  if (typeof text !== "string" || Buffer.byteLength(text) > LIMIT) fail("RELEASE_RECORD_INVALID");
  try { const result = JSON.parse(text); encoded(result); return result; }
  catch { fail("RELEASE_RECORD_INVALID"); }
}
const exact = (value, fields) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).sort().join() === fields.split(",").sort().join();

/** Actual Azure SDK adapter. All writes are conditional; a lost acknowledgement
 * is returned as uncertainty, never converted into permission to retry a write.
 * Prefer a ContainerClient configured with retryOptions.maxTries=1. This adapter
 * receives a credentialed client, never prints credentials, and creates no RG,
 * account or container. Production callers supply the independent custody store.
 */
export function azureOpsCoreReleaseStore(container) {
  if (!container || typeof container.getBlockBlobClient !== "function" || typeof container.getAccessPolicy !== "function") {
    fail("RELEASE_STORE_INVALID");
  }
  const path = /^(?:release-custody\/(ops|core)\/owner\.json|release-custody\/(ops|core)\/releases\/[a-f0-9-]{36}\/(?:plan|result)\.json)$/;
  const client = key => {
    if (typeof key !== "string" || !path.test(key)) fail("RELEASE_STORE_KEY_INVALID");
    return container.getBlockBlobClient(key);
  };
  const leases = new Map();
  async function readOptional(key, signal, leaseId) {
    let response;
    try { response = await client(key).download(0, undefined, { abortSignal: signal,
      ...(leaseId ? { conditions: { leaseId } } : {}) }); }
    catch (error) {
      if (error?.statusCode === 404 && error?.code === "BlobNotFound") return null;
      fail("RELEASE_STORE_READ_UNCERTAIN");
    }
    if (!response.etag || !response.readableStreamBody || response.contentLength > LIMIT) fail("RELEASE_STORE_RESPONSE_INVALID");
    const chunks = []; let bytes = 0;
    for await (const chunk of response.readableStreamBody) {
      signal?.throwIfAborted(); bytes += chunk.length;
      if (bytes > LIMIT) fail("RELEASE_RECORD_TOO_LARGE"); chunks.push(Buffer.from(chunk));
    }
    return { text: Buffer.concat(chunks).toString("utf8"), etag: response.etag };
  }
  return {
    async assertPrivate(signal) {
      const result = await container.getAccessPolicy({ abortSignal: signal });
      if (result.blobPublicAccess) fail("RELEASE_STORE_NOT_PRIVATE");
    },
    readOptional,
    async createOnly(key, text, signal) {
      await client(key).upload(text, Buffer.byteLength(text), { abortSignal: signal,
        conditions: { ifNoneMatch: "*" }, blobHTTPHeaders: { blobContentType: "application/json" } });
    },
    async ensureLock(key, text, signal) {
      try { await this.createOnly(key, text, signal); }
      catch (error) {
        // Only explicit conditional conflict means another initializer won.
        if (!([409, 412].includes(error?.statusCode)
          && ["BlobAlreadyExists", "ConditionNotMet"].includes(error?.code))) fail("RELEASE_LOCK_INITIALIZATION_UNCERTAIN");
      }
    },
    async acquire(key, seconds, signal) {
      const leaseId = randomUUID();
      const lease = client(key).getBlobLeaseClient(leaseId);
      await lease.acquireLease(seconds, { abortSignal: signal });
      leases.set(leaseId, lease); return leaseId;
    },
    async renew(leaseId, signal) { await leases.get(leaseId).renewLease({ abortSignal: signal }); },
    async release(leaseId) {
      const lease = leases.get(leaseId);
      if (!lease) fail("RELEASE_LEASE_UNKNOWN");
      await lease.releaseLease(); leases.delete(leaseId);
    },
    async write(key, text, { leaseId, etag, signal }) {
      const result = await client(key).upload(text, Buffer.byteLength(text), { abortSignal: signal,
        conditions: { leaseId, ifMatch: etag }, blobHTTPHeaders: { blobContentType: "application/json" } });
      if (!result.etag) fail("RELEASE_STORE_ETAG_MISSING");
      return { etag: result.etag };
    },
  };
}

/** One stable lease per domain, independent of the accepted cutover journal.
 * The immutable target hash lives inside owner.json; changing the hash cannot
 * select a different lock and bypass an unfinished owner. Plans/results must be
 * password-free caller projections. Custody contains no runtime apply/replay.
 * mode=reconcile grants no automatic apply/replay authority. This is a caller
 * policy signal: explicit recovery may append distinct recorded effects after
 * reconciling outstanding intents and retaining its recovery decision. Custody
 * keeps the same lease/unfinished release throughout; it does not execute or
 * authorize recovery itself. Fresh provider evidence is required before finish.
 */
export async function openOpsCoreReleaseCustody({ container, store: suppliedStore, domain, targetBindingSha256, plan: suppliedPlan,
  renewIntervalMs = 20_000, signal: callerSignal } = {}) {
  if (!["ops", "core"].includes(domain) || !HASH.test(targetBindingSha256)
    || !Number.isSafeInteger(renewIntervalMs) || renewIntervalMs < 1 || renewIntervalMs > 20_000
    || callerSignal !== undefined && !(callerSignal instanceof AbortSignal)) fail("RELEASE_CUSTODY_INPUT_INVALID");
  const planText = encoded(suppliedPlan), plan = parsed(planText), planSha256 = sha(planText);
  if (!plan || !UUID.test(plan.releaseId)) fail("RELEASE_PLAN_INVALID");
  const store = suppliedStore ?? azureOpsCoreReleaseStore(container);
  for (const method of ["assertPrivate", "readOptional", "createOnly", "ensureLock", "acquire", "renew", "release", "write"]) {
    if (typeof store?.[method] !== "function") fail("RELEASE_STORE_INVALID");
  }
  const lockPath = `release-custody/${domain}/owner.json`;
  const releasePath = `release-custody/${domain}/releases/${plan.releaseId}`;
  const binding = { schemaVersion: 1, domain, targetBindingSha256 };
  const expectedPlan = { ...binding, releaseId: plan.releaseId, planSha256, plan };
  const controller = new AbortController();
  const signal = callerSignal ? AbortSignal.any([callerSignal, controller.signal]) : controller.signal;
  let leaseId, timer, closed = false, uncertain = false, renewing = false, busy = false;
  let pointer, etag, mode, retainedResult = null;
  const requireOwner = () => {
    if (closed || signal.aborted) fail("RELEASE_LEASE_LOST");
    if (uncertain) fail("RELEASE_RECONCILIATION_REQUIRED");
  };
  function pointerValue(value) {
    if (!exact(value, "schemaVersion,domain,targetBindingSha256,sequence,current") || value.schemaVersion !== 1
      || value.domain !== domain || value.targetBindingSha256 !== targetBindingSha256
      || !Number.isSafeInteger(value.sequence) || value.sequence < 0) fail("RELEASE_OWNER_BINDING_MISMATCH");
    const c = value.current;
    if (c !== null && (!exact(c, "releaseId,planSha256,status,resultSha256") || !UUID.test(c.releaseId)
      || !HASH.test(c.planSha256) || !["unfinished", "finished"].includes(c.status)
      || c.status === "unfinished" && c.resultSha256 !== null || c.status === "finished" && !HASH.test(c.resultSha256))) {
      fail("RELEASE_POINTER_INVALID");
    }
    return value;
  }
  async function read(key, leased = false) {
    requireOwner();
    const result = await store.readOptional(key, signal, leased ? leaseId : undefined);
    requireOwner();
    if (result !== null && (!exact(result, "text,etag") || typeof result.etag !== "string" || !result.etag)) fail("RELEASE_STORE_RESPONSE_INVALID");
    return result;
  }
  async function renew() {
    requireOwner(); await store.renew(leaseId, signal); requireOwner();
  }
  async function assertOwned() {
    try {
      await renew();
      const observed = await read(lockPath, true);
      if (!observed || observed.etag !== etag || encoded(pointerValue(parsed(observed.text))) !== encoded(pointer)) {
        fail("RELEASE_POINTER_CHANGED");
      }
    } catch (error) {
      uncertain = true; controller.abort();
      throw error instanceof ReleaseCustodyError ? error : new ReleaseCustodyError("RELEASE_LEASE_LOST");
    }
  }
  async function retain(key, expected) {
    const text = encoded(expected);
    const existing = await read(key);
    if (existing !== null) {
      if (encoded(parsed(existing.text)) !== text) fail("RELEASE_IMMUTABLE_RECORD_MISMATCH");
      return;
    }
    await assertOwned(); await store.assertPrivate(signal); requireOwner();
    await store.createOnly(key, text, signal); requireOwner();
    const observed = await read(key);
    if (!observed || encoded(parsed(observed.text)) !== text) fail("RELEASE_IMMUTABLE_READBACK_FAILED");
  }
  async function writePointer(next) {
    await assertOwned(); await store.assertPrivate(signal); requireOwner();
    const text = encoded(pointerValue(next));
    const written = await store.write(lockPath, text, { leaseId, etag, signal }); requireOwner();
    const observed = await read(lockPath, true);
    if (!observed || !written?.etag || observed.etag !== written.etag || encoded(parsed(observed.text)) !== text) {
      fail("RELEASE_POINTER_WRITE_UNCERTAIN");
    }
    pointer = next; etag = observed.etag;
  }
  async function close() {
    if (closed) return;
    closed = true; clearInterval(timer); controller.abort();
    if (leaseId) {
      try { await store.release(leaseId); } catch { fail("RELEASE_LEASE_RELEASE_UNCERTAIN"); }
    }
  }
  async function loadResult(required = true) {
    const record = await read(`${releasePath}/result.json`);
    if (!record) { if (required) fail("RELEASE_RESULT_MISSING"); return; }
    const result = parsed(record.text);
    if (!exact(result, "schemaVersion,domain,targetBindingSha256,releaseId,planSha256,resultSha256,result")
      || result.schemaVersion !== 1 || result.domain !== domain || result.targetBindingSha256 !== targetBindingSha256
      || result.releaseId !== plan.releaseId || result.planSha256 !== planSha256 || result.result?.complete !== true
      || hash(result.result) !== result.resultSha256
      || required && pointer.current.resultSha256 !== result.resultSha256) fail("RELEASE_RESULT_MISMATCH");
    retainedResult = result;
  }
  async function assertPreviousFinished(current) {
    const prefix = `release-custody/${domain}/releases/${current.releaseId}`;
    const p = await read(`${prefix}/plan.json`), r = await read(`${prefix}/result.json`);
    if (!p || !r) fail("RELEASE_PREVIOUS_EVIDENCE_MISSING");
    const priorPlan = parsed(p.text), priorResult = parsed(r.text);
    if (!exact(priorPlan, "schemaVersion,domain,targetBindingSha256,releaseId,planSha256,plan")
      || !exact(priorResult, "schemaVersion,domain,targetBindingSha256,releaseId,planSha256,resultSha256,result")
      || [priorPlan, priorResult].some(record => record.schemaVersion !== 1 || record.domain !== domain
        || record.targetBindingSha256 !== targetBindingSha256 || record.releaseId !== current.releaseId
        || record.planSha256 !== current.planSha256)
      || priorPlan.plan?.releaseId !== current.releaseId || hash(priorPlan.plan) !== current.planSha256
      || priorResult.result?.complete !== true || hash(priorResult.result) !== current.resultSha256
      || priorResult.resultSha256 !== current.resultSha256) fail("RELEASE_PREVIOUS_EVIDENCE_MISMATCH");
  }
  try {
    signal.throwIfAborted(); await store.assertPrivate(signal); signal.throwIfAborted();
    await store.ensureLock(lockPath, encoded({ ...binding, sequence: 0, current: null }), signal);
    signal.throwIfAborted(); leaseId = await store.acquire(lockPath, 60, signal); requireOwner();
    const initial = await read(lockPath, true);
    if (!initial) fail("RELEASE_POINTER_MISSING");
    pointer = pointerValue(parsed(initial.text)); etag = initial.etag;
    timer = setInterval(async () => {
      if (closed || uncertain || renewing) return;
      renewing = true;
      try { await renew(); }
      catch { uncertain = true; controller.abort(); }
      finally { renewing = false; }
    }, renewIntervalMs);
    timer.unref();
    const current = pointer.current;
    if (current?.releaseId === plan.releaseId) {
      if (current.planSha256 !== planSha256) fail("RELEASE_PLAN_MISMATCH");
      mode = current.status === "finished" ? "finished" : "reconcile";
      const record = await read(`${releasePath}/plan.json`);
      if (mode === "finished" && !record) fail("RELEASE_PLAN_MISSING");
      // A crash after pending pointer publication but before plan retention
      // cannot be bypassed; reconstruct only this exact caller-bound plan.
      await retain(`${releasePath}/plan.json`, expectedPlan);
      await loadResult(mode === "finished");
    } else {
      if (current?.status === "unfinished") fail("RELEASE_PRIOR_UNFINISHED");
      if (current) await assertPreviousFinished(current);
      if (await read(`${releasePath}/plan.json`) || await read(`${releasePath}/result.json`)) fail("RELEASE_ID_REUSED");
      mode = "apply";
      // Publish pending ownership FIRST so loss before immutable plan creation
      // still prevents a different release from bypassing this unfinished one.
      await writePointer({ ...pointer, sequence: pointer.sequence + 1, current: {
        releaseId: plan.releaseId, planSha256, status: "unfinished", resultSha256: null } });
      await retain(`${releasePath}/plan.json`, expectedPlan);
    }
    await assertOwned();
  } catch (error) {
    uncertain = true;
    try { await close(); } catch { /* Preserve the initiating safe error. */ }
    throw error instanceof ReleaseCustodyError ? error : new ReleaseCustodyError("RELEASE_OPEN_UNCERTAIN");
  }
  return Object.freeze({ signal, planSha256, releaseId: plan.releaseId, lockPath,
    get mode() { requireOwner(); return mode; },
    get result() { requireOwner(); return retainedResult ? structuredClone(retainedResult.result) : null; },
    snapshot() {
      requireOwner();
      return { domain, targetBindingSha256, intentSha256: planSha256, phase: mode === "finished" ? "RELEASE_FINISHED" : "RELEASE_PREPARED",
        pending: mode === "finished" ? null : { to: "RELEASING", operationId: plan.releaseId },
        releaseId: plan.releaseId, mode, sequence: pointer.sequence, resultSha256: pointer.current.resultSha256 };
    },
    assertOwned,
    async finish(result) {
      requireOwner();
      if (busy) fail("RELEASE_CONCURRENT_OPERATION"); busy = true;
      try {
        const copy = parsed(encoded(result));
        if (!copy || typeof copy !== "object" || Array.isArray(copy) || copy.complete !== true) fail("RELEASE_RESULT_INVALID");
        const resultSha256 = hash(copy), record = { ...binding, releaseId: plan.releaseId, planSha256, resultSha256, result: copy };
        await assertOwned();
        if (mode === "finished") {
          if (encoded(record) !== encoded(retainedResult)) fail("RELEASE_RESULT_MISMATCH");
        } else {
          await retain(`${releasePath}/result.json`, record);
          // Only a read-back immutable result permits publishing completion.
          await writePointer({ ...pointer, sequence: pointer.sequence + 1,
            current: { ...pointer.current, status: "finished", resultSha256 } });
          retainedResult = record; mode = "finished";
        }
        return { complete: true, releaseId: plan.releaseId, planSha256, resultSha256, result: structuredClone(copy) };
      } catch (error) {
        uncertain = true; controller.abort();
        throw error instanceof ReleaseCustodyError ? error : new ReleaseCustodyError("RELEASE_FINISH_UNCERTAIN");
      } finally { busy = false; }
    },
    close,
  });
}
