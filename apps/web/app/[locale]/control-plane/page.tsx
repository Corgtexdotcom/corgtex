import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getFormatter } from "next-intl/server";
import { listControlPlaneCustomers, requireControlPlaneAccess } from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";

export const dynamic = "force-dynamic";

function statusTone(status?: string | null) {
  if (status === "ok" || status === "active" || status === "connected") return "var(--green-11)";
  if (status === "degraded" || status === "provisioning" || status === "configured") return "var(--orange-11)";
  if (status === "down" || status === "suspended" || status === "failed") return "var(--red-11)";
  return "var(--gray-11)";
}

export default async function ControlPlanePage() {
  const actor = await requirePageActor();
  try {
    await requireControlPlaneAccess(actor);
  } catch {
    notFound();
  }

  const customers = await listControlPlaneCustomers(actor);
  if (customers.length === 1) {
    redirect(`/control-plane/customers/${customers[0].id}`);
  }

  const format = await getFormatter();
  const totals = customers.reduce((summary, customer) => ({
    active: summary.active + (customer.provisioningStatus === "active" ? 1 : 0),
    degraded: summary.degraded + (customer.lastHealthStatus === "degraded" || customer.supportConnectorStatus === "degraded" ? 1 : 0),
    supportReady: summary.supportReady + (customer.hasSupportCredential ? 1 : 0),
    failedOperations: summary.failedOperations + customer.supportOperations.filter((op) => op.status === "FAILED").length,
  }), { active: 0, degraded: 0, supportReady: 0, failedOperations: 0 });

  return (
    <main className="stack" style={{ padding: 32, maxWidth: 1280, margin: "0 auto" }}>
      <header className="page-header">
        <div>
          <p className="muted" style={{ textTransform: "uppercase", letterSpacing: "0.08em", fontSize: 12 }}>Corgtex Ops</p>
          <h1 className="title-lg" style={{ margin: 0 }}>Control Plane</h1>
          <p className="muted">Pilot customer support, fleet health, and audited repair operations.</p>
        </div>
      </header>

      <section style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 16 }}>
        {[
          ["Customers", customers.length],
          ["Active", totals.active],
          ["Support ready", totals.supportReady],
          ["Needs attention", totals.degraded + totals.failedOperations],
        ].map(([label, value]) => (
          <div className="panel" key={label} style={{ padding: 18 }}>
            <div className="muted" style={{ fontSize: 12 }}>{label}</div>
            <div style={{ fontSize: 28, fontWeight: 700 }}>{value}</div>
          </div>
        ))}
      </section>

      <section className="panel" style={{ overflow: "hidden", padding: 0 }}>
        <table className="table" style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ textAlign: "left", borderBottom: "1px solid var(--border-color)" }}>
              <th style={{ padding: 14 }}>Customer</th>
              <th style={{ padding: 14 }}>Region</th>
              <th style={{ padding: 14 }}>Release</th>
              <th style={{ padding: 14 }}>Runtime</th>
              <th style={{ padding: 14 }}>Support</th>
              <th style={{ padding: 14 }}>Last check</th>
              <th style={{ padding: 14 }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {customers.map((customer) => (
              <tr key={customer.id} style={{ borderBottom: "1px solid var(--border-color)" }}>
                <td style={{ padding: 14 }}>
                  <strong>{customer.label}</strong>
                  <div className="muted">{customer.customerSlug || customer.url}</div>
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
            ))}
            {customers.length === 0 && (
              <tr>
                <td colSpan={7} style={{ padding: 32, textAlign: "center" }} className="muted">
                  No customer instances are registered yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </main>
  );
}
