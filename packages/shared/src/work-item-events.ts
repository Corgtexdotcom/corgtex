// Pure contract: no database, transport, environment, or authorization dependencies.
export type ActionEventPayloadMap = {
  "action.created": { actionId: string; title: string };
  "action.updated": { actionId: string; fields: string[]; evidenceDocumentIds?: string[] };
};
type ActionEventName = keyof ActionEventPayloadMap;
type ActionEvent = { [K in ActionEventName]: {
  workspaceId: string;
  type: K;
  aggregateType: "Action";
  aggregateId: string;
  payload: ActionEventPayloadMap[K] & { eventVersion: 1 };
} }[ActionEventName];
type ActionEventArgs = { [K in ActionEventName]: [type: K, payload: ActionEventPayloadMap[K], workspaceId: string] }[ActionEventName];

export function createActionEvent(...[type, payload, workspaceId]: ActionEventArgs): ActionEvent {
  return {
    workspaceId, type, aggregateType: "Action", aggregateId: payload.actionId,
    payload: { ...payload, eventVersion: 1 },
  } as ActionEvent;
}

export function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readPayloadString(payload: unknown, key: string) {
  if (!isObjectRecord(payload)) return null;
  const value = payload[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function isReplayEvent(payload: unknown) {
  if (!isObjectRecord(payload) || !isObjectRecord(payload.runtimeMeta)) return false;
  const replayOfEventId = payload.runtimeMeta.replayOfEventId;
  return typeof replayOfEventId === "string" && replayOfEventId.trim().length > 0;
}

type DecodedActionEvent = {
  [K in ActionEventName]: { type: K; payload: ActionEventPayloadMap[K] & { eventVersion: 1 } };
}[ActionEventName];
type LegacyActionEvent = {
  [K in ActionEventName]: { type: K; payload: Pick<ActionEventPayloadMap[K], "actionId"> & Partial<ActionEventPayloadMap[K]> };
}[ActionEventName];
export type ActionEventDecodeResult =
  | { status: "supported"; event: DecodedActionEvent }
  | { status: "legacy"; event: LegacyActionEvent }
  | { status: "legacy-command" }
  | { status: "unmigrated" }
  | { status: "invalid"; reason: string }
  | { status: "unsupported-version"; version: number };

// Absence of payload.eventVersion is legacy, never an implicit upgrade to v1.
// Extra payload metadata remains intact for replay and outbound webhook envelopes.
export function decodeActionEvent(event: {
  type: string; payload: unknown; aggregateId?: string | null;
}): ActionEventDecodeResult {
  if (event.type !== "action.created" && event.type !== "action.updated") return { status: "unmigrated" };
  const payload = event.payload;
  const invalid = (reason: string): ActionEventDecodeResult => ({ status: "invalid", reason });
  if (!isObjectRecord(payload)) return invalid("payload must be an object");
  const legacy = !Object.hasOwn(payload, "eventVersion");
  if (!legacy) {
    if (typeof payload.eventVersion !== "number" || !Number.isSafeInteger(payload.eventVersion)) return invalid("eventVersion must be an integer");
    if (payload.eventVersion !== 1) return { status: "unsupported-version", version: payload.eventVersion };
  }
  // The inbound Slack command shares a historical name but is not a canonical
  // action mutation. Keep its existing triage-only behavior without versioning it.
  if (legacy && event.type === "action.created" && event.aggregateId == null
    && !Object.hasOwn(payload, "actionId") && payload.source === "slack"
    && ["title", "bodyMd", "slackChannel", "slackUser", "inboundWebhookId"].every((key) => typeof payload[key] === "string")) {
    return { status: "legacy-command" };
  }
  if (typeof payload.actionId !== "string" || payload.actionId.length === 0) return invalid("actionId must be a nonempty string");
  if (event.type === "action.created") {
    if ((!legacy || Object.hasOwn(payload, "title")) && typeof payload.title !== "string") return invalid("title must be a string");
  } else {
    const stringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");
    if ((!legacy || Object.hasOwn(payload, "fields")) && !stringArray(payload.fields)) return invalid("fields must be a string array");
    if (Object.hasOwn(payload, "evidenceDocumentIds") && !stringArray(payload.evidenceDocumentIds)) return invalid("evidenceDocumentIds must be a string array");
  }
  // Validation above is deliberately less strict only for unversioned sparse rows.
  if (legacy) return { status: "legacy", event: { type: event.type, payload } as LegacyActionEvent };
  return { status: "supported", event: { type: event.type, payload } as DecodedActionEvent };
}
