import { requirePageActor } from "@/lib/auth";
import { prisma } from "@corgtex/shared";
import { getMemberExpertiseProfile, getLatestImpactFootprint } from "@corgtex/domain";
import Link from "next/link";
import { endorseMemberExpertiseAction } from "../../actions";

export const dynamic = "force-dynamic";


export default async function MemberProfilePage({
  params,
}: {
  params: Promise<{ workspaceId: string; memberId: string }>;
}) {
  const { workspaceId, memberId } = await params;
  const actor = await requirePageActor();

  const member = await prisma.member.findUnique({
    where: { id: memberId, workspaceId },
    include: {
      user: { select: { id: true, displayName: true, email: true } },
      roleAssignments: {
        include: { role: { include: { circle: true } } },
      },
      authoredAdviceProcesses: {
        where: { status: "EXECUTED" },
        include: { proposal: { select: { title: true } } },
        take: 5,
        orderBy: { executedAt: "desc" }
      },
      adviceRecords: {
        include: { process: { include: { proposal: { select: { title: true } } } } },
        take: 5,
        orderBy: { createdAt: "desc" }
      }
    },
  });

  if (!member) {
    return <div>Member not found</div>;
  }

  const expertise = await getMemberExpertiseProfile(actor, workspaceId, memberId);
  const footprint = await getLatestImpactFootprint(actor, workspaceId, memberId);

  return (
    <>
      <header className="nr-masthead" style={{ textAlign: "left", marginBottom: 32 }}>
        <h1 style={{ border: "none", padding: 0, margin: 0, fontSize: "2.5rem" }}>
          {member.user.displayName || member.user.email}
        </h1>
        <div className="nr-masthead-meta">
          <span className="tag info">{member.role}</span>
        </div>
      </header>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "24px" }}>
        
        {/* Left Column: Impact Footprint & Recent Activity */}
        <div className="stack">
          <section className="ws-section">
            <h2 className="nr-section-header">Impact Footprint (Last 90 Days)</h2>
            {footprint ? (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
                <div className="nr-stat-card">
                  <div className="nr-stat-value">{footprint.tensionsResolved}</div>
                  <div className="nr-stat-label">Tensions Resolved</div>
                </div>
                <div className="nr-stat-card">
                  <div className="nr-stat-value">{footprint.actionsCompleted}</div>
                  <div className="nr-stat-label">Actions Completed</div>
                </div>
                <div className="nr-stat-card">
                  <div className="nr-stat-value">{footprint.proposalsExecuted}</div>
                  <div className="nr-stat-label">Decisions Executed</div>
                </div>
                <div className="nr-stat-card">
                  <div className="nr-stat-value">{footprint.adviceGiven}</div>
                  <div className="nr-stat-label">Advice Given</div>
                </div>
              </div>
            ) : (
              <p className="muted">Impact Footprint has not been calculated yet. It will update during the next governance cycle.</p>
            )}
          </section>

          <section className="ws-section">
            <h2 className="nr-section-header">Recent Contributions</h2>
            
            <h3 style={{ fontSize: "1rem", marginTop: 16 }}>Authored Decisions</h3>
            {member.authoredAdviceProcesses.length === 0 && <p className="muted">None yet</p>}
            <ul style={{ paddingLeft: 20 }}>
              {member.authoredAdviceProcesses.map(ap => (
                <li key={ap.id}>
                  <Link href={`/workspaces/${workspaceId}/proposals/${ap.proposalId}`}>
                    {ap.proposal.title}
                  </Link>
                </li>
              ))}
            </ul>

            <h3 style={{ fontSize: "1rem", marginTop: 16 }}>Advice Given</h3>
            {member.adviceRecords.length === 0 && <p className="muted">None yet</p>}
            <ul style={{ paddingLeft: 20 }}>
              {member.adviceRecords.map(ar => (
                <li key={ar.id}>
                  {ar.type === "ENDORSE" ? "👍" : "⚠️"} {ar.type.toLowerCase()} on{" "}
                  <Link href={`/workspaces/${workspaceId}/proposals/${ar.process.proposalId}`}>
                    {ar.process.proposal.title}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        </div>

        {/* Right Column: Roles & Expertise */}
        <div className="stack">
          <section className="ws-section">
            <h2 className="nr-section-header">Current Roles</h2>
            {member.roleAssignments.length === 0 && <p className="muted">No roles assigned.</p>}
            {member.roleAssignments.map(ra => (
              <div key={ra.id} className="nr-item" style={{ marginBottom: 12 }}>
                <strong>{ra.role.name}</strong>
                <div className="muted" style={{ fontSize: "0.85rem" }}>
                  Circle: {ra.role.circle.name}
                </div>
              </div>
            ))}
          </section>

          <section className="ws-section">
            <h2 className="nr-section-header">Expertise Profile</h2>
            {expertise.length === 0 && <p className="muted">No expertise claimed or inferred yet.</p>}
            <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
              {expertise.map(exp => (
                <div key={exp.id} className="nr-item" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px" }}>
                  <div>
                    <strong>{exp.expertiseTag.label}</strong>
                    <div style={{ fontSize: "0.85rem", marginTop: 4 }}>
                      <span className={`tag ${exp.level === "AUTHORITY" ? "danger" : exp.level === "EXPERT" ? "warning" : "info"}`}>
                        {exp.level}
                      </span>
                      <span className="muted" style={{ marginLeft: 8 }}>
                        {exp.endorsedCount} endorsements
                      </span>
                    </div>
                  </div>
                  
                  {actor.kind === "user" && member.userId !== actor.user.id && (
                    <form action={endorseMemberExpertiseAction}>
                      <input type="hidden" name="workspaceId" value={workspaceId} />
                      <input type="hidden" name="memberId" value={member.id} />
                      <input type="hidden" name="tagId" value={exp.expertiseTagId} />
                      <button type="submit" className="secondary small">Endorse</button>
                    </form>
                  )}
                </div>
              ))}
            </div>
          </section>
        </div>

      </div>
    </>
  );
}
