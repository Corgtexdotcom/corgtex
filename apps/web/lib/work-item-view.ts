export type WorkItemViewMode = "list" | "kanban";

export type WorkItemScope = "company" | "circle" | "member";

export type WorkItemSort = "priority" | "date" | "alpha";

export type WorkItemDateValues = Record<string, string | undefined>;

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function firstSearchParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export function normalizeWorkItemView(value: string | string[] | undefined): WorkItemViewMode {
  return firstSearchParam(value) === "kanban" ? "kanban" : "list";
}

export function normalizeWorkItemSort(value: string | string[] | undefined): WorkItemSort {
  const candidate = firstSearchParam(value);
  return candidate === "date" || candidate === "alpha" ? candidate : "priority";
}

export function normalizeWorkItemScope(value: string | string[] | undefined): WorkItemScope {
  const candidate = firstSearchParam(value);
  return candidate === "circle" || candidate === "member" ? candidate : "company";
}

export function normalizeDateOnly(value: string | string[] | undefined) {
  const date = firstSearchParam(value);
  if (!date || !DATE_ONLY_RE.test(date)) return undefined;
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== date) return undefined;
  return date;
}

export function startOfUtcDate(value: string) {
  return new Date(`${value}T00:00:00.000Z`);
}

export function endOfUtcDate(value: string) {
  return new Date(`${value}T23:59:59.999Z`);
}

export function buildWorkItemQuery(params: {
  status?: string;
  view?: WorkItemViewMode;
  scope?: WorkItemScope;
  sort?: WorkItemSort;
  circleId?: string;
  memberId?: string;
  dates?: WorkItemDateValues;
}) {
  const query = new URLSearchParams();
  if (params.status) query.set("status", params.status);
  if (params.view && params.view !== "list") query.set("view", params.view);
  if (params.scope && params.scope !== "company") query.set("scope", params.scope);
  if (params.sort && params.sort !== "priority") query.set("sort", params.sort);
  if (params.circleId) query.set("circleId", params.circleId);
  if (params.memberId) query.set("memberId", params.memberId);
  for (const [key, value] of Object.entries(params.dates ?? {})) {
    if (value) query.set(key, value);
  }
  const value = query.toString();
  return value ? `?${value}` : "?";
}

export function resolveWorkItemFilters(search: Record<string, string | string[] | undefined>) {
  const circleId = firstSearchParam(search.circleId)?.trim() || undefined;
  const memberId = firstSearchParam(search.memberId)?.trim() || undefined;
  const sort = normalizeWorkItemSort(search.sort);
  return { circleId, memberId, sort };
}

export function resolveWorkItemScope(search: Record<string, string | string[] | undefined>) {
  const scope = normalizeWorkItemScope(search.scope);
  const circleId = scope === "circle" ? firstSearchParam(search.circleId)?.trim() || undefined : undefined;
  const memberId = scope === "member" ? firstSearchParam(search.memberId)?.trim() || undefined : undefined;
  return { scope, circleId, memberId };
}
