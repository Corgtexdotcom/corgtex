import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";
import { AppError } from "./errors";

const {
  prismaMock,
  sendEmailMock,
  resolveSlackNotificationRecipientMock,
  sendSlackMessageMock,
} = vi.hoisted(() => ({
  prismaMock: {
    $executeRaw: vi.fn(),
    $transaction: vi.fn(),
    communicationInstallation: { findFirst: vi.fn() },
    communicationExternalUser: { findFirst: vi.fn() },
    user: { findFirst: vi.fn() },
    workspaceSupportGrant: { findUnique: vi.fn().mockResolvedValue(null) },
    notification: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
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
      findUnique: vi.fn(),
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

vi.mock("./auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./auth")>();
  return { ...actual, requireWorkspaceMembership: (params: Parameters<typeof actual.requireWorkspaceMembership>[0]) => {
    // Operator fixtures also have an explicit ADMIN membership.
    if (params.actor.kind === "user" && params.actor.user.globalRole === "OPERATOR") {
      return actual.requireWorkspaceMembership({ ...params, resolvedMembership: {
        id: "fixture-admin", workspaceId: params.workspaceId, userId: params.actor.user.id, role: "ADMIN", isActive: true,
      } });
    }
    return actual.requireWorkspaceMembership(params);
  } };
});

vi.mock("@corgtex/shared", () => ({
  setSupportAuthorizationActor: vi.fn(),
  getMcpOrigin: () => undefined,
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

const lineageMocks = vi.hoisted(() => ({ prepare: vi.fn(), finish: vi.fn(), readable: vi.fn(), capture: vi.fn(), release: vi.fn() }));
vi.mock("./producer-lineage", () => ({ prepareProducerLineage: lineageMocks.prepare, finishProducerLineage: lineageMocks.finish }));
vi.mock("./source-lineage", () => ({
  readableArtifactIds: lineageMocks.readable,
  captureArtifactInputProof: lineageMocks.capture,
  captureArtifactReadHeadObservation: async (read: () => Promise<unknown>) => ({ value: await read(), heads: new Map() }),
  mergeLineageInputRoot: (_previous: unknown, root: unknown) => root,
  sealArtifactInputActor: (reader: AppActor) => reader,
  withArtifactCountReleaseSnapshot: lineageMocks.release,
}));

const epochMocks = vi.hoisted(() => ({ capture: vi.fn(), current: vi.fn() }));
vi.mock("./source-permission-epochs", async importOriginal => ({
  ...await importOriginal<typeof import("./source-permission-epochs")>(),
  capturePermissionEpochs: epochMocks.capture,
  isArtifactPermissionEpochProofCurrent: epochMocks.current,
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
    prismaMock.$transaction.mockReset().mockImplementation(async work => work(prismaMock));
    prismaMock.communicationInstallation.findFirst.mockReset().mockResolvedValue({ id: "slack-install-1", workspaceId: "workspace-1", provider: "SLACK", status: "ACTIVE", botTokenEnc: "synthetic", disconnectedAt: null });
    prismaMock.communicationExternalUser.findFirst.mockReset().mockResolvedValue({ id: "mapping-1", installationId: "slack-install-1", workspaceId: "workspace-1", provider: "SLACK", externalUserId: "U1", userId: "user-1", isBot: false, isDeleted: false, updatedAt: new Date("2026-01-01") });
    epochMocks.capture.mockReset().mockResolvedValue({ version: 1, policyVersion: "pun68-permissions-v3", entries: [] });
    epochMocks.current.mockReset().mockResolvedValue(true);
    lineageMocks.prepare.mockReset().mockImplementation(async ({ capture }) => capture?.lineageRoots?.length
      ? { mode: "DERIVED", inputs: [], roots: capture.lineageRoots } : { mode: "UNKNOWN" });
    lineageMocks.finish.mockReset().mockResolvedValue(undefined);
    lineageMocks.readable.mockReset().mockImplementation(async (_actor, _workspace, _kind, rows) => new Set(rows.map((row: { id: string }) => row.id)));
    lineageMocks.capture.mockReset().mockImplementation(async (_actor, _workspace, inputs) => {
      const admitted = await lineageMocks.readable(_actor, _workspace, inputs[0]?.kind, inputs);
      if (inputs.some((input: { id: string }) => !admitted.has(input.id))) throw new AppError(403, "SOURCE_RESTRICTED", "Fixture source restricted");
      return inputs.map((input: { kind: string; id: string }) => ({ kind: input.kind, id: input.id, fingerprint: input.id }));
    });
    lineageMocks.release.mockReset().mockImplementation(async (_actor, _workspace, _roots, remote, finish) => {
      await remote();
      return finish(prismaMock);
    });
    prismaMock.notification.findUnique.mockReset().mockResolvedValue(null);
    prismaMock.notification.findMany.mockReset().mockResolvedValue([{ id: "notification-1", createdAt: new Date("2026-04-24") }]);
    prismaMock.member.findUnique.mockReset().mockResolvedValue({ id: "member-1", workspaceId: "workspace-1", userId: "user-1", role: "CONTRIBUTOR", isActive: true });
    prismaMock.user.findFirst.mockReset().mockResolvedValue({ id: "user-1", email: "user-1@example.com", displayName: "User", globalRole: "USER" });
    prismaMock.notification.findFirst.mockReset().mockImplementation(async () => {
      const delivery = await prismaMock.notificationDelivery.findUnique();
      return delivery ? { ...delivery.notification, workspaceId: delivery.workspaceId, userId: delivery.userId } : null;
    });
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
    prismaMock.notification.findMany.mockResolvedValue([{ id: "notification-1", createdAt: new Date("2026-04-24") }]);

    const { listNotifications } = await import("./notifications");
    await expect(listNotifications(actor, "workspace-1", { unreadOnly: true, take: 10, skip: 0 })).resolves.toEqual([{ id: "notification-1", createdAt: new Date("2026-04-24") }]);
    expect(prismaMock.notification.findMany).toHaveBeenCalledWith({
      where: {
        workspaceId: "workspace-1",
        userId: "user-1",
        readAt: null,
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 100,
    });
  });

  it("countUnreadNotifications counts unread rows", async () => {
    prismaMock.notification.findMany.mockResolvedValue(["n1", "n2", "n3"].map(id => ({ id, createdAt: new Date("2026-04-24") })));

    const { countUnreadNotifications } = await import("./notifications");
    await expect(countUnreadNotifications(actor, "workspace-1")).resolves.toBe(3);
  });

  it("preserves an exact zero only for a complete empty notification result", async () => {
    prismaMock.notification.findMany.mockResolvedValue([]);
    const { countUnreadNotifications, getUnreadNotificationSummary } = await import("./notifications");
    await expect(getUnreadNotificationSummary(actor, "workspace-1")).resolves.toEqual({ count: 0, complete: true, available: true });
    await expect(countUnreadNotifications(actor, "workspace-1")).resolves.toBe(0);
  });

  it("returns bounded summaries but rejects a legacy exact count when more rows remain", async () => {
    prismaMock.notification.findMany.mockResolvedValue(Array.from({ length: 100 }, (_, index) => ({
      id: `n-${index}`, createdAt: new Date("2026-04-24"),
    })));
    const { countUnreadNotifications, getUnreadNotificationSummary } = await import("./notifications");
    await expect(getUnreadNotificationSummary(actor, "workspace-1")).resolves.toEqual({ count: 100, complete: false, available: true });
    await expect(countUnreadNotifications(actor, "workspace-1")).rejects.toMatchObject({ code: "SOURCE_READ_SCAN_LIMIT" });
  });

  it("exposes continuation for a hidden window instead of returning an incomplete legacy array", async () => {
    const rows = Array.from({ length: 200 }, (_, index) => ({ id: `n-${index}`, createdAt: new Date("2026-04-24") }));
    lineageMocks.readable.mockResolvedValue(new Set());
    prismaMock.notification.findMany.mockResolvedValueOnce(rows.slice(0, 100)).mockResolvedValueOnce(rows.slice(100))
      .mockResolvedValueOnce(rows.slice(0, 100)).mockResolvedValueOnce(rows.slice(100));
    const { listNotifications, listNotificationPage } = await import("./notifications");
    await expect(listNotificationPage(actor, "workspace-1")).resolves.toMatchObject({ items: [], hasMore: true, complete: false, nextCursor: expect.any(String) });
    await expect(listNotifications(actor, "workspace-1")).rejects.toMatchObject({ code: "SOURCE_READ_SCAN_LIMIT" });
    expect(prismaMock.notification.findMany).toHaveBeenCalledTimes(4);
  });

  it("markNotificationRead marks one notification for the actor", async () => {
    const { markNotificationRead } = await import("./notifications");
    await markNotificationRead(actor, "workspace-1", "notification-1");
    expect(prismaMock.notification.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["notification-1"] }, workspaceId: "workspace-1", userId: "user-1" },
      data: { readAt: new Date("2026-04-24T12:00:00.000Z") },
    });
  });

  it("markAllNotificationsRead marks all unread notifications for the actor", async () => {
    const { markAllNotificationsRead } = await import("./notifications");
    await markAllNotificationsRead(actor, "workspace-1");
    expect(prismaMock.notification.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["notification-1"] }, workspaceId: "workspace-1", userId: "user-1", readAt: null },
      data: { readAt: new Date("2026-04-24T12:00:00.000Z") },
    });
  });

  it("withholds the single read mutation when the final original-proof release fails", async () => {
    const failure = new AppError(409, "SOURCE_CHANGED", "Synthetic original authority changed");
    lineageMocks.release.mockRejectedValue(failure);
    const { markNotificationRead } = await import("./notifications");
    await expect(markNotificationRead(actor, "workspace-1", "notification-1")).rejects.toBe(failure);
    expect(prismaMock.notification.updateMany).not.toHaveBeenCalled();
  });

  it("updates only the targeted admitted notification inside the final release transaction", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const tx = { ...prismaMock, notification: { ...prismaMock.notification, updateMany } };
    lineageMocks.release.mockImplementation(async (_actor, _workspace, roots, remote, finish) => {
      expect(roots).toEqual([{ kind: "Notification", id: "notification-1", fingerprint: "notification-1" }]);
      expect(prismaMock.notification.updateMany).not.toHaveBeenCalled();
      await remote();
      return finish(tx);
    });
    const { markNotificationRead } = await import("./notifications");
    await markNotificationRead(actor, "workspace-1", "notification-1");
    expect(prismaMock.notification.findMany).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      where: { id: "notification-1", workspaceId: "workspace-1", userId: "user-1" }, take: 100,
    }));
    expect(updateMany).toHaveBeenCalledExactlyOnceWith({
      where: { id: { in: ["notification-1"] }, workspaceId: "workspace-1", userId: "user-1" },
      data: { readAt: new Date("2026-04-24T12:00:00.000Z") },
    });
    expect(prismaMock.notification.updateMany).not.toHaveBeenCalled();
  });

  it("keeps missing or denied single notifications as an empty scoped update", async () => {
    lineageMocks.readable.mockResolvedValue(new Set());
    const { markNotificationRead } = await import("./notifications");
    await markNotificationRead(actor, "workspace-1", "notification-1");
    expect(prismaMock.notification.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: { in: [] }, workspaceId: "workspace-1", userId: "user-1" },
    }));
  });

  it("withholds retained rows, counts and mark-all writes when final release rejects original proofs", async () => {
    lineageMocks.release.mockRejectedValue(new Error("Synthetic authority changed"));
    const { listNotifications, countUnreadNotifications, getUnreadNotificationSummary, markAllNotificationsRead } = await import("./notifications");
    await expect(listNotifications(actor, "workspace-1")).rejects.toThrow("Synthetic authority changed");
    await expect(countUnreadNotifications(actor, "workspace-1")).rejects.toMatchObject({ code: "SOURCE_READ_SCAN_LIMIT" });
    await expect(getUnreadNotificationSummary(actor, "workspace-1")).resolves.toEqual({ count: 0, complete: false, available: false });
    await expect(markAllNotificationsRead(actor, "workspace-1")).rejects.toThrow("Synthetic authority changed");
    expect(prismaMock.notification.updateMany).not.toHaveBeenCalled();
    expect(lineageMocks.release).toHaveBeenCalledWith(actor, "workspace-1", [{
      kind: "Notification", id: "notification-1", fingerprint: "notification-1",
    }], expect.any(Function), expect.any(Function), expect.any(Map));
  });

  it("createNotificationIntent creates in-app rows for active human recipients", async () => {
    const { createNotificationIntent } = await import("./notifications");

    await createNotificationIntent(prismaMock as any, {
      lineageActor: actor, lineageRoots: [{ kind: "Tension", id: "tension-1", fingerprint: "a".repeat(64) }],
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
    expect(prismaMock.notification.create).toHaveBeenCalledWith({ data: expect.objectContaining({ userId: "user-1", type: "deliberation.mention" }) });
    expect(prismaMock.notification.create).toHaveBeenCalledWith({ data: expect.objectContaining({ userId: "user-2", type: "deliberation.mention" }) });
  });

  it.each([
    new Error("Synthetic proof database unavailable"),
    new AppError(503, "DATABASE_UNAVAILABLE", "Synthetic proof outage"),
    new AppError(409, "SOURCE_CHANGED", "Original proof changed"),
  ])("propagates retryable intent proof failure instead of reporting success: %s", async failure => {
    lineageMocks.readable.mockRejectedValueOnce(failure);
    prismaMock.notificationPreference.findMany.mockResolvedValue([
      { userId: "user-1", notifType: "deliberation.mention", channel: "EMAIL" },
      { userId: "user-2", notifType: "deliberation.mention", channel: "EMAIL" },
    ]);
    const { createNotificationIntent } = await import("./notifications");
    await expect(createNotificationIntent(prismaMock as any, {
      lineageActor: actor, lineageRoots: [{ kind: "Tension", id: "tension-1", fingerprint: "a".repeat(64) }],
      workspaceId: "workspace-1", type: "deliberation.mention", recipientUserIds: ["user-1", "user-2"], title: "Retry intent",
    })).rejects.toBe(failure);
    expect(prismaMock.notificationDelivery.upsert).not.toHaveBeenCalled();
    expect(prismaMock.workflowJob.upsert).not.toHaveBeenCalled();
  });

  it.each(["AUTH_REQUIRED", "NOT_A_MEMBER", "SOURCE_RESTRICTED", "UNKNOWN_LINEAGE"])(
    "keeps other recipients eligible when one intent recipient is definitively denied: %s", async code => {
      lineageMocks.readable.mockRejectedValueOnce(new AppError(403, code, "Denied recipient"));
      prismaMock.notificationPreference.findMany.mockResolvedValue([
        { userId: "user-1", notifType: "deliberation.mention", channel: "EMAIL" },
        { userId: "user-2", notifType: "deliberation.mention", channel: "EMAIL" },
      ]);
      const { createNotificationIntent } = await import("./notifications");
      expect(await createNotificationIntent(prismaMock as any, {
        lineageActor: actor, lineageRoots: [{ kind: "Tension", id: "tension-1", fingerprint: "a".repeat(64) }],
        workspaceId: "workspace-1", type: "deliberation.mention", recipientUserIds: ["user-1", "user-2"], title: "Mixed recipients",
      })).toEqual({ count: 2 });
      expect(prismaMock.notificationDelivery.upsert).toHaveBeenCalledTimes(1);
      expect(prismaMock.notificationDelivery.upsert).toHaveBeenCalledWith(expect.objectContaining({
        create: expect.objectContaining({ notificationId: "notification-user-2", userId: "user-2" }),
      }));
    });

  it("createNotificationIntent dedupes recipients, excludes the actor, and trusts the active human member query", async () => {
    prismaMock.member.findMany.mockResolvedValue([{ userId: "user-2" }]);

    const { createNotificationIntent } = await import("./notifications");
    await createNotificationIntent(prismaMock as any, {
      lineageActor: actor, lineageRoots: [{ kind: "Tension", id: "tension-1", fingerprint: "a".repeat(64) }],
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
    expect(prismaMock.notification.create).toHaveBeenCalledWith({ data: expect.objectContaining({ userId: "user-2" }) });
  });

  it("createNotificationIntent applies exact preferences before global defaults", async () => {
    prismaMock.notificationPreference.findMany.mockResolvedValue([
      { userId: "user-1", notifType: "*", channel: "OFF" },
      { userId: "user-1", notifType: "deliberation.mention", channel: "IN_APP" },
      { userId: "user-2", notifType: "*", channel: "OFF" },
    ]);

    const { createNotificationIntent } = await import("./notifications");
    await createNotificationIntent(prismaMock as any, {
      lineageActor: actor, lineageRoots: [{ kind: "Tension", id: "tension-1", fingerprint: "a".repeat(64) }],
      workspaceId: "workspace-1",
      type: "deliberation.mention",
      recipientUserIds: ["user-1", "user-2"],
      title: "Mentioned you",
    });

    expect(prismaMock.notification.create).toHaveBeenCalledWith({ data: expect.objectContaining({ userId: "user-1" }) });
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
      lineageActor: actor, lineageRoots: [{ kind: "Tension", id: "tension-1", fingerprint: "a".repeat(64) }],
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
      lineageActor: actor, lineageRoots: [{ kind: "Tension", id: "tension-1", fingerprint: "a".repeat(64) }],
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
      lineageActor: actor, lineageRoots: [{ kind: "Tension", id: "tension-1", fingerprint: "a".repeat(64) }],
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
      lineageActor: actor, lineageRoots: [{ kind: "Tension", id: "tension-1", fingerprint: "a".repeat(64) }],
      workspaceId: "workspace-1",
      type: "meeting.created",
      recipientUserIds: ["user-1"],
      title: "Meeting created",
    });

    expect(prismaMock.notification.create).toHaveBeenCalledWith({ data: expect.objectContaining({ userId: "user-1", type: "meeting.created" }) });
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
      lineageActor: actor, lineageRoots: [{ kind: "Tension", id: "tension-1", fingerprint: "a".repeat(64) }],
      workspaceId: "workspace-1",
      type: "meeting.created",
      recipientUserIds: ["user-1"],
      title: "Meeting created",
    });

    expect(prismaMock.notification.create).toHaveBeenCalledWith({ data: expect.objectContaining({ userId: "user-1", type: "meeting.created" }) });
    expect(prismaMock.notificationDelivery.upsert).not.toHaveBeenCalled();
    expect(prismaMock.workflowJob.upsert).not.toHaveBeenCalled();
  });

  it("createNotificationIntent upserts deduped notification rows", async () => {
    const { createNotificationIntent } = await import("./notifications");
    await createNotificationIntent(prismaMock as any, {
      lineageActor: actor, lineageRoots: [{ kind: "Tension", id: "tension-1", fingerprint: "a".repeat(64) }],
      workspaceId: "workspace-1",
      type: "deliberation.mention",
      recipientUserIds: ["user-1"],
      title: "Mentioned you",
      dedupeKey: "mention:entry-1",
    });

    expect(prismaMock.notification.findUnique).toHaveBeenCalledWith({ where: { dedupeKey: "mention:entry-1:user-1" } });
    expect(prismaMock.notification.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        dedupeKey: "mention:entry-1:user-1",
        userId: "user-1",
      }),
    });
  });

  it("stores missing receipts as unknown atomically without queuing copied content", async () => {
    prismaMock.notificationPreference.findMany.mockResolvedValue([
      { userId: "user-1", notifType: "deliberation.mention", channel: "EMAIL" },
    ]);
    const { createNotificationIntent } = await import("./notifications");
    await createNotificationIntent(prismaMock as any, {
      workspaceId: "workspace-1", type: "deliberation.mention", recipientUserIds: ["user-1"],
      title: "Copied restricted title",
    });
    expect(lineageMocks.finish).toHaveBeenCalledWith(expect.objectContaining({
      tx: prismaMock, artifact: { kind: "Notification", id: "notification-user-1" }, receipt: { mode: "UNKNOWN" },
    }));
    expect(prismaMock.notificationDelivery.upsert).not.toHaveBeenCalled();
  });

  it("does not recertify deduped content with a retry's different roots", async () => {
    prismaMock.notification.findUnique.mockResolvedValue({ id: "old", workspaceId: "workspace-1", userId: "user-1", title: "Old payload" });
    lineageMocks.readable.mockResolvedValue(new Set());
    const { createNotificationIntent } = await import("./notifications");
    await createNotificationIntent(prismaMock as any, {
      lineageActor: actor, lineageRoots: [{ kind: "Tension", id: "new", fingerprint: "a".repeat(64) }],
      workspaceId: "workspace-1", type: "deliberation.mention", recipientUserIds: ["user-1"],
      title: "New payload", dedupeKey: "same",
    });
    expect(prismaMock.notification.create).not.toHaveBeenCalled();
    expect(lineageMocks.finish).not.toHaveBeenCalled();
    expect(prismaMock.notificationDelivery.upsert).not.toHaveBeenCalled();
  });

  it("filters unavailable sources before list pagination and unread counts", async () => {
    prismaMock.notification.findMany.mockResolvedValue(["hidden", "shown-1", "shown-2"].map(id => ({ id, createdAt: new Date("2026-04-24") })));
    lineageMocks.readable.mockResolvedValue(new Set(["shown-1", "shown-2"]));
    const { listNotifications, countUnreadNotifications } = await import("./notifications");
    await expect(listNotifications(actor, "workspace-1", { skip: 1, take: 1 })).resolves.toEqual([{ id: "shown-2", createdAt: new Date("2026-04-24") }]);
    await expect(countUnreadNotifications(actor, "workspace-1")).resolves.toBe(2);
  });

  it.each(["EMAIL", "SLACK"])("withholds queued %s content after recipient revocation", async (channel) => {
    prismaMock.notificationDelivery.findUnique.mockResolvedValue({
      id: "delivery-1", notificationId: "notification-1", workspaceId: "workspace-1", userId: "user-1",
      channel, status: "PENDING", attempts: 0, user: { email: "old@example.com" },
      notification: { id: "notification-1", title: "Restricted", bodyMd: "Restricted" },
    });
    prismaMock.user.findFirst.mockResolvedValue(null);
    const { deliverNotificationDelivery } = await import("./notifications");
    await expect(deliverNotificationDelivery("delivery-1")).resolves.toEqual({ status: "SKIPPED" });
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(sendSlackMessageMock).not.toHaveBeenCalled();
  });

  it.each(["EMAIL", "SLACK"])("rechecks source access immediately before %s publication", async (channel) => {
    prismaMock.notificationDelivery.findUnique.mockResolvedValue({
      id: "delivery-1", notificationId: "notification-1", workspaceId: "workspace-1", userId: "user-1",
      channel, status: "PENDING", attempts: 0, user: { email: "user-1@example.com" },
      notification: { id: "notification-1", title: "Restricted", bodyMd: "Restricted" },
    });
    lineageMocks.readable.mockResolvedValueOnce(new Set(["notification-1"])).mockResolvedValue(new Set());
    const { deliverNotificationDelivery } = await import("./notifications");
    await expect(deliverNotificationDelivery("delivery-1")).resolves.toEqual({ status: "SKIPPED" });
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(sendSlackMessageMock).not.toHaveBeenCalled();
  });

  it.each([
    ["EMAIL", 1], ["EMAIL", 2], ["SLACK", 1], ["SLACK", 2],
  ] as const)("retries %s after a transient proof failure at admission %s", async (channel, admission) => {
    const delivery = {
      id: "delivery-1", notificationId: "notification-1", workspaceId: "workspace-1", userId: "user-1",
      channel, status: "PENDING", attempts: 0, user: { email: "user-1@example.com" },
      notification: { id: "notification-1", type: "deliberation.mention", title: "Synthetic notification", bodyMd: null },
    };
    prismaMock.notificationDelivery.findUnique.mockResolvedValue(delivery);
    const failure = new Error("Synthetic temporary lineage database failure");
    if (admission === 2) lineageMocks.readable.mockResolvedValueOnce(new Set(["notification-1"]));
    lineageMocks.readable.mockRejectedValueOnce(failure);
    const { deliverNotificationDelivery } = await import("./notifications");
    await expect(deliverNotificationDelivery("delivery-1")).rejects.toBe(failure);
    expect(prismaMock.notificationDelivery.update).not.toHaveBeenCalled();
    expect(prismaMock.notificationDelivery.upsert).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(sendSlackMessageMock).not.toHaveBeenCalled();
    await expect(deliverNotificationDelivery("delivery-1")).resolves.toEqual({ status: "SENT" });
    expect(channel === "EMAIL" ? sendEmailMock : sendSlackMessageMock).toHaveBeenCalledOnce();
  });

  it.each(["NOT_A_MEMBER", "SOURCE_RESTRICTED"])("keeps definitive %s admission denial terminal and unsent", async code => {
    prismaMock.notificationDelivery.findUnique.mockResolvedValue({
      id: "delivery-1", notificationId: "notification-1", workspaceId: "workspace-1", userId: "user-1",
      channel: "SLACK", status: "PENDING", attempts: 0, user: { email: "user-1@example.com" },
      notification: { id: "notification-1", title: "Denied", bodyMd: null },
    });
    lineageMocks.readable.mockRejectedValueOnce(new AppError(403, code, "Synthetic denied source"));
    const { deliverNotificationDelivery } = await import("./notifications");
    await expect(deliverNotificationDelivery("delivery-1")).resolves.toEqual({ status: "SKIPPED" });
    expect(prismaMock.notificationDelivery.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "SKIPPED" }),
    }));
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(sendSlackMessageMock).not.toHaveBeenCalled();
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
    }), expect.objectContaining({ authorizeAttempt: expect.any(Function), signal: expect.any(AbortSignal) }));
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

  it.each((["credentials", "retry"] as const).flatMap(boundary =>
    (["source", "recipient", "none"] as const).map(change => ({ boundary, change }))))("retains original Slack notification authority across $boundary/$change", async ({ boundary, change }) => {
    const delivery = { id: "delivery-1", notificationId: "notification-1", workspaceId: "workspace-1", userId: "user-1",
      channel: "SLACK", status: "PENDING", attempts: 0, user: { email: "user-1@example.com" },
      notification: { id: "notification-1", type: "deliberation.mention", title: "Private notice", bodyMd: "Private original body" } };
    prismaMock.notificationDelivery.findUnique.mockResolvedValue(delivery);
    let changed = false; let sends = 0; const denied = new AppError(409, "SOURCE_CHANGED", "Original proof revoked and restored.");
    lineageMocks.release.mockImplementation(async (_actor, _ws, roots, remote, finish) => {
      expect(roots).toEqual([expect.objectContaining({ kind: "Notification", id: "notification-1", fingerprint: "notification-1" })]);
      if (changed && change === "source") throw denied;
      await remote(); return finish(prismaMock);
    });
    const mutate = () => { changed = true; if (change === "recipient") prismaMock.user.findFirst.mockResolvedValue(null); };
    sendSlackMessageMock.mockImplementation(async (_installation, _target, _blocks, _token, controls) => {
      if (boundary === "retry") { await controls?.authorizeAttempt({ signal: controls.signal }); sends++; }
      mutate();
      await controls?.authorizeAttempt({ signal: controls.signal }); sends++;
      return { ts: "sent" };
    });
    const { deliverNotificationDelivery } = await import("./notifications");
    const result = await deliverNotificationDelivery("delivery-1").catch(error => error);
    expect(sends).toBe(change === "none" ? (boundary === "retry" ? 2 : 1) : (boundary === "retry" ? 1 : 0));
    if (change === "none") expect(result).toEqual({ status: "SENT" });
    else {
      expect(result).toBeInstanceOf(Error);
      expect(prismaMock.notificationDelivery.upsert).not.toHaveBeenCalled();
      expect(prismaMock.notificationDelivery.update).not.toHaveBeenCalled();
    }
  });

  it.each((["credentials", "retry"] as const).flatMap(boundary =>
    (["source", "recipient", "email", "none"] as const).map(change => ({ boundary, change }))))("retains original email authority at $boundary/$change", async ({ boundary, change }) => {
    prismaMock.notificationDelivery.findUnique.mockResolvedValue({ id: "delivery-1", notificationId: "notification-1", workspaceId: "workspace-1", userId: "user-1",
      channel: "EMAIL", status: "PENDING", attempts: 4, user: { email: "user-1@example.com" }, notification: { id: "notification-1", type: "deliberation.mention", title: "Notice" } });
    let changed = false; let sends = 0;
    lineageMocks.release.mockImplementation(async (_actor, _ws, roots, remote, finish) => {
      expect(roots).toEqual([expect.objectContaining({ kind: "Notification", id: "notification-1" })]);
      if (changed && change === "source") throw new AppError(409, "SOURCE_CHANGED", "Original receipt changed");
      await remote(); return finish(prismaMock);
    });
    sendEmailMock.mockImplementation(async (_params, controls) => {
      if (boundary === "retry") { await controls?.authorizeAttempt({ signal: controls.signal }); sends++; }
      changed = true;
      if (change === "recipient") prismaMock.user.findFirst.mockResolvedValue(null);
      if (change === "email") prismaMock.user.findFirst.mockResolvedValue({ id: "user-1", email: "replacement@example.test", globalRole: "USER" });
      await controls?.authorizeAttempt({ signal: controls.signal }); sends++;
      return { status: "SENT", providerMessageId: "synthetic" };
    });
    const { deliverNotificationDelivery } = await import("./notifications");
    const result = await deliverNotificationDelivery("delivery-1").catch(error => error);
    expect(sends).toBe(change === "none" ? (boundary === "retry" ? 2 : 1) : boundary === "retry" ? 1 : 0);
    if (change === "none") expect(result).toEqual({ status: "SENT" });
    else { expect(result).toBeInstanceOf(Error); expect(prismaMock.notificationDelivery.update).not.toHaveBeenCalled(); }
  });

  it("keeps a swallowed email guard failure fatal even on the final delivery attempt", async () => {
    prismaMock.notificationDelivery.findUnique.mockResolvedValue({ id: "delivery-1", notificationId: "notification-1", workspaceId: "workspace-1", userId: "user-1",
      channel: "EMAIL", status: "PENDING", attempts: 4, user: { email: "user-1@example.com" }, notification: { id: "notification-1", type: "deliberation.mention", title: "Notice" } });
    const failure = new Error("Proof infrastructure unavailable"); let rejected = false;
    sendEmailMock.mockImplementation(async (_params, controls) => {
      lineageMocks.release.mockRejectedValueOnce(failure);
      try { await controls?.authorizeAttempt({ signal: controls.signal }); } catch { rejected = true; }
      return { status: "SENT", providerMessageId: "ignored-guard" };
    });
    const { deliverNotificationDelivery } = await import("./notifications");
    const result = await deliverNotificationDelivery("delivery-1").catch(error => error);
    expect(rejected).toBe(true); expect(result).toBe(failure);
    expect(prismaMock.notificationDelivery.update).not.toHaveBeenCalled();
  });

  it.each((["credentials", "retry"] as const).flatMap(boundary =>
    (["installation", "replacement", "mapping", "mapping-restore", "epochs", "none"] as const).map(change => ({ boundary, change }))))("retains selected Slack binding at $boundary/$change", async ({ boundary, change }) => {
    prismaMock.notificationDelivery.findUnique.mockResolvedValue({ id: "delivery-1", notificationId: "notification-1", workspaceId: "workspace-1", userId: "user-1",
      channel: "SLACK", status: "PENDING", attempts: 0, user: { email: "user-1@example.com" }, notification: { id: "notification-1", type: "deliberation.mention", title: "Notice" } });
    let sends = 0;
    sendSlackMessageMock.mockImplementation(async (_id, _target, _blocks, _token, controls) => {
      if (boundary === "retry") { await controls?.authorizeAttempt({ signal: controls.signal }); sends++; }
      if (change === "installation") prismaMock.communicationInstallation.findFirst.mockResolvedValue(null);
      if (change === "replacement") prismaMock.communicationInstallation.findFirst.mockResolvedValue({ id: "replacement-installation" });
      if (change === "mapping") prismaMock.communicationExternalUser.findFirst.mockResolvedValue({ id: "mapping-1", externalUserId: "OTHER" });
      if (change === "mapping-restore") {
        const previous = await prismaMock.communicationExternalUser.findFirst();
        prismaMock.communicationExternalUser.findFirst.mockResolvedValue({ ...previous, updatedAt: new Date("2026-01-02") });
      }
      if (change === "epochs") epochMocks.current.mockResolvedValue(false);
      await controls?.authorizeAttempt({ signal: controls.signal }); sends++;
      return { ts: "synthetic" };
    });
    const { deliverNotificationDelivery } = await import("./notifications");
    const result = await deliverNotificationDelivery("delivery-1").catch(error => error);
    expect(sends).toBe(change === "none" ? (boundary === "retry" ? 2 : 1) : boundary === "retry" ? 1 : 0);
    if (change === "none") expect(result).toEqual({ status: "SENT" });
    else { expect(result).toBeInstanceOf(Error); expect(prismaMock.notificationDelivery.update).not.toHaveBeenCalled(); expect(prismaMock.notificationDelivery.upsert).not.toHaveBeenCalled(); }
  });

  it("withholds a delivery when original proof capture definitively denies after admission", async () => {
    prismaMock.notificationDelivery.findUnique.mockResolvedValue({ id: "delivery-1", notificationId: "notification-1", workspaceId: "workspace-1", userId: "user-1",
      channel: "SLACK", status: "PENDING", attempts: 0, user: { email: "user-1@example.com" }, notification: { id: "notification-1", type: "deliberation.mention", title: "Notice" } });
    lineageMocks.capture.mockRejectedValueOnce(new AppError(409, "UNKNOWN_LINEAGE", "Original proof unavailable."));
    const { deliverNotificationDelivery } = await import("./notifications");
    expect(await deliverNotificationDelivery("delivery-1")).toEqual({ status: "SKIPPED" });
    expect(sendSlackMessageMock).not.toHaveBeenCalled();
    expect(prismaMock.notificationDelivery.upsert).not.toHaveBeenCalled();
  });

  it("does not swallow a notification attempt proof failure or queue fallback after an adapter restores authority", async () => {
    prismaMock.notificationDelivery.findUnique.mockResolvedValue({ id: "delivery-1", notificationId: "notification-1", workspaceId: "workspace-1", userId: "user-1",
      channel: "SLACK", status: "PENDING", attempts: 0, user: { email: "user-1@example.com" }, notification: { id: "notification-1", title: "Private", bodyMd: null } });
    const failure = new Error("Temporary proof backend unavailable"); let rejected = false;
    sendSlackMessageMock.mockImplementation(async (_installation, _target, _blocks, _token, controls) => {
      lineageMocks.release.mockRejectedValueOnce(failure);
      await controls?.authorizeAttempt({ signal: controls.signal }).catch(() => { rejected = true; });
      return { ts: "not-actually-sent" };
    });
    const { deliverNotificationDelivery } = await import("./notifications");
    const result = await deliverNotificationDelivery("delivery-1").catch(error => error);
    expect(rejected).toBe(true); expect(result).toBe(failure);
    expect(prismaMock.notificationDelivery.update).not.toHaveBeenCalled();
    expect(prismaMock.notificationDelivery.upsert).not.toHaveBeenCalled();
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
      undefined, expect.objectContaining({ authorizeAttempt: expect.any(Function), signal: expect.any(AbortSignal) }),
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
