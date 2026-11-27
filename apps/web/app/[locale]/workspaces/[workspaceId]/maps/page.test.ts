import React from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AppError } from "../../../../../../../packages/domain/src/errors";

const mocks = vi.hoisted(() => ({
  map: vi.fn(), membership: vi.fn(), actor: vi.fn(), feature: vi.fn(), ai: vi.fn(), workspace: vi.fn(),
}));
vi.mock("@corgtex/domain", async () => ({
  AppError: (await import("../../../../../../../packages/domain/src/errors")).AppError,
  getContextMapData: mocks.map,
  requireWorkspaceMembership: mocks.membership,
}));
vi.mock("@corgtex/shared", () => ({ prisma: { workspace: { findUnique: mocks.workspace } } }));
vi.mock("@/lib/auth", () => ({ requirePageActor: mocks.actor }));
vi.mock("@/lib/workspace-feature-flags", () => ({
  isWorkspaceFeatureEnabled: mocks.ai,
  requireWorkspaceFeature: mocks.feature,
}));
vi.mock("./ContextMapClient", () => ({ default: () => null }));

import ContextMapsPage from "./page";

const actor = { kind: "user", user: { id: "member", email: "synthetic@example.test" } };
const render = () => ContextMapsPage({
  params: Promise.resolve({ workspaceId: "synthetic" }),
  searchParams: Promise.resolve({ view: "view-1", stale: "1" }),
});

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("React", React);
  mocks.actor.mockResolvedValue(actor);
  mocks.workspace.mockResolvedValue({ slug: "synthetic" });
  mocks.map.mockResolvedValue({ mapView: { id: "view-1" } });
});
afterEach(() => vi.unstubAllGlobals());

it("uses Next's not-found boundary for an unavailable map", async () => {
  mocks.map.mockRejectedValue(new AppError(404, "NOT_FOUND", "Context map not found."));
  await expect(render()).rejects.toMatchObject({ digest: "NEXT_HTTP_ERROR_FALLBACK;404" });
});

it.each([
  ["permission error", new AppError(403, "FORBIDDEN", "Not allowed.")],
  ["unrelated typed not-found", new AppError(404, "NOT_FOUND", "Workspace not found.")],
  ["database failure", new Error("Database unavailable.")],
  ["untyped lookalike", { status: 404, code: "NOT_FOUND", message: "Context map not found." }],
])("preserves a map loader %s", async (_label, error) => {
  mocks.map.mockRejectedValue(error);
  await expect(render()).rejects.toBe(error);
});

it("does not turn a parallel dependency failure into a map 404", async () => {
  const error = new AppError(404, "NOT_FOUND", "Context map not found.");
  mocks.ai.mockRejectedValue(error);
  await expect(render()).rejects.toBe(error);
});

it("continues to require feature and membership before loading", async () => {
  const error = new AppError(403, "FORBIDDEN", "Not a member.");
  mocks.membership.mockRejectedValue(error);
  await expect(render()).rejects.toBe(error);
  expect(mocks.feature).toHaveBeenCalledWith("synthetic", "CONTEXT_MAPS");
  expect(mocks.membership).toHaveBeenCalledWith({ actor, workspaceId: "synthetic" });
  expect(mocks.map).not.toHaveBeenCalled();
});

it("retains the existing success path and forwards map selection", async () => {
  await expect(render()).resolves.toMatchObject({ type: "div", props: { className: "context-map-page" } });
  expect(mocks.map).toHaveBeenCalledWith(actor, {
    workspaceId: "synthetic", mapViewId: "view-1", includeStale: true,
  });
});
