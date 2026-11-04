import {beforeEach, expect, it, vi} from "vitest";
const mocks = vi.hoisted(() => ({resolve: vi.fn(), actor: vi.fn(), redirect: vi.fn(), notFound: vi.fn()}));
vi.mock("@corgtex/domain", async () => ({resolveWorkspacePermalink: mocks.resolve,
  AppError: (await import("../../../../../../../../packages/domain/src/errors")).AppError}));
import {AppError} from "../../../../../../../../packages/domain/src/errors";
vi.mock("@/lib/auth", () => ({requirePageActor: mocks.actor}));
vi.mock("next/navigation", () => ({redirect: mocks.redirect, notFound: mocks.notFound}));
vi.mock("@/lib/components/UnavailableItemStatus", () => ({UnavailableItemStatus: () => null}));
import Page from "./page";
beforeEach(() => {vi.resetAllMocks(); mocks.actor.mockResolvedValue({kind: "user", user: {id: "viewer"}});});
it("redirects an admitted permanent link to the canonical served path", async () => {
  mocks.resolve.mockResolvedValue({status: "ACTIVE", canonicalPath: "/workspaces/ws/meetings/meeting", permalink: {entityType: "Meeting", entityId: "meeting"}});
  mocks.redirect.mockImplementation(() => {throw new Error("NEXT_REDIRECT");});
  await expect(Page({params: Promise.resolve({workspaceId: "ws", permalinkId: "link"})})).rejects.toThrow("NEXT_REDIRECT");
  expect(mocks.resolve).toHaveBeenCalledWith({kind: "user", user: {id: "viewer"}}, {workspaceId: "ws", permalinkId: "link"});
  expect(mocks.redirect).toHaveBeenCalledWith("/workspaces/ws/meetings/meeting");
});
it("renders the normal404 for a denied source without redirecting or rendering archive metadata", async () => {
  const error = new AppError(404, "NOT_FOUND", "Permanent link target not found.");
  mocks.notFound.mockImplementation(() => {throw new Error("NEXT_HTTP_ERROR_FALLBACK;404");});
  mocks.resolve.mockRejectedValue(error);
  await expect(Page({params: Promise.resolve({workspaceId: "ws", permalinkId: "link"})})).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
  expect(mocks.notFound).toHaveBeenCalledOnce();
  expect(mocks.redirect).not.toHaveBeenCalled();
});

it("preserves a retryable source-change error instead of hiding it as missing", async () => {
  const error = new AppError(409, "SOURCE_CHANGED", "Source changed during release.");
  mocks.resolve.mockRejectedValue(error);
  await expect(Page({params: Promise.resolve({workspaceId: "ws", permalinkId: "link"})})).rejects.toBe(error);
  expect(mocks.redirect).not.toHaveBeenCalled();
  expect(mocks.notFound).not.toHaveBeenCalled();
});
