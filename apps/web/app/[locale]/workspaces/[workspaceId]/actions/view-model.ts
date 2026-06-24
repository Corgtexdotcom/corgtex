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

export type ActionListItem = {
  status: string;
  isPrivate?: boolean | null;
};

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
