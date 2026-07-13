import { requirePageActor } from "@/lib/auth";
import { requireWorkspaceFeature } from "@/lib/workspace-feature-flags";
import { MarkdownEditor } from "@/lib/components/MarkdownEditor";
import { MarkdownRenderer } from "@/lib/components/MarkdownRenderer";
import {
  listContacts,
  listCrmAccounts,
  listCrmActivities,
  listCommunicationSuggestions,
  listCrmConversations,
  listCrmProspectWorkspaces,
  listDeals,
  listMembers,
  listQualifications,
  requireWorkspaceMembership,
} from "@corgtex/domain";
import { CrmActivityType } from "@prisma/client";
import { getTranslations } from "next-intl/server";
import { ArrowRight, ExternalLink } from "lucide-react";
import { normalizeVisibleWorkItemColumns, toggleWorkItemColumnVisibility } from "@/lib/work-item-view";

import {
  archiveContactAction,
  archiveCrmAccountAction,
  approveQualificationAction,
  completeActivityAction,
  createConversationMessageAction,
  provisionProspectWorkspaceAction,
  rejectQualificationAction,
} from "../actions";
import { CommunicationSuggestionCard } from "./CommunicationSuggestionCard";
import { CrmChatPageContext } from "./CrmChatPageContext";
import { DealPipelineBoard } from "./DealPipelineBoard";
import { RelationshipNav, relationshipNavLabels } from "./RelationshipNav";
import {
  CRM_CHAT_CONTEXT_LIMIT,
  crmAccountContext,
  crmActivityContext,
  crmDealContext,
  crmFilters,
  crmPageMetrics,
  crmSuggestionContext,
} from "./chat-page-context";
import { splitCommunicationSuggestions } from "./communication-suggestions";
import { capDashboardPanelRows } from "./dashboard-panel-rows";
import { sortDashboardDeals, summarizeDashboardAccounts } from "./dashboard-view-model";
import { splitRelationshipReminders } from "./relationship-reminders";
import {
  CRM_DEAL_STAGES,
  CRM_CREATABLE_DEAL_STAGES,
  accountHref,
  activePipelineValueCents,
  labelFromCrmCode,
  normalizeRelationshipView,
  relationshipFullPageHref,
} from "./view-model";

export const dynamic = "force-dynamic";

type CrmActivityContext = {
  account?: { id: string; name: string } | null;
  contact?: { id: string; name?: string | null; email: string } | null;
  deal?: { id: string; title: string } | null;
};

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
  const pipelineReturnQuery = new URLSearchParams({ view: "pipeline" });
  const pipelineColumns = Array.isArray(resolvedSearch.columns) ? resolvedSearch.columns[0] : resolvedSearch.columns;
  if (pipelineColumns) pipelineReturnQuery.set("columns", pipelineColumns);
  const pipelineReturnTo = `/workspaces/${workspaceId}/leads?${pipelineReturnQuery.toString()}`;
  const pipelineStageAddHrefs = Object.fromEntries(CRM_CREATABLE_DEAL_STAGES.map((stage) => [
    stage,
    `/workspaces/${workspaceId}/add?kind=deal&stage=${stage}&returnTo=${encodeURIComponent(pipelineReturnTo)}`,
  ]));

  const [
    accountResult,
    contactResult,
    dealResult,
    activityResult,
    followUpResult,
    communicationSuggestionResult,
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
    listCrmActivities(actor, workspaceId, { type: CrmActivityType.TASK, completion: "open", sort: "due", take: 100 }),
    listCommunicationSuggestions(actor, workspaceId, { take: 100 }),
    listQualifications(actor, workspaceId, { status: "PENDING_REVIEW" }),
    listQualifications(actor, workspaceId, { status: "APPROVED" }),
    listCrmConversations(actor, workspaceId, { take: 30 }),
    listCrmProspectWorkspaces(actor, workspaceId, { take: 30 }),
    listMembers(workspaceId),
  ]);

  const accounts = accountResult.items;
  const contacts = contactResult.items;
  const deals = dealResult.items;
  const recentActivities = activityResult.items as Array<(typeof activityResult.items)[number] & CrmActivityContext>;
  const followUps = followUpResult.items as Array<(typeof followUpResult.items)[number] & CrmActivityContext>;
  const communicationSuggestions = communicationSuggestionResult.items;
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
  const pipelineValue = activePipelineValueCents(activeDeals);
  const reminderSummary = splitRelationshipReminders(followUps);
  const communicationSummary = splitCommunicationSuggestions(communicationSuggestions);
  const memberNames = new Map(members.map((member) => [
    member.user.id,
    member.user.displayName || member.user.email,
  ]));

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

  const dueText = (date?: Date | string | null) => date ? formatDate(date) : t("followUpNoDueDate");
  const ownerText = (ownerUserId?: string | null) => ownerUserId ? memberNames.get(ownerUserId) ?? t("pipelineNoOwner") : t("pipelineNoOwner");

  const viewLabels = relationshipNavLabels(t);
  const fullPageHrefs = {
    accounts: relationshipFullPageHref(workspaceId, "accounts"),
    pipeline: relationshipFullPageHref(workspaceId, "pipeline"),
    activity: relationshipFullPageHref(workspaceId, "activity"),
    suggestions: relationshipFullPageHref(workspaceId, "suggestions"),
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

  const accountLink = (account?: { id: string; name: string; archivedAt?: Date | string | null } | null) => {
    if (!account) return <span className="muted">{t("emptyAccount")}</span>;
    if (account.archivedAt) return <span className="muted">{account.name}</span>;
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

  const communicationStatusLabels = {
    SUGGESTED: t("suggestionStatusSuggested"),
    REQUESTED: t("suggestionStatusRequested"),
    SENT: t("suggestionStatusSent"),
    DECLINED: t("suggestionStatusDeclined"),
    FAILED: t("suggestionStatusFailed"),
  };

  const communicationCardLabels = {
    title: t("formSuggestionTitle"),
    status: communicationStatusLabels,
    recipient: t("formSuggestionRecipient"),
    subject: t("formSuggestionSubject"),
    body: t("formSuggestionBody"),
    source: t("colSource"),
    account: t("pipelineAccount"),
    contact: t("pipelineContact"),
    deal: t("activityDeal"),
    noRecipient: t("suggestionNoRecipient"),
    noSubject: t("suggestionNoSubject"),
    copyDraft: t("suggestionCopyDraft"),
    edit: t("btnEditSuggestion"),
    save: t("btnSaveSuggestion"),
    requestExecution: t("btnRequestExternalExecution"),
    markSent: t("btnMarkSuggestionSent"),
    decline: t("btnDeclineSuggestion"),
    failureReason: t("formFailureReason"),
    fail: t("btnFailSuggestion"),
    requestedAt: t("suggestionRequestedAt"),
    sentAt: t("suggestionSentAt"),
    declinedAt: t("suggestionDeclinedAt"),
    failedAt: t("suggestionFailedAt"),
    externalExecutionNote: t("suggestionExternalExecutionNote"),
  };
  const dashboardAccounts = summarizeDashboardAccounts(accounts, deals, recentActivities);
  const dashboardDeals = sortDashboardDeals(deals);
  const attentionFollowUps = reminderSummary.overdue.slice(0, 3);
  const attentionSuggestions = [...communicationSummary.failed, ...communicationSummary.requested].slice(0, 3);
  const attentionQualifications = pendingQualifications.slice(0, 2);
  const hasAttention = attentionFollowUps.length > 0 || attentionSuggestions.length > 0 || attentionQualifications.length > 0;
  const dashboardAccountRows = capDashboardPanelRows(dashboardAccounts);
  const dashboardDealRows = capDashboardPanelRows(dashboardDeals);
  const dashboardActivityRows = capDashboardPanelRows(recentActivities);
  const dashboardSuggestionRows = capDashboardPanelRows(communicationSummary.open);
  const crmChatPageContext = {
    surface: "crm" as const,
    workspaceId,
    view,
    section: view === "dashboard" ? null : view,
    selectedIds: {},
    filters: crmFilters({ view: view === "dashboard" ? null : view }),
    visibleContext: {
      metrics: crmPageMetrics([
        { label: "accountsLoaded", value: accounts.length },
        { label: "contactsLoaded", value: contacts.length },
        { label: "activeDeals", value: activeDeals.length },
        { label: "pipelineValueCents", value: pipelineValue },
        { label: "openFollowUps", value: reminderSummary.open.length },
        { label: "overdueFollowUps", value: reminderSummary.overdue.length },
        { label: "openCommunicationSuggestions", value: communicationSummary.open.length },
        { label: "pendingQualifications", value: pendingQualifications.length },
      ]),
      accounts: dashboardAccounts
        .slice(0, CRM_CHAT_CONTEXT_LIMIT)
        .map(({ account }) => crmAccountContext(workspaceId, account)),
      deals: dashboardDeals
        .slice(0, CRM_CHAT_CONTEXT_LIMIT)
        .map((deal) => crmDealContext(workspaceId, deal)),
      activities: attentionFollowUps
        .slice(0, CRM_CHAT_CONTEXT_LIMIT)
        .map((activity) => crmActivityContext(workspaceId, activity)),
      suggestions: attentionSuggestions
        .slice(0, CRM_CHAT_CONTEXT_LIMIT)
        .map((suggestion) => crmSuggestionContext(workspaceId, suggestion)),
    },
  };

  return (
    <>
      <CrmChatPageContext context={crmChatPageContext} />
      <header className="nr-masthead nr-crm-masthead">
        <h1>{t("pageTitle")}</h1>
        <div className="nr-masthead-meta">
          <span>{t("pageDescription")}</span>
        </div>
      </header>

      <section className="ws-section">
        <RelationshipNav workspaceId={workspaceId} active={view} labels={viewLabels} />

        {view === "dashboard" && (
          <div className="stack" style={{ gap: 20 }}>
            <div className="ws-stat-row" style={{ marginBottom: 0 }}>
              <div className="ws-stat-card">
                <strong>{accountResult.total}</strong>
                <span>{t("statAccounts")}</span>
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
                <strong>{reminderSummary.open.length}</strong>
                <span>{t("statOpenFollowUps")}</span>
              </div>
            </div>

            <section className="nr-table-wrap" style={{ overflow: "hidden" }}>
              <div className="row" style={{ alignItems: "flex-start", gap: 12, padding: "12px 12px 0" }}>
                <div>
                  <h2 style={{ margin: 0, fontSize: "1.1rem" }}>{t("dashboardAttentionTitle")}</h2>
                  <div className="muted" style={{ fontSize: "0.85rem", marginTop: 4 }}>
                    {t("nextFollowUpsMeta", {
                      overdue: reminderSummary.overdue.length,
                      upcoming: reminderSummary.upcoming.length,
                    })}
                    {" · "}
                    {t("suggestionQueueMeta", {
                      suggested: communicationSummary.suggested.length,
                      requested: communicationSummary.requested.length,
                      failed: communicationSummary.failed.length,
                    })}
                  </div>
                </div>
                <a href={fullPageHrefs.activity} className="nr-icon-link nr-table-action" style={{ marginLeft: "auto" }} aria-label={t("viewActivity")} title={t("viewActivity")}>
                  <ArrowRight size={14} aria-hidden="true" />
                </a>
              </div>
              <table className="nr-table nr-work-item-table" style={{ marginTop: 12 }}>
                <thead>
                  <tr>
                    <th>{t("dashboardAttentionTitle")}</th>
                    <th>{t("colAccount")}</th>
                    <th>{t("colUpdated")}</th>
                    <th className="nr-table-cell-right">{t("colActions")}</th>
                  </tr>
                </thead>
                <tbody>
                  {attentionFollowUps.map((activity) => (
                    <tr key={activity.id}>
                      <td data-label={t("dashboardAttentionTitle")}>
                        <div className="nr-work-item-table-main">
                          <span className="tag-sm">{t("dashboardAttentionFollowUp")}</span>
                          <strong>{activity.title}</strong>
                          <span className="nr-work-item-table-meta">{t("followUpDue", { date: dueText(activity.dueAt) })}</span>
                        </div>
                      </td>
                      <td data-label={t("colAccount")}>{activity.account ? accountLink(activity.account) : t("emptyAccount")}</td>
                      <td data-label={t("colUpdated")} className="muted">{dueText(activity.dueAt)}</td>
                      <td data-label={t("colActions")} className="nr-table-cell-right">
                        <form action={completeActivityAction}>
                          <input type="hidden" name="workspaceId" value={workspaceId} />
                          <input type="hidden" name="activityId" value={activity.id} />
                          <button type="submit" className="small">{t("btnCompleteFollowUp")}</button>
                        </form>
                      </td>
                    </tr>
                  ))}
                  {attentionSuggestions.map((suggestion) => (
                    <tr key={suggestion.id}>
                      <td data-label={t("dashboardAttentionTitle")}>
                        <div className="nr-work-item-table-main">
                          <span className="tag-sm">{t("dashboardAttentionSuggestion")}</span>
                          <strong>{suggestion.title}</strong>
                          <span className="nr-work-item-table-meta">{communicationStatusLabels[suggestion.status as keyof typeof communicationStatusLabels] ?? suggestion.status}</span>
                        </div>
                      </td>
                      <td data-label={t("colAccount")}>{suggestion.account ? accountLink(suggestion.account) : t("emptyAccount")}</td>
                      <td data-label={t("colUpdated")} className="muted">{suggestion.updatedAt ? formatDate(suggestion.updatedAt) : t("emptyValue")}</td>
                      <td data-label={t("colActions")} className="nr-table-cell-right">
                        <a href={fullPageHrefs.suggestions} className="nr-icon-link nr-table-action" aria-label={t("btnReviewSuggestion")} title={t("btnReviewSuggestion")}>
                          <ExternalLink size={15} aria-hidden="true" />
                        </a>
                      </td>
                    </tr>
                  ))}
                  {attentionQualifications.map((qualification) => (
                    <tr key={qualification.id}>
                      <td data-label={t("dashboardAttentionTitle")}>
                        <div className="nr-work-item-table-main">
                          <span className="tag-sm">{t("dashboardAttentionQualification")}</span>
                          <strong>{qualification.companyName || qualification.demoLead.email}</strong>
                          <span className="nr-work-item-table-meta">{qualification.responseChannel}</span>
                        </div>
                      </td>
                      <td data-label={t("colAccount")}>{t("emptyAccount")}</td>
                      <td data-label={t("colUpdated")} className="muted">{formatDate(qualification.createdAt)}</td>
                      <td data-label={t("colActions")} className="nr-table-cell-right">
                        <a href="?view=review" className="nr-icon-link nr-table-action" aria-label={t("dashboardViewReview")} title={t("dashboardViewReview")}>
                          <ExternalLink size={15} aria-hidden="true" />
                        </a>
                      </td>
                    </tr>
                  ))}
                  {!hasAttention && (
                    <tr><td colSpan={4} className="nr-table-cell-center muted">{t("dashboardNoAttention")}</td></tr>
                  )}
                </tbody>
              </table>
            </section>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(420px, 1fr))", gap: 20 }}>
              <section className="nr-table-wrap" style={{ overflow: "hidden" }}>
                <div className="row" style={{ alignItems: "flex-start", gap: 12, padding: "12px 12px 0" }}>
                  <h2 style={{ margin: 0, fontSize: "1.1rem" }}>{t("dashboardAccountSummaryTitle")}</h2>
                  <a href={fullPageHrefs.accounts} className="nr-icon-link nr-table-action" style={{ marginLeft: "auto" }} aria-label={t("dashboardViewAccounts")} title={t("dashboardViewAccounts")}>
                    <ArrowRight size={14} aria-hidden="true" />
                  </a>
                </div>
                <table className="nr-table nr-work-item-table" style={{ marginTop: 12 }}>
                  <thead>
                    <tr>
                      <th>{t("colAccount")}</th>
                      <th>{t("colRelationship")}</th>
                      <th>{t("accountPipeline")}</th>
                      <th className="nr-table-cell-right">{t("colActions")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dashboardAccountRows.map((summary) => {
                      const account = summary.account;
                      return (
                        <tr key={account.id}>
                          <td data-label={t("colAccount")}>
                            <a href={accountHref(workspaceId, account.id)} className="nr-work-item-table-title">{account.name}</a>
                            <div className="nr-work-item-table-meta">{account.domain || t("noDomain")}</div>
                          </td>
                          <td data-label={t("colRelationship")}>
                            <div className="nr-work-item-table-tags">
                              <span className="tag-sm">{relationshipLabel(account.relationshipType)}</span>
                              <span className="tag-sm">{lifecycleLabel(account.lifecycleStage)}</span>
                              <span className="tag-sm">{t("dashboardActiveDealsCount", { count: summary.activeDealCount })}</span>
                            </div>
                          </td>
                          <td data-label={t("accountPipeline")}><strong>{formatCurrency(summary.pipelineValueCents)}</strong></td>
                          <td data-label={t("colActions")} className="nr-table-cell-right">
                            <a href={accountHref(workspaceId, account.id)} className="nr-icon-link nr-table-action" aria-label={t("openDetail")} title={t("openDetail")}>
                              <ExternalLink size={15} aria-hidden="true" />
                            </a>
                          </td>
                        </tr>
                      );
                    })}
                    {dashboardAccountRows.length === 0 && (
                      <tr><td colSpan={4} className="nr-table-cell-center muted">{t("noAccounts")}</td></tr>
                    )}
                  </tbody>
                </table>
              </section>

              <section className="nr-table-wrap" style={{ overflow: "hidden" }}>
                <div className="row" style={{ alignItems: "flex-start", gap: 12, padding: "12px 12px 0" }}>
                  <h2 style={{ margin: 0, fontSize: "1.1rem" }}>{t("dashboardPipelineSummaryTitle")}</h2>
                  <a href={fullPageHrefs.pipeline} className="nr-icon-link nr-table-action" style={{ marginLeft: "auto" }} aria-label={t("dashboardViewPipeline")} title={t("dashboardViewPipeline")}>
                    <ArrowRight size={14} aria-hidden="true" />
                  </a>
                </div>
                <table className="nr-table nr-work-item-table" style={{ marginTop: 12 }}>
                  <thead>
                    <tr>
                      <th>{t("fullPipelineTitle")}</th>
                      <th>{t("colAccount")}</th>
                      <th>{t("dashboardDealValue")}</th>
                      <th className="nr-table-cell-right">{t("colActions")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dashboardDealRows.map((deal) => (
                      <tr key={deal.id}>
                        <td data-label={t("fullPipelineTitle")}>
                          <div className="nr-work-item-table-main">
                            <strong>{deal.title}</strong>
                            <div className="nr-work-item-table-tags">
                              <span className="tag-sm">{stageLabels[deal.stage as keyof typeof stageLabels] ?? labelFromCrmCode(deal.stage)}</span>
                              <span className="tag-sm">{t("pipelineOwner")}: {ownerText(deal.ownerUserId)}</span>
                            </div>
                          </div>
                        </td>
                        <td data-label={t("colAccount")}>{deal.account ? accountLink(deal.account) : t("emptyAccount")}</td>
                        <td data-label={t("dashboardDealValue")}><strong>{formatCurrency(deal.valueCents ?? 0)}</strong></td>
                        <td data-label={t("colActions")} className="nr-table-cell-right">
                          {deal.account ? (
                            <a href={accountHref(workspaceId, deal.account.id)} className="nr-icon-link nr-table-action" aria-label={t("openDetail")} title={t("openDetail")}>
                              <ExternalLink size={15} aria-hidden="true" />
                            </a>
                          ) : (
                            <a href={fullPageHrefs.pipeline} className="nr-icon-link nr-table-action" aria-label={t("dashboardViewPipeline")} title={t("dashboardViewPipeline")}>
                              <ExternalLink size={15} aria-hidden="true" />
                            </a>
                          )}
                        </td>
                      </tr>
                    ))}
                    {dashboardDealRows.length === 0 && (
                      <tr><td colSpan={4} className="nr-table-cell-center muted">{t("dashboardNoPipeline")}</td></tr>
                    )}
                  </tbody>
                </table>
              </section>

              <section className="nr-table-wrap" style={{ overflow: "hidden" }}>
                <div className="row" style={{ alignItems: "flex-start", gap: 12, padding: "12px 12px 0" }}>
                  <h2 style={{ margin: 0, fontSize: "1.1rem" }}>{t("fullActivityTitle")}</h2>
                  <a href={fullPageHrefs.activity} className="nr-icon-link nr-table-action" style={{ marginLeft: "auto" }} aria-label={t("viewActivity")} title={t("viewActivity")}>
                    <ArrowRight size={14} aria-hidden="true" />
                  </a>
                </div>
                <table className="nr-table nr-work-item-table" style={{ marginTop: 12 }}>
                  <thead>
                    <tr>
                      <th>{t("fullActivityTitle")}</th>
                      <th>{t("colAccount")}</th>
                      <th>{t("colUpdated")}</th>
                      <th className="nr-table-cell-right">{t("colActions")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dashboardActivityRows.map((activity) => (
                      <tr key={activity.id}>
                        <td data-label={t("fullActivityTitle")}>
                          <div className="nr-work-item-table-main">
                            <strong>{activity.title}</strong>
                            <div className="nr-work-item-table-tags">
                              <span className="tag-sm">{activityTypeLabel(activity.type)}</span>
                              {activity.dueAt && <span className="tag-sm">{t("followUpDue", { date: formatDate(activity.dueAt) })}</span>}
                            </div>
                          </div>
                        </td>
                        <td data-label={t("colAccount")}>{activity.account ? accountLink(activity.account) : t("emptyAccount")}</td>
                        <td data-label={t("colUpdated")} className="muted">{ageText(activity.createdAt)}</td>
                        <td data-label={t("colActions")} className="nr-table-cell-right">
                          {activity.account ? (
                            <a href={accountHref(workspaceId, activity.account.id)} className="nr-icon-link nr-table-action" aria-label={t("openDetail")} title={t("openDetail")}>
                              <ExternalLink size={15} aria-hidden="true" />
                            </a>
                          ) : (
                            <a href={fullPageHrefs.activity} className="nr-icon-link nr-table-action" aria-label={t("viewActivity")} title={t("viewActivity")}>
                              <ExternalLink size={15} aria-hidden="true" />
                            </a>
                          )}
                        </td>
                      </tr>
                    ))}
                    {dashboardActivityRows.length === 0 && (
                      <tr><td colSpan={4} className="nr-table-cell-center muted">{t("noActivity")}</td></tr>
                    )}
                  </tbody>
                </table>
              </section>

              <section className="nr-table-wrap" style={{ overflow: "hidden" }}>
                <div className="row" style={{ alignItems: "flex-start", gap: 12, padding: "12px 12px 0" }}>
                  <h2 style={{ margin: 0, fontSize: "1.1rem" }}>{t("dashboardSuggestionSummaryTitle")}</h2>
                  <a href={fullPageHrefs.suggestions} className="nr-icon-link nr-table-action" style={{ marginLeft: "auto" }} aria-label={t("viewSuggestions")} title={t("viewSuggestions")}>
                    <ArrowRight size={14} aria-hidden="true" />
                  </a>
                </div>
                <table className="nr-table nr-work-item-table" style={{ marginTop: 12 }}>
                  <thead>
                    <tr>
                      <th>{t("dashboardSuggestionSummaryTitle")}</th>
                      <th>{t("colAccount")}</th>
                      <th>{t("formSuggestionRecipient")}</th>
                      <th className="nr-table-cell-right">{t("colActions")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dashboardSuggestionRows.map((suggestion) => (
                      <tr key={suggestion.id}>
                        <td data-label={t("dashboardSuggestionSummaryTitle")}>
                          <div className="nr-work-item-table-main">
                            <strong>{suggestion.title}</strong>
                            <span className="tag-sm">{communicationStatusLabels[suggestion.status as keyof typeof communicationStatusLabels] ?? suggestion.status}</span>
                          </div>
                        </td>
                        <td data-label={t("colAccount")}>{suggestion.account ? accountLink(suggestion.account) : t("emptyAccount")}</td>
                        <td data-label={t("formSuggestionRecipient")} className="muted">{suggestion.recipientEmail || suggestion.contact?.email || t("suggestionNoRecipient")}</td>
                        <td data-label={t("colActions")} className="nr-table-cell-right">
                          <a href={fullPageHrefs.suggestions} className="nr-icon-link nr-table-action" aria-label={t("btnReviewSuggestion")} title={t("btnReviewSuggestion")}>
                            <ExternalLink size={15} aria-hidden="true" />
                          </a>
                        </td>
                      </tr>
                    ))}
                    {dashboardSuggestionRows.length === 0 && (
                      <tr><td colSpan={4} className="nr-table-cell-center muted">{t("noOpenSuggestions")}</td></tr>
                    )}
                  </tbody>
                </table>
              </section>
            </div>
          </div>
        )}

        {view === "accounts" && (
          <div>
            {accounts.length === 0 ? (
              <p className="muted">{t("noAccounts")}</p>
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 16 }}>
                {accounts.map((account) => {
                  const accountDeals = dealsByAccountId.get(account.id) ?? [];
                  const accountPipelineValue = activePipelineValueCents(accountDeals);
                  const lastActivity = lastActivityByAccountId.get(account.id);
                  return (
                    <div
                      key={account.id}
                      className="item"
                      style={{ display: "grid", gap: 12, borderRadius: 8 }}
                    >
                      <div className="row" style={{ alignItems: "flex-start", gap: 12 }}>
                        <div>
                          <a href={accountHref(workspaceId, account.id)} className="nr-work-item-table-title">{account.name}</a>
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
                      <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
                        <a href={accountHref(workspaceId, account.id)} className="link-button small">{t("openDetail")}</a>
                        <form action={archiveCrmAccountAction}>
                          <input type="hidden" name="workspaceId" value={workspaceId} />
                          <input type="hidden" name="accountId" value={account.id} />
                          <button type="submit" className="danger small">{t("btnArchiveAccount")}</button>
                        </form>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {view === "contacts" && (
          <div>
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
                              <form action={archiveContactAction}>
                                <input type="hidden" name="workspaceId" value={workspaceId} />
                                <input type="hidden" name="contactId" value={contact.id} />
                                <button type="submit" className="danger small" style={{ width: "100%", whiteSpace: "nowrap" }}>{t("btnArchiveContact")}</button>
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
            <DealPipelineBoard
              workspaceId={workspaceId}
              deals={deals}
              members={members}
              locale={locale}
              stageLabels={stageLabels}
              visibleColumnIds={visiblePipelineColumnIds}
              hideColumnHrefs={pipelineColumnHideHrefs}
              addStageHrefs={pipelineStageAddHrefs}
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

        {view === "suggestions" && (
          <div className="stack">
            {communicationSummary.all.length === 0 ? (
              <p className="muted">{t("noSuggestions")}</p>
            ) : communicationSummary.all.map((suggestion) => (
              <CommunicationSuggestionCard
                key={suggestion.id}
                workspaceId={workspaceId}
                suggestion={suggestion}
                labels={communicationCardLabels}
                formatDate={formatDate}
              />
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
