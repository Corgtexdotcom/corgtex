import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ArrowLeft, ArrowRight, Search } from "lucide-react";
import { listControlPlaneWorkspaces } from "@corgtex/domain";
import { Link } from "@/i18n/routing";
import { requirePageActor } from "@/lib/auth";
import { ControlPlanePageHeader, StatusBadge, controlPlaneButtonClass, controlPlaneInputClass } from "../_components/control-plane-ui";

export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;
const first = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] : value;

function directoryHref(query: string, cursor?: string, history: string[] = [], scope = "all") {
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  if (scope !== "all") params.set("scope", scope);
  if (cursor) params.set("cursor", cursor);
  for (const entry of history) params.append("previous", entry);
  const suffix = params.toString();
  return `/control-plane/workspaces${suffix ? `?${suffix}` : ""}`;
}

export default async function ControlPlaneWorkspacesPage({ searchParams }: { searchParams?: Promise<SearchParams> }) {
  const actor = await requirePageActor();
  const t = await getTranslations("controlPlane.workspaces");
  const raw = await searchParams;
  const query = first(raw?.q)?.trim() ?? "";
  const requestedScope = first(raw?.scope);
  const scope = requestedScope === "local" || requestedScope === "remote" ? requestedScope : "all";
  const cursor = first(raw?.cursor);
  const previousRaw = raw?.previous;
  const history = (Array.isArray(previousRaw) ? previousRaw : previousRaw ? [previousRaw] : [])
    .filter((entry) => entry.length <= 2048 && (entry === "start" || /^[A-Za-z0-9_-]+$/.test(entry))).slice(-20);
  let directory: Awaited<ReturnType<typeof listControlPlaneWorkspaces>>;
  try {
    directory = await listControlPlaneWorkspaces(actor, { query, cursor, scope, pageSize: 25 });
  } catch (error) {
    if (error && typeof error === "object" && "status" in error && error.status === 403) notFound();
    if (error && typeof error === "object" && "status" in error && error.status === 400) {
      return <div className="space-y-4"><h1 className="text-xl font-semibold">{t("title")}</h1>
        <p>{t("expiredPage")}</p><Link href={directoryHref(query.slice(0, 120), undefined, [], scope)} className={controlPlaneButtonClass}>{t("firstPage")}</Link></div>;
    }
    throw error;
  }
  const previousCursor = history.at(-1);
  const previousHref = directoryHref(directory.query, previousCursor === "start" ? undefined : previousCursor, history.slice(0, -1), scope);

  return (
    <div className="space-y-5 pb-10">
      <ControlPlanePageHeader title={t("title")} />
      <form action="" method="get" className="flex max-w-2xl flex-wrap items-center gap-2" role="search">
        <label htmlFor="workspace-query" className="sr-only">{t("search")}</label>
        <input id="workspace-query" name="q" defaultValue={directory.query} maxLength={120}
          placeholder={t("search")} className={`${controlPlaneInputClass} min-w-0 flex-1`} />
        <select name="scope" defaultValue={scope} aria-label={t("source")} className={`${controlPlaneInputClass} max-w-full`}>
          <option value="all">{t("allSources")}</option>
          <option value="local">{t("local")}</option>
          <option value="remote">{t("remote")}</option>
        </select>
        <button type="submit" title={t("search")} aria-label={t("search")} className={`${controlPlaneButtonClass} h-10 w-10 shrink-0 p-2`}>
          <Search size={16} aria-hidden="true" />
        </button>
      </form>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-muted" aria-label={t("pageSummary")}>
        <span>{t("onPage", { count: directory.rows.length })}</span>
        <span>{t("localCount", { count: directory.coverage.counts.local })}</span>
        <span>{t("remoteCount", { count: directory.coverage.counts.remote })}</span>
        <a href="#inventory-coverage" className="underline">{t("partialInventory")}</a>
      </div>

      <div className="overflow-x-auto border-y border-line">
        <table className="w-full min-w-[640px] text-left text-sm">
          <thead className="border-b border-line text-xs text-muted">
            <tr>{["workspace", "account", "source", "status", "plan"].map((key) => <th key={key} scope="col" className="px-3 py-3 font-medium">{t(key)}</th>)}</tr>
          </thead>
          <tbody>
            {directory.rows.map((row) => {
              const href = row.source === "local" ? `/control-plane/workspaces/${encodeURIComponent(row.workspaceId)}`
                : row.deploymentId ? `/control-plane/deployments/${encodeURIComponent(row.deploymentId)}` : null;
              return <tr key={row.key} className="border-b border-line last:border-0 hover:bg-bg-alt">
                <td className="max-w-[320px] px-3 py-4">
                  {href ? <Link href={href} className="break-words font-medium text-text-strong hover:underline">{row.name}</Link>
                    : <span className="break-words font-medium">{row.name}</span>}
                  {row.slug && <div className="mt-1 break-all text-xs text-muted">{row.slug}</div>}
                </td>
                <td className="max-w-[240px] break-words px-3 py-4 text-muted">{row.accountLabel ?? t("unlinked")}</td>
                <td className="px-3 py-4 text-muted">{t(row.source === "local" ? "local" : "remote")}</td>
                <td className="px-3 py-4"><StatusBadge status={row.observedStatus?.toLowerCase() ?? "unknown"} /></td>
                <td className="px-3 py-4 text-muted">{row.plan?.replace(/_/g, " ") ?? t("unknown")}</td>
              </tr>;
            })}
            {directory.rows.length === 0 && <tr><td colSpan={5} className="px-3 py-12 text-center text-muted">{t("empty")}</td></tr>}
          </tbody>
        </table>
      </div>

      <nav aria-label={t("pagination")} className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          {cursor && <Link href={directoryHref(directory.query, undefined, [], scope)} className={controlPlaneButtonClass}>{t("firstPage")}</Link>}
          {cursor && history.length > 0 && <Link href={previousHref} className={controlPlaneButtonClass}><ArrowLeft size={14} aria-hidden="true" />{t("previous")}</Link>}
        </div>
        {directory.nextCursor && <Link href={directoryHref(directory.query, directory.nextCursor, [...history, cursor ?? "start"].slice(-20), scope)}
          className={controlPlaneButtonClass}>{t("next")}<ArrowRight size={14} aria-hidden="true" /></Link>}
      </nav>

      <details id="inventory-coverage" className="border-t border-line pt-4 text-xs text-muted">
        <summary className="cursor-pointer font-medium">{t("coverage")}</summary>
        <dl className="mt-3 grid gap-2 sm:grid-cols-[180px_1fr]">
          <dt>{t("local")}</dt><dd>{t("localCoverage")}</dd>
          <dt>{t("remote")}</dt><dd>{t("remoteCoverage")}</dd>
          <dt>{t("health")}</dt><dd>{t("healthCoverage")}</dd>
        </dl>
        <Link href="/control-plane/self-serve" className="mt-3 inline-block underline">{t("onboarding")}</Link>
      </details>
    </div>
  );
}
