import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { captureOpsCoreObjects, copyOpsCoreObjects, verifyOpsCoreObjects } from "./ops-core-objects.ts";
import { ObjectTransferError, validateObjectReceipt } from "./shared-tenant-objects.ts";

function fixture() {
  let fenced = true;
  let inventoryCount = 0;
  const options = { limits: { maxPages: 2, maxObjects: 10, maxTotalBytes: 100, maxObjectBytes: 20 },
    async assertSourceFenced() { if (!fenced) throw new Error("private custody details"); } };
  const sourceObjects = new Map([["document", { data: Buffer.from("retained"), etag: "generation-one", contentType: "text/plain", metadata: {} }],
    ["empty", { data: Buffer.alloc(0), etag: "empty-one", contentType: "application/octet-stream", metadata: {} }]]);
  const targetObjects = new Map();
  const heads = (map) => [...map.entries()].map(([key, value]) => ({ key, etag: value.etag,
    bytes: value.data.length, contentType: value.contentType, metadata: value.metadata }));
  function store(identity, map) {
    return {
      identity, writes: 0, afterRead: () => {},
      async assertPrivate() {},
      async head(key) { return heads(map).find((entry) => entry.key === key) ?? null; },
      async read(key, etag) {
        const value = map.get(key);
        if (!value) return null;
        if (etag && etag !== value.etag) throw new ObjectTransferError("SOURCE_ETAG_CHANGED");
        const head = await this.head(key);
        const afterRead = this.afterRead;
        return { ...head, body: (async function* () { yield value.data; afterRead(); })() };
      },
      async createOnly(key, data, metadata, contentType) {
        this.writes++;
        if (map.has(key)) return false;
        map.set(key, { data: Buffer.from(data), metadata, contentType, etag: "target-generation" });
        return true;
      },
      async removeIfMatch() { throw new Error("unexpected delete"); },
    };
  }
  const source = Object.assign(store("railway-source", sourceObjects), {
    onInventory: () => {},
    async inventory() { inventoryCount++; this.onInventory(inventoryCount); return heads(sourceObjects); },
  });
  const target = store("azure-target", targetObjects);
  const capture = () => captureOpsCoreObjects(source, { databaseSnapshotSha256: "a".repeat(64), sourceFenceSha256: "b".repeat(64) }, options);
  return { source, target, options, sourceObjects, targetObjects, capture, unfence: () => { fenced = false; } };
}

describe("Ops/Core whole bucket transfer", () => {
  it("captures all retained objects and integrates create-only copy with checksum receipts", async () => {
    const f = fixture();
    const snapshot = await f.capture();
    expect(snapshot.objects).toHaveLength(2);
    expect(snapshot.objects[0].sha256).toBe(createHash("sha256").update("retained").digest("hex"));
    const receipt = await copyOpsCoreObjects(f.source, f.target, snapshot, "cutover-objects", f.options);
    expect(validateObjectReceipt(receipt).entries).toHaveLength(2);
    expect(receipt.sourceSnapshotSha256).toBe(snapshot.sha256);
    expect(f.targetObjects.get("document").data.toString()).toBe("retained");
    const retry = await copyOpsCoreObjects(f.source, f.target, snapshot, "cutover-objects", f.options);
    expect(retry.sha256).toBe(receipt.sha256);
    expect(f.source.writes).toBe(0);
  });

  it("refuses a capture if an object is added while hashing", async () => {
    const f = fixture();
    f.source.onInventory = (count) => {
      if (count === 2) f.sourceObjects.set("late", { ...f.sourceObjects.get("document") });
    };
    await expect(f.capture()).rejects.toMatchObject({ code: "SOURCE_INVENTORY_CHANGED" });
  });

  it("refuses source drift before copy without writing destination objects", async () => {
    const f = fixture(); const snapshot = await f.capture();
    f.sourceObjects.get("document").etag = "generation-two";
    await expect(copyOpsCoreObjects(f.source, f.target, snapshot, "cutover-objects", f.options))
      .rejects.toMatchObject({ code: "SOURCE_INVENTORY_CHANGED" });
    expect(f.target.writes).toBe(0);
  });

  it("does not overwrite an existing destination with different bytes", async () => {
    const f = fixture(); const snapshot = await f.capture();
    f.targetObjects.set("document", { ...f.sourceObjects.get("document"), data: Buffer.from("modified") });
    await expect(copyOpsCoreObjects(f.source, f.target, snapshot, "cutover-objects", f.options))
      .rejects.toMatchObject({ code: "OBJECT_DIGEST_MISMATCH" });
    expect(f.targetObjects.get("document").data.toString()).toBe("modified");
  });

  it("rechecks the fence after source streaming before the first destination write", async () => {
    const f = fixture(); const snapshot = await f.capture();
    f.source.afterRead = f.unfence;
    const error = await copyOpsCoreObjects(f.source, f.target, snapshot, "cutover-objects", f.options).catch((error) => error);
    expect(error).toBeInstanceOf(ObjectTransferError);
    expect(error.message).not.toContain("private");
    expect(f.target.writes).toBe(0);
  });

  it("rejects tampered snapshot bindings and oversized objects", async () => {
    const f = fixture(); const snapshot = await f.capture();
    snapshot.databaseSnapshotSha256 = "c".repeat(64);
    await expect(copyOpsCoreObjects(f.source, f.target, snapshot, "cutover-objects", f.options))
      .rejects.toMatchObject({ code: "INVALID_OBJECT_SNAPSHOT" });
    f.options.limits.maxObjectBytes = 2;
    await expect(f.capture()).rejects.toMatchObject({ code: "OBJECT_BUDGET_EXCEEDED" });
    expect(f.target.writes).toBe(0);
  });
  it("verifies retained objects without create calls and rejects missing or changed content", async () => {
    const f=fixture(), snapshot=await f.capture();
    await copyOpsCoreObjects(f.source,f.target,snapshot,"cutover-objects",f.options);
    const writes=f.target.writes;
    const receipt=await verifyOpsCoreObjects(f.source,f.target,snapshot,f.options);
    expect(receipt.complete).toBe(true);expect(receipt.objectCount).toBe(2);expect(f.target.writes).toBe(writes);
    f.targetObjects.get("document").data=Buffer.from("modified");
    await expect(verifyOpsCoreObjects(f.source,f.target,snapshot,f.options)).rejects.toMatchObject({code:"TARGET_OBJECT_MISMATCH"});
    f.targetObjects.delete("document");
    await expect(verifyOpsCoreObjects(f.source,f.target,snapshot,f.options)).rejects.toMatchObject({code:"TARGET_OBJECT_MISMATCH"});
    expect(f.target.writes).toBe(writes);
  });
  it("verification catches source inventory drift and fence loss without destination effects", async () => {
    const f=fixture(), snapshot=await f.capture();
    await copyOpsCoreObjects(f.source,f.target,snapshot,"cutover-objects",f.options);
    const writes=f.target.writes;f.sourceObjects.get("document").etag="foreign";
    await expect(verifyOpsCoreObjects(f.source,f.target,snapshot,f.options)).rejects.toMatchObject({code:"SOURCE_INVENTORY_CHANGED"});
    f.sourceObjects.get("document").etag="generation-one";f.target.afterRead=f.unfence;
    await expect(verifyOpsCoreObjects(f.source,f.target,snapshot,f.options)).rejects.toThrow();
    expect(f.target.writes).toBe(writes);
  });

});
