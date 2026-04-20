import { requirePageActor } from "@/lib/auth";
import { prisma } from "@corgtex/shared";
import { listContacts, listDeals } from "@corgtex/domain";
import { redirect } from "next/navigation";
import { 
  createContactAction, 
  deleteContactAction,
  createDealAction,
} from "../actions";
import { DealStageSelect } from "./DealStageSelect";

export const dynamic = "force-dynamic";

export default async function LeadsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const actor = await requirePageActor();
  
  // They must be a member
  try {
    const membership = await prisma.member.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: actor.kind === "user" ? actor.user.id : "" } }
    });
    if (!membership) throw new Error("Not a member");
  } catch (error) {
    redirect("/");
  }

  const resolvedSearch = searchParams ? await searchParams : {};
  const view = typeof resolvedSearch.view === "string" ? resolvedSearch.view : "contacts";

  let contacts: any[] = [];
  let totalContacts = 0;
  let deals: any[] = [];
  let recentActivities: any[] = [];

  try {
    const [cResult, dResult, aResult] = await Promise.all([
      listContacts(actor, workspaceId, { take: 50 }),
      listDeals(actor, workspaceId, { take: 50 }),
      prisma.crmActivity.findMany({
        where: { workspaceId },
        include: {
          contact: { select: { name: true, email: true } },
          deal: { select: { title: true } }
        },
        orderBy: { createdAt: "desc" },
        take: 10
      })
    ]);
    contacts = cResult.items;
    totalContacts = cResult.total;
    deals = dResult.items;
    recentActivities = aResult;
  } catch (error) {
    // CRM tables might not be seeded or present in this environment, fallback safely
  }

  const dealsByStage = deals.reduce((acc, deal) => {
    acc[deal.stage] = acc[deal.stage] || [];
    acc[deal.stage].push(deal);
    return acc;
  }, {} as Record<string, typeof deals>);

  const activeDeals = deals.filter(d => d.stage !== "CLOSED_WON" && d.stage !== "CLOSED_LOST");
  const closedWon = deals.filter(d => d.stage === "CLOSED_WON");
  const pipelineValue = activeDeals.reduce((sum, d) => sum + (d.valueCents || 0), 0);

  const formatCurrency = (cents: number) => {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(cents / 100);
  };

  const ageText = (date: Date) => {
    const days = Math.floor((Date.now() - new Date(date).getTime()) / (1000 * 60 * 60 * 24));
    return days === 0 ? "today" : `${days}d ago`;
  };

  return (
    <>
      <header className="nr-masthead" style={{ textAlign: "left", marginBottom: 32 }}>
        <h1 style={{ border: "none", padding: 0, margin: 0, fontSize: "2.5rem" }}>Relationships</h1>
        <div className="nr-masthead-meta">
          <span>Manage contacts, leads, and pipeline deals.</span>
        </div>
      </header>

      <section className="ws-section">
        <div className="ws-stat-row">
          <div className="ws-stat-card">
            <strong>{totalContacts}</strong>
            <span>Total Contacts</span>
          </div>
          <div className="ws-stat-card">
            <strong>{activeDeals.length}</strong>
            <span>Active Deals</span>
          </div>
          <div className="ws-stat-card">
            <strong>{formatCurrency(pipelineValue)}</strong>
            <span>Pipeline Value</span>
          </div>
          <div className="ws-stat-card">
            <strong>{closedWon.length}</strong>
            <span>Deals Won</span>
          </div>
        </div>

        <div className="nr-filter-bar">
          {(["contacts", "pipeline", "activity"] as const).map((s) => (
            <a 
              key={s} 
              href={`?view=${s}`} 
              className={`nr-filter-item ${view === s ? "nr-filter-active" : ""}`}
              style={{ textTransform: "capitalize" }}
            >
              {s}
            </a>
          ))}
        </div>

        {view === "contacts" && (
          <div>
            <div style={{ marginBottom: "24px", display: "flex", justifyContent: "flex-end" }}>
              <details style={{ width: "100%" }}>
                <summary className="link-button small" style={{ cursor: "pointer", marginLeft: "auto", display: "inline-flex" }}>
                  + New Contact
                </summary>
                <form action={createContactAction} className="stack nr-form-section" style={{ marginTop: 16 }}>
                  <input type="hidden" name="workspaceId" value={workspaceId} />
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
                    <label>Email <input type="email" name="email" required /></label>
                    <label>Name <input type="text" name="name" /></label>
                    <label>Company <input type="text" name="company" /></label>
                    <label>Title <input type="text" name="title" /></label>
                  </div>
                  <button type="submit" style={{ width: "fit-content" }}>Create Contact</button>
                </form>
              </details>
            </div>

            {contacts.length === 0 ? (
              <p className="muted">No contacts yet. Adding demo form leads or creating them manually will show them here.</p>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.9rem" }}>
                  <thead>
                    <tr style={{ borderBottom: "2px solid var(--line)", textAlign: "left" }}>
                      <th style={{ padding: "12px 8px" }}>Contact</th>
                      <th style={{ padding: "12px 8px" }}>Company</th>
                      <th style={{ padding: "12px 8px" }}>Source</th>
                      <th style={{ padding: "12px 8px" }}>Created</th>
                      <th style={{ padding: "12px 8px" }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {contacts.map((contact) => (
                      <tr key={contact.id} style={{ borderBottom: "1px solid var(--line)" }}>
                        <td style={{ padding: "12px 8px" }}>
                          <div style={{ fontWeight: 600, color: "var(--text)" }}>{contact.name || "Unknown"}</div>
                          <div className="muted" style={{ fontSize: "0.8rem" }}>{contact.email}</div>
                        </td>
                        <td style={{ padding: "12px 8px" }}>
                          {contact.company || <span className="muted">—</span>}
                        </td>
                        <td style={{ padding: "12px 8px" }}>
                          <span className="tag">{contact.source}</span>
                        </td>
                        <td style={{ padding: "12px 8px" }} className="muted">
                          {new Date(contact.createdAt).toLocaleDateString()}
                        </td>
                        <td style={{ padding: "12px 8px" }}>
                          <details style={{ position: "relative" }}>
                            <summary style={{ cursor: "pointer", color: "var(--accent)", listStyle: "none" }}>⋯</summary>
                            <div style={{ position: "absolute", right: 0, top: "100%", background: "white", padding: 8, border: "1px solid var(--line)", borderRadius: 8, zIndex: 10, boxShadow: "var(--shadow-md)" }}>
                              <form action={deleteContactAction}>
                                <input type="hidden" name="workspaceId" value={workspaceId} />
                                <input type="hidden" name="contactId" value={contact.id} />
                                <button type="submit" className="danger small" style={{ width: "100%", whiteSpace: "nowrap" }}>Delete</button>
                              </form>
                            </div>
                          </details>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {view === "pipeline" && (
          <div>
            <div style={{ marginBottom: "24px", display: "flex", justifyContent: "flex-end" }}>
              <details style={{ width: "100%" }}>
                <summary className="link-button small" style={{ cursor: "pointer", marginLeft: "auto", display: "inline-flex" }}>
                  + New Deal
                </summary>
                <form action={createDealAction} className="stack nr-form-section" style={{ marginTop: 16 }}>
                  <input type="hidden" name="workspaceId" value={workspaceId} />
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
                    <label>
                      Contact
                      <select name="contactId" required>
                        <option value="">Select a contact...</option>
                        {contacts.map((c) => <option key={c.id} value={c.id}>{c.name || c.email}</option>)}
                      </select>
                    </label>
                    <label>Deal Title <input type="text" name="title" required /></label>
                    <label>Value (USD) <input type="number" name="value" step="0.01" min="0" /></label>
                  </div>
                  <button type="submit" style={{ width: "fit-content" }}>Create Deal</button>
                </form>
              </details>
            </div>

            <div style={{ display: "flex", gap: "16px", overflowX: "auto", paddingBottom: "16px" }}>
              {(["LEAD", "QUALIFIED", "PROPOSAL", "NEGOTIATION", "CLOSED_WON", "CLOSED_LOST"] as const).map(stage => (
                <div key={stage} style={{ flex: "0 0 300px", background: "var(--bg-alt)", borderRadius: "12px", padding: "16px" }}>
                  <div style={{ fontWeight: 600, marginBottom: "16px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    {stage.replace("_", " ")}
                    <span className="muted" style={{ fontSize: "0.8rem", background: "rgba(0,0,0,0.05)", padding: "2px 8px", borderRadius: "99px" }}>
                      {(dealsByStage[stage] || []).length}
                    </span>
                  </div>
                  <div className="stack">
                    {(dealsByStage[stage] || []).map((deal: any) => (
                      <div key={deal.id} className="item" style={{ background: "white", padding: "12px" }}>
                        <div style={{ fontWeight: 600, fontSize: "0.95rem", marginBottom: 4 }}>{deal.title}</div>
                        <div className="row" style={{ fontSize: "0.8rem" }}>
                          <span className="muted">{deal.contact.name || deal.contact.email}</span>
                          {deal.valueCents != null && <strong style={{ color: "var(--success)" }}>{formatCurrency(deal.valueCents)}</strong>}
                        </div>
                        <div style={{ marginTop: 12, display: "flex", gap: "4px" }}>
                          <DealStageSelect workspaceId={workspaceId} dealId={deal.id} currentStage={deal.stage} />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {view === "activity" && (
          <div className="stack">
            {recentActivities.length === 0 && <p className="muted">No recent activity.</p>}
            {recentActivities.map(activity => (
              <div key={activity.id} className="item" style={{ display: "flex", gap: "16px" }}>
                <div style={{ width: "40px", height: "40px", borderRadius: "50%", background: "var(--accent-soft)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "1.2rem", flexShrink: 0 }}>
                  {activity.type === "EMAIL" ? "✉️" : activity.type === "MEETING" ? "📅" : activity.type === "CALL" ? "📞" : "📝"}
                </div>
                <div>
                  <div className="row" style={{ justifyContent: "flex-start", gap: "8px", marginBottom: "4px" }}>
                    <strong style={{ fontSize: "0.95rem" }}>{activity.title}</strong>
                    <span className="tag">{activity.type}</span>
                    <span className="muted" style={{ fontSize: "0.8rem", marginLeft: "auto" }}>{ageText(activity.createdAt)}</span>
                  </div>
                  <div style={{ fontSize: "0.85rem", color: "var(--text)", lineHeight: 1.5, marginBottom: "8px" }}>
                    {activity.bodyMd}
                  </div>
                  <div className="row" style={{ fontSize: "0.8rem" }}>
                    {activity.contact && (
                      <span className="muted">Contact: <strong>{activity.contact.name || activity.contact.email}</strong></span>
                    )}
                    {activity.deal && (
                      <span className="muted">Deal: <strong>{activity.deal.title}</strong></span>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
