import { listSources } from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";
import { ingestSourceAction } from "../actions";

export const dynamic = "force-dynamic";


export default async function BrainSourcesPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const actor = await requirePageActor();
  const { items: sources } = await listSources(actor, { workspaceId, take: 50 });

  return (
    <>
      <div className="ws-page-header">
        <h1>Brain Sources</h1>
        <p>Raw sources ingested into the brain. Agents absorb these into wiki articles.</p>
      </div>

      <section className="ws-section stack">
        <h2>Ingest raw files</h2>
        <form action={`/api/workspaces/${workspaceId}/brain/sources/upload`} method="post" encType="multipart/form-data" className="stack panel">
          <label>
            File to ingest (PDF, DOCX, CSV, TXT, JSON)
            <input type="file" name="file" required />
          </label>
          <button type="submit">Upload and Map to Brain</button>
        </form>

        <h2>Ingest text source</h2>
        <form action={ingestSourceAction} className="stack panel">
          <input type="hidden" name="workspaceId" value={workspaceId} />
          <label>
            Title
            <input name="title" placeholder="Source title (optional)" />
          </label>
          <div className="actions-inline">
            <label style={{ flex: 1 }}>
              Source type
              <select name="sourceType">
                {["MEETING","TICKET","PR","RFC","INCIDENT","SLACK","CUSTOMER_FEEDBACK","COMPETITOR","RESEARCH","ARTICLE","DOC","RUNBOOK","EMAIL","FILE_UPLOAD"].map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </label>
            <label style={{ flex: 1 }}>
              Tier
              <select name="tier">
                <option value="1">1 — Core</option>
                <option value="2">2 — Relational</option>
                <option value="3">3 — Context</option>
              </select>
            </label>
          </div>
          <label>
            Channel (optional)
            <input name="channel" placeholder="#engineering, repo name, meeting name..." />
          </label>
          <label>
            Content
            <textarea name="content" rows={8} required placeholder="Paste the source content here..." />
          </label>
          <button type="submit">Ingest source</button>
        </form>
      </section>

      <section className="ws-section">
        <h2>Sources ({sources.length})</h2>
        <div className="list">
          {sources.map((s) => (
            <div className="item" key={s.id}>
              <div className="row">
                <strong>{s.title ?? s.id.slice(0, 8)}</strong>
                <div>
                  <span className="tag">{s.sourceType}</span>
                  <span className="tag" style={{ marginLeft: 4 }}>Tier {s.tier}</span>
                  <span className="tag" style={{ marginLeft: 4 }}>{s.absorbedAt ? "Absorbed" : "Pending"}</span>
                </div>
              </div>
              <div className="muted">
                {s.channel && `${s.channel} · `}
                {s.authorMember ? (s.authorMember.user.displayName ?? s.authorMember.user.email) : "System"}
                {" · "}
                {new Date(s.createdAt).toLocaleDateString()}
                {s.fileStorageKey && (
                  <>
                    {" · "}
                    <a href={`/api/workspaces/${workspaceId}/brain/sources/${s.id}/file`} target="_blank" rel="noreferrer" style={{ textDecoration: "underline" }}>
                      Download
                    </a>
                  </>
                )}
              </div>
              <p style={{ margin: "8px 0 0", fontSize: "0.85rem" }}>{s.content.slice(0, 200)}{s.content.length > 200 ? "..." : ""}</p>
            </div>
          ))}
          {sources.length === 0 && <p className="muted">No sources ingested yet.</p>}
        </div>
      </section>
    </>
  );
}
