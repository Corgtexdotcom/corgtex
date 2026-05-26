type JsonRecord = Record<string, unknown>;

export type ContextMapPageContextObject = {
  id: string;
  title: string;
  objectType: string;
  status: string;
};

export type ContextMapPageContextRelationship = {
  id: string;
  sourceObjectId: string;
  targetObjectId: string;
  relationshipType: string;
  status: string;
};

export type ConversationPageContext = {
  surface: "context-map";
  route: string | null;
  mapView: {
    id: string;
    name: string;
    viewType: string;
  };
  includeStale: boolean;
  selectedObjectIds: string[];
  selectedObjects: ContextMapPageContextObject[];
  selectedRelationship: ContextMapPageContextRelationship | null;
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanString(value: unknown, maxLength: number) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, maxLength);
}

function cleanStringArray(value: unknown, maxItems: number, maxLength: number) {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const item of value) {
    const cleaned = cleanString(item, maxLength);
    if (cleaned && !result.includes(cleaned)) result.push(cleaned);
    if (result.length >= maxItems) break;
  }
  return result;
}

function sanitizeObject(value: unknown): ContextMapPageContextObject | null {
  if (!isRecord(value)) return null;
  const id = cleanString(value.id, 80);
  const title = cleanString(value.title, 160);
  if (!id || !title) return null;
  return {
    id,
    title,
    objectType: cleanString(value.objectType, 60) ?? "Unknown",
    status: cleanString(value.status, 60) ?? "unknown",
  };
}

function sanitizeRelationship(value: unknown): ContextMapPageContextRelationship | null {
  if (!isRecord(value)) return null;
  const id = cleanString(value.id, 80);
  const sourceObjectId = cleanString(value.sourceObjectId, 80);
  const targetObjectId = cleanString(value.targetObjectId, 80);
  const relationshipType = cleanString(value.relationshipType, 80);
  if (!id || !sourceObjectId || !targetObjectId || !relationshipType) return null;
  return {
    id,
    sourceObjectId,
    targetObjectId,
    relationshipType,
    status: cleanString(value.status, 60) ?? "unknown",
  };
}

export function sanitizeConversationPageContext(value: unknown): ConversationPageContext | null {
  if (!isRecord(value) || value.surface !== "context-map") return null;
  const mapView = isRecord(value.mapView) ? value.mapView : null;
  const mapViewId = cleanString(mapView?.id, 80);
  if (!mapViewId) return null;

  const selectedObjects = Array.isArray(value.selectedObjects)
    ? value.selectedObjects.map(sanitizeObject).filter((object): object is ContextMapPageContextObject => Boolean(object)).slice(0, 12)
    : [];
  const selectedObjectIds = [
    ...cleanStringArray(value.selectedObjectIds, 12, 80),
    ...selectedObjects.map((object) => object.id),
  ].filter((id, index, array) => array.indexOf(id) === index).slice(0, 12);

  return {
    surface: "context-map",
    route: cleanString(value.route, 240),
    mapView: {
      id: mapViewId,
      name: cleanString(mapView?.name, 160) ?? "Context map",
      viewType: cleanString(mapView?.viewType, 80) ?? "process",
    },
    includeStale: value.includeStale === true,
    selectedObjectIds,
    selectedObjects,
    selectedRelationship: sanitizeRelationship(value.selectedRelationship),
  };
}

export function formatConversationPageContextForModel(context: ConversationPageContext) {
  return [
    "CURRENT PAGE CONTEXT (sanitized, user-visible state only):",
    JSON.stringify(context, null, 2),
    "Use this only to understand what the user is looking at. Fetch graph details with context-map tools before proposing or applying map changes.",
  ].join("\n");
}
