import { requirePageActor } from "@/lib/auth";
import { MarkdownRenderer } from "@/lib/components/MarkdownRenderer";
import { MultiSelectFilter } from "@/lib/components/MultiSelectFilter";
import { WorkItemToolbar } from "@/lib/components/WorkItemControls";
import { WorkItemTable, type WorkItemTableColumn, type WorkItemTableRow } from "@/lib/components/WorkItemTable";
import { requireWorkspaceFeature } from "@/lib/workspace-feature-flags";
import type { WorkItemViewMode } from "@/lib/work-item-view";
import {
  listCrmActivities,
  listMembers,
  requireWorkspaceMembership,
} from "@corgtex/domain";
import type { CrmActivityType } from "@prisma/client";
import { getTranslations } from "next-intl/server";

import { completeActivityAction } from "../actions";
import { CrmTableSortHeader } from "../CrmTableSortHeader";
import { CrmChatPageContext } from "../CrmChatPageContext";
import {
  CRM_CHAT_CONTEXT_LIMIT,
  crmActivityContext,
  crmFilters,
  crmPageMetrics,
} from "../chat-page-context";
import { accountHref, labelFromCrmCode, relationshipDashboardHref, relationshipFullPageHref } from "../view-model";
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
  optionValues,
  type SearchParamsRecord,
} from "../full-page-utils";

export const dynamic = "force-dynamic";

const CRM_ACTIVITY_TYPES = ["NOTE", "EMAIL", "CALL", "MEETING", "TASK"] as const;
const ACTIVITY_COMPLETION = ["open", "completed", "all"] as const;
const ACTIVITY_SORTS = ["recent", "due", "date", "type", "account"] as const;
const ACTIVITY_VIEW_MODES = ["list", "table"] as const;
const DEFAULT_ACTIVITY_VIEW = "list";

type ActivityContext = {
  account?: { id: string; name: string } | null;
  contact?: { id: string; name?: string | null; email: string } | null;
  deal?: { id: string; title: string } | null;
};

export default async function RelationshipActivityPage({
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
  const viewMode = normalizeCrmViewMode(resolvedSearch.view, ACTIVITY_VIEW_MODES, DEFAULT_ACTIVITY_VIEW);
  const types = optionValues(resolvedSearch.type, CRM_ACTIVITY_TYPES as readonly CrmActivityType[]);
  const completions = optionValues(resolvedSearch.completion, ACTIVITY_COMPLETION);
  const sort = optionValue(resolvedSearch.sort, ACTIVITY_SORTS) ?? "recent";
  const defaultSortDirection = sort === "recent" || sort === "date" ? "desc" : "asc";
  const sortDirection = normalizeCrmSortDirection(resolvedSearch.dir, defaultSortDirection);
  const pagePath = relationshipFullPageHref(workspaceId, "activity");

  const [activityResult, members] = await Promise.all([
    listCrmActivities(actor, workspaceId, {
      take: CRM_FULL_PAGE_SIZE,
      skip: crmPageOffset(page),
      types,
      completions,
      sort: sort === "due" ? "due" : "recent",
    }),
    listMembers(workspaceId),
  ]);
  const activities = activityResult.items as Array<(typeof activityResult.items)[number] & ActivityContext>;
  const memberNames = new Map(members.map((member) => [member.user.id, member.user.displayName || member.user.email]));

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
  const activityTypeLabel = (value: string) => {
    const labels: Record<string, string> = {
      EMAIL: t("activityTypeEmail"),
      MEETING: t("activityTypeMeeting"),
      CALL: t("activityTypeCall"),
      NOTE: t("activityTypeNote"),
      TASK: t("activityTypeTask"),
    };
    return labels[value] ?? labelFromCrmCode(value);
  };
  const activityIcon = (value: string) => {
    const labels: Record<string, string> = {
      EMAIL: t("activityIconEmail"),
      MEETING: t("activityIconMeeting"),
      CALL: t("activityIconCall"),
      NOTE: t("activityIconNote"),
      TASK: t("activityIconTask"),
    };
    return labels[value] ?? t("activityIconDefault");
  };
  const accountLink = (account?: { id: string; name: string } | null) => (
    account ? <a href={accountHref(workspaceId, account.id)}>{account.name}</a> : <span className="muted">{t("emptyAccount")}</span>
  );
  const pageCount = crmPageCount(activityResult.total);
  const previousHref = crmPageHref(pagePath, resolvedSearch, { page: Math.max(page - 1, 1) });
  const nextHref = crmPageHref(pagePath, resolvedSearch, { page: Math.min(page + 1, pageCount) });
  const clearHref = crmPageHref(pagePath, {}, { view: viewMode === DEFAULT_ACTIVITY_VIEW ? null : viewMode });
  const directionFactor = sortDirection === "asc" ? 1 : -1;
  const compareText = (left?: string | null, right?: string | null) => (
    (left || "").localeCompare(right || "", locale, { sensitivity: "base" }) * directionFactor
  );
  const compareDate = (left: Date | string, right: Date | string) => (
    (new Date(left).getTime() - new Date(right).getTime()) * directionFactor
  );
  const sortedActivities = sort === "date" ? [...activities].sort((left, right) => compareDate(left.createdAt, right.createdAt))
    : sort === "type" ? [...activities].sort((left, right) => compareText(activityTypeLabel(left.type), activityTypeLabel(right.type)))
      : sort === "account" ? [...activities].sort((left, right) => compareText(left.account?.name, right.account?.name))
        : activities;
  const tableActiveSort = sort === "recent" ? "date" : sort;
  const tableSortDirection = sort === "recent" ? "desc" : sortDirection;
  const renderCompleteAction = (activity: (typeof activities)[number]) => !activity.completedAt ? (
    <form action={completeActivityAction}>
      <input type="hidden" name="workspaceId" value={workspaceId} />
      <input type="hidden" name="activityId" value={activity.id} />
      <button type="submit" className="small">{t("btnCompleteFollowUp")}</button>
    </form>
  ) : null;
  const activityTableColumns: WorkItemTableColumn[] = [
    { id: "activity", label: t("fullActivityTitle") },
    {
      id: "type",
      label: (
        <CrmTableSortHeader
          label={t("filterActivityType")}
          sortKey="type"
          activeSort={tableActiveSort}
          direction={tableSortDirection}
          path={pagePath}
          current={resolvedSearch}
        />
      ),
      mobileLabel: t("filterActivityType"),
    },
    {
      id: "account",
      label: (
        <CrmTableSortHeader
          label={t("colAccount")}
          sortKey="account"
          activeSort={tableActiveSort}
          direction={tableSortDirection}
          path={pagePath}
          current={resolvedSearch}
        />
      ),
      mobileLabel: t("colAccount"),
    },
    {
      id: "date",
      label: (
        <CrmTableSortHeader
          label={t("colUpdated")}
          sortKey="date"
          activeSort={tableActiveSort}
          direction={tableSortDirection}
          defaultDirection="desc"
          path={pagePath}
          current={resolvedSearch}
        />
      ),
      mobileLabel: t("colUpdated"),
    },
    { id: "actions", label: t("colActions"), align: "right" },
  ];
  const activityTableRows: WorkItemTableRow[] = sortedActivities.map((activity) => ({
    id: activity.id,
    cells: {
      activity: (
        <>
          <strong>{activity.title}</strong>
          <div className="nr-work-item-table-meta">
            {activity.dueAt ? t("followUpDue", { date: formatDate(activity.dueAt) }) : ageText(activity.createdAt)}
          </div>
        </>
      ),
      type: <span className="tag-sm">{activityTypeLabel(activity.type)}</span>,
      account: accountLink(activity.account),
      date: <span className="muted">{ageText(activity.createdAt)}</span>,
      actions: renderCompleteAction(activity),
    },
  }));
  const crmChatPageContext = {
    surface: "crm" as const,
    workspaceId,
    view: "activity",
    section: "activity",
    selectedIds: {},
    filters: crmFilters({ type: types.join(","), completion: completions.join(","), sort, dir: sortDirection, page, viewMode }),
    pagination: { page, pageCount, total: activityResult.total },
    visibleContext: {
      metrics: crmPageMetrics([
        { label: "activitiesVisible", value: activityResult.items.length },
        { label: "activitiesTotal", value: activityResult.total },
      ]),
      activities: sortedActivities
        .slice(0, CRM_CHAT_CONTEXT_LIMIT)
        .map((activity) => crmActivityContext(workspaceId, activity)),
    },
  };

  return (
    <>
      <CrmChatPageContext context={crmChatPageContext} />
      <header className="nr-masthead nr-crm-masthead">
        <a href={relationshipDashboardHref(workspaceId)} className="nr-crm-back-link">
          {t("backToRelationships")}
        </a>
        <h1>{t("fullActivityTitle")}</h1>
        <div className="nr-masthead-meta"><span>{t("fullActivityDescription")}</span></div>
      </header>

      <section className="ws-section">
        <div className="nr-work-board-header">
          <RelationshipNav workspaceId={workspaceId} active="activity" labels={relationshipNavLabels(t)} />
          <WorkItemToolbar
            currentView={viewMode as WorkItemViewMode}
            currentSort="priority"
            listHref={crmViewHref(pagePath, resolvedSearch, "list", DEFAULT_ACTIVITY_VIEW)}
            tableHref={crmViewHref(pagePath, resolvedSearch, "table", DEFAULT_ACTIVITY_VIEW)}
            sortLinks={{ priority: pagePath, date: pagePath, alpha: pagePath }}
            listLabel={tWork("listView")}
            kanbanLabel={tWork("kanbanView")}
            tableLabel={tWork("tableView")}
            sortLabel={tWork("sort")}
            sortPriorityLabel={tWork("sortPriority")}
            sortDateLabel={tWork("sortDate")}
            sortAlphaLabel={tWork("sortAlpha")}
            label={tWork("viewMode")}
            availableViews={["list", "table"]}
            showSort={false}
          />
        </div>

        <form method="get" className="nr-filter-panel nr-crm-filter-panel">
          {viewMode !== DEFAULT_ACTIVITY_VIEW && <input type="hidden" name="view" value={viewMode} />}
          {sortDirection !== defaultSortDirection && <input type="hidden" name="dir" value={sortDirection} />}
          <MultiSelectFilter
            name="type"
            label={t("filterActivityType")}
            options={CRM_ACTIVITY_TYPES.map((option) => ({ value: option, label: activityTypeLabel(option) }))}
            selectedValues={types}
            allLabel={t("activityTypeAll")}
            selectAllLabel={tWork("selectAll")}
            unselectAllLabel={tWork("unselectAll")}
            selectedCountLabel={tWork("selectedCount", { count: "{count}" })}
          />
          <MultiSelectFilter
            name="completion"
            label={t("filterCompletion")}
            options={[
              { value: "open", label: t("completionOpen") },
              { value: "completed", label: t("completionCompleted") },
            ]}
            selectedValues={completions.filter((value) => value !== "all")}
            allLabel={t("completionAll")}
            selectAllLabel={tWork("selectAll")}
            unselectAllLabel={tWork("unselectAll")}
            selectedCountLabel={tWork("selectedCount", { count: "{count}" })}
          />
          <label>
            <span className="nr-item-meta">{t("filterSort")}</span>
            <select name="sort" defaultValue={sort}>
              <option value="recent">{t("sortRecent")}</option>
              <option value="due">{t("sortDue")}</option>
              <option value="date">{t("colUpdated")}</option>
              <option value="type">{t("filterActivityType")}</option>
              <option value="account">{t("colAccount")}</option>
            </select>
          </label>
          <div className="nr-crm-filter-actions">
            <button type="submit" className="small">{t("filterApply")}</button>
            <a href={clearHref} className="link-button small">{t("filterClear")}</a>
          </div>
        </form>

        {viewMode === "table" ? (
          <WorkItemTable
            columns={activityTableColumns}
            rows={activityTableRows}
            empty={<p className="muted">{t("noActivity")}</p>}
          />
        ) : (
        <div className="stack">
          {sortedActivities.length === 0 && <p className="muted">{t("noActivity")}</p>}
          {sortedActivities.map((activity) => (
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
                  {activity.contact && <span className="muted">{t("activityContact")} <strong>{activity.contact.name || activity.contact.email}</strong></span>}
                  {activity.deal && <span className="muted">{t("activityDeal")} <strong>{activity.deal.title}</strong></span>}
                  <span className="muted">{t("pipelineOwner")}: {activity.ownerUserId ? memberNames.get(activity.ownerUserId) ?? t("pipelineNoOwner") : t("pipelineNoOwner")}</span>
                  {activity.dueAt && <span className="muted">{t("followUpDue", { date: formatDate(activity.dueAt) })}</span>}
                  {activity.completedAt && <span className="muted">{t("followUpCompleted", { date: formatDate(activity.completedAt) })}</span>}
                </div>
                <div style={{ marginTop: 10 }}>{renderCompleteAction(activity)}</div>
              </div>
            </div>
          ))}
        </div>
        )}

        <div className="row" style={{ marginTop: 16, fontSize: "0.85rem" }}>
          <span className="muted">{t("paginationSummary", { page, pageCount, count: activityResult.items.length, total: activityResult.total })}</span>
          <div className="row" style={{ gap: 8 }}>
            {page > 1 ? <a href={previousHref} className="link-button small">{t("paginationPrevious")}</a> : <span className="tag-sm">{t("paginationPrevious")}</span>}
            {page < pageCount ? <a href={nextHref} className="link-button small">{t("paginationNext")}</a> : <span className="tag-sm">{t("paginationNext")}</span>}
          </div>
        </div>
      </section>
    </>
  );
}
