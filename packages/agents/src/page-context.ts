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

export type ConversationContextMapPageContext = {
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

type CrmVisibleRecord = Record<string, string | number | null>;

export type ConversationCrmPageContext = {
  surface: "crm";
  route: string | null;
  workspaceId: string;
  view: string;
  section: string | null;
  selectedIds: {
    accountId: string | null;
    contactId: string | null;
    dealId: string | null;
    activityId: string | null;
    suggestionId: string | null;
  };
  filters: Record<string, string>;
  pagination: {
    page: number | null;
    pageCount: number | null;
    total: number | null;
  };
  visibleContext: {
    metrics: CrmVisibleRecord[];
    accounts: CrmVisibleRecord[];
    contacts: CrmVisibleRecord[];
    deals: CrmVisibleRecord[];
    activities: CrmVisibleRecord[];
    suggestions: CrmVisibleRecord[];
  };
};

export type ConversationPageContext = ConversationContextMapPageContext | ConversationCrmPageContext;

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

function cleanNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function cleanFilters(value: unknown) {
  if (!isRecord(value)) return {};
  const filters: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = cleanString(rawKey, 60);
    if (!key || rawValue === null || rawValue === undefined || rawValue === "") continue;
    const stringValue = cleanString(String(rawValue), 120);
    if (stringValue) filters[key] = stringValue;
    if (Object.keys(filters).length >= 12) break;
  }
  return filters;
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

function sanitizeContextMapPageContext(value: JsonRecord): ConversationContextMapPageContext | null {
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

function sanitizeCrmMetric(value: unknown): CrmVisibleRecord | null {
  if (!isRecord(value)) return null;
  const label = cleanString(value.label, 80);
  const metricValue = cleanString(value.value, 120);
  if (!label || !metricValue) return null;
  return {
    label,
    value: metricValue,
    detail: cleanString(value.detail, 160),
  };
}

function sanitizeCrmAccount(value: unknown): CrmVisibleRecord | null {
  if (!isRecord(value)) return null;
  const id = cleanString(value.id, 80);
  const name = cleanString(value.name, 160);
  if (!id || !name) return null;
  return {
    id,
    name,
    domain: cleanString(value.domain, 120),
    relationshipType: cleanString(value.relationshipType, 60),
    lifecycleStage: cleanString(value.lifecycleStage, 60),
    webUrl: cleanString(value.webUrl, 240),
  };
}

function sanitizeCrmContact(value: unknown): CrmVisibleRecord | null {
  if (!isRecord(value)) return null;
  const id = cleanString(value.id, 80);
  if (!id) return null;
  return {
    id,
    name: cleanString(value.name, 160),
    email: cleanString(value.email, 160),
    title: cleanString(value.title, 120),
    accountId: cleanString(value.accountId, 80),
    accountName: cleanString(value.accountName, 160),
    webUrl: cleanString(value.webUrl, 240),
  };
}

function sanitizeCrmDeal(value: unknown): CrmVisibleRecord | null {
  if (!isRecord(value)) return null;
  const id = cleanString(value.id, 80);
  const title = cleanString(value.title, 160);
  if (!id || !title) return null;
  return {
    id,
    title,
    stage: cleanString(value.stage, 60),
    accountId: cleanString(value.accountId, 80),
    accountName: cleanString(value.accountName, 160),
    contactId: cleanString(value.contactId, 80),
    contactName: cleanString(value.contactName, 160),
    valueCents: cleanNumber(value.valueCents),
    ownerUserId: cleanString(value.ownerUserId, 80),
    webUrl: cleanString(value.webUrl, 240),
  };
}

function sanitizeCrmActivity(value: unknown): CrmVisibleRecord | null {
  if (!isRecord(value)) return null;
  const id = cleanString(value.id, 80);
  const title = cleanString(value.title, 160);
  if (!id || !title) return null;
  return {
    id,
    title,
    type: cleanString(value.type, 60),
    accountId: cleanString(value.accountId, 80),
    accountName: cleanString(value.accountName, 160),
    contactId: cleanString(value.contactId, 80),
    contactName: cleanString(value.contactName, 160),
    dealId: cleanString(value.dealId, 80),
    dealTitle: cleanString(value.dealTitle, 160),
    dueAt: cleanString(value.dueAt, 40),
    completedAt: cleanString(value.completedAt, 40),
    ownerUserId: cleanString(value.ownerUserId, 80),
    webUrl: cleanString(value.webUrl, 240),
  };
}

function sanitizeCrmSuggestion(value: unknown): CrmVisibleRecord | null {
  if (!isRecord(value)) return null;
  const id = cleanString(value.id, 80);
  const title = cleanString(value.title, 160);
  if (!id || !title) return null;
  return {
    id,
    title,
    status: cleanString(value.status, 60),
    accountId: cleanString(value.accountId, 80),
    accountName: cleanString(value.accountName, 160),
    contactId: cleanString(value.contactId, 80),
    contactName: cleanString(value.contactName, 160),
    dealId: cleanString(value.dealId, 80),
    dealTitle: cleanString(value.dealTitle, 160),
    recipientEmail: cleanString(value.recipientEmail, 160),
    subject: cleanString(value.subject, 160),
    webUrl: cleanString(value.webUrl, 240),
  };
}

function sanitizeCrmArray<T>(value: unknown, sanitizer: (item: unknown) => T | null) {
  if (!Array.isArray(value)) return [];
  return value.map(sanitizer).filter((item): item is T => Boolean(item)).slice(0, 12);
}

function sanitizeCrmPageContext(value: JsonRecord): ConversationCrmPageContext | null {
  const workspaceId = cleanString(value.workspaceId, 80);
  const view = cleanString(value.view, 80);
  if (!workspaceId || !view) return null;

  const selectedIds = isRecord(value.selectedIds) ? value.selectedIds : {};
  const pagination = isRecord(value.pagination) ? value.pagination : {};
  const visibleContext = isRecord(value.visibleContext) ? value.visibleContext : {};

  return {
    surface: "crm",
    route: cleanString(value.route, 240),
    workspaceId,
    view,
    section: cleanString(value.section, 80),
    selectedIds: {
      accountId: cleanString(selectedIds.accountId, 80),
      contactId: cleanString(selectedIds.contactId, 80),
      dealId: cleanString(selectedIds.dealId, 80),
      activityId: cleanString(selectedIds.activityId, 80),
      suggestionId: cleanString(selectedIds.suggestionId, 80),
    },
    filters: cleanFilters(value.filters),
    pagination: {
      page: cleanNumber(pagination.page),
      pageCount: cleanNumber(pagination.pageCount),
      total: cleanNumber(pagination.total),
    },
    visibleContext: {
      metrics: sanitizeCrmArray(visibleContext.metrics, sanitizeCrmMetric),
      accounts: sanitizeCrmArray(visibleContext.accounts, sanitizeCrmAccount),
      contacts: sanitizeCrmArray(visibleContext.contacts, sanitizeCrmContact),
      deals: sanitizeCrmArray(visibleContext.deals, sanitizeCrmDeal),
      activities: sanitizeCrmArray(visibleContext.activities, sanitizeCrmActivity),
      suggestions: sanitizeCrmArray(visibleContext.suggestions, sanitizeCrmSuggestion),
    },
  };
}

export function sanitizeConversationPageContext(value: unknown): ConversationPageContext | null {
  if (!isRecord(value)) return null;
  if (value.surface === "context-map") return sanitizeContextMapPageContext(value);
  if (value.surface === "crm") return sanitizeCrmPageContext(value);
  return null;
}

export function formatConversationPageContextForModel(context: ConversationPageContext) {
  if (context.surface === "crm") {
    return [
      "CURRENT PAGE CONTEXT (sanitized, user-visible CRM state only):",
      JSON.stringify(context, null, 2),
      "Use this to understand the CRM route, selected IDs, filters, and visible records the user is looking at. Do not send email directly.",
    ].join("\n");
  }

  return [
    "CURRENT PAGE CONTEXT (sanitized, user-visible state only):",
    JSON.stringify(context, null, 2),
    "Use this only to understand what the user is looking at. Fetch graph details with context-map tools before proposing or applying map changes.",
  ].join("\n");
}
