import { requirePageActor } from "@/lib/auth";
import { MarkdownEditor } from "@/lib/components/MarkdownEditor";
import { WorkItemToolbar } from "@/lib/components/WorkItemControls";
import { WorkItemKanbanBoard, type WorkItemKanbanColumn } from "@/lib/components/WorkItemKanbanBoard";
import { WorkItemTable, type WorkItemTableColumn, type WorkItemTableRow } from "@/lib/components/WorkItemTable";
import { requireWorkspaceFeature } from "@/lib/workspace-feature-flags";
import type { WorkItemViewMode } from "@/lib/work-item-view";
import {
  listCommunicationSuggestions,
  listContacts,
  listCrmAccounts,
  listDeals,
  listMembers,
  requireWorkspaceMembership,
} from "@corgtex/domain";
import { getTranslations } from "next-intl/server";

import { createCommunicationSuggestionAction } from "../actions";
import { CommunicationSuggestionCard } from "../CommunicationSuggestionCard";
import { CrmTableSortHeader } from "../CrmTableSortHeader";
import { CrmChatPageContext } from "../CrmChatPageContext";
import {
  CRM_CHAT_CONTEXT_LIMIT,
  crmFilters,
  crmPageMetrics,
  crmSuggestionContext,
} from "../chat-page-context";
import { relationshipDashboardHref, relationshipFullPageHref } from "../view-model";
import { RelationshipNav, relationshipNavLabels } from "../RelationshipNav";
import {
  CRM_FULL_PAGE_SIZE,
  crmPageCount,
  crmPageHref,
  crmPageOffset,
  crmViewHref,
  normalizeCrmPage,
  normalizeCrmSortDirection,
  normalizeCrmViewMode,
  optionValue,
  type SearchParamsRecord,
} from "../full-page-utils";

export const dynamic = "force-dynamic";

const SUGGESTION_STATUSES = ["SUGGESTED", "REQUESTED", "SENT", "DECLINED", "FAILED"] as const;
const SUGGESTION_VIEW_MODES = ["list", "table", "kanban"] as const;
const SUGGESTION_SORTS = ["status", "account", "updated"] as const;
const DEFAULT_SUGGESTION_VIEW = "list";

export default async function RelationshipSuggestionsPage({
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
  const viewMode = normalizeCrmViewMode(resolvedSearch.view, SUGGESTION_VIEW_MODES, DEFAULT_SUGGESTION_VIEW);
  const status = optionValue(resolvedSearch.status, SUGGESTION_STATUSES);
  const sort = optionValue(resolvedSearch.sort, SUGGESTION_SORTS) ?? "updated";
  const sortDirection = normalizeCrmSortDirection(resolvedSearch.dir, sort === "updated" ? "desc" : "asc");
  const pagePath = relationshipFullPageHref(workspaceId, "suggestions");

  const [suggestionResult, accountResult, contactResult, dealResult, members] = await Promise.all([
    listCommunicationSuggestions(actor, workspaceId, {
      take: CRM_FULL_PAGE_SIZE,
      skip: crmPageOffset(page),
      status,
    }),
    listCrmAccounts(actor, workspaceId, { take: 200 }),
    listContacts(actor, workspaceId, { take: 200 }),
    listDeals(actor, workspaceId, { take: 200 }),
    listMembers(workspaceId),
  ]);

  const formatDate = (value: Date | string) => new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
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
  const pageCount = crmPageCount(suggestionResult.total);
  const previousHref = crmPageHref(pagePath, resolvedSearch, { page: Math.max(page - 1, 1) });
  const nextHref = crmPageHref(pagePath, resolvedSearch, { page: Math.min(page + 1, pageCount) });
  const clearHref = crmPageHref(pagePath, {}, { view: viewMode === DEFAULT_SUGGESTION_VIEW ? null : viewMode });
  const suggestionDate = (suggestion: (typeof suggestionResult.items)[number]) => (
    suggestion.updatedAt ?? suggestion.requestedAt ?? suggestion.sentAt ?? suggestion.declinedAt ?? suggestion.failedAt
  );
  const suggestionAccount = (suggestion: (typeof suggestionResult.items)[number]) => (
    suggestion.account ? <a href={`/workspaces/${workspaceId}/leads/accounts/${suggestion.account.id}`}>{suggestion.account.name}</a> : <span className="muted">{t("emptyAccount")}</span>
  );
  const suggestionRecipient = (suggestion: (typeof suggestionResult.items)[number]) => (
    suggestion.recipientEmail || suggestion.contact?.email || t("suggestionNoRecipient")
  );
  const directionFactor = sortDirection === "asc" ? 1 : -1;
  const statusOrder = new Map(SUGGESTION_STATUSES.map((suggestionStatus, index) => [suggestionStatus, index]));
  const compareText = (left?: string | null, right?: string | null) => (
    (left || "").localeCompare(right || "", locale, { sensitivity: "base" }) * directionFactor
  );
  const compareNumber = (left: number, right: number) => (left - right) * directionFactor;
  const compareDate = (left?: Date | string | null, right?: Date | string | null) => (
    ((left ? new Date(left).getTime() : 0) - (right ? new Date(right).getTime() : 0)) * directionFactor
  );
  const sortedSuggestions = [...suggestionResult.items].sort((left, right) => {
    if (sort === "status") {
      return compareNumber(
        statusOrder.get(left.status as typeof SUGGESTION_STATUSES[number]) ?? 0,
        statusOrder.get(right.status as typeof SUGGESTION_STATUSES[number]) ?? 0,
      );
    }
    if (sort === "account") return compareText(left.account?.name, right.account?.name);
    return compareDate(suggestionDate(left), suggestionDate(right));
  });
  const suggestionTableColumns: WorkItemTableColumn[] = [
    { id: "suggestion", label: t("dashboardSuggestionSummaryTitle") },
    {
      id: "status",
      label: (
        <CrmTableSortHeader
          label={t("filterStatus")}
          sortKey="status"
          activeSort={sort}
          direction={sortDirection}
          path={pagePath}
          current={resolvedSearch}
        />
      ),
      mobileLabel: t("filterStatus"),
    },
    {
      id: "account",
      label: (
        <CrmTableSortHeader
          label={t("colAccount")}
          sortKey="account"
          activeSort={sort}
          direction={sortDirection}
          path={pagePath}
          current={resolvedSearch}
        />
      ),
      mobileLabel: t("colAccount"),
    },
    { id: "recipient", label: t("formSuggestionRecipient") },
    {
      id: "updated",
      label: (
        <CrmTableSortHeader
          label={t("colUpdated")}
          sortKey="updated"
          activeSort={sort}
          direction={sortDirection}
          defaultDirection="desc"
          path={pagePath}
          current={resolvedSearch}
        />
      ),
      mobileLabel: t("colUpdated"),
    },
  ];
  const suggestionTableRows: WorkItemTableRow[] = sortedSuggestions.map((suggestion) => ({
    id: suggestion.id,
    cells: {
      suggestion: (
        <>
          <strong>{suggestion.title}</strong>
          <div className="nr-work-item-table-meta">{suggestion.subject || t("suggestionNoSubject")}</div>
        </>
      ),
      status: <span className="tag-sm">{communicationStatusLabels[suggestion.status as keyof typeof communicationStatusLabels] ?? suggestion.status}</span>,
      account: suggestionAccount(suggestion),
      recipient: <span className="muted">{suggestionRecipient(suggestion)}</span>,
      updated: <span className="muted">{suggestionDate(suggestion) ? formatDate(suggestionDate(suggestion) as Date | string) : t("emptyValue")}</span>,
    },
  }));
  const suggestionColumns: WorkItemKanbanColumn[] = SUGGESTION_STATUSES.map((suggestionStatus) => {
    const items = suggestionResult.items.filter((suggestion) => suggestion.status === suggestionStatus);
    return {
      id: suggestionStatus,
      label: communicationStatusLabels[suggestionStatus],
      count: items.length,
      empty: <p className="muted">{t("noSuggestions")}</p>,
      items: items.map((suggestion) => ({
        id: suggestion.id,
        status: suggestion.status,
        sort: {
          priority: suggestion.status === "FAILED" ? 3 : suggestion.status === "REQUESTED" ? 2 : 1,
          date: suggestionDate(suggestion) ?? null,
          alpha: suggestion.title,
        },
        node: (
          <div className="item" style={{ padding: 12, display: "grid", gap: 8 }}>
            <strong style={{ fontSize: "0.95rem", lineHeight: 1.3 }}>{suggestion.title}</strong>
            <div className="muted" style={{ fontSize: "0.82rem" }}>{suggestion.subject || t("suggestionNoSubject")}</div>
            <div className="nr-tag-group">
              <span className="tag-sm">{suggestionRecipient(suggestion)}</span>
              <span className="tag-sm">{suggestion.account?.name ?? t("emptyAccount")}</span>
            </div>
          </div>
        ),
      })),
    };
  });
  const crmChatPageContext = {
    surface: "crm" as const,
    workspaceId,
    view: "suggestions",
    section: "suggestions",
    selectedIds: {},
    filters: crmFilters({ status, page, viewMode, sort, dir: sortDirection }),
    pagination: { page, pageCount, total: suggestionResult.total },
    visibleContext: {
      metrics: crmPageMetrics([
        { label: "suggestionsVisible", value: suggestionResult.items.length },
        { label: "suggestionsTotal", value: suggestionResult.total },
      ]),
      suggestions: sortedSuggestions
        .slice(0, CRM_CHAT_CONTEXT_LIMIT)
        .map((suggestion) => crmSuggestionContext(workspaceId, suggestion)),
    },
  };

  return (
    <>
      <CrmChatPageContext context={crmChatPageContext} />
      <header className="nr-masthead nr-crm-masthead">
        <a href={relationshipDashboardHref(workspaceId)} className="nr-crm-back-link">
          {t("backToRelationships")}
        </a>
        <h1>{t("fullSuggestionsTitle")}</h1>
        <div className="nr-masthead-meta"><span>{t("fullSuggestionsDescription")}</span></div>
      </header>

      <section className="ws-section">
        <div className="nr-work-board-header">
          <RelationshipNav workspaceId={workspaceId} active="suggestions" labels={relationshipNavLabels(t)} />
          <WorkItemToolbar
            currentView={viewMode as WorkItemViewMode}
            currentSort="priority"
            listHref={crmViewHref(pagePath, resolvedSearch, "list", DEFAULT_SUGGESTION_VIEW)}
            kanbanHref={crmViewHref(pagePath, resolvedSearch, "kanban", DEFAULT_SUGGESTION_VIEW)}
            tableHref={crmViewHref(pagePath, resolvedSearch, "table", DEFAULT_SUGGESTION_VIEW)}
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

        <form method="get" className="nr-filter-panel nr-crm-filter-panel">
          {viewMode !== DEFAULT_SUGGESTION_VIEW && <input type="hidden" name="view" value={viewMode} />}
          <input type="hidden" name="sort" value={sort} />
          {sortDirection !== "asc" && <input type="hidden" name="dir" value={sortDirection} />}
          <label>
            <span className="nr-item-meta">{t("filterStatus")}</span>
            <select name="status" defaultValue={status ?? ""}>
              <option value="">{t("statusAll")}</option>
              {SUGGESTION_STATUSES.map((option) => (
                <option key={option} value={option}>{communicationStatusLabels[option]}</option>
              ))}
            </select>
          </label>
          <div className="nr-crm-filter-actions">
            <button type="submit" className="small">{t("filterApply")}</button>
            <a href={clearHref} className="link-button small">{t("filterClear")}</a>
          </div>
        </form>

        <details style={{ marginBottom: 20 }}>
          <summary className="link-button small" style={{ cursor: "pointer", width: "fit-content" }}>
            {t("btnNewSuggestion")}
          </summary>
          <form action={createCommunicationSuggestionAction} className="stack nr-form-section" style={{ marginTop: 16 }}>
            <input type="hidden" name="workspaceId" value={workspaceId} />
            <input type="hidden" name="channel" value="EMAIL" />
            <input type="hidden" name="source" value="manual" />
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 16 }}>
              <label>{t("formAccount")} <select name="accountId" required><option value="">{t("selectAccount")}</option>{accountResult.items.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label>
              <label>{t("formContact")} <select name="contactId" defaultValue=""><option value="">{t("selectContactOptional")}</option>{contactResult.items.map((contact) => <option key={contact.id} value={contact.id}>{contact.name || contact.email}</option>)}</select></label>
              <label>{t("activityDeal")} <select name="dealId" defaultValue=""><option value="">{t("selectDealOptional")}</option>{dealResult.items.map((deal) => <option key={deal.id} value={deal.id}>{deal.title}</option>)}</select></label>
              <label>{t("formOwner")} <select name="ownerUserId" defaultValue=""><option value="">{t("selectOwnerOptional")}</option>{members.map((member) => <option key={member.user.id} value={member.user.id}>{member.user.displayName || member.user.email}</option>)}</select></label>
              <label>{t("formSuggestionTitle")} <input name="title" required /></label>
              <label>{t("formSuggestionRecipient")} <input type="email" name="recipientEmail" /></label>
              <label>{t("formSuggestionSubject")} <input name="subject" /></label>
            </div>
            <label>{t("formSuggestionBody")} <MarkdownEditor name="bodyMd" placeholder={t("formSuggestionBodyPlaceholder")} rows={5} required /></label>
            <button type="submit" style={{ width: "fit-content" }}>{t("btnCreateSuggestion")}</button>
          </form>
        </details>

        {viewMode === "table" ? (
          <WorkItemTable
            columns={suggestionTableColumns}
            rows={suggestionTableRows}
            empty={<p className="muted">{t("noSuggestions")}</p>}
          />
        ) : viewMode === "kanban" ? (
          <WorkItemKanbanBoard
            columns={suggestionColumns}
            storageKey={`relationships:${workspaceId}:suggestions`}
            settingsLabel={tWork("columnSettings")}
            resetLabel={tWork("resetColumns")}
            hideLabel={tWork("hideColumn")}
            moveUpLabel={tWork("moveColumnLeft")}
            moveDownLabel={tWork("moveColumnRight")}
            hideShortLabel={tWork("hideColumnShort")}
            moveUpShortLabel={tWork("moveColumnLeftShort")}
            moveDownShortLabel={tWork("moveColumnRightShort")}
            sortLabel={tWork("sort")}
            sortPriorityLabel={tWork("sortPriority")}
            sortDateLabel={tWork("sortDate")}
            sortAlphaLabel={tWork("sortAlpha")}
            dragUnavailableLabel={tWork("dragUnavailable")}
          />
        ) : (
        <div className="stack">
          {sortedSuggestions.length === 0 ? (
            <p className="muted">{t("noSuggestions")}</p>
          ) : sortedSuggestions.map((suggestion) => (
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

        <div className="row" style={{ marginTop: 16, fontSize: "0.85rem" }}>
          <span className="muted">{t("paginationSummary", { page, pageCount, count: suggestionResult.items.length, total: suggestionResult.total })}</span>
          <div className="row" style={{ gap: 8 }}>
            {page > 1 ? <a href={previousHref} className="link-button small">{t("paginationPrevious")}</a> : <span className="tag-sm">{t("paginationPrevious")}</span>}
            {page < pageCount ? <a href={nextHref} className="link-button small">{t("paginationNext")}</a> : <span className="tag-sm">{t("paginationNext")}</span>}
          </div>
        </div>
      </section>
    </>
  );
}
