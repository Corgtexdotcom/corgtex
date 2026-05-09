import { notFound } from "next/navigation";
import { getFormatter } from "next-intl/server";
import { listControlPlaneFleetPage, listControlPlaneReleaseRolloutJobs, requireControlPlaneAccess } from "@corgtex/domain";
import { Link } from "@/i18n/routing";
import { requirePageActor } from "@/lib/auth";
import { enqueueDeployLatestRolloutAction } from "./actions";
import { ControlPlaneLanguageSwitcher } from "./ControlPlaneLanguageSwitcher";

export const dynamic = "force-dynamic";

type FleetPage = Awaited<ReturnType<typeof listControlPlaneFleetPage>>;
type FleetCustomer = FleetPage["items"][number];
type ReleaseRollout = Awaited<ReturnType<typeof listControlPlaneReleaseRolloutJobs>>[number];

const PAGE_SIZE = 25;

function statusTone(status?: string | null) {
  if (status === "ok" || status === "active" || status === "connected") return "var(--green-11)";
  if (status === "attention" || status === "degraded" || status === "provisioning" || status === "configured" || status === "pending") return "var(--orange-11)";
  if (status === "down" || status === "suspended" || status === "failed" || status === "FAILED") return "var(--red-11)";
  return "var(--gray-11)";
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

function ReadinessCell({ customer }: { customer: FleetCustomer }) {
  const health = customer.lastHealthStatus || latestSnapshot(customer, "HEALTH")?.status || customer.provisioningStatus;
  const drift = releaseDrift(customer);
  return (
    <td style={{ padding: 12, minWidth: 180 }}>
      <div style={{ color: statusTone(health), fontWeight: 700, textTransform: "capitalize" }}>{label(health)}</div>
      {drift ? <div className="muted" style={{ fontSize: 12 }}>{drift}</div> : <div className="muted" style={{ fontSize: 12 }}>Cached status</div>}
    </td>
  );
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
  const format = await getFormatter();
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
    <main className="control-plane-shell">
      <aside className="control-plane-rail stack">
        <strong>Ops Control Plane</strong>
        <a className="ws-nav-link" href="#fleet"><span className="ws-nav-icon">◇</span>Fleet</a>
        <a className="ws-nav-link" href="#rollout"><span className="ws-nav-icon">◇</span>Deploy latest</a>
        <a className="ws-nav-link" href="#audit"><span className="ws-nav-icon">◇</span>Cached evidence</a>
        <ControlPlaneLanguageSwitcher />
      </aside>

      <div className="control-plane-content stack">
        <header className="page-header">
          <div>
            <p className="muted" style={{ textTransform: "uppercase", fontSize: 12 }}>Private operations</p>
            <h1 className="title-lg" style={{ margin: 0 }}>Customer Fleet</h1>
            <p className="muted" style={{ maxWidth: 760 }}>
              Scalable control plane for 10-100 customer deployments. The list reads cached deployment and fleet snapshot records only; live probes run on demand from customer detail pages.
            </p>
          </div>
        </header>

        <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
          {[
            ["Customers", fleet.summary.totalCustomers, "registered clients"],
            ["Active", fleet.summary.active, "active deployments"],
            ["Needs attention", fleet.summary.attention, "cached health issues"],
            ["Support ready", fleet.summary.supportReady, "connector configured"],
            ["Release drift", fleet.summary.releaseDrift, "cached drift signals"],
          ].map(([title, value, detail]) => (
            <div className="panel" key={title} style={{ padding: 16 }}>
              <div className="muted" style={{ fontSize: 12 }}>{title}</div>
              <div style={{ fontSize: 28, fontWeight: 700 }}>{value}</div>
              <div className="muted" style={{ fontSize: 12 }}>{detail}</div>
            </div>
          ))}
        </section>

        <section id="fleet" className="panel stack" style={{ padding: 18, gap: 16 }}>
          <div className="row" style={{ alignItems: "end" }}>
            <div>
              <h2 style={{ margin: 0 }}>Fleet</h2>
              <p className="muted" style={{ margin: "4px 0 0" }}>Server-side filters, pagination, and cached evidence. No fan-out from this page.</p>
            </div>
            <form method="get" style={{ display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "flex-end" }}>
              <input name="q" defaultValue={fleet.filters.query} placeholder="Search customer, URL, owner, release" style={{ minWidth: 280 }} />
              <select name="health" defaultValue={fleet.filters.health}>
                <option value="">Any health</option>
                <option value="ok">Healthy</option>
                <option value="degraded">Degraded</option>
                <option value="down">Down</option>
                <option value="active">Active</option>
              </select>
              <select name="support" defaultValue={fleet.filters.support}>
                <option value="">Any support</option>
                <option value="connected">Connected</option>
                <option value="configured">Configured</option>
                <option value="not_configured">Not configured</option>
                <option value="degraded">Degraded</option>
              </select>
              <select name="region" defaultValue={fleet.filters.region}>
                <option value="">Any region</option>
                {fleet.filters.regions.map((region) => <option key={region} value={region.toLowerCase()}>{region}</option>)}
              </select>
              <select name="owner" defaultValue={fleet.filters.owner}>
                <option value="">Any owner</option>
                {fleet.filters.owners.map((owner) => <option key={owner} value={owner.toLowerCase()}>{owner}</option>)}
              </select>
              <select name="sort" defaultValue={fleet.filters.sort}>
                <option value="updated">Updated</option>
                <option value="customer">Customer</option>
                <option value="health">Health</option>
                <option value="release">Release</option>
                <option value="support">Support</option>
                <option value="region">Region</option>
                <option value="owner">Owner</option>
              </select>
              <select name="direction" defaultValue={fleet.filters.direction}>
                <option value="desc">Descending</option>
                <option value="asc">Ascending</option>
              </select>
              <button type="submit" className="button secondary small">Apply</button>
            </form>
          </div>

          <div className="control-plane-deploy-strip">
            <div>
              <strong>Deploy latest</strong>
              <p className="muted" style={{ margin: "4px 0 0" }}>
                Queue selected clients from the table, or send the configured latest release to all healthy eligible clients. Preflight still skips unsafe targets.
              </p>
            </div>
            <form action={enqueueDeployLatestRolloutAction} className="control-plane-inline-form">
              <input type="hidden" name="allEligible" value="true" />
              <input type="hidden" name="limit" value="100" />
              <input name="reason" required defaultValue="Deploy configured latest release to all eligible healthy clients." />
              <button type="submit" className="button secondary small">Queue all eligible</button>
            </form>
          </div>

          <form action={enqueueDeployLatestRolloutAction} className="stack" id="rollout" style={{ gap: 14 }}>
            <div style={{ overflowX: "auto" }}>
              <table className="table" style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ textAlign: "left", borderBottom: "1px solid var(--border-color)" }}>
                    <th style={{ padding: 12 }}><span className="muted">Select</span></th>
                    <th style={{ padding: 12 }}>Customer</th>
                    <th style={{ padding: 12 }}>Health</th>
                    <th style={{ padding: 12 }}>Release</th>
                    <th style={{ padding: 12 }}>Support</th>
                    <th style={{ padding: 12 }}>Feature flags</th>
                    <th style={{ padding: 12 }}>Owner</th>
                    <th style={{ padding: 12 }}>Last checked</th>
                    <th style={{ padding: 12 }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {fleet.items.map((customer) => {
                    const supportStatus = customer.hasSupportCredential ? customer.supportConnectorStatus : "not_configured";
                    const integrationSnapshot = latestSnapshot(customer, "INTEGRATION");
                    return (
                      <tr key={customer.id} style={{ borderBottom: "1px solid var(--border-color)" }}>
                        <td style={{ padding: 12 }}>
                          {customer.hasDeployment ? <input type="checkbox" name="deploymentIds" value={customer.id} aria-label={`Select ${customer.label}`} /> : null}
                        </td>
                        <td style={{ padding: 12, minWidth: 220 }}>
                          <strong>{customer.label}</strong>
                          <div className="muted">{customer.customerSlug || customer.customerAccount?.slug || customer.url}</div>
                          <div className="muted" style={{ fontSize: 12 }}>{customer.region || "No region"} / {customer.dataResidency || "No residency"}</div>
                        </td>
                        <ReadinessCell customer={customer} />
                        <td style={{ padding: 12, minWidth: 180 }}>
                          <strong>{customer.releaseImageTag || customer.releaseVersion || "Unknown"}</strong>
                          {releaseDrift(customer) ? <div style={{ color: "var(--red-11)", fontSize: 12 }}>Drift recorded</div> : <div className="muted" style={{ fontSize: 12 }}>No cached drift</div>}
                        </td>
                        <td style={{ padding: 12 }}>
                          <span style={{ color: statusTone(supportStatus), fontWeight: 700, textTransform: "capitalize" }}>{label(supportStatus)}</span>
                          <div className="muted" style={{ fontSize: 12 }}>{customer.managedWorkspace ? "Managed workspace" : "Remote connector"}</div>
                        </td>
                        <td style={{ padding: 12 }}>
                          <span style={{ color: statusTone(integrationSnapshot?.status), fontWeight: 700, textTransform: "capitalize" }}>{label(integrationSnapshot?.status)}</span>
                          <div className="muted" style={{ fontSize: 12 }}>Open client to edit</div>
                        </td>
                        <td style={{ padding: 12 }}>{customer.supportOwnerEmail || "Unassigned"}</td>
                        <td style={{ padding: 12 }}>
                          {customer.lastHealthCheck
                            ? format.dateTime(customer.lastHealthCheck, { dateStyle: "medium", timeStyle: "short" })
                            : latestSnapshot(customer, "HEALTH")?.observedAt
                              ? format.dateTime(latestSnapshot(customer, "HEALTH")!.observedAt, { dateStyle: "medium", timeStyle: "short" })
                              : "Never"}
                        </td>
                        <td style={{ padding: 12 }}>
                          {customer.hasDeployment ? (
                            <Link className="link-button small" href={`/control-plane/deployments/${customer.id}`}>Open</Link>
                          ) : (
                            <span className="muted">Needs deployment</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                  {fleet.items.length === 0 && (
                    <tr><td colSpan={9} className="muted" style={{ padding: 28, textAlign: "center" }}>No customers match these filters.</td></tr>
                  )}
                </tbody>
              </table>
            </div>

            <div className="row" style={{ alignItems: "end", gap: 12 }}>
              <label style={{ flex: "1 1 320px" }}>
                Rollout reason
                <input name="reason" required defaultValue="Deploy configured latest release to selected eligible clients." />
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 8, margin: 0 }}>
                <input type="checkbox" name="includeUnhealthy" />
                Confirm selected clients with health blockers
              </label>
              <button type="submit" className="button">Queue selected deploy latest</button>
            </div>
          </form>

          <section className="control-plane-rollout-panel stack">
            <div className="row">
              <div>
                <h3 style={{ margin: 0 }}>Recent rollout progress</h3>
                <p className="muted" style={{ margin: "4px 0 0" }}>Queued jobs are per client, so failures and retries stay visible without polling every customer instance.</p>
              </div>
              <span className="tag neutral">{recentRollouts.length} recent</span>
            </div>
            <div className="control-plane-rollout-list">
              {recentRollouts.map((rollout) => {
                const deploymentId = payloadString(rollout.payload, "deploymentId");
                const customerLabel = deploymentId ? fleetLabelByDeploymentId.get(deploymentId) ?? deploymentId : "Unknown client";
                const target = rolloutTarget(rollout.payload);
                return (
                  <div className="item" key={rollout.id}>
                    <div className="row">
                      <div>
                        <strong>{customerLabel}</strong>
                        <div className="muted" style={{ fontSize: 12 }}>{target ? `Target ${target}` : "Target not recorded"}</div>
                      </div>
                      <span style={{ color: statusTone(rollout.status), fontWeight: 700, textTransform: "capitalize" }}>{label(rollout.status)}</span>
                    </div>
                    <div className="muted" style={{ fontSize: 12 }}>
                      {format.dateTime(rollout.createdAt, { dateStyle: "medium", timeStyle: "short" })} / attempts {rollout.attempts}
                      {rollout.completedAt ? ` / completed ${format.dateTime(rollout.completedAt, { dateStyle: "medium", timeStyle: "short" })}` : ""}
                    </div>
                    {rollout.error ? <div style={{ color: "var(--red-11)", fontSize: 12 }}>{rollout.error}</div> : null}
                  </div>
                );
              })}
              {recentRollouts.length === 0 && (
                <div className="item muted">No deploy latest jobs have been queued yet.</div>
              )}
            </div>
          </section>

          <div className="row">
            <div className="muted">Page {fleet.page} of {fleet.pageCount}. Showing {fleet.items.length} of {fleet.total} matching customers.</div>
            <div className="actions-inline">
              {fleet.page > 1 ? <a className="link-button small" href={previousHref}>Previous</a> : <span className="link-button small muted" aria-disabled="true">Previous</span>}
              {fleet.page < fleet.pageCount ? <a className="link-button small" href={nextHref}>Next</a> : <span className="link-button small muted" aria-disabled="true">Next</span>}
            </div>
          </div>
        </section>

        <section id="audit" className="panel stack" style={{ padding: 18 }}>
          <h2 style={{ margin: 0 }}>Operational model</h2>
          <p className="muted" style={{ margin: 0 }}>
            Fleet rendering stays fast because it uses central deployment rows and cached fleet snapshots. Health probes, support snapshots, access changes, feature flag writes, and deploy actions run from client detail pages or queued jobs and write the audit timeline.
          </p>
        </section>
      </div>
    </main>
  );
}
