"use client";

import { useEffect, useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { MarkdownEditor } from "./MarkdownEditor";
import { useFormatter, useTranslations } from "next-intl";

type DeliberationEntry = {
  id: string;
  entryType: string;
  authorName: string;
  authorInitials: string;
  bodyMd?: string | null;
  createdAt: Date | string;
  parentVersion?: number | null;
  resolvedAt?: Date | string | null;
  resolvedNote?: string | null;
  targetLabel?: string | null;
  canEdit?: boolean;
  canResolve?: boolean;
};

type DeliberationThreadProps = {
  entries: DeliberationEntry[];
  canResolve: boolean;
  resolveAction?: (formData: FormData) => Promise<void>;
  updateAction?: (formData: FormData) => Promise<void>;
  apiEndpoint?: string;
  hiddenFields: Record<string, string>;
  emptyMessage?: string;
};

function getTypeBadgeProps(type: string, t: (key: "entryObjection" | "entryReaction") => string) {
  const entryType = type.toUpperCase();
  if (entryType === "OBJECTION") return { label: t("entryObjection"), tagClass: "danger", avatarClass: "delib-avatar-objection" };
  return { label: t("entryReaction"), tagClass: "", avatarClass: "delib-avatar-reaction" };
}

async function responseErrorMessage(response: Response, fallback: string) {
  try {
    const body = await response.json();
    const message = body?.error?.message;
    return typeof message === "string" && message.length > 0 ? message : fallback;
  } catch {
    return fallback;
  }
}

function unknownErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message.length > 0 ? error.message : fallback;
}

function focusEntry(entryId: string) {
  const focus = () => {
    document.getElementById(`delib-entry-${entryId}`)?.focus();
  };
  window.requestAnimationFrame(focus);
  window.setTimeout(focus, 250);
}

export function DeliberationThread({ entries, canResolve, resolveAction, updateAction, apiEndpoint, hiddenFields, emptyMessage }: DeliberationThreadProps) {
  const t = useTranslations("deliberation");
  const tCommon = useTranslations("common");
  const format = useFormatter();
  const router = useRouter();
  const [editingEntryId, setEditingEntryId] = useState<string | null>(null);
  const [editType, setEditType] = useState("REACTION");
  const [editBody, setEditBody] = useState("");
  const [pendingEntryId, setPendingEntryId] = useState<string | null>(null);
  const [focusEntryId, setFocusEntryId] = useState<string | null>(null);
  const [errorByEntryId, setErrorByEntryId] = useState<Record<string, string>>({});
  const [isHydrated, setIsHydrated] = useState(false);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    setIsHydrated(true);
  }, []);

  useEffect(() => {
    if (!focusEntryId || !entries.some((entry) => entry.id === focusEntryId)) return;
    focusEntry(focusEntryId);
    setFocusEntryId(null);
  }, [entries, focusEntryId]);

  if (entries.length === 0) {
    return emptyMessage ? <p className="work-conversation-empty">{emptyMessage}</p> : null;
  }

  const startEdit = (entry: DeliberationEntry) => {
    setEditingEntryId(entry.id);
    setEditType(entry.entryType);
    setEditBody(entry.bodyMd ?? "");
    setErrorByEntryId((current) => {
      const next = { ...current };
      delete next[entry.id];
      return next;
    });
  };

  const cancelEdit = () => {
    setEditingEntryId(null);
    setEditBody("");
    setEditType("REACTION");
  };

  const submitApiUpdate = (event: FormEvent<HTMLFormElement>, entry: DeliberationEntry) => {
    event.preventDefault();
    if (!apiEndpoint) return;

    startTransition(async () => {
      setPendingEntryId(entry.id);
      setErrorByEntryId((current) => {
        const next = { ...current };
        delete next[entry.id];
        return next;
      });
      try {
        const response = await fetch(`${apiEndpoint}/${encodeURIComponent(entry.id)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            entryType: editType,
            bodyMd: editBody,
          }),
        });
        if (!response.ok) {
          throw new Error(await responseErrorMessage(response, t("entryPostFailed")));
        }
        cancelEdit();
        setFocusEntryId(entry.id);
        router.refresh();
      } catch (error: unknown) {
        setErrorByEntryId((current) => ({
          ...current,
          [entry.id]: unknownErrorMessage(error, t("entryPostFailed")),
        }));
      } finally {
        setPendingEntryId(null);
      }
    });
  };

  const submitApiResolve = (event: FormEvent<HTMLFormElement>, entry: DeliberationEntry) => {
    event.preventDefault();
    if (!apiEndpoint) return;

    const form = event.currentTarget;
    const formData = new FormData(form);
    const resolvedNote = String(formData.get("resolvedNote") ?? "");

    startTransition(async () => {
      setPendingEntryId(entry.id);
      setErrorByEntryId((current) => {
        const next = { ...current };
        delete next[entry.id];
        return next;
      });
      try {
        const response = await fetch(`${apiEndpoint}/${encodeURIComponent(entry.id)}/resolve`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ resolvedNote }),
        });
        if (!response.ok) {
          throw new Error(await responseErrorMessage(response, t("entryPostFailed")));
        }
        form.reset();
        setFocusEntryId(entry.id);
        router.refresh();
      } catch (error: unknown) {
        setErrorByEntryId((current) => ({
          ...current,
          [entry.id]: unknownErrorMessage(error, t("entryPostFailed")),
        }));
      } finally {
        setPendingEntryId(null);
      }
    });
  };

  return (
    <div className="delib-thread">
      {entries.map((entry) => {
        const { label, tagClass, avatarClass } = getTypeBadgeProps(entry.entryType, t);
        const isResolved = !!entry.resolvedAt;
        const isObjection = entry.entryType.toUpperCase() === "OBJECTION";
        const canEditEntry = !isResolved && !!entry.canEdit && Boolean(apiEndpoint || updateAction);
        const canResolveEntry = !isResolved && (entry.canResolve ?? canResolve) && Boolean(apiEndpoint || resolveAction);
        const isEditing = editingEntryId === entry.id;
        const isEntryPending = isPending && pendingEntryId === entry.id;
        const isApiEntryDisabled = isEntryPending || (Boolean(apiEndpoint) && !isHydrated);
        const errorMessage = errorByEntryId[entry.id];

        return (
          <article
            key={entry.id}
            id={`delib-entry-${entry.id}`}
            tabIndex={-1}
            className={`delib-entry ${isObjection ? "delib-objection" : ""} ${isResolved ? "delib-resolved" : ""}`}
          >
            <div className="delib-header">
              <div className={`delib-avatar ${avatarClass}`}>{entry.authorInitials}</div>
              <div className="delib-header-main">
                <div className="delib-author-line">
                  <strong>{entry.authorName}</strong>
                  <span className={`tag ${tagClass}`}>{label}</span>
                </div>
                <div className="delib-meta-line">
                  <span>
                    {format.dateTime(new Date(entry.createdAt), {
                      month: "short",
                      day: "numeric",
                      hour: "numeric",
                      minute: "2-digit",
                    })}
                  </span>
                  {entry.targetLabel && <span>{entry.targetLabel}</span>}
                  {entry.parentVersion && <span>v{entry.parentVersion}</span>}
                </div>
              </div>
            </div>

            {entry.bodyMd && (
              <MarkdownRenderer markdown={entry.bodyMd} variant="document" className="delib-body" />
            )}

            {isResolved && entry.resolvedNote && (
              <div className="delib-resolve-note">
                <strong>{t("resolved")}:</strong> {entry.resolvedNote}
              </div>
            )}

            {canEditEntry && apiEndpoint && (
              <div className="delib-edit-panel">
                {!isEditing ? (
                  <button type="button" className="secondary small" onClick={() => startEdit(entry)} disabled={isApiEntryDisabled}>
                    {tCommon("edit")}
                  </button>
                ) : (
                  <form onSubmit={(event) => submitApiUpdate(event, entry)} className="delib-inline-form" data-api-ready={String(isHydrated)}>
                    <label>
                      {t("entryType")}
                      <select value={editType} onChange={(event) => setEditType(event.target.value)} disabled={isApiEntryDisabled}>
                        <option value="REACTION">{t("entryReaction")}</option>
                        <option value="OBJECTION">{t("entryObjection")}</option>
                      </select>
                    </label>
                    <MarkdownEditor name="bodyMd" value={editBody} onValueChange={setEditBody} rows={4} disabled={isApiEntryDisabled} />
                    {errorMessage && <div className="form-message form-message-error">{errorMessage}</div>}
                    <div className="row" style={{ gap: 8 }}>
                      <button type="submit" className="secondary small" disabled={isApiEntryDisabled} style={{ alignSelf: "flex-start" }}>
                        {tCommon("save")}
                      </button>
                      <button type="button" className="secondary small" onClick={cancelEdit} disabled={isApiEntryDisabled}>
                        {tCommon("cancel")}
                      </button>
                    </div>
                  </form>
                )}
              </div>
            )}

            {canEditEntry && !apiEndpoint && updateAction && (
              <details className="delib-edit-panel">
                <summary className="secondary small nr-hide-marker">
                  {tCommon("edit")}
                </summary>
                <form action={updateAction} className="delib-inline-form">
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
                  <MarkdownEditor name="bodyMd" defaultValue={entry.bodyMd ?? ""} resetKey={`${entry.id}:${entry.bodyMd ?? ""}`} rows={4} />
                  <button type="submit" className="secondary small" style={{ alignSelf: "flex-start" }}>{tCommon("save")}</button>
                </form>
              </details>
            )}

            {canResolveEntry && apiEndpoint && (
              <form onSubmit={(event) => submitApiResolve(event, entry)} className="delib-resolve-form" data-api-ready={String(isHydrated)}>
                <input
                  type="text"
                  name="resolvedNote"
                  placeholder={t("resolvePlaceholder")}
                  required
                  disabled={isApiEntryDisabled}
                />
                <button type="submit" className="secondary small" disabled={isApiEntryDisabled}>{t("resolve")}</button>
                {errorMessage && !isEditing && <div className="form-message form-message-error">{errorMessage}</div>}
              </form>
            )}

            {canResolveEntry && !apiEndpoint && resolveAction && (
              <form action={resolveAction} className="delib-resolve-form">
                <input type="hidden" name="entryId" value={entry.id} />
                {Object.entries(hiddenFields).map(([k, v]) => (
                  <input key={k} type="hidden" name={k} value={v} />
                ))}
                <input
                  type="text"
                  name="resolvedNote"
                  placeholder={t("resolvePlaceholder")}
                  required
                />
                <button type="submit" className="secondary small">{t("resolve")}</button>
              </form>
            )}
          </article>
        );
      })}
    </div>
  );
}
