export const TENSION_STATUS_FILTERS = ["DRAFT", "OPEN", "RESOLVED", "ALL"] as const;

export type TensionStatusFilter = (typeof TENSION_STATUS_FILTERS)[number];

export type TensionDateValues = { openedFrom?: string; openedTo?: string; closedFrom?: string; closedTo?: string };
type SearchParams = Record<string, string | string[] | undefined>;
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export function normalizeTensionStatusFilter(value: string | string[] | undefined): TensionStatusFilter {
  const status = firstParam(value);
  return TENSION_STATUS_FILTERS.includes(status as TensionStatusFilter) ? status as TensionStatusFilter : "OPEN";
}

export function normalizeDateOnly(value: string | string[] | undefined) {
  const date = firstParam(value);
  if (!date || !DATE_ONLY_RE.test(date)) return undefined;
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== date) return undefined;
  return date;
}

function startOfUtcDate(value: string) {
  return new Date(`${value}T00:00:00.000Z`);
}

function endOfUtcDate(value: string) {
  return new Date(`${value}T23:59:59.999Z`);
}

export function resolveTensionSearch(search: SearchParams) {
  const statusFilter = normalizeTensionStatusFilter(search.status);
  const dateValues: TensionDateValues = {
    openedFrom: normalizeDateOnly(search.openedFrom),
    openedTo: normalizeDateOnly(search.openedTo),
    closedFrom: normalizeDateOnly(search.closedFrom),
    closedTo: normalizeDateOnly(search.closedTo),
  };
  const dateFilters: { openedFrom?: Date; openedTo?: Date; closedFrom?: Date; closedTo?: Date } = {};
  if (dateValues.openedFrom) dateFilters.openedFrom = startOfUtcDate(dateValues.openedFrom);
  if (dateValues.openedTo) dateFilters.openedTo = endOfUtcDate(dateValues.openedTo);
  if (dateValues.closedFrom) dateFilters.closedFrom = startOfUtcDate(dateValues.closedFrom);
  if (dateValues.closedTo) dateFilters.closedTo = endOfUtcDate(dateValues.closedTo);

  return { statusFilter, dateValues, dateFilters };
}

export function buildTensionQuery(params: { status: TensionStatusFilter; dateValues: TensionDateValues }) {
  const query = new URLSearchParams();
  query.set("status", params.status);
  for (const key of ["openedFrom", "openedTo", "closedFrom", "closedTo"] as const) {
    const value = params.dateValues[key];
    if (value) query.set(key, value);
  }
  return `?${query.toString()}`;
}

export function groupTensionsByStatus<T extends { status: string; isPrivate: boolean }>(tensions: T[]) {
  return {
    DRAFT: tensions.filter((tension) => tension.status === "DRAFT"),
    OPEN: tensions.filter((tension) => tension.status === "OPEN" && !tension.isPrivate),
    RESOLVED: tensions.filter((tension) => tension.status === "RESOLVED" && !tension.isPrivate),
    ALL: tensions,
  };
}
