import { requirePageActor } from "@/lib/auth";
import { MarkdownEditor } from "@/lib/components/MarkdownEditor";
import { MarkdownRenderer } from "@/lib/components/MarkdownRenderer";
import { WorkItemToolbar } from "@/lib/components/WorkItemControls";
import { WorkItemTable, type WorkItemTableColumn, type WorkItemTableRow } from "@/lib/components/WorkItemTable";
import { requireWorkspaceFeature } from "@/lib/workspace-feature-flags";
import type { WorkItemViewMode } from "@/lib/work-item-view";
import {
  listContacts,
  listCrmAccounts,
  listCrmActivities,
  listDeals,
  listMembers,
  requireWorkspaceMembership,
} from "@corgtex/domain";
import type { CrmActivityType } from "@prisma/client";
import { getTranslations } from "next-intl/server";

import { completeActivityAction, createActivityAction } from "../actions";
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
  normalizeCrmViewMode,
  optionValue,
  type SearchParamsRecord,
} from "../full-page-utils";

export const dynamic = "force-dynamic";

const CRM_ACTIVITY_TYPES = ["NOTE", "EMAIL", "CALL", "MEETING", "TASK"] as const;
const ACTIVITY_COMPLETION = ["open", "completed", "all"] as const;
const ACTIVITY_SORTS = ["recent", "due"] as const;
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
  const type = optionValue(resolvedSearch.type, CRM_ACTIVITY_TYPES as readonly CrmActivityType[]);
  const completion = optionValue(resolvedSearch.completion, ACTIVITY_COMPLETION) ?? "all";
  const sort = optionValue(resolvedSearch.sort, ACTIVITY_SORTS) ?? "recent";
  const pagePath = relationshipFullPageHref(workspaceId, "activity");

  const [activityResult, accountResult, contactResult, dealResult, members] = await Promise.all([
    listCrmActivities(actor, workspaceId, {
      take: CRM_FULL_PAGE_SIZE,
      skip: crmPageOffset(page),
      type,
      completion,
      sort,
    }),
    listCrmAccounts(actor, workspaceId, { take: 200 }),
    listContacts(actor, workspaceId, { take: 200 }),
    listDeals(actor, workspaceId, { take: 200 }),
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
  const renderCompleteAction = (activity: (typeof activities)[number]) => !activity.completedAt ? (
    <form action={completeActivityAction}>
      <input type="hidden" name="workspaceId" value={workspaceId} />
      <input type="hidden" name="activityId" value={activity.id} />
      <button type="submit" className="small">{t("btnCompleteFollowUp")}</button>
    </form>
  ) : null;
  const activityTableColumns: WorkItemTableColumn[] = [
    { id: "activity", label: t("fullActivityTitle") },
    { id: "type", label: t("filterActivityType") },
    { id: "account", label: t("colAccount") },
    { id: "date", label: t("colUpdated") },
    { id: "actions", label: t("colActions"), align: "right" },
  ];
  const activityTableRows: WorkItemTableRow[] = activities.map((activity) => ({
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
    filters: crmFilters({ type, completion, sort, page, viewMode }),
    pagination: { page, pageCount, total: activityResult.total },
    visibleContext: {
      metrics: crmPageMetrics([
        { label: "activitiesVisible", value: activityResult.items.length },
        { label: "activitiesTotal", value: activityResult.total },
      ]),
      activities: activities
        .slice(0, CRM_CHAT_CONTEXT_LIMIT)
        .map((activity) => crmActivityContext(workspaceId, activity)),
    },
  };

  return (
    <>
      <CrmChatPageContext context={crmChatPageContext} />
      <header className="nr-masthead" style={{ textAlign: "left", marginBottom: 32 }}>
        <a href={relationshipDashboardHref(workspaceId)} className="muted" style={{ fontSize: "0.9rem" }}>
          {t("backToRelationships")}
        </a>
        <h1 style={{ border: "none", padding: 0, margin: "12px 0 0", fontSize: "2rem" }}>{t("fullActivityTitle")}</h1>
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

        <form method="get" className="nr-form-section" style={{ marginBottom: 20 }}>
          {viewMode !== DEFAULT_ACTIVITY_VIEW && <input type="hidden" name="view" value={viewMode} />}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
            <label>
              {t("filterActivityType")}
              <select name="type" defaultValue={type ?? ""}>
                <option value="">{t("activityTypeAll")}</option>
                {CRM_ACTIVITY_TYPES.map((option) => <option key={option} value={option}>{activityTypeLabel(option)}</option>)}
              </select>
            </label>
            <label>
              {t("filterCompletion")}
              <select name="completion" defaultValue={completion}>
                <option value="all">{t("completionAll")}</option>
                <option value="open">{t("completionOpen")}</option>
                <option value="completed">{t("completionCompleted")}</option>
              </select>
            </label>
            <label>
              {t("filterSort")}
              <select name="sort" defaultValue={sort}>
                <option value="recent">{t("sortRecent")}</option>
                <option value="due">{t("sortDue")}</option>
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
            {t("btnNewActivity")}
          </summary>
          <form action={createActivityAction} className="stack nr-form-section" style={{ marginTop: 16 }}>
            <input type="hidden" name="workspaceId" value={workspaceId} />
            <input type="hidden" name="source" value="manual" />
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 16 }}>
              <label>{t("formAccount")} <select name="accountId" required><option value="">{t("selectAccount")}</option>{accountResult.items.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label>
              <label>{t("formContact")} <select name="contactId" defaultValue=""><option value="">{t("selectContactOptional")}</option>{contactResult.items.map((contact) => <option key={contact.id} value={contact.id}>{contact.name || contact.email}</option>)}</select></label>
              <label>{t("activityDeal")} <select name="dealId" defaultValue=""><option value="">{t("selectDealOptional")}</option>{dealResult.items.map((deal) => <option key={deal.id} value={deal.id}>{deal.title}</option>)}</select></label>
              <label>{t("formActivityType")} <select name="type" defaultValue="TASK">{CRM_ACTIVITY_TYPES.map((option) => <option key={option} value={option}>{activityTypeLabel(option)}</option>)}</select></label>
              <label>{t("formActivityTitle")} <input name="title" required /></label>
              <label>{t("formDueAt")} <input type="date" name="dueAt" /></label>
              <label>{t("formOwner")} <select name="ownerUserId" defaultValue=""><option value="">{t("selectOwnerOptional")}</option>{members.map((member) => <option key={member.user.id} value={member.user.id}>{member.user.displayName || member.user.email}</option>)}</select></label>
            </div>
            <MarkdownEditor name="bodyMd" placeholder={t("formActivityBodyPlaceholder")} rows={3} />
            <button type="submit" style={{ width: "fit-content" }}>{t("btnCreateActivity")}</button>
          </form>
        </details>

        {viewMode === "table" ? (
          <WorkItemTable
            columns={activityTableColumns}
            rows={activityTableRows}
            empty={<p className="muted">{t("noActivity")}</p>}
          />
        ) : (
        <div className="stack">
          {activities.length === 0 && <p className="muted">{t("noActivity")}</p>}
          {activities.map((activity) => (
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
