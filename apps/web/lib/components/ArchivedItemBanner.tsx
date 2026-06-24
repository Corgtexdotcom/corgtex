import Link from "next/link";

export function ArchivedItemBanner(props: {
  archivedAt?: Date | string | null;
  archivedBy?: string | null;
  archiveReason?: string | null;
  restoreHref?: string | null;
}) {
  const archivedAt = props.archivedAt
    ? new Date(props.archivedAt).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    })
    : null;
  const archiveMeta = [
    archivedAt ? `Archived ${archivedAt}` : "Archived",
    props.archivedBy ? `by ${props.archivedBy}` : null,
  ].filter(Boolean).join(" ");

  return (
    <div
      className="nr-item"
      style={{
        marginBottom: 24,
        borderColor: "var(--warning)",
        background: "color-mix(in srgb, var(--warning) 10%, transparent)",
      }}
    >
      <div className="row" style={{ alignItems: "flex-start", gap: 16 }}>
        <div style={{ flex: 1 }}>
          <strong>Archived item</strong>
          <p className="nr-item-meta" style={{ margin: "4px 0 0" }}>
            This link still works, but the item is archived and hidden from active workspace lists.
            {archiveMeta ? ` ${archiveMeta}.` : ""}
            {props.archiveReason ? ` Reason: ${props.archiveReason}` : ""}
          </p>
        </div>
        {props.restoreHref && (
          <Link href={props.restoreHref} className="button secondary small">
            View in archive
          </Link>
        )}
      </div>
    </div>
  );
}
