import { createHash, randomUUID } from "node:crypto";

// The journal lives outside Ops so taking its database offline cannot remove
// migration ownership or the record of an unacknowledged provider operation.
export const CUTOVER_PHASES = Object.freeze([
  "PREPARED", "SOURCE_FENCED", "CAPTURED", "RESTORED", "VERIFIED",
  "TARGET_ACTIVATING", "TARGET_ACTIVE", "ROUTED", "ACCEPTED",
]);
const HASH = /^[a-f0-9]{64}$/;
const fail = (code) => { throw new Error(code); };
const digest = (text) => createHash("sha256").update(text).digest("hex");

export function createCutoverJournal({ domain, intentSha256, evidenceSha256 }) {
  if (!["ops", "core"].includes(domain) || !HASH.test(intentSha256) || !HASH.test(evidenceSha256)) {
    fail("CUTOVER_INTENT_INVALID");
  }
  return {
    schemaVersion: 1, domain, intentSha256, phase: "PREPARED", sequence: 0,
    destinationMayHaveWritten: false, pending: null,
    history: [{ phase: "PREPARED", evidenceSha256 }],
  };
}

export function validateCutoverJournal(journal, intentSha256) {
  if (journal?.schemaVersion !== 1 || !["ops", "core"].includes(journal.domain)
    || !HASH.test(intentSha256) || journal.intentSha256 !== intentSha256
    || !CUTOVER_PHASES.includes(journal.phase) || !Number.isSafeInteger(journal.sequence)
    || journal.sequence < 0 || typeof journal.destinationMayHaveWritten !== "boolean"
    || !Array.isArray(journal.history) || journal.history.length !== CUTOVER_PHASES.indexOf(journal.phase) + 1
    || journal.history.some((entry, index) => entry.phase !== CUTOVER_PHASES[index] || !HASH.test(entry.evidenceSha256)
      || ((entry.operationId !== undefined || entry.intentSha256 !== undefined)
        && (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(entry.operationId) || !HASH.test(entry.intentSha256))))) {
    fail("CUTOVER_JOURNAL_INVALID");
  }
  if (CUTOVER_PHASES.indexOf(journal.phase) >= CUTOVER_PHASES.indexOf("TARGET_ACTIVATING")
    && !journal.destinationMayHaveWritten) fail("CUTOVER_WRITE_BOUNDARY_INVALID");
  if (journal.pending !== null) {
    const pending = journal.pending;
    if (!pending || pending.from !== journal.phase
      || pending.to !== CUTOVER_PHASES[CUTOVER_PHASES.indexOf(journal.phase) + 1]
      || !/^[a-f0-9-]{36}$/.test(pending.operationId)
      || !HASH.test(pending.intentSha256)) fail("CUTOVER_PENDING_INVALID");
    if (pending.to === "TARGET_ACTIVATING" && !journal.destinationMayHaveWritten) {
      fail("CUTOVER_WRITE_BOUNDARY_INVALID");
    }
  }
  if (journal.sequence !== 2 * CUTOVER_PHASES.indexOf(journal.phase) + (journal.pending ? 1 : 0)) {
    fail("CUTOVER_SEQUENCE_INVALID");
  }
  return journal;
}

export function sourceRecoveryAllowed(journal) {
  validateCutoverJournal(journal, journal.intentSha256);
  return !journal.destinationMayHaveWritten;
}

/**
 * blob supplies createOnly/read/write/acquire/renew/release. All reads/writes
 * while owned require the lease; writes also compare ETag. Provider errors are
 * deliberately not exposed because they can contain signed resource URLs.
 */
export async function openCutoverCustody(blob, intentSha256, { renewIntervalMs = 20_000 } = {}) {
  if (!Number.isSafeInteger(renewIntervalMs) || renewIntervalMs < 1 || renewIntervalMs > 20_000) {
    fail("CUTOVER_RENEW_INTERVAL_INVALID");
  }
  let lease;
  try { lease = await blob.acquire(60); } catch { fail("CUTOVER_ALREADY_OWNED_OR_UNAVAILABLE"); }
  const abort = new AbortController();
  let closed = false;
  let uncertain = false;
  let renewing = false;
  const requireOwner = () => {
    if (closed || abort.signal.aborted) fail("CUTOVER_LEASE_LOST");
    if (uncertain) fail("CUTOVER_RECONCILIATION_REQUIRED");
  };
  const timer = setInterval(async () => {
    if (closed || renewing) return;
    renewing = true;
    try { await blob.renew(lease); }
    catch { abort.abort(new Error("CUTOVER_LEASE_LOST")); }
    finally { renewing = false; }
  }, renewIntervalMs);
  timer.unref();
  let current;
  let busy = false;
  async function reload() {
    requireOwner();
    try {
      const read = await blob.read(lease);
      requireOwner();
      current = { ...read, journal: validateCutoverJournal(JSON.parse(read.text), intentSha256) };
      return structuredClone(current.journal);
    } catch {
      uncertain = true;
      fail("CUTOVER_READ_RECONCILE");
    }
  }
  async function write(journal) {
    requireOwner();
    const text = JSON.stringify(validateCutoverJournal(journal, intentSha256));
    try {
      const result = await blob.write(text, { lease, etag: current.etag });
      requireOwner();
      current = { text, etag: result.etag, journal };
    } catch {
      // The service may have committed even though acknowledgement was lost.
      // This owner cannot retry or advance on its stale in-memory snapshot.
      uncertain = true;
      fail("CUTOVER_WRITE_RECONCILE");
    }
  }
  async function exclusive(action) {
    requireOwner();
    if (busy) fail("CUTOVER_CONCURRENT_OPERATION");
    busy = true;
    try { return await action(); } finally { busy = false; }
  }
  async function close() {
    if (closed) return;
    closed = true;
    abort.abort(new Error("CUTOVER_CUSTODY_CLOSED"));
    clearInterval(timer);
    try { await blob.release(lease); } catch { fail("CUTOVER_LEASE_RELEASE_UNCERTAIN"); }
  }
  try { await reload(); } catch (error) {
    try { await close(); } catch { /* Preserve the primary read failure. */ }
    throw error;
  }
  return {
    signal: abort.signal,
    async assertOwned() {
      requireOwner();
      try { await blob.renew(lease); }
      catch {
        abort.abort(new Error("CUTOVER_LEASE_LOST"));
        fail("CUTOVER_LEASE_LOST");
      }
      requireOwner();
    },
    snapshot: () => { requireOwner(); return structuredClone(current.journal); },
    async begin(to, operationIntent) {
      return exclusive(async () => {
        const journal = await reload();
        if (journal.pending) fail("CUTOVER_PENDING_RECONCILIATION_REQUIRED");
        if (to !== CUTOVER_PHASES[CUTOVER_PHASES.indexOf(journal.phase) + 1]) fail("CUTOVER_PHASE_ORDER_INVALID");
        if (!HASH.test(operationIntent)) fail("CUTOVER_OPERATION_INTENT_INVALID");
        const pending = { operationId: randomUUID(), from: journal.phase, to, intentSha256: operationIntent };
        await write({ ...journal, sequence: journal.sequence + 1, pending,
          destinationMayHaveWritten: journal.destinationMayHaveWritten || to === "TARGET_ACTIVATING" });
        return structuredClone(pending);
      });
    },
    async complete(operationId, evidenceSha256) {
      return exclusive(async () => {
        const journal = await reload();
        if (!journal.pending || journal.pending.operationId !== operationId || !HASH.test(evidenceSha256)) {
          fail("CUTOVER_COMPLETION_MISMATCH");
        }
        // The caller must reconcile actual provider state before completing an
        // operation inherited from another owner. No provider action is replayed here.
        await write({ ...journal, phase: journal.pending.to, pending: null, sequence: journal.sequence + 1,
          history: [...journal.history, { phase: journal.pending.to, evidenceSha256,
            operationId: journal.pending.operationId, intentSha256: journal.pending.intentSha256 }] });
        return structuredClone(current.journal);
      });
    },
    close,
  };
}

export function azureBlobCustodyAdapter(blockBlobClient) {
  const leaseClients = new Map();
  return {
    async createOnly(journal) {
      const text = JSON.stringify(validateCutoverJournal(journal, journal.intentSha256));
      try {
        await blockBlobClient.upload(text, Buffer.byteLength(text), {
          conditions: { ifNoneMatch: "*" }, blobHTTPHeaders: { blobContentType: "application/json" },
        });
      } catch { fail("CUTOVER_CREATE_RECONCILE"); }
      return digest(text);
    },
    async acquire(seconds) {
      const client = blockBlobClient.getBlobLeaseClient();
      const result = await client.acquireLease(seconds);
      leaseClients.set(result.leaseId, client);
      return result.leaseId;
    },
    async renew(lease) { await leaseClients.get(lease).renewLease(); },
    async release(lease) {
      await leaseClients.get(lease).releaseLease();
      leaseClients.delete(lease);
    },
    async read(lease) {
      const result = await blockBlobClient.download(0, undefined, { conditions: { leaseId: lease } });
      if (!result.etag || !result.readableStreamBody || result.contentLength > 64 * 1024) fail("CUTOVER_BLOB_INVALID");
      const chunks = [];
      let bytes = 0;
      for await (const chunk of result.readableStreamBody) {
        bytes += chunk.length;
        if (bytes > 64 * 1024) fail("CUTOVER_BLOB_TOO_LARGE");
        chunks.push(Buffer.from(chunk));
      }
      return { text: Buffer.concat(chunks).toString("utf8"), etag: result.etag };
    },
    async write(text, { lease, etag }) {
      const result = await blockBlobClient.upload(text, Buffer.byteLength(text), {
        conditions: { leaseId: lease, ifMatch: etag }, blobHTTPHeaders: { blobContentType: "application/json" },
      });
      if (!result.etag) fail("CUTOVER_BLOB_ETAG_MISSING");
      return { etag: result.etag };
    },
  };
}
