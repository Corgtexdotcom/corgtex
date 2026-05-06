"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { MarkdownEditor } from "@/lib/components/MarkdownEditor";
import { MarkdownRenderer } from "@/lib/components/MarkdownRenderer";

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

function displayDate(value: string | null) {
  if (!value) return "";
  return new Date(value).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function dateValue(value: string | null) {
  return value ? new Date(value).getTime() : 0;
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

function firstImage(artifact: BuildArtifact) {
  return artifact.assets.find((asset) => asset.mimeType.startsWith("image/")) ?? null;
}

function initialSelectedId(artifacts: BuildArtifact[]) {
  return artifacts.find((artifact) => artifact.status === "OPEN")?.id
    ?? artifacts.find((artifact) => artifact.status === "MERGED")?.id
    ?? artifacts[0]?.id
    ?? null;
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
  const [selectedId, setSelectedId] = useState(initialSelectedId(initialArtifacts));
  const [error, setError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [uploadingId, setUploadingId] = useState<string | null>(null);

  const groupedArtifacts = useMemo(() => {
    const inProgress = artifacts
      .filter((artifact) => artifact.status === "OPEN")
      .sort((a, b) => dateValue(b.updatedAt) - dateValue(a.updatedAt));
    const merged = artifacts
      .filter((artifact) => artifact.status === "MERGED")
      .sort((a, b) => dateValue(b.mergedAt ?? b.updatedAt) - dateValue(a.mergedAt ?? a.updatedAt));
    const closed = artifacts
      .filter((artifact) => artifact.status === "CLOSED")
      .sort((a, b) => dateValue(b.closedAt ?? b.updatedAt) - dateValue(a.closedAt ?? a.updatedAt));

    return {
      inProgress,
      merged,
      closed,
      ordered: [...inProgress, ...merged, ...closed],
    };
  }, [artifacts]);

  const selected = useMemo(
    () => artifacts.find((artifact) => artifact.id === selectedId) ?? groupedArtifacts.ordered[0] ?? null,
    [artifacts, groupedArtifacts.ordered, selectedId],
  );

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

  function artifactDateLabel(artifact: BuildArtifact) {
    if (artifact.status === "MERGED") return t("mergedOn", { date: displayDate(artifact.mergedAt ?? artifact.updatedAt) });
    if (artifact.status === "CLOSED") return t("closedOn", { date: displayDate(artifact.closedAt ?? artifact.updatedAt) });
    return t("updated", { date: displayDate(artifact.updatedAt) });
  }

  function renderThumbnail(artifact: BuildArtifact, height = 72) {
    const image = firstImage(artifact);
    if (image) {
      return (
        <div
          role="img"
          aria-label={image.label}
          style={{
            height,
            backgroundImage: `url("${assetUrl(workspaceId, artifact, image).replace(/"/g, "%22")}")`,
            backgroundPosition: "center",
            backgroundSize: "cover",
            backgroundColor: "var(--bg-alt)",
          }}
        />
      );
    }

    return (
      <div
        style={{
          height,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "var(--bg-alt)",
          fontSize: "1.45rem",
          fontWeight: 700,
        }}
      >
        {artifact.repositoryName.slice(0, 1).toUpperCase()}
      </div>
    );
  }

  function renderArtifactCard(artifact: BuildArtifact) {
    const isSelected = selected?.id === artifact.id;
    return (
      <button
        type="button"
        key={artifact.id}
        onClick={() => setSelectedId(artifact.id)}
        style={{
          display: "grid",
          gridTemplateColumns: "96px minmax(0, 1fr)",
          gap: 12,
          textAlign: "left",
          border: isSelected ? "2px solid var(--accent)" : "1px solid var(--line)",
          borderRadius: 8,
          padding: 10,
          background: "var(--surface-strong)",
          color: "var(--text)",
          cursor: "pointer",
          width: "100%",
        }}
      >
        <div style={{ borderRadius: 6, overflow: "hidden", border: "1px solid var(--line)" }}>
          {renderThumbnail(artifact)}
        </div>
        <div style={{ minWidth: 0 }}>
          <strong style={{ display: "block", fontSize: "0.95rem", wordBreak: "break-word" }}>{artifact.title}</strong>
          <div className="nr-item-meta" style={{ marginTop: 4, wordBreak: "break-word" }}>
            {artifact.repositoryOwner}/{artifact.repositoryName}
            {artifact.pullRequestNumber ? ` #${artifact.pullRequestNumber}` : ""}
          </div>
          <div className="actions-inline" style={{ gap: 6, marginTop: 10 }}>
            <span className="tag">{statusLabel(artifact.status)}</span>
            <span className="tag info">{artifact.assets.length} {t("assets")}</span>
          </div>
          <div className="nr-item-meta" style={{ marginTop: 8 }}>{artifactDateLabel(artifact)}</div>
        </div>
      </button>
    );
  }

  function renderArtifactSection(title: string, description: string, emptyText: string, items: BuildArtifact[]) {
    return (
      <section className="stack" style={{ gap: 12 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: "1.25rem" }}>{title}</h2>
          <div className="nr-item-meta" style={{ marginTop: 4 }}>{description}</div>
        </div>
        {items.length > 0 ? (
          <div style={{ display: "grid", gap: 10 }}>
            {items.map((artifact) => renderArtifactCard(artifact))}
          </div>
        ) : (
          <div className="nr-empty" style={{ padding: 18 }}>
            <p style={{ margin: 0 }}>{emptyText}</p>
          </div>
        )}
      </section>
    );
  }

  function renderDetail(artifact: BuildArtifact) {
    return (
      <article className="stack" style={{ gap: 18 }}>
        <div
          style={{
            border: "1px solid var(--line)",
            borderRadius: 8,
            overflow: "hidden",
            background: "var(--surface-strong)",
          }}
        >
          {renderThumbnail(artifact, 168)}
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
          <div>
            <h2 style={{ margin: 0, fontSize: "1.35rem" }}>{artifact.title}</h2>
            <div className="nr-item-meta" style={{ marginTop: 6 }}>
              {classificationLabel(artifact.classification)} · {visibilityLabel(artifact.visibility)} · {artifactDateLabel(artifact)}
            </div>
          </div>
          <div className="actions-inline">
            {artifact.pullRequestUrl && (
              <a className="link-button small" href={artifact.pullRequestUrl} target="_blank" rel="noreferrer">
                {t("btnOpenPr")}
              </a>
            )}
            {artifact.assets.some((asset) => asset.publicUrl) && (
              <button type="button" className="secondary small" onClick={() => copyPublicLinks(artifact)}>
                {copiedId === artifact.id ? t("btnCopied") : t("btnCopyPrLinks")}
              </button>
            )}
            {artifact.canManage && artifact.visibility === "PUBLIC_REVIEW" && (
              <button type="button" className="danger small" onClick={() => revokePublic(artifact)}>
                {t("btnRevokePublic")}
              </button>
            )}
          </div>
        </div>

        {artifact.summaryMd && (
          <MarkdownRenderer markdown={artifact.summaryMd} variant="compact" />
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
              {artifact.assets.map((asset) => (
                <tr key={asset.id}>
                  <td style={{ minWidth: 180 }}>
                    <a href={assetUrl(workspaceId, artifact, asset)} target="_blank" rel="noreferrer">
                      {asset.label}
                    </a>
                    <div className="nr-item-meta">{asset.kind} · {asset.mimeType}</div>
                  </td>
                  <td style={{ minWidth: 220 }}>
                    {asset.captionMd ? <MarkdownRenderer markdown={asset.captionMd} variant="compact" /> : <span className="muted">-</span>}
                  </td>
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
              {artifact.assets.length === 0 && (
                <tr>
                  <td colSpan={4} className="muted">{t("noAssets")}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {artifact.canManage && (
          <form
            onSubmit={(event) => uploadAsset(event, artifact)}
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
              <MarkdownEditor name="captionMd" rows={3} placeholder={t("captionPlaceholder")} />
            </label>
            <div className="actions-inline">
              <button type="submit" disabled={uploadingId === artifact.id}>
                {uploadingId === artifact.id ? t("btnUploading") : t("btnUpload")}
              </button>
            </div>
          </form>
        )}
      </article>
    );
  }

  return (
    <section className="ws-section stack" style={{ gap: 24 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <div className="actions-inline" style={{ gap: 8 }}>
          <span className="tag">{t("inProgressCount", { count: groupedArtifacts.inProgress.length })}</span>
          <span className="tag info">{t("mergedCount", { count: groupedArtifacts.merged.length })}</span>
          {groupedArtifacts.closed.length > 0 && <span className="tag">{t("closedCount", { count: groupedArtifacts.closed.length })}</span>}
        </div>
        <div className="nr-item-meta">{t("artifactCount", { count: artifacts.length })}</div>
      </div>

      {error && <div className="form-message form-message-error">{error}</div>}

      {artifacts.length === 0 ? (
        <div className="nr-empty">
          <h2>{t("emptyTitle")}</h2>
          <p>{t("emptyDescription")}</p>
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 360px), 1fr))", gap: 24, alignItems: "start" }}>
          <div className="stack" style={{ gap: 28 }}>
            {renderArtifactSection(
              t("inProgressTitle"),
              t("inProgressDescription"),
              t("emptyInProgress"),
              groupedArtifacts.inProgress,
            )}
            {renderArtifactSection(
              t("mergedTitle"),
              t("mergedDescription"),
              t("emptyMerged"),
              groupedArtifacts.merged,
            )}
            {groupedArtifacts.closed.length > 0 && renderArtifactSection(
              t("closedTitle"),
              t("closedDescription"),
              t("emptyClosed"),
              groupedArtifacts.closed,
            )}
          </div>

          {selected && renderDetail(selected)}
        </div>
      )}
    </section>
  );
}
