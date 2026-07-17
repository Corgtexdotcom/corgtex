import type { Prisma } from "@prisma/client";
import { prisma } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import { requireWorkspaceMembership } from "./auth";
import { humanMemberIdentityWhere } from "./member-identity";

export const DEFAULT_NOTIFICATION_CHANNEL = "IN_APP";

export const STORED_NOTIFICATION_CHANNELS = [
  "IN_APP",
  "EMAIL",
  "BOTH",
  "OFF",
] as const;

export const NOTIFICATION_PREFERENCE_CHANNELS = [
  ...STORED_NOTIFICATION_CHANNELS,
  "USE_DEFAULT",
] as const;

export type StoredNotificationChannel = typeof STORED_NOTIFICATION_CHANNELS[number];
export type NotificationPreferenceChannel = typeof NOTIFICATION_PREFERENCE_CHANNELS[number];
export type NotificationPriority = "LOW" | "NORMAL" | "HIGH";

export type NotificationIntentParams = {
  workspaceId: string;
  type: string;
  recipientUserIds: string[];
  title: string;
  bodyMd?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  actorUserId?: string | null;
  priority?: NotificationPriority;
  dedupeKey?: string | null;
};

export function isNotificationPreferenceChannel(value: string): value is NotificationPreferenceChannel {
  return (NOTIFICATION_PREFERENCE_CHANNELS as readonly string[]).includes(value);
}

function storedChannel(value: string | null | undefined): StoredNotificationChannel {
  if ((STORED_NOTIFICATION_CHANNELS as readonly string[]).includes(value ?? "")) {
    return value as StoredNotificationChannel;
  }
  return DEFAULT_NOTIFICATION_CHANNEL;
}

function channelEnablesInApp(channel: StoredNotificationChannel) {
  return channel !== "OFF";
}

function effectiveChannels(preferences: Array<{ userId: string; notifType: string; channel: string }>, userId: string, type: string) {
  const exact = preferences.find((preference) => preference.userId === userId && preference.notifType === type);
  const globalDefault = preferences.find((preference) => preference.userId === userId && preference.notifType === "*");
  return storedChannel(exact?.channel ?? globalDefault?.channel ?? DEFAULT_NOTIFICATION_CHANNEL);
}

export async function createNotificationIntent(
  tx: Prisma.TransactionClient,
  params: NotificationIntentParams,
) {
  const recipientUserIds = Array.from(new Set(params.recipientUserIds.filter(Boolean)))
    .filter((userId) => userId !== params.actorUserId);
  if (recipientUserIds.length === 0) {
    return { count: 0 };
  }

  const activeRecipients = await tx.member.findMany({
    where: {
      workspaceId: params.workspaceId,
      userId: { in: recipientUserIds },
      isActive: true,
      ...humanMemberIdentityWhere(),
    },
    select: { userId: true },
  });
  if (activeRecipients.length === 0) {
    return { count: 0 };
  }

  const activeRecipientUserIds = Array.from(new Set(activeRecipients.map((member) => member.userId)));
  const preferences = await tx.notificationPreference.findMany({
    where: {
      userId: { in: activeRecipientUserIds },
      notifType: { in: [params.type, "*"] },
    },
    select: {
      userId: true,
      notifType: true,
      channel: true,
    },
  });

  const inAppRecipientUserIds = activeRecipientUserIds.filter((userId) => (
    channelEnablesInApp(effectiveChannels(preferences, userId, params.type))
  ));
  if (inAppRecipientUserIds.length === 0) {
    return { count: 0 };
  }

  return tx.notification.createMany({
    data: inAppRecipientUserIds.map((userId) => ({
      workspaceId: params.workspaceId,
      userId,
      type: params.type,
      entityType: params.entityType ?? null,
      entityId: params.entityId ?? null,
      title: params.title,
      bodyMd: params.bodyMd ?? null,
    })),
  });
}

export async function listNotifications(actor: AppActor, workspaceId: string, opts?: {
  unreadOnly?: boolean;
  take?: number;
  skip?: number;
}) {
  const userId = actor.kind === "user" ? actor.user.id : null;
  if (!userId) return [];

  await requireWorkspaceMembership({ actor, workspaceId });

  return prisma.notification.findMany({
    where: {
      workspaceId,
      userId,
      ...(opts?.unreadOnly ? { readAt: null } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: opts?.take ?? 30,
    skip: opts?.skip,
  });
}

export async function countUnreadNotifications(userId: string, workspaceId: string) {
  return prisma.notification.count({
    where: { workspaceId, userId, readAt: null },
  });
}

export async function markNotificationRead(actor: AppActor, workspaceId: string, notificationId: string) {
  const userId = actor.kind === "user" ? actor.user.id : null;
  if (!userId) return;

  await requireWorkspaceMembership({ actor, workspaceId });

  await prisma.notification.updateMany({
    where: { id: notificationId, workspaceId, userId },
    data: { readAt: new Date() },
  });
}

export async function markAllNotificationsRead(actor: AppActor, workspaceId: string) {
  const userId = actor.kind === "user" ? actor.user.id : null;
  if (!userId) return;

  await prisma.notification.updateMany({
    where: { workspaceId, userId, readAt: null },
    data: { readAt: new Date() },
  });
}
