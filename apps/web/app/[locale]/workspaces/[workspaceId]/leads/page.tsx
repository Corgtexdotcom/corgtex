import { requirePageActor } from "@/lib/auth";
import { prisma } from "@corgtex/shared";
import { listContacts, listDeals, listQualifications, listCrmConversations } from "@corgtex/domain";
import { redirect } from "next/navigation";
import { 
  createContactAction, 
  deleteContactAction,
  createDealAction,
  approveQualificationAction,
  rejectQualificationAction,
  createConversationMessageAction,
  provisionProspectWorkspaceAction
} from "../actions";
import { DealStageSelect } from "./DealStageSelect";
import { getTranslations } from "next-intl/server";
import { requireWorkspaceFeature } from "@/lib/workspace-feature-flags";

export const dynamic = "force-dynamic";

export default async function LeadsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  await requireWorkspaceFeature(workspaceId, "RELATIONSHIPS");
  const actor = await requirePageActor();
  const t = await getTranslations("leads");
  
  // They must be a member
  try {
    const membership = await prisma.member.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: actor.kind === "user" ? actor.user.id : "" } }
    });
    if (!membership) throw new Error(t("errorNotMember"));
  } catch (error) {
    redirect("/");
  }

  const resolvedSearch = searchParams ? await searchParams : {};
  const view = typeof resolvedSearch.view === "string" ? resolvedSearch.view : "contacts";

  let contacts: any[] = [];
  let totalContacts = 0;
  let deals: any[] = [];
  let recentActivities: any[] = [];
  let pendingQualifications: any[] = [];
  let conversations: any[] = [];
  let prospectWorkspaces: any[] = [];

  try {
    const [cResult, dResult, aResult, qResult, convResult, pwResult] = await Promise.all([
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
      }),
      listQualifications(actor, workspaceId, { status: "PENDING_REVIEW" }),
      listCrmConversations(actor, workspaceId, { take: 20 }),
      prisma.crmProspectWorkspace.findMany({
        where: { crmWorkspaceId: workspaceId },
        include: { demoLead: true, targetWorkspace: true },
        orderBy: { provisionedAt: "desc" }
      })
    ]);
    contacts = cResult.items;
    totalContacts = cResult.total;
    deals = dResult.items;
    recentActivities = aResult;
    pendingQualifications = qResult.items;
    conversations = convResult.items;
    prospectWorkspaces = pwResult;
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
    return days === 0 ? t("ageToday") : t("ageDaysAgo", { days });
  };

  const viewLabels: Record<string, string> = {
    contacts: t("tabContacts"),
    pipeline: t("tabPipeline"),
    activity: t("tabActivity"),
    review: "Review Queue",
    conversations: "Conversations",
    instances: "Instances",
  };

  const activityIcon = (type: string) => {
    const labels: Record<string, string> = {
      EMAIL: t("activityIconEmail"),
      MEETING: t("activityIconMeeting"),
      CALL: t("activityIconCall"),
      NOTE: t("activityIconNote"),
    };
    return labels[type] ?? t("activityIconDefault");
  };

  const activityTypeLabel = (type: string) => {
    const labels: Record<string, string> = {
      EMAIL: t("activityTypeEmail"),
      MEETING: t("activityTypeMeeting"),
      CALL: t("activityTypeCall"),
      NOTE: t("activityTypeNote"),
    };
    return labels[type] ?? type;
  };

  return (
    <>
      <header className="nr-masthead" style={{ textAlign: "left", marginBottom: 32 }}>
        <h1 style={{ border: "none", padding: 0, margin: 0, fontSize: "2.5rem" }}>{t("pageTitle")}</h1>
        <div className="nr-masthead-meta">
          <span>{t("pageDescription")}</span>
        </div>
      </header>

      <section className="ws-section">
        <div className="ws-stat-row">
          <div className="ws-stat-card">
            <strong>{totalContacts}</strong>
            <span>{t("statTotalContacts")}</span>
          </div>
          <div className="ws-stat-card">
            <strong>{activeDeals.length}</strong>
            <span>{t("statActiveDeals")}</span>
          </div>
          <div className="ws-stat-card">
            <strong>{formatCurrency(pipelineValue)}</strong>
            <span>{t("statPipelineValue")}</span>
          </div>
          <div className="ws-stat-card">
            <strong>{closedWon.length}</strong>
            <span>{t("statDealsWon")}</span>
          </div>
        </div>

        <div className="nr-filter-bar">
          {(["contacts", "pipeline", "activity", "review", "conversations", "instances"] as const).map((s) => (
            <a 
              key={s} 
              href={`?view=${s}`} 
              className={`nr-filter-item ${view === s ? "nr-filter-active" : ""}`}
            >
              {viewLabels[s]}
            </a>
          ))}
        </div>

        {view === "contacts" && (
          <div>
            <div style={{ marginBottom: "24px", display: "flex", justifyContent: "flex-end" }}>
              <details style={{ width: "100%" }}>
                <summary className="link-button small" style={{ cursor: "pointer", marginLeft: "auto", display: "inline-flex" }}>
                  {t("btnNewContact")}
                </summary>
                <form action={createContactAction} className="stack nr-form-section" style={{ marginTop: 16 }}>
                  <input type="hidden" name="workspaceId" value={workspaceId} />
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
                    <label>{t("formEmail")} <input type="email" name="email" required /></label>
                    <label>{t("formName")} <input type="text" name="name" /></label>
                    <label>{t("formCompany")} <input type="text" name="company" /></label>
                    <label>{t("formTitle")} <input type="text" name="title" /></label>
                  </div>
                  <button type="submit" style={{ width: "fit-content" }}>{t("btnCreateContact")}</button>
                </form>
              </details>
            </div>

            {contacts.length === 0 ? (
              <p className="muted">{t("noContacts")}</p>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.9rem" }}>
                  <thead>
                    <tr style={{ borderBottom: "2px solid var(--line)", textAlign: "left" }}>
                      <th style={{ padding: "12px 8px" }}>{t("colContact")}</th>
                      <th style={{ padding: "12px 8px" }}>{t("colCompany")}</th>
                      <th style={{ padding: "12px 8px" }}>{t("colSource")}</th>
                      <th style={{ padding: "12px 8px" }}>{t("colCreated")}</th>
                      <th style={{ padding: "12px 8px" }}>{t("colActions")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {contacts.map((contact) => (
                      <tr key={contact.id} style={{ borderBottom: "1px solid var(--line)" }}>
                        <td style={{ padding: "12px 8px" }}>
                          <div style={{ fontWeight: 600, color: "var(--text)" }}>{contact.name || t("unknownContact")}</div>
                          <div className="muted" style={{ fontSize: "0.8rem" }}>{contact.email}</div>
                        </td>
                        <td style={{ padding: "12px 8px" }}>
                          {contact.company || <span className="muted">{t("emptyValue")}</span>}
                        </td>
                        <td style={{ padding: "12px 8px" }}>
                          <span className="tag">{contact.source}</span>
                        </td>
                        <td style={{ padding: "12px 8px" }} className="muted">
                          {new Date(contact.createdAt).toLocaleDateString()}
                        </td>
                        <td style={{ padding: "12px 8px" }}>
                          <details style={{ position: "relative" }}>
                            <summary
                              aria-label={t("titleContactActions")}
                              style={{ cursor: "pointer", color: "var(--accent)", listStyle: "none" }}
                            >
                              {t("btnContactActions")}
                            </summary>
                            <div style={{ position: "absolute", right: 0, top: "100%", background: "white", padding: 8, border: "1px solid var(--line)", borderRadius: 8, zIndex: 10, boxShadow: "var(--shadow-md)" }}>
                              <form action={deleteContactAction}>
                                <input type="hidden" name="workspaceId" value={workspaceId} />
                                <input type="hidden" name="contactId" value={contact.id} />
                                <button type="submit" className="danger small" style={{ width: "100%", whiteSpace: "nowrap" }}>{t("btnDelete")}</button>
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
                  {t("btnNewDeal")}
                </summary>
                <form action={createDealAction} className="stack nr-form-section" style={{ marginTop: 16 }}>
                  <input type="hidden" name="workspaceId" value={workspaceId} />
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
                    <label>
                      {t("formContact")}
                      <select name="contactId" required>
                        <option value="">{t("selectContact")}</option>
                        {contacts.map((c) => <option key={c.id} value={c.id}>{c.name || c.email}</option>)}
                      </select>
                    </label>
                    <label>{t("formDealTitle")} <input type="text" name="title" required /></label>
                    <label>{t("formValue")} <input type="number" name="value" step="0.01" min="0" /></label>
                  </div>
                  <button type="submit" style={{ width: "fit-content" }}>{t("btnCreateDeal")}</button>
                </form>
              </details>
            </div>

            <div style={{ display: "flex", gap: "16px", overflowX: "auto", paddingBottom: "16px" }}>
              {(["LEAD", "QUALIFIED", "PROPOSAL", "NEGOTIATION", "CLOSED_WON", "CLOSED_LOST"] as const).map(stage => (
                <div key={stage} style={{ flex: "0 0 300px", background: "var(--bg-alt)", borderRadius: "12px", padding: "16px" }}>
                  <div style={{ fontWeight: 600, marginBottom: "16px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    {stage === "LEAD" ? t("stageLead") : stage === "QUALIFIED" ? t("stageQualified") : stage === "PROPOSAL" ? t("stageProposal") : stage === "NEGOTIATION" ? t("stageNegotiate") : stage === "CLOSED_WON" ? t("stageWon") : t("stageLost")}
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
            {recentActivities.length === 0 && <p className="muted">{t("noActivity")}</p>}
            {recentActivities.map(activity => (
              <div key={activity.id} className="item" style={{ display: "flex", gap: "16px" }}>
                <div style={{ width: "40px", height: "40px", borderRadius: "50%", background: "var(--accent-soft)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "1.2rem", flexShrink: 0 }}>
                  {activityIcon(activity.type)}
                </div>
                <div>
                  <div className="row" style={{ justifyContent: "flex-start", gap: "8px", marginBottom: "4px" }}>
                    <strong style={{ fontSize: "0.95rem" }}>{activity.title}</strong>
                    <span className="tag">{activityTypeLabel(activity.type)}</span>
                    <span className="muted" style={{ fontSize: "0.8rem", marginLeft: "auto" }}>{ageText(activity.createdAt)}</span>
                  </div>
                  <div style={{ fontSize: "0.85rem", color: "var(--text)", lineHeight: 1.5, marginBottom: "8px" }}>
                    {activity.bodyMd}
                  </div>
                  <div className="row" style={{ fontSize: "0.8rem" }}>
                    {activity.contact && (
                      <span className="muted">{t("activityContact")} <strong>{activity.contact.name || activity.contact.email}</strong></span>
                    )}
                    {activity.deal && (
                      <span className="muted">{t("activityDeal")} <strong>{activity.deal.title}</strong></span>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {view === "review" && (
          <div className="stack">
            {pendingQualifications.length === 0 && <p className="muted">No pending qualifications in queue</p>}
            {pendingQualifications.map(qual => (
              <div key={qual.id} className="item" style={{ padding: 16 }}>
                <div className="row">
                  <strong>{qual.demoLead.email}</strong>
                  <span className="tag">{qual.responseChannel}</span>
                </div>
                <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, fontSize: "0.85rem" }}>
                  {qual.companyName && <div><span className="muted">Company:</span> {qual.companyName}</div>}
                  {qual.website && <div><span className="muted">Website:</span> {qual.website}</div>}
                  {qual.aiExperience && <div style={{ gridColumn: "1 / -1" }}><span className="muted">AI Exp:</span> {qual.aiExperience}</div>}
                  {qual.helpNeeded && <div style={{ gridColumn: "1 / -1" }}><span className="muted">Needs:</span> {qual.helpNeeded}</div>}
                  {qual.rawEmailReply && <div style={{ gridColumn: "1 / -1" }}><span className="muted">Raw Reply:</span> {qual.rawEmailReply}</div>}
                </div>
                <div className="row" style={{ marginTop: 16, justifyContent: "flex-start", gap: 8 }}>
                  <form action={approveQualificationAction}>
                    <input type="hidden" name="workspaceId" value={workspaceId} />
                    <input type="hidden" name="qualificationId" value={qual.id} />
                    <button type="submit" className="small">Approve & Send Demo</button>
                  </form>
                  <form action={rejectQualificationAction}>
                    <input type="hidden" name="workspaceId" value={workspaceId} />
                    <input type="hidden" name="qualificationId" value={qual.id} />
                    <button type="submit" className="danger small">Reject</button>
                  </form>
                </div>
              </div>
            ))}
          </div>
        )}

        {view === "conversations" && (
          <div className="stack">
            {conversations.length === 0 && <p className="muted">No active conversations</p>}
            {conversations.map(conv => (
              <div key={conv.id} className="item" style={{ padding: 16 }}>
                <div className="row">
                  <strong>{conv.subject}</strong>
                  <span className="tag">{conv.status}</span>
                </div>
                <div className="muted" style={{ fontSize: "0.85rem", marginTop: 4 }}>
                  {conv.contact ? (conv.contact.name || conv.contact.email) : conv.demoLead?.email}
                </div>
                {conv.messages && conv.messages[0] && (
                  <div style={{ marginTop: 12, background: "var(--bg-alt)", padding: 12, borderRadius: 8, fontSize: "0.85rem" }}>
                    <strong>{conv.messages[0].senderType === "LEAD" ? "Lead" : "Staff"}</strong>: {conv.messages[0].bodyMd}
                  </div>
                )}
                
                <details style={{ marginTop: 12 }}>
                  <summary className="link-button small" style={{ cursor: "pointer" }}>Reply to Conversation</summary>
                  <form action={createConversationMessageAction} className="stack nr-form-section" style={{ marginTop: 12 }}>
                    <input type="hidden" name="workspaceId" value={workspaceId} />
                    <input type="hidden" name="conversationId" value={conv.id} />
                    <textarea name="bodyMd" required placeholder="Type your reply here..." rows={3} style={{ width: "100%", padding: 8, border: "1px solid var(--line)", borderRadius: 8 }}></textarea>
                    <button type="submit" className="small" style={{ width: "fit-content" }}>Send Reply</button>
                  </form>
                </details>
              </div>
            ))}
          </div>
        )}

        {view === "instances" && (
          <div className="stack">
            <div style={{ marginBottom: "24px", display: "flex", justifyContent: "flex-end" }}>
              <details style={{ width: "100%" }}>
                <summary className="link-button small" style={{ cursor: "pointer", marginLeft: "auto", display: "inline-flex" }}>
                  Provision New Instance
                </summary>
                <form action={provisionProspectWorkspaceAction} className="stack nr-form-section" style={{ marginTop: 16 }}>
                  <input type="hidden" name="workspaceId" value={workspaceId} />
                  <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: "16px" }}>
                    <label>
                      Select Prospect
                      <select name="demoLeadId" required>
                        <option value="">Choose Lead...</option>
                        {contacts.filter((c: any) => c.demoLeadId).map((c: any) => (
                          <option key={c.demoLeadId} value={c.demoLeadId}>{c.name || c.email}</option>
                        ))}
                      </select>
                    </label>
                    <label>Admin Email <input type="email" name="adminEmail" required /></label>
                  </div>
                  <button type="submit" style={{ width: "fit-content" }}>Provision Demo Workspace</button>
                </form>
              </details>
            </div>

            {prospectWorkspaces.length === 0 && <p className="muted">No instances provisioned yet</p>}
            {prospectWorkspaces.map(pw => (
              <div key={pw.id} className="item" style={{ padding: 16 }}>
                <div className="row">
                  <strong>{pw.targetWorkspace?.name || "Demo Workspace"}</strong>
                  <span className="tag" style={{ background: pw.status === "ACTIVE" ? "var(--success)" : "var(--bg-alt)", color: pw.status === "ACTIVE" ? "white" : "inherit" }}>
                    {pw.status}
                  </span>
                </div>
                <div className="muted" style={{ fontSize: "0.85rem", marginTop: 8 }}>
                  <div>Lead: {pw.demoLead?.email}</div>
                  <div>Admin: {pw.adminEmail}</div>
                  <div>Provisioned: {new Date(pw.provisionedAt).toLocaleDateString()}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
