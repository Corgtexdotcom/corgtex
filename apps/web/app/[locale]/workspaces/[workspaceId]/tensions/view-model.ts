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

export function resolveTensionSearch(search: SearchParams) {
  const statusFilter = normalizeTensionStatusFilter(search.status);
  return { statusFilter };
}

export function groupTensionsByStatus<T extends { status: string; isPrivate: boolean }>(tensions: T[]) {
  return {
    DRAFT: tensions.filter((tension) => tension.status === "DRAFT"),
    OPEN: tensions.filter((tension) => tension.status === "OPEN" && !tension.isPrivate),
    RESOLVED: tensions.filter((tension) => tension.status === "RESOLVED" && !tension.isPrivate),
    ALL: tensions,
  };
}
