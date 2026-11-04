import { beforeEach, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";

const fixture = vi.hoisted(() => ({ get: vi.fn(), flags: vi.fn() }));
vi.mock("@corgtex/shared", () => ({ prisma: { workspaceFeatureFlag: { findMany: fixture.flags } } }));
vi.mock("@corgtex/domain", () => ({ getContextMapData: fixture.get,
  applyContextGraphProposedDiff: vi.fn(), buildSelectedRegionContext: vi.fn(), createContextGraphProposedDiff: vi.fn(),
  AppError: class extends Error {},
}));
import { contextMapToolHandlers } from "./context-map";
const actor = { kind: "user", user: { id: "member-user" } } as AppActor;
const complete = { scope: "WINDOW", complete: true, objectsComplete: true, relationshipsComplete: true,
  evidenceComplete: true, proposedDiffsComplete: true, variantsComplete: true };
beforeEach(() => {
  vi.clearAllMocks();
  fixture.flags.mockResolvedValue([ { flag: "CONTEXT_MAPS", enabled: true }, { flag: "CONTEXT_MAP_AI", enabled: true } ]);
});
it.each([
  [80, 120, true, true], [81, 120, false, true], [80, 121, true, false], [81, 121, false, false],
] as const)("qualifies the tool's own %i object and %i relationship slices", async (objects, relationships, objectsComplete, relationshipsComplete) => {
  fixture.get.mockResolvedValue({ mapView: { id: "map" }, permissions: {}, readWindow: complete,
    objects: Array.from({ length: objects }, (_, i) => ({ id: `object-${i}`, objectType: "Task", title: "Visible", status: "approved", properties: {} })),
    relationships: Array.from({ length: relationships }, (_, i) => ({ id: `relationship-${i}`, sourceObjectId: "object-0", targetObjectId: "object-1", relationshipType: "supports", status: "approved" })),
  });
  const result = await contextMapToolHandlers.get_context_map_info(actor, { workspaceId: "workspace" }, {});
  expect(result.visibleObjects).toHaveLength(Math.min(objects, 80));
  expect(result.visibleRelationships).toHaveLength(Math.min(relationships, 120));
  expect(result.readWindow).toEqual({ ...complete, objectsComplete, relationshipsComplete, complete: objectsComplete && relationshipsComplete });
  expect(fixture.get).toHaveBeenCalledWith(actor, { workspaceId: "workspace", mapViewId: null, includeStale: false });
});
it("preserves incomplete empty-window metadata instead of claiming global absence", async () => {
  const readWindow = { ...complete, complete: false, evidenceComplete: false, variantsComplete: false };
  fixture.get.mockResolvedValue({ mapView: { id: "map" }, permissions: {}, readWindow, objects: [], relationships: [] });
  const result = await contextMapToolHandlers.get_context_map_info(actor, { workspaceId: "workspace" }, {});
  expect(result.readWindow).toEqual(readWindow);
  expect(result.visibleObjects).toEqual([]);
  expect(JSON.stringify(result)).not.toMatch(/examined|denied/);
});
it("propagates the domain final-release denial without returning map metadata", async () => {
  const denied = Object.assign(new Error("Source changed"), { code: "SOURCE_CHANGED" });
  fixture.get.mockRejectedValue(denied);
  await expect(contextMapToolHandlers.get_context_map_info(actor, { workspaceId: "workspace" }, {})).rejects.toBe(denied);
});
