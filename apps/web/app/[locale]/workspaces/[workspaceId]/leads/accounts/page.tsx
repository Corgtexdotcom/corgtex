import { requirePageActor } from "@/lib/auth";
import { MarkdownEditor } from "@/lib/components/MarkdownEditor";
import { WorkItemToolbar } from "@/lib/components/WorkItemControls";
import { WorkItemTable, type WorkItemTableColumn, type WorkItemTableRow } from "@/lib/components/WorkItemTable";
import { requireWorkspaceFeature } from "@/lib/workspace-feature-flags";
import type { WorkItemViewMode } from "@/lib/work-item-view";
import { listCrmAccounts, listCrmActivities, listDeals, requireWorkspaceMembership } from "@corgtex/domain";
import { getTranslations } from "next-intl/server";

import { createCrmAccountAction } from "../actions";
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
  normalizeCrmViewMode,
  optionValue,
  searchValue,
  type SearchParamsRecord,
} from "../full-page-utils";

export const dynamic = "force-dynamic";
const ACCOUNT_VIEW_MODES = ["table", "list"] as const;
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
  const relationshipType = optionValue(resolvedSearch.relationshipType, CRM_RELATIONSHIP_OPTIONS);
  const lifecycleStage = optionValue(resolvedSearch.lifecycleStage, CRM_LIFECYCLE_OPTIONS);
  const pagePath = relationshipFullPageHref(workspaceId, "accounts");

  const [accountResult, dealResult, activityResult] = await Promise.all([
    listCrmAccounts(actor, workspaceId, {
      take: CRM_FULL_PAGE_SIZE,
      skip: crmPageOffset(page),
      query: query || undefined,
      relationshipType,
      lifecycleStage,
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
  const accountTableColumns: WorkItemTableColumn[] = [
    { id: "account", label: t("colAccount") },
    { id: "relationship", label: t("colRelationship") },
    { id: "counts", label: t("colCounts") },
    { id: "pipeline", label: t("accountPipeline") },
    { id: "updated", label: t("colUpdated") },
    { id: "actions", label: t("colActions"), align: "right" },
  ];
  const accountTableRows: WorkItemTableRow[] = accountResult.items.map((account) => {
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
        actions: <a href={accountHref(workspaceId, account.id)} className="link-button small">{t("openDetail")}</a>,
      },
    };
  });
  const crmChatPageContext = {
    surface: "crm" as const,
    workspaceId,
    view: "accounts",
    section: "accounts",
    selectedIds: {},
    filters: crmFilters({ q: query, relationshipType, lifecycleStage, page, viewMode }),
    pagination: { page, pageCount, total: accountResult.total },
    visibleContext: {
      metrics: crmPageMetrics([
        { label: "accountsVisible", value: accountResult.items.length },
        { label: "accountsTotal", value: accountResult.total },
      ]),
      accounts: accountResult.items
        .slice(0, CRM_CHAT_CONTEXT_LIMIT)
        .map((account) => crmAccountContext(workspaceId, account)),
    },
  };

  return (
    <>
      <CrmChatPageContext context={crmChatPageContext} />
      <header className="nr-masthead" style={{ textAlign: "left", marginBottom: 32 }}>
        <a href={relationshipDashboardHref(workspaceId)} className="muted" style={{ fontSize: "0.9rem" }}>
          {t("backToRelationships")}
        </a>
        <h1 style={{ border: "none", padding: 0, margin: "12px 0 0", fontSize: "2rem" }}>{t("fullAccountsTitle")}</h1>
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

        <form method="get" className="nr-form-section" style={{ marginBottom: 20 }}>
          {viewMode !== DEFAULT_ACCOUNT_VIEW && <input type="hidden" name="view" value={viewMode} />}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
            <label>{t("filterSearch")} <input name="q" defaultValue={query} /></label>
            <label>
              {t("filterRelationship")}
              <select name="relationshipType" defaultValue={relationshipType ?? ""}>
                <option value="">{t("filterAny")}</option>
                {CRM_RELATIONSHIP_OPTIONS.map((option) => <option key={option} value={option}>{relationshipLabel(option)}</option>)}
              </select>
            </label>
            <label>
              {t("filterLifecycle")}
              <select name="lifecycleStage" defaultValue={lifecycleStage ?? ""}>
                <option value="">{t("filterAny")}</option>
                {CRM_LIFECYCLE_OPTIONS.map((option) => <option key={option} value={option}>{lifecycleLabel(option)}</option>)}
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
            {t("btnNewAccount")}
          </summary>
          <form action={createCrmAccountAction} className="stack nr-form-section" style={{ marginTop: 16 }}>
            <input type="hidden" name="workspaceId" value={workspaceId} />
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 16 }}>
              <label>{t("formAccountName")} <input type="text" name="name" required /></label>
              <label>{t("formDomain")} <input type="text" name="domain" placeholder={t("formDomainPlaceholder")} /></label>
              <label>{t("formRelationshipType")} <select name="relationshipType" defaultValue="PROSPECT">{CRM_RELATIONSHIP_OPTIONS.map((option) => <option key={option} value={option}>{relationshipLabel(option)}</option>)}</select></label>
              <label>{t("formLifecycleStage")} <select name="lifecycleStage" defaultValue="DISCOVERY">{CRM_LIFECYCLE_OPTIONS.map((option) => <option key={option} value={option}>{lifecycleLabel(option)}</option>)}</select></label>
            </div>
            <label>{t("formDescription")} <MarkdownEditor name="descriptionMd" placeholder={t("formDescriptionPlaceholder")} rows={3} /></label>
            <button type="submit" style={{ width: "fit-content" }}>{t("btnCreateAccount")}</button>
          </form>
        </details>

        {viewMode === "table" ? (
          <WorkItemTable
            columns={accountTableColumns}
            rows={accountTableRows}
            empty={<p className="muted">{t("noAccounts")}</p>}
          />
        ) : (
          <div className="stack">
            {accountResult.items.length === 0 && <p className="muted">{t("noAccounts")}</p>}
            {accountResult.items.map((account) => {
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
