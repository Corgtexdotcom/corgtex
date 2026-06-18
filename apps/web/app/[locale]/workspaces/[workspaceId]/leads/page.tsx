import { requirePageActor } from "@/lib/auth";
import { requireWorkspaceFeature } from "@/lib/workspace-feature-flags";
import { MarkdownEditor } from "@/lib/components/MarkdownEditor";
import { MarkdownRenderer } from "@/lib/components/MarkdownRenderer";
import {
  listContacts,
  listCrmAccounts,
  listCrmActivities,
  listCrmConversations,
  listCrmProspectWorkspaces,
  listDeals,
  listMembers,
  listQualifications,
  requireWorkspaceMembership,
} from "@corgtex/domain";
import { getTranslations } from "next-intl/server";
import { normalizeVisibleWorkItemColumns, toggleWorkItemColumnVisibility } from "@/lib/work-item-view";

import {
  approveQualificationAction,
  createContactAction,
  createConversationMessageAction,
  createCrmAccountAction,
  createDealAction,
  deleteContactAction,
  provisionProspectWorkspaceAction,
  rejectQualificationAction,
} from "../actions";
import { DealPipelineBoard } from "./DealPipelineBoard";
import {
  CRM_DEAL_STAGES,
  CRM_LIFECYCLE_OPTIONS,
  CRM_RELATIONSHIP_OPTIONS,
  accountHref,
  activePipelineValueCents,
  labelFromCrmCode,
  normalizeRelationshipView,
} from "./view-model";

export const dynamic = "force-dynamic";

export default async function LeadsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; workspaceId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale, workspaceId } = await params;
  await requireWorkspaceFeature(workspaceId, "RELATIONSHIPS");
  const actor = await requirePageActor();
  await requireWorkspaceMembership({ actor, workspaceId });
  const t = await getTranslations("leads");
  const tWork = await getTranslations("workItems");

  const resolvedSearch = searchParams ? await searchParams : {};
  const view = normalizeRelationshipView(resolvedSearch.view);
  const visiblePipelineColumnIds = normalizeVisibleWorkItemColumns(resolvedSearch.columns, CRM_DEAL_STAGES);
  const pipelineColumnHideHrefs = Object.fromEntries(CRM_DEAL_STAGES.map((stage) => {
    const nextColumns = toggleWorkItemColumnVisibility(visiblePipelineColumnIds, stage, CRM_DEAL_STAGES);
    const query = new URLSearchParams({ view: "pipeline" });
    if (nextColumns) query.set("columns", nextColumns.join(","));
    return [stage, `?${query.toString()}`];
  }));

  const [
    accountResult,
    contactResult,
    dealResult,
    activityResult,
    pendingQualificationResult,
    approvedQualificationResult,
    conversationResult,
    prospectWorkspaceResult,
    members,
  ] = await Promise.all([
    listCrmAccounts(actor, workspaceId, { take: 100 }),
    listContacts(actor, workspaceId, { take: 100 }),
    listDeals(actor, workspaceId, { take: 100 }),
    listCrmActivities(actor, workspaceId, { take: 20 }),
    listQualifications(actor, workspaceId, { status: "PENDING_REVIEW" }),
    listQualifications(actor, workspaceId, { status: "APPROVED" }),
    listCrmConversations(actor, workspaceId, { take: 30 }),
    listCrmProspectWorkspaces(actor, workspaceId, { take: 30 }),
    listMembers(workspaceId),
  ]);

  const accounts = accountResult.items;
  const contacts = contactResult.items;
  const deals = dealResult.items;
  const recentActivities = activityResult.items;
  const pendingQualifications = pendingQualificationResult.items;
  const approvedQualifications = approvedQualificationResult.items;
  const conversations = conversationResult.items;
  const prospectWorkspaces = prospectWorkspaceResult.items;

  const dealsByAccountId = deals.reduce((acc, deal) => {
    if (!deal.accountId) return acc;
    acc.set(deal.accountId, [...(acc.get(deal.accountId) ?? []), deal]);
    return acc;
  }, new Map<string, typeof deals>());

  const lastActivityByAccountId = new Map<string, (typeof recentActivities)[number]>();
  for (const activity of recentActivities) {
    if (activity.accountId && !lastActivityByAccountId.has(activity.accountId)) {
      lastActivityByAccountId.set(activity.accountId, activity);
    }
  }

  const activeDeals = deals.filter((deal) => deal.stage !== "CLOSED_WON" && deal.stage !== "CLOSED_LOST");
  const closedWon = deals.filter((deal) => deal.stage === "CLOSED_WON");
  const pipelineValue = activePipelineValueCents(activeDeals);

  const formatCurrency = (cents: number) => {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0,
    }).format(cents / 100);
  };

  const formatDate = (value: Date | string) => new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));

  const ageText = (date: Date | string) => {
    const days = Math.floor((Date.now() - new Date(date).getTime()) / (1000 * 60 * 60 * 24));
    if (days <= 0) return t("ageToday");
    if (days === 1) return t("ageYesterday");
    return t("ageDaysAgo", { days });
  };

  const viewLabels = {
    accounts: t("tabAccounts"),
    contacts: t("tabContacts"),
    pipeline: t("tabPipeline"),
    activity: t("tabActivity"),
    review: t("tabReview"),
    conversations: t("tabConversations"),
    instances: t("tabInstances"),
  };

  const stageLabels = {
    LEAD: t("stageLead"),
    QUALIFIED: t("stageQualified"),
    PROPOSAL: t("stageProposal"),
    NEGOTIATION: t("stageNegotiate"),
    CLOSED_WON: t("stageWon"),
    CLOSED_LOST: t("stageLost"),
  };

  const relationshipLabelKeys: Record<string, string> = {
    PROSPECT: "relationshipProspect",
    PILOT: "relationshipPilot",
    CLIENT: "relationshipClient",
    PARTNER: "relationshipPartner",
    VENDOR: "relationshipVendor",
    INVESTOR: "relationshipInvestor",
    INTERNAL: "relationshipInternal",
  };

  const lifecycleLabelKeys: Record<string, string> = {
    DISCOVERY: "lifecycleDiscovery",
    QUALIFIED: "lifecycleQualified",
    PILOT: "lifecyclePilot",
    ACTIVE: "lifecycleActive",
    EXPANSION: "lifecycleExpansion",
    PAUSED: "lifecyclePaused",
    CHURNED: "lifecycleChurned",
  };

  const relationshipLabel = (value?: string | null) => {
    if (!value) return t("emptyValue");
    const key = relationshipLabelKeys[value];
    return key ? t(key) : labelFromCrmCode(value);
  };

  const lifecycleLabel = (value?: string | null) => {
    if (!value) return t("emptyValue");
    const key = lifecycleLabelKeys[value];
    return key ? t(key) : labelFromCrmCode(value);
  };

  const accountLink = (account?: { id: string; name: string } | null) => {
    if (!account) return <span className="muted">{t("emptyAccount")}</span>;
    return <a href={accountHref(workspaceId, account.id)}>{account.name}</a>;
  };

  const activityIcon = (type: string) => {
    const labels: Record<string, string> = {
      EMAIL: t("activityIconEmail"),
      MEETING: t("activityIconMeeting"),
      CALL: t("activityIconCall"),
      NOTE: t("activityIconNote"),
      TASK: t("activityIconTask"),
    };
    return labels[type] ?? t("activityIconDefault");
  };

  const activityTypeLabel = (type: string) => {
    const labels: Record<string, string> = {
      EMAIL: t("activityTypeEmail"),
      MEETING: t("activityTypeMeeting"),
      CALL: t("activityTypeCall"),
      NOTE: t("activityTypeNote"),
      TASK: t("activityTypeTask"),
    };
    return labels[type] ?? labelFromCrmCode(type);
  };

  return (
    <>
      <header className="nr-masthead" style={{ textAlign: "left", marginBottom: 32 }}>
        <h1 style={{ border: "none", padding: 0, margin: 0, fontSize: "2rem" }}>{t("pageTitle")}</h1>
        <div className="nr-masthead-meta">
          <span>{t("pageDescription")}</span>
        </div>
      </header>

      <section className="ws-section">
        <div className="ws-stat-row">
          <div className="ws-stat-card">
            <strong>{accountResult.total}</strong>
            <span>{t("statAccounts")}</span>
          </div>
          <div className="ws-stat-card">
            <strong>{contactResult.total}</strong>
            <span>{t("statTotalContacts")}</span>
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
          {Object.entries(viewLabels).map(([key, label]) => (
            <a
              key={key}
              href={`?view=${key}`}
              className={`nr-filter-item ${view === key ? "nr-filter-active" : ""}`}
            >
              {label}
            </a>
          ))}
        </div>

        {view === "accounts" && (
          <div>
            <div style={{ marginBottom: 24, display: "flex", justifyContent: "flex-end" }}>
              <details style={{ width: "100%" }}>
                <summary className="link-button small" style={{ cursor: "pointer", marginLeft: "auto", display: "inline-flex" }}>
                  {t("btnNewAccount")}
                </summary>
                <form action={createCrmAccountAction} className="stack nr-form-section" style={{ marginTop: 16 }}>
                  <input type="hidden" name="workspaceId" value={workspaceId} />
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 16 }}>
                    <label>{t("formAccountName")} <input type="text" name="name" required /></label>
                    <label>{t("formDomain")} <input type="text" name="domain" placeholder={t("formDomainPlaceholder")} /></label>
                    <label>
                      {t("formRelationshipType")}
                      <select name="relationshipType" defaultValue="PROSPECT">
                        {CRM_RELATIONSHIP_OPTIONS.map((option) => (
                          <option key={option} value={option}>{relationshipLabel(option)}</option>
                        ))}
                      </select>
                    </label>
                    <label>
                      {t("formLifecycleStage")}
                      <select name="lifecycleStage" defaultValue="DISCOVERY">
                        {CRM_LIFECYCLE_OPTIONS.map((option) => (
                          <option key={option} value={option}>{lifecycleLabel(option)}</option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <label>
                    {t("formDescription")}
                    <MarkdownEditor name="descriptionMd" placeholder={t("formDescriptionPlaceholder")} rows={3} />
                  </label>
                  <button type="submit" style={{ width: "fit-content" }}>{t("btnCreateAccount")}</button>
                </form>
              </details>
            </div>

            {accounts.length === 0 ? (
              <p className="muted">{t("noAccounts")}</p>
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 16 }}>
                {accounts.map((account) => {
                  const accountDeals = dealsByAccountId.get(account.id) ?? [];
                  const accountPipelineValue = activePipelineValueCents(accountDeals);
                  const lastActivity = lastActivityByAccountId.get(account.id);
                  return (
                    <a
                      key={account.id}
                      href={accountHref(workspaceId, account.id)}
                      className="item nr-clickable-card"
                      style={{ display: "grid", gap: 12, color: "inherit", textDecoration: "none", borderRadius: 8 }}
                    >
                      <div className="row" style={{ alignItems: "flex-start", gap: 12 }}>
                        <div>
                          <strong style={{ fontSize: "1rem" }}>{account.name}</strong>
                          <div className="muted" style={{ fontSize: "0.82rem", marginTop: 4 }}>
                            {account.domain || t("noDomain")}
                          </div>
                        </div>
                        <span className="tag" style={{ marginLeft: "auto" }}>{relationshipLabel(account.relationshipType)}</span>
                      </div>
                      <div className="nr-tag-group">
                        <span className="tag-sm">{lifecycleLabel(account.lifecycleStage)}</span>
                        <span className="tag-sm">{t("accountContactsCount", { count: account._count.contacts })}</span>
                        <span className="tag-sm">{t("accountDealsCount", { count: account._count.deals })}</span>
                      </div>
                      <div className="row" style={{ fontSize: "0.85rem", alignItems: "baseline" }}>
                        <span className="muted">{t("accountPipeline")}</span>
                        <strong>{formatCurrency(accountPipelineValue)}</strong>
                      </div>
                      <div className="muted" style={{ fontSize: "0.8rem" }}>
                        {lastActivity
                          ? t("accountLastActivity", { title: lastActivity.title, age: ageText(lastActivity.createdAt) })
                          : t("accountNoActivity")}
                      </div>
                    </a>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {view === "contacts" && (
          <div>
            <div style={{ marginBottom: 24, display: "flex", justifyContent: "flex-end" }}>
              <details style={{ width: "100%" }}>
                <summary className="link-button small" style={{ cursor: "pointer", marginLeft: "auto", display: "inline-flex" }}>
                  {t("btnNewContact")}
                </summary>
                <form action={createContactAction} className="stack nr-form-section" style={{ marginTop: 16 }}>
                  <input type="hidden" name="workspaceId" value={workspaceId} />
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 16 }}>
                    <label>
                      {t("formAccount")}
                      <select name="accountId" defaultValue="">
                        <option value="">{t("selectAccountOptional")}</option>
                        {accounts.map((account) => (
                          <option key={account.id} value={account.id}>{account.name}</option>
                        ))}
                      </select>
                    </label>
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
                      <th style={{ padding: "12px 8px" }}>{t("colAccount")}</th>
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
                          {contact.account ? accountLink(contact.account) : (contact.company || <span className="muted">{t("emptyAccount")}</span>)}
                        </td>
                        <td style={{ padding: "12px 8px" }}>
                          <span className="tag">{contact.source}</span>
                        </td>
                        <td style={{ padding: "12px 8px" }} className="muted">
                          {formatDate(contact.createdAt)}
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
            <div style={{ marginBottom: 24, display: "flex", justifyContent: "flex-end" }}>
              <details style={{ width: "100%" }}>
                <summary className="link-button small" style={{ cursor: "pointer", marginLeft: "auto", display: "inline-flex" }}>
                  {t("btnNewDeal")}
                </summary>
                <form action={createDealAction} className="stack nr-form-section" style={{ marginTop: 16 }}>
                  <input type="hidden" name="workspaceId" value={workspaceId} />
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 16 }}>
                    <label>
                      {t("formContact")}
                      <select name="contactId" required>
                        <option value="">{t("selectContact")}</option>
                        {contacts.map((contact) => (
                          <option key={contact.id} value={contact.id}>
                            {contact.name || contact.email}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>{t("formDealTitle")} <input type="text" name="title" required /></label>
                    <label>{t("formValue")} <input type="number" name="value" step="0.01" min="0" /></label>
                    <label>
                      {t("formOwner")}
                      <select name="ownerUserId" defaultValue="">
                        <option value="">{t("selectOwnerOptional")}</option>
                        {members.map((member) => (
                          <option key={member.user.id} value={member.user.id}>
                            {member.user.displayName || member.user.email}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <button type="submit" style={{ width: "fit-content" }}>{t("btnCreateDeal")}</button>
                </form>
              </details>
            </div>

            <DealPipelineBoard
              workspaceId={workspaceId}
              deals={deals}
              members={members}
              locale={locale}
              stageLabels={stageLabels}
              visibleColumnIds={visiblePipelineColumnIds}
              hideColumnHrefs={pipelineColumnHideHrefs}
              storageKey={`relationships:${workspaceId}:pipeline`}
              labels={{
                account: t("pipelineAccount"),
                contact: t("pipelineContact"),
                emptyStage: t("pipelineNoDealsInStage"),
                noAccount: t("emptyAccount"),
                nextFollowUp: t("pipelineNextFollowUp"),
                noNextFollowUp: t("pipelineNoNextFollowUp"),
                owner: t("pipelineOwner"),
                noOwner: t("pipelineNoOwner"),
                stageAgeToday: t("pipelineStageAgeToday"),
                stageAgeYesterday: t("pipelineStageAgeYesterday"),
                stageAgeDays: (days) => t("pipelineStageAgeDays", { days }),
              }}
              workItemLabels={{
                settingsLabel: tWork("columnSettings"),
                resetLabel: tWork("resetColumns"),
                hideLabel: tWork("hideColumn"),
                moveUpLabel: tWork("moveColumnLeft"),
                moveDownLabel: tWork("moveColumnRight"),
                hideShortLabel: tWork("hideColumnShort"),
                moveUpShortLabel: tWork("moveColumnLeftShort"),
                moveDownShortLabel: tWork("moveColumnRightShort"),
                sortLabel: tWork("sort"),
                sortPriorityLabel: tWork("sortPriority"),
                sortDateLabel: tWork("sortDate"),
                sortAlphaLabel: tWork("sortAlpha"),
                dragUnavailableLabel: tWork("dragUnavailable"),
              }}
            />
          </div>
        )}

        {view === "activity" && (
          <div className="stack">
            {recentActivities.length === 0 && <p className="muted">{t("noActivity")}</p>}
            {recentActivities.map((activity) => (
              <div key={activity.id} className="item" style={{ display: "flex", gap: 16 }}>
                <div style={{ width: 40, height: 40, borderRadius: "50%", background: "var(--accent-soft)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "1.2rem", flexShrink: 0 }}>
                  {activityIcon(activity.type)}
                </div>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="row" style={{ justifyContent: "flex-start", gap: 8, marginBottom: 4 }}>
                    <strong style={{ fontSize: "0.95rem" }}>{activity.title}</strong>
                    <span className="tag">{activityTypeLabel(activity.type)}</span>
                    <span className="muted" style={{ fontSize: "0.8rem", marginLeft: "auto" }}>{ageText(activity.createdAt)}</span>
                  </div>
                  {activity.bodyMd && <MarkdownRenderer markdown={activity.bodyMd} variant="compact" />}
                  <div className="row" style={{ fontSize: "0.8rem", justifyContent: "flex-start", gap: 12 }}>
                    <span className="muted">{t("activityAccount")} <strong>{accountLink(activity.account)}</strong></span>
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
            {pendingQualifications.length === 0 && <p className="muted">{t("noPendingQualifications")}</p>}
            {pendingQualifications.map((qualification) => (
              <div key={qualification.id} className="item" style={{ padding: 16 }}>
                <div className="row">
                  <strong>{qualification.demoLead.email}</strong>
                  <span className="tag">{qualification.responseChannel}</span>
                </div>
                <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 16, fontSize: "0.85rem" }}>
                  {qualification.companyName && <div><span className="muted">{t("reviewCompany")}</span> {qualification.companyName}</div>}
                  {qualification.website && <div><span className="muted">{t("reviewWebsite")}</span> {qualification.website}</div>}
                  {qualification.aiExperience && <div style={{ gridColumn: "1 / -1" }}><span className="muted">{t("reviewAiExperience")}</span> {qualification.aiExperience}</div>}
                  {qualification.helpNeeded && <div style={{ gridColumn: "1 / -1" }}><span className="muted">{t("reviewNeeds")}</span> {qualification.helpNeeded}</div>}
                  {qualification.rawEmailReply && <div style={{ gridColumn: "1 / -1" }}><span className="muted">{t("reviewRawReply")}</span> {qualification.rawEmailReply}</div>}
                </div>
                <div className="row" style={{ marginTop: 16, justifyContent: "flex-start", gap: 8 }}>
                  <form action={approveQualificationAction}>
                    <input type="hidden" name="workspaceId" value={workspaceId} />
                    <input type="hidden" name="qualificationId" value={qualification.id} />
                    <button type="submit" className="small">{t("btnApproveQualification")}</button>
                  </form>
                  <form action={rejectQualificationAction}>
                    <input type="hidden" name="workspaceId" value={workspaceId} />
                    <input type="hidden" name="qualificationId" value={qualification.id} />
                    <button type="submit" className="danger small">{t("btnRejectQualification")}</button>
                  </form>
                </div>
              </div>
            ))}
          </div>
        )}

        {view === "conversations" && (
          <div className="stack">
            {conversations.length === 0 && <p className="muted">{t("noConversations")}</p>}
            {conversations.map((conversation) => (
              <div key={conversation.id} className="item" style={{ padding: 16 }}>
                <div className="row">
                  <strong>{conversation.subject || t("untitledConversation")}</strong>
                  <span className="tag">{conversation.status}</span>
                </div>
                <div className="muted" style={{ fontSize: "0.85rem", marginTop: 4 }}>
                  {accountLink(conversation.account)}
                  {" · "}
                  {conversation.contact ? (conversation.contact.name || conversation.contact.email) : conversation.demoLead?.email}
                </div>
                {conversation.messages && conversation.messages[0] && (
                  <div style={{ marginTop: 12, background: "var(--bg-alt)", padding: 12, borderRadius: 8, fontSize: "0.85rem" }}>
                    <strong>{conversation.messages[0].senderType === "LEAD" ? t("senderLead") : t("senderStaff")}</strong>
                    <MarkdownRenderer markdown={conversation.messages[0].bodyMd} variant="compact" />
                  </div>
                )}

                <details style={{ marginTop: 12 }}>
                  <summary className="link-button small" style={{ cursor: "pointer" }}>{t("btnReplyConversation")}</summary>
                  <form action={createConversationMessageAction} className="stack nr-form-section" style={{ marginTop: 12 }}>
                    <input type="hidden" name="workspaceId" value={workspaceId} />
                    <input type="hidden" name="conversationId" value={conversation.id} />
                    <MarkdownEditor name="bodyMd" required placeholder={t("formReplyPlaceholder")} rows={3} />
                    <button type="submit" className="small" style={{ width: "fit-content" }}>{t("btnSendReply")}</button>
                  </form>
                </details>
              </div>
            ))}
          </div>
        )}

        {view === "instances" && (
          <div className="stack">
            <div style={{ marginBottom: 24, display: "flex", justifyContent: "flex-end" }}>
              <details style={{ width: "100%" }}>
                <summary className="link-button small" style={{ cursor: "pointer", marginLeft: "auto", display: "inline-flex" }}>
                  {t("btnProvisionInstance")}
                </summary>
                <form action={provisionProspectWorkspaceAction} className="stack nr-form-section" style={{ marginTop: 16 }}>
                  <input type="hidden" name="workspaceId" value={workspaceId} />
                  <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 16 }}>
                    <label>
                      {t("formProspect")}
                      <select name="demoLeadId" required>
                        <option value="">{t("selectLead")}</option>
                        {approvedQualifications.map((qualification) => (
                          <option key={qualification.demoLeadId} value={qualification.demoLeadId}>
                            {qualification.companyName || qualification.demoLead?.email || t("unknownLead")}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>{t("formAdminEmail")} <input type="email" name="adminEmail" required /></label>
                  </div>
                  <button type="submit" style={{ width: "fit-content" }}>{t("btnProvisionWorkspace")}</button>
                </form>
              </details>
            </div>

            {prospectWorkspaces.length === 0 && <p className="muted">{t("noInstances")}</p>}
            {prospectWorkspaces.map((prospectWorkspace) => (
              <div key={prospectWorkspace.id} className="item" style={{ padding: 16 }}>
                <div className="row">
                  <strong>{prospectWorkspace.targetWorkspace?.name || t("demoWorkspace")}</strong>
                  <span className="tag" style={{ background: prospectWorkspace.status === "ACTIVE" ? "var(--success)" : "var(--bg-alt)", color: prospectWorkspace.status === "ACTIVE" ? "white" : "inherit" }}>
                    {prospectWorkspace.status}
                  </span>
                </div>
                <div className="muted" style={{ fontSize: "0.85rem", marginTop: 8 }}>
                  <div>{t("instanceAccount")} {accountLink(prospectWorkspace.account)}</div>
                  <div>{t("instanceLead")} {prospectWorkspace.demoLead?.email}</div>
                  <div>{t("instanceAdmin")} {prospectWorkspace.adminEmail}</div>
                  <div>{t("instanceProvisioned")} {formatDate(prospectWorkspace.provisionedAt)}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
