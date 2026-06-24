export const TENSION_STATUS_FILTERS = ["DRAFT", "OPEN", "RESOLVED", "ALL"] as const;
const TENSION_VISIBLE_STATUS_FILTERS = ["DRAFT", "OPEN", "RESOLVED"] as const;

export type TensionStatusFilter = (typeof TENSION_STATUS_FILTERS)[number];
export type TensionVisibleStatusFilter = (typeof TENSION_VISIBLE_STATUS_FILTERS)[number];
export type TensionStatusQuery = TensionStatusFilter | readonly TensionVisibleStatusFilter[] | undefined;
export type TensionStatusSearch = {
  statusFilter: TensionStatusFilter;
  statusFilters: TensionVisibleStatusFilter[];
  statusQuery: TensionStatusQuery;
};

type SearchParams = Record<string, string | string[] | undefined>;

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export function normalizeTensionStatusFilter(value: string | string[] | undefined): TensionStatusFilter {
  const status = firstParam(value);
  return TENSION_STATUS_FILTERS.includes(status as TensionStatusFilter) ? status as TensionStatusFilter : "OPEN";
}

function tensionStatusValues(value: string | string[] | undefined) {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  const seen = new Set<TensionStatusFilter>();
  for (const entry of values) {
    if (TENSION_STATUS_FILTERS.includes(entry as TensionStatusFilter)) {
      seen.add(entry as TensionStatusFilter);
    }
  }
  return seen;
}

export function resolveTensionStatusSearch(
  value: string | string[] | undefined,
  defaultValue: TensionVisibleStatusFilter | null = "OPEN",
): TensionStatusSearch {
  const seen = tensionStatusValues(value);
  const selected = TENSION_VISIBLE_STATUS_FILTERS.filter((status) => seen.has(status));
  const isAllStatuses = seen.has("ALL") || selected.length === TENSION_VISIBLE_STATUS_FILTERS.length;
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
    statusFilter: normalizeTensionStatusFilter(value),
    statusFilters: [],
    statusQuery: undefined,
  };
}

export function normalizeTensionStatusFilters(
  value: string | string[] | undefined,
  defaultValue: TensionVisibleStatusFilter | null = "OPEN",
): TensionVisibleStatusFilter[] {
  return resolveTensionStatusSearch(value, defaultValue).statusFilters;
}

export function resolveTensionSearch(
  search: SearchParams,
  defaultValue: TensionVisibleStatusFilter | null = "OPEN",
) {
  return resolveTensionStatusSearch(search.status, defaultValue);
}

export function groupTensionsByStatus<T extends { status: string; isPrivate: boolean }>(tensions: T[]) {
  return {
    DRAFT: tensions.filter((tension) => tension.status === "DRAFT"),
    OPEN: tensions.filter((tension) => tension.status === "OPEN" && !tension.isPrivate),
    RESOLVED: tensions.filter((tension) => tension.status === "RESOLVED" && !tension.isPrivate),
    ALL: tensions,
  };
}

export function tensionMatchesStatusFilters<T extends { status: string; isPrivate: boolean }>(tension: T, filters: readonly TensionStatusFilter[]) {
  if (filters.length === 0) return true;
  return filters.some((filter) => groupTensionsByStatus([tension])[filter]?.length > 0);
}
