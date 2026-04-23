import { formatDateTime } from "@/lib/format";
import type { DeliberationEntry } from "@prisma/client";

export type DeliberationThreadProps = {
  entries: {
    id: string;
    entryType: string;
    bodyMd: string | null;
    createdAt: Date;
    resolvedAt: Date | null;
    resolvedNote: string | null;
    author: {
      displayName: string | null;
      email: string;
    };
  }[];
  resolveAction?: (formData: FormData) => void | Promise<void>;
  canResolve?: boolean;
};

export function DeliberationThread({ entries, resolveAction, canResolve }: DeliberationThreadProps) {
  if (!entries || entries.length === 0) {
    return <div className="text-muted text-sm italic py-4">No deliberation entries yet.</div>;
  }

  const getAvatarProps = (type: string) => {
    switch (type) {
      case "SUPPORT": return { label: "Su", class: "delib-avatar-support" };
      case "QUESTION": return { label: "Qu", class: "delib-avatar-question" };
      case "CONCERN": return { label: "Co", class: "delib-avatar-concern" };
      case "OBJECTION": return { label: "Ob", class: "delib-avatar-objection" };
      case "REACTION": default: return { label: "Re", class: "delib-avatar-reaction" };
    }
  };

  const getBadgeClass = (type: string) => {
    switch (type) {
      case "SUPPORT": return "tag success";
      case "QUESTION": return "tag info";
      case "CONCERN": return "tag warning";
      case "OBJECTION": return "tag danger";
      default: return "tag info";
    }
  };

  return (
    <div className="delib-thread">
      {entries.map((entry) => {
        const avatar = getAvatarProps(entry.entryType);
        const authorName = entry.author.displayName || entry.author.email || "Unknown";
        const isResolved = !!entry.resolvedAt;

        return (
          <div key={entry.id} className={`delib-entry ${entry.entryType === "OBJECTION" ? "delib-objection" : ""} ${isResolved ? "delib-resolved" : ""}`}>
            <div className="delib-header">
              <div className={`delib-avatar ${avatar.class}`}>{avatar.label}</div>
              <strong>{authorName}</strong>
              <span className="text-muted text-xs mx-1">·</span>
              <span className="text-muted text-xs">{formatDateTime(entry.createdAt)}</span>
              <span className="text-muted text-xs mx-1">·</span>
              <span className={getBadgeClass(entry.entryType)}>{entry.entryType}</span>
              {isResolved && <span className="tag success ml-2">RESOLVED</span>}
            </div>

            <div className="delib-body">
              {entry.bodyMd}
            </div>

            {isResolved && entry.resolvedNote && (
              <div className="delib-resolve-note">
                <strong>Resolution Note:</strong> {entry.resolvedNote}
              </div>
            )}

            {!isResolved && canResolve && resolveAction && (
              <div className="mt-3">
                <form action={resolveAction} className="flex gap-2 items-center">
                  <input type="hidden" name="entryId" value={entry.id} />
                  <input type="text" name="resolvedNote" placeholder="Resolution note..." className="input-sm flex-1" required />
                  <button type="submit" className="btn btn-sm btn-outline">Resolve</button>
                </form>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
