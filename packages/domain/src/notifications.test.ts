import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    notification: {
      findMany: vi.fn(),
      count: vi.fn(),
      updateMany: vi.fn(),
    },
  },
}));

vi.mock("@corgtex/shared", () => ({
  prisma: prismaMock,
  parseAllowedWorkspaceIds: vi.fn(() => new Set<string>()),
  env: {
    SESSION_LAST_SEEN_WRITE_INTERVAL_MS: 5 * 60 * 1000,
  },
}));

const actor: AppActor = {
  kind: "user" as const,
  user: {
    id: "user-1",
    email: "user@example.com",
    displayName: "User",
    globalRole: "OPERATOR",
  },
};

describe("notifications domain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-24T12:00:00.000Z"));
    prismaMock.notification.updateMany.mockResolvedValue({ count: 1 });
  });

  it("listNotifications returns user notifications for a workspace", async () => {
    prismaMock.notification.findMany.mockResolvedValue([{ id: "notification-1" }]);

    const { listNotifications } = await import("./notifications");
    await expect(listNotifications(actor, "workspace-1", { unreadOnly: true, take: 10 })).resolves.toEqual([{ id: "notification-1" }]);
    expect(prismaMock.notification.findMany).toHaveBeenCalledWith({
      where: {
        workspaceId: "workspace-1",
        userId: "user-1",
        readAt: null,
      },
      orderBy: { createdAt: "desc" },
      take: 10,
    });
  });

  it("countUnreadNotifications counts unread rows", async () => {
    prismaMock.notification.count.mockResolvedValue(3);

    const { countUnreadNotifications } = await import("./notifications");
    await expect(countUnreadNotifications("user-1", "workspace-1")).resolves.toBe(3);
  });

  it("markNotificationRead marks one notification for the actor", async () => {
    const { markNotificationRead } = await import("./notifications");
    await markNotificationRead(actor, "notification-1");
    expect(prismaMock.notification.updateMany).toHaveBeenCalledWith({
      where: { id: "notification-1", userId: "user-1" },
      data: { readAt: new Date("2026-04-24T12:00:00.000Z") },
    });
  });

  it("markAllNotificationsRead marks all unread notifications for the actor", async () => {
    const { markAllNotificationsRead } = await import("./notifications");
    await markAllNotificationsRead(actor, "workspace-1");
    expect(prismaMock.notification.updateMany).toHaveBeenCalledWith({
      where: { workspaceId: "workspace-1", userId: "user-1", readAt: null },
      data: { readAt: new Date("2026-04-24T12:00:00.000Z") },
    });
  });
});
