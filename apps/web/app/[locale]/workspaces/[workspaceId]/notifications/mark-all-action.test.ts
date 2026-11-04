import { beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ mark: vi.fn(), refresh: vi.fn(), actor: { kind: "user", user: { id: "reader" } } }));
vi.mock("@/lib/demo-guard", () => ({ enforceDemoGuard: async () => {} }));
vi.mock("@/lib/auth", () => ({ requirePageActor: async () => state.actor }));
vi.mock("@corgtex/domain", () => ({ markAllNotificationsRead: state.mark }));
vi.mock("@corgtex/shared", () => ({ prisma: {}, sendEmail: vi.fn() }));
vi.mock("../action-utils", () => ({
  asString: (data: FormData, key: string) => String(data.get(key) ?? ""),
  asOptional: (data: FormData, key: string) => data.get(key) || null,
  asOptionalInt: vi.fn(), refresh: state.refresh,
}));
import { markAllNotificationsReadAction } from "../settings/actions";
beforeEach(() => vi.clearAllMocks());
it("passes the bounded continuation and returns its completion state", async () => {
  const form = new FormData(); form.set("workspaceId", "workspace"); form.set("cursor", "original-cursor");
  const result = { updatedCount: 1, complete: false, nextCursor: "next-cursor" }; state.mark.mockResolvedValue(result);
  expect(await markAllNotificationsReadAction(form)).toEqual(result);
  expect(state.mark).toHaveBeenCalledExactlyOnceWith(state.actor, "workspace", { cursor: "original-cursor" });
  expect(state.refresh).toHaveBeenCalledExactlyOnceWith("workspace");
});
it("propagates authority rejection without inventing progress", async () => {
  const form = new FormData(); form.set("workspaceId", "workspace");
  const error = new Error("Source authority changed"); state.mark.mockRejectedValue(error);
  await expect(markAllNotificationsReadAction(form)).rejects.toBe(error);
  expect(state.refresh).not.toHaveBeenCalled();
});
