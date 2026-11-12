export type SearchParamValue = string | string[] | undefined;

export function searchParamValues(value: SearchParamValue) {
  const rawValues = Array.isArray(value) ? value : value ? [value] : [];
  const seen = new Set<string>();
  const values: string[] = [];

  for (const rawValue of rawValues) {
    const trimmed = rawValue.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    values.push(trimmed);
  }

  return values;
}

export function normalizeSelectedValues<TValue extends string>(
  value: SearchParamValue,
  allowedValues?: readonly TValue[],
): TValue[] {
  const allowed = allowedValues ? new Set<string>(allowedValues) : null;
  const values = searchParamValues(value)
    .filter((entry) => !allowed || allowed.has(entry)) as TValue[];

  if (allowedValues && values.length === allowedValues.length) return [];
  return values;
}

export function firstSelectedValue(values: readonly string[]) {
  return values[0] || undefined;
}

export function appendRepeatedParams(query: URLSearchParams, key: string, values?: readonly string[]) {
  for (const value of values ?? []) {
    if (value) query.append(key, value);
  }
}

export function queryStringFromParams(params: Record<string, string | number | readonly string[] | null | undefined>) {
  const search = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      appendRepeatedParams(search, key, value);
    } else if (value !== undefined && value !== null && String(value).length > 0) {
      search.set(key, String(value));
    }
  }

  return `?${search.toString()}`;
}
