import Link from "next/link";

type ArchiveRecord = {
  entityLabel?: string | null;
  archiveReason?: string | null;
  archivedAt?: Date | string | null;
  purgedAt?: Date | string | null;
  purgeReason?: string | null;
} | null;

function formatDateTime(value: Date | string | null | undefined) {
  if (!value) return null;
  return new Date(value).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function UnavailableItemStatus(props: {
  workspaceId: string;
  entityType: string;
  entityId: string;
  archiveRecord?: ArchiveRecord;
  backHref: string;
  backLabel: string;
}) {
  const archivedAt = formatDateTime(props.archiveRecord?.archivedAt);
  const purgedAt = formatDateTime(props.archiveRecord?.purgedAt);
  const isPurged = Boolean(props.archiveRecord?.purgedAt);
  const title = props.archiveRecord?.entityLabel ?? `${props.entityType} ${props.entityId.slice(0, 8)}`;

  return (
    <>
      <header className="nr-masthead" style={{ textAlign: "left", marginBottom: 32 }}>
        <div style={{ marginBottom: 16 }}>
          <Link href={props.backHref} style={{ textDecoration: "none", color: "var(--muted)" }}>
            {props.backLabel}
          </Link>
        </div>
        <h1 style={{ border: "none", padding: 0, margin: 0, fontSize: "2rem" }}>{title}</h1>
        <div className="nr-masthead-meta" style={{ marginTop: 12 }}>
          <span className={`tag ${isPurged ? "danger" : "warning"}`}>
            {isPurged ? "Purged" : "Unavailable"}
          </span>
          <span>{props.entityType}</span>
          <span>{props.entityId}</span>
        </div>
      </header>

      <section className="ws-section">
        <div className="nr-item">
          {isPurged ? (
            <>
              <strong>This item was permanently purged.</strong>
              <p className="nr-item-meta" style={{ margin: "8px 0 0" }}>
                This link is preserved for auditability, but the original content was deleted.
                {purgedAt ? ` Purged ${purgedAt}.` : ""}
                {props.archiveRecord?.purgeReason ? ` Reason: ${props.archiveRecord.purgeReason}` : ""}
              </p>
            </>
          ) : (
            <>
              <strong>This link no longer has a readable item.</strong>
              <p className="nr-item-meta" style={{ margin: "8px 0 0" }}>
                The item may have been removed before permanent links were backfilled.
                {archivedAt ? ` It was archived ${archivedAt}.` : ""}
                {props.archiveRecord?.archiveReason ? ` Reason: ${props.archiveRecord.archiveReason}` : ""}
              </p>
            </>
          )}
        </div>
      </section>
    </>
  );
}
