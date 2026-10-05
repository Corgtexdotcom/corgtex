import type { Prisma } from "@prisma/client";
import { createNotificationIntent } from "@corgtex/domain";

type AssignmentEvent = {
  id: string;
  type: string;
  workspaceId: string | null;
  aggregateType: string | null;
  aggregateId: string | null;
  payload: unknown;
};

function payloadObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export async function createActionAssignmentNotification(
  tx: Prisma.TransactionClient,
  event: AssignmentEvent,
  actorUserId: string | null,
): Promise<string | null> {
  if ((event.type !== "action.published" && event.type !== "action.assigned")
    || !event.workspaceId || event.aggregateType !== "Action" || !event.aggregateId) return null;

  const payload = payloadObject(event.payload);
  const runtimeMeta = payloadObject(payload?.runtimeMeta);
  if (typeof runtimeMeta?.replayOfEventId === "string" && runtimeMeta.replayOfEventId.trim()) return null;
  const assigneeMemberId = payload?.assigneeMemberId;
  if (typeof assigneeMemberId !== "string" || !assigneeMemberId.trim()) return null;

  // Hold the Action through notification creation so a concurrent reassignment,
  // return to draft, or archive cannot invalidate the visibility check.
  await tx.$queryRaw`SELECT "id" FROM "Action" WHERE "id" = ${event.aggregateId} AND "workspaceId" = ${event.workspaceId} FOR UPDATE`;
  const action = await tx.action.findFirst({
    where: {
      id: event.aggregateId,
      workspaceId: event.workspaceId,
      assigneeMemberId,
      isPrivate: false,
      status: { in: ["OPEN", "IN_PROGRESS"] },
      archivedAt: null,
      duplicateOfActionId: null,
    },
    select: { title: true },
  });
  if (!action) return null;

  const assignee = await tx.member.findFirst({
    where: { id: assigneeMemberId, workspaceId: event.workspaceId, isActive: true },
    select: { userId: true },
  });
  if (!assignee) return null;

  const result = await createNotificationIntent(tx, {
    workspaceId: event.workspaceId,
    type: "action.assigned",
    recipientUserIds: [assignee.userId],
    actorUserId,
    entityType: "Action",
    entityId: event.aggregateId,
    title: `Assigned to you: ${action.title}`,
    bodyMd: "You were assigned an action in this workspace.",
    priority: "HIGH",
    dedupeKey: `action-assigned:${event.id}`,
  });
  return result.count > 0 ? assignee.userId : null;
}
