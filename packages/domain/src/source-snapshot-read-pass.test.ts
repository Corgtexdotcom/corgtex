import { describe, expect, it, vi } from "vitest";
import type { ArtifactInputSnapshot, Prisma } from "@prisma/client";
import { BoundedSnapshotReads } from "./source-snapshot-read-pass";

const snapshot = (id = "one", body = "Original") => ({ id, workspaceId: "ws", sourceKind: "BrainArticle",
  sourceId: "article", sourceFingerprint: "hash", origin: "HUMAN_ORIGINAL", contentJson: { bodyMd: body },
  accessEnvelopeJson: { isPrivate: false }, rootsJson: [], epochProofVersion: 1, permissionEpochsJson: {},
  createdAt: new Date("2026-10-01T00:00:00Z") }) as ArtifactInputSnapshot;
function fixture() {
  const rows = new Map([["one", snapshot()]]);
  const findMany = vi.fn(async ({ where }: { where: { workspaceId: string; id: { in: string[] } } }) =>
    where.id.in.flatMap(id => rows.has(id) && rows.get(id)!.workspaceId === where.workspaceId ? [structuredClone(rows.get(id)!)] : []));
  const db = { artifactInputSnapshot: { findMany } } as unknown as Prisma.TransactionClient;
  return { rows, findMany, reads: new BoundedSnapshotReads(db, "ws") };
}

describe("bounded snapshot bytes in a single coverage inspection", () => {
  it("isolates returned bytes and disposes after its one final comparison", async () => {
    const t = fixture(); const row = snapshot(); t.reads.retain(row);
    (row.contentJson as { bodyMd: string }).bodyMd = "Caller mutation";
    const hit = t.reads.get("one")!; (hit.contentJson as { bodyMd: string }).bodyMd = "Consumer mutation";
    expect(t.reads.get("one")!.contentJson).toEqual({ bodyMd: "Original" });
    expect(await t.reads.isCurrent()).toBe(true);
    expect(t.findMany).toHaveBeenCalledTimes(1);
    expect(t.reads.get("one")).toBeUndefined();
    expect(await t.reads.isCurrent()).toBe(false);
  });

  it.each(["content", "roots", "envelope", "delete"])("rejects %s changes without relying on permission epochs", async change => {
    const t = fixture(); t.reads.retain(snapshot());
    expect(t.reads.get("one")).toEqual(snapshot()); // Exercise the reused row.
    if (change === "delete") t.rows.delete("one");
    else {
      const row = snapshot();
      if (change === "content") row.contentJson = { bodyMd: "Changed" };
      if (change === "roots") row.rootsJson = [{ id: "other" }];
      if (change === "envelope") row.accessEnvelopeJson = { isPrivate: true };
      t.rows.set("one", row);
    }
    expect(await t.reads.isCurrent()).toBe(false);
  });

  it("binds the actual workspace and excludes native/SQL/Knowledge payloads", async () => {
    const t = fixture();
    t.reads.retain({ ...snapshot(), workspaceId: "foreign" });
    for (const sourceKind of ["SqlNativeRunInput", "KnowledgeChunk", "NativeTranscriptInput", "ExternalProviderFetchInput"]) {
      t.reads.retain({ ...snapshot(), sourceKind });
    }
    expect(t.reads.get("one")).toBeUndefined();
    expect(await t.reads.isCurrent()).toBe(true);
    expect(t.findMany).not.toHaveBeenCalled();
  });

  it("retains at most 64 rows and skips oversized rows without copying their JSON", async () => {
    const t = fixture();
    t.reads.retain(snapshot("huge", "x".repeat(128 * 1024)));
    expect(t.reads.get("huge")).toBeUndefined();
    for (let index = 0; index < 65; index++) {
      const row = snapshot(String(index)); t.rows.set(row.id, row); t.reads.retain(row);
    }
    expect(t.reads.get("63")).toBeDefined(); expect(t.reads.get("64")).toBeUndefined();
    expect(await t.reads.isCurrent()).toBe(true);
    expect(t.findMany.mock.calls[0][0].where.id.in).toHaveLength(64);
  });

  it("enforces an aggregate retained-size budget and independent inspection lifetimes", async () => {
    const t = fixture();
    for (let index = 0; index < 10; index++) {
      const row = snapshot(String(index), "x".repeat(16 * 1024)); t.rows.set(row.id, row); t.reads.retain(row);
    }
    expect(await t.reads.isCurrent()).toBe(true);
    expect(t.findMany.mock.calls[0][0].where.id.in.length).toBeLessThanOrEqual(3);
    const other = fixture(); other.reads.retain(snapshot("one", "New inspection"));
    other.rows.set("one", snapshot("one", "New inspection"));
    expect(await other.reads.isCurrent()).toBe(true);
  });

  it("disposes when the final SQL read throws", async () => {
    const t = fixture(); t.reads.retain(snapshot());
    t.findMany.mockRejectedValueOnce(new Error("Database unavailable"));
    await expect(t.reads.isCurrent()).rejects.toThrow("Database unavailable");
    expect(t.reads.get("one")).toBeUndefined();
  });
});
