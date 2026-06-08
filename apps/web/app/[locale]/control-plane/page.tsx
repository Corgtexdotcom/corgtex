import { notFound } from "next/navigation";
import {
  getControlPlaneFleetOverview,
  getControlPlaneLatestReleaseTarget,
  isControlPlaneRailwayDeployConfigured,
  listControlPlaneReleaseRolloutJobs,
  requireControlPlaneAccess,
} from "@corgtex/domain";
import { Link } from "@/i18n/routing";
import { requirePageActor } from "@/lib/auth";
import { enqueueDeployLatestRolloutAction } from "./actions";
import {
  ControlPlanePageHeader,
  ControlPlaneCacheMeta,
  ControlPlaneSection,
  ControlPlaneStatusStrip,
  DisabledActionHint,
  StatusBadge,
  controlPlaneButtonClass,
  controlPlaneInputClass,
  controlPlaneLabel,
} from "./_components/control-plane-ui";
import { ControlPlaneIssueDiagnostics, type ControlPlaneIssueView } from "./_components/issue-diagnostics";
import { controlPlaneActorCacheKey, readControlPlaneCached, shouldRefreshControlPlaneCache } from "./cache";

export const dynamic = "force-dynamic";

type FleetPage = Awaited<ReturnType<typeof getControlPlaneFleetOverview>>;
type ReleaseRollout = Awaited<ReturnType<typeof listControlPlaneReleaseRolloutJobs>>[number];

const PAGE_SIZE = 25;

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

function rolloutBlockerLabel(latestReleaseTarget: unknown, releaseExecutionConfigured: boolean) {
  if (!latestReleaseTarget) return "Latest release target is not configured.";
  if (!releaseExecutionConfigured) return "Railway token is not configured for rollout execution.";
  return null;
}

function serializeIssues(issues: FleetPage["items"][number]["issues"]): ControlPlaneIssueView[] {
  return issues.map((issue) => ({
    ...issue,
    observedAt: issue.observedAt ? issue.observedAt.toISOString() : null,
  }));
}

function formatFreshness(value?: Date | string | null) {
  if (!value) return "Not checked";
  const checkedAt = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(checkedAt.valueOf())) return "Not checked";
  const ageSeconds = Math.max(0, Math.round((Date.now() - checkedAt.getTime()) / 1000));
  if (ageSeconds < 60) return `${ageSeconds}s ago`;
  const ageMinutes = Math.floor(ageSeconds / 60);
  if (ageMinutes < 60) return `${ageMinutes}m ago`;
  const ageHours = Math.floor(ageMinutes / 60);
  if (ageHours < 24) return `${ageHours}h ago`;
  return `${Math.floor(ageHours / 24)}d ago`;
}

function issueStatusLabel(issues: FleetPage["items"][number]["issues"]) {
  if (issues.length === 0) return "ok";
  return issues.some((issue) => issue.severity === "critical") ? "failed" : "degraded";
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
  const refresh = shouldRefreshControlPlaneCache(raw?.refresh);
  const fleetParams = {
    query: raw?.q,
    health: raw?.health,
    support: raw?.support,
    region: raw?.region,
    owner: raw?.owner,
    unhealthy: raw?.unhealthy,
    issues: raw?.issues,
    missingTools: raw?.missingTools,
    stale: raw?.stale,
    sort: raw?.sort,
    direction: raw?.direction,
    page: Number(raw?.page ?? 1),
    pageSize: PAGE_SIZE,
  };
  const actorCacheKey = controlPlaneActorCacheKey(actor);
  const [fleetRead, recentRolloutsRead] = await Promise.all([
    readControlPlaneCached(["control-plane", "fleet", actorCacheKey, fleetParams], refresh, () => (
      getControlPlaneFleetOverview(actor, fleetParams)
    )),
    readControlPlaneCached(["control-plane", "rollouts", actorCacheKey, { take: 8 }], refresh, () => (
      listControlPlaneReleaseRolloutJobs(actor, { take: 8 })
    )),
  ]);
  const fleet = fleetRead.data;
  const recentRollouts = recentRolloutsRead.data;

  const latestReleaseTarget = getControlPlaneLatestReleaseTarget();
  const releaseExecutionConfigured = isControlPlaneRailwayDeployConfigured();
  const canQueueReleaseRollouts = Boolean(latestReleaseTarget && releaseExecutionConfigured);
  const rolloutBlocker = rolloutBlockerLabel(latestReleaseTarget, releaseExecutionConfigured);
  const fleetLabelByDeploymentId = new Map(fleet.items.map((customer) => [customer.id, customer.label]));
  const paginationFilters = {
    q: fleet.filters.query,
    health: fleet.filters.health,
    support: fleet.filters.support,
    region: fleet.filters.region,
    owner: fleet.filters.owner,
    unhealthy: fleet.filters.unhealthy ? "1" : "",
    issues: fleet.filters.issues ? "1" : "",
    missingTools: fleet.filters.missingTools ? "1" : "",
    stale: fleet.filters.stale ? "1" : "",
    sort: fleet.filters.sort,
    direction: fleet.filters.direction,
  };
  const previousHref = queryString({ ...paginationFilters, page: Math.max(fleet.page - 1, 1) });
  const nextHref = queryString({ ...paginationFilters, page: Math.min(fleet.page + 1, fleet.pageCount) });
  const refreshHref = queryString({ ...paginationFilters, page: fleet.page, refresh: 1 });
  const attentionItems = fleet.items.filter((customer) => customer.hasDeployment && customer.issues.length > 0);
  const firstAttentionIssue = attentionItems[0]?.issues[0] ? serializeIssues([attentionItems[0].issues[0]]) : [];

  return (
    <div className="space-y-5 pb-12">
      <ControlPlanePageHeader
        eyebrow="Private operations"
        title="Fleet Control Plane"
        description="Client operations matrix for deployment health, support readiness, recorder state, release drift, and support actions."
        actions={
          <form action={enqueueDeployLatestRolloutAction} className="flex flex-col gap-2 rounded-lg border border-line bg-bg-alt p-3">
            <input type="hidden" name="allEligible" value="true" />
            <input type="hidden" name="limit" value="100" />
            <input type="hidden" name="reason" value="Deploy latest rollout scheduled from control-plane fleet matrix." />
            <button type="submit" disabled={!canQueueReleaseRollouts} className={controlPlaneButtonClass}>
              Queue all eligible rollouts
            </button>
            {rolloutBlocker && <DisabledActionHint>{rolloutBlocker}</DisabledActionHint>}
          </form>
        }
      />

      <ControlPlaneCacheMeta
        cachedAt={fleetRead.cachedAt}
        cacheStatus={fleetRead.cacheStatus}
        refreshAction={<Link href={refreshHref} className={controlPlaneButtonClass}>Refresh live data</Link>}
      />

      <ControlPlaneStatusStrip
        items={[
          { label: "Customers", value: fleet.summary.totalCustomers, detail: "registered" },
          { label: "Deployments", value: fleet.summary.active, detail: "active" },
          {
            label: "Needs attention",
            value: fleet.summary.attention,
            detail: "open gaps",
            status: fleet.summary.attention > 0 ? "degraded" : "ok",
            action: firstAttentionIssue.length > 0 ? (
              <ControlPlaneIssueDiagnostics
                issues={firstAttentionIssue}
                hideBadges
                triggerLabel={<span className="sr-only">Open needs attention diagnostics</span>}
                triggerAriaLabel="Open needs attention diagnostics"
                triggerClassName="absolute inset-0 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-amber-400/70"
              />
            ) : null,
          },
          { label: "Support ready", value: fleet.summary.supportReady, detail: "connectors" },
          { label: "Release drift", value: fleet.summary.releaseDrift, detail: "signals", status: fleet.summary.releaseDrift > 0 ? "failed" : "ok" },
        ]}
      />

      <ControlPlaneSection
        id="fleet"
        title="Client Operations Matrix"
        description="Filter, inspect, and open the customer detail view for integration, recorder, user, release, and audit actions."
        actions={
          <form method="get" className="flex flex-wrap gap-2">
            <input name="q" defaultValue={fleet.filters.query} placeholder="Search clients..." className={controlPlaneInputClass} />
            <select name="health" defaultValue={fleet.filters.health} className={controlPlaneInputClass}>
              <option value="">Any health</option>
              <option value="ok">Healthy</option>
              <option value="degraded">Degraded</option>
              <option value="down">Down</option>
            </select>
            <select name="support" defaultValue={fleet.filters.support} className={controlPlaneInputClass}>
              <option value="">Any support</option>
              <option value="connected">Connected</option>
              <option value="not_configured">Not configured</option>
              <option value="degraded">Degraded</option>
            </select>
            <label className="flex min-h-9 items-center gap-2 rounded-md border border-line bg-surface px-3 text-xs text-muted">
              <input type="checkbox" name="unhealthy" value="1" defaultChecked={fleet.filters.unhealthy} className="rounded border-line bg-bg-alt text-brand-600 focus:ring-0" />
              Unhealthy
            </label>
            <label className="flex min-h-9 items-center gap-2 rounded-md border border-line bg-surface px-3 text-xs text-muted">
              <input type="checkbox" name="issues" value="1" defaultChecked={fleet.filters.issues} className="rounded border-line bg-bg-alt text-brand-600 focus:ring-0" />
              Open issues
            </label>
            <label className="flex min-h-9 items-center gap-2 rounded-md border border-line bg-surface px-3 text-xs text-muted">
              <input type="checkbox" name="missingTools" value="1" defaultChecked={fleet.filters.missingTools} className="rounded border-line bg-bg-alt text-brand-600 focus:ring-0" />
              Missing tools/apps
            </label>
            <label className="flex min-h-9 items-center gap-2 rounded-md border border-line bg-surface px-3 text-xs text-muted">
              <input type="checkbox" name="stale" value="1" defaultChecked={fleet.filters.stale} className="rounded border-line bg-bg-alt text-brand-600 focus:ring-0" />
              Stale data
            </label>
            <button type="submit" className={controlPlaneButtonClass}>Apply</button>
          </form>
        }
      >
        <form action={enqueueDeployLatestRolloutAction} className="space-y-4">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1260px] border-collapse text-xs">
              <thead>
                <tr className="border-b border-line text-left text-[10px] font-semibold uppercase tracking-wide text-muted">
                  <th className="p-3 w-8"><span className="sr-only">Select</span></th>
                  <th className="p-3">Client</th>
                  <th className="p-3">Health</th>
                  <th className="p-3">Support</th>
                  <th className="p-3">Agents</th>
                  <th className="p-3">Tools / Apps</th>
                  <th className="p-3">Issues</th>
                  <th className="p-3">Release / Recorder</th>
                  <th className="p-3">Last checked</th>
                  <th className="p-3 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {fleet.items.map((customer) => (
                  <tr key={customer.id} className="hover:bg-surface/40">
                    <td className="p-3">
                      {customer.hasDeployment && (
                        <input
                          type="checkbox"
                          name="deploymentIds"
                          value={customer.id}
                          disabled={!canQueueReleaseRollouts}
                          className="rounded border-line bg-surface text-brand-600 focus:ring-0 focus:ring-offset-0"
                          aria-label={`Select ${customer.label} for rollout`}
                        />
                      )}
                    </td>
                    <td className="p-3 min-w-[190px]">
                      <span className="block font-semibold text-white">{customer.label}</span>
                      <span className="mt-0.5 block truncate text-[10px] text-muted">{customer.slug || customer.id}</span>
                    </td>
                    <td className="p-3">
                      <StatusBadge status={customer.health.status} />
                      <span className="mt-1 block max-w-[180px] truncate text-[10px] text-muted">
                        {customer.health.detail || "No current error"}
                      </span>
                    </td>
                    <td className="p-3">
                      <StatusBadge status={customer.support.status} />
                      <span className="mt-1 block text-[10px] text-muted">{controlPlaneLabel(customer.support.mode)}</span>
                    </td>
                    <td className="p-3">
                      <StatusBadge status={customer.agents.status} />
                      <span className="mt-1 block text-[10px] text-muted">{customer.agents.runCount ?? "n/a"} runs</span>
                    </td>
                    <td className="p-3">
                      <StatusBadge status={customer.tools.status} />
                      <span className="mt-1 block text-[10px] text-muted">
                        {customer.tools.total ?? "n/a"} local signals
                      </span>
                      {customer.tools.total !== null && (
                        <span className="mt-1 block max-w-[220px] truncate text-[9px] text-muted">
                          Links {customer.tools.toolLinks} / creds {customer.tools.agentCredentials} / apps {customer.tools.enterpriseApps} / integrations {customer.tools.communicationIntegrations}
                        </span>
                      )}
                    </td>
                    <td className="p-3">
                      <StatusBadge status={issueStatusLabel(customer.issues)}>
                        {customer.issues.length === 0 ? "None" : `${customer.issues.length} open`}
                      </StatusBadge>
                      <ControlPlaneIssueDiagnostics issues={serializeIssues(customer.issues)} className="mt-2" />
                    </td>
                    <td className="p-3 min-w-[210px]">
                      <span className="block max-w-[190px] truncate font-medium text-text">{customer.release.label}</span>
                      <span className="mt-1 block text-[10px] text-muted">
                        {customer.release.detail ? "Release drift" : "Release aligned"}
                      </span>
                      <span className="mt-1 block text-[10px] text-muted">
                        Recorder: {controlPlaneLabel(customer.recorder.status)}
                        {customer.recorder.provider ? ` / ${customer.recorder.provider}` : ""}
                      </span>
                    </td>
                    <td className="p-3">
                      <span className="block font-semibold text-text">{formatFreshness(customer.lastCheckedAt)}</span>
                      <span className="mt-1 block text-[10px] text-muted">local snapshot</span>
                    </td>
                    <td className="p-3 text-right">
                      {customer.hasDeployment ? (
                        <Link href={`/control-plane/deployments/${customer.id}`} className={controlPlaneButtonClass}>
                          Open details
                        </Link>
                      ) : (
                        <span className="inline-flex min-h-8 items-center rounded-md border border-line bg-surface/40 px-3 py-1.5 text-xs font-semibold text-muted">
                          No deployment
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
                {fleet.items.length === 0 && (
                  <tr>
                    <td colSpan={10} className="p-8 text-center text-muted">
                      No clients match the current filters.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {fleet.items.length > 0 && (
            <div className="flex flex-col gap-3 border-t border-line pt-4 lg:flex-row lg:items-end lg:justify-between">
              <div className="max-w-lg flex-1">
                <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wide text-muted">
                  Rollout reason
                </label>
                <input
                  name="reason"
                  required
                  defaultValue="Execute stable release upgrade via control-plane selection."
                  className={`${controlPlaneInputClass} w-full`}
                />
              </div>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <label className="flex items-center gap-2 text-xs text-muted">
                  <input type="checkbox" name="includeUnhealthy" disabled={!canQueueReleaseRollouts} className="rounded border-line bg-surface text-brand-600 focus:ring-0" />
                  Override health blocks
                </label>
                <button type="submit" disabled={!canQueueReleaseRollouts} className={controlPlaneButtonClass}>
                  Deploy selected
                </button>
              </div>
            </div>
          )}
          {rolloutBlocker && <DisabledActionHint>{rolloutBlocker}</DisabledActionHint>}
        </form>

        <div className="mt-4 flex items-center justify-between text-[10px] text-muted">
          <span>
            Page {fleet.page} of {fleet.pageCount} / showing {fleet.items.length} of {fleet.total}
          </span>
          <div className="flex gap-2">
            {fleet.page > 1 ? <Link href={previousHref} className={controlPlaneButtonClass}>Previous</Link> : <span className="rounded-md border border-line/50 bg-surface/40 px-3 py-1.5 text-muted">Previous</span>}
            {fleet.page < fleet.pageCount ? <Link href={nextHref} className={controlPlaneButtonClass}>Next</Link> : <span className="rounded-md border border-line/50 bg-surface/40 px-3 py-1.5 text-muted">Next</span>}
          </div>
        </div>
      </ControlPlaneSection>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <ControlPlaneSection title="Health Alerts" description="Clients with degraded, blocked, or missing operational signals.">
          <div className="space-y-2">
            {attentionItems.map((customer) => (
              <div key={customer.id} className="rounded-md border border-line bg-surface p-3">
                <div className="flex items-center justify-between gap-3">
                  <strong className="text-xs text-white">{customer.label}</strong>
                  <StatusBadge status={customer.issues[0]?.status ?? customer.health.status} />
                </div>
                <p className="mt-1 truncate text-[10px] text-muted">
                  {customer.issues[0]?.detail || "Support sync issue detected."}
                </p>
                <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                  <ControlPlaneIssueDiagnostics issues={serializeIssues(customer.issues)} />
                  <Link href={`/control-plane/deployments/${customer.id}`} className={controlPlaneButtonClass}>
                    Open details
                  </Link>
                </div>
              </div>
            ))}
            {attentionItems.length === 0 && (
              <div className="rounded-md border border-line bg-surface/40 p-4 text-center text-xs text-muted">
                No active fleet health alerts.
              </div>
            )}
          </div>
        </ControlPlaneSection>

        <ControlPlaneSection title="Rollout Queue" description="Recent deploy-latest jobs and their blockers.">
          <div className="space-y-2">
            {recentRollouts.map((rollout) => {
              const deploymentId = payloadString(rollout.payload, "deploymentId");
              const customerLabel = deploymentId ? fleetLabelByDeploymentId.get(deploymentId) ?? deploymentId : "Unknown client";
              const target = rolloutTarget(rollout.payload);
              return (
                <div key={rollout.id} className="rounded-md border border-line bg-surface p-3">
                  <div className="flex items-center justify-between gap-3">
                    <strong className="text-xs text-white">{customerLabel}</strong>
                    <StatusBadge status={rollout.status}>{controlPlaneLabel(rollout.status)}</StatusBadge>
                  </div>
                  <div className="mt-1 flex items-center justify-between gap-3 text-[10px] text-muted">
                    <span className="truncate">Target: {target || "not recorded"}</span>
                    <span>Attempts: {rollout.attempts}</span>
                  </div>
                  {rollout.error && (
                    <p className="mt-2 whitespace-pre-wrap rounded-md border border-rose-500/20 bg-rose-500/10 p-2 font-mono text-[10px] leading-4 text-rose-300">
                      {rollout.error}
                    </p>
                  )}
                </div>
              );
            })}
            {recentRollouts.length === 0 && (
              <div className="rounded-md border border-line bg-surface/40 p-4 text-center text-xs text-muted">
                No deploy-latest jobs have been queued recently.
              </div>
            )}
          </div>
        </ControlPlaneSection>
      </div>
    </div>
  );
}
