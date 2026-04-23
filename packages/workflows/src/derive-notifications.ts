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

  if (event.type === "proposal.submitted") {
    return [{
      type: event.type,
      entityType,
      entityId,
      title: "Proposal submitted for review",
      bodyMd: "A proposal is awaiting approval in the workspace dashboard.",
    }] satisfies NotificationDraft[];
  }

  if (event.type === "spend.submitted") {
    return [{
      type: event.type,
      entityType,
      entityId,
      title: "Spend request submitted for review",
      bodyMd: "A spend request is awaiting finance review in the workspace dashboard.",
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

  if (event.type === "action.created") {
    return [{
      type: event.type,
      entityType,
      entityId,
      title: title ? `New action: ${title}` : "New action created",
      bodyMd: "An action item was added to the workspace.",
    }] satisfies NotificationDraft[];
  }

  if (event.type === "tension.created") {
    return [{
      type: event.type,
      entityType,
      entityId,
      title: title ? `New tension: ${title}` : "New tension raised",
      bodyMd: "A new tension was captured in the workspace.",
    }] satisfies NotificationDraft[];
  }

  if (event.type === "advice-process.initiated") {
    return [{
      type: event.type,
      entityType: "AdviceProcess",
      entityId,
      title: title ? `Context required: ${title}` : "Advice process initiated",
      bodyMd: "A new proposal is seeking advice before execution.",
    }] satisfies NotificationDraft[];
  }

  if (event.type === "advice-process.advice-recorded") {
    return [{
      type: event.type,
      entityType: "AdviceRecord",
      entityId,
      title: title ? `Advice recorded on: ${title}` : "New advice recorded",
      bodyMd: "A peer has left advice on an active proposal.",
    }] satisfies NotificationDraft[];
  }

  return [] satisfies NotificationDraft[];
}

