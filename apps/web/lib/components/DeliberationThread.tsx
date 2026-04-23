import { renderMarkdown } from "@/lib/markdown";
import { formatDateTime } from "@/lib/format";

type DeliberationEntry = {
  id: string;
  entryType: string;
  authorName: string;
  authorInitials: string;
  bodyMd?: string | null;
  createdAt: Date;
  resolvedAt?: Date | null;
  resolvedNote?: string | null;
};

type DeliberationThreadProps = {
  entries: DeliberationEntry[];
  canResolve: boolean;
  resolveAction: (formData: FormData) => Promise<void>;
  hiddenFields: Record<string, string>;
};

function getTypeBadgeProps(type: string) {
  const t = type.toUpperCase();
  if (t === "SUPPORT") return { label: "Support", tagClass: "success", avatarClass: "delib-avatar-support" };
  if (t === "QUESTION") return { label: "Question", tagClass: "info", avatarClass: "delib-avatar-question" };
  if (t === "CONCERN") return { label: "Concern", tagClass: "warning", avatarClass: "delib-avatar-concern" };
  if (t === "OBJECTION") return { label: "Objection", tagClass: "danger", avatarClass: "delib-avatar-objection" };
  return { label: "Reaction", tagClass: "", avatarClass: "delib-avatar-reaction" };
}

export function DeliberationThread({ entries, canResolve, resolveAction, hiddenFields }: DeliberationThreadProps) {
  if (entries.length === 0) return null;

  return (
    <div className="delib-thread">
      {entries.map((entry) => {
        const { label, tagClass, avatarClass } = getTypeBadgeProps(entry.entryType);
        const isResolved = !!entry.resolvedAt;
        const isObjection = entry.entryType.toUpperCase() === "OBJECTION";

        return (
          <div
            key={entry.id}
            className={`delib-entry ${isObjection ? "delib-objection" : ""} ${isResolved ? "delib-resolved" : ""}`}
          >
            <div className="delib-header">
              <div className={`delib-avatar ${avatarClass}`}>{entry.authorInitials}</div>
              <div style={{ fontWeight: 600 }}>{entry.authorName}</div>
              <div className="muted" style={{ margin: "0 4px" }}>·</div>
              <div className="muted">{formatDateTime(entry.createdAt)}</div>
              <div className={`tag ${tagClass}`} style={{ marginLeft: "auto" }}>{label}</div>
            </div>

            {entry.bodyMd && (
              <div
                className="delib-body nr-markdown"
                dangerouslySetInnerHTML={{ __html: renderMarkdown(entry.bodyMd) }}
              />
            )}

            {isResolved && entry.resolvedNote && (
              <div className="delib-resolve-note">
                <strong>Resolved:</strong> {entry.resolvedNote}
              </div>
            )}

            {!isResolved && canResolve && (
              <form action={resolveAction} style={{ marginTop: "12px", display: "flex", gap: "8px", alignItems: "center" }}>
                <input type="hidden" name="entryId" value={entry.id} />
                {Object.entries(hiddenFields).map(([k, v]) => (
                  <input key={k} type="hidden" name={k} value={v} />
                ))}
                <input
                  type="text"
                  name="resolvedNote"
                  placeholder="Resolution note (optional)..."
                  style={{ fontSize: "0.85rem", padding: "6px 10px", flex: 1 }}
                />
                <button type="submit" className="secondary small">Resolve</button>
              </form>
            )}
          </div>
        );
      })}
    </div>
  );
}
