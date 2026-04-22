import { listMembersEnriched, listAgentIdentities } from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function MembersPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const actor = await requirePageActor();

  const members = await listMembersEnriched(workspaceId, { includeInactive: false });
  const agents = await listAgentIdentities(actor, workspaceId);

  return (
    <>
      <header className="nr-masthead" style={{ textAlign: "left", marginBottom: 32 }}>
        <h1 style={{ border: "none", padding: 0, margin: 0, fontSize: "2.5rem" }}>Members</h1>
        <div className="nr-masthead-meta">
          <span>Everyone in your workspace.</span>
        </div>
      </header>

      <section className="ws-section" style={{ padding: "0 24px" }}>
        <div style={{ display: "grid", gap: "16px", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))" }}>
          {members.map(member => {
            const displayName = member.user.displayName || member.user.email;
            const initials = member.user.displayName 
              ? member.user.displayName.split(" ").map((n: string) => n[0]).join("").substring(0, 2).toUpperCase() 
              : member.user.email.substring(0,2).toUpperCase();
            const isAgent = member.user.email.includes("agent") || displayName.toLowerCase().includes("agent") || member.user.email.includes("system+");
            
            return (
              <Link 
                href={`/workspaces/${workspaceId}/members/${member.id}`} 
                key={member.id}
                className="nr-item"
                style={{ textDecoration: "none", color: "inherit", transition: "transform 0.1s" }}
              >
                <div style={{ display: "flex", gap: "16px", alignItems: "center" }}>
                  <div style={{ 
                    width: 48, 
                    height: 48, 
                    borderRadius: 24, 
                    background: isAgent ? "#f1f5f9" : "var(--accent-soft)", 
                    color: isAgent ? "#334155" : "var(--accent)", 
                    border: isAgent ? "1px solid var(--line)" : "none",
                    display: "flex", 
                    alignItems: "center", 
                    justifyContent: "center",
                    fontWeight: 600,
                    fontSize: "1.1rem"
                  }}>
                    {isAgent ? "🤖" : initials}
                  </div>
                  <div>
                    <h3 style={{ margin: "0 0 4px", fontSize: "1rem" }}>{displayName}</h3>
                    <div className="muted" style={{ fontSize: "0.8rem", marginBottom: 4 }}>
                      {member.user.email}
                    </div>
                    <div style={{ fontSize: "0.75rem", background: "var(--bg-alt)", display: "inline-block", padding: "2px 8px", borderRadius: "12px" }}>
                      {member.role}
                    </div>
                  </div>
                </div>
              </Link>
            )
          })}
        </div>

        {agents.length > 0 && (
          <>
            <div className="nr-section-header" style={{ marginTop: 48, marginBottom: 24, padding: "8px 0" }}>
              <h2 style={{ fontSize: "1.5rem", margin: 0, borderTop: "2px solid var(--text)", paddingTop: 16 }}>Agent Members</h2>
            </div>
            <div style={{ display: "grid", gap: "16px", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))" }}>
              {agents.map((agent: any) => (
                <Link 
                  href={`/workspaces/${workspaceId}/agents/${agent.id}`} 
                  key={agent.id}
                  className="nr-item"
                  style={{ textDecoration: "none", color: "inherit", transition: "transform 0.1s" }}
                >
                  <div style={{ display: "flex", gap: "16px", alignItems: "center" }}>
                    <div style={{ 
                      width: 48, 
                      height: 48, 
                      borderRadius: 24, 
                      background: agent.memberType === "INTERNAL" ? "var(--accent-muted)" : "var(--bg-alt)", 
                      border: "1px solid var(--line)",
                      display: "flex", 
                      alignItems: "center", 
                      justifyContent: "center",
                      fontWeight: 600,
                      fontSize: "1.1rem"
                    }}>
                      🤖
                    </div>
                    <div>
                      <h3 style={{ margin: "0 0 4px", fontSize: "1rem" }}>{agent.displayName}</h3>
                      <div className="muted" style={{ fontSize: "0.8rem", marginBottom: 4 }}>
                        Key: {agent.agentKey}
                      </div>
                      <div style={{ fontSize: "0.75rem", background: agent.memberType === "INTERNAL" ? "#fef3c7" : "#f3e8ff", color: agent.memberType === "INTERNAL" ? "#92400e" : "#6b21a8", display: "inline-block", padding: "2px 8px", borderRadius: "12px", border: `1px solid ${agent.memberType === "INTERNAL" ? "#fde68a" : "#e9d5ff"}`, marginRight: 4 }}>
                        {agent.memberType === "INTERNAL" ? "Built-in" : "Personal Agent"}
                      </div>
                      {!agent.isActive && (
                        <div style={{ fontSize: "0.75rem", background: "var(--bg-alt)", color: "var(--text-muted)", display: "inline-block", padding: "2px 8px", borderRadius: "12px", border: "1px solid var(--line)" }}>
                          Inactive
                        </div>
                      )}
                      {agent.circleAssignments && agent.circleAssignments.length > 0 && (
                        <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginTop: 4 }}>
                          In {agent.circleAssignments.length} circle{agent.circleAssignments.length > 1 ? "s" : ""}
                        </div>
                      )}
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          </>
        )}
      </section>
    </>
  );
}
