import { getArticle, listArticleVersions } from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";
import { getTranslations } from "next-intl/server";

export const dynamic = "force-dynamic";


export default async function BrainArticleHistoryPage({
  params,
}: {
  params: Promise<{ workspaceId: string; slug: string }>;
}) {
  const { workspaceId, slug } = await params;
  const actor = await requirePageActor();
  const t = await getTranslations("brain");
  const [article, versions] = await Promise.all([
    getArticle(actor, { workspaceId, slug }),
    listArticleVersions(actor, { workspaceId, slug }),
  ]);

  return (
    <>
      <div className="ws-page-header">
        <div className="row">
          <h1>{t("historyTitle", { title: article.title })}</h1>
          <a href={`/workspaces/${workspaceId}/brain/${slug}`} className="link-button small">{t("backToArticle")}</a>
        </div>
      </div>

      {versions.length === 0 ? (
        <p className="muted">{t("noPreviousVersions")}</p>
      ) : (
        <div className="list">
          {versions.map((v) => (
            <div className="item" key={v.id}>
              <div className="row">
                <strong>{t("version", { version: v.version })}</strong>
                <span className="muted">{new Date(v.createdAt).toLocaleString()}</span>
              </div>
              {v.changeSummary && <p style={{ margin: "4px 0" }}>{v.changeSummary}</p>}
              {v.agentRunId && <div className="muted">{t("changedByAgentRun", { id: v.agentRunId.slice(0, 8) })}</div>}
              <details style={{ marginTop: 8 }}>
                <summary style={{ cursor: "pointer", color: "var(--accent)" }}>{t("viewBody")}</summary>
                <pre style={{ whiteSpace: "pre-wrap", fontSize: "0.85rem", marginTop: 8, padding: 8, background: "var(--bg-alt)", borderRadius: 4 }}>
                  {v.bodyMd}
                </pre>
              </details>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
