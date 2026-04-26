export const ACTION_STATUS_FILTERS = ["DRAFT", "OPEN", "IN_PROGRESS", "COMPLETED", "ALL"] as const;

export type ActionStatusFilter = (typeof ACTION_STATUS_FILTERS)[number];

export type ActionListItem = {
  status: string;
  isPrivate?: boolean | null;
};

export const ACTION_STATUS_META: Record<ActionStatusFilter, {
  labelKey: "statusDraft" | "statusOpen" | "statusInProgress" | "statusCompleted" | "statusAll";
  tagClass: "info" | "warning" | "success" | "";
}> = {
  DRAFT: { labelKey: "statusDraft", tagClass: "info" },
  OPEN: { labelKey: "statusOpen", tagClass: "warning" },
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

export function actionMatchesStatusFilter(action: ActionListItem, filter: ActionStatusFilter): boolean {
  if (filter === "ALL") return true;
  if (action.status !== filter) return false;
  if (filter === "DRAFT") return true;
  return !action.isPrivate;
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
