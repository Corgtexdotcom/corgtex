import type { Prisma } from "@prisma/client";
import { logger } from "@corgtex/shared";

export function parseMentions(bodyMd: string | null | undefined): { memberIds: string[]; circleIds: string[] } {
  if (!bodyMd) return { memberIds: [], circleIds: [] };

  const memberIds = new Set<string>();
  const circleIds = new Set<string>();

  const memberRegex = /@member:([a-f0-9-]+)/g;
  let match;
  while ((match = memberRegex.exec(bodyMd)) !== null) {
    memberIds.add(match[1]);
  }

  const circleRegex = /@circle:([a-f0-9-]+)/g;
  while ((match = circleRegex.exec(bodyMd)) !== null) {
    circleIds.add(match[1]);
  }

  return {
    memberIds: Array.from(memberIds),
    circleIds: Array.from(circleIds),
  };
}

export async function createMentionNotifications(
  tx: Prisma.TransactionClient,
  params: {
    workspaceId: string;
    actorUserId: string;
    entityType: string;
    entityId: string;
    title: string;
    memberIds: string[];
    circleIds: string[];
  }
) {
  if (params.memberIds.length === 0 && params.circleIds.length === 0) return;

  const targetUserIds = new Set<string>();

  if (params.memberIds.length > 0) {
    const members = await tx.member.findMany({
      where: {
        workspaceId: params.workspaceId,
        id: { in: params.memberIds },
        isActive: true,
      },
      select: { userId: true },
    });
    members.forEach((m) => targetUserIds.add(m.userId));
  }

  if (params.circleIds.length > 0) {
    const assignments = await tx.roleAssignment.findMany({
      where: {
        role: { circleId: { in: params.circleIds } },
        member: { isActive: true },
      },
      select: { member: { select: { userId: true } } },
    });
    assignments.forEach((a) => targetUserIds.add(a.member.userId));
  }

  targetUserIds.delete(params.actorUserId);

  if (targetUserIds.size === 0) return;

  const notificationsData = Array.from(targetUserIds).map((userId) => ({
    workspaceId: params.workspaceId,
    userId,
    type: "MENTION",
    entityType: params.entityType,
    entityId: params.entityId,
    title: params.title,
  }));

  try {
    await tx.notification.createMany({
      data: notificationsData,
      skipDuplicates: true,
    });
  } catch (error) {
    logger.error("Failed to create mention notifications", { error, params });
  }
}
