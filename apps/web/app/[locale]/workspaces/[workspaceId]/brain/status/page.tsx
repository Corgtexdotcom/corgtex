import { getBrainStatus, listArticles } from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";
import { getTranslations } from "next-intl/server";

export const dynamic = "force-dynamic";


export default async function BrainStatusPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const actor = await requirePageActor();
  const t = await getTranslations("brain");

  const [status, { items: staleArticles }] = await Promise.all([
    getBrainStatus(actor, { workspaceId }),
    listArticles(actor, { workspaceId, stale: true, take: 20 }),
  ]);

  return (
    <>
      <div className="ws-page-header">
        <h1>Brain Status</h1>
      </div>

      <div className="ws-stat-row">
        <div className="ws-stat-card">
          <strong>{status.totalArticles}</strong>
          <span>Total Articles</span>
        </div>
        <div className="ws-stat-card">
          <strong>{status.staleArticles}</strong>
          <span>Stale</span>
        </div>
        <div className="ws-stat-card">
          <strong>{status.unabsorbedSources}</strong>
          <span>Pending Sources</span>
        </div>
        <div className="ws-stat-card">
          <strong>{status.openDiscussionThreads}</strong>
          <span>Open Threads</span>
        </div>
        <div className="ws-stat-card">
          <strong>{status.orphanArticles}</strong>
          <span>Orphans</span>
        </div>
        <div className="ws-stat-card">
          <strong>{status.unownedArticles}</strong>
          <span>Unowned</span>
        </div>
      </div>

      <div className="ws-columns">
        <div className="panel">
          <h2>Articles by type</h2>
          <div className="list">
            {Object.entries(status.articleCountByType).sort(([, a], [, b]) => b - a).map(([type, count]) => (
              <div className="item" key={type}>
                <div className="row">
                  <strong>{type}</strong>
                  <span>{count}</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="panel">
          <h2>Articles by authority</h2>
          <div className="list">
            {Object.entries(status.articleCountByAuthority).sort(([, a], [, b]) => b - a).map(([auth, count]) => (
              <div className="item" key={auth}>
                <div className="row">
                  <strong>{auth}</strong>
                  <span>{count}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {staleArticles.length > 0 && (
        <section className="ws-section" style={{ marginTop: 20 }}>
          <h2>Stale articles (need review)</h2>
          <div className="list">
            {staleArticles.map((a) => (
              <a className="item" key={a.id} href={`/workspaces/${workspaceId}/brain/${a.slug}`}>
                <div className="row">
                  <strong>{a.title}</strong>
                  <div>
                    <span className="tag">{a.type}</span>
                    <span className="tag" style={{ marginLeft: 4 }}>{a.authority}</span>
                  </div>
                </div>
                <div className="muted">
                  Updated {new Date(a.updatedAt).toLocaleDateString()}
                  {a.ownerMember && ` · ${a.ownerMember.user.displayName ?? a.ownerMember.user.email}`}
                </div>
              </a>
            ))}
          </div>
        </section>
      )}
    </>
  );
}
