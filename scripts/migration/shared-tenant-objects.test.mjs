import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  AzureBlobObjectStore, ObjectTransferError, copyReferencedObjects, reconcileStalePrecopies,
  removeStaleOwnedObjects, validateObjectReceipt,
} from "./shared-tenant-objects.ts";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const snapshot = sha("synthetic snapshot");

class MemoryStore {
  constructor(identity) { this.identity = identity; }
  objects = new Map();
  isPrivate = true;
  generation = 0;
  createCalls = 0;
  deleteCalls = 0;
  onCreate;
  onDelete;
  readOverride;
  put(key, data, metadata = {}, contentType = "text/plain") {
    const object = { bytes: Buffer.byteLength(data), data: Buffer.from(data), metadata: { ...metadata }, contentType,
      etag: `"version-${++this.generation}"` };
    this.objects.set(key, object);
    return object;
  }
  async assertPrivate() {
    if (!this.isPrivate) throw new ObjectTransferError("PUBLIC_CONTAINER_FORBIDDEN");
  }
  async head(key) {
    const object = this.objects.get(key);
    if (!object) return null;
    const { data, ...head } = object;
    return structuredClone(head);
  }
  async read(key, ifMatch) {
    const object = this.objects.get(key);
    if (!object) return null;
    if (ifMatch && ifMatch !== object.etag) throw new Error("ETag mismatch");
    if (this.readOverride) return this.readOverride(object);
    const head = await this.head(key);
    const data = Buffer.from(object.data);
    return { ...head, body: (async function* () {
      for (let offset = 0; offset < data.length; offset += 2) yield data.subarray(offset, offset + 2);
    })() };
  }
  async createOnly(key, bytes, metadata, contentType) {
    this.createCalls++;
    if (this.objects.has(key)) return false;
    const object = this.put(key, bytes, metadata, contentType);
    await this.onCreate?.(key, object);
    return true;
  }
  async removeIfMatch(key, etag) {
    this.deleteCalls++;
    await this.onDelete?.(key);
    const object = this.objects.get(key);
    if (!object) return false;
    if (object.etag !== etag) throw new Error("ETag mismatch");
    this.objects.delete(key);
    return true;
  }
}

function manifest(objects, overrides = {}) {
  return { transferId: "synthetic-transfer", sourceSnapshotSha256: snapshot,
    objects, limits: { maxObjectBytes: 1024, maxTotalBytes: 4096 }, ...overrides };
}
function reference(sourceKey, data, targetKey = `import/${sourceKey}`) {
  return { sourceKey, targetKey, sha256: sha(data), bytes: Buffer.byteLength(data), contentType: "text/plain" };
}
function fixture(data = "synthetic content") {
  const source = new MemoryStore("source");
  const target = new MemoryStore("target");
  source.put("document", data);
  return { source, target, input: manifest([reference("document", data)]) };
}

describe("snapshot-referenced object copy", () => {
  it("copies streamed bytes, verifies readback and returns a JSON-stable bound receipt", async () => {
    const { source, target, input } = fixture();
    source.put("unreferenced", "must stay behind");
    const receipt = await copyReferencedObjects(source, target, input);
    expect(target.objects.size).toBe(1);
    expect(target.objects.get("import/document").data).toEqual(source.objects.get("document").data);
    expect(target.objects.get("import/document").metadata).toEqual({ transferid: input.transferId, sourcesnapshot: snapshot, sha256: input.objects[0].sha256 });
    expect(receipt.entries).toEqual([{ ...input.objects[0], ownership: "created", etag: '"version-1"' }]);
    expect(validateObjectReceipt(JSON.parse(JSON.stringify(receipt)), input)).toEqual(receipt);
    expect(receipt.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(target.deleteCalls).toBe(0);
  });

  it("recognizes creation after interruption before acknowledgement and never overwrites it on retry", async () => {
    const { source, target, input } = fixture();
    target.onCreate = () => { throw new Error("interrupted at https://private.invalid/?sig=secret"); };
    await expect(copyReferencedObjects(source, target, input)).rejects.toMatchObject({ code: "COPY_FAILED" });
    expect(target.objects.size).toBe(1);
    const initialEtag = target.objects.get("import/document").etag;
    target.onCreate = undefined;
    const receipt = await copyReferencedObjects(source, target, input);
    expect(receipt.entries[0]).toMatchObject({ ownership: "created", etag: initialEtag });
    expect(target.generation).toBe(1);
  });

  it("links matching existing shared content without claiming ownership", async () => {
    const { source, target, input } = fixture();
    target.put("import/document", "synthetic content", { existing: "another-tenant" });
    const receipt = await copyReferencedObjects(source, target, input);
    expect(receipt.entries[0].ownership).toBe("linked");
    expect(target.generation).toBe(1);
    const finalRefs = { sourceSnapshotSha256: sha("final"), objects: [] };
    expect(reconcileStalePrecopies(receipt, finalRefs)).toEqual([]);
    expect((await removeStaleOwnedObjects(target, receipt, finalRefs)).removed).toEqual([]);
    expect(target.objects.has("import/document")).toBe(true);
  });

  it("does not claim another transfer's matching object", async () => {
    const { source, target, input } = fixture();
    target.put("import/document", "synthetic content", { transferid: "other", sourcesnapshot: snapshot, sha256: input.objects[0].sha256 });
    expect((await copyReferencedObjects(source, target, input)).entries[0].ownership).toBe("linked");
  });

  it("rejects a target key collision without replacing the object", async () => {
    const { source, target, input } = fixture("abc");
    const existing = target.put("import/document", "xyz");
    await expect(copyReferencedObjects(source, target, input)).rejects.toMatchObject({ code: "OBJECT_DIGEST_MISMATCH" });
    expect(target.objects.get("import/document")).toEqual(existing);
    expect(target.generation).toBe(1);
  });

  it("rejects source digest mismatch before any target mutation", async () => {
    const { source, target, input } = fixture("abc");
    source.put("document", "xyz");
    await expect(copyReferencedObjects(source, target, input)).rejects.toMatchObject({ code: "OBJECT_DIGEST_MISMATCH" });
    expect(target.createCalls).toBe(0);
  });

  it("detects failed readback even when ownership metadata looks correct", async () => {
    const { source, target, input } = fixture("abc");
    target.onCreate = (_key, object) => { object.data = Buffer.from("xyz"); };
    await expect(copyReferencedObjects(source, target, input)).rejects.toMatchObject({ code: "OBJECT_DIGEST_MISMATCH" });
  });

  it.each(["source", "target"])("rejects public %s containers before copy", async (store) => {
    const f = fixture();
    f[store].isPrivate = false;
    await expect(copyReferencedObjects(f.source, f.target, f.input)).rejects.toMatchObject({ code: "PUBLIC_CONTAINER_FORBIDDEN" });
    expect(f.target.createCalls).toBe(0);
  });

  it("rechecks privacy after readback", async () => {
    const { source, target, input } = fixture();
    target.onCreate = () => { target.isPrivate = false; };
    await expect(copyReferencedObjects(source, target, input)).rejects.toMatchObject({ code: "PUBLIC_CONTAINER_FORBIDDEN" });
  });

  it("bounds declared per-object and total bytes before any mutation", async () => {
    const { source, target, input } = fixture("1234");
    await expect(copyReferencedObjects(source, target, { ...input, limits: { maxObjectBytes: 3, maxTotalBytes: 20 } })).rejects.toMatchObject({ code: "OBJECT_BUDGET_EXCEEDED" });
    const entries = [input.objects[0], { ...input.objects[0], targetKey: "second" }];
    await expect(copyReferencedObjects(source, target, { ...input, objects: entries, limits: { maxObjectBytes: 4, maxTotalBytes: 7 } })).rejects.toMatchObject({ code: "OBJECT_BUDGET_EXCEEDED" });
    expect(target.createCalls).toBe(0);
  });

  it("bounds actual streams despite false headers and closes the iterator on rejection", async () => {
    const { source, target, input } = fixture("abc");
    let closed = false;
    source.readOverride = (object) => ({ ...object, bytes: 3, body: {
      [Symbol.asyncIterator]() { return {
        next: async () => ({ done: false, value: Buffer.from("oversized") }),
        return: async () => { closed = true; return { done: true }; },
      }; },
    } });
    await expect(copyReferencedObjects(source, target, input)).rejects.toMatchObject({ code: "OBJECT_SIZE_EXCEEDED" });
    expect(closed).toBe(true);
    expect(target.createCalls).toBe(0);
  });

  it("supports verified empty objects and an empty reference receipt", async () => {
    const { source, target, input } = fixture("");
    expect((await copyReferencedObjects(source, target, input)).entries[0].bytes).toBe(0);
    const empty = manifest([]);
    expect(validateObjectReceipt(await copyReferencedObjects(source, target, empty), empty).entries).toEqual([]);
  });

  it("freezes the supplied manifest across asynchronous copy work", async () => {
    const { source, target, input } = fixture();
    source.assertPrivate = async () => { input.sourceSnapshotSha256 = sha("changed"); input.objects[0].targetKey = "changed-key"; };
    const receipt = await copyReferencedObjects(source, target, input);
    expect(receipt.sourceSnapshotSha256).toBe(snapshot);
    expect(receipt.entries[0].targetKey).toBe("import/document");
  });

  it("rejects URL keys and emits no signed URL in an error", async () => {
    const { source, target, input } = fixture();
    input.objects[0].sourceKey = "https://private.invalid/document?sig=secret";
    const error = await copyReferencedObjects(source, target, input).catch((value) => value);
    expect(error.code).toBe("INVALID_OBJECT_KEY");
    expect(JSON.stringify(error)).not.toContain("secret");
    expect(error.message).not.toContain("https:");
  });

  it("rejects modified receipts and mismatched final snapshot closure", async () => {
    const { source, target, input } = fixture();
    const receipt = await copyReferencedObjects(source, target, input);
    const tampered = structuredClone(receipt);
    tampered.entries[0].ownership = "linked";
    expect(() => validateObjectReceipt(tampered)).toThrow("RECEIPT_DIGEST_MISMATCH");
    expect(() => validateObjectReceipt(receipt, { ...input, sourceSnapshotSha256: sha("other") })).toThrow("RECEIPT_MANIFEST_MISMATCH");
    expect(() => validateObjectReceipt(receipt, { ...input, objects: [] })).toThrow("RECEIPT_MANIFEST_MISMATCH");
  });
});

describe("explicit stale precopy removal", () => {
  it("uses final references for deletes and renames and preserves shared or still-referenced objects", async () => {
    const source = new MemoryStore("source");
    const target = new MemoryStore("target");
    for (const key of ["keep", "rename", "delete", "shared"]) source.put(key, key);
    target.put("import/shared", "shared");
    const original = manifest(["keep", "rename", "delete", "shared"].map((key) => reference(key, key)));
    const prior = await copyReferencedObjects(source, target, original);
    const finalRefs = manifest([reference("keep", "keep"), reference("rename", "rename", "import/renamed"), reference("shared", "shared")], { sourceSnapshotSha256: sha("final snapshot") });
    expect(reconcileStalePrecopies(prior, finalRefs).map((entry) => entry.targetKey)).toEqual(["import/rename", "import/delete"]);
    expect(target.deleteCalls).toBe(0);
    await copyReferencedObjects(source, target, finalRefs);
    const removed = await removeStaleOwnedObjects(target, prior, finalRefs);
    expect(removed.removed.map((entry) => entry.targetKey)).toEqual(["import/rename", "import/delete"]);
    expect([...target.objects.keys()].sort()).toEqual(["import/keep", "import/renamed", "import/shared"]);
    expect((await removeStaleOwnedObjects(target, prior, finalRefs)).alreadyAbsent).toEqual(["import/rename", "import/delete"]);
  });

  it("rejects changed ETags, ownership and wrong containers", async () => {
    const { source, target, input } = fixture();
    const receipt = await copyReferencedObjects(source, target, input);
    const finalRefs = { sourceSnapshotSha256: sha("final"), objects: [] };
    await expect(removeStaleOwnedObjects(new MemoryStore("wrong-target"), receipt, finalRefs)).rejects.toMatchObject({ code: "TARGET_IDENTITY_MISMATCH" });
    const object = target.objects.get("import/document");
    object.metadata.transferid = "other";
    await expect(removeStaleOwnedObjects(target, receipt, finalRefs)).rejects.toMatchObject({ code: "STALE_OBJECT_NOT_OWNED" });
    object.metadata.transferid = input.transferId;
    object.etag = '"changed"';
    await expect(removeStaleOwnedObjects(target, receipt, finalRefs)).rejects.toMatchObject({ code: "STALE_OBJECT_CHANGED" });
    expect(target.deleteCalls).toBe(0);
  });

  it("uses conditional deletion to preserve a replacement arriving after the ownership read", async () => {
    const { source, target, input } = fixture();
    const receipt = await copyReferencedObjects(source, target, input);
    target.onDelete = (key) => { target.put(key, "later work", {}); };
    await expect(removeStaleOwnedObjects(target, receipt, { sourceSnapshotSha256: sha("final"), objects: [] }))
      .rejects.toMatchObject({ code: "STALE_REMOVAL_FAILED" });
    expect(target.objects.get("import/document").data.toString()).toBe("later work");
  });
});

describe("Azure adapter with explicit synthetic clients", () => {
  function azureFixture() {
    const blob = { getProperties: vi.fn(), download: vi.fn(), deleteIfExists: vi.fn() };
    const block = { uploadData: vi.fn() };
    const container = { url: "https://synthetic.blob.core.windows.net/private?sig=do-not-expose",
      getAccessPolicy: vi.fn().mockResolvedValue({}), getBlobClient: vi.fn(() => blob), getBlockBlobClient: vi.fn(() => block) };
    return { blob, block, container, adapter: new AzureBlobObjectStore(container) };
  }

  it("enforces private access, conditional create and ETag delete without returning client URLs", async () => {
    const { adapter, container, blob, block } = azureFixture();
    await adapter.assertPrivate();
    await expect(adapter.createOnly("key", Buffer.from("abc"), { transferid: "transfer" }, "text/plain")).resolves.toBe(true);
    expect(block.uploadData).toHaveBeenCalledWith(Buffer.from("abc"), { conditions: { ifNoneMatch: "*" },
      metadata: { transferid: "transfer" }, blobHTTPHeaders: { blobContentType: "text/plain" }, concurrency: 1 });
    blob.deleteIfExists.mockResolvedValueOnce({ succeeded: true });
    await expect(adapter.removeIfMatch("key", '"etag"')).resolves.toBe(true);
    expect(blob.deleteIfExists).toHaveBeenCalledWith({ conditions: { ifMatch: '"etag"' } });
    expect(adapter.identity).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(adapter)).not.toContain("sig=");
    container.getAccessPolicy.mockResolvedValueOnce({ blobPublicAccess: "blob" });
    await expect(adapter.assertPrivate()).rejects.toMatchObject({ code: "PUBLIC_CONTAINER_FORBIDDEN" });
  });

  it("treats only expected collision/not-found responses as recoverable", async () => {
    const { adapter, block, blob } = azureFixture();
    block.uploadData.mockRejectedValueOnce({ statusCode: 412, code: "ConditionNotMet" });
    await expect(adapter.createOnly("key", Buffer.alloc(0), {})).resolves.toBe(false);
    block.uploadData.mockRejectedValueOnce(new Error("https://secret.invalid/?sig=secret"));
    const failure = await adapter.createOnly("key", Buffer.alloc(0), {}).catch((error) => error);
    expect(failure).toMatchObject({ code: "OBJECT_CREATE_FAILED" });
    expect(failure.message).not.toContain("secret");
    blob.getProperties.mockRejectedValueOnce({ statusCode: 404, code: "BlobNotFound" });
    await expect(adapter.head("key")).resolves.toBeNull();
    blob.getProperties.mockRejectedValueOnce({ statusCode: 404, code: "ContainerNotFound" });
    await expect(adapter.head("key")).rejects.toMatchObject({ code: "OBJECT_HEAD_FAILED" });
  });

  it("maps a conditional Azure stream read to bounded verifier inputs", async () => {
    const { adapter, blob } = azureFixture();
    blob.download.mockResolvedValueOnce({ etag: '"etag"', contentLength: 3, contentType: "text/plain",
      metadata: { sha256: sha("abc") }, readableStreamBody: (async function* () { yield Buffer.from("abc"); })() });
    const object = await adapter.read("key", '"etag"');
    expect(blob.download).toHaveBeenCalledWith(0, undefined, { conditions: { ifMatch: '"etag"' } });
    expect(object).toMatchObject({ etag: '"etag"', bytes: 3, contentType: "text/plain", metadata: { sha256: sha("abc") } });
    const chunks = [];
    for await (const chunk of object.body) chunks.push(chunk);
    expect(Buffer.concat(chunks).toString()).toBe("abc");
  });

  it("identifies the same container across distinct credential URLs and sanitizes invalid clients", async () => {
    const { adapter, container } = azureFixture();
    const second = new AzureBlobObjectStore({ ...container, url: "https://synthetic.blob.core.windows.net/private?sig=different" });
    expect(second.identity).toBe(adapter.identity);
    await expect(copyReferencedObjects(adapter, second, manifest([]))).rejects.toMatchObject({ code: "DISTINCT_STORES_REQUIRED" });
    expect(() => new AzureBlobObjectStore({ url: "invalid?sig=secret" })).toThrow("INVALID_CONTAINER_CLIENT");
  });
});
