import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "./errors";

const { capture, readable } = vi.hoisted(() => ({ capture: vi.fn(), readable: vi.fn() }));
vi.mock("./source-lineage", async importOriginal => ({
  mergeLineageInputRoot: (await importOriginal<typeof import("./source-lineage")>()).mergeLineageInputRoot,
  captureReadableNewspaperDeliveryInputs: async () => null,
  captureArtifactReadHeadObservation: async (read: () => Promise<unknown>) => ({value: await read(), heads: new Map()}),
  withArtifactCountReleaseSnapshot: async (_actor: unknown, _ws: string, _roots: unknown, remote: () => Promise<void>, finish: (tx: unknown) => Promise<unknown>) => {await remote();return finish({});}, captureArtifactInputProof: capture, isArtifactInputProofReadable: readable }));
import { DigestReadRelease, isDigestInputProofShared, loadReadableArtifactSample, loadReadableDigestQuery, mergeArtifactInputProofs } from "./digest-lineage";
vi.mock("./auth", () => ({requireWorkspaceMembership: async () => ({id: "member"})}));
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

  it("completes full lists beyond 5000 candidates while sampled input budgets remain", async () => {
    capture.mockImplementation(async (_actor, _workspaceId, inputs) => {
      if (Number(inputs[0].id) < 5001) throw new AppError(409, "UNKNOWN_LINEAGE", "Unknown history");
      return [{kind: "NewspaperDelivery", id: inputs[0].id, fingerprint: "a".repeat(64)}];
    });
    const rows = Array.from({length: 5003}, (_, index) => ({id: String(index)}));
    const loadBatch = vi.fn(async ({take,skip}) => rows.slice(skip,skip+take));
    expect(await loadReadableDigestQuery({actor: {} as any,workspaceId: "ws",kind: "NewspaperDelivery",limit: 1,completeScan: true,loadBatch})).toEqual([{id:"5001"},{id:"5002"}]);
    expect(loadBatch.mock.calls.every(([page]) => page.take <= 100)).toBe(true);
    await expect(loadReadableDigestQuery({actor: {} as any,workspaceId: "ws",kind: "NewspaperDelivery",limit: 1,loadBatch})).rejects.toMatchObject({code:"INPUT_SCAN_LIMIT"});
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


it("replenishes a bounded sample beyond 5000 denied candidates and keeps only its original roots", async () => {
  capture.mockImplementation(async (_actor, _ws, inputs) => {
    if (Number(inputs[0].id) < 5001) throw new AppError(409, "UNKNOWN_LINEAGE", "Unproved");
    return [{kind: "BrainArticle", id: inputs[0].id, fingerprint: "a".repeat(64)}];
  });
  const rows = Array.from({length: 5004}, (_, id) => ({id: String(id)}));
  const loadBatch = vi.fn(async (after, take) => rows.slice(after ? Number(after.id)+1 : 0, (after ? Number(after.id)+1 : 0)+take));
  const release = new DigestReadRelease({} as any, "ws");
  const sample = await loadReadableArtifactSample({actor: {} as any, workspaceId: "ws", kind: "BrainArticle", limit: 2, release, loadBatch});
  expect(sample.records.map(row => row.id)).toEqual(["5001", "5002"]);
  expect(sample.roots.map(root => root.id)).toEqual(["5001", "5002"]);
  expect(loadBatch).toHaveBeenCalledTimes(51);
  expect(loadBatch.mock.calls.every(([, take]) => take === 100)).toBe(true);
});
