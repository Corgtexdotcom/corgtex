import type { ActionSort } from "@corgtex/domain";
import { buildWorkItemQuery } from "@/lib/work-item-view";

const ACTION_SORTS: readonly ActionSort[] = ["priority", "date", "created_asc", "due_asc", "due_desc", "alpha"];
export const ACTION_PAGE_SIZE = 200;
const MAX_ACTION_PAGE = Math.floor(2_147_483_647 / ACTION_PAGE_SIZE) + 1;

export function normalizeActionPage(value: string | string[] | undefined) {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (!candidate || !/^[1-9]\d*$/.test(candidate)) return 1;
  const page = Number(candidate);
  return Number.isSafeInteger(page) && page <= MAX_ACTION_PAGE ? page : 1;
}

export function normalizeActionSort(value: string | string[] | undefined): ActionSort {
  const candidate = Array.isArray(value) ? value[0] : value;
  return ACTION_SORTS.includes(candidate as ActionSort) ? candidate as ActionSort : "priority";
}

export function buildActionListQuery(
  params: Omit<Parameters<typeof buildWorkItemQuery>[0], "sort"> & { sort?: ActionSort; page?: number },
  scope?: string,
) {
  const { sort, page, ...queryParams } = params;
  const query = new URLSearchParams(buildWorkItemQuery(queryParams).slice(1));
  if (sort && sort !== "priority") query.set("sort", sort);
  if (page && page > 1) query.set("page", String(page));
  if (scope === "workspace" || scope === "assigned") query.set("scope", scope);
  return query.size > 0 ? `?${query}` : "?";
}

export const ACTION_STATUS_FILTERS = ["DRAFT", "OPEN", "IN_PROGRESS", "COMPLETED", "ALL"] as const;
const ACTION_VISIBLE_STATUS_FILTERS = ["DRAFT", "OPEN", "IN_PROGRESS", "COMPLETED"] as const;

export type ActionStatusFilter = (typeof ACTION_STATUS_FILTERS)[number];
export type ActionVisibleStatusFilter = (typeof ACTION_VISIBLE_STATUS_FILTERS)[number];
export type ActionStatusQuery = ActionStatusFilter | readonly ActionVisibleStatusFilter[] | undefined;
export type ActionStatusSearch = {
  statusFilter: ActionStatusFilter;
  statusFilters: ActionVisibleStatusFilter[];
  statusQuery: ActionStatusQuery;
};

export function actionStatusFormValues(statusQuery: ActionStatusQuery, statusFilters: readonly ActionVisibleStatusFilter[]) {
  return statusQuery === "ALL" ? ["ALL"] : statusFilters;
}

export type ActionListItem = {
  status: string;
  isPrivate?: boolean | null;
};

export function resolveActionAssigneeScope(
  selectedAssigneeIds: string[],
  currentMemberId: string | null,
  scope: string | string[] | undefined,
) {
  const requestedScope = Array.isArray(scope) ? scope[0] : scope;
  const baseScope = !currentMemberId || requestedScope === "workspace"
    ? "workspace"
    : requestedScope === "assigned" ? "assigned" : "mine";
  const actionScope = selectedAssigneeIds.length > 0
    ? "filtered"
    : baseScope;
  return {
    actionScope,
    baseScope,
    assigneeMemberIds: actionScope === "workspace" ? []
      : actionScope === "filtered" ? selectedAssigneeIds : [currentMemberId!],
    includeOwnDrafts: actionScope === "mine",
    assignedToMeActive: Boolean(currentMemberId)
      && (actionScope === "assigned" || (actionScope === "filtered" && selectedAssigneeIds.length === 1 && selectedAssigneeIds[0] === currentMemberId)),
  };
}

export function hasEligibleActionAssignee(assigneeMemberId: string | null | undefined, humanMemberIds: ReadonlySet<string>) {
  return Boolean(assigneeMemberId && humanMemberIds.has(assigneeMemberId));
}

export const ACTION_STATUS_META: Record<ActionStatusFilter, {
  labelKey: "statusDraft" | "statusOpen" | "statusInProgress" | "statusCompleted" | "statusAll";
  tagClass: "info" | "neutral" | "success" | "";
}> = {
  DRAFT: { labelKey: "statusDraft", tagClass: "info" },
  OPEN: { labelKey: "statusOpen", tagClass: "neutral" },
  IN_PROGRESS: { labelKey: "statusInProgress", tagClass: "info" },
  COMPLETED: { labelKey: "statusCompleted", tagClass: "success" },
  ALL: { labelKey: "statusAll", tagClass: "" },
};

export function normalizeActionStatusFilter(value: string | string[] | undefined): ActionStatusFilter {
  const candidate = Array.isArray(value) ? value[0] : value;
  return ACTION_STATUS_FILTERS.includes(candidate as ActionStatusFilter)
    ? candidate as ActionStatusFilter
    : "OPEN";
}

function actionStatusValues(value: string | string[] | undefined) {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  const seen = new Set<ActionStatusFilter>();
  for (const entry of values) {
    if (ACTION_STATUS_FILTERS.includes(entry as ActionStatusFilter)) {
      seen.add(entry as ActionStatusFilter);
    }
  }
  return seen;
}

export function resolveActionStatusSearch(
  value: string | string[] | undefined,
  defaultValue: ActionVisibleStatusFilter | null = "OPEN",
): ActionStatusSearch {
  const seen = actionStatusValues(value);
  const selected = ACTION_VISIBLE_STATUS_FILTERS.filter((status) => seen.has(status));
  const isAllStatuses = seen.has("ALL") || selected.length === ACTION_VISIBLE_STATUS_FILTERS.length;
  if (isAllStatuses) {
    return {
      statusFilter: "ALL" as const,
      statusFilters: [],
      statusQuery: "ALL" as const,
    };
  }
  if (selected.length > 0) {
    return {
      statusFilter: selected[0],
      statusFilters: selected,
      statusQuery: selected,
    };
  }
  if (defaultValue !== null) {
    return {
      statusFilter: defaultValue,
      statusFilters: [defaultValue],
      statusQuery: [defaultValue],
    };
  }
  return {
    statusFilter: normalizeActionStatusFilter(value),
    statusFilters: [],
    statusQuery: undefined,
  };
}

export function normalizeActionStatusFilters(
  value: string | string[] | undefined,
  defaultValue: ActionVisibleStatusFilter | null = "OPEN",
): ActionVisibleStatusFilter[] {
  return resolveActionStatusSearch(value, defaultValue).statusFilters;
}

export function actionMatchesStatusFilter(action: ActionListItem, filter: ActionStatusFilter): boolean {
  if (filter === "ALL") return true;
  if (action.status !== filter) return false;
  if (filter === "DRAFT") return true;
  return !action.isPrivate;
}

export function actionMatchesStatusFilters(action: ActionListItem, filters: readonly ActionStatusFilter[]): boolean {
  if (filters.length === 0) return true;
  return filters.some((filter) => actionMatchesStatusFilter(action, filter));
}

export function groupActionsByStatus<T extends ActionListItem>(actions: T[]) {
  return {
    DRAFT: actions.filter((action) => actionMatchesStatusFilter(action, "DRAFT")),
    OPEN: actions.filter((action) => actionMatchesStatusFilter(action, "OPEN")),
    IN_PROGRESS: actions.filter((action) => actionMatchesStatusFilter(action, "IN_PROGRESS")),
    COMPLETED: actions.filter((action) => actionMatchesStatusFilter(action, "COMPLETED")),
    ALL: actions,
  } satisfies Record<ActionStatusFilter, T[]>;
}
