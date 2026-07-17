import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";

const {
  prismaMock,
  sendEmailMock,
  resolveSlackNotificationRecipientMock,
  sendSlackMessageMock,
} = vi.hoisted(() => ({
  prismaMock: {
    notification: {
      findMany: vi.fn(),
      count: vi.fn(),
      updateMany: vi.fn(),
      createMany: vi.fn(),
      create: vi.fn(),
      upsert: vi.fn(),
    },
    notificationDelivery: {
      findUnique: vi.fn(),
      update: vi.fn(),
      upsert: vi.fn(),
    },
    notificationPreference: {
      findMany: vi.fn(),
    },
    member: {
      findMany: vi.fn(),
    },
    workflowJob: {
      upsert: vi.fn(),
    },
  },
  sendEmailMock: vi.fn(),
  resolveSlackNotificationRecipientMock: vi.fn(),
  sendSlackMessageMock: vi.fn(),
}));

vi.mock("@corgtex/shared", () => ({
  prisma: prismaMock,
  sendEmail: sendEmailMock,
  parseAllowedWorkspaceIds: vi.fn(() => new Set<string>()),
  env: {
    APP_URL: "https://app.example.test",
    SESSION_LAST_SEEN_WRITE_INTERVAL_MS: 5 * 60 * 1000,
  },
}));

vi.mock("./communication", () => ({
  resolveSlackNotificationRecipient: resolveSlackNotificationRecipientMock,
  sendSlackMessage: sendSlackMessageMock,
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
    prismaMock.notification.create.mockImplementation(async ({ data }: any) => ({
      id: `notification-${data.userId}`,
      ...data,
    }));
    prismaMock.notification.upsert.mockImplementation(async ({ create }: any) => ({
      id: `notification-${create.userId}`,
      ...create,
    }));
    prismaMock.notificationDelivery.upsert.mockImplementation(async ({ create }: any) => ({
      id: `delivery-${create.notificationId}-${create.channel}`,
      ...create,
    }));
    prismaMock.notificationDelivery.update.mockResolvedValue({ id: "delivery-1" });
    prismaMock.notificationDelivery.findUnique.mockResolvedValue(null);
    prismaMock.workflowJob.upsert.mockResolvedValue({ id: "job-1" });
    sendEmailMock.mockReset().mockResolvedValue({ status: "SENT", providerMessageId: "resend-1" });
    resolveSlackNotificationRecipientMock.mockReset().mockResolvedValue({
      installationId: "slack-install-1",
      externalUserId: "U1",
    });
    sendSlackMessageMock.mockReset().mockResolvedValue({ ts: "1714320000.000100" });
    prismaMock.notificationPreference.findMany.mockResolvedValue([]);
    prismaMock.member.findMany.mockResolvedValue([
      { userId: "user-1", user: { email: "user-1@example.com" } },
      { userId: "user-2", user: { email: "user-2@example.com" } },
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

  it("createNotificationIntent honors OFF without creating rows or deliveries", async () => {
    prismaMock.member.findMany.mockResolvedValue([
      { userId: "user-1", user: { email: "user-1@example.com" } },
    ]);
    prismaMock.notificationPreference.findMany.mockResolvedValue([
      { userId: "user-1", notifType: "deliberation.mention", channel: "OFF" },
    ]);

    const { createNotificationIntent } = await import("./notifications");
    await createNotificationIntent(prismaMock as any, {
      workspaceId: "workspace-1",
      type: "deliberation.mention",
      recipientUserIds: ["user-1"],
      title: "Mentioned you",
    });

    expect(prismaMock.notification.createMany).not.toHaveBeenCalled();
    expect(prismaMock.notification.create).not.toHaveBeenCalled();
    expect(prismaMock.notificationDelivery.upsert).not.toHaveBeenCalled();
    expect(prismaMock.workflowJob.upsert).not.toHaveBeenCalled();
  });

  it("createNotificationIntent creates pending email delivery jobs for outbound-eligible email preferences", async () => {
    prismaMock.notificationPreference.findMany.mockResolvedValue([
      { userId: "user-1", notifType: "deliberation.mention", channel: "EMAIL" },
    ]);

    const { createNotificationIntent } = await import("./notifications");
    await createNotificationIntent(prismaMock as any, {
      workspaceId: "workspace-1",
      type: "deliberation.mention",
      recipientUserIds: ["user-1"],
      title: "Mentioned you",
      bodyMd: "Please review this note.",
      entityType: "Tension",
      entityId: "tension-1",
      priority: "HIGH",
    });

    expect(prismaMock.notification.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: "workspace-1",
        userId: "user-1",
        type: "deliberation.mention",
        title: "Mentioned you",
        priority: "HIGH",
      }),
      select: { id: true, workspaceId: true, userId: true },
    });
    expect(prismaMock.notificationDelivery.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        notificationId: "notification-user-1",
        workspaceId: "workspace-1",
        userId: "user-1",
        channel: "EMAIL",
        status: "PENDING",
      }),
    }));
    expect(prismaMock.workflowJob.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        workspaceId: "workspace-1",
        type: "notification.delivery",
        payload: { deliveryId: "delivery-notification-user-1-EMAIL" },
      }),
    }));
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("createNotificationIntent creates pending Slack delivery jobs for outbound-eligible Slack preferences", async () => {
    prismaMock.notificationPreference.findMany.mockResolvedValue([
      { userId: "user-1", notifType: "deliberation.mention", channel: "SLACK" },
    ]);

    const { createNotificationIntent } = await import("./notifications");
    await createNotificationIntent(prismaMock as any, {
      workspaceId: "workspace-1",
      type: "deliberation.mention",
      recipientUserIds: ["user-1"],
      title: "Mentioned you",
      bodyMd: "Please review this note.",
    });

    expect(prismaMock.notification.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        workspaceId: "workspace-1",
        userId: "user-1",
        type: "deliberation.mention",
      }),
      select: { id: true, workspaceId: true, userId: true },
    }));
    expect(prismaMock.notificationDelivery.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        notificationId: "notification-user-1",
        workspaceId: "workspace-1",
        userId: "user-1",
        channel: "SLACK",
        status: "PENDING",
      }),
    }));
    expect(prismaMock.workflowJob.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        workspaceId: "workspace-1",
        type: "notification.delivery",
        payload: { deliveryId: "delivery-notification-user-1-SLACK" },
      }),
    }));
    expect(sendSlackMessageMock).not.toHaveBeenCalled();
  });

  it("createNotificationIntent does not email broad activity notifications", async () => {
    prismaMock.member.findMany.mockResolvedValue([
      { userId: "user-1", user: { email: "user-1@example.com" } },
    ]);
    prismaMock.notificationPreference.findMany.mockResolvedValue([
      { userId: "user-1", notifType: "meeting.created", channel: "EMAIL" },
    ]);

    const { createNotificationIntent } = await import("./notifications");
    await createNotificationIntent(prismaMock as any, {
      workspaceId: "workspace-1",
      type: "meeting.created",
      recipientUserIds: ["user-1"],
      title: "Meeting created",
    });

    expect(prismaMock.notification.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({ userId: "user-1", type: "meeting.created" }),
      ],
    });
    expect(prismaMock.notificationDelivery.upsert).not.toHaveBeenCalled();
    expect(prismaMock.workflowJob.upsert).not.toHaveBeenCalled();
  });

  it("createNotificationIntent does not create Slack deliveries for broad activity notifications", async () => {
    prismaMock.member.findMany.mockResolvedValue([
      { userId: "user-1", user: { email: "user-1@example.com" } },
    ]);
    prismaMock.notificationPreference.findMany.mockResolvedValue([
      { userId: "user-1", notifType: "meeting.created", channel: "SLACK" },
    ]);

    const { createNotificationIntent } = await import("./notifications");
    await createNotificationIntent(prismaMock as any, {
      workspaceId: "workspace-1",
      type: "meeting.created",
      recipientUserIds: ["user-1"],
      title: "Meeting created",
    });

    expect(prismaMock.notification.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({ userId: "user-1", type: "meeting.created" }),
      ],
    });
    expect(prismaMock.notificationDelivery.upsert).not.toHaveBeenCalled();
    expect(prismaMock.workflowJob.upsert).not.toHaveBeenCalled();
  });

  it("createNotificationIntent upserts deduped notification rows", async () => {
    const { createNotificationIntent } = await import("./notifications");
    await createNotificationIntent(prismaMock as any, {
      workspaceId: "workspace-1",
      type: "deliberation.mention",
      recipientUserIds: ["user-1"],
      title: "Mentioned you",
      dedupeKey: "mention:entry-1",
    });

    expect(prismaMock.notification.upsert).toHaveBeenCalledWith({
      where: { dedupeKey: "mention:entry-1:user-1" },
      update: {},
      create: expect.objectContaining({
        dedupeKey: "mention:entry-1:user-1",
        userId: "user-1",
      }),
      select: { id: true, workspaceId: true, userId: true },
    });
  });

  it("deliverNotificationDelivery sends email and records provider success", async () => {
    prismaMock.notificationDelivery.findUnique.mockResolvedValue({
      id: "delivery-1",
      notificationId: "notification-1",
      workspaceId: "workspace-1",
      userId: "user-1",
      channel: "EMAIL",
      status: "PENDING",
      attempts: 0,
      notification: {
        id: "notification-1",
        type: "deliberation.mention",
        title: "Mentioned you",
        bodyMd: "Please review this note.",
      },
      user: { email: "user-1@example.com" },
    });

    const { deliverNotificationDelivery } = await import("./notifications");
    await expect(deliverNotificationDelivery("delivery-1")).resolves.toEqual({ status: "SENT" });

    expect(sendEmailMock).toHaveBeenCalledWith(expect.objectContaining({
      to: "user-1@example.com",
      subject: "Mentioned you",
      tracking: expect.objectContaining({
        emailType: "notification.deliberation.mention",
        userId: "user-1",
        workspaceId: "workspace-1",
      }),
    }));
    expect(prismaMock.notificationDelivery.update).toHaveBeenCalledWith({
      where: { id: "delivery-1" },
      data: expect.objectContaining({
        status: "SENT",
        attempts: 1,
        providerMessageId: "resend-1",
        error: null,
      }),
    });
  });

  it("deliverNotificationDelivery retries transient email failures", async () => {
    prismaMock.notificationDelivery.findUnique.mockResolvedValue({
      id: "delivery-1",
      notificationId: "notification-1",
      workspaceId: "workspace-1",
      userId: "user-1",
      channel: "EMAIL",
      status: "PENDING",
      attempts: 0,
      notification: {
        id: "notification-1",
        type: "deliberation.mention",
        title: "Mentioned you",
        bodyMd: null,
      },
      user: { email: "user-1@example.com" },
    });
    sendEmailMock.mockRejectedValue(new Error("temporary resend failure"));

    const { deliverNotificationDelivery } = await import("./notifications");
    await expect(deliverNotificationDelivery("delivery-1")).rejects.toThrow("temporary resend failure");

    expect(prismaMock.notificationDelivery.update).toHaveBeenCalledWith({
      where: { id: "delivery-1" },
      data: expect.objectContaining({
        status: "PENDING",
        attempts: 1,
        failedAt: null,
        error: "temporary resend failure",
      }),
    });
  });

  it("deliverNotificationDelivery records final email failure without throwing", async () => {
    prismaMock.notificationDelivery.findUnique.mockResolvedValue({
      id: "delivery-1",
      notificationId: "notification-1",
      workspaceId: "workspace-1",
      userId: "user-1",
      channel: "EMAIL",
      status: "PENDING",
      attempts: 4,
      notification: {
        id: "notification-1",
        type: "deliberation.mention",
        title: "Mentioned you",
        bodyMd: null,
      },
      user: { email: "user-1@example.com" },
    });
    sendEmailMock.mockRejectedValue(new Error("resend still failing"));

    const { deliverNotificationDelivery } = await import("./notifications");
    await expect(deliverNotificationDelivery("delivery-1")).resolves.toEqual({ status: "FAILED" });

    expect(prismaMock.notificationDelivery.update).toHaveBeenCalledWith({
      where: { id: "delivery-1" },
      data: expect.objectContaining({
        status: "FAILED",
        attempts: 5,
        failedAt: new Date("2026-04-24T12:00:00.000Z"),
        error: "resend still failing",
      }),
    });
  });

  it("deliverNotificationDelivery sends Slack and records provider success", async () => {
    prismaMock.notificationDelivery.findUnique.mockResolvedValue({
      id: "delivery-1",
      notificationId: "notification-1",
      workspaceId: "workspace-1",
      userId: "user-1",
      channel: "SLACK",
      status: "PENDING",
      attempts: 0,
      notification: {
        id: "notification-1",
        type: "deliberation.mention",
        title: "Mentioned you",
        bodyMd: "Please review this note.",
      },
      user: { email: "user-1@example.com" },
    });

    const { deliverNotificationDelivery } = await import("./notifications");
    await expect(deliverNotificationDelivery("delivery-1")).resolves.toEqual({ status: "SENT" });

    expect(resolveSlackNotificationRecipientMock).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      userId: "user-1",
      email: "user-1@example.com",
    });
    expect(sendSlackMessageMock).toHaveBeenCalledWith(
      "slack-install-1",
      expect.objectContaining({
        channel: "U1",
        text: expect.stringContaining("Mentioned you"),
      }),
      expect.arrayContaining([
        expect.objectContaining({ type: "section" }),
      ]),
    );
    expect(prismaMock.notificationDelivery.update).toHaveBeenCalledWith({
      where: { id: "delivery-1" },
      data: expect.objectContaining({
        status: "SENT",
        attempts: 1,
        providerMessageId: "1714320000.000100",
        error: null,
      }),
    });
  });

  it("deliverNotificationDelivery records missing Slack identity and queues email fallback", async () => {
    prismaMock.notificationDelivery.findUnique.mockResolvedValue({
      id: "delivery-1",
      notificationId: "notification-1",
      workspaceId: "workspace-1",
      userId: "user-1",
      channel: "SLACK",
      status: "PENDING",
      attempts: 0,
      notification: {
        id: "notification-1",
        type: "deliberation.mention",
        title: "Mentioned you",
        bodyMd: null,
      },
      user: { email: "user-1@example.com" },
    });
    resolveSlackNotificationRecipientMock.mockResolvedValue(null);

    const { deliverNotificationDelivery } = await import("./notifications");
    await expect(deliverNotificationDelivery("delivery-1")).resolves.toEqual({ status: "SKIPPED" });

    expect(prismaMock.notificationDelivery.update).toHaveBeenCalledWith({
      where: { id: "delivery-1" },
      data: expect.objectContaining({
        status: "SKIPPED",
        attempts: 1,
        error: "Recipient user has no mapped Slack identity.",
      }),
    });
    expect(prismaMock.notificationDelivery.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        notificationId: "notification-1",
        workspaceId: "workspace-1",
        userId: "user-1",
        channel: "EMAIL",
        status: "PENDING",
      }),
    }));
    expect(prismaMock.workflowJob.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        type: "notification.delivery",
        payload: { deliveryId: "delivery-notification-1-EMAIL" },
      }),
    }));
    expect(sendSlackMessageMock).not.toHaveBeenCalled();
  });

  it("deliverNotificationDelivery records Slack failure and queues email fallback", async () => {
    prismaMock.notificationDelivery.findUnique.mockResolvedValue({
      id: "delivery-1",
      notificationId: "notification-1",
      workspaceId: "workspace-1",
      userId: "user-1",
      channel: "SLACK",
      status: "PENDING",
      attempts: 0,
      notification: {
        id: "notification-1",
        type: "deliberation.mention",
        title: "Mentioned you",
        bodyMd: null,
      },
      user: { email: "user-1@example.com" },
    });
    sendSlackMessageMock.mockRejectedValue(new Error("slack api unavailable"));

    const { deliverNotificationDelivery } = await import("./notifications");
    await expect(deliverNotificationDelivery("delivery-1")).resolves.toEqual({ status: "FAILED" });

    expect(prismaMock.notificationDelivery.update).toHaveBeenCalledWith({
      where: { id: "delivery-1" },
      data: expect.objectContaining({
        status: "FAILED",
        attempts: 1,
        failedAt: new Date("2026-04-24T12:00:00.000Z"),
        error: "slack api unavailable",
      }),
    });
    expect(prismaMock.notificationDelivery.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        notificationId: "notification-1",
        channel: "EMAIL",
        status: "PENDING",
      }),
    }));
  });
});
