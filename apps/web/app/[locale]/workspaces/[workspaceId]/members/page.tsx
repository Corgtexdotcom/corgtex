import { AppError, listMembersEnriched, listAgentIdentities, requireWorkspaceMembership } from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { getWorkspaceFeatureFlags } from "@/lib/workspace-feature-flags";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function MembersPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const actor = await requirePageActor();
  const t = await getTranslations("members");
  try {
    await requireWorkspaceMembership({ actor, workspaceId });
  } catch (error) {
    if (error instanceof AppError && error.status === 403) {
      notFound();
    }
    throw error;
  }

  const featureFlags = await getWorkspaceFeatureFlags(workspaceId);
  const members = await listMembersEnriched(workspaceId, { includeInactive: false });
  const agents = featureFlags.AGENT_GOVERNANCE ? await listAgentIdentities(actor, workspaceId) : [];

  return (
    <>
      <header className="nr-masthead" style={{ textAlign: "left", marginBottom: 32 }}>
        <h1 style={{ border: "none", padding: 0, margin: 0, fontSize: "2.5rem" }}>{t("title")}</h1>
        <div className="nr-masthead-meta">
          <span>{t("description")}</span>
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
                    background: isAgent ? "var(--surface-sunken)" : "var(--accent-soft)", 
                    color: isAgent ? "var(--text-strong)" : "var(--accent)", 
                    border: isAgent ? "1px solid var(--line)" : "none",
                    display: "flex", 
                    alignItems: "center", 
                    justifyContent: "center",
                    fontWeight: 600,
                    fontSize: "1.1rem"
                  }}>
                    {isAgent ? "⬡" : initials}
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
              <h2 style={{ fontSize: "1.5rem", margin: 0, borderTop: "2px solid var(--text)", paddingTop: 16 }}>{t("agentMembers")}</h2>
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
                      ⬡
                    </div>
                    <div>
                      <h3 style={{ margin: "0 0 4px", fontSize: "1rem" }}>{agent.displayName}</h3>
                      <div className="muted" style={{ fontSize: "0.8rem", marginBottom: 4 }}>
                        Key: {agent.agentKey}
                      </div>
                      <div style={{ fontSize: "0.75rem", background: agent.memberType === "INTERNAL" ? "var(--warning-soft)" : "var(--info-soft)", color: agent.memberType === "INTERNAL" ? "var(--warning)" : "var(--info)", display: "inline-block", padding: "2px 8px", borderRadius: "12px", border: `1px solid ${agent.memberType === "INTERNAL" ? "var(--warning)" : "var(--info)"}`, marginRight: 4 }}>
                        {agent.memberType === "INTERNAL" ? t("builtIn") : t("personalAgent")}
                      </div>
                      {!agent.isActive && (
                        <div style={{ fontSize: "0.75rem", background: "var(--bg-alt)", color: "var(--text-muted)", display: "inline-block", padding: "2px 8px", borderRadius: "12px", border: "1px solid var(--line)" }}>
                          {t("inactive")}
                        </div>
                      )}
                      {agent.circleAssignments && agent.circleAssignments.length > 0 && (
                        <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginTop: 4 }}>
                          {t("inCircles", { count: agent.circleAssignments.length })}
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
