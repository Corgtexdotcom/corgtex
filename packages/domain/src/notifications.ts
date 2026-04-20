import { prisma } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import { requireWorkspaceMembership } from "./auth";

export async function listNotifications(actor: AppActor, workspaceId: string, opts?: {
  unreadOnly?: boolean;
  take?: number;
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
  });
}

export async function countUnreadNotifications(userId: string, workspaceId: string) {
  return prisma.notification.count({
    where: { workspaceId, userId, readAt: null },
  });
}

export async function markNotificationRead(actor: AppActor, notificationId: string) {
  const userId = actor.kind === "user" ? actor.user.id : null;
  if (!userId) return;

  await prisma.notification.updateMany({
    where: { id: notificationId, userId },
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

