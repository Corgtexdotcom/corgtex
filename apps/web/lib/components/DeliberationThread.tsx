import { MarkdownRenderer } from "./MarkdownRenderer";
import { MarkdownEditor } from "./MarkdownEditor";
import { useFormatter, useTranslations } from "next-intl";

type DeliberationEntry = {
  id: string;
  entryType: string;
  authorName: string;
  authorInitials: string;
  bodyMd?: string | null;
  createdAt: Date;
  parentVersion?: number | null;
  resolvedAt?: Date | null;
  resolvedNote?: string | null;
  targetLabel?: string | null;
  canEdit?: boolean;
  canResolve?: boolean;
};

type DeliberationThreadProps = {
  entries: DeliberationEntry[];
  canResolve: boolean;
  resolveAction: (formData: FormData) => Promise<void>;
  updateAction?: (formData: FormData) => Promise<void>;
  hiddenFields: Record<string, string>;
};

function getTypeBadgeProps(type: string, t: (key: "entryObjection" | "entryReaction") => string) {
  const entryType = type.toUpperCase();
  if (entryType === "OBJECTION") return { label: t("entryObjection"), tagClass: "danger", avatarClass: "delib-avatar-objection" };
  return { label: t("entryReaction"), tagClass: "", avatarClass: "delib-avatar-reaction" };
}

export function DeliberationThread({ entries, canResolve, resolveAction, updateAction, hiddenFields }: DeliberationThreadProps) {
  const t = useTranslations("deliberation");
  const tCommon = useTranslations("common");
  const format = useFormatter();

  if (entries.length === 0) return null;

  return (
    <div className="delib-thread">
      {entries.map((entry) => {
        const { label, tagClass, avatarClass } = getTypeBadgeProps(entry.entryType, t);
        const isResolved = !!entry.resolvedAt;
        const isObjection = entry.entryType.toUpperCase() === "OBJECTION";
        const canEditEntry = !isResolved && !!entry.canEdit && !!updateAction;
        const canResolveEntry = !isResolved && (entry.canResolve ?? canResolve);

        return (
          <div
            key={entry.id}
            className={`delib-entry ${isObjection ? "delib-objection" : ""} ${isResolved ? "delib-resolved" : ""}`}
          >
            <div className="delib-header">
              <div className={`delib-avatar ${avatarClass}`}>{entry.authorInitials}</div>
              <div style={{ fontWeight: 600 }}>{entry.authorName}</div>
              <div className="muted" style={{ margin: "0 4px" }}>·</div>
              <div className="muted">
                {format.dateTime(entry.createdAt, {
                  month: "short",
                  day: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                })}
              </div>
              {entry.targetLabel && (
                <>
                  <div className="muted" style={{ margin: "0 4px" }}>·</div>
                  <div className="muted">{entry.targetLabel}</div>
                </>
              )}
              {entry.parentVersion && (
                <>
                  <div className="muted" style={{ margin: "0 4px" }}>·</div>
                  <div className="muted">on v{entry.parentVersion}</div>
                </>
              )}
              <div className={`tag ${tagClass}`} style={{ marginLeft: "auto" }}>{label}</div>
            </div>

            {entry.bodyMd && (
              <MarkdownRenderer markdown={entry.bodyMd} variant="document" className="delib-body" />
            )}

            {isResolved && entry.resolvedNote && (
              <div className="delib-resolve-note">
                <strong>{t("resolved")}:</strong> {entry.resolvedNote}
              </div>
            )}

            {canEditEntry && (
              <details style={{ marginTop: "12px" }}>
                <summary className="secondary small nr-hide-marker" style={{ cursor: "pointer", display: "inline-block" }}>
                  {tCommon("edit")}
                </summary>
                <form action={updateAction} style={{ marginTop: "12px", display: "flex", flexDirection: "column", gap: "10px" }}>
                  <input type="hidden" name="entryId" value={entry.id} />
                  {Object.entries(hiddenFields).map(([k, v]) => (
                    <input key={k} type="hidden" name={k} value={v} />
                  ))}
                  <label>
                    {t("entryType")}
                    <select name="entryType" defaultValue={entry.entryType}>
                      <option value="REACTION">{t("entryReaction")}</option>
                      <option value="OBJECTION">{t("entryObjection")}</option>
                    </select>
                  </label>
                  <MarkdownEditor name="bodyMd" defaultValue={entry.bodyMd ?? ""} rows={4} />
                  <button type="submit" className="secondary small" style={{ alignSelf: "flex-start" }}>{tCommon("save")}</button>
                </form>
              </details>
            )}

            {canResolveEntry && (
              <form action={resolveAction} style={{ marginTop: "12px", display: "flex", gap: "8px", alignItems: "center", width: "100%" }}>
                <input type="hidden" name="entryId" value={entry.id} />
                {Object.entries(hiddenFields).map(([k, v]) => (
                  <input key={k} type="hidden" name={k} value={v} />
                ))}
                <input
                  type="text"
                  name="resolvedNote"
                  placeholder={t("resolvePlaceholder")}
                  required
                  style={{ fontSize: "0.85rem", padding: "6px 10px", flex: "1 1 220px", minWidth: 0, width: "auto" }}
                />
                <button type="submit" className="secondary small" style={{ flex: "0 0 auto" }}>{t("resolve")}</button>
              </form>
            )}
          </div>
        );
      })}
    </div>
  );
}
