import { getMemberProfile } from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";
import { notFound } from "next/navigation";
import Link from "next/link";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ workspaceId: string; memberId: string }>;
}

function getInitials(name?: string | null, email?: string) {
  if (name) {
    const parts = name.split(" ");
    return parts.length >= 2
      ? `${parts[0][0]}${parts[1][0]}`.toUpperCase()
      : name.slice(0, 2).toUpperCase();
  }
  return email ? email.slice(0, 2).toUpperCase() : "?";
}

export default async function MemberProfilePage({ params }: PageProps) {
  const { workspaceId, memberId } = await params;
  await requirePageActor();

  let data;
  try {
    data = await getMemberProfile(workspaceId, memberId);
  } catch (error) {
    notFound();
  }

  const { member, meetings, proposals, authoredTensions, recentActivity } = data;

  return (
    <>
      <header className="nr-masthead" style={{ textAlign: "left", marginBottom: 32 }}>
        <Link
          href={`/workspaces/${workspaceId}/circles`}
          style={{ textDecoration: "none", color: "var(--muted)", fontSize: "0.85rem", marginBottom: 16, display: "inline-block" }}
        >
          ← Back to Graph
        </Link>
        <div style={{ display: "flex", alignItems: "center", gap: 24, marginTop: 16 }}>
          <div style={{ 
            width: 80, 
            height: 80, 
            borderRadius: 40, 
            background: "var(--accent-soft)", 
            color: "var(--accent)", 
            display: "flex", 
            alignItems: "center", 
            justifyContent: "center",
            fontSize: "2rem",
            fontWeight: 600
          }}>
            {getInitials(member.user?.displayName, member.user?.email)}
          </div>
          <div>
            <h1 style={{ border: "none", padding: 0, margin: "0 0 8px 0", fontSize: "2rem" }}>
              {member.user?.displayName || "Unknown User"}
            </h1>
            <div className="nr-masthead-meta" style={{ display: "flex", gap: 12, alignItems: "center" }}>
              <span>{member.user?.email}</span>
              <span className="badge-getting-started" style={{ padding: "2px 8px", borderRadius: 12, fontSize: "0.75rem", background: "var(--surface)", border: "1px solid var(--line)" }}>
                {member.role}
              </span>
            </div>
          </div>
        </div>
      </header>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 32 }}>
        <div style={{ flex: 2, minWidth: 300 }}>
          <section className="ws-section" style={{ marginBottom: 32 }}>
            <h2 className="nr-section-header">Roles & Circles</h2>
            {member.roleAssignments.length === 0 ? (
              <p className="muted italic">No roles assigned.</p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                {member.roleAssignments.map((ra) => (
                  <div key={ra.id} className="nr-item">
                    <div className="nr-item-meta" style={{ marginBottom: 4 }}>
                      <Link href={`/workspaces/${workspaceId}/circles`} style={{ color: "var(--accent)", textDecoration: "none" }}>
                        {ra.role.circle?.name || "No Circle"} Circle
                      </Link>
                    </div>
                    <strong className="nr-item-title">{ra.role.name}</strong>
                    {ra.role.purposeMd && (
                      <div className="nr-excerpt" style={{ marginTop: 8 }}>
                        {ra.role.purposeMd}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="ws-section" style={{ marginBottom: 32 }}>
            <h2 className="nr-section-header">Recent Proposals</h2>
            {proposals.length === 0 ? (
              <p className="muted italic">No recent proposals.</p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {proposals.map((p) => (
                  <Link
                    key={p.id}
                    href={`/workspaces/${workspaceId}/proposals/${p.id}`}
                    className="nr-item row"
                    style={{ textDecoration: "none", color: "inherit", display: "flex", justifyContent: "space-between" }}
                  >
                    <span>{p.title || "Untitled"}</span>
                    <span className="muted" style={{ fontSize: "0.8rem", textTransform: "uppercase" }}>{p.status}</span>
                  </Link>
                ))}
              </div>
            )}
          </section>

          <section className="ws-section">
            <h2 className="nr-section-header">Active Tensions</h2>
            {authoredTensions.length === 0 && member.assignedTensions.length === 0 ? (
              <p className="muted italic">No active tensions.</p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {[...authoredTensions, ...member.assignedTensions].reduce((acc: any[], curr) => {
                  if (!acc.find(item => item.id === curr.id)) acc.push(curr);
                  return acc;
                }, []).map((t) => (
                  <div key={t.id} className="nr-item row" style={{ display: "flex", justifyContent: "space-between" }}>
                    <span>{t.title || "Untitled"}</span>
                    <span className="muted" style={{ fontSize: "0.8rem", textTransform: "uppercase" }}>{t.status}</span>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>

        <div style={{ flex: 1, minWidth: 300 }}>
          <section className="ws-section" style={{ marginBottom: 32 }}>
            <h2 className="nr-section-header">Recent Meetings</h2>
            {meetings.length === 0 ? (
              <p className="muted italic">No recent meetings.</p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {meetings.map((m) => (
                  <Link
                    key={m.id}
                    href={`/workspaces/${workspaceId}/meetings/${m.id}`}
                    className="nr-item"
                    style={{ textDecoration: "none", color: "inherit", display: "block" }}
                  >
                    <div style={{ fontWeight: 500 }}>{m.title || "Untitled Meeting"}</div>
                    <div className="nr-item-meta mt-1">
                      {new Date(m.recordedAt).toLocaleDateString()}
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </section>

          <section className="ws-section">
            <h2 className="nr-section-header">Recent Activity</h2>
            {recentActivity.length === 0 ? (
              <p className="muted italic">No recent activity.</p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {recentActivity.map((log) => (
                  <div key={log.id} style={{ fontSize: "0.85rem", padding: "8px 0", borderBottom: "1px solid var(--line)" }}>
                    <div style={{ color: "var(--text)", fontWeight: 500, marginBottom: 2 }}>{log.action}</div>
                    <div className="muted">{new Date(log.createdAt).toLocaleDateString()}</div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </>
  );
}
