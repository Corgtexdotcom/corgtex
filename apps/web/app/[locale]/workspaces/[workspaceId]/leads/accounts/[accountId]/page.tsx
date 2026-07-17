import { requirePageActor } from "@/lib/auth";
import { isWorkspaceFeatureEnabled, requireWorkspaceFeature } from "@/lib/workspace-feature-flags";
import { MarkdownEditor } from "@/lib/components/MarkdownEditor";
import { MarkdownRenderer } from "@/lib/components/MarkdownRenderer";
import { normalizeVisibleWorkItemColumns, toggleWorkItemColumnVisibility } from "@/lib/work-item-view";
import { canManagePracticeFinanceProjects, getCrmAccount, getCrmAccountPracticeFinance, listCommunicationSuggestions, listMembers, requireWorkspaceMembership } from "@corgtex/domain";
import { getTranslations } from "next-intl/server";

import {
  archiveContactAction,
  archiveCrmAccountAction,
  completeActivityAction,
  createFinanceProjectFromDealAction,
  convertCrmAccountToClientAction,
  updateCrmAccountAction,
} from "../../actions";
import { CrmChatPageContext } from "../../CrmChatPageContext";
import {
  CRM_CHAT_CONTEXT_LIMIT,
  crmAccountContext,
  crmActivityContext,
  crmContactContext,
  crmDealContext,
  crmFilters,
  crmPageMetrics,
  crmSuggestionContext,
} from "../../chat-page-context";
import {
  ACCOUNT_DETAIL_VIEWS,
  CRM_CREATABLE_DEAL_STAGES,
  CRM_LIFECYCLE_OPTIONS,
  CRM_RELATIONSHIP_OPTIONS,
  activePipelineValueCents,
  labelFromCrmCode,
  normalizeAccountDetailView,
  CRM_DEAL_STAGES,
} from "../../view-model";
import { DealPipelineBoard } from "../../DealPipelineBoard";
import { CommunicationSuggestionCard } from "../../CommunicationSuggestionCard";
import { splitCommunicationSuggestions } from "../../communication-suggestions";
import { splitRelationshipReminders } from "../../relationship-reminders";

export const dynamic = "force-dynamic";

type AccountActivityContext = {
  contact?: { id: string; name?: string | null; email: string } | null;
  deal?: { id: string; title: string } | null;
};

export default async function AccountDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; workspaceId: string; accountId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale, workspaceId, accountId } = await params;
  await requireWorkspaceFeature(workspaceId, "RELATIONSHIPS");
  const actor = await requirePageActor();
  const membership = await requireWorkspaceMembership({ actor, workspaceId });
  const t = await getTranslations("leads");
  const tWork = await getTranslations("workItems");
  const resolvedSearch = searchParams ? await searchParams : {};
  const view = normalizeAccountDetailView(resolvedSearch.view);
  const visiblePipelineColumnIds = normalizeVisibleWorkItemColumns(resolvedSearch.columns, CRM_DEAL_STAGES);
  const pipelineColumnHideHrefs = Object.fromEntries(CRM_DEAL_STAGES.map((stage) => {
    const nextColumns = toggleWorkItemColumnVisibility(visiblePipelineColumnIds, stage, CRM_DEAL_STAGES);
    const query = new URLSearchParams({ view: "pipeline" });
    if (nextColumns) query.set("columns", nextColumns.join(","));
    return [stage, `?${query.toString()}`];
  }));
  const accountPath = `/workspaces/${workspaceId}/leads/accounts/${accountId}`;
  const pipelineReturnQuery = new URLSearchParams({ view: "pipeline" });
  const columnsParam = Array.isArray(resolvedSearch.columns) ? resolvedSearch.columns[0] : resolvedSearch.columns;
  if (columnsParam) pipelineReturnQuery.set("columns", columnsParam);
  const pipelineReturnTo = `${accountPath}?${pipelineReturnQuery.toString()}`;
  const pipelineStageAddHrefs = Object.fromEntries(CRM_CREATABLE_DEAL_STAGES.map((stage) => [
    stage,
    `/workspaces/${workspaceId}/add?kind=deal&stage=${stage}&returnTo=${encodeURIComponent(pipelineReturnTo)}`,
  ]));
  const [financeEnabled, practiceProjectsEnabled] = await Promise.all([
    isWorkspaceFeatureEnabled(workspaceId, "FINANCE"),
    isWorkspaceFeatureEnabled(workspaceId, "PRACTICE_PROJECTS"),
  ]);
  const canShowPracticeFinance = financeEnabled && practiceProjectsEnabled;
  const [account, communicationSuggestionResult, members, accountFinance] = await Promise.all([
    getCrmAccount(actor, { workspaceId, accountId }),
    listCommunicationSuggestions(actor, workspaceId, { accountId, take: 100 }),
    listMembers(workspaceId),
    canShowPracticeFinance
      ? getCrmAccountPracticeFinance(actor, { workspaceId, accountId })
      : Promise.resolve({
        summary: {
          activeProjects: 0,
          budgetCents: 0,
          usedCents: 0,
          remainingCents: 0,
          marginBps: null,
          currency: null,
          directCostCents: 0,
          grossProfitCents: 0,
          riskBudgetCount: 0,
          riskMarginCount: 0,
        },
        projects: [],
        projectHealth: [],
      }),
  ]);

  const activeDeals = account.deals.filter((deal) => deal.stage !== "CLOSED_WON" && deal.stage !== "CLOSED_LOST");
  const pipelineValue = activePipelineValueCents(account.deals);
  const accountActivities = account.activities as Array<(typeof account.activities)[number] & AccountActivityContext>;
  const reminderSummary = splitRelationshipReminders(accountActivities);
  const nextFollowUps = reminderSummary.open.slice(0, 5);
  const communicationSummary = splitCommunicationSuggestions(communicationSuggestionResult.items);
  const nextCommunicationSuggestions = communicationSummary.open.slice(0, 3);
  const financeProjectByDealId = new Map(accountFinance.projects
    .filter((project) => project.crmDealId)
    .map((project) => [project.crmDealId as string, project]));
  const financeProjectHealthById = new Map(accountFinance.projectHealth.map((health) => [health.projectId, health]));
  const closedWonDealsWithoutProject = account.deals.filter((deal) => deal.stage === "CLOSED_WON" && !financeProjectByDealId.has(deal.id));
  const canCreateFinanceProjects = canShowPracticeFinance && await canManagePracticeFinanceProjects(actor, workspaceId, {
    resolvedMembership: membership,
  });
  const isClientAccount = account.relationshipType === "CLIENT" && account.lifecycleStage === "ACTIVE";
  const canConvertToClient = !isClientAccount;
  const memberNames = new Map(members.map((member) => [
    member.user.id,
    member.user.displayName || member.user.email,
  ]));

  const formatCurrency = (cents: number, currency = "USD") => new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(cents / 100);
  const financeRemainingLabel = accountFinance.summary.currency == null && accountFinance.summary.activeProjects > 0
    ? "Mixed"
    : formatCurrency(accountFinance.summary.remainingCents, accountFinance.summary.currency ?? "USD");

  const formatMargin = (bps?: number | null) => bps == null ? t("emptyValue") : `${(bps / 100).toFixed(1)}%`;

  const formatDate = (value: Date | string) => new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
  const dueText = (date?: Date | string | null) => date ? formatDate(date) : t("followUpNoDueDate");
  const ownerText = (ownerUserId?: string | null) => ownerUserId ? memberNames.get(ownerUserId) ?? t("pipelineNoOwner") : t("pipelineNoOwner");

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

  const detailViewLabels = {
    overview: t("accountTabOverview"),
    contacts: t("tabContacts"),
    pipeline: t("tabPipeline"),
    activity: t("tabActivity"),
    suggestions: t("tabSuggestions"),
    conversations: t("tabConversations"),
    instances: t("tabInstances"),
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
  const crmChatPageContext = {
    surface: "crm" as const,
    workspaceId,
    view: "account-detail",
    section: view,
    selectedIds: { accountId: account.id },
    filters: crmFilters({ view }),
    visibleContext: {
      metrics: crmPageMetrics([
        { label: "contacts", value: account.contacts.length },
        { label: "activeDeals", value: activeDeals.length },
        { label: "pipelineValueCents", value: pipelineValue },
        { label: "activities", value: accountActivities.length },
        { label: "openFollowUps", value: reminderSummary.open.length },
        { label: "overdueFollowUps", value: reminderSummary.overdue.length },
        { label: "openCommunicationSuggestions", value: communicationSummary.open.length },
      ]),
      accounts: [crmAccountContext(workspaceId, account)],
      contacts: account.contacts
        .slice(0, CRM_CHAT_CONTEXT_LIMIT)
        .map((contact) => crmContactContext(workspaceId, { ...contact, account })),
      deals: account.deals
        .slice(0, CRM_CHAT_CONTEXT_LIMIT)
        .map((deal) => crmDealContext(workspaceId, { ...deal, account })),
      activities: accountActivities
        .slice(0, CRM_CHAT_CONTEXT_LIMIT)
        .map((activity) => crmActivityContext(workspaceId, { ...activity, account })),
      suggestions: communicationSummary.all
        .slice(0, CRM_CHAT_CONTEXT_LIMIT)
        .map((suggestion) => crmSuggestionContext(workspaceId, suggestion)),
    },
  };

  return (
    <>
      <CrmChatPageContext context={crmChatPageContext} />
      <header className="nr-masthead nr-crm-masthead">
        <a href={`/workspaces/${workspaceId}/leads`} className="nr-crm-back-link">
          {t("backToRelationships")}
        </a>
        <div className="row" style={{ alignItems: "flex-start", marginTop: 8 }}>
          <div>
            <h1>{account.name}</h1>
            <div className="nr-masthead-meta">
              <span>{account.domain || t("noDomain")}</span>
              <span>{relationshipLabel(account.relationshipType)}</span>
              <span>{lifecycleLabel(account.lifecycleStage)}</span>
            </div>
          </div>
        </div>
      </header>

      <section className="ws-section">
        <div className="ws-stat-row">
          <div className="ws-stat-card">
            <strong>{account.contacts.length}</strong>
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
            <strong>{accountActivities.length}</strong>
            <span>{t("statActivities")}</span>
          </div>
          <div className="ws-stat-card">
            <strong>{reminderSummary.open.length}</strong>
            <span>{t("statOpenFollowUps")}</span>
          </div>
          <div className="ws-stat-card">
            <strong>{reminderSummary.overdue.length}</strong>
            <span>{t("statOverdueFollowUps")}</span>
          </div>
          <div className="ws-stat-card">
            <strong>{communicationSummary.open.length}</strong>
            <span>{t("statSuggestedCommunications")}</span>
          </div>
          {canShowPracticeFinance && (
            <>
              <div className="ws-stat-card">
                <strong>{accountFinance.projects.length}</strong>
                <span>{t("statFinanceProjects")}</span>
              </div>
              <div className="ws-stat-card">
                <strong>{financeRemainingLabel}</strong>
                <span>{t("statFinanceRemaining")}</span>
              </div>
            </>
          )}
        </div>

        <div className="item" style={{ padding: 16, marginBottom: 24 }}>
          <div className="row" style={{ alignItems: "flex-start", gap: 12 }}>
            <div>
              <strong>{t("nextFollowUpsTitle")}</strong>
              <div className="muted" style={{ fontSize: "0.85rem", marginTop: 4 }}>
                {t("nextFollowUpsMeta", {
                  overdue: reminderSummary.overdue.length,
                  upcoming: reminderSummary.upcoming.length,
                })}
              </div>
            </div>
            <a href="?view=activity" className="link-button small" style={{ marginLeft: "auto" }}>
              {t("viewActivity")}
            </a>
          </div>
          {nextFollowUps.length === 0 ? (
            <p className="muted" style={{ marginTop: 12 }}>{t("noOpenFollowUps")}</p>
          ) : (
            <div className="stack" style={{ marginTop: 16 }}>
              {nextFollowUps.map((activity) => (
                <div key={activity.id} className="row" style={{ alignItems: "flex-start", gap: 12, padding: "10px 0", borderTop: "1px solid var(--line)" }}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <strong style={{ fontSize: "0.92rem" }}>{activity.title}</strong>
                    <div className="muted" style={{ fontSize: "0.82rem", marginTop: 4 }}>
                      {t("followUpDue", { date: dueText(activity.dueAt) })}
                      {" · "}
                      {t("pipelineOwner")}: {ownerText(activity.ownerUserId)}
                    </div>
                    {activity.deal && (
                      <div className="muted" style={{ fontSize: "0.82rem", marginTop: 4 }}>
                        {t("activityDeal")} <strong>{activity.deal.title}</strong>
                      </div>
                    )}
                  </div>
                  <form action={completeActivityAction}>
                    <input type="hidden" name="workspaceId" value={workspaceId} />
                    <input type="hidden" name="activityId" value={activity.id} />
                    <button type="submit" className="small">{t("btnCompleteFollowUp")}</button>
                  </form>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="item" style={{ padding: 16, marginBottom: 24 }}>
          <div className="row" style={{ alignItems: "flex-start", gap: 12 }}>
            <div>
              <strong>{t("suggestionQueueTitle")}</strong>
              <div className="muted" style={{ fontSize: "0.85rem", marginTop: 4 }}>
                {t("suggestionQueueMeta", {
                  suggested: communicationSummary.suggested.length,
                  requested: communicationSummary.requested.length,
                  failed: communicationSummary.failed.length,
                })}
              </div>
            </div>
            <a href="?view=suggestions" className="link-button small" style={{ marginLeft: "auto" }}>
              {t("viewSuggestions")}
            </a>
          </div>
          {nextCommunicationSuggestions.length === 0 ? (
            <p className="muted" style={{ marginTop: 12 }}>{t("noOpenSuggestions")}</p>
          ) : (
            <div className="stack" style={{ marginTop: 16 }}>
              {nextCommunicationSuggestions.map((suggestion) => (
                <div key={suggestion.id} className="row" style={{ alignItems: "flex-start", gap: 12, padding: "10px 0", borderTop: "1px solid var(--line)" }}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <strong style={{ fontSize: "0.92rem" }}>{suggestion.title}</strong>
                    <div className="muted" style={{ fontSize: "0.82rem", marginTop: 4 }}>
                      {communicationStatusLabels[suggestion.status as keyof typeof communicationStatusLabels] ?? suggestion.status}
                      {" · "}
                      {suggestion.recipientEmail || suggestion.contact?.email || t("suggestionNoRecipient")}
                    </div>
                    {suggestion.deal && (
                      <div className="muted" style={{ fontSize: "0.82rem", marginTop: 4 }}>
                        {t("activityDeal")} <strong>{suggestion.deal.title}</strong>
                      </div>
                    )}
                  </div>
                  <a href="?view=suggestions" className="link-button small">{t("btnReviewSuggestion")}</a>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="nr-filter-bar">
          {ACCOUNT_DETAIL_VIEWS.map((tab) => (
            <a
              key={tab}
              href={`?view=${tab}`}
              className={`nr-filter-item ${view === tab ? "nr-filter-active" : ""}`}
            >
              {detailViewLabels[tab]}
            </a>
          ))}
        </div>

        {view === "overview" && (
          <div className="stack">
            {canConvertToClient && (
              <div className="item" style={{ padding: 16 }}>
                <div className="row" style={{ alignItems: "flex-start", gap: 12 }}>
                  <div>
                    <strong>{t("clientConversionTitle")}</strong>
                    <div className="muted" style={{ fontSize: "0.85rem", marginTop: 4 }}>
                      {t("clientConversionMeta")}
                    </div>
                  </div>
                  <form action={convertCrmAccountToClientAction} className="row" style={{ gap: 12, marginLeft: "auto", alignItems: "center" }}>
                    <input type="hidden" name="workspaceId" value={workspaceId} />
                    <input type="hidden" name="accountId" value={account.id} />
                    {canCreateFinanceProjects && closedWonDealsWithoutProject.length > 0 && (
                      <label className="muted" style={{ fontSize: "0.85rem" }}>
                        {t("clientConversionOptionalFinance")}
                        <select name="financeDealId" defaultValue="" style={{ marginLeft: 8, minWidth: 220 }}>
                          <option value="">{t("clientConversionNoFinance")}</option>
                          {closedWonDealsWithoutProject.map((deal) => (
                            <option key={deal.id} value={deal.id}>
                              {deal.title} ({formatCurrency(deal.valueCents ?? 0)})
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                    <button type="submit" className="small">{t("clientConversionButton")}</button>
                  </form>
                </div>
              </div>
            )}

            {canShowPracticeFinance && (
              <div className="item" style={{ padding: 16 }}>
                <div className="row" style={{ alignItems: "flex-start", gap: 12 }}>
                  <div>
                    <strong>{t("financeBridgeTitle")}</strong>
                    <div className="muted" style={{ fontSize: "0.85rem", marginTop: 4 }}>
                      {t("financeBridgeMeta", {
                        projects: accountFinance.projects.length,
                        remaining: financeRemainingLabel,
                      })}
                    </div>
                  </div>
                  <a href={`/workspaces/${workspaceId}/finance`} className="link-button small" style={{ marginLeft: "auto" }}>
                    {t("financeOpenDashboard")}
                  </a>
                </div>

                {accountFinance.projects.length === 0 ? (
                  <p className="muted" style={{ marginTop: 12 }}>{t("financeBridgeEmpty")}</p>
                ) : (
                  <div className="stack" style={{ marginTop: 16 }}>
                    {accountFinance.projects.map((project) => {
                      const health = financeProjectHealthById.get(project.id);
                      return (
                      <div key={project.id} className="item" style={{ padding: 14 }}>
                        <div className="row" style={{ gap: 8, alignItems: "flex-start" }}>
                          <div style={{ minWidth: 0, flex: 1 }}>
                            <strong>
                              <a href={`/workspaces/${workspaceId}/finance/projects/${project.id}`}>{project.name}</a>
                            </strong>
                            <div className="muted" style={{ fontSize: "0.82rem", marginTop: 4 }}>
                              {t("financeProjectCode")}: {project.code}
                              {project.crmDeal ? ` · ${t("financeLinkedDeal")}: ${project.crmDeal.title}` : ""}
                            </div>
                          </div>
                          <span className="tag">{project.status.toLowerCase()}</span>
                        </div>
                        <div className="nr-tag-group" style={{ marginTop: 12 }}>
                          {project.crmDeal && <span className="tag-sm">{t("financeDealValue")}: {formatCurrency(project.crmDeal.valueCents ?? 0)}</span>}
                          <span className="tag-sm">{t("financePoValue")}: {formatCurrency(health?.budgetCents ?? project.poValueCents, health?.currency ?? project.currency)}</span>
                          <span className="tag-sm">{t("financeUsedBudget")}: {formatCurrency(health?.usedBudgetCents ?? 0, health?.currency ?? project.currency)}</span>
                          <span className="tag-sm">{t("financeRemainingBudget")}: {formatCurrency(health?.remainingBudgetCents ?? project.poValueCents, health?.currency ?? project.currency)}</span>
                          <span className="tag-sm">{t("financeMargin")}: {formatMargin(health?.grossMarginBps ?? null)}</span>
                          <a className="link-button small secondary" href={`/workspaces/${workspaceId}/finance/projects/${project.id}`}>
                            Open project
                          </a>
                        </div>
                      </div>
                      );
                    })}
                  </div>
                )}

                {canCreateFinanceProjects && closedWonDealsWithoutProject.length > 0 && (
                  <details style={{ marginTop: 16 }}>
                    <summary className="link-button small" style={{ cursor: "pointer" }}>{t("financeCreateFromWonDealTitle")}</summary>
                    <div className="stack" style={{ marginTop: 16 }}>
                      {closedWonDealsWithoutProject.map((deal) => (
                        <form key={deal.id} action={createFinanceProjectFromDealAction} className="stack nr-form-section">
                          <input type="hidden" name="workspaceId" value={workspaceId} />
                          <input type="hidden" name="dealId" value={deal.id} />
                          <div className="row" style={{ alignItems: "flex-start", gap: 12 }}>
                            <div>
                              <strong>{deal.title}</strong>
                              <div className="muted" style={{ fontSize: "0.82rem", marginTop: 4 }}>
                                {t("financeDealValue")}: {formatCurrency(deal.valueCents ?? 0)}
                              </div>
                            </div>
                            <span className="tag success" style={{ marginLeft: "auto" }}>{stageLabels.CLOSED_WON}</span>
                          </div>
                          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
                            <label>{t("formProjectCodeOptional")} <input type="text" name="code" /></label>
                            <label>{t("formServiceBudget")} <input type="number" name="serviceBudget" min="0" step="0.01" /></label>
                            <label>{t("formExpenseBudget")} <input type="number" name="expenseBudget" min="0" step="0.01" /></label>
                            <label>{t("formTargetMargin")} <input type="number" name="targetMargin" min="0" max="100" step="0.1" /></label>
                          </div>
                          <button type="submit" style={{ width: "fit-content" }}>{t("btnCreateFinanceProject")}</button>
                        </form>
                      ))}
                    </div>
                  </details>
                )}
              </div>
            )}

            <div className="item" style={{ padding: 16 }}>
              <div className="row">
                <strong>{t("accountOverview")}</strong>
                <span className="tag">{account.source}</span>
              </div>
              {account.descriptionMd ? (
                <div style={{ marginTop: 12 }}>
                  <MarkdownRenderer markdown={account.descriptionMd} variant="compact" />
                </div>
              ) : (
                <p className="muted">{t("accountNoDescription")}</p>
              )}
              <div className="nr-tag-group" style={{ marginTop: 12 }}>
                <span className="tag-sm">{t("accountCreated", { date: formatDate(account.createdAt) })}</span>
                <span className="tag-sm">{t("accountUpdated", { date: formatDate(account.updatedAt) })}</span>
              </div>
            </div>

            <details>
              <summary className="link-button small" style={{ cursor: "pointer" }}>{t("btnEditAccount")}</summary>
              <form action={updateCrmAccountAction} className="stack nr-form-section" style={{ marginTop: 16 }}>
                <input type="hidden" name="workspaceId" value={workspaceId} />
                <input type="hidden" name="accountId" value={account.id} />
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 16 }}>
                  <label>{t("formAccountName")} <input type="text" name="name" defaultValue={account.name} required /></label>
                  <label>{t("formDomain")} <input type="text" name="domain" defaultValue={account.domain ?? ""} /></label>
                  <label>
                    {t("formRelationshipType")}
                    <select name="relationshipType" defaultValue={account.relationshipType}>
                      {CRM_RELATIONSHIP_OPTIONS.map((option) => (
                        <option key={option} value={option}>{relationshipLabel(option)}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    {t("formLifecycleStage")}
                    <select name="lifecycleStage" defaultValue={account.lifecycleStage}>
                      {CRM_LIFECYCLE_OPTIONS.map((option) => (
                        <option key={option} value={option}>{lifecycleLabel(option)}</option>
                      ))}
                    </select>
                  </label>
                </div>
                <label>
                  {t("formDescription")}
                  <MarkdownEditor name="descriptionMd" defaultValue={account.descriptionMd ?? ""} rows={4} />
                </label>
                <button type="submit" style={{ width: "fit-content" }}>{t("btnSaveAccount")}</button>
              </form>
              <form action={archiveCrmAccountAction} style={{ marginTop: 12 }}>
                <input type="hidden" name="workspaceId" value={workspaceId} />
                <input type="hidden" name="accountId" value={account.id} />
                <button type="submit" className="danger small">{t("btnArchiveAccount")}</button>
              </form>
            </details>
          </div>
        )}

        {view === "contacts" && (
          <div className="stack">
            {account.contacts.length === 0 ? (
              <p className="muted">{t("accountNoContacts")}</p>
            ) : account.contacts.map((contact) => (
              <div key={contact.id} className="item" style={{ padding: 16 }}>
                <div className="row" style={{ alignItems: "flex-start", gap: 12 }}>
                  <div style={{ minWidth: 0 }}>
                    <strong>{contact.name || t("unknownContact")}</strong>
                    <div className="muted" style={{ fontSize: "0.85rem", marginTop: 4 }}>
                      {contact.email}
                      {contact.title ? ` · ${contact.title}` : ""}
                    </div>
                  </div>
                  <div className="row" style={{ marginLeft: "auto", gap: 8 }}>
                    <span className="tag">{contact.source}</span>
                    <form action={archiveContactAction}>
                      <input type="hidden" name="workspaceId" value={workspaceId} />
                      <input type="hidden" name="contactId" value={contact.id} />
                      <button type="submit" className="danger small">{t("btnArchiveContact")}</button>
                    </form>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {view === "pipeline" && (
          <div className="stack">
            <DealPipelineBoard
              workspaceId={workspaceId}
              deals={account.deals}
              members={members}
              locale={locale}
              stageLabels={stageLabels}
              visibleColumnIds={visiblePipelineColumnIds}
              hideColumnHrefs={pipelineColumnHideHrefs}
              storageKey={`relationships:${workspaceId}:account:${account.id}:pipeline`}
              accountFallback={{ id: account.id, name: account.name }}
              addStageHrefs={pipelineStageAddHrefs}
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
            {accountActivities.length === 0 ? (
              <p className="muted">{t("accountNoActivity")}</p>
            ) : accountActivities.map((activity) => (
              <div key={activity.id} className="item" style={{ display: "flex", gap: 16 }}>
                <div style={{ width: 40, height: 40, borderRadius: "50%", background: "var(--accent-soft)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "1.2rem", flexShrink: 0 }}>
                  {activityIcon(activity.type)}
                </div>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="row">
                    <strong>{activity.title}</strong>
                    <div className="row" style={{ gap: 8, marginLeft: "auto", fontSize: "0.8rem" }}>
                      <span className="tag-sm">{activity.source}</span>
                      <span className="muted">{activity.completedAt ? t("followUpCompleted", { date: formatDate(activity.completedAt) }) : formatDate(activity.createdAt)}</span>
                    </div>
                  </div>
                  <div className="nr-tag-group" style={{ marginTop: 8 }}>
                    {activity.dueAt && <span className="tag-sm">{t("followUpDue", { date: dueText(activity.dueAt) })}</span>}
                    {activity.ownerUserId && <span className="tag-sm">{t("pipelineOwner")}: {ownerText(activity.ownerUserId)}</span>}
                  </div>
                  {activity.bodyMd && <MarkdownRenderer markdown={activity.bodyMd} variant="compact" />}
                  {activity.type === "TASK" && !activity.completedAt && (
                    <form action={completeActivityAction} style={{ marginTop: 12 }}>
                      <input type="hidden" name="workspaceId" value={workspaceId} />
                      <input type="hidden" name="activityId" value={activity.id} />
                      <button type="submit" className="small">{t("btnCompleteFollowUp")}</button>
                    </form>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {view === "suggestions" && (
          <div className="stack">
            {communicationSummary.all.length === 0 ? (
              <p className="muted">{t("accountNoSuggestions")}</p>
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

        {view === "conversations" && (
          <div className="stack">
            {account.crmConversations.length === 0 ? (
              <p className="muted">{t("accountNoConversations")}</p>
            ) : account.crmConversations.map((conversation) => (
              <div key={conversation.id} className="item" style={{ padding: 16 }}>
                <div className="row">
                  <strong>{conversation.subject || t("untitledConversation")}</strong>
                  <span className="tag">{conversation.status}</span>
                </div>
                {conversation.messages[0] && (
                  <div style={{ marginTop: 12, background: "var(--bg-alt)", padding: 12, borderRadius: 8, fontSize: "0.85rem" }}>
                    <strong>{conversation.messages[0].senderType === "LEAD" ? t("senderLead") : t("senderStaff")}</strong>
                    <MarkdownRenderer markdown={conversation.messages[0].bodyMd} variant="compact" />
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {view === "instances" && (
          <div className="stack">
            {account.prospectWorkspaces.length === 0 ? (
              <p className="muted">{t("accountNoInstances")}</p>
            ) : account.prospectWorkspaces.map((prospectWorkspace) => (
              <div key={prospectWorkspace.id} className="item" style={{ padding: 16 }}>
                <div className="row">
                  <strong>{prospectWorkspace.targetWorkspace?.name || t("demoWorkspace")}</strong>
                  <span className="tag">{prospectWorkspace.status}</span>
                </div>
                <div className="muted" style={{ fontSize: "0.85rem", marginTop: 8 }}>
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
