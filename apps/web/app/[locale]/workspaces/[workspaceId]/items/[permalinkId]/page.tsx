import { redirect } from "next/navigation";
import Link from "next/link";
import { resolveWorkspacePermalink } from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";

export const dynamic = "force-dynamic";

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

export default async function WorkspacePermanentItemPage({
  params,
}: {
  params: Promise<{ workspaceId: string; permalinkId: string }>;
}) {
  const { workspaceId, permalinkId } = await params;
  const actor = await requirePageActor();
  const resolved = await resolveWorkspacePermalink(actor, { workspaceId, permalinkId });

  if (resolved.status === "ACTIVE" || resolved.status === "ARCHIVED") {
    redirect(resolved.canonicalPath);
  }

  const archiveRecord = resolved.archiveRecord;
  const purgedAt = formatDateTime(archiveRecord?.purgedAt);
  const archivedAt = formatDateTime(archiveRecord?.archivedAt);
  const title = archiveRecord?.entityLabel ?? `${resolved.permalink.entityType} ${resolved.permalink.entityId.slice(0, 8)}`;

  return (
    <>
      <header className="nr-masthead" style={{ textAlign: "left", marginBottom: 32 }}>
        <div style={{ marginBottom: 16 }}>
          <Link href={`/workspaces/${workspaceId}/audit?tab=archive`} style={{ textDecoration: "none", color: "var(--muted)" }}>
            Back to archive
          </Link>
        </div>
        <h1 style={{ border: "none", padding: 0, margin: 0, fontSize: "2rem" }}>{title}</h1>
        <div className="nr-masthead-meta" style={{ marginTop: 12 }}>
          <span className={`tag ${resolved.status === "PURGED" ? "danger" : "warning"}`}>
            {resolved.status === "PURGED" ? "Purged" : "Unavailable"}
          </span>
          <span>{resolved.permalink.entityType}</span>
          <span>{resolved.permalink.entityId}</span>
        </div>
      </header>

      <section className="ws-section">
        <div className="nr-item">
          {resolved.status === "PURGED" ? (
            <>
              <strong>This item was permanently purged.</strong>
              <p className="nr-item-meta" style={{ margin: "8px 0 0" }}>
                The permanent link is preserved for auditability, but the original content was deleted.
                {purgedAt ? ` Purged ${purgedAt}.` : ""}
                {archiveRecord?.purgeReason ? ` Reason: ${archiveRecord.purgeReason}` : ""}
              </p>
            </>
          ) : (
            <>
              <strong>This permanent link no longer has a readable item.</strong>
              <p className="nr-item-meta" style={{ margin: "8px 0 0" }}>
                The item may have been removed before permanent links were backfilled.
                {archivedAt ? ` It was archived ${archivedAt}.` : ""}
              </p>
            </>
          )}
        </div>
      </section>
    </>
  );
}
