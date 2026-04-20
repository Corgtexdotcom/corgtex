import { getMeeting } from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";
import Link from "next/link";
import { renderMarkdown } from "@/lib/markdown";

export const dynamic = "force-dynamic";


export default async function MeetingDetailPage({
  params,
}: {
  params: Promise<{ workspaceId: string; meetingId: string }>;
}) {
  const { workspaceId, meetingId } = await params;
  await requirePageActor();

  const meeting = await getMeeting(workspaceId, meetingId);

  if (!meeting) {
    return (
      <div className="ws-page-header">
        <h1>Meeting not found</h1>
        <Link href={`/workspaces/${workspaceId}/meetings`} className="nr-meta" style={{ textDecoration: "underline" }}>
          &larr; Back to meetings
        </Link>
      </div>
    );
  }

  const getReactionCount = (proposal: any, type: string) => 
    proposal.reactions.filter((r: any) => r.reaction === type).length;

  return (
    <>
      <div style={{ marginBottom: "32px" }}>
        <Link href={`/workspaces/${workspaceId}/meetings`} className="nr-meta" style={{ textDecoration: "none" }}>
          &larr; Back to Board Meetings
        </Link>
      </div>

      <header className="nr-masthead" style={{ textAlign: "left", marginBottom: 32 }}>
        <div className="nr-meta" style={{ marginBottom: "8px" }}>{meeting.source}</div>
        <h1 style={{ border: "none", padding: 0, margin: 0, fontSize: "2.5rem" }}>
          {meeting.title || "Untitled Meeting"}
        </h1>
        <div className="nr-masthead-meta">
          <span>{new Date(meeting.recordedAt).toLocaleString()}</span>
        </div>
      </header>

      {meeting.summaryMd && (
        <section className="ws-section" style={{ marginBottom: 48 }}>
          <h2 className="nr-section-header">Summary</h2>
          <div 
            className="nr-excerpt" 
            style={{ fontSize: "1rem", lineHeight: 1.6 }}
            dangerouslySetInnerHTML={{ __html: renderMarkdown(meeting.summaryMd) }}
          />
        </section>
      )}

      {meeting.tensions.length > 0 && (
        <section className="ws-section" style={{ marginBottom: 48 }}>
          <h2 className="nr-section-header">Tensions Raised</h2>
          <div className="list">
            {meeting.tensions.map(tension => (
              <div className="item" key={tension.id}>
                <div className="row">
                  <strong>{tension.title}</strong>
                  <span className={`tag ${tension.status === 'OPEN' ? 'warning' : 'success'}`}>
                    {tension.status}
                  </span>
                </div>
                <div className="muted">{tension.bodyMd}</div>
                <div className="muted" style={{ fontSize: "0.82rem", marginTop: 8 }}>
                  {tension.author?.displayName || tension.author?.email}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {meeting.proposals.length > 0 && (
        <section className="ws-section" style={{ marginBottom: 48 }}>
          <h2 className="nr-section-header">Proposals Created</h2>
          <div className="list">
            {meeting.proposals.map(proposal => (
              <div className="item" key={proposal.id}>
                <div className="row">
                  <strong>{proposal.title}</strong>
                  <span className={`tag ${proposal.status === "DRAFT" ? "info" : proposal.status === "SUBMITTED" ? "warning" : proposal.status === "APPROVED" ? "success" : proposal.status === "REJECTED" ? "danger" : ""}`}>
                    {proposal.status}
                  </span>
                </div>
                <div className="muted">{proposal.summary ?? proposal.bodyMd.slice(0, 150) + "..."}</div>
                
                <div className="muted" style={{ fontSize: "0.82rem", marginTop: 8 }}>
                   {proposal.author?.displayName || proposal.author?.email} · {new Date(proposal.createdAt).toLocaleDateString()}
                   {" · "} Support: {getReactionCount(proposal, "SUPPORT")} {" · "} Questions: {getReactionCount(proposal, "QUESTION")} {" · "} Concerns: {getReactionCount(proposal, "CONCERN")}
                </div>

                {(proposal.tensions?.length > 0 || proposal.actions?.length > 0) && (
                  <div style={{ marginTop: 8, fontSize: "0.82rem", display: "flex", gap: "8px", flexWrap: "wrap" }}>
                    {proposal.tensions?.map((t: any) => (
                      <span key={t.id} className="tag info" style={{ padding: "2px 6px", fontSize: "0.75rem" }}>
                        Tension: {t.title}
                      </span>
                    ))}
                    {proposal.actions?.map((a: any) => (
                      <span key={a.id} className="tag info" style={{ padding: "2px 6px", fontSize: "0.75rem" }}>
                        Action: {a.title}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {meeting.transcript && (
        <section className="ws-section" style={{ marginBottom: 48 }}>
          <details>
            <summary style={{ cursor: "pointer", fontWeight: 600, color: "var(--accent)" }}>
              <span className="nr-section-header" style={{ borderTop: "none", display: "inline-block", padding: 0, margin: 0 }}>View Full Transcript</span>
            </summary>
            <div style={{ marginTop: "24px", whiteSpace: "pre-wrap", fontSize: "0.9rem", color: "var(--text)" }}>
              {meeting.transcript}
            </div>
          </details>
        </section>
      )}
    </>
  );
}
