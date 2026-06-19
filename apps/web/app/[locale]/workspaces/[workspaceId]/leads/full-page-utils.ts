export const CRM_FULL_PAGE_SIZE = 25;
export const CRM_SORT_DIRECTIONS = ["asc", "desc"] as const;

export type SearchParamsRecord = Record<string, string | string[] | undefined>;
export type CrmFullPageViewMode = "list" | "kanban" | "table";
export type CrmSortDirection = typeof CRM_SORT_DIRECTIONS[number];

export function searchValue(searchParams: SearchParamsRecord, key: string) {
  const value = searchParams[key];
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

export function normalizeCrmPage(value: string | string[] | undefined) {
  const raw = Array.isArray(value) ? value[0] : value;
  const page = Number.parseInt(raw ?? "1", 10);
  return Number.isFinite(page) && page > 0 ? page : 1;
}

export function crmPageOffset(page: number, pageSize = CRM_FULL_PAGE_SIZE) {
  return (Math.max(1, page) - 1) * pageSize;
}

export function crmPageCount(total: number, pageSize = CRM_FULL_PAGE_SIZE) {
  return Math.max(1, Math.ceil(total / pageSize));
}

export function optionValue<TValue extends string>(
  value: string | string[] | undefined,
  allowed: readonly TValue[],
): TValue | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  return allowed.includes(raw as TValue) ? raw as TValue : undefined;
}

export function optionValues<TValue extends string>(
  value: string | string[] | undefined,
  allowed: readonly TValue[],
): TValue[] {
  const rawValues = Array.isArray(value) ? value : value ? [value] : [];
  const allowedSet = new Set<string>(allowed);
  const seen = new Set<string>();
  const values: TValue[] = [];

  for (const raw of rawValues) {
    if (!allowedSet.has(raw) || seen.has(raw)) continue;
    seen.add(raw);
    values.push(raw as TValue);
  }

  return values.length === allowed.length ? [] : values;
}

export function normalizeCrmViewMode<TView extends CrmFullPageViewMode>(
  value: string | string[] | undefined,
  allowed: readonly TView[],
  defaultView: TView,
) {
  return optionValue(value, allowed) ?? defaultView;
}

export function normalizeCrmSortDirection(
  value: string | string[] | undefined,
  defaultDirection: CrmSortDirection = "asc",
) {
  return optionValue(value, CRM_SORT_DIRECTIONS) ?? defaultDirection;
}

export function crmPageHref(
  path: string,
  current: SearchParamsRecord,
  updates: Record<string, string | number | readonly string[] | null | undefined>,
) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(current)) {
    const rawValues = Array.isArray(value) ? value : value ? [value] : [];
    for (const raw of rawValues) {
      if (raw) query.append(key, raw);
    }
  }
  for (const [key, value] of Object.entries(updates)) {
    if (value === null || value === undefined || (!Array.isArray(value) && String(value).length === 0)) {
      query.delete(key);
    } else if (Array.isArray(value)) {
      query.delete(key);
      for (const entry of value) {
        if (entry) query.append(key, entry);
      }
    } else {
      query.set(key, String(value));
    }
  }
  const text = query.toString();
  return text ? `${path}?${text}` : path;
}

export function crmViewHref<TView extends CrmFullPageViewMode>(
  path: string,
  current: SearchParamsRecord,
  view: TView,
  defaultView: TView,
) {
  return crmPageHref(path, current, { view: view === defaultView ? null : view });
}

export function crmSortHref(
  path: string,
  current: SearchParamsRecord,
  sortKey: string,
  activeSort: string | undefined,
  activeDirection: CrmSortDirection,
  defaultDirection: CrmSortDirection = "asc",
) {
  const nextDirection = activeSort === sortKey
    ? activeDirection === "asc" ? "desc" : "asc"
    : defaultDirection;
  return crmPageHref(path, current, {
    sort: sortKey,
    dir: nextDirection === "asc" ? null : nextDirection,
    page: null,
  });
}
