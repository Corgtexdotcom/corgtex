import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FleetHealthSnapshot } from "@prisma/client";
const { queryRaw } = vi.hoisted(() => ({ queryRaw: vi.fn() }));
vi.mock("@corgtex/shared", () => ({ prisma: { $queryRaw: queryRaw } }));
import { loadControlPlaneSnapshots } from "./control-plane-snapshots";

describe("bounded control-plane snapshots", () => {
  beforeEach(() => { queryRaw.mockReset().mockResolvedValue([]); });

  it.each(["deployment", "account"] as const)("uses one parameterized lateral read for %s parents, not one query per parent", async parent => {
    const hostileId = "synthetic'); DROP TABLE ignored; --";
    await loadControlPlaneSnapshots(parent, ["parent-1", hostileId, "parent-1"]);
    expect(queryRaw).toHaveBeenCalledTimes(1);
    const query = queryRaw.mock.calls[0][0];
    expect(query.values).toEqual(["parent-1", hostileId]);
    expect(query.sql).not.toContain(hostileId);
    expect(query.sql).toContain("CROSS JOIN LATERAL");
    expect(query.sql).toContain(`WHERE snapshot."${parent === "deployment" ? "deploymentId" : "customerAccountId"}" = parents.id`);
    expect(query.sql).toMatch(/ORDER BY snapshot\."createdAt" DESC\s+LIMIT 6\s*\)/);
    expect(query.sql).toContain("SELECT snapshot.*");
    expect(query.sql).not.toContain('"snapshotKind"');
  });

  it("skips empty parent sets", async () => {
    expect(await loadControlPlaneSnapshots("account", [])).toEqual(new Map());
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it.each(["deployment", "account"] as const)("preserves complete %s snapshot values and database ordering", async parent => {
    const snapshots = ["HEALTH", "SUPPORT_READY", "HEALTH"].map((kind, index) => ({
      id: `snapshot-${index}`, deploymentId: "dep", customerAccountId: "account", snapshotKind: kind,
      status: "unknown", error: "synthetic error", summary: { nested: { value: "x".repeat(2000) }, list: [1, null, true] },
      createdAt: new Date(2000 - index), observedAt: new Date(1000 - index),
    })) as FleetHealthSnapshot[];
    queryRaw.mockResolvedValue(snapshots);
    const key = parent === "deployment" ? "dep" : "account";
    const result = await loadControlPlaneSnapshots(parent, [key, "empty"]);
    expect(result.get(key)).toEqual(snapshots);
    expect(result.get(key)?.[0]).toBe(snapshots[0]);
    expect(result.has("empty")).toBe(false);
  });

  it("propagates database failures rather than manufacturing empty histories", async () => {
    queryRaw.mockRejectedValue(new Error("synthetic failure"));
    await expect(loadControlPlaneSnapshots("account", ["a"])).rejects.toThrow("synthetic failure");
  });
});
