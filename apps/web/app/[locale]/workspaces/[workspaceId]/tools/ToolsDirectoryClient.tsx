"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { MarkdownEditor } from "@/lib/components/MarkdownEditor";
import { MarkdownExcerpt, MarkdownRenderer } from "@/lib/components/MarkdownRenderer";

type CircleOption = {
  id: string;
  name: string;
};

type ToolLink = {
  id: string;
  title: string;
  url: string;
  category: string;
  descriptionMd: string | null;
  accessNotesMd: string | null;
  previewTitle: string | null;
  previewDescription: string | null;
  previewImageUrl: string | null;
  previewFaviconUrl: string | null;
  credentialLabel: string | null;
  hasCredential: boolean;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  createdBy: { id: string; email: string; displayName: string | null } | null;
  circles: CircleOption[];
  canManage: boolean;
};

type FormState = {
  title: string;
  url: string;
  category: string;
  descriptionMd: string;
  accessNotesMd: string;
  previewTitle: string;
  previewDescription: string;
  previewImageUrl: string;
  credentialLabel: string;
  credentialSecret: string;
  circleIds: string[];
};

const EMPTY_FORM: FormState = {
  title: "",
  url: "",
  category: "OTHER",
  descriptionMd: "",
  accessNotesMd: "",
  previewTitle: "",
  previewDescription: "",
  previewImageUrl: "",
  credentialLabel: "",
  credentialSecret: "",
  circleIds: [],
};

const CATEGORIES = [
  ["WHITEBOARD", "categoryWhiteboard"],
  ["FILES", "categoryFiles"],
  ["COMMUNICATION", "categoryCommunication"],
  ["OPERATIONS", "categoryOperations"],
  ["OTHER", "categoryOther"],
] as const;

function domainFor(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function displayDate(value: string) {
  return new Date(value).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function linkToForm(link: ToolLink): FormState {
  return {
    title: link.title,
    url: link.url,
    category: link.category,
    descriptionMd: link.descriptionMd ?? "",
    accessNotesMd: link.accessNotesMd ?? "",
    previewTitle: link.previewTitle ?? "",
    previewDescription: link.previewDescription ?? "",
    previewImageUrl: link.previewImageUrl ?? "",
    credentialLabel: link.credentialLabel ?? "",
    credentialSecret: "",
    circleIds: link.circles.map((circle) => circle.id),
  };
}

export function ToolsDirectoryClient({
  workspaceId,
  initialLinks,
  circles,
  initialView,
}: {
  workspaceId: string;
  initialLinks: ToolLink[];
  circles: CircleOption[];
  initialView: "list" | "grid";
}) {
  const router = useRouter();
  const t = useTranslations("tools");
  const [links, setLinks] = useState(initialLinks);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<Record<string, string | null>>({});
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const isEditing = Boolean(editingId);

  const groupedLinks = useMemo(() => {
    return [...links].sort((a, b) => a.title.localeCompare(b.title));
  }, [links]);

  function setField<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function toggleCircle(circleId: string) {
    setForm((current) => ({
      ...current,
      circleIds: current.circleIds.includes(circleId)
        ? current.circleIds.filter((id) => id !== circleId)
        : [...current.circleIds, circleId],
    }));
  }

  function resetForm() {
    setForm(EMPTY_FORM);
    setEditingId(null);
    setIsFormOpen(false);
    setError(null);
  }

  function startEdit(link: ToolLink) {
    setForm(linkToForm(link));
    setEditingId(link.id);
    setIsFormOpen(true);
    setError(null);
  }

  async function submitForm(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    const payload: Record<string, unknown> = {
      title: form.title,
      url: form.url,
      category: form.category,
      descriptionMd: form.descriptionMd,
      accessNotesMd: form.accessNotesMd,
      previewTitle: form.previewTitle,
      previewDescription: form.previewDescription,
      previewImageUrl: form.previewImageUrl,
      credentialLabel: form.credentialLabel,
      circleIds: form.circleIds,
    };
    if (form.credentialSecret.trim()) {
      payload.credentialSecret = form.credentialSecret;
    }

    const res = await fetch(
      editingId
        ? `/api/workspaces/${workspaceId}/tool-links/${editingId}`
        : `/api/workspaces/${workspaceId}/tool-links`,
      {
        method: editingId ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
    );
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      setError(data?.error?.message ?? t("errorGeneric"));
      return;
    }

    setLinks((current) => (
      editingId
        ? current.map((link) => (link.id === editingId ? data : link))
        : [data, ...current]
    ));
    resetForm();
    router.refresh();
  }

  async function archiveLink(link: ToolLink) {
    if (!window.confirm(t("confirmArchive"))) return;
    const res = await fetch(`/api/workspaces/${workspaceId}/tool-links/${link.id}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      setError(data?.error?.message ?? t("errorGeneric"));
      return;
    }
    setLinks((current) => current.filter((item) => item.id !== link.id));
    router.refresh();
  }

  async function revealCredential(link: ToolLink) {
    const res = await fetch(`/api/workspaces/${workspaceId}/tool-links/${link.id}/reveal`, {
      method: "POST",
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      setError(data?.error?.message ?? t("errorGeneric"));
      return;
    }
    setRevealed((current) => ({ ...current, [link.id]: data.credentialSecret ?? null }));
  }

  async function copyCredential(linkId: string) {
    const secret = revealed[linkId];
    if (!secret) return;
    await navigator.clipboard.writeText(secret);
    setCopiedId(linkId);
    window.setTimeout(() => setCopiedId(null), 1800);
  }

  function renderCredential(link: ToolLink) {
    if (!link.hasCredential) {
      return <span className="muted" style={{ fontSize: "0.82rem" }}>{t("hasNoCredential")}</span>;
    }

    const secret = revealed[link.id];
    return (
      <div className="stack" style={{ gap: 8 }}>
        <div className="nr-item-meta" style={{ margin: 0 }}>
          {link.credentialLabel || t("credential")}
        </div>
        {secret === undefined ? (
          <button type="button" className="secondary small" onClick={() => revealCredential(link)}>
            {t("btnReveal")}
          </button>
        ) : (
          <div className="actions-inline">
            <input
              readOnly
              value={secret ?? ""}
              style={{ minWidth: 180, maxWidth: 280 }}
              aria-label={link.credentialLabel || t("credential")}
            />
            <button type="button" className="secondary small" onClick={() => copyCredential(link.id)}>
              {copiedId === link.id ? t("btnCopied") : t("btnCopy")}
            </button>
          </div>
        )}
      </div>
    );
  }

  function renderTags(link: ToolLink) {
    return (
      <div className="actions-inline" style={{ gap: 6 }}>
        <span className="tag">{categoryLabel(link.category)}</span>
        {link.circles.map((circle) => (
          <span className="tag info" key={circle.id}>{circle.name}</span>
        ))}
        {link.hasCredential && <span className="tag success">{t("credentialConfigured")}</span>}
      </div>
    );
  }

  function categoryLabel(category: string) {
    const match = CATEGORIES.find(([value]) => value === category);
    return match ? t(match[1]) : category;
  }

  function renderPreview(link: ToolLink) {
    const host = domainFor(link.url);
    return (
      <div
        style={{
          border: "1px solid var(--line)",
          borderRadius: 8,
          overflow: "hidden",
          background: "var(--surface-strong)",
          minHeight: 154,
        }}
      >
        {link.previewImageUrl ? (
          <div
            aria-hidden="true"
            style={{
              height: 96,
              backgroundImage: `url("${link.previewImageUrl.replace(/"/g, "%22")}")`,
              backgroundPosition: "center",
              backgroundSize: "cover",
              backgroundColor: "var(--bg-alt)",
            }}
          />
        ) : (
          <div
            style={{
              height: 96,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "var(--bg-alt)",
              fontSize: "2rem",
              fontWeight: 700,
            }}
          >
            {link.title.slice(0, 1).toUpperCase()}
          </div>
        )}
        <div style={{ padding: 12 }}>
          <strong style={{ display: "block", fontSize: "0.95rem" }}>
            {link.previewTitle || link.title}
          </strong>
          <div className="nr-item-meta" style={{ marginTop: 4 }}>{host}</div>
          {(link.previewDescription || link.descriptionMd) && (
            <p style={{ margin: "8px 0 0", color: "var(--muted)", fontSize: "0.82rem", lineHeight: 1.45 }}>
              {link.previewDescription || <MarkdownExcerpt markdown={link.descriptionMd} maxLength={130} />}
            </p>
          )}
        </div>
      </div>
    );
  }

  function renderListView() {
    return (
      <div className="nr-table-wrap">
        <table className="nr-table">
          <thead>
            <tr>
              <th>{t("formTitle")}</th>
              <th>{t("formCategory")}</th>
              <th>{t("accessNotes")}</th>
              <th>{t("credential")}</th>
              <th>{t("updatedAt", { date: "" }).trim()}</th>
              <th>{t("btnOpen")}</th>
            </tr>
          </thead>
          <tbody>
            {groupedLinks.map((link) => (
              <tr key={link.id}>
                <td style={{ minWidth: 220, verticalAlign: "top" }}>
                  <strong>{link.title}</strong>
                  <div className="nr-item-meta">{domainFor(link.url)}</div>
                  {link.descriptionMd && (
                    <MarkdownRenderer markdown={link.descriptionMd} variant="compact" className="mt-2" />
                  )}
                  <div style={{ marginTop: 8 }}>{renderTags(link)}</div>
                </td>
                <td style={{ verticalAlign: "top" }}>{categoryLabel(link.category)}</td>
                <td style={{ minWidth: 220, verticalAlign: "top" }}>
                  {link.accessNotesMd ? <MarkdownRenderer markdown={link.accessNotesMd} variant="compact" /> : <span className="muted">-</span>}
                </td>
                <td style={{ minWidth: 240, verticalAlign: "top" }}>{renderCredential(link)}</td>
                <td style={{ minWidth: 150, verticalAlign: "top" }}>
                  <div>{displayDate(link.updatedAt)}</div>
                  <div className="nr-item-meta">
                    {link.createdBy
                      ? t("addedBy", { name: link.createdBy.displayName ?? link.createdBy.email })
                      : t("createdAt", { date: displayDate(link.createdAt) })}
                  </div>
                </td>
                <td style={{ minWidth: 170, verticalAlign: "top" }}>
                  <div className="actions-inline">
                    <a className="link-button small" href={link.url} target="_blank" rel="noreferrer">
                      {t("btnOpen")}
                    </a>
                    {link.canManage && (
                      <>
                        <button type="button" className="secondary small" onClick={() => startEdit(link)}>
                          {t("btnEdit")}
                        </button>
                        <button type="button" className="danger small" onClick={() => archiveLink(link)}>
                          {t("btnArchive")}
                        </button>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  function renderGridView() {
    return (
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 16 }}>
        {groupedLinks.map((link) => (
          <article
            key={link.id}
            style={{
              border: "1px solid var(--line)",
              borderRadius: 8,
              padding: 14,
              background: "var(--surface-strong)",
              display: "grid",
              gap: 12,
            }}
          >
            {renderPreview(link)}
            <div>
              <h2 style={{ fontSize: "1rem", margin: "0 0 6px" }}>{link.title}</h2>
              {renderTags(link)}
            </div>
            {link.accessNotesMd && (
              <MarkdownRenderer markdown={link.accessNotesMd} variant="compact" className="muted" />
            )}
            {renderCredential(link)}
            <div className="actions-inline">
              <a className="link-button small" href={link.url} target="_blank" rel="noreferrer">
                {t("btnOpen")}
              </a>
              {link.canManage && (
                <>
                  <button type="button" className="secondary small" onClick={() => startEdit(link)}>
                    {t("btnEdit")}
                  </button>
                  <button type="button" className="danger small" onClick={() => archiveLink(link)}>
                    {t("btnArchive")}
                  </button>
                </>
              )}
            </div>
          </article>
        ))}
      </div>
    );
  }

  return (
    <section className="ws-section stack" style={{ gap: 24 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
        <button
          type="button"
          className={isFormOpen ? "secondary small" : "small"}
          onClick={() => {
            if (isFormOpen) {
              resetForm();
            } else {
              setIsFormOpen(true);
            }
          }}
        >
          {isFormOpen ? t("btnCancel") : t("btnAddTool")}
        </button>
      </div>

      {error && <div className="form-message form-message-error">{error}</div>}

      {isFormOpen && (
        <form
          onSubmit={submitForm}
          className="nr-form-section stack"
          style={{ border: "1px solid var(--line)", borderRadius: 8, padding: 20, marginBottom: 8 }}
        >
          <h2 style={{ margin: 0, fontSize: "1.1rem" }}>{isEditing ? t("editTitle") : t("newTitle")}</h2>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 14 }}>
            <label>
              {t("formTitle")}
              <input required value={form.title} onChange={(event) => setField("title", event.target.value)} />
            </label>
            <label>
              {t("formUrl")}
              <input required value={form.url} onChange={(event) => setField("url", event.target.value)} placeholder="https://example.com" />
            </label>
            <label>
              {t("formCategory")}
              <select value={form.category} onChange={(event) => setField("category", event.target.value)}>
                {CATEGORIES.map(([value, labelKey]) => (
                  <option key={value} value={value}>{t(labelKey)}</option>
                ))}
              </select>
            </label>
          </div>
          <label>
            {t("formDescription")}
            <MarkdownEditor
              name="descriptionMd"
              value={form.descriptionMd}
              onValueChange={(descriptionMd) => setField("descriptionMd", descriptionMd)}
              placeholder={t("placeholderDescription")}
              rows={4}
            />
          </label>
          <label>
            {t("formAccessNotes")}
            <MarkdownEditor
              name="accessNotesMd"
              value={form.accessNotesMd}
              onValueChange={(accessNotesMd) => setField("accessNotesMd", accessNotesMd)}
              placeholder={t("placeholderAccessNotes")}
              rows={4}
            />
          </label>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 14 }}>
            <label>
              {t("formPreviewTitle")}
              <input value={form.previewTitle} onChange={(event) => setField("previewTitle", event.target.value)} placeholder={t("placeholderPreviewTitle")} />
            </label>
            <label>
              {t("formPreviewImageUrl")}
              <input value={form.previewImageUrl} onChange={(event) => setField("previewImageUrl", event.target.value)} />
            </label>
          </div>
          <label>
            {t("formPreviewDescription")}
            <input value={form.previewDescription} onChange={(event) => setField("previewDescription", event.target.value)} placeholder={t("placeholderPreviewDescription")} />
          </label>
          <fieldset style={{ border: "1px solid var(--line)", borderRadius: 8, padding: 14 }}>
            <legend style={{ padding: "0 6px", fontWeight: 600 }}>{t("credentialOptional")}</legend>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 14 }}>
              <label>
                {t("formCredentialLabel")}
                <input value={form.credentialLabel} onChange={(event) => setField("credentialLabel", event.target.value)} placeholder={t("placeholderCredentialLabel")} />
              </label>
              <label>
                {t("formCredentialSecret")}
                <input type="password" value={form.credentialSecret} onChange={(event) => setField("credentialSecret", event.target.value)} placeholder={t("placeholderCredentialSecret")} />
              </label>
            </div>
          </fieldset>
          <fieldset style={{ border: "1px solid var(--line)", borderRadius: 8, padding: 14 }}>
            <legend style={{ padding: "0 6px", fontWeight: 600 }}>{t("formCircles")}</legend>
            {circles.length === 0 ? (
              <p className="nr-item-meta">{t("noCircles")}</p>
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 8 }}>
                {circles.map((circle) => (
                  <label key={circle.id} style={{ flexDirection: "row", alignItems: "center" }}>
                    <input
                      type="checkbox"
                      checked={form.circleIds.includes(circle.id)}
                      onChange={() => toggleCircle(circle.id)}
                    />
                    {circle.name}
                  </label>
                ))}
              </div>
            )}
          </fieldset>
          <div className="actions-inline">
            <button type="submit" className="small">{isEditing ? t("btnUpdateTool") : t("btnSaveTool")}</button>
            <button type="button" className="secondary small" onClick={resetForm}>{t("btnCancel")}</button>
          </div>
        </form>
      )}

      {groupedLinks.length === 0 ? (
        <div className="nr-item" style={{ textAlign: "center", padding: "48px 24px" }}>
          <h2 style={{ margin: "0 0 8px", fontSize: "1.1rem" }}>{t("emptyTitle")}</h2>
          <p className="muted" style={{ margin: 0 }}>{t("emptyDescription")}</p>
        </div>
      ) : initialView === "grid" ? renderGridView() : renderListView()}
    </section>
  );
}
