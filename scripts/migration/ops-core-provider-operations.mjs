import { createHash, randomUUID } from "node:crypto";

const HASH = /^[a-f0-9]{64}$/;
const LIMIT = 64 * 1024;
class OperationError extends Error {}
const fail = (code) => { throw new OperationError(code); };
export const providerOperationDiagnostic = (error) => error instanceof OperationError ? error.message : null;
function canonical(value, seen = new Set()) {
  if (value === null || typeof value === "boolean" || typeof value === "string"
    || (typeof value === "number" && Number.isFinite(value))) return JSON.stringify(value);
  if (!value || typeof value !== "object" || seen.has(value)
    || (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype)) fail("PROVIDER_RECORD_INVALID");
  seen.add(value);
  const result = Array.isArray(value) ? `[${value.map(item => canonical(item, seen)).join(",")}]`
    : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key], seen)}`).join(",")}}`;
  seen.delete(value);
  return result;
}
const hash = (value) => createHash("sha256").update(canonical(value)).digest("hex");
function encoded(value) {
  const text = canonical(value);
  if (Buffer.byteLength(text) > LIMIT) fail("PROVIDER_RECORD_TOO_LARGE");
  return text;
}

/** Each provider effect has an immutable intent before dispatch and a receipt
 * after readback. The cutover's independent Blob lease serializes all writers.
 * Input and provider response bodies are never stored: only their digests.
 * Reopening an inherited intent permits read-only reconciliation, never replay.
 */
export async function openProviderOperationRecorder({ custody, store, phase, signal }) {
  if (!custody || typeof custody.assertOwned !== "function" || typeof custody.snapshot !== "function"
    || !store || typeof store.assertPrivate !== "function" || !signal) fail("PROVIDER_CUSTODY_REQUIRED");
  let uncertain = false;
  let busy = false;
  const initial = custody.snapshot();
  if (!initial.pending || initial.pending.to !== phase || !HASH.test(initial.intentSha256)
    || !["ops", "core"].includes(initial.domain)) fail("PROVIDER_PHASE_INVALID");
  const binding = { domain: initial.domain, intentSha256: initial.intentSha256,
    phase, phaseOperationId: initial.pending.operationId };
  const prefix = `operations/${binding.domain}/${binding.intentSha256}/${binding.phaseOperationId}`;
  async function check() {
    if (uncertain) fail("PROVIDER_OWNER_RECONCILE_REQUIRED");
    signal.throwIfAborted();
    await custody.assertOwned();
    signal.throwIfAborted();
    const current = custody.snapshot();
    if (current.intentSha256 !== binding.intentSha256 || current.domain !== binding.domain
      || current.pending?.operationId !== binding.phaseOperationId || current.pending?.to !== phase) fail("PROVIDER_PHASE_CHANGED");
  }
  async function guarded(action) {
    if (busy) fail("PROVIDER_CONCURRENT_OPERATION");
    busy = true;
    try { await check(); return await action(); }
    catch (error) {
      uncertain = true;
      throw error instanceof OperationError ? error : new OperationError("PROVIDER_OPERATION_RECONCILE_REQUIRED");
    } finally { busy = false; }
  }
  function descriptor(kind, input) {
    if (typeof kind !== "string" || !/^[a-zA-Z][a-zA-Z0-9_.-]{0,95}$/.test(kind)) fail("PROVIDER_KIND_INVALID");
    const inputSha256 = hash(JSON.parse(encoded(input)));
    const operationKey = hash({ kind, inputSha256 });
    return { kind, inputSha256, operationKey };
  }
  async function read(key) {
    await check();
    const text = await store.readOptional(key, signal);
    await check();
    if (text === null) return null;
    if (typeof text !== "string" || Buffer.byteLength(text) > LIMIT) fail("PROVIDER_RECORD_INVALID");
    try {
      const record = JSON.parse(text);
      if (record === null || typeof record !== "object" || Array.isArray(record)) fail("PROVIDER_RECORD_INVALID");
      return record;
    } catch { fail("PROVIDER_RECORD_INVALID"); }
  }
  function validateIntent(record, desc) {
    if (record?.schemaVersion !== 1 || record.type !== "intent"
      || canonical(record.binding) !== canonical(binding) || record.kind !== desc.kind
      || record.inputSha256 !== desc.inputSha256 || record.operationKey !== desc.operationKey
      || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(record.operationId)) fail("PROVIDER_INTENT_MISMATCH");
    return record;
  }
  async function readOperation(desc) {
    const base = `${prefix}/${desc.operationKey}`;
    const intent = await read(`${base}/intent.json`);
    const receipt = await read(`${base}/receipt.json`);
    if (intent !== null) validateIntent(intent, desc);
    if (receipt !== null && (intent === null || receipt.schemaVersion !== 1 || receipt.type !== "receipt"
      || receipt.intentSha256 !== hash(intent) || receipt.operationId !== intent.operationId
      || !HASH.test(receipt.evidenceSha256))) fail("PROVIDER_RECEIPT_MISMATCH");
    return { intent, receipt };
  }
  async function writeOnce(key, record) {
    await check();
    await store.assertPrivate();
    await check();
    const text = encoded(record);
    await store.createOnly(key, text, signal);
    await check();
    // An acknowledged upload is insufficient if it did not retain our record.
    if (canonical(await read(key)) !== text) fail("PROVIDER_RECORD_READBACK_MISMATCH");
  }
  await guarded(async () => { await store.assertPrivate(); await check(); });
  return {
    async readStatus(kind, input) {
      return guarded(async () => structuredClone(await readOperation(descriptor(kind, input))));
    },
    async readIntent(kind, input) {
      return guarded(async () => {
        const desc = descriptor(kind, input);
        const record = await read(`${prefix}/${desc.operationKey}/intent.json`);
        return record === null ? null : structuredClone(validateIntent(record, desc));
      });
    },
    async runRecordedOperation({ kind, input, apply, verify }) {
      return guarded(async () => {
        if (typeof apply !== "function" || typeof verify !== "function") fail("PROVIDER_CALLBACK_REQUIRED");
        const desc = descriptor(kind, input);
        const base = `${prefix}/${desc.operationKey}`;
        let { intent, receipt } = await readOperation(desc);
        const inherited = intent !== null;
        if (!inherited) {
          intent = { schemaVersion: 1, type: "intent", binding, ...desc, operationId: randomUUID() };
          await writeOnce(`${base}/intent.json`, intent);
          await check();
          // Exactly one dispatch. A thrown/lost acknowledgement leaves intent
          // pending; another owner must inspect actual state, never retry here.
          await apply();
          await check();
        }
        const result = await verify();
        await check();
        if (result?.complete !== true || result.evidence === undefined) {
          fail(receipt ? "PROVIDER_COMPLETED_STATE_DRIFT" : "PROVIDER_PENDING_RECONCILIATION_REQUIRED");
        }
        const evidence = JSON.parse(encoded(result.evidence));
        if (!receipt) await writeOnce(`${base}/receipt.json`, { schemaVersion: 1, type: "receipt",
          operationId: intent.operationId, intentSha256: hash(intent), evidenceSha256: hash(evidence) });
        return { operationId: intent.operationId, reconciled: inherited, evidence };
      });
    },
  };
}

/** SDK transport for a private container outside the migrating Ops runtime.
 * No upload retry: callers retain uncertain intent and reconcile explicitly.
 */
export function azureProviderOperationStore(containerClient) {
  const PREFIX = /^operations\/(ops|core)\/[a-f0-9]{64}\/[a-f0-9-]{36}\/$/;
  const keyClient = (key) => {
    if (typeof key !== "string" || !/^operations\/(ops|core)\/[a-f0-9]{64}\/[a-f0-9-]{36}\/(?:[a-f0-9]{64}\/(intent|receipt|descriptor)|phase-plan|phase-evidence-[a-f0-9]{64}|promotion-intent|promotion-receipt)\.json$/.test(key)) fail("PROVIDER_RECORD_KEY_INVALID");
    return containerClient.getBlockBlobClient(key);
  };
  return {
    async listRecords(prefix, signal) {
      if (!PREFIX.test(prefix)) fail("PROVIDER_RECORD_KEY_INVALID");
      const names = [];
      for await (const blob of containerClient.listBlobsFlat({ prefix, abortSignal: signal })) {
        signal.throwIfAborted();
        if (names.length >= 15_002) fail("PROVIDER_RECORD_LIST_LIMIT");
        keyClient(blob.name); names.push(blob.name);
      }
      return names.sort();
    },
    async listDescriptors(prefix, signal) {
      if (!PREFIX.test(prefix)) fail("PROVIDER_RECORD_KEY_INVALID");
      const names = [];
      let count = 0;
      for await (const blob of containerClient.listBlobsFlat({ prefix, abortSignal: signal })) {
        signal.throwIfAborted();
        if (++count > 15_002) fail("PROVIDER_RECORD_LIST_LIMIT");
        if (blob.name.endsWith("/descriptor.json")) { keyClient(blob.name); names.push(blob.name); }
      }
      return names.sort();
    },
    async assertPrivate() {
      const properties = await containerClient.getAccessPolicy();
      if (properties.blobPublicAccess) fail("PROVIDER_STORE_NOT_PRIVATE");
    },
    async readOptional(key, signal) {
      const limit = /\/phase-evidence-[a-f0-9]{64}\.json$/.test(key) ? 32 * 1024 * 1024 : LIMIT;
      let result;
      try { result = await keyClient(key).download(0, undefined, { abortSignal: signal }); }
      catch (error) {
        if (error?.statusCode === 404 && error?.code === "BlobNotFound") return null;
        throw new OperationError("PROVIDER_STORE_READ_FAILED");
      }
      if (!result.readableStreamBody || result.contentLength > limit) fail("PROVIDER_RECORD_INVALID");
      const chunks = [];
      let bytes = 0;
      for await (const chunk of result.readableStreamBody) {
        signal.throwIfAborted();
        bytes += chunk.length;
        if (bytes > limit) { result.readableStreamBody.destroy(); fail("PROVIDER_RECORD_TOO_LARGE"); }
        chunks.push(Buffer.from(chunk));
      }
      return Buffer.concat(chunks).toString("utf8");
    },
    async createOnly(key, text, signal) {
      const limit = /\/phase-evidence-[a-f0-9]{64}\.json$/.test(key) ? 32 * 1024 * 1024 : LIMIT;
      if (typeof text !== "string" || Buffer.byteLength(text) > limit) fail("PROVIDER_RECORD_INVALID");
      await keyClient(key).upload(text, Buffer.byteLength(text), { abortSignal: signal,
        conditions: { ifNoneMatch: "*" }, blobHTTPHeaders: { blobContentType: "application/json" } });
    },
  };
}
