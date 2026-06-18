import { requirePageActor } from "@/lib/auth";
import { MarkdownEditor } from "@/lib/components/MarkdownEditor";
import { requireWorkspaceFeature } from "@/lib/workspace-feature-flags";
import { listCrmAccounts, listCrmActivities, listDeals, requireWorkspaceMembership } from "@corgtex/domain";
import { getTranslations } from "next-intl/server";

import { createCrmAccountAction } from "../actions";
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
  normalizeCrmPage,
  optionValue,
  searchValue,
  type SearchParamsRecord,
} from "../full-page-utils";

export const dynamic = "force-dynamic";

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
  const resolvedSearch = searchParams ? await searchParams : {};
  const page = normalizeCrmPage(resolvedSearch.page);
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

  return (
    <>
      <header className="nr-masthead" style={{ textAlign: "left", marginBottom: 32 }}>
        <a href={relationshipDashboardHref(workspaceId)} className="muted" style={{ fontSize: "0.9rem" }}>
          {t("backToRelationships")}
        </a>
        <h1 style={{ border: "none", padding: 0, margin: "12px 0 0", fontSize: "2rem" }}>{t("fullAccountsTitle")}</h1>
        <div className="nr-masthead-meta"><span>{t("fullAccountsDescription")}</span></div>
      </header>

      <section className="ws-section">
        <RelationshipNav workspaceId={workspaceId} active="accounts" labels={relationshipNavLabels(t)} />

        <form method="get" className="nr-form-section" style={{ marginBottom: 20 }}>
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
            <a href={pagePath} className="link-button small">{t("filterClear")}</a>
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

        <div className="nr-table-wrap">
          <table className="nr-table nr-work-item-table">
            <thead>
              <tr>
                <th>{t("colAccount")}</th>
                <th>{t("colRelationship")}</th>
                <th>{t("colCounts")}</th>
                <th>{t("accountPipeline")}</th>
                <th>{t("colUpdated")}</th>
                <th className="nr-table-cell-right">{t("colActions")}</th>
              </tr>
            </thead>
            <tbody>
              {accountResult.items.map((account) => {
                const accountDeals = dealsByAccountId.get(account.id) ?? [];
                const pipelineValue = activePipelineValueCents(accountDeals);
                const lastActivity = lastActivityByAccountId.get(account.id);
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
                      </div>
                    </td>
                    <td data-label={t("colCounts")}>{t("accountContactsCount", { count: account._count.contacts })} · {t("accountDealsCount", { count: account._count.deals })}</td>
                    <td data-label={t("accountPipeline")}><strong>{formatCurrency(pipelineValue)}</strong></td>
                    <td data-label={t("colUpdated")} className="muted">
                      {lastActivity ? t("accountLastActivity", { title: lastActivity.title, age: formatDate(lastActivity.createdAt) }) : formatDate(account.updatedAt)}
                    </td>
                    <td data-label={t("colActions")} className="nr-table-cell-right">
                      <a href={accountHref(workspaceId, account.id)} className="link-button small">{t("openDetail")}</a>
                    </td>
                  </tr>
                );
              })}
              {accountResult.items.length === 0 && (
                <tr><td colSpan={6} className="nr-table-cell-center muted">{t("noAccounts")}</td></tr>
              )}
            </tbody>
          </table>
        </div>

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
