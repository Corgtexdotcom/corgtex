import Link from "next/link";
import { getFormatter, getTranslations } from "next-intl/server";
import { listDecisionLinkOptions, listDecisionRecords } from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";
import { MarkdownExcerpt } from "@/lib/components/MarkdownRenderer";
import { createDecisionAction } from "./actions";
import { DecisionFields } from "./DecisionFields";

export const dynamic = "force-dynamic";

function first(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function decisionListHref(workspaceId: string, options: { q: string; tag: string; page: number; archived: boolean }) {
  const search = new URLSearchParams();
  if (options.q) search.set("q", options.q);
  if (options.tag) search.set("tag", options.tag);
  if (options.page > 1) search.set("page", String(options.page));
  if (options.archived) search.set("archived", "1");
  return `/workspaces/${workspaceId}/decisions${search.size ? `?${search}` : ""}`;
}

export default async function DecisionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const actor = await requirePageActor();
  const t = await getTranslations("decisions");
  const format = await getFormatter();
  const search = searchParams ? await searchParams : {};
  const q = (first(search.q) ?? "").trim().slice(0, 120);
  const tag = (first(search.tag) ?? "").trim().slice(0, 40);
  const page = Number(first(search.page)) || 1;
  const archived = first(search.archived) === "1";
  const [results, options] = await Promise.all([
    listDecisionRecords(actor, { workspaceId, query: q, tag, page, includeArchived: archived }),
    listDecisionLinkOptions(actor, workspaceId),
  ]);
  const base = `/workspaces/${workspaceId}/decisions`;

  return (
    <div className="stack">
      <header className="nr-masthead nr-masthead-left">
        <h1 className="nr-masthead-title">{t("title")}</h1>
        <div className="nr-masthead-meta">{t("description")}</div>
      </header>

      <details className="panel">
        <summary style={{ cursor: "pointer", fontWeight: 600 }}>{t("new")}</summary>
        <form action={createDecisionAction} className="stack">
          <DecisionFields workspaceId={workspaceId} proposals={options.proposals} tensions={options.tensions} />
          <div><button type="submit">{t("save")}</button></div>
        </form>
      </details>

      <section className="panel stack">
        <form method="GET" className="actions-inline">
          <label style={{ flex: 2 }}>
            {t("search")}
            <input name="q" defaultValue={q} placeholder={t("searchPlaceholder")} />
          </label>
          <label style={{ flex: 1 }}>
            {t("tagFilter")}
            <select name="tag" defaultValue={tag}>
              <option value="">{t("allTags")}</option>
              {results.tags.map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
          </label>
          {archived && <input type="hidden" name="archived" value="1" />}
          <button type="submit">{t("apply")}</button>
          <Link href={base}>{t("clear")}</Link>
        </form>
        <div className="actions-inline">
          <strong>{results.total === 1 ? t("countOne") : t("countMany", { count: results.total })}</strong>
          <Link href={decisionListHref(workspaceId, { q, tag: "", page: 1, archived: !archived })}>
            {archived ? t("activeFilter") : t("archivedFilter")}
          </Link>
        </div>
        {results.items.length === 0 ? <p>{t("empty")}</p> : (
          <div className="agreements-list">
            {results.items.map((decision) => (
              <article key={decision.id} className="nr-item agreements-item">
                <div className="row">
                  <Link href={`${base}/${decision.id}`} className="nr-item-title">{decision.title}</Link>
                  {decision.archivedAt && <span className="tag">{t("archived")}</span>}
                </div>
                <div className="nr-item-meta">{format.dateTime(decision.decidedAt, { dateStyle: "medium", timeZone: "UTC" })}</div>
                <MarkdownExcerpt markdown={decision.bodyMd} maxLength={220} as="p" className="nr-excerpt" />
                <div className="actions-inline">
                  {decision.tags.map((item) => <span key={item} className="tag">{item}</span>)}
                  {decision.proposal && <Link style={{ textDecoration: "underline" }} href={`/workspaces/${workspaceId}/proposals/${decision.proposal.id}`}>{t("proposal")}: {decision.proposal.title}</Link>}
                  {decision.tension && <Link style={{ textDecoration: "underline" }} href={`/workspaces/${workspaceId}/tensions/${decision.tension.id}`}>{t("tension")}: {decision.tension.title}</Link>}
                </div>
              </article>
            ))}
          </div>
        )}
        {(results.page > 1 || results.page * 50 < results.total) && (
          <nav className="actions-inline">
            {results.page > 1 && <Link href={decisionListHref(workspaceId, { q, tag, page: results.page - 1, archived })}>{t("previous")}</Link>}
            {results.page * 50 < results.total && <Link href={decisionListHref(workspaceId, { q, tag, page: results.page + 1, archived })}>{t("next")}</Link>}
          </nav>
        )}
      </section>
    </div>
  );
}
