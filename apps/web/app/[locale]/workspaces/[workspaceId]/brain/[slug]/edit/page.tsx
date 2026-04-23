import { getArticle } from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";
import { updateArticleAction } from "../../actions";

export const dynamic = "force-dynamic";


export default async function BrainArticleEditPage({
  params,
}: {
  params: Promise<{ workspaceId: string; slug: string }>;
}) {
  const { workspaceId, slug } = await params;
  const actor = await requirePageActor();
  const article = await getArticle(actor, { workspaceId, slug });

  return (
    <>
      <div className="ws-page-header">
        <h1>Edit: {article.title}</h1>
      </div>

      <form action={updateArticleAction} className="stack panel">
        <input type="hidden" name="workspaceId" value={workspaceId} />
        <input type="hidden" name="slug" value={slug} />
        <label>
          Title
          <input name="title" defaultValue={article.title} required />
        </label>
        <div className="actions-inline">
          <label style={{ flex: 1 }}>
            Type
            <select name="type" defaultValue={article.type}>
              {["PRODUCT","ARCHITECTURE","PROCESS","RUNBOOK","DECISION","TEAM","PERSON","CUSTOMER","INCIDENT","PROJECT","INTEGRATION","PATTERN","STRATEGY","CULTURE","GLOSSARY"].map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </label>
          <label style={{ flex: 1 }}>
            Authority
            <select name="authority" defaultValue={article.authority}>
              <option value="DRAFT">Draft</option>
              <option value="REFERENCE">Reference</option>
              <option value="AUTHORITATIVE">Authoritative</option>
              <option value="HISTORICAL">Historical</option>
            </select>
          </label>
        </div>
        <label>
          Body (Markdown)
          <textarea name="bodyMd" rows={20} defaultValue={article.bodyMd} required />
        </label>
        <label>
          Change summary (optional)
          <input name="changeSummary" placeholder="What changed?" />
        </label>
        <div className="actions-inline">
          <button type="submit">Save changes</button>
          <a href={`/workspaces/${workspaceId}/brain/${slug}`} className="link-button">Cancel</a>
        </div>
      </form>
    </>
  );
}
