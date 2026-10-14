import type { Prisma } from "@prisma/client";
import type { AppActor } from "@corgtex/shared";
import { meetingTranscriptInputProjection, type LineageInput, type LineageRoot } from "@corgtex/domain";
import { captureNotificationEventRoots, notificationProducerActor } from "./notification-event-lineage";

type NotificationDraft = {
  type: string;
  entityType: string | null;
  entityId: string | null;
  title: string;
  bodyMd: string | null;
};

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readPayloadString(payload: unknown, key: string) {
  if (!isObjectRecord(payload)) {
    return null;
  }

  const value = payload[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function isReplayEvent(payload: unknown) {
  if (!isObjectRecord(payload)) {
    return false;
  }

  const runtimeMeta = payload.runtimeMeta;
  if (!isObjectRecord(runtimeMeta)) {
    return false;
  }

  return typeof runtimeMeta.replayOfEventId === "string" && runtimeMeta.replayOfEventId.trim().length > 0;
}

export function deriveNotificationsForEvent(event: {
  type: string;
  workspaceId: string | null;
  aggregateType?: string | null;
  aggregateId?: string | null;
  payload: unknown;
}) {
  if (!event.workspaceId || isReplayEvent(event.payload)) {
    return [] satisfies NotificationDraft[];
  }

  const entityType = event.aggregateType ?? null;
  const entityId = event.aggregateId ?? null;
  const title = readPayloadString(event.payload, "title");

  if (event.type === "proposal.submitted" || event.type === "proposal.opened") {
    return [{
      type: event.type,
      entityType,
      entityId,
      title: title ? `Review requested: ${title}` : "Proposal review requested",
      bodyMd: title
        ? `The proposal **${title}** is open for advisory review.`
        : "A proposal is open for advisory review in the workspace dashboard.",
    }] satisfies NotificationDraft[];
  }

  if (event.type === "meeting.created") {
    return [{
      type: event.type,
      entityType,
      entityId,
      title: title ? `Meeting added: ${title}` : "New meeting added",
      bodyMd: "Meeting summary and action extraction will run automatically.",
    }] satisfies NotificationDraft[];
  }

  if (event.type === "action.published") {
    return [{
      // Keep the existing notification preference key for newly visible actions.
      type: "action.created",
      entityType,
      entityId,
      title: title ? `New action: ${title}` : "New action created",
      bodyMd: "An action item was added to the workspace.",
    }] satisfies NotificationDraft[];
  }

  if (event.type === "tension.published") {
    return [{
      type: "tension.created",
      entityType,
      entityId,
      title: title ? `New tension: ${title}` : "New tension raised",
      bodyMd: "A new tension was captured in the workspace.",
    }] satisfies NotificationDraft[];
  }

  return [] satisfies NotificationDraft[];
}

export async function deriveDispatchNotifications(
  tx: Prisma.TransactionClient,
  event: Parameters<typeof deriveNotificationsForEvent>[0] & { aggregateId: string | null },
): Promise<Array<NotificationDraft & { lineageActor: AppActor; lineageRoots: LineageRoot[] }>> {
  if (!event.workspaceId || !event.aggregateId || isReplayEvent(event.payload)) return [];
  const workspaceId = event.workspaceId, id = event.aggregateId;
  let kind: LineageInput["kind"];
  let row: { id: string; title: string | null; [key: string]: unknown } | null;
  if (event.type === "action.published" && event.aggregateType === "Action") {
    kind = "Action";
    await tx.$queryRaw`SELECT id FROM "Action" WHERE id = ${id} AND "workspaceId" = ${workspaceId} FOR UPDATE`;
    row = await tx.action.findFirst({ where: { id, workspaceId, isPrivate: false, status: { not: "DRAFT" }, archivedAt: null, duplicateOfActionId: null } });
  } else if (event.type === "tension.published" && event.aggregateType === "Tension") {
    kind = "Tension";
    await tx.$queryRaw`SELECT id FROM "Tension" WHERE id = ${id} AND "workspaceId" = ${workspaceId} FOR UPDATE`;
    row = await tx.tension.findFirst({ where: { id, workspaceId, isPrivate: false, status: { not: "DRAFT" }, archivedAt: null } });
  } else if (["proposal.submitted", "proposal.opened"].includes(event.type) && event.aggregateType === "Proposal") {
    kind = "Proposal";
    await tx.$queryRaw`SELECT id FROM "Proposal" WHERE id = ${id} AND "workspaceId" = ${workspaceId} FOR UPDATE`;
    row = await tx.proposal.findFirst({ where: { id, workspaceId, isPrivate: false, status: { not: "DRAFT" }, archivedAt: null } });
  } else if (event.type === "meeting.created" && event.aggregateType === "Meeting") {
    kind = "MeetingTranscript";
    await tx.$queryRaw`SELECT id FROM "Meeting" WHERE id = ${id} AND "workspaceId" = ${workspaceId} FOR UPDATE`;
    row = await tx.meeting.findFirst({ where: { id, workspaceId, archivedAt: null } });
  } else return [];
  if (!row) return [];
  const snapshot = kind === "MeetingTranscript" ? meetingTranscriptInputProjection(row) : row;
  const lineageRoots = await captureNotificationEventRoots(tx, workspaceId, [{ kind, id: row.id, snapshot }]);
  if (!lineageRoots) return [];
  return deriveNotificationsForEvent({ ...event, payload: { title: row.title } }).map((draft) => ({
    ...draft, lineageActor: notificationProducerActor(workspaceId), lineageRoots,
  }));
}
