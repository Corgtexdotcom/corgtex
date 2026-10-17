/** Counts and empty states describe this window, including on a final older page. */
export function HistoryWindowNavigation({limited, unavailable = false, nextHref, latestHref, labels}: {
  limited: boolean; unavailable?: boolean; nextHref?: string | null; latestHref?: string | null;
  labels: {limited: string; unavailable: string; older: string; latest: string};
}) {
  return <div className="stack" style={{gap: 8, marginBottom: 16}}>
    {(limited || unavailable) && <p role="status" className="nr-item-meta">{unavailable ? labels.unavailable : labels.limited}</p>}
    <nav aria-label={labels.older} className="actions-inline" style={{flexWrap: "wrap"}}>
      {nextHref && <a className="link-button secondary small" href={nextHref}>{labels.older}</a>}
      {latestHref && <a className="link-button secondary small" href={latestHref}>{labels.latest}</a>}
    </nav>
  </div>;
}
