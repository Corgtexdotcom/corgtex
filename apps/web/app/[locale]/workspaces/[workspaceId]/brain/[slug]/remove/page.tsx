import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { previewBrainArticleRemoval } from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";
import { confirmArticleRemovalAction } from "../../actions";

export const dynamic = "force-dynamic";

export default async function BrainArticleRemovalPage({
  params,
}: {
  params: Promise<{ workspaceId: string; slug: string }>;
}) {
  const { workspaceId, slug } = await params;
  const actor = await requirePageActor();
  const t = await getTranslations("brain");
  const preview = await previewBrainArticleRemoval(actor, { workspaceId, slug });
  const articleHref = `/workspaces/${workspaceId}/brain/${preview.article.slug}`;

  return (
    <div className="stack" style={{ maxWidth: 840 }}>
      <div className="ws-page-header">
        <h1>{t("removeArticleTitle", { title: preview.article.title })}</h1>
        <p>{t("removeArticleDescription")}</p>
      </div>

      <form action={confirmArticleRemovalAction} className="stack panel">
        <input type="hidden" name="workspaceId" value={workspaceId} />
        <input type="hidden" name="slug" value={preview.article.slug} />
        <input type="hidden" name="expectedToken" value={preview.token} />
        <input type="hidden" name="confirmation" value="archive_article" />
        <label className="stack">
          <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input type="radio" name="mode" value="keep_sources" defaultChecked style={{ width: "auto", margin: 0 }} />
            {t("removeArticleKeepSources")}
          </span>
          <span className="muted">{t("removeArticleKeepSourcesDetail")}</span>
        </label>
        {preview.hasSources && (
          <label className="stack">
            <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input type="radio" name="mode" value="remove_sources" disabled={!preview.canRemoveSources} style={{ width: "auto", margin: 0 }} />
              {t("removeArticleAndSources")}
            </span>
            <span className="muted">{t("removeArticleAndSourcesDetail")}</span>
          </label>
        )}

        {preview.sources.length > 0 && (
          <div className="stack">
            <h2>{t("removeArticleSourceImpact")}</h2>
            {preview.sources.map((source) => (
              <div className="panel stack" key={source.id}>
                <strong>{source.title}</strong>
                {source.documentTitle && <p className="muted">{t("removeArticleDocument", { title: source.documentTitle })}</p>}
                {source.sharedArticles.length === 0 ? <p className="muted">{t("removeArticleNoSharedArticle")}</p>
                  : source.sharedArticles.map((shared) => (
                    <p key={shared.id} className="muted">{shared.title} · {t(shared.action === "regenerate"
                      ? "removeArticleSharedRegenerate" : shared.action === "archive"
                        ? "removeArticleSharedArchive" : "removeArticleSharedManual")}</p>
                  ))}
              </div>
            ))}
          </div>
        )}
        {preview.hasSources && preview.sources.length === 0 && <p className="muted">{t("removeArticleOnlyAdmin")}</p>}
        {preview.blockReasons.map((reason) => <p key={reason} role="alert">{t(`removeArticleBlock_${reason}`)}</p>)}
        <div className="actions-inline">
          <button type="submit" className="danger">{t("removeArticleConfirm")}</button>
          <Link href={articleHref} className="secondary">{t("removeArticleCancel")}</Link>
        </div>
      </form>
    </div>
  );
}
