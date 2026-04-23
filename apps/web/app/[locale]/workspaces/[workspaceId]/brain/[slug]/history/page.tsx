import { getArticle, listArticleVersions } from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";

export const dynamic = "force-dynamic";


export default async function BrainArticleHistoryPage({
  params,
}: {
  params: Promise<{ workspaceId: string; slug: string }>;
}) {
  const { workspaceId, slug } = await params;
  const actor = await requirePageActor();
  const [article, versions] = await Promise.all([
    getArticle(actor, { workspaceId, slug }),
    listArticleVersions(actor, { workspaceId, slug }),
  ]);

  return (
    <>
      <div className="ws-page-header">
        <div className="row">
          <h1>History: {article.title}</h1>
          <a href={`/workspaces/${workspaceId}/brain/${slug}`} className="link-button small">Back to article</a>
        </div>
      </div>

      {versions.length === 0 ? (
        <p className="muted">No previous versions. The article has not been edited since creation.</p>
      ) : (
        <div className="list">
          {versions.map((v) => (
            <div className="item" key={v.id}>
              <div className="row">
                <strong>Version {v.version}</strong>
                <span className="muted">{new Date(v.createdAt).toLocaleString()}</span>
              </div>
              {v.changeSummary && <p style={{ margin: "4px 0" }}>{v.changeSummary}</p>}
              {v.agentRunId && <div className="muted">Changed by agent run {v.agentRunId.slice(0, 8)}</div>}
              <details style={{ marginTop: 8 }}>
                <summary style={{ cursor: "pointer", color: "var(--accent)" }}>View body</summary>
                <pre style={{ whiteSpace: "pre-wrap", fontSize: "0.85rem", marginTop: 8, padding: 8, background: "var(--bg-secondary)", borderRadius: 4 }}>
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
