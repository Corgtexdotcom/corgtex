"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

type BuildArtifactAsset = {
  id: string;
  kind: "SCREENSHOT" | "VIDEO" | "DOCUMENT" | "LOG" | "OTHER";
  label: string;
  captionMd: string | null;
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  sortOrder: number;
  createdAt: string;
  hasPublicUrl: boolean;
  publicUrl: string | null;
};

type BuildArtifact = {
  id: string;
  workspaceId: string;
  repositoryOwner: string;
  repositoryName: string;
  pullRequestNumber: number | null;
  pullRequestUrl: string | null;
  branchName: string | null;
  commitSha: string | null;
  mergeCommitSha: string | null;
  title: string;
  summaryMd: string | null;
  status: "OPEN" | "MERGED" | "CLOSED";
  classification: "OPEN_CORE" | "INTERNAL" | "CLIENT_PRIVATE";
  visibility: "PRIVATE" | "PUBLIC_REVIEW" | "REVOKED";
  publicEnabledAt: string | null;
  publicRevokedAt: string | null;
  mergedAt: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
  canManage: boolean;
  createdBy: { id: string; email: string; displayName: string | null } | null;
  assets: BuildArtifactAsset[];
};

type FormState = {
  repositoryOwner: string;
  repositoryName: string;
  pullRequestNumber: string;
  pullRequestUrl: string;
  branchName: string;
  commitSha: string;
  title: string;
  summaryMd: string;
  classification: BuildArtifact["classification"];
  visibility: BuildArtifact["visibility"];
  noPrivateDataConfirmed: boolean;
};

const EMPTY_FORM: FormState = {
  repositoryOwner: "",
  repositoryName: "",
  pullRequestNumber: "",
  pullRequestUrl: "",
  branchName: "",
  commitSha: "",
  title: "",
  summaryMd: "",
  classification: "OPEN_CORE",
  visibility: "PUBLIC_REVIEW",
  noPrivateDataConfirmed: false,
};

function displayDate(value: string | null) {
  if (!value) return "";
  return new Date(value).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function assetUrl(workspaceId: string, artifact: BuildArtifact, asset: BuildArtifactAsset) {
  return asset.publicUrl ?? `/api/workspaces/${workspaceId}/build-artifacts/${artifact.id}/assets/${asset.id}`;
}

function markdownLinks(artifact: BuildArtifact) {
  return artifact.assets
    .filter((asset) => asset.publicUrl)
    .map((asset) => `- [${asset.label}](${asset.publicUrl})`)
    .join("\n");
}

export function BuiltArtifactsClient({
  workspaceId,
  initialArtifacts,
}: {
  workspaceId: string;
  initialArtifacts: BuildArtifact[];
}) {
  const router = useRouter();
  const t = useTranslations("built");
  const [artifacts, setArtifacts] = useState(initialArtifacts);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [isFormOpen, setIsFormOpen] = useState(initialArtifacts.length === 0);
  const [selectedId, setSelectedId] = useState(initialArtifacts[0]?.id ?? null);
  const [error, setError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [uploadingId, setUploadingId] = useState<string | null>(null);

  const selected = useMemo(
    () => artifacts.find((artifact) => artifact.id === selectedId) ?? artifacts[0] ?? null,
    [artifacts, selectedId],
  );

  function setField<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function submitArtifact(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    const payload = {
      repositoryOwner: form.repositoryOwner,
      repositoryName: form.repositoryName,
      pullRequestNumber: form.pullRequestNumber.trim() ? Number.parseInt(form.pullRequestNumber, 10) : null,
      pullRequestUrl: form.pullRequestUrl || null,
      branchName: form.branchName || null,
      commitSha: form.commitSha || null,
      title: form.title,
      summaryMd: form.summaryMd || null,
      classification: form.classification,
      visibility: form.visibility,
      noPrivateDataConfirmed: form.noPrivateDataConfirmed,
    };

    const res = await fetch(`/api/workspaces/${workspaceId}/build-artifacts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      setError(data?.error?.message ?? t("errorGeneric"));
      return;
    }

    setArtifacts((current) => {
      const exists = current.some((artifact) => artifact.id === data.id);
      return exists
        ? current.map((artifact) => (artifact.id === data.id ? data : artifact))
        : [data, ...current];
    });
    setSelectedId(data.id);
    setIsFormOpen(false);
    setForm(EMPTY_FORM);
    router.refresh();
  }

  async function uploadAsset(event: React.FormEvent<HTMLFormElement>, artifact: BuildArtifact) {
    event.preventDefault();
    setError(null);
    setUploadingId(artifact.id);

    const formData = new FormData(event.currentTarget);
    const res = await fetch(`/api/workspaces/${workspaceId}/build-artifacts/${artifact.id}/assets`, {
      method: "POST",
      body: formData,
    });
    const data = await res.json().catch(() => null);
    setUploadingId(null);
    if (!res.ok) {
      setError(data?.error?.message ?? t("errorGeneric"));
      return;
    }

    setArtifacts((current) => current.map((item) => (item.id === artifact.id ? data.artifact : item)));
    event.currentTarget.reset();
    router.refresh();
  }

  async function revokePublic(artifact: BuildArtifact) {
    if (!window.confirm(t("confirmRevoke"))) return;
    const res = await fetch(`/api/workspaces/${workspaceId}/build-artifacts/${artifact.id}/revoke-public`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "Revoked from Built view" }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      setError(data?.error?.message ?? t("errorGeneric"));
      return;
    }
    setArtifacts((current) => current.map((item) => (item.id === artifact.id ? data : item)));
    router.refresh();
  }

  async function copyPublicLinks(artifact: BuildArtifact) {
    const links = markdownLinks(artifact);
    if (!links) return;
    await navigator.clipboard.writeText(links);
    setCopiedId(artifact.id);
    window.setTimeout(() => setCopiedId(null), 1800);
  }

  function statusLabel(status: BuildArtifact["status"]) {
    if (status === "MERGED") return t("statusMerged");
    if (status === "CLOSED") return t("statusClosed");
    return t("statusOpen");
  }

  function visibilityLabel(visibility: BuildArtifact["visibility"]) {
    if (visibility === "PUBLIC_REVIEW") return t("visibilityPublicReview");
    if (visibility === "REVOKED") return t("visibilityRevoked");
    return t("visibilityPrivate");
  }

  function classificationLabel(classification: BuildArtifact["classification"]) {
    if (classification === "OPEN_CORE") return t("classificationOpenCore");
    if (classification === "CLIENT_PRIVATE") return t("classificationClientPrivate");
    return t("classificationInternal");
  }

  function renderPreview(artifact: BuildArtifact) {
    const firstVisual = artifact.assets.find((asset) => asset.mimeType.startsWith("image/"));
    return (
      <div
        style={{
          border: "1px solid var(--line)",
          borderRadius: 8,
          overflow: "hidden",
          background: "var(--surface-strong)",
          minHeight: 168,
        }}
      >
        {firstVisual ? (
          <div
            role="img"
            aria-label={firstVisual.label}
            style={{
              height: 124,
              backgroundImage: `url("${assetUrl(workspaceId, artifact, firstVisual).replace(/"/g, "%22")}")`,
              backgroundPosition: "center",
              backgroundSize: "cover",
              backgroundColor: "var(--bg-alt)",
            }}
          />
        ) : (
          <div
            style={{
              height: 124,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "var(--bg-alt)",
              fontSize: "2rem",
              fontWeight: 700,
            }}
          >
            {artifact.repositoryName.slice(0, 1).toUpperCase()}
          </div>
        )}
        <div style={{ padding: 12 }}>
          <strong style={{ display: "block", fontSize: "0.95rem" }}>{artifact.title}</strong>
          <div className="nr-item-meta" style={{ marginTop: 4 }}>
            {artifact.repositoryOwner}/{artifact.repositoryName}
            {artifact.pullRequestNumber ? ` #${artifact.pullRequestNumber}` : ""}
          </div>
        </div>
      </div>
    );
  }

  return (
    <section className="ws-section stack" style={{ gap: 24 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <div className="actions-inline">
          <button
            type="button"
            className={isFormOpen ? "secondary small" : "small"}
            onClick={() => setIsFormOpen((value) => !value)}
          >
            {isFormOpen ? t("btnCancel") : t("btnAddArtifact")}
          </button>
        </div>
        <div className="nr-item-meta">{t("artifactCount", { count: artifacts.length })}</div>
      </div>

      {error && <div className="form-message form-message-error">{error}</div>}

      {isFormOpen && (
        <form
          onSubmit={submitArtifact}
          className="nr-form-section stack"
          style={{ border: "1px solid var(--line)", borderRadius: 8, padding: 20 }}
        >
          <h2 style={{ margin: 0, fontSize: "1.1rem" }}>{t("newArtifact")}</h2>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14 }}>
            <label>
              {t("repositoryOwner")}
              <input required value={form.repositoryOwner} onChange={(event) => setField("repositoryOwner", event.target.value)} placeholder="puncar-dev" />
            </label>
            <label>
              {t("repositoryName")}
              <input required value={form.repositoryName} onChange={(event) => setField("repositoryName", event.target.value)} placeholder="CORGTEX" />
            </label>
            <label>
              {t("pullRequestNumber")}
              <input inputMode="numeric" value={form.pullRequestNumber} onChange={(event) => setField("pullRequestNumber", event.target.value)} placeholder="123" />
            </label>
            <label>
              {t("pullRequestUrl")}
              <input value={form.pullRequestUrl} onChange={(event) => setField("pullRequestUrl", event.target.value)} placeholder="https://github.com/org/repo/pull/123" />
            </label>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14 }}>
            <label>
              {t("title")}
              <input required value={form.title} onChange={(event) => setField("title", event.target.value)} />
            </label>
            <label>
              {t("branchName")}
              <input value={form.branchName} onChange={(event) => setField("branchName", event.target.value)} />
            </label>
            <label>
              {t("commitSha")}
              <input value={form.commitSha} onChange={(event) => setField("commitSha", event.target.value)} />
            </label>
          </div>
          <label>
            {t("summary")}
            <textarea rows={4} value={form.summaryMd} onChange={(event) => setField("summaryMd", event.target.value)} />
          </label>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14 }}>
            <label>
              {t("classification")}
              <select value={form.classification} onChange={(event) => setField("classification", event.target.value as BuildArtifact["classification"])}>
                <option value="OPEN_CORE">{t("classificationOpenCore")}</option>
                <option value="INTERNAL">{t("classificationInternal")}</option>
                <option value="CLIENT_PRIVATE">{t("classificationClientPrivate")}</option>
              </select>
            </label>
            <label>
              {t("visibility")}
              <select value={form.visibility} onChange={(event) => setField("visibility", event.target.value as BuildArtifact["visibility"])}>
                <option value="PUBLIC_REVIEW">{t("visibilityPublicReview")}</option>
                <option value="PRIVATE">{t("visibilityPrivate")}</option>
              </select>
            </label>
          </div>
          {form.visibility === "PUBLIC_REVIEW" && (
            <label style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
              <input
                type="checkbox"
                checked={form.noPrivateDataConfirmed}
                onChange={(event) => setField("noPrivateDataConfirmed", event.target.checked)}
                style={{ width: "auto", marginTop: 4 }}
              />
              <span>{t("noPrivateDataConfirm")}</span>
            </label>
          )}
          <div className="actions-inline">
            <button type="submit">{t("btnSaveArtifact")}</button>
          </div>
        </form>
      )}

      {artifacts.length === 0 ? (
        <div className="nr-empty">
          <h2>{t("emptyTitle")}</h2>
          <p>{t("emptyDescription")}</p>
        </div>
      ) : (
        <div style={{ display: "grid", gap: 24 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 240px), 1fr))", gap: 12, alignContent: "start" }}>
            {artifacts.map((artifact) => (
              <button
                type="button"
                key={artifact.id}
                onClick={() => setSelectedId(artifact.id)}
                style={{
                  textAlign: "left",
                  border: selected?.id === artifact.id ? "2px solid var(--accent)" : "1px solid var(--line)",
                  borderRadius: 8,
                  padding: 12,
                  background: "var(--surface-strong)",
                  color: "var(--text)",
                  cursor: "pointer",
                }}
              >
                <strong>{artifact.title}</strong>
                <div className="nr-item-meta" style={{ marginTop: 4 }}>
                  {artifact.repositoryOwner}/{artifact.repositoryName}
                  {artifact.pullRequestNumber ? ` #${artifact.pullRequestNumber}` : ""}
                </div>
                <div className="actions-inline" style={{ gap: 6, marginTop: 10 }}>
                  <span className="tag">{statusLabel(artifact.status)}</span>
                  <span className="tag info">{visibilityLabel(artifact.visibility)}</span>
                  <span className="tag">{artifact.assets.length} {t("assets")}</span>
                </div>
              </button>
            ))}
          </div>

          {selected && (
            <article className="stack" style={{ gap: 18 }}>
              {renderPreview(selected)}
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
                <div>
                  <h2 style={{ margin: 0, fontSize: "1.35rem" }}>{selected.title}</h2>
                  <div className="nr-item-meta" style={{ marginTop: 6 }}>
                    {classificationLabel(selected.classification)} · {visibilityLabel(selected.visibility)} · {t("updated", { date: displayDate(selected.updatedAt) })}
                  </div>
                </div>
                <div className="actions-inline">
                  {selected.pullRequestUrl && (
                    <a className="link-button small" href={selected.pullRequestUrl} target="_blank" rel="noreferrer">
                      {t("btnOpenPr")}
                    </a>
                  )}
                  {selected.assets.some((asset) => asset.publicUrl) && (
                    <button type="button" className="secondary small" onClick={() => copyPublicLinks(selected)}>
                      {copiedId === selected.id ? t("btnCopied") : t("btnCopyPrLinks")}
                    </button>
                  )}
                  {selected.canManage && selected.visibility === "PUBLIC_REVIEW" && (
                    <button type="button" className="danger small" onClick={() => revokePublic(selected)}>
                      {t("btnRevokePublic")}
                    </button>
                  )}
                </div>
              </div>

              {selected.summaryMd && (
                <p style={{ margin: 0, whiteSpace: "pre-wrap", lineHeight: 1.55 }}>{selected.summaryMd}</p>
              )}

              <div className="nr-table-wrap">
                <table className="nr-table">
                  <thead>
                    <tr>
                      <th>{t("asset")}</th>
                      <th>{t("caption")}</th>
                      <th>{t("publicLink")}</th>
                      <th>{t("size")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selected.assets.map((asset) => (
                      <tr key={asset.id}>
                        <td style={{ minWidth: 180 }}>
                          <a href={assetUrl(workspaceId, selected, asset)} target="_blank" rel="noreferrer">
                            {asset.label}
                          </a>
                          <div className="nr-item-meta">{asset.kind} · {asset.mimeType}</div>
                        </td>
                        <td style={{ minWidth: 220, whiteSpace: "pre-wrap" }}>{asset.captionMd || <span className="muted">-</span>}</td>
                        <td style={{ minWidth: 220 }}>
                          {asset.publicUrl ? (
                            <a href={asset.publicUrl} target="_blank" rel="noreferrer">{t("publicProofLink")}</a>
                          ) : (
                            <span className="muted">{t("privateOnly")}</span>
                          )}
                        </td>
                        <td>{formatBytes(asset.sizeBytes)}</td>
                      </tr>
                    ))}
                    {selected.assets.length === 0 && (
                      <tr>
                        <td colSpan={4} className="muted">{t("noAssets")}</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              {selected.canManage && (
                <form
                  onSubmit={(event) => uploadAsset(event, selected)}
                  className="nr-form-section stack"
                  style={{ border: "1px solid var(--line)", borderRadius: 8, padding: 16 }}
                >
                  <h3 style={{ margin: 0, fontSize: "1rem" }}>{t("uploadProof")}</h3>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
                    <label>
                      {t("file")}
                      <input name="file" type="file" required />
                    </label>
                    <label>
                      {t("assetKind")}
                      <select name="kind" defaultValue="SCREENSHOT">
                        <option value="SCREENSHOT">{t("kindScreenshot")}</option>
                        <option value="VIDEO">{t("kindVideo")}</option>
                        <option value="DOCUMENT">{t("kindDocument")}</option>
                        <option value="LOG">{t("kindLog")}</option>
                        <option value="OTHER">{t("kindOther")}</option>
                      </select>
                    </label>
                    <label>
                      {t("assetLabel")}
                      <input name="label" placeholder={t("assetLabelPlaceholder")} />
                    </label>
                  </div>
                  <label>
                    {t("caption")}
                    <textarea name="captionMd" rows={3} placeholder={t("captionPlaceholder")} />
                  </label>
                  <div className="actions-inline">
                    <button type="submit" disabled={uploadingId === selected.id}>
                      {uploadingId === selected.id ? t("btnUploading") : t("btnUpload")}
                    </button>
                  </div>
                </form>
              )}
            </article>
          )}
        </div>
      )}
    </section>
  );
}
