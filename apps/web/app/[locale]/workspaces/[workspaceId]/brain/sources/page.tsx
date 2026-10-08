import { duplicateGuardErrorPayload, isBrainSourceRemovalEnabled, isDuplicateGuardMatchError, listBrainSourceArchiveImpacts, listBrainSourceRemovalReviews, listSources, requireWorkspaceMembership } from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";
import { prisma } from "@corgtex/shared";
import { deleteSourceAction, ingestSourceAction, resolveSourceRemovalAction, retrySourceRemovalAction } from "../actions";
import { getTranslations } from "next-intl/server";
import { DuplicateGuardForm, type DuplicateGuardFormState } from "../../add/DuplicateGuardForm";
import { BrainSourceFileUploadForm } from "./BrainSourceFileUploadForm";

export const dynamic = "force-dynamic";


export default async function BrainSourcesPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<{ review?: string }>;
}) {
  const { workspaceId } = await params;
  const { review: reviewSourceId } = await searchParams;
  const actor = await requirePageActor();
  const t = await getTranslations("brain");
  const [membership, { items: sources }, currentWorkspace, sourceRemovalEnabled] = await Promise.all([
    requireWorkspaceMembership({ actor, workspaceId }),
    listSources(actor, { workspaceId, take: 50, sourceId: reviewSourceId }),
    prisma.workspace.findUnique({ where: { id: workspaceId }, select: { slug: true } }),
    isBrainSourceRemovalEnabled(prisma, workspaceId),
  ]);
  const isDemo = currentWorkspace?.slug === "jnj-demo";
  const sourceImpacts = new Map((await listBrainSourceArchiveImpacts(actor, {
    workspaceId,
    sourceIds: sources.map((source) => source.id),
  })).map((impact) => [impact.sourceId, impact]));
  const canReview = actor.kind === "agent" || membership?.role === "ADMIN";
  const removalReviews = new Map((canReview ? await listBrainSourceRemovalReviews(actor, {
    workspaceId, sourceIds: sources.map((source) => source.id),
  }) : []).map((review) => [review.sourceId, review]));

  async function ingestSourceAndReturn(_state: DuplicateGuardFormState, formData: FormData): Promise<DuplicateGuardFormState> {
    "use server";
    try {
      await ingestSourceAction(formData);
    } catch (error) {
      if (isDuplicateGuardMatchError(error)) return duplicateGuardErrorPayload(error);
      throw error;
    }
    return null;
  }

  return (
    <>
      <div className="ws-page-header">
        <h1>{t("sourcesTitle")}</h1>
        <p>{t("sourcesDescription")}</p>
      </div>

      <section className="ws-section stack">
        <h2>{t("ingestRawFiles")}</h2>
        <BrainSourceFileUploadForm
          workspaceId={workspaceId}
          labels={{
            fileToIngest: t("fileToIngest"),
            labelTitle: t("labelTitle"),
            placeholderSourceTitle: t("placeholderSourceTitle"),
            uploadAndMap: t("uploadAndMap"),
          }}
        />

        <h2>{t("ingestTextSource")}</h2>
        <DuplicateGuardForm action={ingestSourceAndReturn} className="stack panel">
          <input type="hidden" name="workspaceId" value={workspaceId} />
          <label>
            {t("labelTitle")}
            <input name="title" placeholder={t("placeholderSourceTitle")} />
          </label>
          <div className="actions-inline">
            <label style={{ flex: 1 }}>
              {t("labelSourceType")}
              <select name="sourceType">
                {["MEETING","TICKET","PR","RFC","INCIDENT","SLACK","CUSTOMER_FEEDBACK","COMPETITOR","RESEARCH","ARTICLE","DOC","RUNBOOK","EMAIL","FILE_UPLOAD","EXTERNAL_CONTENT"].map((t) => (
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
        </DuplicateGuardForm>
      </section>

      <section className="ws-section">
        <h2>{t("sourcesCount", { count: sources.length })}</h2>
        <div className="list">
          {sources.map((s) => {
            const impact = sourceImpacts.get(s.id);
            const review = removalReviews.get(s.id);
            const hasUnresolvedReview = !!review && review.phase !== "APPLIED";
            const hasUnclassifiedLink = impact?.visibleArticles.some((article) => article.kind === "unclassified") ?? false;
            const canArchive = !isDemo && (
              actor.kind === "agent"
              || membership?.role === "ADMIN"
              || (s.authorMemberId !== null && s.authorMemberId === membership?.id)
            );
            return (
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
                {impact?.blocked && (
                  <div className="muted" style={{ marginTop: 8 }}>
                    <p>{t("sourceArchiveNeedsReview")}</p>
                    {impact.visibleArticles.map((article) => (
                      <div key={article.id}>
                        <a href={`/workspaces/${workspaceId}/brain/${article.slug}`}>{article.title}</a>
                        {" · "}{t(article.kind === "derived" ? "derivedArticleLink" : "unclassifiedArticleLink")}
                      </div>
                    ))}
                    {impact.hasHiddenArticles && <p>{t("sourceArchiveHiddenLinks")}</p>}
                  </div>
                )}
                {canReview && hasUnclassifiedLink && <p className="muted">{t("sourceRemovalUnclassified")}</p>}
                {canReview && (impact?.blocked || hasUnresolvedReview) && !hasUnclassifiedLink && !isDemo && (
                  <div className="stack" style={{ marginTop: 8 }}>
                    {!sourceRemovalEnabled && <p className="muted">{t("sourceRemovalPaused")}</p>}
                    {review?.phase === "READY" && review.status === "COMPLETED" ? (
                      <div className="panel stack">
                        <p>{t("sourceRemovalReady")}</p>
                        {review.articles.map((article) => (
                          <details key={article.id}>
                            <summary>{article.title} · {t(article.action === "archive" ? "sourceRemovalArchiveArticle" : "sourceRemovalRegenerateArticle")}</summary>
                            {article.action === "regenerate" && <div className="stack">
                              <h4>{t("sourceRemovalCurrentBody")}</h4>
                              <pre style={{ whiteSpace: "pre-wrap", maxHeight: 300, overflow: "auto" }}>{article.currentBodyMd}</pre>
                              <h4>{t("sourceRemovalCandidateBody")}</h4>
                              <pre style={{ whiteSpace: "pre-wrap", maxHeight: 300, overflow: "auto" }}>{article.candidateBodyMd}</pre>
                            </div>}
                          </details>
                        ))}
                        <div className="actions-inline">
                          {(["accept", "reject"] as const).map((decision) => (
                            <form key={decision} action={resolveSourceRemovalAction}>
                              <input type="hidden" name="workspaceId" value={workspaceId} />
                              <input type="hidden" name="jobId" value={review.jobId} />
                              <input type="hidden" name="decision" value={decision} />
                              <button type="submit" className={decision === "accept" ? "danger small" : "secondary small"}
                                disabled={decision === "accept" && !sourceRemovalEnabled}>
                                {t(decision === "accept" ? "sourceRemovalAccept" : "sourceRemovalReject")}
                              </button>
                            </form>
                          ))}
                        </div>
                      </div>
                    ) : review && (review.status === "PENDING" || review.status === "RUNNING") ? (
                      <p className="muted">{t("sourceRemovalPending")}</p>
                    ) : review && (review.status === "FAILED" || review.phase === "STALE" || review.phase === "REJECTED") ? (
                      <form action={retrySourceRemovalAction}>
                        <input type="hidden" name="workspaceId" value={workspaceId} />
                        <input type="hidden" name="jobId" value={review.jobId} />
                        <button type="submit" className="secondary small" disabled={!sourceRemovalEnabled}>{t("sourceRemovalRetryAction")}</button>
                        <p className="muted">{t("sourceRemovalRetry")}</p>
                      </form>
                    ) : (
                      <form action={deleteSourceAction}>
                        <input type="hidden" name="workspaceId" value={workspaceId} />
                        <input type="hidden" name="sourceId" value={s.id} />
                        <button type="submit" className="secondary small" disabled={!sourceRemovalEnabled}>{t("sourceRemovalPrepare")}</button>
                        {review && <p className="muted">{t("sourceRemovalRetry")}</p>}
                      </form>
                    )}
                  </div>
                )}
                {canArchive && !hasUnresolvedReview && (
                  <form action={deleteSourceAction} style={{ marginTop: 8 }}>
                    <input type="hidden" name="workspaceId" value={workspaceId} />
                    <input type="hidden" name="sourceId" value={s.id} />
                    <button type="submit" className="danger small" disabled={impact?.blocked}>{t("archiveSource")}</button>
                  </form>
                )}
              </div>
            );
          })}
          {sources.length === 0 && <p className="muted">{t("noSourcesIngested")}</p>}
        </div>
      </section>
    </>
  );
}
