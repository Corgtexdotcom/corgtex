type Search = Record<string, string | string[] | undefined>;

/** Retain the entity route and every unrelated filter when changing advice windows. */
export function adviceRequestWindowHref(path: string, search: Search, cursor: string | null) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(search)) {
    if (key === "adviceCursor") continue;
    for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) query.append(key, item);
  }
  if (cursor) query.set("adviceCursor", cursor);
  return `${path}${query.size ? `?${query}` : ""}#advice-requests`;
}

export function AdviceRequestWindowNotice({ page, path, search, labels }: {
  page: { complete: boolean; nextCursor: string | null };
  path: string;
  search: Search;
  labels: { limited: string; older: string; newest: string };
}) {
  const continued = typeof search.adviceCursor === "string" && Boolean(search.adviceCursor);
  if (page.complete && !continued) return null;
  return <div className="nr-caption" role="status" style={{ marginBlock: 16 }}>
    <p>{labels.limited}</p>
    <div className="actions-inline">
      {page.nextCursor && <a href={adviceRequestWindowHref(path, search, page.nextCursor)}>{labels.older}</a>}
      {continued && <a href={adviceRequestWindowHref(path, search, null)}>{labels.newest}</a>}
    </div>
  </div>;
}
