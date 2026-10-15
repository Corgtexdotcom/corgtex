import {beforeEach, expect, it, vi} from "vitest";
const mocks = vi.hoisted(() => ({resolve: vi.fn(), actor: vi.fn(), redirect: vi.fn()}));
vi.mock("@corgtex/domain", () => ({resolveWorkspacePermalink: mocks.resolve}));
vi.mock("@/lib/auth", () => ({requirePageActor: mocks.actor}));
vi.mock("next/navigation", () => ({redirect: mocks.redirect}));
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
it("propagates denied source permission without redirecting or rendering archive metadata", async () => {
  const error = Object.assign(new Error("Permanent link target not found."), {status: 404, code: "NOT_FOUND"});
  mocks.resolve.mockRejectedValue(error);
  await expect(Page({params: Promise.resolve({workspaceId: "ws", permalinkId: "link"})})).rejects.toBe(error);
  expect(mocks.redirect).not.toHaveBeenCalled();
});
