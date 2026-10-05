import type { Prisma } from "@prisma/client";

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

async function visiblePublicationTitle(
  tx: Prisma.TransactionClient,
  event: { type: string; workspaceId: string | null; aggregateId: string | null },
): Promise<string | null | undefined> {
  if (event.type !== "action.published" && event.type !== "tension.published") {
    return undefined;
  }
  if (!event.workspaceId || !event.aggregateId) {
    return null;
  }

  if (event.type === "action.published") {
    // Hold the row until notification intents are committed in the caller's
    // transaction. A concurrent return to draft or archive must complete
    // before this visibility read or wait until after the intents commit.
    await tx.$queryRaw`SELECT "id" FROM "Action" WHERE "id" = ${event.aggregateId} AND "workspaceId" = ${event.workspaceId} FOR UPDATE`;
    const action = await tx.action.findFirst({
      where: {
        id: event.aggregateId,
        workspaceId: event.workspaceId,
        isPrivate: false,
        status: { not: "DRAFT" },
        archivedAt: null,
        duplicateOfActionId: null,
      },
      select: { title: true },
    });
    return action?.title ?? null;
  }

  await tx.$queryRaw`SELECT "id" FROM "Tension" WHERE "id" = ${event.aggregateId} AND "workspaceId" = ${event.workspaceId} FOR UPDATE`;
  const tension = await tx.tension.findFirst({
    where: {
      id: event.aggregateId,
      workspaceId: event.workspaceId,
      isPrivate: false,
      status: { not: "DRAFT" },
      archivedAt: null,
    },
    select: { title: true },
  });
  return tension?.title ?? null;
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
) {
  if (isReplayEvent(event.payload)) {
    return [] satisfies NotificationDraft[];
  }

  const publicationTitle = await visiblePublicationTitle(tx, event);
  if (publicationTitle === null) {
    return [] satisfies NotificationDraft[];
  }
  return deriveNotificationsForEvent(publicationTitle === undefined
    ? event
    : { ...event, payload: { ...(isObjectRecord(event.payload) ? event.payload : {}), title: publicationTitle } });
}
