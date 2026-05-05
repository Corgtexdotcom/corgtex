import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter } from "next-intl/server";
import { listControlPlaneCustomers, requireControlPlaneAccess } from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";

export const dynamic = "force-dynamic";

type ControlPlaneCustomer = Awaited<ReturnType<typeof listControlPlaneCustomers>>[number];

const CONTROL_PLANE_SECTIONS = [
  ["fleet", "Fleet", "Hosted instance health, rollout state, and customer readiness."],
  ["customers", "Customers", "Searchable enterprise customer records and support ownership."],
  ["context", "Context & Brain", "Source freshness, provenance, sync status, and ingestion risk."],
  ["ai-governance", "AI Governance", "Agent runs, model spend, approvals, budgets, and risky actions."],
  ["integrations", "Integrations", "Enterprise entitlements, vendor readiness, caps, and failures."],
  ["releases", "Releases", "Version drift, staged upgrades, bootstrap, and rollback readiness."],
  ["support", "Support", "Reasoned support operations and break-glass records."],
  ["audit", "Audit", "Central evidence trail for control-plane and customer-side operations."],
  ["mcp", "MCP/CLI", "Least-privilege automation interface for Codex and operator tooling."],
] as const;

function statusTone(status?: string | null) {
  if (status === "ok" || status === "active" || status === "connected") return "var(--green-11)";
  if (status === "attention" || status === "degraded" || status === "provisioning" || status === "configured" || status === "pending") return "var(--orange-11)";
  if (status === "down" || status === "suspended" || status === "failed" || status === "FAILED") return "var(--red-11)";
  return "var(--gray-11)";
}

function instanceReadiness(customer: ControlPlaneCustomer) {
  const issues = [
    !customer.region ? "Region missing" : null,
    !customer.dataResidency ? "Residency missing" : null,
    !customer.releaseImageTag && !customer.releaseVersion ? "Release unknown" : null,
    !customer.lastHealthCheck ? "No health probe" : null,
    customer.lastHealthStatus && customer.lastHealthStatus !== "ok" ? `Runtime ${customer.lastHealthStatus}` : null,
    !customer.hasSupportCredential ? "Support connector not configured" : null,
    customer.supportConnectorStatus === "degraded" ? "Support connector degraded" : null,
  ].filter(Boolean) as string[];

  return {
    status: issues.length === 0 ? "ready" : "attention",
    issues,
  };
}

function matchesQuery(customer: ControlPlaneCustomer, query: string) {
  if (!query) return true;
  return [
    customer.label,
    customer.customerSlug,
    customer.url,
    customer.region,
    customer.dataResidency,
    customer.supportOwnerEmail,
    customer.releaseImageTag,
    customer.releaseVersion,
    customer.managedWorkspace?.name,
    customer.managedWorkspace?.slug,
  ].some((value) => value?.toLowerCase().includes(query));
}

export default async function ControlPlanePage({
  searchParams,
}: {
  searchParams?: Promise<{ q?: string }>;
}) {
  const actor = await requirePageActor();
  try {
    await requireControlPlaneAccess(actor);
  } catch {
    notFound();
  }

  const query = ((await searchParams)?.q ?? "").trim().toLowerCase();
  const customers = await listControlPlaneCustomers(actor);
  const filteredCustomers = customers.filter((customer) => matchesQuery(customer, query));
  const format = await getFormatter();
  const totals = customers.reduce((summary, customer) => ({
    active: summary.active + (customer.provisioningStatus === "active" ? 1 : 0),
    attention: summary.attention + (instanceReadiness(customer).status === "attention" ? 1 : 0),
    supportReady: summary.supportReady + (customer.hasSupportCredential ? 1 : 0),
    managed: summary.managed + (customer.managedWorkspace ? 1 : 0),
    failedOperations: summary.failedOperations + customer.supportOperations.filter((op) => op.status === "FAILED").length,
  }), { active: 0, attention: 0, supportReady: 0, managed: 0, failedOperations: 0 });
  const recentOperations = customers
    .flatMap((customer) => customer.supportOperations.map((operation) => ({ customer, operation })))
    .sort((a, b) => b.operation.createdAt.getTime() - a.operation.createdAt.getTime())
    .slice(0, 8);

  return (
    <main className="control-plane-shell">
      <aside className="control-plane-rail stack">
        <strong>Control Plane</strong>
        {CONTROL_PLANE_SECTIONS.map(([id, label]) => (
          <a key={id} className="ws-nav-link" href={`#${id}`}>
            <span className="ws-nav-icon">◇</span>
            {label}
          </a>
        ))}
      </aside>

      <div className="control-plane-content stack">
        <header className="page-header">
          <div>
            <p className="muted" style={{ textTransform: "uppercase", fontSize: 12 }}>Enterprise AI governance</p>
            <h1 className="title-lg" style={{ margin: 0 }}>Control Plane</h1>
            <p className="muted" style={{ maxWidth: 720 }}>
              Proprietary operations surface for hosted customer instances, governed context, enterprise integrations,
              AI-agent lifecycle controls, release rollout, support operations, audit, and Codex/MCP access.
            </p>
          </div>
        </header>

        <section id="fleet" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 16 }}>
          {[
            ["Customers", customers.length, "Registered enterprise instances"],
            ["Active", totals.active, "Instances reporting active provisioning"],
            ["Managed locally", totals.managed, "Linked to an in-deployment workspace"],
            ["Support ready", totals.supportReady, "Encrypted support connector available"],
            ["Needs attention", totals.attention + totals.failedOperations, "Readiness gaps or failed operations"],
          ].map(([label, value, detail]) => (
            <div className="panel" key={label} style={{ padding: 18 }}>
              <div className="muted" style={{ fontSize: 12 }}>{label}</div>
              <div style={{ fontSize: 28, fontWeight: 700 }}>{value}</div>
              <div className="muted" style={{ fontSize: 12 }}>{detail}</div>
            </div>
          ))}
        </section>

        <section id="customers" className="panel stack" style={{ padding: 20, gap: 18 }}>
          <div className="row">
            <div>
              <h2 style={{ margin: 0 }}>Customers</h2>
              <p className="muted" style={{ margin: "4px 0 0" }}>Search by customer, slug, region, release, owner, or URL.</p>
            </div>
            <form method="get" style={{ display: "flex", gap: 8 }}>
              <input name="q" defaultValue={query} placeholder="Search customers" style={{ minWidth: 260 }} />
              <button type="submit" className="button secondary small">Search</button>
            </form>
          </div>

          <div style={{ overflowX: "auto" }}>
            <table className="table" style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ textAlign: "left", borderBottom: "1px solid var(--border-color)" }}>
                  <th style={{ padding: 14 }}>Customer</th>
                  <th style={{ padding: 14 }}>Readiness</th>
                  <th style={{ padding: 14 }}>Workspace</th>
                  <th style={{ padding: 14 }}>Region</th>
                  <th style={{ padding: 14 }}>Release</th>
                  <th style={{ padding: 14 }}>Runtime</th>
                  <th style={{ padding: 14 }}>Support</th>
                  <th style={{ padding: 14 }}>Last check</th>
                  <th style={{ padding: 14 }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredCustomers.map((customer) => {
                  const readiness = instanceReadiness(customer);
                  return (
                    <tr key={customer.id} style={{ borderBottom: "1px solid var(--border-color)" }}>
                      <td style={{ padding: 14 }}>
                        <strong>{customer.label}</strong>
                        <div className="muted">{customer.customerSlug || customer.url}</div>
                      </td>
                      <td style={{ padding: 14 }}>
                        <span style={{ color: statusTone(readiness.status), fontWeight: 700 }}>{readiness.status}</span>
                        {readiness.issues.length > 0 && <div className="muted">{readiness.issues.slice(0, 2).join(", ")}</div>}
                      </td>
                      <td style={{ padding: 14 }}>
                        {customer.managedWorkspace ? (
                          <>
                            <strong>{customer.managedWorkspace.name}</strong>
                            <div className="muted">{customer.managedWorkspace.slug}</div>
                          </>
                        ) : (
                          <span className="muted">Remote only</span>
                        )}
                      </td>
                      <td style={{ padding: 14 }}>{customer.region || "Not set"}</td>
                      <td style={{ padding: 14 }}>{customer.releaseImageTag || customer.releaseVersion || "Unknown"}</td>
                      <td style={{ padding: 14 }}>
                        <span style={{ color: statusTone(customer.lastHealthStatus), fontWeight: 600 }}>
                          {customer.lastHealthStatus || customer.provisioningStatus || "unknown"}
                        </span>
                        {customer.lastHealthError && <div className="muted">{customer.lastHealthError}</div>}
                      </td>
                      <td style={{ padding: 14 }}>
                        <span style={{ color: statusTone(customer.supportConnectorStatus), fontWeight: 600 }}>
                          {customer.supportConnectorStatus}
                        </span>
                        <div className="muted">{customer.supportOwnerEmail || "No owner"}</div>
                      </td>
                      <td style={{ padding: 14 }}>
                        {customer.supportLastSyncAt
                          ? format.dateTime(customer.supportLastSyncAt, { dateStyle: "medium", timeStyle: "short" })
                          : customer.lastHealthCheck
                            ? format.dateTime(customer.lastHealthCheck, { dateStyle: "medium", timeStyle: "short" })
                            : "Never"}
                      </td>
                      <td style={{ padding: 14 }}>
                        <Link className="button secondary small" href={`/control-plane/customers/${customer.id}`}>
                          Open
                        </Link>
                      </td>
                    </tr>
                  );
                })}
                {filteredCustomers.length === 0 && (
                  <tr>
                    <td colSpan={9} style={{ padding: 32, textAlign: "center" }} className="muted">
                      No customer instances match this search.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 16 }}>
          {CONTROL_PLANE_SECTIONS.slice(2).map(([id, label, detail]) => (
            <div id={id} className="panel stack" key={id} style={{ padding: 18, gap: 8 }}>
              <h2 style={{ margin: 0, fontSize: 18 }}>{label}</h2>
              <p className="muted" style={{ margin: 0 }}>{detail}</p>
              <div className="muted" style={{ fontSize: 12 }}>
                {id === "support"
                  ? `${recentOperations.length} recent support operations visible`
                  : "Customer detail pages expose the first operating view for this domain."}
              </div>
            </div>
          ))}
        </section>

        <section className="panel stack" style={{ padding: 20, gap: 14 }}>
          <div>
            <h2 style={{ margin: 0 }}>Operation history</h2>
            <p className="muted" style={{ margin: "4px 0 0" }}>Recent reasoned support operations across the fleet.</p>
          </div>
          {recentOperations.map(({ customer, operation }) => (
            <div className="item" key={operation.id}>
              <div className="row">
                <div>
                  <strong>{operation.action}</strong>
                  <div className="muted">{customer.label} - {operation.reason}</div>
                </div>
                <span style={{ color: statusTone(operation.status), fontWeight: 700 }}>{operation.status}</span>
              </div>
              <div className="muted">{format.dateTime(operation.createdAt, { dateStyle: "medium", timeStyle: "short" })}</div>
            </div>
          ))}
          {recentOperations.length === 0 && <p className="muted">No support operations recorded yet.</p>}
        </section>
      </div>
    </main>
  );
}
