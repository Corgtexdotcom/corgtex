import { listSources } from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";
import { ingestSourceAction } from "../actions";
import { getTranslations } from "next-intl/server";

export const dynamic = "force-dynamic";


export default async function BrainSourcesPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const actor = await requirePageActor();
  const t = await getTranslations("brain");
  const { items: sources } = await listSources(actor, { workspaceId, take: 50 });

  return (
    <>
      <div className="ws-page-header">
        <h1>{t("sourcesTitle")}</h1>
        <p>{t("sourcesDescription")}</p>
      </div>

      <section className="ws-section stack">
        <h2>{t("ingestRawFiles")}</h2>
        <form action={`/api/workspaces/${workspaceId}/brain/sources/upload`} method="post" encType="multipart/form-data" className="stack panel">
          <label>
            {t("fileToIngest")}
            <input type="file" name="file" required />
          </label>
          <button type="submit">{t("uploadAndMap")}</button>
        </form>

        <h2>{t("ingestTextSource")}</h2>
        <form action={ingestSourceAction} className="stack panel">
          <input type="hidden" name="workspaceId" value={workspaceId} />
          <label>
            {t("labelTitle")}
            <input name="title" placeholder={t("placeholderSourceTitle")} />
          </label>
          <div className="actions-inline">
            <label style={{ flex: 1 }}>
              {t("labelSourceType")}
              <select name="sourceType">
                {["MEETING","TICKET","PR","RFC","INCIDENT","SLACK","CUSTOMER_FEEDBACK","COMPETITOR","RESEARCH","ARTICLE","DOC","RUNBOOK","EMAIL","FILE_UPLOAD"].map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </label>
            <label style={{ flex: 1 }}>
              {t("labelTier")}
              <select name="tier">
                <option value="1">{t("tierCore")}</option>
                <option value="2">{t("tierRelational")}</option>
                <option value="3">{t("tierContext")}</option>
              </select>
            </label>
          </div>
          <label>
            {t("labelChannel")}
            <input name="channel" placeholder={t("placeholderChannel")} />
          </label>
          <label>
            {t("labelContent")}
            <textarea name="content" rows={8} required placeholder={t("placeholderSourceContent")} />
          </label>
          <button type="submit">{t("ingestSource")}</button>
        </form>
      </section>

      <section className="ws-section">
        <h2>{t("sourcesCount", { count: sources.length })}</h2>
        <div className="list">
          {sources.map((s) => (
            <div className="item" key={s.id}>
              <div className="row">
                <strong>{s.title ?? s.id.slice(0, 8)}</strong>
                <div>
                  <span className="tag">{s.sourceType}</span>
                  <span className="tag" style={{ marginLeft: 4 }}>{t("tierLabel", { tier: s.tier })}</span>
                  <span className="tag" style={{ marginLeft: 4 }}>{s.absorbedAt ? t("absorbed") : t("pending")}</span>
                </div>
              </div>
              <div className="muted">
                {s.channel && `${s.channel} · `}
                {s.authorMember ? (s.authorMember.user.displayName ?? s.authorMember.user.email) : t("systemAuthor")}
                {" · "}
                {new Date(s.createdAt).toLocaleDateString()}
                {s.fileStorageKey && (
                  <>
                    {" · "}
                    <a href={`/api/workspaces/${workspaceId}/brain/sources/${s.id}/file`} target="_blank" rel="noreferrer" style={{ textDecoration: "underline" }}>
                      {t("download")}
                    </a>
                  </>
                )}
              </div>
              <p style={{ margin: "8px 0 0", fontSize: "0.85rem" }}>{s.content.slice(0, 200)}{s.content.length > 200 ? "..." : ""}</p>
            </div>
          ))}
          {sources.length === 0 && <p className="muted">{t("noSourcesIngested")}</p>}
        </div>
      </section>
    </>
  );
}
