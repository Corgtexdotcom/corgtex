import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";
import { AppError } from "./errors";
import { DigestReadRelease } from "./digest-lineage";

const state = vi.hoisted(() => ({
  findMany: vi.fn(), membership: vi.fn(), capture: vi.fn(), finish: vi.fn(),
  observation: 0,
}));
vi.mock("@corgtex/shared", () => ({ prisma: { constitution: { findMany: state.findMany } } }));
vi.mock("./auth", () => ({ requireWorkspaceMembership: state.membership }));
vi.mock("./source-lineage", () => ({
  captureArtifactInputProof: state.capture,
  captureArtifactReadHeadObservation: async (read: () => Promise<unknown>) => ({
    value: await read(), heads: new Map([[`page-${state.observation}`, `original-${state.observation++}`]]),
  }),
  mergeLineageInputRoot: (_previous: unknown, root: unknown) => root,
  withArtifactCountReleaseSnapshot: state.finish,
  readableArtifactIds: async (_actor: unknown, _ws: string, _kind: string, rows: Array<{ id: string }>) => new Set(rows.filter(row => !row.id.startsWith("denied")).map(row => row.id)),
}));
vi.mock("./producer-lineage", () => ({}));
import { listConstitutionVersions, listConstitutionVersionPage } from "./constitutions";

const actor: AppActor = { kind: "user", user: { id: "reader", email: "reader@example.test", displayName: "Reader" } };
const tx = { snapshot: "final" };

describe("constitution history bounded discovery and final release", () => {
  beforeEach(() => {
    state.findMany.mockReset();
    state.membership.mockReset().mockResolvedValue({ id: "reader-member" });
    state.observation = 0;
    state.capture.mockReset().mockImplementation(async (_actor, _workspaceId, inputs: Array<{ kind: string; id: string }>) => {
      if (inputs[0]!.id.startsWith("denied")) throw new AppError(409, "UNKNOWN_LINEAGE", "Denied");
      return inputs.map(input => ({ kind: input.kind, id: input.id, fingerprint: "a".repeat(64) }));
    });
    state.finish.mockReset().mockImplementation(async (_actor, _workspaceId, _roots, prepass, callback) => {
      await prepass(); return callback(tx);
    });
  });

  it("bounds legacy exact history instead of exhausting a denied prefix", async () => {
    const rows = Array.from({length: 205}, (_, index) => ({id: `denied-${index}`, version: 205-index, bodyMd: "Hidden"}));
    state.findMany.mockImplementation(async args => rows.filter(row => row.version < (args.where.OR?.[0]?.version.lt ?? Infinity)).slice(0,args.take));
    await expect(listConstitutionVersions(actor, "ws", {take: 2})).rejects.toMatchObject({code:"SOURCE_READ_SCAN_LIMIT"});
    expect(state.findMany).toHaveBeenCalledTimes(1);
    expect(state.findMany.mock.calls[0][0].take).toBe(200);
  });

  it("rejects a caller or workspace mismatched shared release", async () => {
    await expect(listConstitutionVersionPage(actor, "ws", {}, new DigestReadRelease(actor, "other")))
      .rejects.toMatchObject({code: "INVALID_INPUT"});
    await expect(listConstitutionVersionPage(actor, "ws", {}, new DigestReadRelease({...actor}, "ws")))
      .rejects.toMatchObject({code: "INVALID_INPUT"});
    expect(state.findMany).not.toHaveBeenCalled();
  });

  it("continues an empty hidden window from the last examined version", async () => {
    const rows = Array.from({length: 201}, (_, index) => ({id: index < 200 ? `denied-${index}` : "tail", version: 201-index, bodyMd: "Synthetic"}));
    state.findMany.mockImplementation(async args => rows.filter(row => row.version < (args.where.OR?.[0]?.version.lt ?? Infinity)).slice(0,args.take));
    const first = await listConstitutionVersionPage(actor, "ws", {take: 10});
    expect(first).toMatchObject({items: [], complete: false, hasMore: true});
    expect(state.findMany).toHaveBeenCalledTimes(1);
    expect(await listConstitutionVersionPage(actor, "ws", {take: 10, cursor: first.nextCursor!}))
      .toEqual({items: [rows[200]], complete: true, hasMore: false, nextCursor: null});
    await expect(listConstitutionVersionPage(actor, "other", {cursor: first.nextCursor!})).rejects.toMatchObject({code: "INVALID_INPUT"});
    await expect(listConstitutionVersionPage(actor, "ws", {cursor: "not-a-cursor"})).rejects.toMatchObject({code: "INVALID_INPUT"});
  });

  it("continues from the last returned readable row without losing later candidates", async () => {
    const rows = Array.from({length: 3}, (_, index) => ({id: `visible-${index}`, version: 3-index}));
    state.findMany.mockImplementation(async args => rows.filter(row => row.version < (args.where.OR?.[0]?.version.lt ?? Infinity)).slice(0,args.take));
    const first = await listConstitutionVersionPage(actor, "ws", {take: 1});
    expect(first.items).toEqual([rows[0]]); expect(first.complete).toBe(false);
    const second = await listConstitutionVersionPage(actor, "ws", {take: 2, cursor: first.nextCursor!});
    expect(second.items).toEqual(rows.slice(1)); expect(second.complete).toBe(true);
  });

  it("returns no bodies beyond the readable window while still counting the complete history", async () => {
    state.findMany.mockResolvedValue([{ id: "readable", version: 1, bodyMd: "Outside page" }]);
    expect(await listConstitutionVersions(actor, "ws", { skip: 4, take: 2 })).toEqual({ items: [], total: 1, take: 2, skip: 4 });
    expect(state.finish.mock.calls[0]![2]).toHaveLength(1);
  });

  it("does not return a previously collected window when final proof validation fails", async () => {
    state.findMany.mockResolvedValue([{ id: "selected", version: 2 }, { id: "count-only", version: 1 }]);
    state.finish.mockRejectedValueOnce(new AppError(409, "SOURCE_CHANGED", "Original authority changed"));
    await expect(listConstitutionVersions(actor, "ws", { take: 1 })).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(state.finish.mock.calls[0]![2]).toEqual([
      { kind: "Constitution", id: "selected", fingerprint: "a".repeat(64) },
      { kind: "Constitution", id: "count-only", fingerprint: "a".repeat(64) },
    ]);
  });

  it("rechecks current membership even for an empty readable history", async () => {
    state.findMany.mockResolvedValue([{ id: "denied-1", version: 1 }]);
    state.membership.mockResolvedValueOnce({ id: "reader-member" }).mockRejectedValueOnce(new AppError(403, "NOT_A_MEMBER", "Departed"));
    await expect(listConstitutionVersions(actor, "ws")).rejects.toMatchObject({ code: "NOT_A_MEMBER" });
    expect(state.finish.mock.calls[0]![2]).toEqual([]);
  });
});
