import { buildActionListQuery, normalizeActionPage, normalizeActionSort, type ActionStatusFilter } from "./view-model";

const RETURN_KEYS = new Set([
  "status", "view", "sort", "scope", "circleId", "assigneeMemberId", "page", "group", "columns",
]);
const SINGLE_KEYS = ["view", "sort", "scope", "page", "group", "columns"] as const;
const STATUSES = new Set<ActionStatusFilter>(["DRAFT", "OPEN", "IN_PROGRESS", "COMPLETED", "ALL"]);
const COLUMN_STATUSES = new Set(["DRAFT", "OPEN", "IN_PROGRESS", "COMPLETED"]);
const MAX_RETURN_LENGTH = 4096;
const FILTER_ID = /^[A-Za-z0-9_-]{1,128}$/;

function actionsPath(workspaceId: string) {
  return `/workspaces/${workspaceId}/actions`;
}

export function buildActionListReturnHref(workspaceId: string, query: string) {
  return `${actionsPath(workspaceId)}${query === "?" ? "" : query}`;
}

export function appendActionReturnTo(path: string, listHref: string | null) {
  return listHref ? `${path}?${new URLSearchParams({ returnTo: listHref })}` : path;
}

// Return context is a filter snapshot, never a destination supplied to a redirect.
// Rebuild its URL from known Actions parameters under this workspace's list path.
export function readActionListReturnHref(workspaceId: string, raw: string | string[] | undefined): string | null {
  const path = actionsPath(workspaceId);
  if (typeof raw !== "string" || raw.length > MAX_RETURN_LENGTH || (raw !== path && !raw.startsWith(`${path}?`))) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(raw, "https://app.local");
  } catch {
    return null;
  }
  if (parsed.origin !== "https://app.local" || parsed.pathname !== path || parsed.hash) return null;
  const query = parsed.searchParams;
  if ([...query.keys()].some((key) => !RETURN_KEYS.has(key))) return null;
  if (SINGLE_KEYS.some((key) => query.getAll(key).length > 1)) return null;

  const view = query.get("view") ?? "list";
  if (view !== "list" && view !== "table" && view !== "kanban") return null;
  const sort = query.get("sort") ?? "priority";
  if (sort !== normalizeActionSort(sort) || (view === "kanban" && query.has("sort"))) return null;
  const scope = query.get("scope");
  if (scope !== null && scope !== "workspace" && scope !== "assigned") return null;
  const status = query.getAll("status");
  if (status.some((value) => !STATUSES.has(value as ActionStatusFilter))
    || new Set(status).size !== status.length || (status.includes("ALL") && status.length > 1)) return null;

  const readIds = (key: "circleId" | "assigneeMemberId") => {
    const ids = query.getAll(key);
    return ids.every((id) => FILTER_ID.test(id)) && new Set(ids).size === ids.length ? ids : null;
  };
  const circleIds = readIds("circleId");
  const assigneeMemberIds = readIds("assigneeMemberId");
  if (!circleIds || !assigneeMemberIds) return null;

  const group = query.get("group");
  if (group !== null && (view !== "kanban" || !["status", "due", "priority"].includes(group))) return null;
  const rawColumns = query.get("columns");
  const columns = rawColumns?.split(",");
  if (columns && (view !== "kanban" || (group !== null && group !== "status")
    || columns.some((column) => !COLUMN_STATUSES.has(column)) || new Set(columns).size !== columns.length)) return null;
  const rawPage = query.get("page");
  const page = rawPage === null ? 1 : normalizeActionPage(rawPage);
  if (rawPage !== null && (view === "kanban" || rawPage !== String(page))) return null;

  const filters = buildActionListQuery({
    view,
    status: status.length === 1 ? status[0] : status.length > 1 ? status : undefined,
    sort: view === "kanban" ? undefined : normalizeActionSort(sort),
    circleIds,
    assigneeMemberIds,
    group: group === "status" ? undefined : group ?? undefined,
    columns,
    page,
  }, scope ?? undefined);
  return buildActionListReturnHref(workspaceId, filters);
}
