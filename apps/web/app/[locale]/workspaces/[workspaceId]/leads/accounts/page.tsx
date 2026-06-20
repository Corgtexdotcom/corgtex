import { requirePageActor } from "@/lib/auth";
import { MultiSelectFilter } from "@/lib/components/MultiSelectFilter";
import { WorkItemToolbar } from "@/lib/components/WorkItemControls";
import { WorkItemTable, type WorkItemTableColumn, type WorkItemTableRow } from "@/lib/components/WorkItemTable";
import { requireWorkspaceFeature } from "@/lib/workspace-feature-flags";
import type { WorkItemViewMode } from "@/lib/work-item-view";
import { listCrmAccounts, listCrmActivities, listDeals, requireWorkspaceMembership } from "@corgtex/domain";
import { ExternalLink } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { CrmTableSortHeader } from "../CrmTableSortHeader";
import { CrmChatPageContext } from "../CrmChatPageContext";
import {
  CRM_CHAT_CONTEXT_LIMIT,
  crmAccountContext,
  crmFilters,
  crmPageMetrics,
} from "../chat-page-context";
import {
  CRM_LIFECYCLE_OPTIONS,
  CRM_RELATIONSHIP_OPTIONS,
  accountHref,
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
  normalizeCrmSortDirection,
  normalizeCrmViewMode,
  optionValue,
  optionValues,
  searchValue,
  type SearchParamsRecord,
} from "../full-page-utils";

export const dynamic = "force-dynamic";
const ACCOUNT_VIEW_MODES = ["table", "list"] as const;
const ACCOUNT_SORTS = ["name", "relationship", "pipeline", "updated"] as const;
const DEFAULT_ACCOUNT_VIEW = "table";

export default async function RelationshipAccountsPage({
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
  const viewMode = normalizeCrmViewMode(resolvedSearch.view, ACCOUNT_VIEW_MODES, DEFAULT_ACCOUNT_VIEW);
  const query = searchValue(resolvedSearch, "q").trim();
  const relationshipTypes = optionValues(resolvedSearch.relationshipType, CRM_RELATIONSHIP_OPTIONS);
  const lifecycleStages = optionValues(resolvedSearch.lifecycleStage, CRM_LIFECYCLE_OPTIONS);
  const sort = optionValue(resolvedSearch.sort, ACCOUNT_SORTS) ?? "updated";
  const sortDirection = normalizeCrmSortDirection(resolvedSearch.dir, sort === "updated" ? "desc" : "asc");
  const pagePath = relationshipFullPageHref(workspaceId, "accounts");

  const [accountResult, dealResult, activityResult] = await Promise.all([
    listCrmAccounts(actor, workspaceId, {
      take: CRM_FULL_PAGE_SIZE,
      skip: crmPageOffset(page),
      query: query || undefined,
      relationshipTypes,
      lifecycleStages,
    }),
    listDeals(actor, workspaceId, { take: 500 }),
    listCrmActivities(actor, workspaceId, { take: 500 }),
  ]);

  const dealsByAccountId = new Map<string, typeof dealResult.items>();
  for (const deal of dealResult.items) {
    if (!deal.accountId) continue;
    dealsByAccountId.set(deal.accountId, [...(dealsByAccountId.get(deal.accountId) ?? []), deal]);
  }
  const lastActivityByAccountId = new Map<string, (typeof activityResult.items)[number]>();
  for (const activity of activityResult.items) {
    if (activity.accountId && !lastActivityByAccountId.has(activity.accountId)) {
      lastActivityByAccountId.set(activity.accountId, activity);
    }
  }

  const formatCurrency = (cents: number) => new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(cents / 100);
  const formatDate = (value: Date | string) => new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
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
  const pageCount = crmPageCount(accountResult.total);
  const previousHref = crmPageHref(pagePath, resolvedSearch, { page: Math.max(page - 1, 1) });
  const nextHref = crmPageHref(pagePath, resolvedSearch, { page: Math.min(page + 1, pageCount) });
  const clearHref = crmPageHref(pagePath, {}, { view: viewMode === DEFAULT_ACCOUNT_VIEW ? null : viewMode });
  const directionFactor = sortDirection === "asc" ? 1 : -1;
  const compareText = (left?: string | null, right?: string | null) => (
    (left || "").localeCompare(right || "", locale, { sensitivity: "base" }) * directionFactor
  );
  const compareNumber = (left: number, right: number) => (left - right) * directionFactor;
  const compareDate = (left: Date | string, right: Date | string) => (
    (new Date(left).getTime() - new Date(right).getTime()) * directionFactor
  );
  const accountSortLabel = (account: (typeof accountResult.items)[number]) => (
    `${relationshipLabel(account.relationshipType)} ${lifecycleLabel(account.lifecycleStage)}`
  );
  const accountUpdatedAt = (account: (typeof accountResult.items)[number]) => (
    lastActivityByAccountId.get(account.id)?.createdAt ?? account.updatedAt
  );
  const sortedAccounts = [...accountResult.items].sort((left, right) => {
    if (sort === "name") return compareText(left.name, right.name);
    if (sort === "relationship") return compareText(accountSortLabel(left), accountSortLabel(right));
    if (sort === "pipeline") {
      return compareNumber(
        activePipelineValueCents(dealsByAccountId.get(left.id) ?? []),
        activePipelineValueCents(dealsByAccountId.get(right.id) ?? []),
      );
    }
    return compareDate(accountUpdatedAt(left), accountUpdatedAt(right));
  });
  const accountTableColumns: WorkItemTableColumn[] = [
    {
      id: "account",
      label: (
        <CrmTableSortHeader
          label={t("colAccount")}
          sortKey="name"
          activeSort={sort}
          direction={sortDirection}
          path={pagePath}
          current={resolvedSearch}
        />
      ),
      mobileLabel: t("colAccount"),
    },
    {
      id: "relationship",
      label: (
        <CrmTableSortHeader
          label={t("colRelationship")}
          sortKey="relationship"
          activeSort={sort}
          direction={sortDirection}
          path={pagePath}
          current={resolvedSearch}
        />
      ),
      mobileLabel: t("colRelationship"),
    },
    { id: "counts", label: t("colCounts") },
    {
      id: "pipeline",
      label: (
        <CrmTableSortHeader
          label={t("accountPipeline")}
          sortKey="pipeline"
          activeSort={sort}
          direction={sortDirection}
          path={pagePath}
          current={resolvedSearch}
        />
      ),
      mobileLabel: t("accountPipeline"),
    },
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
    { id: "actions", label: t("colActions"), align: "right" },
  ];
  const accountTableRows: WorkItemTableRow[] = sortedAccounts.map((account) => {
    const accountDeals = dealsByAccountId.get(account.id) ?? [];
    const pipelineValue = activePipelineValueCents(accountDeals);
    const lastActivity = lastActivityByAccountId.get(account.id);
    return {
      id: account.id,
      cells: {
        account: (
          <>
            <a href={accountHref(workspaceId, account.id)} className="nr-work-item-table-title">{account.name}</a>
            <div className="nr-work-item-table-meta">{account.domain || t("noDomain")}</div>
          </>
        ),
        relationship: (
          <div className="nr-work-item-table-tags">
            <span className="tag-sm">{relationshipLabel(account.relationshipType)}</span>
            <span className="tag-sm">{lifecycleLabel(account.lifecycleStage)}</span>
          </div>
        ),
        counts: <>{t("accountContactsCount", { count: account._count.contacts })} · {t("accountDealsCount", { count: account._count.deals })}</>,
        pipeline: <strong>{formatCurrency(pipelineValue)}</strong>,
        updated: (
          <span className="muted">
            {lastActivity ? t("accountLastActivity", { title: lastActivity.title, age: formatDate(lastActivity.createdAt) }) : formatDate(account.updatedAt)}
          </span>
        ),
        actions: (
          <a
            href={accountHref(workspaceId, account.id)}
            className="nr-icon-link nr-table-action"
            aria-label={t("openDetail")}
            title={t("openDetail")}
          >
            <ExternalLink size={15} aria-hidden="true" />
          </a>
        ),
      },
    };
  });
  const crmChatPageContext = {
    surface: "crm" as const,
    workspaceId,
    view: "accounts",
    section: "accounts",
    selectedIds: {},
    filters: crmFilters({ q: query, relationshipType: relationshipTypes.join(","), lifecycleStage: lifecycleStages.join(","), page, viewMode, sort, dir: sortDirection }),
    pagination: { page, pageCount, total: accountResult.total },
    visibleContext: {
      metrics: crmPageMetrics([
        { label: "accountsVisible", value: accountResult.items.length },
        { label: "accountsTotal", value: accountResult.total },
      ]),
      accounts: sortedAccounts
        .slice(0, CRM_CHAT_CONTEXT_LIMIT)
        .map((account) => crmAccountContext(workspaceId, account)),
    },
  };

  return (
    <>
      <CrmChatPageContext context={crmChatPageContext} />
      <header className="nr-masthead nr-crm-masthead">
        <a href={relationshipDashboardHref(workspaceId)} className="nr-crm-back-link">
          {t("backToRelationships")}
        </a>
        <h1>{t("fullAccountsTitle")}</h1>
        <div className="nr-masthead-meta"><span>{t("fullAccountsDescription")}</span></div>
      </header>

      <section className="ws-section">
        <div className="nr-work-board-header">
          <RelationshipNav workspaceId={workspaceId} active="accounts" labels={relationshipNavLabels(t)} />
          <WorkItemToolbar
            currentView={viewMode as WorkItemViewMode}
            currentSort="priority"
            listHref={crmViewHref(pagePath, resolvedSearch, "list", DEFAULT_ACCOUNT_VIEW)}
            tableHref={crmViewHref(pagePath, resolvedSearch, "table", DEFAULT_ACCOUNT_VIEW)}
            sortLinks={{ priority: pagePath, date: pagePath, alpha: pagePath }}
            listLabel={tWork("listView")}
            kanbanLabel={tWork("kanbanView")}
            tableLabel={tWork("tableView")}
            sortLabel={tWork("sort")}
            sortPriorityLabel={tWork("sortPriority")}
            sortDateLabel={tWork("sortDate")}
            sortAlphaLabel={tWork("sortAlpha")}
            label={tWork("viewMode")}
            availableViews={["table", "list"]}
            showSort={false}
          />
        </div>

        <form method="get" className="nr-filter-panel nr-crm-filter-panel">
          {viewMode !== DEFAULT_ACCOUNT_VIEW && <input type="hidden" name="view" value={viewMode} />}
          <input type="hidden" name="sort" value={sort} />
          {sortDirection !== "asc" && <input type="hidden" name="dir" value={sortDirection} />}
          <label>
            <span className="nr-item-meta">{t("filterSearch")}</span>
            <input name="q" defaultValue={query} />
          </label>
          <MultiSelectFilter
            name="relationshipType"
            label={t("filterRelationship")}
            options={CRM_RELATIONSHIP_OPTIONS.map((option) => ({ value: option, label: relationshipLabel(option) }))}
            selectedValues={relationshipTypes}
            allLabel={t("filterAny")}
            selectAllLabel={tWork("selectAll")}
            unselectAllLabel={tWork("unselectAll")}
            selectedCountLabel={tWork("selectedCount", { count: "{count}" })}
          />
          <MultiSelectFilter
            name="lifecycleStage"
            label={t("filterLifecycle")}
            options={CRM_LIFECYCLE_OPTIONS.map((option) => ({ value: option, label: lifecycleLabel(option) }))}
            selectedValues={lifecycleStages}
            allLabel={t("filterAny")}
            selectAllLabel={tWork("selectAll")}
            unselectAllLabel={tWork("unselectAll")}
            selectedCountLabel={tWork("selectedCount", { count: "{count}" })}
          />
          <div className="nr-crm-filter-actions">
            <button type="submit" className="small">{t("filterApply")}</button>
            <a href={clearHref} className="link-button small">{t("filterClear")}</a>
          </div>
        </form>

        {viewMode === "table" ? (
          <WorkItemTable
            columns={accountTableColumns}
            rows={accountTableRows}
            empty={<p className="muted">{t("noAccounts")}</p>}
          />
        ) : (
          <div className="stack">
            {sortedAccounts.length === 0 && <p className="muted">{t("noAccounts")}</p>}
            {sortedAccounts.map((account) => {
              const accountDeals = dealsByAccountId.get(account.id) ?? [];
              const pipelineValue = activePipelineValueCents(accountDeals);
              const lastActivity = lastActivityByAccountId.get(account.id);
              return (
                <a key={account.id} href={accountHref(workspaceId, account.id)} className="item nr-clickable-card" style={{ display: "grid", gap: 10, color: "inherit", textDecoration: "none" }}>
                  <div className="row" style={{ alignItems: "flex-start", gap: 10 }}>
                    <div style={{ minWidth: 0 }}>
                      <strong>{account.name}</strong>
                      <div className="muted" style={{ fontSize: "0.84rem", marginTop: 4 }}>{account.domain || t("noDomain")}</div>
                    </div>
                    <span className="tag-sm" style={{ marginLeft: "auto" }}>{formatCurrency(pipelineValue)}</span>
                  </div>
                  <div className="nr-tag-group">
                    <span className="tag-sm">{relationshipLabel(account.relationshipType)}</span>
                    <span className="tag-sm">{lifecycleLabel(account.lifecycleStage)}</span>
                    <span className="tag-sm">{t("accountContactsCount", { count: account._count.contacts })}</span>
                    <span className="tag-sm">{t("accountDealsCount", { count: account._count.deals })}</span>
                  </div>
                  <div className="muted" style={{ fontSize: "0.82rem" }}>
                    {lastActivity ? t("accountLastActivity", { title: lastActivity.title, age: formatDate(lastActivity.createdAt) }) : formatDate(account.updatedAt)}
                  </div>
                </a>
              );
            })}
          </div>
        )}

        <div className="row" style={{ marginTop: 16, fontSize: "0.85rem" }}>
          <span className="muted">{t("paginationSummary", { page, pageCount, count: accountResult.items.length, total: accountResult.total })}</span>
          <div className="row" style={{ gap: 8 }}>
            {page > 1 ? <a href={previousHref} className="link-button small">{t("paginationPrevious")}</a> : <span className="tag-sm">{t("paginationPrevious")}</span>}
            {page < pageCount ? <a href={nextHref} className="link-button small">{t("paginationNext")}</a> : <span className="tag-sm">{t("paginationNext")}</span>}
          </div>
        </div>
      </section>
    </>
  );
}
