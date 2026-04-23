import { listMembersEnriched } from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function MembersPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  await requirePageActor();

  const members = await listMembersEnriched(workspaceId, { includeInactive: false });

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
      </section>
    </>
  );
}
