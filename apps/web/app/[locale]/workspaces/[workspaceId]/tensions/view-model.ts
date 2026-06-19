export const TENSION_STATUS_FILTERS = ["DRAFT", "OPEN", "RESOLVED", "ALL"] as const;

export type TensionStatusFilter = (typeof TENSION_STATUS_FILTERS)[number];

type SearchParams = Record<string, string | string[] | undefined>;

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export function normalizeTensionStatusFilter(value: string | string[] | undefined): TensionStatusFilter {
  const status = firstParam(value);
  return TENSION_STATUS_FILTERS.includes(status as TensionStatusFilter) ? status as TensionStatusFilter : "OPEN";
}

export function normalizeTensionStatusFilters(value: string | string[] | undefined): TensionStatusFilter[] {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  const seen = new Set<TensionStatusFilter>();
  for (const entry of values) {
    if (TENSION_STATUS_FILTERS.includes(entry as TensionStatusFilter)) {
      seen.add(entry as TensionStatusFilter);
    }
  }
  if (seen.has("ALL") || seen.size === TENSION_STATUS_FILTERS.length - 1) return [];
  return [...seen];
}

export function resolveTensionSearch(search: SearchParams) {
  const statusFilter = normalizeTensionStatusFilter(search.status);
  const statusFilters = normalizeTensionStatusFilters(search.status);
  return { statusFilter, statusFilters };
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
