import { createHash } from "node:crypto";
import { hashCanonical } from "./shared-tenant-export";
import { copyReferencedObjects, ObjectTransferError } from "./shared-tenant-objects";
import type { ObjectReference, ObjectStore } from "./shared-tenant-objects";
import type { RailwayInventoryEntry, RailwayInventoryLimits } from "./railway-object-source";

interface InventorySource extends ObjectStore {
  inventory(limits: RailwayInventoryLimits): Promise<RailwayInventoryEntry[]>;
}

interface SnapshotEntry extends ObjectReference { sourceEtag: string }

export interface OpsCoreObjectSnapshot {
  formatVersion: 1;
  sourceStoreId: string;
  databaseSnapshotSha256: string;
  sourceFenceSha256: string;
  objects: SnapshotEntry[];
  sha256: string;
}

export interface OpsCoreObjectOptions {
  limits: RailwayInventoryLimits & { maxObjectBytes: number };
  /** Must read actual writer/custody state; a saved receipt alone is insufficient. */
  assertSourceFenced(): Promise<void>;
}

const HASH = /^[a-f0-9]{64}$/;
function check(value: unknown, code: string): asserts value {
  if (!value) throw new ObjectTransferError(code);
}

function optionsCopy(options: OpsCoreObjectOptions): OpsCoreObjectOptions {
  const limits = { ...options.limits };
  check(typeof options.assertSourceFenced === "function", "SOURCE_FENCE_REQUIRED");
  check(Number.isSafeInteger(limits.maxObjectBytes) && limits.maxObjectBytes > 0
    && Number.isSafeInteger(limits.maxObjects) && limits.maxObjects >= 0 && limits.maxObjects <= 10_000,
  "INVALID_SNAPSHOT_LIMITS");
  const assertSourceFenced = options.assertSourceFenced.bind(options);
  return { limits, assertSourceFenced };
}

function inventoryIdentity(entries: RailwayInventoryEntry[]) {
  return entries.map((entry) => ({ key: entry.key, etag: entry.etag, bytes: entry.bytes,
    contentType: entry.contentType ?? null })).sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}

async function checkInventory(source: InventorySource, objects: SnapshotEntry[], options: OpsCoreObjectOptions) {
  await options.assertSourceFenced();
  const current = inventoryIdentity(await source.inventory(options.limits));
  const expected = inventoryIdentity(objects.map((entry) => ({ key: entry.sourceKey, etag: entry.sourceEtag,
    bytes: entry.bytes, contentType: entry.contentType, metadata: {} })));
  check(hashCanonical(current) === hashCanonical(expected), "SOURCE_INVENTORY_CHANGED");
}

/** Hashes every retained object after the full database capture while writers are
 * fenced. Object names remain private evidence; never emit this manifest in logs.
 */
export async function captureOpsCoreObjects(source: InventorySource,
  binding: { databaseSnapshotSha256: string; sourceFenceSha256: string },
  suppliedOptions: OpsCoreObjectOptions): Promise<OpsCoreObjectSnapshot> {
  const options = optionsCopy(suppliedOptions);
  const { databaseSnapshotSha256, sourceFenceSha256 } = binding;
  check(HASH.test(databaseSnapshotSha256) && HASH.test(sourceFenceSha256), "INVALID_SNAPSHOT_BINDING");
  try {
    await options.assertSourceFenced();
    const inventory = await source.inventory(options.limits);
    const objects: SnapshotEntry[] = [];
    for (const entry of inventory) {
      check(entry.bytes <= options.limits.maxObjectBytes, "OBJECT_BUDGET_EXCEEDED");
      await options.assertSourceFenced();
      const object = await source.read(entry.key, entry.etag);
      check(object, "OBJECT_NOT_FOUND");
      const iterator = object.body[Symbol.asyncIterator]();
      let complete = false;
      try {
        check(object.etag === entry.etag && object.bytes === entry.bytes
          && object.contentType === entry.contentType, "SOURCE_INVENTORY_CHANGED");
        const hash = createHash("sha256");
        let bytes = 0;
        while (true) {
          const next = await iterator.next();
          if (next.done) break;
          check(next.value instanceof Uint8Array && next.value.byteLength <= entry.bytes - bytes, "OBJECT_SIZE_EXCEEDED");
          bytes += next.value.byteLength;
          hash.update(next.value);
        }
        check(bytes === entry.bytes, "OBJECT_SIZE_MISMATCH");
        objects.push({ sourceKey: entry.key, targetKey: entry.key, sourceEtag: entry.etag,
          bytes, sha256: hash.digest("hex"), ...(entry.contentType ? { contentType: entry.contentType } : {}) });
        complete = true;
      } finally {
        if (!complete) await iterator.return?.();
      }
    }
    await checkInventory(source, objects, options);
    await options.assertSourceFenced();
    const snapshot = { formatVersion: 1 as const, sourceStoreId: source.identity,
      databaseSnapshotSha256, sourceFenceSha256, objects };
    return { ...snapshot, sha256: hashCanonical(snapshot) };
  } catch (error) {
    if (error instanceof ObjectTransferError) throw error;
    throw new ObjectTransferError("OBJECT_SNAPSHOT_FAILED");
  }
}

/** Reuses create-only copy/readback and its receipt protocol. Captured ETags are
 * required for each source read; a changed source is never silently re-snapshotted.
 */
export async function copyOpsCoreObjects(source: InventorySource, target: ObjectStore,
  suppliedSnapshot: OpsCoreObjectSnapshot, transferId: string, suppliedOptions: OpsCoreObjectOptions) {
  const options = optionsCopy(suppliedOptions);
  const snapshot = structuredClone(suppliedSnapshot);
  const { sha256, ...body } = snapshot;
  check(snapshot.formatVersion === 1 && HASH.test(sha256) && hashCanonical(body) === sha256
    && HASH.test(snapshot.databaseSnapshotSha256) && HASH.test(snapshot.sourceFenceSha256), "INVALID_OBJECT_SNAPSHOT");
  check(snapshot.sourceStoreId === source.identity, "SOURCE_BINDING_MISMATCH");
  check(Array.isArray(snapshot.objects) && snapshot.objects.length <= options.limits.maxObjects,
    "INVENTORY_OBJECT_LIMIT");
  const entries = new Map(snapshot.objects.map((entry) => [entry.sourceKey, entry]));
  check(entries.size === snapshot.objects.length
    && snapshot.objects.every((entry) => entry.sourceKey === entry.targetKey
      && typeof entry.sourceEtag === "string" && entry.sourceEtag.length > 0), "INVALID_OBJECT_SNAPSHOT");
  try {
    await checkInventory(source, snapshot.objects, options);
    const boundSource: ObjectStore = {
      identity: source.identity,
      assertPrivate: () => source.assertPrivate(),
      head: (key) => source.head(key),
      async read(key) {
        await options.assertSourceFenced();
        const entry = entries.get(key);
        check(entry, "SOURCE_OBJECT_NOT_CAPTURED");
        return source.read(key, entry.sourceEtag);
      },
      createOnly: () => { throw new ObjectTransferError("SOURCE_WRITES_FORBIDDEN"); },
      removeIfMatch: () => { throw new ObjectTransferError("SOURCE_WRITES_FORBIDDEN"); },
    };
    const boundTarget: ObjectStore = {
      identity: target.identity,
      assertPrivate: () => target.assertPrivate(),
      head: (key) => target.head(key),
      read: (key, ifMatch) => target.read(key, ifMatch),
      async createOnly(key, bytes, metadata, contentType) {
        await options.assertSourceFenced();
        return target.createOnly(key, bytes, metadata, contentType);
      },
      removeIfMatch: () => { throw new ObjectTransferError("OBJECT_REMOVAL_FORBIDDEN"); },
    };
    const receipt = await copyReferencedObjects(boundSource, boundTarget, {
      transferId, sourceSnapshotSha256: snapshot.sha256,
      objects: snapshot.objects.map(({ sourceEtag: _sourceEtag, ...reference }) => reference),
      limits: { maxObjectBytes: options.limits.maxObjectBytes, maxTotalBytes: options.limits.maxTotalBytes },
    });
    await checkInventory(source, snapshot.objects, options);
    await options.assertSourceFenced();
    return receipt;
  } catch (error) {
    if (error instanceof ObjectTransferError) throw error;
    throw new ObjectTransferError("OBJECT_SNAPSHOT_COPY_FAILED");
  }
}
