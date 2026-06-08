import { notFound } from "next/navigation";
import { getControlPlaneClientOptions, listControlPlaneRecorderMatrix, requireControlPlaneAccess } from "@corgtex/domain";
import { Link } from "@/i18n/routing";
import { requirePageActor } from "@/lib/auth";
import { cn } from "@/lib/utils";
import { ClientContextSwitcher } from "../_components/client-context-switcher";
import {
  ControlPlaneCacheMeta,
  ControlPlanePageHeader,
  ControlPlaneStatusStrip,
  controlPlaneButtonClass,
  controlPlaneInputClass,
} from "../_components/control-plane-ui";
import { controlPlaneActorCacheKey, readControlPlaneCached, shouldRefreshControlPlaneCache } from "../cache";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 25;

type RecorderPage = Awaited<ReturnType<typeof listControlPlaneRecorderMatrix>>;
type RecorderRow = RecorderPage["items"][number];

function statusTone(status?: string | null) {
  if (status === "ready" || status === "available" || status === "active" || status === "connected") return "text-emerald-400 bg-emerald-500/10 border-emerald-500/20";
  if (status === "needs_setup" || status === "not_configured" || status === "requires_connector" || status === "unavailable" || status === "pending") return "text-amber-400 bg-amber-500/10 border-amber-500/20";
  if (status === "disabled" || status === "failed" || status === "FAILED") return "text-rose-400 bg-rose-500/10 border-rose-500/20";
  return "text-muted bg-slate-500/10 border-slate-500/20";
}

function statusDot(status?: string | null) {
  if (status === "ready" || status === "available" || status === "active" || status === "connected") return "bg-emerald-500 shadow-emerald-500/40";
  if (status === "needs_setup" || status === "not_configured" || status === "requires_connector" || status === "unavailable" || status === "pending") return "bg-amber-500 shadow-amber-500/40";
  if (status === "disabled" || status === "failed" || status === "FAILED") return "bg-rose-500 shadow-rose-500/40";
  return "bg-slate-500";
}

function label(value?: string | null) {
  return value ? value.replace(/_/g, " ") : "unknown";
}

function queryString(params: Record<string, string | number | null | undefined>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && String(value).length > 0) {
      search.set(key, String(value));
    }
  }
  return `?${search.toString()}`;
}

function formatDate(value: Date | null) {
  if (!value) return "Never";
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(value);
}

function usageLabel(row: RecorderRow) {
  if (row.monthlyUsageMinutes === null) return "Unavailable";
  if (row.monthlyMinuteCap === null || row.monthlyMinuteCap <= 0) return `${row.monthlyUsageMinutes} min`;
  return `${row.monthlyUsageMinutes} / ${row.monthlyMinuteCap} min`;
}

export default async function ControlPlaneRecordersPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | undefined>>;
}) {
  const actor = await requirePageActor();
  try {
    await requireControlPlaneAccess(actor);
  } catch {
    notFound();
  }

  const raw = await searchParams;
  const refresh = shouldRefreshControlPlaneCache(raw?.refresh);
  const actorCacheKey = controlPlaneActorCacheKey(actor);
  const recorderParams = {
    query: raw?.q,
    client: raw?.client,
    status: raw?.status,
    page: Number(raw?.page ?? 1),
    pageSize: PAGE_SIZE,
  };
  const [recorderMatrixRead, clientOptionsRead] = await Promise.all([
    readControlPlaneCached(["control-plane", "recorders", actorCacheKey, recorderParams], refresh, () => (
      listControlPlaneRecorderMatrix(actor, recorderParams)
    )),
    readControlPlaneCached(["control-plane", "client-options", actorCacheKey], refresh, () => (
      getControlPlaneClientOptions(actor)
    )),
  ]);
  const recorderMatrix = recorderMatrixRead.data;
  const clientOptions = clientOptionsRead.data;
  const paginationFilters = {
    q: recorderMatrix.filters.query,
    client: recorderMatrix.filters.client,
    status: recorderMatrix.filters.status,
  };
  const previousHref = queryString({ ...paginationFilters, page: Math.max(recorderMatrix.page - 1, 1) });
  const nextHref = queryString({ ...paginationFilters, page: Math.min(recorderMatrix.page + 1, recorderMatrix.pageCount) });
  const refreshHref = queryString({ ...paginationFilters, page: recorderMatrix.page, refresh: 1 });

  return (
    <div className="space-y-5 pb-12">
      <ControlPlanePageHeader
        eyebrow="Function matrix"
        title="Recorder Control Plane"
        description="Client-by-client recorder entitlement, configuration, provider, usage, readiness, calendar, and smoke-run state."
      />

      <ControlPlaneStatusStrip
        items={[
          { label: "Clients", value: recorderMatrix.summary.totalClients, detail: "in matrix" },
          { label: "Available", value: recorderMatrix.summary.available, detail: "configured", status: recorderMatrix.summary.available > 0 ? "available" : "unknown" },
          { label: "Ready", value: recorderMatrix.summary.ready, detail: "passing", status: "ready" },
          { label: "Needs setup", value: recorderMatrix.summary.needsSetup, detail: "gaps", status: recorderMatrix.summary.needsSetup > 0 ? "needs_setup" : "ok" },
          { label: "Connector", value: recorderMatrix.summary.requiresConnector, detail: "required", status: recorderMatrix.summary.requiresConnector > 0 ? "requires_connector" : "ok" },
        ]}
      />

      <ControlPlaneCacheMeta
        cachedAt={recorderMatrixRead.cachedAt}
        cacheStatus={recorderMatrixRead.cacheStatus}
        refreshAction={<Link href={refreshHref} className={controlPlaneButtonClass}>Refresh live data</Link>}
      />

      <div className="bg-bg-alt border border-line rounded-xl p-5 shadow-sm space-y-4">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3 pb-4 border-b border-line">
          <div>
            <h2 className="text-sm font-bold text-white">Recorder Function Matrix</h2>
            <p className="text-[10px] text-muted mt-0.5">Filter by client, readiness status, or provider/configuration text.</p>
          </div>

          <form method="get" className="flex flex-wrap items-center gap-2">
            <input
              name="q"
              defaultValue={recorderMatrix.filters.query}
              placeholder="Search..."
              className={controlPlaneInputClass}
            />
            <input type="hidden" name="client" value={recorderMatrix.filters.client} />
            <ClientContextSwitcher
              clients={clientOptions}
              selectedClientId={recorderMatrix.filters.client}
              mode="filter"
              label="Client"
            />
            <select
              name="status"
              defaultValue={recorderMatrix.filters.status}
              className={controlPlaneInputClass}
            >
              <option value="">Any status</option>
              <option value="available">Available</option>
              <option value="ready">Ready</option>
              <option value="needs_setup">Needs setup</option>
              <option value="not_configured">Not configured</option>
              <option value="disabled">Disabled</option>
              <option value="requires_connector">Requires connector</option>
              <option value="unavailable">Unavailable</option>
            </select>
            <button
              type="submit"
              className={controlPlaneButtonClass}
            >
              Apply
            </button>
          </form>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr className="border-b border-line text-muted text-left font-medium">
                <th className="p-3">Client</th>
                <th className="p-3">Availability</th>
                <th className="p-3">Entitlement</th>
                <th className="p-3">Provider</th>
                <th className="p-3">Monthly Usage</th>
                <th className="p-3">Failures</th>
                <th className="p-3">Calendar Source</th>
                <th className="p-3">Last Smoke Run</th>
                <th className="p-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {recorderMatrix.items.map((row) => (
                <tr key={row.deploymentId} className="hover:bg-surface/40 transition-colors group">
                  <td className="p-3 min-w-[180px]">
                    <span className="font-semibold text-white group-hover:text-brand-400 transition-colors block">
                      {row.clientLabel}
                    </span>
                    <span className="text-[10px] text-muted block truncate mt-0.5">
                      {row.clientSlug || row.deploymentId}
                    </span>
                  </td>
                  <td className="p-3 min-w-[180px]">
                    <div className="flex items-center gap-2">
                      <span className={cn("w-1.5 h-1.5 rounded-full shrink-0", statusDot(row.availability.status))} />
                      <span className={cn("px-2 py-0.5 rounded-full text-[10px] font-semibold border capitalize", statusTone(row.availability.status))}>
                        {label(row.availability.status)}
                      </span>
                    </div>
                    <span className="text-[9px] text-muted block mt-1 truncate">
                      Readiness: {label(row.status)}
                    </span>
                    <span className="text-[9px] text-muted block mt-1 truncate">
                      {row.readiness.detail}
                    </span>
                    {row.readiness.failedChecks.length > 0 && (
                      <details className="mt-1 text-[9px] text-muted">
                        <summary className="cursor-pointer text-amber-300">View checks</summary>
                        <div className="mt-1 space-y-1 rounded-md border border-line bg-bg p-2">
                          {row.readiness.failedChecks.map((check) => (
                            <p key={check.key} className="whitespace-pre-wrap">
                              <strong className="text-text">{check.label}:</strong> {check.detail}
                            </p>
                          ))}
                        </div>
                      </details>
                    )}
                  </td>
                  <td className="p-3">
                    <span className={cn("font-semibold uppercase text-[10px] block", row.entitlementEnabled ? "text-emerald-400" : "text-muted")}>
                      {row.entitlementEnabled === null ? "unavailable" : row.entitlementEnabled ? "enabled" : "disabled"}
                    </span>
                    <span className="text-[9px] text-muted block mt-0.5">
                      {row.configured === null ? "config unavailable" : row.configured ? "configured" : "not configured"}
                    </span>
                  </td>
                  <td className="p-3 text-text">
                    {row.provider ?? "Unavailable"}
                  </td>
                  <td className="p-3 text-text">
                    {usageLabel(row)}
                  </td>
                  <td className="p-3">
                    <span className={cn("font-semibold", row.failureCount && row.failureCount > 0 ? "text-rose-400" : "text-text")}>
                      {row.failureCount ?? "n/a"}
                    </span>
                  </td>
                  <td className="p-3 min-w-[160px]">
                    <span className="text-text block">
                      {row.calendarSource?.label ?? "Unavailable"}
                    </span>
                    <span className="text-[9px] text-muted block mt-0.5">
                      {row.calendarSource ? `${label(row.calendarSource.status)} · ${formatDate(row.calendarSource.lastSyncAt)}` : "No source"}
                    </span>
                  </td>
                  <td className="p-3 min-w-[130px]">
                    <span className={cn("font-semibold uppercase text-[10px] block", row.lastSmokeRun?.status === "COMPLETED" ? "text-emerald-400" : "text-muted")}>
                      {row.lastSmokeRun?.status ?? "none"}
                    </span>
                    <span className="text-[9px] text-muted block mt-0.5">
                      {formatDate(row.lastSmokeRun?.createdAt ?? null)}
                    </span>
                  </td>
                  <td className="p-3 text-right">
                    {row.hasDeployment ? (
                      <Link
                        href={`/control-plane/deployments/${row.deploymentId}?tab=config`}
                        className={controlPlaneButtonClass}
                      >
                        Open client
                      </Link>
                    ) : (
                      <span className="inline-flex items-center bg-surface/40 border border-line/60 text-muted px-2.5 py-1.5 rounded-lg text-[10px] font-medium">
                        No deployment
                      </span>
                    )}
                  </td>
                </tr>
              ))}
              {recorderMatrix.items.length === 0 && (
                <tr>
                  <td colSpan={9} className="text-center py-8 text-muted">
                    No recorder rows found matching these query parameters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="flex items-center justify-between pt-2 text-[10px] text-muted">
          <span>
            Page {recorderMatrix.page} of {recorderMatrix.pageCount} (Showing {recorderMatrix.items.length} of {recorderMatrix.total} clients)
          </span>
          <div className="flex gap-2">
            {recorderMatrix.page > 1 ? (
              <Link href={previousHref} className={controlPlaneButtonClass}>
                Previous
              </Link>
            ) : (
              <span className="bg-surface/40 border border-line/50 text-muted px-2 py-1 rounded select-none cursor-not-allowed">
                Previous
              </span>
            )}
            {recorderMatrix.page < recorderMatrix.pageCount ? (
              <Link href={nextHref} className={controlPlaneButtonClass}>
                Next
              </Link>
            ) : (
              <span className="bg-surface/40 border border-line/50 text-muted px-2 py-1 rounded select-none cursor-not-allowed">
                Next
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
