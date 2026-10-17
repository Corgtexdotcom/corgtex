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

  it("bounds small samples while explicit complete scans retain every permitted row", async () => {
    capture.mockImplementation(async (_actor, _workspaceId, inputs) => {
      if (Number(inputs[0].id) < 5001) throw new AppError(409, "UNKNOWN_LINEAGE", "Unknown history");
      return [{kind: "NewspaperDelivery", id: inputs[0].id, fingerprint: "a".repeat(64)}];
    });
    const rows = Array.from({length: 5003}, (_, index) => ({id: String(index)}));
    const loadBatch = vi.fn(async ({take,skip}) => rows.slice(skip,skip+take));
    expect(await loadReadableDigestQuery({actor: {} as any,workspaceId: "ws",kind: "NewspaperDelivery",limit: 1,completeScan: true,loadBatch})).toEqual([{id:"5001"},{id:"5002"}]);
    expect(loadBatch.mock.calls.every(([page]) => page.take <= 100)).toBe(true);
    loadBatch.mockClear();
    await expect(loadReadableDigestQuery({actor: {} as any,workspaceId: "ws",kind: "NewspaperDelivery",limit: 1,loadBatch})).rejects.toMatchObject({code: "SOURCE_READ_SCAN_LIMIT"});
    expect(loadBatch).toHaveBeenCalledTimes(4);
    const keyset = vi.fn(async ({take, after}) => rows.slice(after ? Number(after.id) + 1 : 0, (after ? Number(after.id) + 1 : 0) + take));
    await expect(loadReadableDigestQuery({actor: {} as any,workspaceId: "ws",kind: "NewspaperDelivery",limit: 1, keyset: true, loadBatch: keyset})).rejects.toMatchObject({code: "SOURCE_READ_SCAN_LIMIT"});
    expect(keyset).toHaveBeenCalledTimes(4);
    expect(keyset.mock.calls.every(([page]) => page.take === 50)).toBe(true);
  });

  it("completes an exact-page history after an empty terminator query", async () => {
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

  it("exhausts denied pages and rejects duplicate candidates instead of looping", async () => {
    capture.mockRejectedValue(new AppError(409, "UNKNOWN_LINEAGE", "Unknown history"));
    const rows = Array.from({length: 5001}, (_, index) => ({id: String(index)}));
    const loadBatch = vi.fn(async ({take, skip}) => rows.slice(skip, skip + take));
    await expect(loadReadableDigestQuery({actor: {} as any, workspaceId: "ws", kind: "NewspaperEdition", limit: 1, loadBatch})).rejects.toMatchObject({code: "SOURCE_READ_SCAN_LIMIT"});
    expect(loadBatch).toHaveBeenCalledTimes(4);
    const repeating = vi.fn(async () => rows.slice(0, 50));
    await expect(loadReadableDigestQuery({actor: {} as any, workspaceId: "ws", kind: "NewspaperEdition", limit: 1, loadBatch: repeating}))
      .rejects.toMatchObject({code: "SOURCE_CHANGED"});
    expect(repeating).toHaveBeenCalledTimes(2);
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


it("replenishes a bounded sample within 200 candidates and keeps only its original roots", async () => {
  capture.mockImplementation(async (_actor, _ws, inputs) => {
    if (Number(inputs[0].id) < 101) throw new AppError(409, "UNKNOWN_LINEAGE", "Unproved");
    return [{kind: "BrainArticle", id: inputs[0].id, fingerprint: "a".repeat(64)}];
  });
  const rows = Array.from({length: 104}, (_, id) => ({id: String(id)}));
  const loadBatch = vi.fn(async (after, take) => rows.slice(after ? Number(after.id)+1 : 0, (after ? Number(after.id)+1 : 0)+take));
  const release = new DigestReadRelease({} as any, "ws");
  const sample = await loadReadableArtifactSample({actor: {} as any, workspaceId: "ws", kind: "BrainArticle", limit: 2, release, loadBatch});
  expect(sample.records.map(row => row.id)).toEqual(["101", "102"]);
  expect(sample.roots.map(root => root.id)).toEqual(["101", "102"]);
  expect(loadBatch).toHaveBeenCalledTimes(2);
  expect(loadBatch.mock.calls.every(([, take]) => take === 100)).toBe(true);
});


it.each(["sample", "digest"])("bounds %s discovery before a 5001-row denied tail", async mode => {
  capture.mockRejectedValue(new AppError(409, "UNKNOWN_LINEAGE", "Unknown history"));
  const rows = Array.from({length: 5001}, (_, i) => ({id: String(i)}));
  const loads = vi.fn(async (after: {id: string} | undefined, take: number) => {
    const offset = after ? Number(after.id) + 1 : 0;
    return rows.slice(offset, offset + take);
  });
  const params = {actor: {} as any, workspaceId: "ws", kind: "BrainArticle" as const, limit: 2};
  const result = mode === "sample" ? loadReadableArtifactSample({...params, release: new DigestReadRelease({} as any, "ws"), loadBatch: loads})
    : loadReadableDigestQuery({...params, keyset: true, loadBatch: ({after, take}) => loads(after, take)});
  await expect(result).rejects.toMatchObject({code: "SOURCE_READ_SCAN_LIMIT"});
  expect(loads.mock.calls.reduce((sum, [, take]) => sum + take, 0)).toBe(200);
});


it.each([0, -1, NaN, Infinity, 1.5])("rejects invalid sample size %s before loading", async limit => {
  const loadBatch = vi.fn();
  await expect(loadReadableDigestQuery({actor: {} as any, workspaceId: "ws", kind: "BrainArticle", limit, loadBatch})).rejects.toMatchObject({code: "INVALID_INPUT"});
  expect(loadBatch).not.toHaveBeenCalled();
});
it("bounds an explicit larger sample to its requested candidates without rounding up", async () => {
  capture.mockRejectedValue(new AppError(409, "UNKNOWN_LINEAGE", "Unknown history"));
  const loadBatch = vi.fn(async (after: {id:string} | undefined, take: number) => Array.from({length:take},(_,i)=>({id:String((after ? Number(after.id)+1 : 0)+i)})));
  await expect(loadReadableArtifactSample({actor:{} as any,workspaceId:"ws",kind:"BrainArticle",limit:250,release:new DigestReadRelease({} as any,"ws"),loadBatch})).rejects.toMatchObject({code:"SOURCE_READ_SCAN_LIMIT"});
  expect(loadBatch.mock.calls.map(([,take])=>take)).toEqual([100,100,50]);
});
