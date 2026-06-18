export const CRM_FULL_PAGE_SIZE = 25;

export type SearchParamsRecord = Record<string, string | string[] | undefined>;

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

export function crmPageHref(
  path: string,
  current: SearchParamsRecord,
  updates: Record<string, string | number | null | undefined>,
) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(current)) {
    const raw = Array.isArray(value) ? value[0] : value;
    if (raw) query.set(key, raw);
  }
  for (const [key, value] of Object.entries(updates)) {
    if (value === null || value === undefined || String(value).length === 0) {
      query.delete(key);
    } else {
      query.set(key, String(value));
    }
  }
  const text = query.toString();
  return text ? `${path}?${text}` : path;
}
