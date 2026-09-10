import { createHash } from "node:crypto";
import type { ContainerClient } from "@azure/storage-blob";
import { hashCanonical } from "./shared-tenant-export";

export interface ObjectReference {
  sourceKey: string;
  targetKey: string;
  sha256: string;
  bytes: number;
  contentType?: string;
}

export interface ObjectSnapshotReferences {
  sourceSnapshotSha256: string;
  objects: readonly ObjectReference[];
}

export interface ObjectCopyManifest extends ObjectSnapshotReferences {
  transferId: string;
  limits: { maxObjectBytes: number; maxTotalBytes: number };
}

export interface ObjectReconciliationManifest extends ObjectSnapshotReferences {
  formatVersion: 1;
  transferId: string;
  sourceStoreId: string;
  targetStoreId: string;
  // Binds the final reference set to the exact preceding copy and snapshot.
  previousReceiptSha256: string;
  sha256: string;
}

export interface ObjectHead {
  etag: string;
  bytes: number;
  contentType?: string;
  metadata: Record<string, string>;
}

export interface ObjectStore {
  // Opaque stable identity of the exact container, never its URL or credentials.
  readonly identity: string;
  assertPrivate(): Promise<void>;
  head(key: string): Promise<ObjectHead | null>;
  read(key: string, ifMatch?: string): Promise<(ObjectHead & { body: AsyncIterable<Uint8Array> }) | null>;
  createOnly(key: string, bytes: Buffer, metadata: Record<string, string>, contentType?: string): Promise<boolean>;
  removeIfMatch(key: string, etag: string): Promise<boolean>;
}

export interface ObjectReceiptEntry extends ObjectReference {
  ownership: "created" | "linked";
  etag: string;
}

export interface ObjectCopyReceipt {
  formatVersion: 1;
  transferId: string;
  sourceSnapshotSha256: string;
  sourceStoreId: string;
  targetStoreId: string;
  entries: ObjectReceiptEntry[];
  sha256: string;
}

export class ObjectTransferError extends Error {
  constructor(readonly code: string) {
    // Never attach provider errors: they may contain signed URLs or credentials.
    super(`Object transfer failed: ${code}.`);
    this.name = "ObjectTransferError";
  }
}

const SHA256 = /^[a-f0-9]{64}$/;
const IDENTIFIER = /^[a-zA-Z0-9_-]{1,128}$/;
const identifier = (value: unknown): value is string => typeof value === "string" && IDENTIFIER.test(value);

function requireValue(condition: unknown, code: string): asserts condition {
  if (!condition) throw new ObjectTransferError(code);
}

function validContentType(value: unknown) {
  return typeof value === "string" && value.length <= 256
    && /^[\w!#$&^.+-]+\/[\w!#$&^.+-]+(?:\s*;[^\r\n]*)?$/.test(value) && !value.includes("://");
}

function validEtag(value: unknown) {
  return typeof value === "string" && value.length > 0 && value.length <= 256
    && !/[\x00-\x1f\x7f?#]/.test(value) && !value.includes("://");
}

function validateReferences(snapshot: ObjectSnapshotReferences) {
  requireValue(SHA256.test(snapshot.sourceSnapshotSha256), "INVALID_SNAPSHOT_HASH");
  requireValue(Array.isArray(snapshot.objects) && snapshot.objects.length <= 10_000, "INVALID_OBJECT_COUNT");
  const targets = new Set<string>();
  for (const entry of snapshot.objects) {
    requireValue(entry && typeof entry === "object", "INVALID_OBJECT_REFERENCE");
    for (const key of [entry.sourceKey, entry.targetKey]) {
      requireValue(typeof key === "string" && key.length > 0 && key.length <= 1024
        && !/[\x00-\x1f\x7f?#]/.test(key) && !key.includes("://"), "INVALID_OBJECT_KEY");
    }
    requireValue(!targets.has(entry.targetKey), "DUPLICATE_TARGET_KEY");
    targets.add(entry.targetKey);
    requireValue(SHA256.test(entry.sha256), "INVALID_OBJECT_HASH");
    requireValue(Number.isSafeInteger(entry.bytes) && entry.bytes >= 0, "INVALID_OBJECT_BYTES");
    requireValue(entry.contentType === undefined || validContentType(entry.contentType), "INVALID_CONTENT_TYPE");
  }
}

/** Validates the durable record only; copy's readback proves provider contents. */
export function validateObjectReceipt(value: unknown, manifest?: ObjectCopyManifest): ObjectCopyReceipt {
  requireValue(value && typeof value === "object" && !Array.isArray(value), "INVALID_RECEIPT");
  const receipt = value as ObjectCopyReceipt;
  requireValue(receipt.formatVersion === 1 && identifier(receipt.transferId), "INVALID_RECEIPT");
  requireValue(Object.keys(receipt).every((key) => ["formatVersion", "transferId", "sourceSnapshotSha256", "sourceStoreId", "targetStoreId", "entries", "sha256"].includes(key)), "INVALID_RECEIPT_FIELDS");
  requireValue(identifier(receipt.sourceStoreId) && identifier(receipt.targetStoreId)
    && receipt.sourceStoreId !== receipt.targetStoreId, "INVALID_STORE_IDENTITY");
  validateReferences({ sourceSnapshotSha256: receipt.sourceSnapshotSha256, objects: receipt.entries });
  for (const entry of receipt.entries) {
    requireValue(Object.keys(entry).every((key) => ["sourceKey", "targetKey", "sha256", "bytes", "contentType", "ownership", "etag"].includes(key)), "INVALID_RECEIPT_FIELDS");
    requireValue((entry.ownership === "created" || entry.ownership === "linked")
      && validEtag(entry.etag), "INVALID_RECEIPT_ENTRY");
  }
  const { sha256, ...body } = receipt;
  requireValue(SHA256.test(sha256) && hashCanonical(body) === sha256, "RECEIPT_DIGEST_MISMATCH");
  if (manifest) {
    validateReferences(manifest);
    requireValue(receipt.transferId === manifest.transferId && receipt.sourceSnapshotSha256 === manifest.sourceSnapshotSha256
      && receipt.entries.length === manifest.objects.length, "RECEIPT_MANIFEST_MISMATCH");
    const entries = new Map(receipt.entries.map((entry) => [entry.targetKey, entry]));
    for (const reference of manifest.objects) {
      const entry = entries.get(reference.targetKey);
      requireValue(entry && entry.sourceKey === reference.sourceKey && entry.sha256 === reference.sha256
        && entry.bytes === reference.bytes && (!reference.contentType || entry.contentType === reference.contentType), "RECEIPT_MANIFEST_MISMATCH");
    }
  }
  return receipt;
}

function ownershipMetadata(transferId: string, snapshot: string, sha256: string) {
  return { transferid: transferId, sourcesnapshot: snapshot, sha256 };
}

function metadataMatches(actual: Record<string, string>, expected: Record<string, string>) {
  return Object.entries(expected).every(([key, value]) => actual[key] === value);
}

async function verifiedBytes(store: ObjectStore, key: string, reference: ObjectReference, maxBytes: number, retain = true) {
  const object = await store.read(key);
  requireValue(object, "OBJECT_NOT_FOUND");
  const iterator = object.body[Symbol.asyncIterator]();
  const chunks: Buffer[] = [];
  const hash = createHash("sha256");
  let bytes = 0;
  let complete = false;
  try {
    requireValue(validEtag(object.etag) && object.bytes === reference.bytes, "OBJECT_SIZE_MISMATCH");
    requireValue(object.contentType === undefined || validContentType(object.contentType), "INVALID_CONTENT_TYPE");
    requireValue(!reference.contentType || object.contentType === reference.contentType, "OBJECT_CONTENT_TYPE_MISMATCH");
    while (true) {
      const next = await iterator.next();
      if (next.done) break;
      const chunk = next.value;
      requireValue(chunk instanceof Uint8Array, "INVALID_OBJECT_STREAM");
      requireValue(chunk.byteLength <= Math.min(maxBytes, reference.bytes) - bytes, "OBJECT_SIZE_EXCEEDED");
      bytes += chunk.byteLength;
      hash.update(chunk);
      if (retain) chunks.push(Buffer.from(chunk));
    }
    requireValue(bytes === reference.bytes && hash.digest("hex") === reference.sha256, "OBJECT_DIGEST_MISMATCH");
    complete = true;
    return { head: object, bytes: retain ? Buffer.concat(chunks, bytes) : Buffer.alloc(0) };
  } finally {
    if (!complete) await iterator.return?.();
  }
}

/** Copies only final snapshot references. Caller must durably save the receipt. */
export async function copyReferencedObjects(source: ObjectStore, target: ObjectStore, manifest: ObjectCopyManifest): Promise<ObjectCopyReceipt> {
  try {
    manifest = structuredClone(manifest);
    validateReferences(manifest);
    requireValue(identifier(manifest.transferId), "INVALID_TRANSFER_ID");
    requireValue(identifier(source.identity) && identifier(target.identity)
      && source.identity !== target.identity, "DISTINCT_STORES_REQUIRED");
    const { maxObjectBytes, maxTotalBytes } = manifest.limits;
    requireValue(Number.isSafeInteger(maxObjectBytes) && maxObjectBytes > 0
      && Number.isSafeInteger(maxTotalBytes) && maxTotalBytes > 0, "INVALID_BYTE_LIMIT");
    let total = 0;
    for (const entry of manifest.objects) {
      requireValue(entry.bytes <= maxObjectBytes && entry.bytes <= maxTotalBytes - total, "OBJECT_BUDGET_EXCEEDED");
      total += entry.bytes;
    }
    await source.assertPrivate();
    await target.assertPrivate();
    const objects: ObjectReceiptEntry[] = [];
    for (const entry of manifest.objects) {
      const original = await verifiedBytes(source, entry.sourceKey, entry, maxObjectBytes);
      const contentType = entry.contentType ?? original.head.contentType;
      const reference: ObjectReference = { sourceKey: entry.sourceKey, targetKey: entry.targetKey,
        sha256: entry.sha256, bytes: entry.bytes, ...(contentType ? { contentType } : {}) };
      const metadata = ownershipMetadata(manifest.transferId, manifest.sourceSnapshotSha256, entry.sha256);
      // The store must enforce an atomic create-only condition, including races.
      const created = await target.createOnly(entry.targetKey, original.bytes, metadata, reference.contentType);
      const copied = await verifiedBytes(target, entry.targetKey, reference, maxObjectBytes, false);
      const owns = metadataMatches(copied.head.metadata, metadata);
      requireValue(!created || owns, "TARGET_OWNERSHIP_CHANGED");
      objects.push({ ...reference, ownership: owns ? "created" : "linked", etag: copied.head.etag });
    }
    // Policy checks are observations, not a lock against unrelated ACL writers.
    await source.assertPrivate();
    await target.assertPrivate();
    const receipt = { formatVersion: 1 as const, transferId: manifest.transferId, sourceSnapshotSha256: manifest.sourceSnapshotSha256,
      sourceStoreId: source.identity, targetStoreId: target.identity, entries: objects };
    return { ...receipt, sha256: hashCanonical(receipt) };
  } catch (error) {
    if (error instanceof ObjectTransferError) throw error;
    throw new ObjectTransferError("COPY_FAILED");
  }
}

/** A renamed/deleted reference is stale only when no final reference uses its key. */
export function reconcileStalePrecopies(previousReceipt: ObjectCopyReceipt, finalRefs: ObjectReconciliationManifest): ObjectReceiptEntry[] {
  validateObjectReceipt(previousReceipt);
  validateReferences(finalRefs);
  requireValue(finalRefs.formatVersion === 1 && Object.keys(finalRefs).every((key) =>
    ["formatVersion", "transferId", "sourceStoreId", "targetStoreId", "previousReceiptSha256", "sourceSnapshotSha256", "objects", "sha256"].includes(key)), "INVALID_FINAL_MANIFEST");
  const { sha256, ...body } = finalRefs;
  requireValue(SHA256.test(sha256) && hashCanonical(body) === sha256, "FINAL_MANIFEST_DIGEST_MISMATCH");
  requireValue(finalRefs.transferId === previousReceipt.transferId
    && finalRefs.sourceStoreId === previousReceipt.sourceStoreId && finalRefs.targetStoreId === previousReceipt.targetStoreId
    && finalRefs.previousReceiptSha256 === previousReceipt.sha256, "FINAL_MANIFEST_LINEAGE_MISMATCH");
  const referenced = new Set(finalRefs.objects.map((entry) => entry.targetKey));
  return previousReceipt.entries.filter((entry) => entry.ownership === "created" && !referenced.has(entry.targetKey))
    .map((entry) => ({ ...entry }));
}

/** Separate explicit mutation; never called by copy or reconciliation. */
export async function removeStaleOwnedObjects(target: ObjectStore, previousReceipt: ObjectCopyReceipt, finalRefs: ObjectReconciliationManifest) {
  try {
    previousReceipt = structuredClone(previousReceipt);
    finalRefs = structuredClone(finalRefs);
    const stale = reconcileStalePrecopies(previousReceipt, finalRefs);
    requireValue(target.identity === previousReceipt.targetStoreId, "TARGET_IDENTITY_MISMATCH");
    await target.assertPrivate();
    const removed: { targetKey: string; etag: string }[] = [];
    const alreadyAbsent: string[] = [];
    for (const entry of stale) {
      const head = await target.head(entry.targetKey);
      if (!head) { alreadyAbsent.push(entry.targetKey); continue; }
      requireValue(head.etag === entry.etag, "STALE_OBJECT_CHANGED");
      requireValue(head.bytes === entry.bytes && metadataMatches(head.metadata,
        ownershipMetadata(previousReceipt.transferId, previousReceipt.sourceSnapshotSha256, entry.sha256)), "STALE_OBJECT_NOT_OWNED");
      // The ETag condition also fences changes after the ownership read.
      if (await target.removeIfMatch(entry.targetKey, entry.etag)) removed.push({ targetKey: entry.targetKey, etag: entry.etag });
      else alreadyAbsent.push(entry.targetKey);
    }
    return { formatVersion: 1 as const, transferId: previousReceipt.transferId,
      previousSourceSnapshotSha256: previousReceipt.sourceSnapshotSha256, finalSourceSnapshotSha256: finalRefs.sourceSnapshotSha256,
      targetStoreId: target.identity, removed, alreadyAbsent };
  } catch (error) {
    if (error instanceof ObjectTransferError) throw error;
    throw new ObjectTransferError("STALE_REMOVAL_FAILED");
  }
}

function azureError(error: unknown, status: number, codes: string[]) {
  if (!error || typeof error !== "object") return false;
  const value = error as { statusCode?: unknown; code?: unknown };
  return value.statusCode === status && typeof value.code === "string" && codes.includes(value.code);
}

/** Construct source and target with their own explicitly authenticated clients. */
export class AzureBlobObjectStore implements ObjectStore {
  readonly identity: string;
  readonly #container: ContainerClient;

  constructor(container: ContainerClient) {
    this.#container = container;
    try {
      const location = new URL(container.url);
      requireValue(location.protocol === "https:", "HTTPS_CONTAINER_REQUIRED");
      this.identity = createHash("sha256").update(`${location.origin}${location.pathname.replace(/\/+$/, "")}`).digest("hex");
    } catch (error) {
      if (error instanceof ObjectTransferError) throw error;
      throw new ObjectTransferError("INVALID_CONTAINER_CLIENT");
    }
  }

  async assertPrivate() {
    try {
      const policy = await this.#container.getAccessPolicy();
      requireValue(policy.blobPublicAccess === undefined, "PUBLIC_CONTAINER_FORBIDDEN");
    } catch (error) {
      if (error instanceof ObjectTransferError) throw error;
      throw new ObjectTransferError("CONTAINER_PRIVACY_UNPROVEN");
    }
  }

  async head(key: string): Promise<ObjectHead | null> {
    try {
      const result = await this.#container.getBlobClient(key).getProperties();
      requireValue(result.etag && Number.isSafeInteger(result.contentLength), "INVALID_OBJECT_HEADERS");
      return { etag: result.etag, bytes: result.contentLength!, metadata: result.metadata ?? {}, contentType: result.contentType };
    } catch (error) {
      if (azureError(error, 404, ["BlobNotFound"])) return null;
      if (error instanceof ObjectTransferError) throw error;
      throw new ObjectTransferError("OBJECT_HEAD_FAILED");
    }
  }

  async read(key: string, ifMatch?: string): Promise<(ObjectHead & { body: AsyncIterable<Uint8Array> }) | null> {
    try {
      const result = await this.#container.getBlobClient(key).download(0, undefined, { conditions: ifMatch ? { ifMatch } : undefined });
      requireValue(result.etag && Number.isSafeInteger(result.contentLength) && result.readableStreamBody, "INVALID_OBJECT_HEADERS");
      return { etag: result.etag, bytes: result.contentLength!, metadata: result.metadata ?? {}, contentType: result.contentType,
        body: result.readableStreamBody as unknown as AsyncIterable<Uint8Array> };
    } catch (error) {
      if (azureError(error, 404, ["BlobNotFound"])) return null;
      if (error instanceof ObjectTransferError) throw error;
      throw new ObjectTransferError("OBJECT_READ_FAILED");
    }
  }

  async createOnly(key: string, bytes: Buffer, metadata: Record<string, string>, contentType?: string) {
    try {
      await this.#container.getBlockBlobClient(key).uploadData(bytes, {
        conditions: { ifNoneMatch: "*" }, metadata, blobHTTPHeaders: { blobContentType: contentType }, concurrency: 1,
      });
      return true;
    } catch (error) {
      if (azureError(error, 409, ["BlobAlreadyExists"]) || azureError(error, 412, ["ConditionNotMet"])) return false;
      throw new ObjectTransferError("OBJECT_CREATE_FAILED");
    }
  }

  async removeIfMatch(key: string, etag: string) {
    try {
      return (await this.#container.getBlobClient(key).deleteIfExists({ conditions: { ifMatch: etag } })).succeeded;
    } catch {
      throw new ObjectTransferError("OBJECT_CONDITIONAL_DELETE_FAILED");
    }
  }
}
