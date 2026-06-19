import { requirePageActor } from "@/lib/auth";
import { WorkItemToolbar } from "@/lib/components/WorkItemControls";
import { WorkItemTable, type WorkItemTableColumn, type WorkItemTableRow } from "@/lib/components/WorkItemTable";
import { normalizeVisibleWorkItemColumns, toggleWorkItemColumnVisibility } from "@/lib/work-item-view";
import type { WorkItemViewMode } from "@/lib/work-item-view";
import { requireWorkspaceFeature } from "@/lib/workspace-feature-flags";
import { listContacts, listDeals, listMembers, requireWorkspaceMembership } from "@corgtex/domain";
import type { CrmDealStage } from "@prisma/client";
import { getTranslations } from "next-intl/server";

import { createDealAction } from "../actions";
import { CrmChatPageContext } from "../CrmChatPageContext";
import { DealPipelineBoard } from "../DealPipelineBoard";
import {
  CRM_CHAT_CONTEXT_LIMIT,
  crmDealContext,
  crmFilters,
  crmPageMetrics,
} from "../chat-page-context";
import {
  CRM_DEAL_STAGES,
  activePipelineValueCents,
  labelFromCrmCode,
  relationshipDashboardHref,
  relationshipFullPageHref,
} from "../view-model";
import { RelationshipNav, relationshipNavLabels } from "../RelationshipNav";
import {
  CRM_FULL_PAGE_SIZE,
  crmPageCount,
  crmPageHref,
  crmPageOffset,
  crmViewHref,
  normalizeCrmPage,
  normalizeCrmViewMode,
  optionValue,
  type SearchParamsRecord,
} from "../full-page-utils";

export const dynamic = "force-dynamic";
const PIPELINE_VIEW_MODES = ["kanban", "table", "list"] as const;
const DEFAULT_PIPELINE_VIEW = "kanban";

export default async function RelationshipPipelinePage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; workspaceId: string }>;
  searchParams?: Promise<SearchParamsRecord>;
}) {
  const { locale, workspaceId } = await params;
  await requireWorkspaceFeature(workspaceId, "RELATIONSHIPS");
  const actor = await requirePageActor();
  await requireWorkspaceMembership({ actor, workspaceId });
  const t = await getTranslations("leads");
  const tWork = await getTranslations("workItems");
  const resolvedSearch = searchParams ? await searchParams : {};
  const page = normalizeCrmPage(resolvedSearch.page);
  const viewMode = normalizeCrmViewMode(resolvedSearch.view, PIPELINE_VIEW_MODES, DEFAULT_PIPELINE_VIEW);
  const stage = optionValue(resolvedSearch.stage, CRM_DEAL_STAGES as readonly CrmDealStage[]);
  const pagePath = relationshipFullPageHref(workspaceId, "pipeline");
  const visiblePipelineColumnIds = normalizeVisibleWorkItemColumns(resolvedSearch.columns, CRM_DEAL_STAGES);
  const pipelineColumnHideHrefs = Object.fromEntries(CRM_DEAL_STAGES.map((column) => {
    const nextColumns = toggleWorkItemColumnVisibility(visiblePipelineColumnIds, column, CRM_DEAL_STAGES);
    return [column, crmPageHref(pagePath, resolvedSearch, { columns: nextColumns?.join(",") ?? null })];
  }));

  const [dealResult, contactResult, members] = await Promise.all([
    listDeals(actor, workspaceId, {
      take: CRM_FULL_PAGE_SIZE,
      skip: crmPageOffset(page),
      stage,
    }),
    listContacts(actor, workspaceId, { take: 200 }),
    listMembers(workspaceId),
  ]);

  const formatCurrency = (cents: number) => new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(cents / 100);
  const stageLabels = {
    LEAD: t("stageLead"),
    QUALIFIED: t("stageQualified"),
    PROPOSAL: t("stageProposal"),
    NEGOTIATION: t("stageNegotiate"),
    CLOSED_WON: t("stageWon"),
    CLOSED_LOST: t("stageLost"),
  };
  const pageCount = crmPageCount(dealResult.total);
  const previousHref = crmPageHref(pagePath, resolvedSearch, { page: Math.max(page - 1, 1) });
  const nextHref = crmPageHref(pagePath, resolvedSearch, { page: Math.min(page + 1, pageCount) });
  const clearHref = crmPageHref(pagePath, {}, { view: viewMode === DEFAULT_PIPELINE_VIEW ? null : viewMode });
  const ownerText = (ownerUserId?: string | null) => {
    const owner = members.find((member) => member.user.id === ownerUserId)?.user;
    return owner ? owner.displayName || owner.email : t("pipelineNoOwner");
  };
  const accountLink = (deal: (typeof dealResult.items)[number]) => {
    if (!deal.account) return <span className="muted">{t("emptyAccount")}</span>;
    return <a href={`/workspaces/${workspaceId}/leads/accounts/${deal.account.id}`}>{deal.account.name}</a>;
  };
  const dealTableColumns: WorkItemTableColumn[] = [
    { id: "deal", label: t("fullPipelineTitle") },
    { id: "stage", label: t("filterStage") },
    { id: "account", label: t("pipelineAccount") },
    { id: "value", label: t("dashboardDealValue") },
    { id: "owner", label: t("pipelineOwner") },
    { id: "actions", label: t("colActions"), align: "right" },
  ];
  const dealTableRows: WorkItemTableRow[] = dealResult.items.map((deal) => ({
    id: deal.id,
    cells: {
      deal: (
        <>
          <strong>{deal.title}</strong>
          <div className="nr-work-item-table-meta">{deal.contact.name || deal.contact.email}</div>
        </>
      ),
      stage: <span className="tag-sm">{stageLabels[deal.stage] ?? labelFromCrmCode(deal.stage)}</span>,
      account: accountLink(deal),
      value: <strong>{formatCurrency(deal.valueCents ?? 0)}</strong>,
      owner: <span className="muted">{ownerText(deal.ownerUserId)}</span>,
      actions: deal.account ? <a href={`/workspaces/${workspaceId}/leads/accounts/${deal.account.id}?view=pipeline`} className="link-button small">{t("openDetail")}</a> : null,
    },
  }));
  const crmChatPageContext = {
    surface: "crm" as const,
    workspaceId,
    view: "pipeline",
    section: "pipeline",
    selectedIds: {},
    filters: crmFilters({ stage, page, viewMode }),
    pagination: { page, pageCount, total: dealResult.total },
    visibleContext: {
      metrics: crmPageMetrics([
        { label: "dealsVisible", value: dealResult.items.length },
        { label: "dealsTotal", value: dealResult.total },
        { label: "pipelineValueCents", value: activePipelineValueCents(dealResult.items) },
      ]),
      deals: dealResult.items
        .slice(0, CRM_CHAT_CONTEXT_LIMIT)
        .map((deal) => crmDealContext(workspaceId, deal)),
    },
  };

  return (
    <>
      <CrmChatPageContext context={crmChatPageContext} />
      <header className="nr-masthead" style={{ textAlign: "left", marginBottom: 32 }}>
        <a href={relationshipDashboardHref(workspaceId)} className="muted" style={{ fontSize: "0.9rem" }}>
          {t("backToRelationships")}
        </a>
        <h1 style={{ border: "none", padding: 0, margin: "12px 0 0", fontSize: "2rem" }}>{t("fullPipelineTitle")}</h1>
        <div className="nr-masthead-meta">
          <span>{t("fullPipelineDescription")}</span>
          <span>{t("paginationSummary", { page, pageCount, count: dealResult.items.length, total: dealResult.total })}</span>
        </div>
      </header>

      <section className="ws-section">
        <div className="nr-work-board-header">
          <RelationshipNav workspaceId={workspaceId} active="pipeline" labels={relationshipNavLabels(t)} />
          <WorkItemToolbar
            currentView={viewMode as WorkItemViewMode}
            currentSort="priority"
            listHref={crmViewHref(pagePath, resolvedSearch, "list", DEFAULT_PIPELINE_VIEW)}
            kanbanHref={crmViewHref(pagePath, resolvedSearch, "kanban", DEFAULT_PIPELINE_VIEW)}
            tableHref={crmViewHref(pagePath, resolvedSearch, "table", DEFAULT_PIPELINE_VIEW)}
            sortLinks={{ priority: pagePath, date: pagePath, alpha: pagePath }}
            listLabel={tWork("listView")}
            kanbanLabel={tWork("kanbanView")}
            tableLabel={tWork("tableView")}
            sortLabel={tWork("sort")}
            sortPriorityLabel={tWork("sortPriority")}
            sortDateLabel={tWork("sortDate")}
            sortAlphaLabel={tWork("sortAlpha")}
            label={tWork("viewMode")}
            showSort={false}
          />
        </div>

        <div className="ws-stat-row" style={{ marginBottom: 20 }}>
          <div className="ws-stat-card"><strong>{dealResult.total}</strong><span>{t("statActiveDeals")}</span></div>
          <div className="ws-stat-card"><strong>{formatCurrency(activePipelineValueCents(dealResult.items))}</strong><span>{t("statPipelineValue")}</span></div>
        </div>

        <form method="get" className="nr-form-section" style={{ marginBottom: 20 }}>
          {viewMode !== DEFAULT_PIPELINE_VIEW && <input type="hidden" name="view" value={viewMode} />}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
            <label>
              {t("filterStage")}
              <select name="stage" defaultValue={stage ?? ""}>
                <option value="">{t("stageAll")}</option>
                {CRM_DEAL_STAGES.map((option) => (
                  <option key={option} value={option}>{stageLabels[option] ?? labelFromCrmCode(option)}</option>
                ))}
              </select>
            </label>
          </div>
          <div className="row" style={{ justifyContent: "flex-start", gap: 8, marginTop: 12 }}>
            <button type="submit" className="small">{t("filterApply")}</button>
            <a href={clearHref} className="link-button small">{t("filterClear")}</a>
          </div>
        </form>

        <details style={{ marginBottom: 20 }}>
          <summary className="link-button small" style={{ cursor: "pointer", width: "fit-content" }}>
            {t("btnNewDeal")}
          </summary>
          <form action={createDealAction} className="stack nr-form-section" style={{ marginTop: 16 }}>
            <input type="hidden" name="workspaceId" value={workspaceId} />
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 16 }}>
              <label>
                {t("formContact")}
                <select name="contactId" required>
                  <option value="">{t("selectContact")}</option>
                  {contactResult.items.map((contact) => (
                    <option key={contact.id} value={contact.id}>{contact.name || contact.email}</option>
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
                    <option key={member.user.id} value={member.user.id}>{member.user.displayName || member.user.email}</option>
                  ))}
                </select>
              </label>
            </div>
            <button type="submit" style={{ width: "fit-content" }}>{t("btnCreateDeal")}</button>
          </form>
        </details>

        {viewMode === "kanban" ? (
          <DealPipelineBoard
            workspaceId={workspaceId}
            deals={dealResult.items}
            members={members}
            locale={locale}
            stageLabels={stageLabels}
            visibleColumnIds={visiblePipelineColumnIds}
            hideColumnHrefs={pipelineColumnHideHrefs}
            storageKey={`relationships:${workspaceId}:pipeline:full`}
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
        ) : viewMode === "table" ? (
          <WorkItemTable
            columns={dealTableColumns}
            rows={dealTableRows}
            empty={<p className="muted">{t("dashboardNoPipeline")}</p>}
          />
        ) : (
          <div className="stack">
            {dealResult.items.length === 0 && <p className="muted">{t("dashboardNoPipeline")}</p>}
            {dealResult.items.map((deal) => (
              <div key={deal.id} className="item" style={{ display: "grid", gap: 10 }}>
                <div className="row" style={{ alignItems: "flex-start", gap: 10 }}>
                  <div style={{ minWidth: 0 }}>
                    <strong>{deal.title}</strong>
                    <div className="muted" style={{ fontSize: "0.84rem", marginTop: 4 }}>{deal.contact.name || deal.contact.email}</div>
                  </div>
                  <span className="tag-sm" style={{ marginLeft: "auto" }}>{formatCurrency(deal.valueCents ?? 0)}</span>
                </div>
                <div className="nr-tag-group">
                  <span className="tag-sm">{stageLabels[deal.stage] ?? labelFromCrmCode(deal.stage)}</span>
                  <span className="tag-sm">{t("pipelineOwner")}: {ownerText(deal.ownerUserId)}</span>
                  <span className="tag-sm">{t("pipelineAccount")}: {deal.account?.name ?? t("emptyAccount")}</span>
                </div>
                {deal.account && <a href={`/workspaces/${workspaceId}/leads/accounts/${deal.account.id}?view=pipeline`} className="link-button small" style={{ width: "fit-content" }}>{t("openDetail")}</a>}
              </div>
            ))}
          </div>
        )}

        <div className="row" style={{ marginTop: 16, fontSize: "0.85rem" }}>
          <span className="muted">{t("paginationSummary", { page, pageCount, count: dealResult.items.length, total: dealResult.total })}</span>
          <div className="row" style={{ gap: 8 }}>
            {page > 1 ? <a href={previousHref} className="link-button small">{t("paginationPrevious")}</a> : <span className="tag-sm">{t("paginationPrevious")}</span>}
            {page < pageCount ? <a href={nextHref} className="link-button small">{t("paginationNext")}</a> : <span className="tag-sm">{t("paginationNext")}</span>}
          </div>
        </div>
      </section>
    </>
  );
}
