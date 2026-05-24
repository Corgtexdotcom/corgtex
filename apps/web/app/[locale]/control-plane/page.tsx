import { notFound } from "next/navigation";
import { getControlPlaneLatestReleaseTarget, isControlPlaneRailwayDeployConfigured, listControlPlaneFleetPage, listControlPlaneReleaseRolloutJobs, requireControlPlaneAccess } from "@corgtex/domain";
import { Link } from "@/i18n/routing";
import { requirePageActor } from "@/lib/auth";
import { enqueueDeployLatestRolloutAction } from "./actions";
import { cn } from "@/lib/utils";
import {
  Users,
  CheckCircle,
  AlertTriangle,
  Radio,
  Shuffle,
  ShieldCheck,
  Search,
  ArrowRight,
  TrendingUp,
  Cpu,
} from "lucide-react";

export const dynamic = "force-dynamic";

type FleetPage = Awaited<ReturnType<typeof listControlPlaneFleetPage>>;
type FleetCustomer = FleetPage["items"][number];
type ReleaseRollout = Awaited<ReturnType<typeof listControlPlaneReleaseRolloutJobs>>[number];

const PAGE_SIZE = 25;

function statusTone(status?: string | null) {
  if (status === "ok" || status === "active" || status === "connected") return "text-emerald-400 bg-emerald-500/10 border-emerald-500/20";
  if (status === "attention" || status === "degraded" || status === "provisioning" || status === "configured" || status === "pending") return "text-amber-400 bg-amber-500/10 border-amber-500/20";
  if (status === "down" || status === "suspended" || status === "failed" || status === "FAILED") return "text-rose-400 bg-rose-500/10 border-rose-500/20";
  return "text-slate-400 bg-slate-500/10 border-slate-500/20";
}

function statusDot(status?: string | null) {
  if (status === "ok" || status === "active" || status === "connected") return "bg-emerald-500 shadow-emerald-500/40 animate-pulse";
  if (status === "attention" || status === "degraded" || status === "provisioning" || status === "configured" || status === "pending") return "bg-amber-500 shadow-amber-500/40";
  if (status === "down" || status === "suspended" || status === "failed" || status === "FAILED") return "bg-rose-500 shadow-rose-500/40 animate-ping";
  return "bg-slate-500";
}

function label(value?: string | null) {
  return value ? value.replace(/_/g, " ") : "unknown";
}

function latestSnapshot(customer: FleetCustomer, kind: string) {
  return customer.fleetSnapshots?.find((snapshot) => snapshot.snapshotKind === kind) ?? null;
}

function releaseDrift(customer: FleetCustomer) {
  return customer.lastHealthError?.includes("Release drift:")
    ? customer.lastHealthError
    : latestSnapshot(customer, "RELEASE")?.error ?? null;
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

function payloadString(payload: ReleaseRollout["payload"], key: string) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const value = payload[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function rolloutTarget(payload: ReleaseRollout["payload"]) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const target = payload.target;
  if (!target || typeof target !== "object" || Array.isArray(target)) return null;
  const targetRecord = target as Record<string, unknown>;
  const releaseImageTag = typeof targetRecord.releaseImageTag === "string" ? targetRecord.releaseImageTag : null;
  const releaseVersion = typeof targetRecord.releaseVersion === "string" ? targetRecord.releaseVersion : null;
  return releaseVersion ? `${releaseImageTag ?? "unknown"} / ${releaseVersion}` : releaseImageTag;
}

export default async function ControlPlanePage({
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
  const [fleet, recentRollouts] = await Promise.all([
    listControlPlaneFleetPage(actor, {
      query: raw?.q,
      health: raw?.health,
      support: raw?.support,
      region: raw?.region,
      owner: raw?.owner,
      sort: raw?.sort,
      direction: raw?.direction,
      page: Number(raw?.page ?? 1),
      pageSize: PAGE_SIZE,
    }),
    listControlPlaneReleaseRolloutJobs(actor, { take: 8 }),
  ]);
  const latestReleaseTarget = getControlPlaneLatestReleaseTarget();
  const releaseExecutionConfigured = isControlPlaneRailwayDeployConfigured();
  const canQueueReleaseRollouts = Boolean(latestReleaseTarget && releaseExecutionConfigured);
  const releaseQueueLabel = !latestReleaseTarget
    ? "Latest release not configured"
    : releaseExecutionConfigured
      ? "Queue rollouts"
      : "Railway token not configured";
  const fleetLabelByDeploymentId = new Map(fleet.items.map((customer) => [customer.id, customer.label]));
  const paginationFilters = {
    q: fleet.filters.query,
    health: fleet.filters.health,
    support: fleet.filters.support,
    region: fleet.filters.region,
    owner: fleet.filters.owner,
    sort: fleet.filters.sort,
    direction: fleet.filters.direction,
  };
  const previousHref = queryString({ ...paginationFilters, page: Math.max(fleet.page - 1, 1) });
  const nextHref = queryString({ ...paginationFilters, page: Math.min(fleet.page + 1, fleet.pageCount) });

  return (
    <div className="space-y-6 pb-12 animate-in fade-in duration-300">
      
      {/* Page Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-[#1f2430] pb-6">
        <div>
          <span className="text-[10px] font-bold tracking-widest text-brand-400 uppercase">
            Private operations surface
          </span>
          <h1 className="text-2xl font-bold tracking-tight text-white mt-1">
            Fleet Control Plane
          </h1>
          <p className="text-xs text-slate-400 mt-1 max-w-2xl">
            Real-time operations dashboard for Corgtex customer deployments. Monitor runtime health, feature flag overrides, enterprise integrations, and version rollouts.
          </p>
        </div>

        {/* Global deploy action shortcut strip */}
        <div className="bg-[#0f121d] border border-[#23293b] rounded-xl p-4 flex flex-col sm:flex-row sm:items-center gap-4">
          <div>
            <h4 className="text-xs font-bold text-white flex items-center gap-1.5">
              <Shuffle className="w-3.5 h-3.5 text-brand-400" />
              Upgrade All Eligible
            </h4>
            <p className="text-[10px] text-slate-500 mt-0.5">
              Deploys latest stable release to healthy environments.
            </p>
          </div>
          <form action={enqueueDeployLatestRolloutAction} className="flex gap-2">
            <input type="hidden" name="allEligible" value="true" />
            <input type="hidden" name="limit" value="100" />
            <input type="hidden" name="reason" value="Deploy latest rollout scheduled from Dashboard" />
            <button
              type="submit"
              disabled={!canQueueReleaseRollouts}
              className={cn(
                "font-semibold text-xs px-3.5 py-2 rounded-lg shadow transition-all duration-150",
                canQueueReleaseRollouts
                  ? "bg-brand-600 hover:bg-brand-500 text-white"
                  : "bg-[#141822]/40 border border-[#202738]/60 text-slate-500 cursor-not-allowed"
              )}
            >
              {releaseQueueLabel}
            </button>
          </form>
        </div>
      </div>

      {/* Top Telemetry Stats Grid */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        {[
          { title: "Registered Customers", value: fleet.summary.totalCustomers, detail: "across active fleet", icon: Users, tone: "text-slate-400" },
          { title: "Active Deployments", value: fleet.summary.active, detail: "provisioned instances", icon: CheckCircle, tone: "text-emerald-400" },
          { title: "Needs Attention", value: fleet.summary.attention, detail: "open preparation gaps", icon: AlertTriangle, tone: fleet.summary.attention > 0 ? "text-amber-400" : "text-slate-400" },
          { title: "Support Ready", value: fleet.summary.supportReady, detail: "connectors active", icon: ShieldCheck, tone: "text-indigo-400" },
          { title: "Release Drift", value: fleet.summary.releaseDrift, detail: "drift signals recorded", icon: Radio, tone: fleet.summary.releaseDrift > 0 ? "text-rose-400" : "text-slate-400" },
        ].map((card, i) => {
          const Icon = card.icon;
          return (
            <div key={i} className="bg-[#0b0d12] border border-[#1f2430] hover:border-[#2b3244] rounded-xl p-4 flex items-start justify-between shadow-sm transition-all duration-150 group">
              <div className="space-y-1">
                <span className="text-[10px] font-semibold text-slate-500 tracking-wider block uppercase">
                  {card.title}
                </span>
                <span className="text-2xl font-bold text-white tracking-tight block">
                  {card.value}
                </span>
                <span className="text-[10px] text-slate-400 block">
                  {card.detail}
                </span>
              </div>
              <div className={cn("p-2 rounded-lg bg-[#141822] border border-[#202738] group-hover:scale-105 transition-transform", card.tone)}>
                <Icon className="w-4 h-4" />
              </div>
            </div>
          );
        })}
      </div>

      {/* Dense Fleet Dashboard Layout (Main content + sidebar right) */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        
        {/* Customer Fleet List Table (Col Span 2) */}
        <div className="lg:col-span-2 space-y-4 bg-[#0b0d12] border border-[#1f2430] rounded-xl p-5 shadow-sm">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-[#1f2430]">
            <div>
              <h2 className="text-sm font-bold text-white">Active Telemetry Fleet</h2>
              <p className="text-[10px] text-slate-500 mt-0.5">Filter, search, or inspect details of Corgtex hosted clients.</p>
            </div>
            
            {/* Filter controls */}
            <form method="get" className="flex flex-wrap gap-2">
              <input
                name="q"
                defaultValue={fleet.filters.query}
                placeholder="Search..."
                className="bg-[#141822] border border-[#202738] text-xs text-slate-200 placeholder-slate-500 rounded-lg px-2.5 py-1.5 focus:border-[#2f3952] focus:ring-0 focus:outline-none"
              />
              <select
                name="health"
                defaultValue={fleet.filters.health}
                className="bg-[#141822] border border-[#202738] text-xs text-slate-400 rounded-lg px-2 py-1.5 focus:border-[#2f3952] focus:outline-none"
              >
                <option value="">Any health</option>
                <option value="ok">Healthy</option>
                <option value="degraded">Degraded</option>
                <option value="down">Down</option>
              </select>
              <button
                type="submit"
                className="bg-[#1c2230] hover:bg-[#252d40] border border-[#2e374d] text-xs text-slate-300 px-3 py-1.5 rounded-lg transition-colors"
              >
                Apply
              </button>
            </form>
          </div>

          {/* Interactive Multi-Select Deploy Rollout Panel */}
          <form action={enqueueDeployLatestRolloutAction} className="space-y-4">
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-xs">
                <thead>
                  <tr className="border-b border-[#1f2430] text-slate-400 text-left font-medium">
                    <th className="p-3 w-8"><span className="sr-only">Select</span></th>
                    <th className="p-3">Customer</th>
                    <th className="p-3">Health Status</th>
                    <th className="p-3">Active Version</th>
                    <th className="p-3">Support Connector</th>
                    <th className="p-3">Owner</th>
                    <th className="p-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#1f2430]/60">
                  {fleet.items.map((customer) => {
                    const health = customer.lastHealthStatus || latestSnapshot(customer, "HEALTH")?.status || customer.provisioningStatus;
                    const drift = releaseDrift(customer);
                    const supportStatus = customer.hasSupportCredential ? customer.supportConnectorStatus : "not_configured";
                    
                    return (
                      <tr key={customer.id} className="hover:bg-[#141822]/40 transition-colors group">
                        <td className="p-3">
                          {customer.hasDeployment ? (
                            <input
                              type="checkbox"
                              name="deploymentIds"
                              value={customer.id}
                              disabled={!canQueueReleaseRollouts}
                              className="rounded border-[#202738] bg-[#141822] text-brand-600 focus:ring-0 focus:ring-offset-0"
                            />
                          ) : null}
                        </td>
                        <td className="p-3 min-w-[180px]">
                          <span className="font-semibold text-white group-hover:text-brand-400 transition-colors block">
                            {customer.label}
                          </span>
                          <span className="text-[10px] text-slate-500 block truncate mt-0.5">
                            {customer.customerSlug || customer.customerAccount?.slug || customer.url}
                          </span>
                        </td>
                        <td className="p-3">
                          <div className="flex items-center gap-2">
                            <span className={cn("w-1.5 h-1.5 rounded-full shrink-0", statusDot(health))} />
                            <span className={cn("px-2 py-0.5 rounded-full text-[10px] font-semibold border capitalize", statusTone(health))}>
                              {label(health)}
                            </span>
                          </div>
                        </td>
                        <td className="p-3">
                          <span className="font-medium text-slate-300 block">
                            {customer.releaseImageTag || customer.releaseVersion || "Unknown"}
                          </span>
                          {drift ? (
                            <span className="text-[9px] text-rose-400 font-semibold block mt-0.5">Drift recorded</span>
                          ) : (
                            <span className="text-[9px] text-slate-500 block mt-0.5">Aligned</span>
                          )}
                        </td>
                        <td className="p-3">
                          <span className={cn("font-semibold uppercase text-[10px] block", supportStatus === "connected" ? "text-emerald-400" : "text-slate-500")}>
                            {label(supportStatus)}
                          </span>
                          <span className="text-[9px] text-slate-500 block mt-0.5">
                            {customer.managedWorkspace ? "Managed" : "Remote"}
                          </span>
                        </td>
                        <td className="p-3 text-slate-400 truncate">
                          {customer.supportOwnerEmail || "Unassigned"}
                        </td>
                        <td className="p-3 text-right">
                          <Link
                            href={`/control-plane/deployments/${customer.id}`}
                            className="inline-flex items-center gap-1 bg-[#141822] hover:bg-[#1d2333] border border-[#202738] hover:border-[#2f3952] text-slate-300 hover:text-white px-2.5 py-1.5 rounded-lg text-[10px] font-medium transition-all"
                          >
                            Open
                            <ArrowRight className="w-3 h-3 text-slate-500 group-hover:text-brand-400 transition-colors" />
                          </Link>
                        </td>
                      </tr>
                    );
                  })}
                  {fleet.items.length === 0 && (
                    <tr>
                      <td colSpan={7} className="text-center py-8 text-slate-500">
                        No enterprise deployments found matching these query parameters.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {/* Bulk select rollout submit trigger */}
            {fleet.items.length > 0 && (
              <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 pt-4 border-t border-[#1f2430]">
                <div className="flex-1 max-w-sm">
                  <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block mb-1.5">
                    Upgrade rollout explanation
                  </label>
                  <input
                    name="reason"
                    required
                    defaultValue="Execute stable release upgrade via control-plane selection."
                    className="bg-[#141822] border border-[#202738] text-xs text-slate-200 rounded-lg px-3 py-2 w-full focus:border-[#2f3952] focus:outline-none"
                  />
                </div>
                <div className="flex items-center gap-4">
                  <label className="flex items-center gap-2 text-xs text-slate-400 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      name="includeUnhealthy"
                      disabled={!canQueueReleaseRollouts}
                      className="rounded border-[#202738] bg-[#141822] text-brand-600 focus:ring-0"
                    />
                    Override health blocks
                  </label>
                  <button
                    type="submit"
                    disabled={!canQueueReleaseRollouts}
                    className={cn(
                      "border font-semibold text-xs px-4 py-2 rounded-lg shadow-sm transition-all duration-150",
                      canQueueReleaseRollouts
                        ? "bg-[#141822] hover:bg-[#1d2333] border-[#202738] hover:border-[#2f3952] text-slate-200 hover:text-white"
                        : "bg-[#141822]/40 border-[#202738]/60 text-slate-500 cursor-not-allowed"
                    )}
                  >
                    {canQueueReleaseRollouts ? "Deploy Selected" : releaseQueueLabel}
                  </button>
                </div>
              </div>
            )}
          </form>

          {/* Table pagination footer */}
          <div className="flex items-center justify-between pt-2 text-[10px] text-slate-500">
            <span>
              Page {fleet.page} of {fleet.pageCount} (Showing {fleet.items.length} of {fleet.total} customers)
            </span>
            <div className="flex gap-2">
              {fleet.page > 1 ? (
                <Link href={previousHref} className="bg-[#141822] hover:bg-[#1d2333] border border-[#202738] text-slate-400 hover:text-slate-200 px-2 py-1 rounded transition-colors">
                  Previous
                </Link>
              ) : (
                <span className="bg-[#141822]/40 border border-[#202738]/50 text-slate-600 px-2 py-1 rounded select-none cursor-not-allowed">
                  Previous
                </span>
              )}
              {fleet.page < fleet.pageCount ? (
                <Link href={nextHref} className="bg-[#141822] hover:bg-[#1d2333] border border-[#202738] text-slate-400 hover:text-slate-200 px-2 py-1 rounded transition-colors">
                  Next
                </Link>
              ) : (
                <span className="bg-[#141822]/40 border border-[#202738]/50 text-slate-600 px-2 py-1 rounded select-none cursor-not-allowed">
                  Next
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Right Sidebar: Telemetry Logs & Alerts (Col Span 1) */}
        <div className="space-y-6">
          
          {/* Actionable Alerts Box */}
          <div className="bg-[#0b0d12] border border-[#1f2430] rounded-xl p-5 shadow-sm space-y-4">
            <div>
              <h3 className="text-sm font-bold text-white flex items-center gap-1.5">
                <AlertTriangle className="w-4 h-4 text-amber-500" />
                Outstanding Health Alerts
              </h3>
              <p className="text-[10px] text-slate-500 mt-0.5">Fleet segments reporting Degraded or Down status signals.</p>
            </div>
            
            <div className="space-y-2 max-h-[220px] overflow-y-auto scrollbar-thin">
              {fleet.items
                .filter((c) => {
                  const health = c.lastHealthStatus || latestSnapshot(c, "HEALTH")?.status || c.provisioningStatus;
                  return health !== "ok" && health !== "active" && health !== "connected";
                })
                .map((customer) => {
                  const health = customer.lastHealthStatus || latestSnapshot(customer, "HEALTH")?.status || customer.provisioningStatus;
                  const drift = releaseDrift(customer);
                  return (
                    <Link
                      key={customer.id}
                      href={`/control-plane/deployments/${customer.id}`}
                      className="flex flex-col p-2.5 rounded-lg bg-[#141822] border border-amber-500/10 hover:border-amber-500/20 hover:bg-[#1a202d] transition-all block group"
                    >
                      <div className="flex items-center justify-between">
                        <strong className="text-white group-hover:text-brand-400 transition-colors text-xs font-semibold">
                          {customer.label}
                        </strong>
                        <span className={cn("px-1.5 py-0.5 rounded text-[8px] font-bold border capitalize shrink-0", statusTone(health))}>
                          {label(health)}
                        </span>
                      </div>
                      <p className="text-[10px] text-slate-400 mt-1 truncate">
                        {drift || "Support sync issue detected."}
                      </p>
                    </Link>
                  );
                })}
              {fleet.items.filter((c) => {
                const health = c.lastHealthStatus || latestSnapshot(c, "HEALTH")?.status || c.provisioningStatus;
                return health !== "ok" && health !== "active" && health !== "connected";
              }).length === 0 && (
                <div className="text-center py-6 text-slate-500 text-[10px] bg-[#141822]/30 border border-[#202738] rounded-lg">
                  All active fleet deployments are fully healthy.
                </div>
              )}
            </div>
          </div>

          {/* Rollouts Telemetry Logs */}
          <div className="bg-[#0b0d12] border border-[#1f2430] rounded-xl p-5 shadow-sm space-y-4">
            <div className="flex items-center justify-between border-b border-[#1f2430] pb-3">
              <div>
                <h3 className="text-sm font-bold text-white flex items-center gap-1.5">
                  <Cpu className="w-4 h-4 text-brand-400" />
                  Rollout Progress Log
                </h3>
                <p className="text-[10px] text-slate-500 mt-0.5">Telemetry log for queued release rollouts.</p>
              </div>
              <span className="px-2 py-0.5 rounded bg-[#141822] border border-[#202738] text-[9px] font-bold text-slate-400">
                {recentRollouts.length} active
              </span>
            </div>

            <div className="space-y-3 max-h-[360px] overflow-y-auto scrollbar-thin pr-1">
              {recentRollouts.map((rollout) => {
                const deploymentId = payloadString(rollout.payload, "deploymentId");
                const customerLabel = deploymentId ? fleetLabelByDeploymentId.get(deploymentId) ?? deploymentId : "Unknown client";
                const target = rolloutTarget(rollout.payload);
                const status = rollout.status;
                
                return (
                  <div key={rollout.id} className="p-3 rounded-lg bg-[#141822] border border-[#202738] space-y-1.5">
                    <div className="flex items-center justify-between">
                      <strong className="text-white text-xs font-semibold">{customerLabel}</strong>
                      <span className={cn("px-1.5 py-0.5 rounded text-[8px] font-bold border capitalize shrink-0", statusTone(status))}>
                        {label(status)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between text-[9px] text-slate-500">
                      <span>Target: {target || "not recorded"}</span>
                      <span>Attempts: {rollout.attempts}</span>
                    </div>
                    {rollout.error && (
                      <p className="text-[9px] text-rose-400 bg-rose-500/5 border border-rose-500/10 rounded p-1.5 mt-1 font-mono leading-tight whitespace-pre-wrap">
                        {rollout.error}
                      </p>
                    )}
                  </div>
                );
              })}
              {recentRollouts.length === 0 && (
                <div className="text-center py-6 text-slate-500 text-[10px]">
                  No deploy latest jobs have been queued recently.
                </div>
              )}
            </div>
          </div>

        </div>

      </div>

    </div>
  );
}
