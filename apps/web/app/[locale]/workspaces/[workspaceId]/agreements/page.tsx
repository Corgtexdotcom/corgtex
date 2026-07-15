import Link from "next/link";
import { listWorkspaceAgreements } from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";
import { MarkdownExcerpt, MarkdownRenderer } from "@/lib/components/MarkdownRenderer";
import { getTranslations } from "next-intl/server";

export const dynamic = "force-dynamic";

const AGREEMENT_CATEGORIES = ["all", "policies", "working-agreements", "constitution"] as const;
type AgreementCategory = (typeof AGREEMENT_CATEGORIES)[number];
type AgreementScope = "all" | "workspace" | string;

function formatDate(value: Date | string | null | undefined) {
  if (!value) return null;
  return new Date(value).toLocaleDateString();
}

function formatEnumLabel(value: string) {
  return value
    .toLowerCase()
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function firstSearchValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function normalizeCategory(value: string | string[] | undefined): AgreementCategory {
  const category = firstSearchValue(value);
  return AGREEMENT_CATEGORIES.includes(category as AgreementCategory) ? category as AgreementCategory : "all";
}

function normalizeScope(value: string | string[] | undefined, validScopeIds: Set<string>): AgreementScope {
  const scope = firstSearchValue(value);
  return scope && validScopeIds.has(scope) ? scope : "all";
}

function agreementsHref(workspaceId: string, params: { category?: AgreementCategory; scope?: AgreementScope }) {
  const search = new URLSearchParams();
  if (params.category && params.category !== "all") search.set("category", params.category);
  if (params.category === "policies" && params.scope && params.scope !== "all") search.set("scope", params.scope);
  const query = search.toString();
  return `/workspaces/${workspaceId}/agreements${query ? `?${query}` : ""}`;
}

export default async function AgreementsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const resolvedSearch = searchParams ? await searchParams : {};
  const actor = await requirePageActor();
  const t = await getTranslations("agreements");
  const agreements = await listWorkspaceAgreements(actor, { workspaceId });
  const currentConstitution = agreements.currentConstitution;
  const category = normalizeCategory(resolvedSearch.category);
  const workspacePolicyCount = agreements.policyCorpus.filter((policy) => !policy.circle).length;
  const circleScopes = Array.from(
    agreements.policyCorpus.reduce((scopes, policy) => {
      if (policy.circle) scopes.set(policy.circle.id, policy.circle.name);
      return scopes;
    }, new Map<string, string>()),
    ([id, name]) => ({
      id,
      name,
      count: agreements.policyCorpus.filter((policy) => policy.circle?.id === id).length,
    }),
  );
  const validScopeIds = new Set(["all", "workspace", ...circleScopes.map((scope) => scope.id)]);
  const scope = normalizeScope(resolvedSearch.scope, validScopeIds);
  const filteredPolicies = agreements.policyCorpus.filter((policy) => {
    if (scope === "all") return true;
    if (scope === "workspace") return !policy.circle;
    return policy.circle?.id === scope;
  });
  const visibleConstitution = category === "all" || category === "constitution";
  const visiblePolicies = category === "all" || category === "policies";
  const visibleBrain = category === "all" || category === "working-agreements";
  const totalAgreementCount = (currentConstitution ? 1 : 0) + agreements.policyCorpus.length + agreements.brainArticles.length;
  const categoryItems = [
    { id: "all" as const, label: t("filterAll"), count: totalAgreementCount },
    { id: "policies" as const, label: t("filterPolicies"), count: agreements.policyCorpus.length },
    { id: "working-agreements" as const, label: t("filterWorkingAgreements"), count: agreements.brainArticles.length },
    { id: "constitution" as const, label: t("filterConstitution"), count: currentConstitution ? 1 : 0 },
  ];
  const scopeItems = [
    { id: "all", label: t("scopeAll"), count: agreements.policyCorpus.length },
    ...(workspacePolicyCount > 0 ? [{ id: "workspace", label: t("scopeWorkspace"), count: workspacePolicyCount }] : []),
    ...circleScopes.map((circle) => ({ id: circle.id, label: circle.name, count: circle.count })),
  ];

  return (
    <>
      <header className="nr-masthead nr-masthead-left">
        <h1 className="nr-masthead-title">{t("pageTitle")}</h1>
        <div className="nr-masthead-meta">
          <span>{t("pageDescription")}</span>
        </div>
      </header>

      <div className="nr-stat-bar">
        <span><strong>{currentConstitution ? `v${currentConstitution.version}` : "-"}</strong> {t("statConstitution")}</span>
        <span className="nr-stat-sep">/</span>
        <span><strong>{agreements.policyCorpus.length}</strong> {t("statPolicies")}</span>
        <span className="nr-stat-sep">/</span>
        <span><strong>{agreements.brainArticles.length}</strong> {t("statBrain")}</span>
      </div>

      <div className="nr-filter-bar nr-filter-bar-wrap">
        {categoryItems.map((item) => (
          <Link
            key={item.id}
            href={agreementsHref(workspaceId, { category: item.id })}
            className={`nr-filter-item ${category === item.id ? "nr-filter-active" : ""}`}
          >
            {t("filterWithCount", { label: item.label, count: item.count })}
          </Link>
        ))}
      </div>

      {visibleConstitution && (
        <section className="work-conversation agreements-section">
          <div className="work-conversation-header">
            <h2 className="nr-section-header">{t("sectionConstitution")}</h2>
            {currentConstitution && (
              <span className="nr-item-meta" style={{ fontSize: "0.82rem", margin: 0 }}>
                {t("constitutionMeta", {
                  version: currentConstitution.version,
                  date: formatDate(currentConstitution.createdAt) ?? "",
                })}
              </span>
            )}
          </div>
          {currentConstitution ? (
            <div className="agreements-document">
              <MarkdownRenderer markdown={currentConstitution.bodyMd} variant="compact" />
            </div>
          ) : (
            <p className="work-conversation-empty">{t("noConstitution")}</p>
          )}
        </section>
      )}

      {visiblePolicies && (
        <section className="work-conversation agreements-section">
          <div className="work-conversation-header">
            <h2 className="nr-section-header">{t("sectionPolicies", { count: agreements.policyCorpus.length })}</h2>
          </div>
          {category === "policies" && agreements.policyCorpus.length > 0 && (
            <div className="nr-filter-bar nr-filter-bar-wrap agreements-scope-filter">
              {scopeItems.map((item) => (
                <Link
                  key={item.id}
                  href={agreementsHref(workspaceId, { category: "policies", scope: item.id })}
                  className={`nr-filter-item ${scope === item.id ? "nr-filter-active" : ""}`}
                >
                  {t("filterWithCount", { label: item.label, count: item.count })}
                </Link>
              ))}
            </div>
          )}
          {agreements.policyCorpus.length === 0 ? (
            <p className="work-conversation-empty">{t("noPolicies")}</p>
          ) : filteredPolicies.length === 0 ? (
            <p className="work-conversation-empty">{t("noPoliciesForScope")}</p>
          ) : (
            <div className="agreements-list">
              {filteredPolicies.map((policy) => (
                <article key={policy.id} className="nr-item agreements-item">
                  <div className="row">
                    <strong className="nr-item-title">{policy.title}</strong>
                    {policy.circle ? <span className="tag">{policy.circle.name}</span> : <span className="tag info">{t("scopeWorkspace")}</span>}
                  </div>
                  <div className="nr-item-meta" style={{ fontSize: "0.82rem", marginTop: 4 }}>
                    <Link href={`/workspaces/${workspaceId}/proposals/${policy.proposal.id}`} style={{ color: "inherit", textDecoration: "underline" }}>
                      {policy.proposal.title}
                    </Link>
                    {" · "}
                    {t("accepted", { date: formatDate(policy.acceptedAt) ?? "" })}
                  </div>
                  {category === "policies" ? (
                    <div className="agreements-document agreements-policy-body">
                      <MarkdownRenderer markdown={policy.bodyMd} variant="compact" />
                    </div>
                  ) : (
                    <MarkdownExcerpt markdown={policy.bodyMd} maxLength={240} as="p" className="nr-excerpt" />
                  )}
                </article>
              ))}
            </div>
          )}
        </section>
      )}

      {visibleBrain && (
        <section className="work-conversation agreements-section">
          <div className="work-conversation-header">
            <h2 className="nr-section-header">{t("sectionBrain", { count: agreements.brainArticles.length })}</h2>
          </div>
          {agreements.brainArticles.length === 0 ? (
            <p className="work-conversation-empty">{t("noBrainAgreements")}</p>
          ) : (
            <div className="agreements-list">
              {agreements.brainArticles.map((article) => {
                const verifiedAt = formatDate(article.lastVerifiedAt);
                const ownerName = article.ownerMember?.user.displayName ?? article.ownerMember?.user.email ?? null;
                return (
                  <article key={article.id} className="nr-item agreements-item">
                    <div className="row">
                      <Link href={`/workspaces/${workspaceId}/brain/${article.slug}`} className="nr-item-title" style={{ color: "inherit" }}>
                        {article.title}
                      </Link>
                      <span className="tag">{formatEnumLabel(article.authority)}</span>
                    </div>
                    <div className="nr-item-meta" style={{ fontSize: "0.82rem", marginTop: 4 }}>
                      {formatEnumLabel(article.type)}
                      {verifiedAt ? ` · ${t("verified", { date: verifiedAt })}` : ""}
                      {ownerName ? ` · ${ownerName}` : ""}
                    </div>
                    <MarkdownExcerpt markdown={article.bodyMd} maxLength={category === "working-agreements" ? 360 : 240} as="p" className="nr-excerpt" />
                  </article>
                );
              })}
            </div>
          )}
        </section>
      )}

      {agreements.constitutionVersions.length > 1 && (category === "all" || category === "constitution") && (
        <section className="work-conversation agreements-section">
          <div className="work-conversation-header">
            <h2 className="nr-section-header">{t("sectionHistory")}</h2>
          </div>
          <div className="agreements-list">
            {agreements.constitutionVersions.map((constitution) => (
              <div key={constitution.id} className="nr-item agreements-item">
                <div className="row">
                  <span className="tag">v{constitution.version}</span>
                  <span className="nr-item-meta" style={{ fontSize: "0.82rem", margin: 0 }}>
                    {formatDate(constitution.createdAt)}
                  </span>
                </div>
                {constitution.diffSummary && (
                  <MarkdownExcerpt markdown={constitution.diffSummary} maxLength={200} as="div" className="nr-excerpt" />
                )}
              </div>
            ))}
          </div>
        </section>
      )}
    </>
  );
}
