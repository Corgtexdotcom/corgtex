import { notFound } from "next/navigation";
import { listWorkItemVersions, normalizeWorkItemEntityType } from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";
import { getTranslations } from "next-intl/server";

export const dynamic = "force-dynamic";

function backHref(workspaceId: string, entityType: string, entityId: string) {
  if (entityType === "Tension") return `/workspaces/${workspaceId}/tensions/${entityId}`;
  if (entityType === "Proposal") return `/workspaces/${workspaceId}/proposals/${entityId}`;
  if (entityType === "Action") return `/workspaces/${workspaceId}/actions`;
  if (entityType === "SpendRequest") return `/workspaces/${workspaceId}/finance`;
  if (entityType === "Goal") return `/workspaces/${workspaceId}/goals`;
  return `/workspaces/${workspaceId}`;
}

function snapshotText(snapshot: unknown) {
  if (snapshot && typeof snapshot === "object") {
    const record = snapshot as Record<string, unknown>;
    const body = record.bodyMd ?? record.descriptionMd ?? record.description ?? null;
    if (typeof body === "string" && body.trim()) {
      return body;
    }
  }
  return JSON.stringify(snapshot, null, 2);
}

function snapshotTitle(snapshot: unknown) {
  if (snapshot && typeof snapshot === "object") {
    const record = snapshot as Record<string, unknown>;
    if (typeof record.title === "string" && record.title.trim()) return record.title;
    if (typeof record.description === "string" && record.description.trim()) return record.description;
  }
  return null;
}

export default async function WorkItemVersionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const resolvedSearch = searchParams ? await searchParams : {};
  const entityTypeInput = typeof resolvedSearch.entityType === "string" ? resolvedSearch.entityType : "";
  const entityId = typeof resolvedSearch.entityId === "string" ? resolvedSearch.entityId : "";

  const actor = await requirePageActor();
  const t = await getTranslations("workItems");
  if (!entityTypeInput && !entityId) {
    return (
      <>
        <div className="ws-page-header">
          <h1>{t("historyIndexTitle")}</h1>
          <p className="muted" style={{ margin: "8px 0 0" }}>
            {t("historyIndexDescription")}
          </p>
        </div>
      </>
    );
  }

  if (!entityTypeInput || !entityId) notFound();

  const entityType = normalizeWorkItemEntityType(entityTypeInput);
  const history = await listWorkItemVersions(actor, { workspaceId, entityType, entityId });
  const href = backHref(workspaceId, entityType, entityId);

  return (
    <>
      <div className="ws-page-header">
        <div className="row">
          <h1>{t("historyTitle", { item: t(`entity${entityType}` as any) })}</h1>
          <a href={href} className="link-button small">{t("backToItem")}</a>
        </div>
        <p className="muted" style={{ margin: "8px 0 0" }}>
          {t("currentVersion", { version: history.currentVersion })}
        </p>
      </div>

      {history.versions.length === 0 ? (
        <p className="muted">{t("noPreviousVersions")}</p>
      ) : (
        <div className="list">
          {history.versions.map((version) => {
            const title = snapshotTitle(version.previousState);
            const text = snapshotText(version.previousState);
            return (
              <div className="item" key={version.id}>
                <div className="row">
                  <strong>{t("version", { version: version.version })}</strong>
                  <span className="muted">{new Date(version.createdAt).toLocaleString()}</span>
                </div>
                <div className="nr-item-meta" style={{ marginTop: 4 }}>
                  {version.changedFields.join(", ")}
                  {version.actorLabel ? ` · ${version.actorLabel}` : ""}
                </div>
                {title && <p style={{ margin: "8px 0 0" }}>{title}</p>}
                <details style={{ marginTop: 8 }}>
                  <summary style={{ cursor: "pointer", color: "var(--accent)" }}>{t("viewSnapshot")}</summary>
                  <pre style={{ whiteSpace: "pre-wrap", fontSize: "0.85rem", marginTop: 8, padding: 8, background: "var(--bg-alt)", borderRadius: 4 }}>
                    {text}
                  </pre>
                </details>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
