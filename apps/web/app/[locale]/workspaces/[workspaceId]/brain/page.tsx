import { getBrainStatus, listArticles, requireWorkspaceMembership, listMeetings, listDocuments, resolveKnowledgeAccessDomains } from "@corgtex/domain";
import { answerKnowledgeQuestion, searchIndexedKnowledge } from "@corgtex/knowledge";
import { prisma } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import { requirePageActor } from "@/lib/auth";
import { createArticleAction, publishArticleAction, returnArticleToDraftAction } from "./actions";
import { getTranslations } from "next-intl/server";
import { MarkdownEditor } from "@/lib/components/MarkdownEditor";
import { MarkdownExcerpt } from "@/lib/components/MarkdownRenderer";
import { KnowledgeFileUploader } from "../KnowledgeFileUploader";
import {
  BRAIN_ARTICLE_TYPES,
  buildBrainIndexHref,
  buildBrainIndexState,
  canManageBrainArticle,
  getUnresolvedBrainSearchArticleRefs,
  normalizeBrainIndexSearch,
  resolveBrainSearchResults,
} from "./view-model";

export const dynamic = "force-dynamic";

const CREATABLE_ARTICLE_TYPES = BRAIN_ARTICLE_TYPES.filter((type) => type !== "DIGEST");

export default async function BrainPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const actor = await requirePageActor();
  const membership = await requireWorkspaceMembership({ actor, workspaceId });
  const accessDomains = await resolveKnowledgeAccessDomains(actor, workspaceId);
  const t = await getTranslations("brain");
  const resolvedSearch = searchParams ? await searchParams : {};
  const normalizedSearch = normalizeBrainIndexSearch(resolvedSearch);
  const provisionalQuery = normalizedSearch.query;
  const provisionalQuestion = normalizedSearch.question;

  const [{ items: articles }, articleTypeCounts, status, searchResults, answer, allMeetings, allDocuments] = await Promise.all([
    listArticles(actor, {
      workspaceId,
      take: 500,
      ...(normalizedSearch.selectedType ? { type: normalizedSearch.selectedType } : {}),
    }),
    listBrainArticleTypeCounts({ workspaceId, actor, membership }),
    getBrainStatus(actor, { workspaceId }),
    provisionalQuery.trim()
      ? searchIndexedKnowledge({ workspaceId, query: provisionalQuery, limit: 12, accessDomains })
      : Promise.resolve([]),
    provisionalQuestion.trim()
      ? answerKnowledgeQuestion({ workspaceId, question: provisionalQuestion, limit: 4, accessDomains })
      : Promise.resolve(null),
    listMeetings(workspaceId, { status: "COMPLETED" }),
    listDocuments(actor, workspaceId),
  ]);

  const {
    query,
    question,
    range,
    selectedType,
    typeCounts,
    visibleArticles,
    typeSummaries,
    meetings,
    documents,
  } = buildBrainIndexState({
    articles,
    meetings: allMeetings,
    documents: allDocuments,
    searchParams: resolvedSearch,
    typeCounts: articleTypeCounts,
  });
  const resolvedSearchArticleRefs = await listSearchResultArticleRefs({
    workspaceId,
    actor,
    membership,
    results: searchResults,
    visibleArticleRefs: articles,
  });
  const resolvedSearchResults = resolveBrainSearchResults(searchResults, [...articles, ...resolvedSearchArticleRefs]);

  const filterHref = (type: string | null) => buildBrainIndexHref({ query, question, range, type });
  const rangeHref = (nextRange: "30d" | "90d" | "all") => buildBrainIndexHref({ query, question, range: nextRange, type: selectedType });

  return (
    <div className="brain-page">
      <div className="nr-masthead brain-masthead">
        <div className="brain-masthead-row">
          <h1>{t("title")}</h1>
          <span className="brain-masthead-meta">
            {t("stats", { articles: status.totalArticles, meetings: allMeetings.length })}
          </span>
        </div>
      </div>

      <KnowledgeFileUploader workspaceId={workspaceId} defaultSource="brain-upload" />

      <section className="brain-stat-strip" aria-label={t("statusTitle")}>
        <div className="brain-stat-card">
          <strong>{status.totalArticles}</strong>
          <span>{t("totalArticles")}</span>
        </div>
        <div className="brain-stat-card">
          <strong>{typeCounts.length}</strong>
          <span>{t("articleTypes")}</span>
        </div>
        <div className="brain-stat-card">
          <strong>{status.unabsorbedSources}</strong>
          <span>{t("pendingSources")}</span>
        </div>
      </section>

      <section className="brain-top-grid">
        <div className="brain-top-panel">
          <h2 className="nr-section-header">{t("searchBrain")}</h2>
          <form method="GET" className="brain-search-form">
            {selectedType && <input type="hidden" name="type" value={selectedType} />}
            {range !== "30d" && <input type="hidden" name="range" value={range} />}
            <input
              name="q"
              defaultValue={query}
              placeholder={t("searchPlaceholder")}
            />
          </form>

          {resolvedSearchResults.length > 0 && (
            <div className="brain-search-results">
              <h3>{t("results")}</h3>
              {resolvedSearchResults.map((result) => {
                const resultBody = (
                  <>
                    <div className="brain-search-result-title">{result.title ?? result.sourceId}</div>
                    <div className="nr-meta">{result.sourceType}</div>
                    <p className="nr-excerpt">{result.snippet.slice(0, 150)}...</p>
                    {!result.articleSlug && <div className="nr-meta">{t("unlinkedSearchResult")}</div>}
                  </>
                );

                return result.articleSlug ? (
                  <a key={result.chunkId} href={`/workspaces/${workspaceId}/brain/${result.articleSlug}`} className="nr-item brain-search-result">
                    {resultBody}
                  </a>
                ) : (
                  <div key={result.chunkId} className="nr-item brain-search-result">
                    {resultBody}
                  </div>
                );
              })}
              <p className="brain-coverage-note">{t("searchCoverageNote")}</p>
            </div>
          )}
        </div>

        <div className="brain-top-panel">
          <h2 className="nr-section-header">{t("askAgent")}</h2>
          <form method="GET" className="brain-ask-form">
            {query && <input type="hidden" name="q" value={query} />}
            {selectedType && <input type="hidden" name="type" value={selectedType} />}
            {range !== "30d" && <input type="hidden" name="range" value={range} />}
            <textarea
              name="question"
              defaultValue={question}
              placeholder={t("askPlaceholder")}
              rows={3}
            />
            <button type="submit">{t("synthesizeAnswer")}</button>
          </form>

          {answer && (
            <div className="brain-answer">
              <div className="brain-answer-title">{t("agentSynthesis")}</div>
              <p>{answer.answer}</p>

              {answer.citations.length > 0 && (
                <div className="brain-answer-citations">
                  <div className="brain-citation-label">{t("sourcesUsed")}</div>
                  {answer.citations.map((citation) => (
                    <div key={citation.chunkId} className="brain-citation">
                      <strong>{citation.title ?? citation.sourceId}</strong>
                      <span>{citation.snippet.slice(0, 80)}...</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </section>

      <section className="brain-content-grid">
        <div className="brain-directory">
          <div className="brain-directory-header">
            <div>
              <h2 className="nr-section-header">{t("fullDirectory")}</h2>
            </div>
          </div>

          <nav className="brain-filter-bar" aria-label={t("typeFilter")}>
            <a className={`brain-filter-chip${selectedType ? "" : " active"}`} href={filterHref(null)}>
              <span>{t("all")}</span>
            </a>
            {typeCounts.map(({ type, count }) => (
              <a key={type} className={`brain-filter-chip${selectedType === type ? " active" : ""}`} href={filterHref(type)}>
                <span>{type}</span>
                <strong>{count}</strong>
              </a>
            ))}
          </nav>

          {visibleArticles.length > 0 ? (
            <div className="brain-article-list">
              {visibleArticles.map((article) => {
                const canManage = canManageBrainArticle(actor, membership, article);
                const owner = article.ownerMember
                  ? (article.ownerMember.user.displayName ?? article.ownerMember.user.email)
                  : null;

                return (
                  <article key={article.id} className="item brain-article-row">
                    <div className="brain-article-row-head">
                      <div className="brain-article-title-block">
                        <a href={`/workspaces/${workspaceId}/brain/${article.slug}`} className="brain-article-title">
                          {article.isPrivate && <span title={t("privateDraft")} className="brain-private-marker">◆</span>}
                          {article.title}
                        </a>
                        <div className="brain-article-tags">
                          <span className="tag neutral">{article.type}</span>
                          <span className={authorityTagClass(article.authority)}>{authorityLabel(article.authority, t)}</span>
                        </div>
                      </div>
                    </div>

                    <MarkdownExcerpt markdown={article.bodyMd} maxLength={140} as="div" className="brain-article-excerpt" />

                    <div className="brain-article-meta">
                      <span>{t("updatedDate", { date: new Date(article.updatedAt).toLocaleDateString() })}</span>
                      {owner && <span>{t("ownedBy", { name: owner })}</span>}
                      {article._count?.backlinksTo ? <span>{t("backlinksCount", { count: article._count.backlinksTo })}</span> : null}
                      {article._count?.discussions ? <span>{t("discussionsCount", { count: article._count.discussions })}</span> : null}
                    </div>

                    {canManage && (
                      <div className="item-actions">
                        {article.isPrivate && article.authority === "DRAFT" && (
                          <form action={publishArticleAction}>
                            <input type="hidden" name="workspaceId" value={workspaceId} />
                            <input type="hidden" name="slug" value={article.slug} />
                            <button type="submit" className="secondary small">{t("open")}</button>
                          </form>
                        )}
                        {!article.isPrivate && (
                          <form action={returnArticleToDraftAction}>
                            <input type="hidden" name="workspaceId" value={workspaceId} />
                            <input type="hidden" name="slug" value={article.slug} />
                            <button type="submit" className="secondary small">{t("returnToDraft")}</button>
                          </form>
                        )}
                        {article.authority === "DRAFT" && (
                          <a href={`/workspaces/${workspaceId}/brain/${article.slug}/edit`} className="secondary small">{t("edit")}</a>
                        )}
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          ) : (
            <div className="brain-empty">
              <p>{articles.length === 0 ? t("noArticles") : t("noArticlesForFilter")}</p>
            </div>
          )}
        </div>

        <aside className="brain-rail">
          <section className="brain-rail-section">
            <h2 className="nr-section-header">{t("typeSummaries")}</h2>
            {typeSummaries.length > 0 ? (
              <div className="brain-type-summary-list">
                {typeSummaries.map((summary) => (
                  <div key={summary.type} className="brain-type-summary">
                    <div className="brain-type-summary-head">
                      <strong>{summary.type}</strong>
                      <span className="tag neutral">{summary.count}</span>
                    </div>
                    <ul>
                      {summary.sampleArticles.map((article) => (
                        <li key={article.id}>
                          <a href={`/workspaces/${workspaceId}/brain/${article.slug}`}>{article.title}</a>
                        </li>
                      ))}
                    </ul>
                    {summary.remainingCount > 0 && (
                      <a className="nr-link" href={filterHref(summary.type)}>{t("viewMore", { count: summary.remainingCount })}</a>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <p className="nr-meta">{t("noArticles")}</p>
            )}
          </section>

          <section className="brain-rail-section">
            <div className="brain-rail-heading">
              <h2 className="nr-section-header">{t("rawIndex")}</h2>
              <div className="brain-range-links">
                <a href={rangeHref("30d")} className={range === "30d" ? "active" : undefined}>30d</a>
                <a href={rangeHref("90d")} className={range === "90d" ? "active" : undefined}>90d</a>
                <a href={rangeHref("all")} className={range === "all" ? "active" : undefined}>{t("all")}</a>
              </div>
            </div>

            <div className="brain-raw-section">
              <h3>{t("meetings", { count: meetings.length })}</h3>
              <div className="brain-raw-list">
                {meetings.slice(0, 20).map((meeting) => (
                  <a key={meeting.id} href={`/workspaces/${workspaceId}/meetings`} className="brain-raw-item">
                    <strong>{meeting.title || t("untitledSourceMeeting", { source: meeting.source })}</strong>
                    <span>{new Date(meeting.recordedAt).toLocaleDateString()}</span>
                  </a>
                ))}
                {meetings.length > 20 && <a href={`/workspaces/${workspaceId}/meetings`} className="nr-link">{t("viewMore", { count: meetings.length - 20 })}</a>}
              </div>
            </div>

            <div className="brain-raw-section">
              <h3>{t("documents", { count: documents.length })}</h3>
              <div className="brain-raw-list">
                {documents.slice(0, 10).map((document) => (
                  <div key={document.id} className="brain-raw-item">
                    <strong>{document.title}</strong>
                    <span>{new Date(document.createdAt).toLocaleDateString()} · {document.source}</span>
                  </div>
                ))}
              </div>
            </div>
          </section>

          <section className="brain-create-panel">
            <h2>{t("createArticle")}</h2>
            <form action={createArticleAction} className="brain-create-form">
              <input type="hidden" name="workspaceId" value={workspaceId} />
              <input name="title" required placeholder={t("articleTitle")} />
              <div className="brain-field-grid">
                <select name="type">
                  {CREATABLE_ARTICLE_TYPES.map((type) => (
                    <option key={type} value={type}>{type}</option>
                  ))}
                </select>
                <select name="authority">
                  <option value="DRAFT">{t("authorityDraft")}</option>
                  <option value="REFERENCE">{t("authorityReference")}</option>
                  <option value="AUTHORITATIVE">{t("authorityAuthoritative")}</option>
                </select>
              </div>
              <MarkdownEditor name="bodyMd" required placeholder={t("bodyMd")} rows={5} />
              <label className="brain-private-toggle">
                <input type="checkbox" name="isPrivate" defaultChecked />
                <span>{t("privateDraftOnlyMe")}</span>
              </label>
              <button type="submit">{t("create")}</button>
            </form>
          </section>
        </aside>
      </section>
    </div>
  );
}

function authorityLabel(authority: string, t: Awaited<ReturnType<typeof getTranslations>>) {
  if (authority === "AUTHORITATIVE") return t("authorityAuthoritative");
  if (authority === "HISTORICAL") return t("authorityHistorical");
  if (authority === "DRAFT") return t("authorityDraft");
  return t("authorityReference");
}

function authorityTagClass(authority: string) {
  if (authority === "DRAFT") return "tag warning";
  if (authority === "AUTHORITATIVE") return "tag";
  return "tag neutral";
}

async function listBrainArticleTypeCounts(params: {
  workspaceId: string;
  actor: AppActor;
  membership: { id?: string | null; role?: string | null } | null | undefined;
}) {
  const counts = await prisma.brainArticle.groupBy({
    by: ["type"],
    where: {
      AND: [
        { workspaceId: params.workspaceId, archivedAt: null },
        { OR: brainArticleVisibility(params.actor, params.membership) },
      ],
    },
    _count: {
      _all: true,
    },
  });

  return counts.map((entry) => ({
    type: entry.type,
    count: entry._count._all,
  }));
}

async function listSearchResultArticleRefs(params: {
  workspaceId: string;
  actor: AppActor;
  membership: { id?: string | null; role?: string | null } | null | undefined;
  results: Array<{ sourceId: string; sourceType: string }>;
  visibleArticleRefs: Array<{ id: string; slug: string }>;
}) {
  const unresolvedRefs = getUnresolvedBrainSearchArticleRefs(params.results, params.visibleArticleRefs);
  if (unresolvedRefs.length === 0) return [];

  return prisma.brainArticle.findMany({
    where: {
      AND: [
        { workspaceId: params.workspaceId, archivedAt: null },
        {
          OR: [
            { id: { in: unresolvedRefs } },
            { slug: { in: unresolvedRefs } },
          ],
        },
        { OR: brainArticleVisibility(params.actor, params.membership) },
      ],
    },
    select: {
      id: true,
      slug: true,
    },
  });
}

function brainArticleVisibility(
  actor: AppActor,
  membership: { id?: string | null; role?: string | null } | null | undefined,
) {
  if (actor.kind === "agent" || membership?.role === "ADMIN") {
    return [{ isPrivate: false }, { isPrivate: true, authority: "DRAFT" as const }];
  }

  if (actor.kind === "user" && membership?.id) {
    return [{ isPrivate: false }, { isPrivate: true, ownerMemberId: membership.id }];
  }

  return [{ isPrivate: false }];
}
