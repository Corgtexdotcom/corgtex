import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "./errors";

const { capture, readable } = vi.hoisted(() => ({ capture: vi.fn(), readable: vi.fn() }));
vi.mock("./source-lineage", () => ({ captureArtifactInputProof: capture, isArtifactInputProofReadable: readable }));
import { isDigestInputProofShared, loadReadableDigestQuery, mergeArtifactInputProofs } from "./digest-lineage";
import { SOURCE_PERMISSION_POLICY_VERSION, type PermissionEpochProof } from "./source-permission-epochs";

describe("digest permission selection", () => {
  beforeEach(() => { vi.resetAllMocks(); });

  it("retains pre-generation permission epochs when a later receipt omits them", () => {
    const permissionEpochs: PermissionEpochProof = { version: 1, policyVersion: SOURCE_PERMISSION_POLICY_VERSION,
      entries: [{ kind: "BrainSource", id: "source", epoch: "4" }] };
    const root = { kind: "BrainSource" as const, id: "source", fingerprint: "a".repeat(64) };
    expect(mergeArtifactInputProofs([{ ...root, permissionEpochs }], [root])).toEqual([{ ...root, permissionEpochs }]);
    expect(mergeArtifactInputProofs([root], [{ ...root, permissionEpochs }])).toEqual([{ ...root, permissionEpochs }]);
    expect(() => mergeArtifactInputProofs([{ ...root, permissionEpochs }], [{ ...root,
      permissionEpochs: { ...permissionEpochs, entries: [{ kind: "BrainSource", id: "source", epoch: "6" }] } }]))
      .toThrow(expect.objectContaining({ code: "SOURCE_CHANGED" }));
  });

  it("keeps collecting past unauthorized rows before applying the requested page size", async () => {
    const rows = Array.from({ length: 60 }, (_, index) => ({ id: String(index) }));
    capture.mockImplementation(async (_actor, _workspaceId, inputs) => {
      if (Number(inputs[0].id) < 55) throw new AppError(409, "UNKNOWN_LINEAGE", "Unproven synthetic input");
      return [{ kind: "NewspaperEdition", id: inputs[0].id, fingerprint: "a".repeat(64) }];
    });
    const loadBatch = vi.fn(async ({ take, skip }) => rows.slice(skip, skip + take));
    expect(await loadReadableDigestQuery({ actor: {} as any, workspaceId: "ws", kind: "NewspaperEdition",
      limit: 2, loadBatch })).toEqual([{ id: "55" }, { id: "56" }]);
    expect(loadBatch.mock.calls.map(([page]) => page)).toEqual([{ take: 50, skip: 0 }, { take: 50, skip: 50 }]);
  });

  it("fails instead of returning partial counts when a complete history scan exceeds its budget", async () => {
    capture.mockImplementation(async (_actor, _workspaceId, inputs) => [
      { kind: "NewspaperDelivery", id: inputs[0].id, fingerprint: "a".repeat(64) },
    ]);
    const loadBatch = vi.fn(async ({ take, skip }) => Array.from({ length: take }, (_, index) => ({ id: String(skip + index) })));
    await expect(loadReadableDigestQuery({ actor: {} as any, workspaceId: "ws", kind: "NewspaperDelivery",
      limit: 1, completeScan: true, loadBatch })).rejects.toMatchObject({ code: "INPUT_SCAN_LIMIT" });
    expect(loadBatch).toHaveBeenCalledTimes(101);
  });

  it("accepts an exact-budget history after an empty terminator query", async () => {
    capture.mockImplementation(async (_actor, _workspaceId, inputs) => [
      { kind: "NewspaperDelivery", id: inputs[0].id, fingerprint: "a".repeat(64) },
    ]);
    const loadBatch = vi.fn(async ({ take, skip }) => skip === 5_000 ? []
      : Array.from({ length: take }, (_, index) => ({ id: String(skip + index) })));
    expect(await loadReadableDigestQuery({ actor: {} as any, workspaceId: "ws", kind: "NewspaperDelivery",
      limit: 1, completeScan: true, loadBatch })).toHaveLength(5_000);
  });

  it("uses the last captured key rather than an offset when rows are inserted between count batches", async () => {
    let rows = Array.from({ length: 55 }, (_, index) => ({ id: String(100 - index) }));
    capture.mockImplementation(async (_actor, _workspaceId, inputs) => [
      { kind: "NewspaperDelivery", id: inputs[0].id, fingerprint: "a".repeat(64) },
    ]);
    const loadBatch = vi.fn(async ({ take, after }) => {
      if (after) rows = [{ id: "101" }, ...rows];
      return rows.filter((row) => !after || Number(row.id) < Number(after.id)).slice(0, take);
    });
    const result = await loadReadableDigestQuery({ actor: {} as any, workspaceId: "ws", kind: "NewspaperDelivery",
      limit: 1, completeScan: true, keyset: true, loadBatch });
    expect(result).toHaveLength(55);
    expect(new Set(result.map((row) => row.id)).size).toBe(55);
  });

  it("removes a departed recipient from the shared audience while still enforcing active readers", async () => {
    readable.mockRejectedValueOnce(new AppError(403, "NOT_A_MEMBER", "Departed"))
      .mockResolvedValueOnce(true);
    expect(await isDigestInputProofShared([{} as any, {} as any], "ws", [])).toBe(true);
    readable.mockRejectedValueOnce(new AppError(403, "NOT_A_MEMBER", "Departed"))
      .mockResolvedValueOnce(false);
    expect(await isDigestInputProofShared([{} as any, {} as any], "ws", [])).toBe(false);
  });
});
