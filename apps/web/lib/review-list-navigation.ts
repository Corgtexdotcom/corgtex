type Search = Record<string, string | string[] | undefined>;

const COMMON_KEYS = ["status", "view", "sort", "circleId", "memberId", "columns"];
const TENSION_DATE_KEYS = ["openedFrom", "openedTo", "closedFrom", "closedTo"];

export function reviewListQuery(search: Search, kind: "proposals" | "tensions") {
  const query = new URLSearchParams();
  const allowed = kind === "tensions" ? [...COMMON_KEYS, ...TENSION_DATE_KEYS] : COMMON_KEYS;
  for (const key of allowed) {
    const values = Array.isArray(search[key]) ? search[key] : search[key] ? [search[key]] : [];
    for (const value of values) {
      if (typeof value === "string" && value.length <= 120) query.append(key, value);
    }
  }
  return query.toString();
}

export function parseReviewListQuery(raw: string | string[] | undefined, kind: "proposals" | "tensions") {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value || value.length > 2000) return { search: {} as Search, query: "" };
  const params = new URLSearchParams(value);
  const search: Search = {};
  for (const key of params.keys()) {
    const values = params.getAll(key);
    search[key] = values.length === 1 ? values[0] : values;
  }
  const query = reviewListQuery(search, kind);
  const canonical = new URLSearchParams(query);
  const clean: Search = {};
  for (const key of canonical.keys()) {
    const values = canonical.getAll(key);
    clean[key] = values.length === 1 ? values[0] : values;
  }
  return { search: clean, query };
}

export function reviewItemHref(base: string, query: string | null) {
  return query === null ? base : `${base}?review=${encodeURIComponent(query)}`;
}

export function reviewListHref(base: string, query: string) {
  return query ? `${base}?${query}` : base;
}

export function reviewNeighbors(ids: string[], currentId: string) {
  const index = ids.indexOf(currentId);
  return {
    previousId: index > 0 ? ids[index - 1] : null,
    nextId: index >= 0 && index < ids.length - 1 ? ids[index + 1] : null,
  };
}
