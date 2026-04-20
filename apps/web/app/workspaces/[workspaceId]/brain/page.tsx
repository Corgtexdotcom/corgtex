import { getBrainStatus, listArticles, requireWorkspaceMembership, listMeetings, listDocuments } from "@corgtex/domain";
import { answerKnowledgeQuestion, searchIndexedKnowledge } from "@corgtex/knowledge";
import { requirePageActor } from "@/lib/auth";
import { createArticleAction } from "./actions";

export const dynamic = "force-dynamic";

export default async function BrainPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const actor = await requirePageActor();
  await requireWorkspaceMembership({ actor, workspaceId });
  const resolvedSearch = searchParams ? await searchParams : {};
  const query = typeof resolvedSearch.q === "string" ? resolvedSearch.q : "";
  const question = typeof resolvedSearch.question === "string" ? resolvedSearch.question : "";
  const range = typeof resolvedSearch.range === "string" ? resolvedSearch.range : "30d";

  const [{ items: articles }, status, searchResults, answer, allMeetings, allDocuments] = await Promise.all([
    listArticles(actor, { workspaceId, take: 500 }),
    getBrainStatus(actor, { workspaceId }),
    query.trim()
      ? searchIndexedKnowledge({ workspaceId, query, limit: 12 })
      : Promise.resolve([]),
    question.trim()
      ? answerKnowledgeQuestion({ workspaceId, question, limit: 4 })
      : Promise.resolve(null),
    listMeetings(workspaceId),
    listDocuments(workspaceId),
  ]);

  const cutoff = new Date();
  if (range === "30d") cutoff.setDate(cutoff.getDate() - 30);
  else if (range === "90d") cutoff.setDate(cutoff.getDate() - 90);
  else cutoff.setTime(0);

  const meetings = allMeetings.filter(m => new Date(m.recordedAt) >= cutoff);
  const documents = allDocuments.filter(d => new Date(d.createdAt) >= cutoff);

  // Group articles by type
  const byType = new Map<string, typeof articles>();
  for (const article of articles) {
    const group = byType.get(article.type) ?? [];
    group.push(article);
    byType.set(article.type, group);
  }

  // Sort groups alphabetically
  const sortedTypes = [...byType.entries()].sort(([a], [b]) => a.localeCompare(b));

  return (
    <>
      <div className="nr-masthead" style={{ textAlign: "left", marginBottom: 48 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", borderBottom: "1px solid var(--text)", paddingBottom: 16 }}>
          <h1 style={{ border: "none", padding: 0, margin: 0, fontSize: "2.5rem" }}>Wiki Index</h1>
          <span style={{ fontSize: "0.85rem", color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
            {status.totalArticles} Articles · {allMeetings.length} Meetings
          </span>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "48px", borderBottom: "4px solid var(--line)", paddingBottom: "48px", marginBottom: "48px" }}>
        
        {/* Left: Search */}
        <div>
          <h2 className="nr-section-header" style={{ borderTop: "none" }}>Search the Brain</h2>
          <form method="GET" style={{ marginBottom: "24px" }}>
            <input 
              name="q" 
              defaultValue={query} 
              placeholder="Search wiki, meetings, documents..." 
              style={{ width: "100%", padding: "12px", fontSize: "1rem", border: "1px solid var(--line)", borderRadius: "4px" }}
            />
          </form>

          {searchResults.length > 0 && (
            <div>
              <h3 style={{ fontSize: "0.9rem", textTransform: "uppercase", color: "var(--muted)", marginBottom: "12px" }}>Results</h3>
              {searchResults.map((result) => (
                <a key={result.chunkId} href={`/workspaces/${workspaceId}/brain/${result.sourceId}`} className="nr-item" style={{ display: "block", textDecoration: "none" }}>
                  <div style={{ fontWeight: 600, color: "var(--text)" }}>{result.title ?? result.sourceId}</div>
                  <div className="nr-meta" style={{ marginTop: "4px" }}>{result.sourceType}</div>
                  <p className="nr-excerpt" style={{ fontSize: "0.85rem", marginTop: "4px" }}>{result.snippet.slice(0, 150)}...</p>
                </a>
              ))}
            </div>
          )}
        </div>

        {/* Right: Ask AI */}
        <div>
          <h2 className="nr-section-header" style={{ borderTop: "none" }}>Ask the Agent</h2>
          <form method="GET">
            {query && <input type="hidden" name="q" value={query} />}
            <textarea 
              name="question" 
              defaultValue={question} 
              placeholder="Synthesize information about...?" 
              rows={3} 
              style={{ width: "100%", padding: "12px", fontSize: "1rem", border: "1px solid var(--line)", borderRadius: "4px", marginBottom: "8px" }}
            />
            <button type="submit" style={{ padding: "8px 16px", background: "var(--accent)", color: "white", border: "none", borderRadius: "4px", cursor: "pointer" }}>Synthesize Answer</button>
          </form>

          {answer && (
            <div style={{ marginTop: "24px", padding: "16px", background: "var(--accent-soft)", borderRadius: "6px" }}>
              <div style={{ fontWeight: 600, marginBottom: "8px" }}>Agent Synthesis</div>
              <p style={{ lineHeight: 1.5, fontSize: "0.95rem", margin: "0 0 16px 0" }}>{answer.answer}</p>
              
              {answer.citations.length > 0 && (
                <div style={{ borderTop: "1px solid var(--line)", paddingTop: "12px" }}>
                  <div style={{ fontSize: "0.8rem", color: "var(--muted)", textTransform: "uppercase", marginBottom: "8px" }}>Sources used</div>
                  {answer.citations.map((c, idx) => (
                    <div key={idx} style={{ fontSize: "0.8rem", marginBottom: "8px" }}>
                      <strong style={{ color: "var(--text)" }}>{c.title ?? c.sourceId}</strong>
                      <span style={{ color: "var(--muted)", marginLeft: "8px" }}>{c.snippet.slice(0, 80)}...</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "3fr 1fr", gap: "48px" }}>
        {/* Full Index Directory */}
        <div>
          <h2 className="nr-section-header">Full Knowledge Directory</h2>
          
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "32px" }}>
            {sortedTypes.map(([type, typeArticles]) => (
              <div key={type} className="nr-category">
                <h3>{type}</h3>
                <ul>
                  {typeArticles.map((a) => (
                    <li key={a.id} style={{ marginBottom: "12px" }}>
                      <a href={`/workspaces/${workspaceId}/brain/${a.slug}`} style={{ fontSize: "0.95rem", fontWeight: 500 }}>
                        {a.isPrivate && <span title="Private draft" style={{ marginRight: 6 }}>🔒</span>}
                        {a.title}
                      </a>
                      {a.authority === "AUTHORITATIVE" && <span style={{ fontSize: "0.6rem", padding: "1px 4px", background: "var(--accent)", color: "white", borderRadius: "2px", marginLeft: "6px", verticalAlign: "middle" }}>Core</span>}
                      {a.authority === "DRAFT" && <span style={{ fontSize: "0.6rem", padding: "1px 4px", background: "var(--warning-soft)", color: "var(--warning)", borderRadius: "2px", marginLeft: "6px", verticalAlign: "middle" }}>Draft</span>}
                      <div style={{ fontSize: "0.8rem", color: "var(--muted)", marginTop: "2px" }}>{a.bodyMd.replace(/[#*]/g, '').slice(0, 80)}...</div>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            {articles.length === 0 && <p className="nr-meta">No wiki articles exist.</p>}
          </div>
        </div>

        {/* Sidebar: Raw Index */}
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: "16px" }}>
            <h2 className="nr-section-header" style={{ margin: 0, flex: 1 }}>Raw Index</h2>
            <div style={{ display: "flex", gap: "8px", fontSize: "0.8rem" }}>
              <a href="?range=30d" style={{ fontWeight: range === "30d" ? "bold" : "normal", textDecoration: "none" }}>30d</a>
              <span className="nr-meta" style={{ margin: 0 }}>|</span>
              <a href="?range=90d" style={{ fontWeight: range === "90d" ? "bold" : "normal", textDecoration: "none" }}>90d</a>
              <span className="nr-meta" style={{ margin: 0 }}>|</span>
              <a href="?range=all" style={{ fontWeight: range === "all" ? "bold" : "normal", textDecoration: "none" }}>All</a>
            </div>
          </div>

          <h3 style={{ fontSize: "0.85rem", textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--muted)", borderBottom: "1px solid var(--line)", paddingBottom: "4px", marginBottom: "12px" }}>
            Meetings ({meetings.length})
          </h3>
          <div style={{ marginBottom: "32px" }}>
            {meetings.slice(0, 20).map(m => (
              <div key={m.id} style={{ marginBottom: "12px" }}>
                <a href={`/workspaces/${workspaceId}/meetings`} style={{ display: "block", textDecoration: "none", color: "var(--text)" }}>
                  <div style={{ fontSize: "0.85rem", fontWeight: 600 }}>{m.title || `Untitled ${m.source} Meeting`}</div>
                  <div className="nr-meta">{new Date(m.recordedAt).toLocaleDateString()}</div>
                </a>
              </div>
            ))}
            {meetings.length > 20 && <a href={`/workspaces/${workspaceId}/meetings`} className="nr-link" style={{ fontSize: "0.85rem" }}>View {meetings.length - 20} more...</a>}
          </div>

          <h3 style={{ fontSize: "0.85rem", textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--muted)", borderBottom: "1px solid var(--line)", paddingBottom: "4px", marginBottom: "12px" }}>
            Documents ({documents.length})
          </h3>
          <div>
            {documents.slice(0, 10).map(d => (
              <div key={d.id} style={{ marginBottom: "12px", fontSize: "0.85rem" }}>
                <div style={{ fontWeight: 600 }}>{d.title}</div>
                <div className="nr-meta">{new Date(d.createdAt).toLocaleDateString()} · {d.source}</div>
              </div>
            ))}
          </div>

          <div style={{ marginTop: "48px", padding: "16px", background: "var(--bg-alt)", borderRadius: "6px" }}>
            <h3 style={{ fontSize: "0.85rem", textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--text)", marginBottom: "12px" }}>Create Article</h3>
            <form action={createArticleAction} style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
              <input type="hidden" name="workspaceId" value={workspaceId} />
              <input name="title" required placeholder="Article title" style={{ padding: "8px", fontSize: "0.85rem", border: "1px solid var(--line)", borderRadius: "4px" }} />
              <div style={{ display: "flex", gap: "8px" }}>
                <select name="type" style={{ flex: 1, padding: "8px", fontSize: "0.85rem", border: "1px solid var(--line)" }}>
                  {["PRODUCT","ARCHITECTURE","PROCESS","RUNBOOK","DECISION","TEAM","PERSON","CUSTOMER","INCIDENT","PROJECT","INTEGRATION","PATTERN","STRATEGY","CULTURE","GLOSSARY"].map((t) => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>
                <select name="authority" style={{ flex: 1, padding: "8px", fontSize: "0.85rem", border: "1px solid var(--line)" }}>
                  <option value="DRAFT">Draft</option>
                  <option value="REFERENCE">Reference</option>
                  <option value="AUTHORITATIVE">Authoritative</option>
                </select>
              </div>
              <textarea name="bodyMd" required placeholder="Body (Markdown)" rows={4} style={{ padding: "8px", fontSize: "0.85rem", border: "1px solid var(--line)", borderRadius: "4px", fontFamily: "monospace" }} />
              <label style={{ display: "flex", alignItems: "center", gap: "8px", fontWeight: "normal", cursor: "pointer", fontSize: "0.85rem" }}>
                <input type="checkbox" name="isPrivate" defaultChecked />
                <span>Private draft (only visible to me)</span>
              </label>
              <button type="submit" style={{ padding: "8px", background: "var(--text)", color: "white", border: "none", borderRadius: "4px", cursor: "pointer", fontWeight: 600 }}>Create</button>
            </form>
          </div>

        </div>
      </div>
    </>
  );
}
