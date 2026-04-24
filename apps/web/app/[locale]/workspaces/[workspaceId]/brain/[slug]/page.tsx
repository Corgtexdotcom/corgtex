import type { BrainArticleType, BrainArticleAuthority } from "@prisma/client";
import { getArticle, listArticles } from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";
import { notFound } from "next/navigation";
import Link from "next/link";
import { renderMarkdown } from "@/lib/markdown";
import { revalidatePath } from "next/cache";
import { prisma } from "@corgtex/shared";
import { getTranslations } from "next-intl/server";

export const dynamic = "force-dynamic";


export default async function BrainArticlePage({
  params,
}: {
  params: Promise<{ workspaceId: string; slug: string }>;
}) {
  const { workspaceId, slug } = await params;
  const actor = await requirePageActor();
  const t = await getTranslations("brain");

  const article = await getArticle(actor, { workspaceId, slug });
  if (!article) notFound();

  // Load sidebar navigation
  const { items: allArticles } = await listArticles(actor, { workspaceId, take: 50 });
  const otherArticles = allArticles.filter(a => a.id !== article.id).slice(0, 5);

  const sources = article.sourceIds.length > 0 
    ? await prisma.brainSource.findMany({
      where: {
        workspaceId,
        id: { in: article.sourceIds },
      },
    })
    : [];

  const ageText = (date: Date) => {
    const days = Math.floor((Date.now() - new Date(date).getTime()) / (1000 * 60 * 60 * 24));
    if (days === 0) return "today";
    if (days === 1) return "yesterday";
    return `${days}d ago`;
  };

  const htmlContent = renderMarkdown(article.bodyMd);

  async function updateArticleAction(formData: FormData) {
    "use server";
    const bodyMd = formData.get("bodyMd") as string;
    const type = formData.get("type") as BrainArticleType;
    const authority = formData.get("authority") as BrainArticleAuthority;
    
    await prisma.brainArticle.update({
      where: { id: article.id },
      data: { bodyMd, type, authority },
    });
    
    revalidatePath(`/workspaces/${workspaceId}/brain/${slug}`);
  }

  return (
    <>
      <div className="nr-masthead" style={{ textAlign: "left", marginBottom: 32 }}>
        <p className="nr-meta" style={{ marginBottom: "12px", display: "flex", gap: "12px" }}>
          <span><Link href={`/workspaces/${workspaceId}/brain`} style={{ color: "inherit", textDecoration: "none" }}>{t("backToIndex")}</Link></span>
          <span>·</span>
          <span>{article.type}</span>
          <span>·</span>
          <span>{article.authority}</span>
        </p>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", borderBottom: "1px solid var(--line)", paddingBottom: 16 }}>
          <h1 style={{ border: "none", padding: 0, margin: 0, fontSize: "2.5rem", maxWidth: "800px" }}>{article.title}</h1>
          <span style={{ fontSize: "0.85rem", color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
            {t("updated", { time: ageText(article.updatedAt) })}
          </span>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "3fr 1fr", gap: "64px" }}>
        {/* Main Article Body */}
        <article style={{ fontSize: "1.1rem", lineHeight: 1.8, color: "var(--text)" }}>
          <div 
            className="nr-markdown" 
            dangerouslySetInnerHTML={{ __html: htmlContent }} 
            style={{ marginBottom: "48px" }}
          />

          <hr className="nr-divider" style={{ margin: "48px 0" }} />
          
          <h3 style={{ fontSize: "1rem", color: "var(--muted)", marginBottom: "16px" }}>{t("editor")}</h3>
          <form action={updateArticleAction} style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
            <div style={{ display: "flex", gap: "8px" }}>
              <select name="type" defaultValue={article.type} style={{ flex: 1, padding: "8px", fontSize: "0.85rem", border: "1px solid var(--line)" }}>
                {["PRODUCT","ARCHITECTURE","PROCESS","RUNBOOK","DECISION","TEAM","PERSON","CUSTOMER","INCIDENT","PROJECT","INTEGRATION","PATTERN","STRATEGY","CULTURE","GLOSSARY"].map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
              <select name="authority" defaultValue={article.authority} style={{ flex: 1, padding: "8px", fontSize: "0.85rem", border: "1px solid var(--line)" }}>
                <option value="DRAFT">Draft</option>
                <option value="REFERENCE">Reference</option>
                <option value="AUTHORITATIVE">Authoritative</option>
              </select>
            </div>
            <textarea name="bodyMd" defaultValue={article.bodyMd} rows={10} style={{ width: "100%", padding: "12px", fontSize: "0.9rem", border: "1px solid var(--line)", borderRadius: "4px", fontFamily: "monospace", lineHeight: 1.4 }} />
            <button type="submit" style={{ padding: "8px 16px", background: "var(--text)", color: "white", border: "none", borderRadius: "4px", cursor: "pointer", fontWeight: 600, alignSelf: "flex-start" }}>{t("updateArticle")}</button>
          </form>
        </article>

        {/* Sidebar */}
        <aside style={{ borderLeft: "1px solid var(--line)", paddingLeft: "32px", paddingRight: "16px" }}>
          <h3 style={{ fontSize: "0.85rem", textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--text)", marginBottom: "16px" }}>{t("relatedInWiki")}</h3>
          <ul style={{ display: "flex", flexDirection: "column", gap: "12px", padding: 0, margin: 0, listStyle: "none" }}>
            {otherArticles.map((a) => (
              <li key={a.id}>
                <Link href={`/workspaces/${workspaceId}/brain/${a.slug}`} style={{ display: "block", textDecoration: "none", color: "var(--text)" }}>
                  <div style={{ fontSize: "0.9rem", fontWeight: 600, marginBottom: "4px" }}>{a.title}</div>
                  <div className="nr-meta">{a.type}</div>
                </Link>
              </li>
            ))}
          </ul>

          {sources.length > 0 && (
            <>
              <h3 style={{ fontSize: "0.85rem", textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--text)", marginTop: "32px", marginBottom: "16px" }}>{t("knowledgeSources")}</h3>
              <ul style={{ display: "flex", flexDirection: "column", gap: "12px", padding: 0, margin: 0, listStyle: "none" }}>
                {sources.map((s) => (
                  <li key={s.id} style={{ fontSize: "0.85rem", paddingBottom: "8px", borderBottom: "1px dashed var(--line)" }}>
                    <div style={{ fontWeight: 600, marginBottom: "4px", color: "var(--text)" }}>{s.title || s.id.slice(0, 8)}</div>
                    <div className="nr-meta" style={{ display: "flex", justifyContent: "space-between" }}>
                      <span>{s.sourceType}</span>
                      {s.fileStorageKey && (
                        <a href={`/api/workspaces/${workspaceId}/brain/sources/${s.id}/file`} target="_blank" rel="noreferrer" style={{ textDecoration: "underline", color: "inherit" }}>
                          {t("viewSource")}
                        </a>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </aside>
      </div>
    </>
  );
}
