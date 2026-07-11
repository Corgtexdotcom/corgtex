import Link from "next/link";
import { listWorkspaceAgreements } from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";
import { MarkdownExcerpt, MarkdownRenderer } from "@/lib/components/MarkdownRenderer";
import { getTranslations } from "next-intl/server";

export const dynamic = "force-dynamic";

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

export default async function AgreementsPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const actor = await requirePageActor();
  const t = await getTranslations("agreements");
  const agreements = await listWorkspaceAgreements(actor, { workspaceId });
  const currentConstitution = agreements.currentConstitution;

  return (
    <>
      <header className="nr-masthead" style={{ textAlign: "left", marginBottom: 32 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 16 }}>
          <h1 style={{ border: "none", padding: 0, margin: 0, fontSize: "2rem" }}>{t("pageTitle")}</h1>
          <Link href={`/workspaces/${workspaceId}/governance`} className="secondary small">
            {t("viewGovernance")}
          </Link>
        </div>
        <div className="nr-masthead-meta">
          <span>{t("pageDescription")}</span>
        </div>
      </header>

      <div className="ws-stat-row" style={{ marginBottom: 36 }}>
        <div className="ws-stat-card" style={{ border: "1px dashed var(--line)", background: "transparent", boxShadow: "none" }}>
          <strong>{currentConstitution ? `v${currentConstitution.version}` : "-"}</strong>
          <span>{t("statConstitution")}</span>
        </div>
        <div className="ws-stat-card" style={{ border: "1px dashed var(--line)", background: "transparent", boxShadow: "none" }}>
          <strong>{agreements.policyCorpus.length}</strong>
          <span>{t("statPolicies")}</span>
        </div>
        <div className="ws-stat-card" style={{ border: "1px dashed var(--line)", background: "transparent", boxShadow: "none" }}>
          <strong>{agreements.brainArticles.length}</strong>
          <span>{t("statBrain")}</span>
        </div>
      </div>

      <section style={{ marginBottom: 44 }}>
        <div className="row" style={{ alignItems: "baseline", marginBottom: 12 }}>
          <h2 className="nr-section-header" style={{ flex: 1, marginBottom: 0 }}>{t("sectionConstitution")}</h2>
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
          <div style={{ border: "1px dashed var(--line)", borderRadius: 8, padding: 16 }}>
            <MarkdownRenderer markdown={currentConstitution.bodyMd} variant="compact" />
          </div>
        ) : (
          <p className="nr-item-meta">{t("noConstitution")}</p>
        )}
      </section>

      <section style={{ marginBottom: 44 }}>
        <h2 className="nr-section-header">{t("sectionPolicies", { count: agreements.policyCorpus.length })}</h2>
        {agreements.policyCorpus.length === 0 ? (
          <p className="nr-item-meta">{t("noPolicies")}</p>
        ) : (
          <div>
            {agreements.policyCorpus.map((policy) => (
              <article key={policy.id} className="nr-item">
                <div className="row">
                  <strong className="nr-item-title">{policy.title}</strong>
                  {policy.circle && <span className="tag">{policy.circle.name}</span>}
                </div>
                <div className="nr-item-meta" style={{ fontSize: "0.82rem", marginTop: 4 }}>
                  <Link href={`/workspaces/${workspaceId}/proposals/${policy.proposal.id}`} style={{ color: "inherit", textDecoration: "underline" }}>
                    {policy.proposal.title}
                  </Link>
                  {" · "}
                  {t("accepted", { date: formatDate(policy.acceptedAt) ?? "" })}
                </div>
                <MarkdownExcerpt markdown={policy.bodyMd} maxLength={240} as="p" className="nr-excerpt" />
              </article>
            ))}
          </div>
        )}
      </section>

      <section style={{ marginBottom: 44 }}>
        <h2 className="nr-section-header">{t("sectionBrain", { count: agreements.brainArticles.length })}</h2>
        {agreements.brainArticles.length === 0 ? (
          <p className="nr-item-meta">{t("noBrainAgreements")}</p>
        ) : (
          <div>
            {agreements.brainArticles.map((article) => {
              const verifiedAt = formatDate(article.lastVerifiedAt);
              const ownerName = article.ownerMember?.user.displayName ?? article.ownerMember?.user.email ?? null;
              return (
                <article key={article.id} className="nr-item">
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
                  <MarkdownExcerpt markdown={article.bodyMd} maxLength={240} as="p" className="nr-excerpt" />
                </article>
              );
            })}
          </div>
        )}
      </section>

      {agreements.constitutionVersions.length > 1 && (
        <section>
          <h2 className="nr-section-header">{t("sectionHistory")}</h2>
          <div>
            {agreements.constitutionVersions.map((constitution) => (
              <div key={constitution.id} className="nr-item">
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
