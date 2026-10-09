import React from "react";

export function ActionPagination({
  page,
  pageCount,
  summary,
  previousHref,
  nextHref,
  labels,
}: {
  page: number;
  pageCount: number;
  summary: string;
  previousHref: string;
  nextHref: string;
  labels: { pagination: string; previous: string; next: string };
}) {
  if (pageCount <= 1) return null;

  return (
    <nav className="row" aria-label={labels.pagination} style={{ marginTop: 16, justifyContent: "space-between", gap: 12 }}>
      <span className="muted">{summary}</span>
      <div className="row" style={{ gap: 8 }}>
        {page > 1
          ? <a href={previousHref} className="link-button small">{labels.previous}</a>
          : <span className="tag-sm">{labels.previous}</span>}
        {page < pageCount
          ? <a href={nextHref} className="link-button small">{labels.next}</a>
          : <span className="tag-sm">{labels.next}</span>}
      </div>
    </nav>
  );
}
