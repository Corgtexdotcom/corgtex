import { getArticle } from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";
import { updateArticleAction } from "../../actions";
import { getTranslations } from "next-intl/server";

export const dynamic = "force-dynamic";


export default async function BrainArticleEditPage({
  params,
}: {
  params: Promise<{ workspaceId: string; slug: string }>;
}) {
  const { workspaceId, slug } = await params;
  const actor = await requirePageActor();
  const t = await getTranslations("brain");
  const article = await getArticle(actor, { workspaceId, slug });

  return (
    <>
      <div className="ws-page-header">
        <h1>{t("editArticleTitle", { title: article.title })}</h1>
      </div>

      <form action={updateArticleAction} className="stack panel">
        <input type="hidden" name="workspaceId" value={workspaceId} />
        <input type="hidden" name="slug" value={slug} />
        <label>
          {t("labelTitle")}
          <input name="title" defaultValue={article.title} required />
        </label>
        <div className="actions-inline">
          <label style={{ flex: 1 }}>
            {t("labelType")}
            <select name="type" defaultValue={article.type}>
              {["PRODUCT","ARCHITECTURE","PROCESS","RUNBOOK","DECISION","TEAM","PERSON","CUSTOMER","INCIDENT","PROJECT","INTEGRATION","PATTERN","STRATEGY","CULTURE","GLOSSARY"].map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </label>
          <label style={{ flex: 1 }}>
            {t("labelAuthority")}
            <select name="authority" defaultValue={article.authority}>
              <option value="DRAFT">{t("authorityDraft")}</option>
              <option value="REFERENCE">{t("authorityReference")}</option>
              <option value="AUTHORITATIVE">{t("authorityAuthoritative")}</option>
              <option value="HISTORICAL">{t("authorityHistorical")}</option>
            </select>
          </label>
        </div>
        <label>
          {t("bodyMd")}
          <textarea name="bodyMd" rows={20} defaultValue={article.bodyMd} required />
        </label>
        <label>
          {t("labelChangeSummary")}
          <input name="changeSummary" placeholder={t("placeholderChangeSummary")} />
        </label>
        <div className="actions-inline">
          <button type="submit">{t("saveChanges")}</button>
          <a href={`/workspaces/${workspaceId}/brain/${slug}`} className="link-button">{t("cancel")}</a>
        </div>
      </form>
    </>
  );
}
