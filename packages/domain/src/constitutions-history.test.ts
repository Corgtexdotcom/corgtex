import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";
import type { LineageRoot } from "./source-lineage";
import { AppError } from "./errors";

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
import { listConstitutionVersions } from "./constitutions";

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

  it("bounds body pages, replenishes denied rows, and releases the exact total with off-page original proofs", async () => {
    const rows = Array.from({ length: 205 }, (_, index) => ({
      id: `${index % 2 === 0 ? "denied" : "readable"}-${index}`, version: 205 - index, bodyMd: `Body ${index}`,
    }));
    state.findMany.mockImplementation(async (args) => {
      expect(args.take).toBe(100);
      const cursor = args.where.OR?.[0]?.version.lt ?? Infinity;
      return rows.filter(row => row.version < cursor).slice(0, args.take);
    });
    const result = await listConstitutionVersions(actor, "ws", { skip: 1, take: 2 });
    expect(result).toEqual({ items: [rows[3], rows[5]], total: 102, take: 2, skip: 1 });
    expect(state.findMany).toHaveBeenCalledTimes(3);
    expect(state.findMany).toHaveBeenNthCalledWith(2, {
      where: { workspaceId: "ws", OR: [{ version: { lt: 106 } }, { version: 106, id: { lt: "readable-99" } }] },
      orderBy: [{ version: "desc" }, { id: "desc" }], take: 100,
    });
    const proof = state.finish.mock.calls[0]![2] as LineageRoot[];
    expect(proof).toHaveLength(102);
    expect(proof).toContainEqual({ kind: "Constitution", id: "readable-203", fingerprint: "a".repeat(64) });
    expect(JSON.stringify(proof)).not.toContain("bodyMd");
    expect(state.finish.mock.calls[0]![5]).toEqual(new Map([
      ["page-0", "original-0"], ["page-1", "original-1"], ["page-2", "original-2"],
    ]));
    expect(state.membership).toHaveBeenLastCalledWith({ actor, workspaceId: "ws", tx });
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
