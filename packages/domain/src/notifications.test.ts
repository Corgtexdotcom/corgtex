import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    notification: {
      findMany: vi.fn(),
      count: vi.fn(),
      updateMany: vi.fn(),
      createMany: vi.fn(),
    },
    notificationPreference: {
      findMany: vi.fn(),
    },
    member: {
      findMany: vi.fn(),
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
    prismaMock.notification.createMany.mockResolvedValue({ count: 1 });
    prismaMock.notificationPreference.findMany.mockResolvedValue([]);
    prismaMock.member.findMany.mockResolvedValue([
      { userId: "user-1" },
      { userId: "user-2" },
    ]);
  });

  it("listNotifications returns user notifications for a workspace", async () => {
    prismaMock.notification.findMany.mockResolvedValue([{ id: "notification-1" }]);

    const { listNotifications } = await import("./notifications");
    await expect(listNotifications(actor, "workspace-1", { unreadOnly: true, take: 10, skip: 20 })).resolves.toEqual([{ id: "notification-1" }]);
    expect(prismaMock.notification.findMany).toHaveBeenCalledWith({
      where: {
        workspaceId: "workspace-1",
        userId: "user-1",
        readAt: null,
      },
      orderBy: { createdAt: "desc" },
      take: 10,
      skip: 20,
    });
  });

  it("countUnreadNotifications counts unread rows", async () => {
    prismaMock.notification.count.mockResolvedValue(3);

    const { countUnreadNotifications } = await import("./notifications");
    await expect(countUnreadNotifications("user-1", "workspace-1")).resolves.toBe(3);
  });

  it("markNotificationRead marks one notification for the actor", async () => {
    const { markNotificationRead } = await import("./notifications");
    await markNotificationRead(actor, "workspace-1", "notification-1");
    expect(prismaMock.notification.updateMany).toHaveBeenCalledWith({
      where: { id: "notification-1", workspaceId: "workspace-1", userId: "user-1" },
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

  it("createNotificationIntent creates in-app rows for active human recipients", async () => {
    const { createNotificationIntent } = await import("./notifications");

    await createNotificationIntent(prismaMock as any, {
      workspaceId: "workspace-1",
      type: "deliberation.mention",
      recipientUserIds: ["user-1", "user-2", "actor-user"],
      actorUserId: "actor-user",
      title: "Mentioned you",
    });

    expect(prismaMock.member.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        workspaceId: "workspace-1",
        userId: { in: ["user-1", "user-2"] },
        isActive: true,
      }),
    }));
    expect(prismaMock.notification.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({ userId: "user-1", type: "deliberation.mention" }),
        expect.objectContaining({ userId: "user-2", type: "deliberation.mention" }),
      ],
    });
  });

  it("createNotificationIntent dedupes recipients, excludes the actor, and trusts the active human member query", async () => {
    prismaMock.member.findMany.mockResolvedValue([{ userId: "user-2" }]);

    const { createNotificationIntent } = await import("./notifications");
    await createNotificationIntent(prismaMock as any, {
      workspaceId: "workspace-1",
      type: "deliberation.mention",
      recipientUserIds: ["user-1", "user-1", "user-2", "actor-user"],
      actorUserId: "actor-user",
      title: "Mentioned you",
    });

    expect(prismaMock.member.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        workspaceId: "workspace-1",
        userId: { in: ["user-1", "user-2"] },
        isActive: true,
      }),
    }));
    expect(prismaMock.notification.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({ userId: "user-2" }),
      ],
    });
  });

  it("createNotificationIntent applies exact preferences before global defaults", async () => {
    prismaMock.notificationPreference.findMany.mockResolvedValue([
      { userId: "user-1", notifType: "*", channel: "OFF" },
      { userId: "user-1", notifType: "deliberation.mention", channel: "IN_APP" },
      { userId: "user-2", notifType: "*", channel: "OFF" },
    ]);

    const { createNotificationIntent } = await import("./notifications");
    await createNotificationIntent(prismaMock as any, {
      workspaceId: "workspace-1",
      type: "deliberation.mention",
      recipientUserIds: ["user-1", "user-2"],
      title: "Mentioned you",
    });

    expect(prismaMock.notification.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({ userId: "user-1" }),
      ],
    });
  });

  it("createNotificationIntent honors OFF without dropping email-only users before email delivery exists", async () => {
    prismaMock.notificationPreference.findMany.mockResolvedValue([
      { userId: "user-1", notifType: "deliberation.mention", channel: "OFF" },
      { userId: "user-2", notifType: "deliberation.mention", channel: "EMAIL" },
    ]);

    const { createNotificationIntent } = await import("./notifications");
    await createNotificationIntent(prismaMock as any, {
      workspaceId: "workspace-1",
      type: "deliberation.mention",
      recipientUserIds: ["user-1", "user-2"],
      title: "Mentioned you",
    });

    expect(prismaMock.notification.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({ userId: "user-2" }),
      ],
    });
  });
});
